// Sessão em localStorage (sobrevive a fechar/reabrir o app — necessário para o Conselheiro
// operar em campo sem sinal). A expiração acompanha o `exp` do JWT: 5 dias para Conselheiro
// (evento inteiro), 8h para os demais perfis.
const SESSION_KEY = 'campori_v3_session';
const HOUR = 3600_000;
const ttlFor = role => (role === 'counselor' ? 5 * 24 * HOUR : 8 * HOUR);

const lsGet = k => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* quota/privado */ } };

function jwtExp(token) {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    const { exp } = JSON.parse(atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4)));
    return exp ? exp * 1000 : null;
  } catch { return null; }
}

function read() {
  let raw = lsGet(SESSION_KEY);
  if (!raw) {
    // migração: sessão antiga (guardada em sessionStorage antes desta versão)
    try {
      raw = sessionStorage.getItem(SESSION_KEY);
      if (raw) { lsSet(SESSION_KEY, raw); sessionStorage.removeItem(SESSION_KEY); }
    } catch { /* ignora */ }
  }
  try { return raw ? JSON.parse(raw) : null; } catch { return null; }
}

export function saveSession(user, token) {
  const prev = read();
  const tok = token || prev?.token || null;
  // token novo → vale até o `exp` dele; sem token novo (ex: troca de senha) mantém o prazo atual
  const expiresAt = token
    ? (jwtExp(token) ?? Date.now() + ttlFor(user.role))
    : (prev?.expiresAt ?? Date.now() + ttlFor(user.role));
  lsSet(SESSION_KEY, JSON.stringify({ user, token: tok, expiresAt }));
}

export function getSession() {
  const s = read();
  if (!s) return null;
  if (Date.now() > s.expiresAt) { clearSession(); return null; }
  return s.user;
}

// Token JWT emitido pelo backend — usado nas chamadas autenticadas
export function getToken() {
  const s = read();
  if (!s || Date.now() > s.expiresAt) return null;
  return s.token || null;
}

// Só a SESSÃO. A fila offline (IndexedDB) nunca é apagada aqui — ver js/scanQueue.js.
export function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch { /* ignora */ }
  try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignora */ }
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
