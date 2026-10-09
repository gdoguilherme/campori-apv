import express from 'express';
import { COLLECTIONS, INDEXED, httpError } from '../db.js';
import { ADMIN_ROLES } from '../auth.js';

// CRUD genérico das coleções (equivalente ao acesso direto ao Firestore que o frontend faz
// hoje). Regras de negócio sensíveis têm rotas próprias (business.js) e coleções protegidas aqui.
const MIXED = [...ADMIN_ROLES, 'region', 'counselor'];
const REGION_PROFILE_FIELDS = ['warCry', 'extraInfo', 'logoUrl'];
const WRITE_ROLES = {
  regions: ADMIN_ROLES,
  requirements: ADMIN_ROLES,
  units: MIXED,
  participants: MIXED,
  submissions: ADMIN_ROLES,   // envio/avaliação/QR: POST /submissions, /qr/redeem etc.; região/conselheiro só PATCH proofUrl (abaixo)
  disciplinaryActions: [],    // só via POST/DELETE /discipline (pontos fixos em 5)
  auditLog: [],               // escrito pelo servidor
};

export function dataRouter({ store, auth }) {
  const r = express.Router();
  const { requireAuth } = auth;

  r.use('/:col', (req, _res, next) => {
    if (!COLLECTIONS.includes(req.params.col) || req.params.col === 'users') return next(httpError(404, 'Coleção desconhecida'));
    next();
  });

  r.get('/:col', requireAuth(), (req, res) => {
    const { col } = req.params;
    const { since, ...q } = req.query;
    const filters = {};
    for (const [k, v] of Object.entries(q)) if (INDEXED[col].includes(k)) filters[k] = v === 'null' ? null : v;
    const docs = store.list(col, { filters, since: Number(since) || 0, includeDeleted: !!since });
    res.json({ revision: store.revision(), docs });
  });

  r.get('/:col/:id', requireAuth(), (req, res) => {
    const doc = store.get(req.params.col, req.params.id);
    if (!doc) throw httpError(404, 'Documento não encontrado');
    res.json(doc);
  });

  function canWrite(req, col) {
    return WRITE_ROLES[col].includes(req.user.role);
  }

  r.post('/:col', requireAuth(), (req, res) => {
    const { col } = req.params;
    if (!canWrite(req, col)) throw httpError(403, 'Sem permissão');
    const body = { ...req.body };
    if (col === 'requirements' && body.order === undefined) body.order = store.count('requirements');
    res.json(store.insert(col, { ...body, createdAt: { __serverTimestamp: true } }));
  });

  r.patch('/:col/:id', requireAuth(), (req, res) => {
    const { col, id } = req.params;
    if (canWrite(req, col)) return res.json(store.update(col, id, req.body));
    // região/conselheiro anexando comprovação à PRÓPRIA submission
    if (col === 'submissions' && ['region', 'counselor'].includes(req.user.role)) {
      const sub = store.get('submissions', id);
      const mine = sub && (req.user.role === 'counselor' ? sub.unitId === req.user.unitId : (!sub.unitId && sub.regionId === req.user.regionId));
      if (!mine) throw httpError(403, 'Sem permissão');
      return res.json(store.update(col, id, { proofUrl: req.body?.proofUrl ?? null }));
    }
    // região editando o PRÓPRIO perfil (nome de guerra, logo, informações extras) — nada além disso
    if (col === 'regions' && req.user.role === 'region' && id === req.user.regionId) {
      const patch = {};
      for (const k of REGION_PROFILE_FIELDS) if (k in (req.body || {})) patch[k] = req.body[k];
      return res.json(store.update(col, id, patch));
    }
    throw httpError(403, 'Sem permissão');
  });

  r.delete('/:col/:id', requireAuth(), (req, res) => {
    if (!canWrite(req, req.params.col)) throw httpError(403, 'Sem permissão');
    store.remove(req.params.col, req.params.id);
    res.json({ ok: true });
  });
  return r;
}
