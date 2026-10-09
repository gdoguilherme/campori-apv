// Sincronização de scans de QR Code (fila offline do Conselheiro) — módulo PURO, sem I/O.
// Usado pelo frontend (validação offline), pelo servidor local (SQLite) e pelo backend da
// nuvem (Firestore). Cada backend só LÊ os dados, chama as funções daqui e GRAVA o resultado
// dentro da sua própria transação. A cópia em server/shared/ é gerada por
// `node scripts/sync-shared.mjs` (o Docker do Fly.io só enxerga a pasta server/).

import { isUniformReq } from './uniforme.js';
import { reqFilledBy, evaluateQrScan, findQrDuplicate, computeUnitScores, tsSeconds, dedupeDisciplinaryActions } from './scoring.js';

export const SCAN_BATCH_MAX = 100;
const CLOCK_SKEW_MS = 5 * 60_000;      // scanTimestamp "do futuro" além disso é limitado ao agora
const MIN_VALID_TS = Date.UTC(2020, 0, 1);

export const scanDocId = clientId => `scan_${clientId}`; // id determinístico = idempotência

const str = v => typeof v === 'string' && v.length > 0 && v.length < 300;
// UUID/ids gerados pelo app: só estes caracteres (vira parte do id do documento no banco)
export const isValidClientId = v => typeof v === 'string' && /^[A-Za-z0-9_-]{8,80}$/.test(v);

