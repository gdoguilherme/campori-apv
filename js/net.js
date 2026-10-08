// Rede com timeout + escolha do servidor ativo (local primeiro, nuvem como reserva).
import { LOCAL_SERVER_URL, CLOUD_URL, TIMEOUTS, LOCAL_APP } from './config.js';

export class NetError extends Error {           // não chegou ao servidor (offline, DNS, timeout)
  constructor(message, kind) { super(message); this.name = 'NetError'; this.kind = kind; }
}
export class HttpError extends Error {          // o servidor respondeu com erro
  constructor(status, data) {
    super(data?.error || `HTTP ${status}`);
    this.name = 'HttpError'; this.status = status; this.data = data; this.code = data?.code;
  }
}

// fetch + leitura do corpo, ambos sob o MESMO timeout (res.json() também pode ficar pendurado)
export async function fetchJson(url, opts = {}, ms = TIMEOUTS.api) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), ms);
  try {
    const res = await fetch(url, { ...opts, signal: ctl.signal });
    // o corpo é lido AQUI, sob o mesmo prazo; se a conexão travar no meio dele, o erro de
    // aborto/rede sobe (vira NetError). Só JSON inválido é tolerado (corpo vazio/HTML de erro).
    const text = await res.text();
    let data = {};
    try { data = text ? JSON.parse(text) : {}; } catch { data = {}; }
    return { ok: res.ok, status: res.status, data };
  } catch (e) {
    throw new NetError(e.name === 'AbortError' ? `Tempo esgotado (${Math.round(ms / 1000)}s)` : 'Sem conexão', e.name === 'AbortError' ? 'timeout' : 'network');
  } finally { clearTimeout(timer); }
}

// Promise com prazo (para o que não é fetch: ex. escrita direta no Firestore)
export function withTimeout(promise, ms, message = 'Tempo esgotado') {
  let timer;
  return Promise.race([promise, new Promise((_, rej) => { timer = setTimeout(() => rej(new NetError(message, 'timeout')), ms); })])
    .finally(() => clearTimeout(timer));
}

// ── Servidor ativo ────────────────────────────────────────────
let current = { kind: 'none', base: null, at: 0 };
let inflight = null;
const listeners = new Set();
const FRESH_MS = 30_000, FRESH_NONE_MS = 4_000;

export const getServerState = () => ({ ...current, online: navigator.onLine !== false });
export function onServerChange(cb) { listeners.add(cb); return () => listeners.delete(cb); }
function setCurrent(next) {
  const changed = next.kind !== current.kind;
  current = { ...next, at: Date.now() };
  if (changed) listeners.forEach(cb => { try { cb(getServerState()); } catch { /* ignora */ } });
}
export const invalidateServer = () => { current = { ...current, at: 0 }; };

async function probe(base, ms) {
  try {
    const { ok, data } = await fetchJson(`${base}/health`, { cache: 'no-store' }, ms);
    return ok && data?.ok ? data : null;
  } catch { return null; }
}

// Testa o servidor local (timeout curto) e, se não responder, a nuvem.
export function resolveServer({ force = false } = {}) {
  const age = Date.now() - current.at;
  if (!force && age < (current.kind === 'none' ? FRESH_NONE_MS : FRESH_MS)) return Promise.resolve(current);
  if (inflight) return inflight;
  inflight = (async () => {
    const local = await probe(LOCAL_SERVER_URL, TIMEOUTS.probeLocal);
    if (local && local.mode === 'local') { setCurrent({ kind: 'local', base: LOCAL_SERVER_URL }); return current; }
    // modo local total: não existe "plano B na nuvem" — nada sai para a internet
    const cloud = LOCAL_APP ? null : await probe(CLOUD_URL, TIMEOUTS.probeCloud);
    setCurrent(cloud ? { kind: 'cloud', base: CLOUD_URL } : { kind: 'none', base: null });
    return current;
  })().finally(() => { inflight = null; });
  return inflight;
}

// A nuvem (Firestore/Fly) está alcançável? — usado antes de ações que só existem online
let cloudSeen = { ok: false, at: 0 };
// (no modo local total o backend das gravações é o próprio servidor local → é ele que precisa estar no ar)
export async function isCloudReachable() {
  if (Date.now() - cloudSeen.at < 20_000) return cloudSeen.ok;
  cloudSeen = { ok: !!(await probe(LOCAL_APP ? LOCAL_SERVER_URL : CLOUD_URL, 3500)), at: Date.now() };
  return cloudSeen.ok;
}

// Chamada JSON ao servidor ativo (local → nuvem). Cai para a nuvem se o local falhar na rede.
export async function serverFetch(path, { method = 'GET', body, token, timeout = TIMEOUTS.api } = {}) {
  const headers = { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) };
  const opts = { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined };
  const call = async base => {
    const { ok, status, data } = await fetchJson(base + path, opts, timeout);
    if (!ok) throw new HttpError(status, data);
    return data;
  };

  let srv = await resolveServer();
  if (srv.kind === 'none') throw new NetError('Sem conexão com nenhum servidor', 'offline');
  try {
    return await call(srv.base);
  } catch (e) {
    if (!(e instanceof NetError)) throw e;
    // o servidor escolhido sumiu no meio do caminho → reavalia (local caiu → nuvem)
    invalidateServer();
    const next = await resolveServer({ force: true });
    if (next.kind === 'none' || next.base === srv.base) throw e;
    return call(next.base);
  }
}
