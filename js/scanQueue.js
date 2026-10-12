// Fila offline de scans de QR Code do Conselheiro + sincronização + snapshot da unidade.
//
// Fluxo: todo scan válido entra PRIMEIRO na fila (IndexedDB) e só depois é enviado — assim nada
// se perde se a conexão cair no meio. O id gerado no aparelho (UUID) é a chave de idempotência
// no servidor. A autenticidade do hash só é validada no servidor (o celular não guarda hashes).
import * as idb from './offlineDb.js';
import { TIMEOUTS } from './config.js';
import { serverFetch, resolveServer, getServerState, onServerChange, HttpError, NetError } from './net.js';
import { getSession, getToken } from './auth.js';

export const STATUS = { PENDENTE: 'pendente', SINCRONIZADO: 'sincronizado', DUPLICADO: 'duplicado', REJEITADO: 'rejeitado' };
const CHUNK = 50;                       // itens por requisição (o servidor aceita até 100)
const BACKOFF_BASE_MS = 15_000, BACKOFF_MAX_MS = 5 * 60_000;
const SNAPSHOT_EVERY_MS = 45_000;       // atualização periódica dos dados (aba visível e online)
const MIN_GAP_MS = 4_000;               // evita rajada de tentativas (online + focus + visibilitychange juntos)

// ── estado observável ─────────────────────────────────────────
const state = { syncing: false, lastSyncAt: null, lastError: null, authExpired: false, attempts: 0, nextRetryAt: 0, lastAttemptAt: 0 };
const listeners = new Set();
export const getSyncState = () => ({ ...state });
export function onQueueChange(cb) { listeners.add(cb); return () => listeners.delete(cb); }
const emit = () => listeners.forEach(cb => { try { cb(); } catch (e) { console.warn(e); } });

export const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : ([1e7] + -1e3 + -4e3 + -8e3 + -1e11).replace(/[018]/g, c =>
  (c ^ (crypto.getRandomValues(new Uint8Array(1))[0] & (15 >> (c / 4)))).toString(16)));

// ── fila ──────────────────────────────────────────────────────
export async function listQueue(userId) {
  const all = await idb.getAll('queue');
  return all.filter(q => q.userId === userId).sort((a, b) => b.scanTimestamp - a.scanTimestamp);
}

export async function enqueueScan({ user, requirement, variant, payload, selectedRequirementId, scanTimestamp = Date.now() }) {
  const item = {
    id: uuid(),
    userId: user.id, conselheiro: { id: user.id, username: user.username, name: user.name },
    unitId: user.unitId,
    requisitoId: payload.requisitoId, varianteId: payload.varianteId, pontos: payload.pontos,
    qr: { requisitoId: payload.requisitoId, varianteId: payload.varianteId, pontos: payload.pontos, hash: payload.hash }, // conteúdo lido do QR
    selectedRequirementId: selectedRequirementId || null,
    requirementName: requirement?.name || '', variantLabel: variant?.label || '',
    scanTimestamp,                       // momento exato do escaneamento (decide conflitos entre aparelhos)
    status: STATUS.PENDENTE, message: '', code: null, submissionId: null, attempts: 0, createdAt: Date.now(),
  };
  await idb.put('queue', item);
  emit();
  return item;
}

const toWire = q => ({
  id: q.id, unitId: q.unitId, requisitoId: q.qr.requisitoId, varianteId: q.qr.varianteId,
  pontos: q.qr.pontos, hash: q.qr.hash, scanTimestamp: q.scanTimestamp, selectedRequirementId: q.selectedRequirementId,
});
const STATUS_FROM_SERVER = { aceito: STATUS.SINCRONIZADO, duplicado: STATUS.DUPLICADO, rejeitado: STATUS.REJEITADO };

// ── sincronização ─────────────────────────────────────────────
function scheduleBackoff() {
  state.attempts++;
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (state.attempts - 1));
  state.nextRetryAt = Date.now() + base * (0.8 + Math.random() * 0.4); // jitter ±20%
}

let inflight = null;