// ── Decisão de UM item do lote ────────────────────────────────────────────────
// Entradas já lidas pelo adaptador (dentro da transação dele):
//   item         { id, unitId, requisitoId, varianteId, pontos, hash, scanTimestamp, selectedRequirementId? }
//   user         { id, unitId, regionId, username, name, ... } — do banco, NUNCA do corpo da requisição
//   requirement  doc do requisito (ou null)
//   existing     submission já gravada com id scanDocId(item.id) (ou null)
//   unitSubs     submissions da unidade para o requisito
//   hashValid    resultado de verifyQr() (feito pelo backend, que tem o QR_SECRET)
//   regionName   nome da região (denormalizado na submission, como no fluxo antigo)
//   makeTs(ms)   fábrica de timestamp do backend (Firestore Timestamp / {seconds,nanoseconds})
// Retorna { result, writes } — writes: [{ op:'insert', id, doc } | { op:'update', id, patch }]
export function decideScanItem({ item, user, requirement, existing, unitSubs, hashValid, regionName, makeTs, nowMs }) {
  const id = item?.id;
  const res = (status, code, message, extra = {}) => ({ result: { id, status, code, message, ...extra }, writes: [] });

  if (!isValidClientId(id)) return res('rejeitado', 'INVALID_ITEM', 'Registro malformado.');

  // 1. Reenvio do mesmo item → mesmo resultado de antes (sem gravar nada)
  if (existing) {
    if (existing.qrConflict === 'superseded') {
      return res('duplicado', 'SUPERSEDED', 'Outro aparelho da sua unidade escaneou esta prova antes — aquele registro foi mantido.', { submissionId: existing.id, alreadySynced: true });
    }
    return res('aceito', 'ALREADY_SYNCED', 'Este registro já havia sido sincronizado.', { submissionId: existing.id, alreadySynced: true });
  }

  // 2. Formato
  if (!item || !str(item.id) || !str(item.unitId) || !str(item.requisitoId) || !str(item.varianteId) ||
      typeof item.pontos !== 'number' || !str(item.hash) ||
      typeof item.scanTimestamp !== 'number' || !Number.isFinite(item.scanTimestamp) || item.scanTimestamp < MIN_VALID_TS) {
    return res('rejeitado', 'INVALID_ITEM', 'Registro malformado.');
  }

  // 3. A unidade vem do usuário autenticado; o item não pode pontuar outra unidade
  if (!user.unitId) return res('rejeitado', 'NO_UNIT', 'Este conselheiro não está vinculado a nenhuma unidade.');
  if (item.unitId !== user.unitId) return res('rejeitado', 'UNIT_MISMATCH', 'Este registro é de outra unidade.');

  // 4. Prova diferente da selecionada no momento do scan
  if (item.selectedRequirementId && item.selectedRequirementId !== item.requisitoId) {
    return res('rejeitado', 'WRONG_PROVA', 'Este QR Code pertence a uma prova diferente da que foi selecionada.');
  }

  // 5. Autenticidade do QR (só o servidor tem o segredo)
  if (!hashValid) return res('rejeitado', 'INVALID_HASH', 'QR Code inválido ou adulterado.');

  // 6. Prova/variante/pontos (sem a trava — ela tem regra própria de conflito abaixo)
  const verdict = evaluateQrScan({
    selectedRequirementId: item.requisitoId,
    payload: { requisitoId: item.requisitoId, varianteId: item.varianteId, pontos: item.pontos },
    requirement, submissions: [], unitId: user.unitId,
  });
  if (!verdict.ok) return res('rejeitado', verdict.code, verdict.message);
  const variant = verdict.variant;

  // 7. Trava (unitId, prova-pai): vence o scanTimestamp mais antigo, não a ordem de chegada
  // relógio do celular adiantado: nunca aceita scan "do futuro" (limita ao agora); acima da tolerância fica marcado
  const scanMs = Math.min(item.scanTimestamp, nowMs);
  const suspicious = item.scanTimestamp > nowMs + CLOCK_SKEW_MS;
  const winner = findQrDuplicate(unitSubs, user.unitId, item.requisitoId);
  const newId = scanDocId(item.id);
  const writes = [];
  let code = 'ACCEPTED', message = 'Pontuação registrada na unidade.';

  if (winner) {
    const winnerMs = typeof winner.scanTimestamp === 'number' ? winner.scanTimestamp : tsSeconds(winner.submittedAt) * 1000;
    const canSupersede = winner.source === 'qr' && scanMs < winnerMs; // aprovação manual do admin nunca é substituída
    if (!canSupersede) {
      return res('duplicado', 'DUPLICATE', 'Esta unidade já tinha pontuado nesta prova.', { submissionId: winner.id });
    }
    writes.push({
      op: 'update', id: winner.id,
      patch: {
        status: 'rejected', qrConflict: 'superseded', supersededBy: newId,
        rejectionReason: 'Substituído por um escaneamento mais antigo da mesma prova (outro aparelho da unidade).',
        reviewedAt: makeTs(nowMs), reviewedBy: 'qr-sync', reviewedByName: 'Sincronização QR',
      },
    });
    code = 'ACCEPTED_SUPERSEDED';
    message = 'Pontuação registrada. Um registro mais recente da mesma prova (outro aparelho) foi substituído por este, que foi escaneado antes.';
  }

  writes.push({
    op: 'insert', id: newId,
    doc: {
      regionId: user.regionId || null, regionName: regionName ?? null, unitId: user.unitId,
      requirementId: requirement.id, requirementName: requirement.name,
      requirementPoints: variant.points, requirementCategory: requirement.category,
      qrVariantId: variant.id, qrVariantLabel: variant.label || null,
      competitionCategory: requirement.competitionCategory || 'Ambos',
      notes: variant.label ? `Registrado via QR Code — variante: ${variant.label}` : 'Registrado via QR Code',
      proofUrl: null, status: 'approved', source: 'qr', fiscalSuggestion: false,
      clientId: item.id, scanTimestamp: scanMs, syncedAt: makeTs(nowMs),
      ...(suspicious ? { scanTimestampClamped: true } : {}),
      submittedAt: makeTs(scanMs), submittedBy: user.username, submittedByName: user.name,
      reviewedAt: makeTs(nowMs), reviewedBy: 'qr', reviewedByName: 'QR Code',
      requirementDeadlineSnapshot: requirement.deadline || null,
    },
  });
  return { result: { id, status: 'aceito', code, message, submissionId: newId }, writes };
}

// Ordem de processamento do lote: do scan mais antigo ao mais novo (desempate: ordem de envio)
export function orderBatch(items) {
  return items.map((it, i) => ({ it, i }))
    .sort((a, b) => (a.it?.scanTimestamp ?? Infinity) - (b.it?.scanTimestamp ?? Infinity) || a.i - b.i)
    .map(x => x.it);
}

// ── Validação OFFLINE (celular) ───────────────────────────────────────────────
// Usa só o que foi baixado quando havia rede: requisito (com variantes, SEM hash), o que a
// unidade já pontuou e a fila local. NÃO valida o hash — isso é feito no servidor.
export function evaluateOfflineScan({ selectedRequirementId, payload, requirement, confirmedSubs, queueItems, unitId }) {
  const queued = (queueItems || [])
    .filter(q => q.unitId === unitId && (q.status === 'pendente' || q.status === 'sincronizado'))
    .map(q => ({ requirementId: q.requisitoId, status: 'approved', unitId: q.unitId }));
  return evaluateQrScan({ selectedRequirementId, payload, requirement, submissions: [...(confirmedSubs || []), ...queued], unitId });
}

