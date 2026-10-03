import express from 'express';
import { httpError } from '../db.js';
import { ADMIN_ROLES } from '../auth.js';
import {
  computeUnitScores, computeStars, reqFilledBy, isDeadlinePassed, DISCIPLINE_POINTS
} from '../../../shared/scoring.js';

export function businessRouter({ store, auth }) {
  const r = express.Router();
  const { requireAuth } = auth;
  const regionName = id => (id ? (store.get('regions', id)?.name ?? id) : null);

  const scores = () => computeUnitScores(
    store.list('submissions'), store.list('units'), store.list('disciplinaryActions')
  );

  // ── RANKING ─────────────────────────────────────────────────
  // Público (tela de login): só posição, pontos e estrelas — sem nome de unidade/região
  r.get('/ranking', (_req, res) => {
    const withPts = scores().filter(s => s.total > 0);
    const max = withPts[0]?.total || 0;
    res.json(withPts.map((s, i) => ({ position: i + 1, total: s.total, stars: computeStars(s.total, max) })));
  });

  r.get('/scores/units', requireAuth(), (_req, res) => {
    const all = scores();
    const max = all[0]?.total || 0;
    res.json(all.map(s => ({ ...s, stars: computeStars(s.total, max) })));
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
  r.post('/submissions/fiscal-suggestion', requireAuth(['judge', ...ADMIN_ROLES]), (req, res) => {
    const { requirementId, regionId, unitId = null, points, subItemScores = null, subItemPcts = null, existingSubId = null } = req.body || {};
    if (typeof points !== 'number' || points < 0) throw httpError(400, 'points inválido');
    const user = req.user;
    const sub = store.tx(() => {
      const req_ = store.get('requirements', requirementId);
      if (!req_) throw httpError(404, 'Requisito não encontrado');
      const base = {
        requirementPoints: points, subItemScores, subItemPcts, status: 'pending', fiscalSuggestion: true,
        notes: `Avaliado por: ${user.name}`, submittedAt: { __serverTimestamp: true },
        submittedBy: user.username, submittedByName: user.name
      };
      if (existingSubId) return store.update('submissions', existingSubId, base);
      return store.insert('submissions', {
        regionId, regionName: regionName(regionId), unitId,
        requirementId: req_.id, requirementName: req_.name, requirementCategory: req_.category,
        competitionCategory: req_.competitionCategory || 'Ambos', proofUrl: null, source: 'judge',
        requirementDeadlineSnapshot: req_.deadline || null, ...base
      });
    });
    res.json(sub);
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
  r.post('/discipline', requireAuth(ADMIN_ROLES), (req, res) => {
    const { targetType, targetId, reason } = req.body || {};
    if (!['region', 'unit'].includes(targetType)) throw httpError(400, 'targetType deve ser "region" ou "unit"');
    if (!reason || !String(reason).trim()) throw httpError(400, 'Informe o motivo');
    const target = store.get(targetType === 'region' ? 'regions' : 'units', targetId);
    if (!target) throw httpError(404, 'Alvo não encontrado');
    res.json(store.insert('disciplinaryActions', {
      targetType, targetId, targetName: target.name, reason: String(reason).trim(), points: DISCIPLINE_POINTS,
      createdAt: { __serverTimestamp: true }, createdBy: req.user.username || 'admin', createdByName: req.user.name || 'Administrador'
    }));
  });

  r.delete('/discipline/:id', requireAuth(ADMIN_ROLES), (req, res) => {
    store.remove('disciplinaryActions', req.params.id);
    res.json({ ok: true });
  });
  return r;
}