// Envia os itens pendentes do usuário logado. Uma sincronização por vez (quem chamar junto
// recebe a mesma promessa). Retorna um resumo para a interface.
export function syncNow({ manual = false } = {}) {
  if (inflight) return inflight;
  inflight = (async () => {
    state.syncing = true; state.lastAttemptAt = Date.now(); emit();
    const summary = { sent: 0, accepted: [], duplicates: [], rejected: [], offline: false, authExpired: false, error: null };
    try {
      const user = getSession(), token = getToken();
      if (!user || !token) { state.authExpired = true; summary.authExpired = true; return summary; }
      const pending = (await listQueue(user.id)).filter(q => q.status === STATUS.PENDENTE).sort((a, b) => a.scanTimestamp - b.scanTimestamp);
      const srv = await resolveServer({ force: manual });
      if (srv.kind === 'none') { summary.offline = true; if (pending.length) scheduleBackoff(); return summary; }
      if (!pending.length) { state.authExpired = false; return summary; }

      for (let i = 0; i < pending.length; i += CHUNK) {
        const chunk = pending.slice(i, i + CHUNK);
        let data;
        try {
          data = await serverFetch('/sync/scans', { method: 'POST', token, body: { items: chunk.map(toWire) }, timeout: TIMEOUTS.sync });
        } catch (e) {
          if (e instanceof HttpError && e.status === 401) { state.authExpired = true; summary.authExpired = true; break; } // fila intacta
          if (e instanceof NetError) { summary.offline = true; scheduleBackoff(); break; }
          summary.error = e.message; state.lastError = e.message; scheduleBackoff(); break;
        }
        state.authExpired = false;
        const byId = new Map(chunk.map(q => [q.id, q]));
        for (const r of data.results || []) {
          const q = byId.get(r.id);
          if (!q || !STATUS_FROM_SERVER[r.status]) continue;
          Object.assign(q, { status: STATUS_FROM_SERVER[r.status], message: r.message || '', code: r.code || null, submissionId: r.submissionId || null, syncedAt: Date.now() });
          await idb.put('queue', q);
          summary.sent++;
          (r.status === 'aceito' ? summary.accepted : r.status === 'duplicado' ? summary.duplicates : summary.rejected).push(q);
        }
        emit();
      }
      if (summary.sent > 0 || manual) { state.lastSyncAt = Date.now(); state.attempts = 0; state.nextRetryAt = 0; state.lastError = null; }
      if (summary.sent > 0) refreshSnapshot().catch(() => {}); // pontos confirmados mudaram
      return summary;
    } finally { state.syncing = false; emit(); }
  })().finally(() => { inflight = null; });
  return inflight;
}

// ── snapshot (dados da unidade para funcionar offline) ────────
const snapKey = userId => `snapshot:${userId}`;
export async function loadSnapshot(userId) { return (await idb.get('kv', snapKey(userId))) || null; }

let snapInflight = null;
export function refreshSnapshot() {
  if (snapInflight) return snapInflight;
  snapInflight = (async () => {
    const user = getSession(), token = getToken();
    if (!user || !token) return null;
    try {
      const data = await serverFetch('/sync/bootstrap', { token, timeout: TIMEOUTS.bootstrap });
      const prev = await loadSnapshot(user.id);
      if (data.ranking === null && prev?.data?.ranking) data.ranking = prev.data.ranking;
      const snap = { key: snapKey(user.id), userId: user.id, data, updatedAt: Date.now(), source: getServerState().kind };
      await idb.put('kv', snap);
      state.authExpired = false;
      emit();
      return snap;
    } catch (e) {
      if (e instanceof HttpError && e.status === 401) { state.authExpired = true; emit(); }
      return null; // offline: segue com o último snapshot guardado
    }
  })().finally(() => { snapInflight = null; });
  return snapInflight;
}

// Ao sair: apaga os dados baixados (privacidade) mas NÃO a fila de scans pendentes
export async function clearSnapshot(userId) { await idb.del('kv', snapKey(userId)); }

// ── gatilhos automáticos ──────────────────────────────────────
// Ao abrir, ao voltar a rede (`online`), ao voltar o foco da aba, e periodicamente (backoff).
export function startAutoSync() {
  let lastSnap = Date.now();
  const attempt = ({ ignoreBackoff = false } = {}) => {
    const now = Date.now();
    if (state.syncing || now - state.lastAttemptAt < MIN_GAP_MS) return;
    if (!ignoreBackoff && now < state.nextRetryAt) return;
    syncNow().then(sum => listeners2.forEach(cb => cb(sum))).catch(() => {});
  };
  const onBack = () => { if (document.visibilityState !== 'hidden') attempt({ ignoreBackoff: true }); };
  const onOnline = () => { state.nextRetryAt = 0; resolveServer({ force: true }).then(() => attempt({ ignoreBackoff: true })); emit(); };
  const onOffline = () => emit();

  window.addEventListener('online', onOnline);
  window.addEventListener('offline', onOffline);
  window.addEventListener('focus', onBack);
  document.addEventListener('visibilitychange', onBack);
  const unsubServer = onServerChange(() => emit());

  const tick = setInterval(async () => {
    if (document.visibilityState === 'hidden') return;
    const user = getSession();
    if (user && (await listQueue(user.id)).some(q => q.status === STATUS.PENDENTE)) attempt();
    if (navigator.onLine !== false && Date.now() - lastSnap > SNAPSHOT_EVERY_MS) { lastSnap = Date.now(); refreshSnapshot().catch(() => {}); }
    emit(); // atualiza "há X min" e o contador de retentativa
  }, 15_000);

  attempt({ ignoreBackoff: true }); // ao abrir o app
  return () => {
    window.removeEventListener('online', onOnline); window.removeEventListener('offline', onOffline);
    window.removeEventListener('focus', onBack); document.removeEventListener('visibilitychange', onBack);
    unsubServer(); clearInterval(tick);
  };
}

// quem quiser ser avisado do resultado das sincronizações AUTOMÁTICAS (ex: duplicado detectado)
const listeners2 = new Set();
export function onAutoSyncResult(cb) { listeners2.add(cb); return () => listeners2.delete(cb); }
