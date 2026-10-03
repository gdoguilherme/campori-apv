import express from 'express';
import { httpError } from '../db.js';
import { evaluateQrScan } from '../../../shared/scoring.js';

export function qrRouter({ store, auth }) {
  const r = express.Router();
  const { requireAuth, signQr, verifyQr } = auth;

  // Fiscal exibe/imprime — mesmo contrato da nuvem
  r.post('/generate', requireAuth(['superadmin', 'admin', 'judge']), (req, res) => {
    const { requirementId, variantId, points } = req.body || {};
    if (!requirementId || !variantId || typeof points !== 'number') {
      throw httpError(400, 'requirementId, variantId e points são obrigatórios');
    }
    res.json({ requisitoId: requirementId, varianteId: variantId, pontos: points, hash: signQr(requirementId, variantId, points) });
  });

  r.post('/verify', requireAuth(), (req, res) => {
    const { requisitoId, varianteId, pontos, hash } = req.body || {};
    if (!requisitoId || !varianteId || typeof pontos !== 'number' || !hash) throw httpError(400, 'QR Code inválido');
    if (!verifyQr(requisitoId, varianteId, pontos, hash)) throw httpError(401, 'QR Code inválido ou adulterado');
    res.json({ valid: true });
  });

  // NOVO (só local): valida o QR E registra a pontuação numa única operação atômica no
  // servidor — a trava de duplicidade (unitId, requisitoId) vale mesmo com 2 celulares
  // escaneando ao mesmo tempo (o SQLite serializa a transação).
  r.post('/redeem', requireAuth(['counselor']), (req, res) => {
    const { requisitoId, varianteId, pontos, hash, selectedRequirementId } = req.body || {};
    if (!requisitoId || !varianteId || typeof pontos !== 'number' || !hash) throw httpError(400, 'QR Code inválido');
    if (!verifyQr(requisitoId, varianteId, pontos, hash)) throw httpError(401, 'QR Code inválido ou adulterado');
    const user = req.user;
    if (!user.unitId) throw httpError(422, 'Este conselheiro não está vinculado a nenhuma unidade');

    const sub = store.tx(() => {
      const requirement = store.get('requirements', requisitoId);
      const submissions = store.list('submissions', { filters: { unitId: user.unitId, requirementId: requisitoId } });
      const verdict = evaluateQrScan({
        selectedRequirementId, payload: { requisitoId, varianteId, pontos }, requirement, submissions, unitId: user.unitId
      });
      if (!verdict.ok) throw httpError(verdict.status, verdict.message, verdict.code);
      const { variant } = verdict;
      return store.insert('submissions', {
        regionId: user.regionId || null,
        regionName: user.regionId ? (store.get('regions', user.regionId)?.name ?? user.regionId) : null,
        unitId: user.unitId,
        requirementId: requirement.id, requirementName: requirement.name,
        requirementPoints: variant.points, requirementCategory: requirement.category,
        qrVariantId: variant.id, qrVariantLabel: variant.label || null,
        competitionCategory: requirement.competitionCategory || 'Ambos',
        notes: variant.label ? `Registrado via QR Code — variante: ${variant.label}` : 'Registrado via QR Code',
        proofUrl: null, status: 'approved', source: 'qr', fiscalSuggestion: false,
        submittedAt: { __serverTimestamp: true }, submittedBy: user.username, submittedByName: user.name,
        reviewedAt: { __serverTimestamp: true }, reviewedBy: 'qr', reviewedByName: 'QR Code',
        requirementDeadlineSnapshot: requirement.deadline || null
      });
    });
    res.json({ ok: true, submission: sub });
  });
  return r;
}
