const express = require('express');
const { signQr, verifyQr } = require('../services/qrTokens');
const { requireAuth } = require('../middleware/requireAuth');

const router = express.Router();

// Gera o hash de um QR Code para um requisito (impresso previamente pelo admin)
router.post('/generate', requireAuth(['superadmin', 'admin']), (req, res) => {
  const { requirementId, points } = req.body || {};
  if (!requirementId || typeof points !== 'number') {
    return res.status(400).json({ error: 'requirementId e points são obrigatórios' });
  }
  const hash = signQr(requirementId, points);
  res.json({ requisitoId: requirementId, pontos: points, hash });
});

// Valida um QR Code escaneado (qualquer usuário autenticado — ex: Conselheiro)
router.post('/verify', requireAuth(), (req, res) => {
  const { requisitoId, pontos, hash } = req.body || {};
  if (!requisitoId || typeof pontos !== 'number' || !hash) {
    return res.status(400).json({ error: 'QR Code inválido' });
  }
  if (!verifyQr(requisitoId, pontos, hash)) {
    return res.status(401).json({ error: 'QR Code inválido ou adulterado' });
  }
  res.json({ valid: true });
});

module.exports = router;
