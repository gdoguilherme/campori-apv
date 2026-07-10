const SESSION_KEY = 'campori_v3_session';
const SESSION_TTL = 8 * 60 * 60 * 1000; // 8 horas

export function saveSession(user, token) {
  const raw = sessionStorage.getItem(SESSION_KEY);
  const prevToken = (() => { try { return JSON.parse(raw)?.token; } catch { return null; } })();
  sessionStorage.setItem(SESSION_KEY, JSON.stringify({
    user,
    token: token || prevToken || null,
    expiresAt: Date.now() + SESSION_TTL
  }));
}

export function getSession() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const { user, expiresAt } = JSON.parse(raw);
    if (Date.now() > expiresAt) {
      sessionStorage.removeItem(SESSION_KEY);
      return null;
    }
    return user;
  } catch {
    return null;
  }
}

// Token JWT emitido pelo backend (server/) — usado nas chamadas autenticadas
// dos endpoints que tocam a coleção `users` (login, troca de senha, CRUD de usuários/regiões)
export function getToken() {
  try {
    const raw = sessionStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const { token, expiresAt } = JSON.parse(raw);
    if (Date.now() > expiresAt) return null;
    return token || null;
  } catch {
    return null;
  }
}

export function clearSession() {
  sessionStorage.removeItem(SESSION_KEY);
}

export function portalUrlForUser(user) {
  if (!user) return '/pages/login.html';
  if (['superadmin', 'admin', 'approver'].includes(user.role)) return '/pages/admin.html';
  if (user.role === 'judge') return '/pages/fiscal.html';
  if (user.role === 'region') {
    return user.competitionCategory === 'AVT' ? '/pages/regiao/avt.html' : '/pages/regiao/dbv.html';
  }
  if (user.role === 'counselor') return '/pages/conselheiro.html';
  return '/pages/login.html';
}

// Redireciona para o portal se já estiver autenticado (usar em login.html)
export function guardLogin() {
  const user = getSession();
  if (user) {
    location.replace(portalUrlForUser(user));
    return true;
  }
  return false;
}

// Protege páginas autenticadas; redireciona para login se sem sessão
// allowedRoles: array de roles permitidos, ou null para qualquer role autenticado
export function guardPage(allowedRoles = null) {
  const user = getSession();
  if (!user) {
    location.replace('/pages/login.html');
    return null;
  }
  if (allowedRoles && !allowedRoles.includes(user.role)) {
    location.replace(portalUrlForUser(user));
    return null;
  }
  return user;
}

export function logout() {
  clearSession();
  location.replace('/pages/login.html');
}

// Verifica expiração a cada minuto e redireciona se expirou
export function startExpiryWatcher() {
  setInterval(() => {
    if (!getSession()) {
      clearSession();
      location.replace('/pages/login.html');
    }
  }, 60_000);
}
