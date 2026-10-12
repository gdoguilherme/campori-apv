const { verifyToken } = require('../services/authTokens');

// allowedRoles: array de roles permitidos, ou null/omitido para qualquer usuário autenticado
function requireAuth(allowedRoles = null) {
  return (req, res, next) => {
    const header = req.headers.authorization || '';
    const token = header.startsWith('Bearer ') ? header.slice(7) : null;
    if (!token) return res.status(401).json({ error: 'Não autenticado' });

    let payload;
    try {
      payload = verifyToken(token);
    } catch (e) {
      return res.status(401).json({ error: 'Sessão inválida ou expirada' });
    }

    if (allowedRoles && !allowedRoles.includes(payload.role)) {
      return res.status(403).json({ error: 'Sem permissão' });
    }

    req.authUser = { id: payload.sub, role: payload.role };
    next();
  };
}

module.exports = { requireAuth };
