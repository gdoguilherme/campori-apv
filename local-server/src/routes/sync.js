import express from 'express';
import { httpError } from '../db.js';
import { wrap } from '../auth.js';
import { decideScanItem, orderBatch, buildCounselorBootstrap, scanDocId, SCAN_BATCH_MAX } from '../../../shared/sync.js';

// Sincronização do app do Conselheiro (fila offline). Mesmo contrato do backend da nuvem
// (server/routes/sync.js) — a decisão de cada item vive em shared/sync.js.
export function syncRouter({ store, auth, engine = null, config = {} }) {
  const r = express.Router();
  const { requireAuth, verifyQr } = auth;
  const makeTs = ms => ({ seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1e6 });

  // Processa UM item numa transação SQLite (BEGIN IMMEDIATE serializa com qualquer outro
  // aparelho sincronizando ao mesmo tempo → a trava e o "vence o mais antigo" são atômicos)
  function processItem(user, item, nowMs) {
    return store.tx(() => {
      const ok = item && typeof item === 'object';
      const requisitoId = ok ? String(item.requisitoId || '') : '';
      const { result, writes } = decideScanItem({
        item, user,
        requirement: requisitoId ? store.get('requirements', requisitoId) : null,
        existing: ok && item.id ? store.get('submissions', scanDocId(item.id)) : null,
        unitSubs: user.unitId && requisitoId ? store.list('submissions', { filters: { unitId: user.unitId, requirementId: requisitoId } }) : [],
        hashValid: ok && verifyQr(requisitoId, item.varianteId, item.pontos, item.hash),
        regionName: user.regionId ? (store.get('regions', user.regionId)?.name ?? user.regionId) : null,
        makeTs, nowMs,
      });
      for (const w of writes) {
        if (w.op === 'insert') store.insert('submissions', w.doc, w.id);
        else store.update('submissions', w.id, w.patch);
      }
      return result;
    });
  }

  r.post('/scans', requireAuth(['counselor']), wrap(async (req, res) => {
    const items = req.body?.items;
    if (!Array.isArray(items)) throw httpError(400, 'items deve ser uma lista');
    if (items.length > SCAN_BATCH_MAX) throw httpError(413, `No máximo ${SCAN_BATCH_MAX} itens por requisição`);
    const nowMs = Date.now();
    const byId = new Map();
    for (const it of orderBatch(items)) byId.set(it, processItem(req.user, it, nowMs));
    res.json({ serverTime: nowMs, results: items.map(it => byId.get(it)) }); // mesma ordem do envio
  }));

  // Snapshot da unidade do conselheiro (para o app funcionar offline). Sem hashes de QR.
  r.get('/bootstrap', requireAuth(['counselor']), (req, res) => {
    const user = req.user;
    const unit = user.unitId ? store.get('units', user.unitId) : null;
    const withRanking = req.query.ranking !== '0';
    res.json(buildCounselorBootstrap({
      user, unit,
      region: unit?.regionId ? store.get('regions', unit.regionId) : (user.regionId ? store.get('regions', user.regionId) : null),
      regions: store.list('regions'),
      participants: user.unitId ? store.list('participants', { filters: { unitId: user.unitId } }) : [],
      requirements: store.list('requirements'),
      unitSubmissions: user.unitId ? store.list('submissions', { filters: { unitId: user.unitId } }) : [],
      // pontos da região (sem unitId) — valem para todas as unidades dela
      regionSubmissions: unit?.regionId ? store.list('submissions', { filters: { regionId: unit.regionId, unitId: null } }) : [],
      allSubmissions: withRanking ? store.list('submissions') : null,
      allUnits: withRanking ? store.list('units') : null,
      disciplinaryActions: store.list('disciplinaryActions'),   // o construtor filtra as que atingem esta unidade/região
      nowMs: Date.now(),
    }));
  });

  // ── Estado e "Sincronizar agora" para a barra de TODOS os portais (qualquer perfil logado) ──
  // state: o servidor local está no ar + quantos itens aguardam envio à nuvem. cloud-now: manda o motor de sincronização agir já.
  r.get('/state', requireAuth(), (_req, res) => {
    const st = engine?.status?.();
    res.set('Cache-Control', 'no-store').json({
      serverTime: Date.now(), revision: store.revision(), version: config.version ?? null,
      cloud: { enabled: !!st?.enabled, state: st?.cloud?.state || 'disabled', lastSuccessAt: st?.push?.lastSuccessAt ?? null },
      // sem sincronização ligada (modo só-PC / demo) nada vai sair para a nuvem: não é pendência
      pendingCloud: st?.enabled ? store.dirtyCounts().total : 0,
    });
  });
  r.post('/cloud-now', requireAuth(), wrap(async (_req, res) => {
    if (!engine) return res.json({ ok: false, disabled: true, message: 'A sincronização com a nuvem está desligada neste servidor.', pendingCloud: 0 });
    const result = await engine.syncNow({ manual: true });
    res.json({ ok: !!result?.ok, offline: !!result?.offline, message: result?.message || '', pendingCloud: store.dirtyCounts().total });
  }));
  return r;
}
