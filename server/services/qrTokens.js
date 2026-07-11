const crypto = require('crypto');

const SECRET = process.env.QR_SECRET;
if (!SECRET) {
  throw new Error('QR_SECRET env var não configurada');
}

// Assina {requirementId, points} — o mesmo par sempre gera o mesmo hash,
// então o QR impresso continua válido mesmo depois de reiniciar o servidor
function signQr(requirementId, points) {
  return crypto.createHmac('sha256', SECRET).update(`${requirementId}:${points}`).digest('hex').slice(0, 16);
}

function verifyQr(requirementId, points, hash) {
  if (!hash || typeof hash !== 'string') return false;
  const expected = signQr(requirementId, points);
  const a = Buffer.from(expected);
  const b = Buffer.from(hash);
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

module.exports = { signQr, verifyQr };
