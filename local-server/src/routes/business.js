import express from 'express';
import { httpError } from '../db.js';
import { ADMIN_ROLES } from '../auth.js';
import {
  computeUnitScores, computeStars, reqFilledBy, isDeadlinePassed, DISCIPLINE_POINTS, findRecentSameInfraction
} from '../../../shared/scoring.js';
import { isUniformReq, normalizeUniformInspection, computeUniformPoints } from '../../../shared/uniforme.js';

export function businessRouter({ store, auth }) {
  const r = express.Router();
  const { requireAuth } = auth;
  const regionName = id => (id ? (store.get('regions', id)?.name ?? id) : null);

  const scores = () => computeUnitScores(
    store.list('submissions'), store.list('units'), store.list('disciplinaryActions')
  );

  // ── RANKING ─────────────────────────────────────────────────
  // Público (tela de login): só posição, pontos e estrelas — sem nome de unidade/região
  // `?meta=1` devolve também a origem e a hora: { source:'local', updatedAt, cloudSyncedAt, ranking|scores }.
  // updatedAt = quando o ranking foi calculado; cloudSyncedAt = última sincronização bem-sucedida com a nuvem
  // (para o usuário saber quão fresco é o dado em relação à nuvem). Sem `meta`, o formato antigo (lista).
  const meta = body => ({ source: 'local', updatedAt: Date.now(), cloudSyncedAt: Number(store.getMeta('sync.lastSuccessAt')) || null, revision: store.revision(), ...body });

  r.get('/ranking', (req, res) => {
    const withPts = scores().filter(s => s.total > 0);
    const max = withPts[0]?.total || 0;
    const rows = withPts.map((s, i) => ({ position: i + 1, total: s.total, stars: computeStars(s.total, max) }));
    res.json(req.query.meta ? meta({ ranking: rows }) : rows);
  });

  // Identificado (admin): nome, região, pontos e estrelas por unidade
  r.get('/scores/units', requireAuth(), (req, res) => {
    const all = scores();
    const max = all[0]?.total || 0;
    const rows = all.map(s => ({ ...s, stars: computeStars(s.total, max) }));
    res.json(req.query.meta ? meta({ scores: rows }) : rows);
  });

  // ── ENVIO (Região / Conselheiro) ────────────────────────────
  r.post('/submissions', requireAuth(['region', 'counselor']), (req, res) => {
    const { requirementId, notes = '', proofUrl = null } = req.body || {};
    const user = req.user;
    const sub = store.tx(() => {
      const req_ = store.get('requirements', requirementId);
      if (!req_) throw httpError(404, 'Requisito não encontrado');
      if (req_.active === false) throw httpError(422, 'Requisito desativado');
      const expected = user.role === 'region' ? 'regional' : 'conselheiro';
      if (reqFilledBy(req_) !== expected) throw httpError(403, 'Este requisito não pode ser enviado por este perfil');
      if (isDeadlinePassed(req_)) throw httpError(422, 'Prazo encerrado para este requisito');
      if (user.role === 'counselor' && !user.unitId) throw httpError(422, 'Conselheiro sem unidade vinculada');

      const scope = user.role === 'counselor'
        ? { unitId: user.unitId, requirementId }
        : { regionId: user.regionId, unitId: null, requirementId };
      if (store.list('submissions', { filters: scope }).some(s => s.status === 'approved')) {
        throw httpError(409, 'Este requisito já foi aprovado', 'DUPLICATE');
      }
      return store.insert('submissions', {
        regionId: user.regionId, regionName: regionName(user.regionId),
        unitId: user.role === 'counselor' ? user.unitId : null,
        requirementId: req_.id, requirementName: req_.name,
        requirementPoints: req_.points, requirementCategory: req_.category,
        competitionCategory: req_.competitionCategory || 'Ambos',
        notes, proofUrl, status: 'pending', source: 'region', fiscalSuggestion: false,
        submittedAt: { __serverTimestamp: true }, submittedBy: user.username, submittedByName: user.name,
        requirementDeadlineSnapshot: req_.deadline || null
      });
    });
    res.json(sub);
  });

  // ── FISCAL: sugestão de pontuação (admin aprova depois) ─────
  // Idempotente e segura para reenvio da fila offline do aparelho:
  //  · `clientId` (UUID do aparelho): reenviar o MESMO item não regrava nada (não "des-aprova" o que o admin já revisou);
  //  · `evaluatedAt` (ms): se já existe avaliação MAIS RECENTE para o mesmo item, a antiga não sobrescreve (result: 'superseded');
  //  · nunca duplica: sem `existingSubId` (ou com id que sumiu), procura a avaliação do fiscal para o mesmo região/unidade + requisito.
  r.post('/submissions/fiscal-suggestion', requireAuth(['judge', ...ADMIN_ROLES]), (req, res) => {
    const { requirementId, unitId = null, subItemScores = null, subItemPcts = null, existingSubId = null, clientId = null, evaluatedAt = null, uniformInspection = null } = req.body || {};
    let { regionId, points } = req.body || {};
    if (uniformInspection === null && (typeof points !== 'number' || points < 0)) throw httpError(400, 'points inválido');
    if (clientId !== null && (typeof clientId !== 'string' || clientId.length > 80)) throw httpError(400, 'clientId inválido');
    const evalAt = Number.isFinite(Number(evaluatedAt)) && evaluatedAt !== null ? Number(evaluatedAt) : null;
    const user = req.user;
    const out = store.tx(() => {
      const req_ = store.get('requirements', requirementId);
      if (!req_) throw httpError(404, 'Requisito não encontrado');
      // Inspeção de uniforme: pontos calculados AQUI pela regra única (shared/uniforme.js), sempre no nível da unidade
      let inspection = null;
      if (uniformInspection !== null) {
        if (!isUniformReq(req_)) throw httpError(422, 'Este requisito não é uma Inspeção de uniforme');
        const unit = unitId ? store.get('units', unitId) : null;
        if (!unit) throw httpError(422, 'Selecione a unidade inspecionada');
        regionId = unit.regionId;
        const norm = normalizeUniformInspection(uniformInspection);
        points = computeUniformPoints(norm.erros, req_).pontos;
        inspection = { ...norm, avaliadorId: user.id, avaliadorNome: user.name, avaliadoEm: evalAt ?? Date.now() };
      } else if (isUniformReq(req_)) throw httpError(422, 'A Inspeção de uniforme é preenchida na tela própria');
      let target = existingSubId ? store.get('submissions', existingSubId) : null;
      if (target && target.requirementId !== requirementId) target = null; // id de outro requisito: ignora
      if (!target) {
        target = store.list('submissions', { filters: { requirementId, regionId } })
          .find(x => x.source === 'judge' && (x.unitId || null) === (unitId || null)) || null;
      }
      if (target && clientId && target.fiscalClientId === clientId) return { ...target, result: 'idempotent' };
      if (target && evalAt !== null && target.fiscalEvaluatedAt && evalAt < target.fiscalEvaluatedAt) return { ...target, result: 'superseded' };
      const base = {
        requirementPoints: points, subItemScores, subItemPcts, status: 'pending', fiscalSuggestion: true,
        notes: `Avaliado por: ${user.name}`, submittedAt: { __serverTimestamp: true },
        submittedBy: user.username, submittedByName: user.name,
        ...(clientId ? { fiscalClientId: clientId } : {}), ...(evalAt !== null ? { fiscalEvaluatedAt: evalAt } : {}),
        ...(inspection ? { uniformInspection: inspection } : {})
      };
      if (target) return { ...store.update('submissions', target.id, base), result: 'updated' };
      return {
        ...store.insert('submissions', {
          regionId, regionName: regionName(regionId), unitId,
          requirementId: req_.id, requirementName: req_.name, requirementCategory: req_.category,
          competitionCategory: req_.competitionCategory || 'Ambos', proofUrl: null, source: 'judge',
          requirementDeadlineSnapshot: req_.deadline || null, ...base
        }), result: 'created'
      };
    });
    res.json(out);
  });

  // ── REVISÃO (aprovar / rejeitar / reabrir) ──────────────────
  r.post('/submissions/:id/review', requireAuth(['approver', ...ADMIN_ROLES]), (req, res) => {
    const { status, reason = '' } = req.body || {};
    if (!['approved', 'rejected', 'pending'].includes(status)) throw httpError(400, 'status inválido');
    const user = req.user;
    const sub = store.tx(() => {
      const updated = store.update('submissions', req.params.id, {
        status, rejectionReason: reason, reviewedAt: { __serverTimestamp: true },
        reviewedBy: user.username || 'admin', reviewedByName: user.name || 'Administrador'
      });
      store.insert('auditLog', {
        action: status, submissionId: req.params.id, by: user.username, byName: user.name, byRole: user.role,
        reason, at: { __serverTimestamp: true }
      });
      return updated;
    });
    res.json(sub);
  });

  // ── DISCIPLINA (-5 pts fixos) ───────────────────────────────
  // Idempotente: `clientId` (UUID do formulário) vira o id do documento (`disc_<clientId>`) — clique duplo, reenvio e sincronização
  // com a nuvem (mesmo id nos dois lados) nunca somam duas vezes; se a ação foi EXCLUÍDA, a exclusão vence (não ressuscita).
  // Mesma infração (alvo + motivo) em menos de 10 min → 409 DUPLICATE_RECENT; o admin confirma com `confirmDuplicate: true`.
  r.post('/discipline', requireAuth(ADMIN_ROLES), (req, res) => {
    const { targetType, targetId, reason, clientId = null, confirmDuplicate = false } = req.body || {};
    if (!['region', 'unit'].includes(targetType)) throw httpError(400, 'targetType deve ser "region" ou "unit"');
    if (!reason || !String(reason).trim()) throw httpError(400, 'Informe o motivo');
    if (clientId !== null && !/^[A-Za-z0-9_-]{8,80}$/.test(String(clientId))) throw httpError(400, 'clientId inválido');
    const target = store.get(targetType === 'region' ? 'regions' : 'units', targetId);
    if (!target) throw httpError(404, 'Alvo não encontrado');
    const out = store.tx(() => {
      const id = clientId ? `disc_${clientId}` : undefined;
      if (id) {
        const row = store.db.prepare('SELECT deleted FROM disciplinaryActions WHERE id = ?').get(id);
        if (row?.deleted) return { id, result: 'deleted-wins' };
        const existing = row && store.get('disciplinaryActions', id);
        if (existing) return { ...existing, result: 'idempotent' };
      }
      const recent = findRecentSameInfraction(store.list('disciplinaryActions'), { targetType, targetId, reason });
      if (recent && !confirmDuplicate) {
        const mins = Math.max(0, Math.round((Date.now() - (recent.createdAt?.seconds || 0) * 1000) / 60000));
        throw httpError(409, `A mesma infração (mesmo alvo e motivo) já foi registrada há ${mins} min. Registrar mesmo assim?`, 'DUPLICATE_RECENT');
      }
      return { ...store.insert('disciplinaryActions', {
        targetType, targetId, targetName: target.name, reason: String(reason).trim(), points: DISCIPLINE_POINTS, origin: 'local',
        ...(clientId ? { clientId } : {}),
        createdAt: { __serverTimestamp: true }, createdBy: req.user.username || 'admin', createdByName: req.user.name || 'Administrador'
      }, id), result: 'created' };
    });
    res.json(out);
  });

  r.delete('/discipline/:id', requireAuth(ADMIN_ROLES), (req, res) => {
    store.remove('disciplinaryActions', req.params.id);
    res.json({ ok: true });
  });
  return r;
}