// ── Snapshot que o celular guarda para funcionar offline ──────────────────────
const pick = (o, keys) => Object.fromEntries(keys.filter(k => o[k] !== undefined).map(k => [k, o[k]]));

export function buildCounselorBootstrap({ user, unit, region, regions, participants, requirements, unitSubmissions, regionSubmissions, allSubmissions, allUnits, disciplinaryActions, nowMs }) {
  const reqs = (requirements || [])
    .filter(r => r.active !== false && reqFilledBy(r) === 'conselheiro')
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map(r => ({
      ...pick(r, ['id', 'name', 'description', 'points', 'category', 'areaAtuacao', 'code', 'deadline', 'order', 'filledBy', 'competitionCategory', 'active']),
      // só id/rótulo/pontos — o hash NUNCA vai para o celular
      qrVariants: (r.qrVariants || []).map(v => pick(v, ['id', 'label', 'points'])),
    }));
  // Pontos da REGIÃO (valem para todas as unidades dela): requisitos que não são do Conselheiro (Regional e "Só Fiscal"),
  // da modalidade da região — a mesma regra do portal regional — e as submissões no nível da região (sem unitId).
  const cat = region?.competitionCategory || null;
  const REQ_FIELDS = ['id', 'name', 'description', 'points', 'category', 'areaAtuacao', 'code', 'deadline', 'order', 'filledBy', 'competitionCategory', 'active'];
  const regionReqs = (requirements || [])
    .filter(r => r.active !== false && reqFilledBy(r) !== 'conselheiro' && !isUniformReq(r) &&
      (!cat || !r.competitionCategory || r.competitionCategory === 'Ambos' || r.competitionCategory === cat))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0))
    .map(r => ({ ...pick(r, REQ_FIELDS), filledBy: reqFilledBy(r) }));
  // Inspeção de uniforme: pontua só a UNIDADE (avaliada pelo Fiscal na tela própria) — não é "da região" nem enviada pelo conselheiro
  const inspectionReqs = (requirements || []).filter(r => r.active !== false && isUniformReq(r))
    .map(r => ({ ...pick(r, ['id', 'name', 'points', 'category', 'order']), filledBy: 'fiscal', inspection: 'uniforme' }));
  const regionId = unit?.regionId || region?.id || null;
  const regionSubs = (regionSubmissions || []).filter(s => !s.unitId && s.regionId === regionId)
    .map(s => pick(s, ['id', 'requirementId', 'status', 'requirementPoints', 'submittedAt', 'reviewedAt', 'rejectionReason', 'source', 'fiscalSuggestion', 'regionId']));
  // descontos de disciplina que atingem esta unidade (a dela ou a da região inteira); sem o motivo
  const discipline = dedupeDisciplinaryActions(disciplinaryActions || []).kept   // mesma infração lançada local + nuvem conta uma vez (igual ao ranking)
    .filter(d => (d.targetType === 'unit' && d.targetId === unit?.id) || (d.targetType === 'region' && d.targetId === regionId))
    .map(d => pick(d, ['id', 'targetType', 'targetId', 'points', 'createdAt']));

  return {
    serverTime: nowMs,
    unit: unit ? pick(unit, ['id', 'name', 'warCry', 'regionId']) : null,
    region: region ? pick(region, ['id', 'name', 'competitionCategory']) : null,
    regions: (regions || (region ? [region] : [])).map(r => pick(r, ['id', 'name'])), // nomes p/ "clube amigo" de outras regiões
    participants: (participants || []).map(p => pick(p, ['id', 'name', 'club', 'regionId', 'competitionCategory', 'unitId'])),
    requirements: reqs,
    inspectionRequirements: inspectionReqs, regionRequirements: regionReqs, regionSubmissions: regionSubs, disciplinaryActions: discipline,
    submissions: (unitSubmissions || []).map(s => pick(s, ['id', 'requirementId', 'status', 'requirementPoints', 'submittedAt', 'rejectionReason', 'source', 'qrVariantLabel', 'unitId', 'qrConflict'])),
    // ranking anônimo (só pontos) — mesmo que o login/portais já exibem
    ranking: allSubmissions && allUnits
      ? computeUnitScores(allSubmissions, allUnits, disciplinaryActions || []).filter(s => s.total > 0).map(s => ({ total: s.total }))
      : null,
  };
}
