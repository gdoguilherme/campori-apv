const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  throw new Error('JWT_SECRET env var não configurada');
}
// Conselheiro: 5 dias (cobre o evento 9–12/10 — a fila offline não pode ser rejeitada por token
// vencido). Demais perfis: 8h. O client lê o `exp` do próprio token (js/auth.js).
const ttlFor = role => (role === 'counselor' ? '5d' : '8h');

function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, SECRET, { expiresIn: ttlFor(user.role) });
}

function verifyToken(token) {
  return jwt.verify(token, SECRET); // lança se inválido/expirado
}

module.exports = { signToken, verifyToken };
