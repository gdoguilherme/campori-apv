import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { httpError } from './db.js';

export const ADMIN_ROLES = ['superadmin', 'admin'];
export const wrap = fn => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function createAuth({ store, config }) {
  // Mesmo formato de token da nuvem: { sub, role }, 8h
  const signToken = user => jwt.sign({ sub: user.id, role: user.role }, config.jwtSecret, { expiresIn: '8h' });

  // allowedRoles: array de roles, ou omitido para qualquer usuário autenticado e ativo.
  // Carrega o usuário do banco (precisamos de regionId/unitId, que não vão no token).
  function requireAuth(allowedRoles = null) {
    return (req, _res, next) => {
      try {
        const h = req.headers.authorization || '';
        const token = h.startsWith('Bearer ') ? h.slice(7) : null;
        if (!token) throw httpError(401, 'Não autenticado');
        let payload;
        try { payload = jwt.verify(token, config.jwtSecret); } catch { throw httpError(401, 'Sessão inválida ou expirada'); }
        const user = store.get('users', payload.sub);
        if (!user || user.active === false) throw httpError(401, 'Sessão inválida ou expirada');
        if (allowedRoles && !allowedRoles.includes(user.role)) throw httpError(403, 'Sem permissão');
        req.user = user;
        req.authUser = { id: user.id, role: user.role };
        next();
      } catch (e) { next(e); }
    };
  }

  // Assinatura de QR — MESMO algoritmo de server/services/qrTokens.js (nuvem). Qualquer
  // mudança aqui invalida QR Codes impressos; test/qr-compat.test.js garante a paridade.
  const signQr = (requirementId, variantId, points) =>
    crypto.createHmac('sha256', config.qrSecret).update(`${requirementId}:${variantId}:${points}`).digest('hex').slice(0, 16);
  const verifyQr = (requirementId, variantId, points, hash) => {
    if (!hash || typeof hash !== 'string') return false;
    const a = Buffer.from(signQr(requirementId, variantId, points)), b = Buffer.from(hash);
    return a.length === b.length && crypto.timingSafeEqual(a, b);
  };

  return { signToken, requireAuth, signQr, verifyQr };
}
