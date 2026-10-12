const express = require('express');
const { signQr, verifyQr } = require('../services/qrTokens');
const { requireAuth } = require('../middleware/requireAuth');

const router = express.Router();

// Gera o hash de uma variante de QR Code de um requisito (Fiscal exibe/imprime na prova física)
router.post('/generate', requireAuth(['superadmin', 'admin', 'judge']), (req, res) => {
  const { requirementId, variantId, points } = req.body || {};
  if (!requirementId || !variantId || typeof points !== 'number') {
    return res.status(400).json({ error: 'requirementId, variantId e points são obrigatórios' });
  }
  const hash = signQr(requirementId, variantId, points);
  res.json({ requisitoId: requirementId, varianteId: variantId, pontos: points, hash });
});

// Valida um QR Code escaneado (qualquer usuário autenticado — ex: Conselheiro)
router.post('/verify', requireAuth(), (req, res) => {
  const { requisitoId, varianteId, pontos, hash } = req.body || {};
  if (!requisitoId || !varianteId || typeof pontos !== 'number' || !hash) {
    return res.status(400).json({ error: 'QR Code inválido' });
  }
  if (!verifyQr(requisitoId, varianteId, pontos, hash)) {
    return res.status(401).json({ error: 'QR Code inválido ou adulterado' });
  }
  res.json({ valid: true });
});

module.exports = router;
