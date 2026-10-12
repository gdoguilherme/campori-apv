const express = require('express');
const { firestore, admin } = require('../services/firebaseAdmin');
const { verifyQr } = require('../services/qrTokens');
const { requireAuth } = require('../middleware/requireAuth');
const syncStore = require('../services/syncStore');

const router = express.Router();
const BATCH_MAX = 100; // igual a SCAN_BATCH_MAX em shared/sync.js

// Resolve o usuário completo (unitId/regionId vêm do banco, nunca do corpo da requisição)
async function currentUser(req, res) {
  const user = await syncStore.loadUser(firestore(), req.authUser.id);
  if (!user) { res.status(401).json({ error: 'Sessão inválida ou expirada' }); return null; }
  return user;
}

// Lote de scans de QR registrados offline. Idempotente pelo id do cliente; em conflito
// (mesma unidade + mesma prova) vence o scanTimestamp mais antigo.
router.post('/scans', requireAuth(['counselor']), async (req, res, next) => {
  try {
    const items = req.body && req.body.items;
    if (!Array.isArray(items)) return res.status(400).json({ error: 'items deve ser uma lista' });
    if (items.length > BATCH_MAX) return res.status(413).json({ error: `No máximo ${BATCH_MAX} itens por requisição` });
    const user = await currentUser(req, res); if (!user) return;
    res.json(await syncStore.processScans({ db: firestore(), admin, user, items, verifyQr }));
  } catch (err) { next(err); }
});

router.get('/bootstrap', requireAuth(['counselor']), async (req, res, next) => {
  try {
    const user = await currentUser(req, res); if (!user) return;
    res.json(await syncStore.bootstrap({ db: firestore(), user, withRanking: req.query.ranking !== '0' }));
  } catch (err) { next(err); }
});

module.exports = router;
