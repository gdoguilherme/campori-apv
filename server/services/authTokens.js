const jwt = require('jsonwebtoken');

const SECRET = process.env.JWT_SECRET;
if (!SECRET) {
  throw new Error('JWT_SECRET env var não configurada');
}
const EXPIRES_IN = '8h'; // mesmo TTL da sessão no client (js/auth.js)

function signToken(user) {
  return jwt.sign({ sub: user.id, role: user.role }, SECRET, { expiresIn: EXPIRES_IN });
}

function verifyToken(token) {
  return jwt.verify(token, SECRET); // lança se inválido/expirado
}

module.exports = { signToken, verifyToken };
