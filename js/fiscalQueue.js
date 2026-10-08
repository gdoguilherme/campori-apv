// Fila offline das avaliações do Fiscal (modo local): toda avaliação entra PRIMEIRO no IndexedDB do aparelho e só
// depois é enviada ao servidor local — se o Wi-Fi/servidor cair no meio, nada se perde.
// Idempotência: cada item tem um `id` (UUID, enviado como `clientId`) e o momento da avaliação (`evaluatedAt`);
// o servidor ignora reenvios do mesmo item e nunca deixa uma avaliação antiga sobrescrever uma mais nova.
// Guarda no store `kv` do offlineDb (chaves `fiscalq:<userId>:<id>`) — não mexe no schema nem na fila de scans.
import * as idb from './offlineDb.js';
import { TIMEOUTS } from './config.js';
import { serverFetch, resolveServer, HttpError, NetError } from './net.js';
import { getSession, getToken } from './auth.js';

export const FQ_STATUS = { PENDENTE: 'pendente', ENVIADO: 'enviado', SUBSTITUIDO: 'substituido', REJEITADO: 'rejeitado' };
const PREFIX = 'fiscalq:';
const BACKOFF_BASE_MS = 8_000, BACKOFF_MAX_MS = 2 * 60_000, MIN_GAP_MS = 2_000;

const state = { syncing: false, lastSyncAt: null, lastError: null, authExpired: false, attempts: 0, nextRetryAt: 0, lastAttemptAt: 0 };
const listeners = new Set(), syncListeners = new Set();
export const getFiscalSyncState = () => ({ ...state });
export const onFiscalQueueChange = cb => { listeners.add(cb); return () => listeners.delete(cb); };
export const onFiscalSynced = cb => { syncListeners.add(cb); return () => syncListeners.delete(cb); };
const emit = () => listeners.forEach(cb => { try { cb(); } catch (e) { console.warn(e); } });

const uuid = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID()
  : 'f' + Date.now().toString(36) + Math.random().toString(36).slice(2, 12));

export const isQueuePersistent = () => idb.isPersistent();

export async function listFiscalQueue(userId) {
  const all = await idb.getAll('kv');
  return all.filter(k => typeof k.key === 'string' && k.key.startsWith(PREFIX) && k.userId === userId).sort((a, b) => b.evaluatedAt - a.evaluatedAt);
}

export async function enqueueFiscal({ user, req, regionId, unitId = null, points, subItemScores = null, subItemPcts = null, existingSubId = null, scopeLabel = '', evaluatedAt = Date.now() }) {
  const id = uuid();
  const item = {
    key: `${PREFIX}${user.id}:${id}`, id, userId: user.id,
    requirementId: req.id, requirementName: req.name || '', regionId, unitId: unitId || null, scopeLabel,
    points, subItemScores, subItemPcts, existingSubId: existingSubId || null,
    evaluatedAt, createdAt: Date.now(),
    status: FQ_STATUS.PENDENTE, message: '', attempts: 0
  };
  await idb.put('kv', item);
  emit();
  return item;
}

// Itens já resolvidos (enviados/ignorados) só servem para o fiscal conferir — somem depois de `olderMs`
export async function pruneFiscalQueue(userId, olderMs = 24 * 3600_000) {
  const limit = Date.now() - olderMs;
  for (const q of await listFiscalQueue(userId)) {
    if ((q.status === FQ_STATUS.ENVIADO || q.status === FQ_STATUS.SUBSTITUIDO) && (q.syncedAt || q.createdAt) < limit) await idb.del('kv', q.key);
  }
}

export async function discardFiscalItem(item) {
  if (item.status === FQ_STATUS.PENDENTE) return false; // pendente nunca é descartado por engano
  await idb.del('kv', item.key);
  emit();
  return true;
}

const toWire = q => ({
  clientId: q.id, evaluatedAt: q.evaluatedAt, requirementId: q.requirementId, regionId: q.regionId, unitId: q.unitId,
  points: q.points, subItemScores: q.subItemScores, subItemPcts: q.subItemPcts, existingSubId: q.existingSubId
});

function scheduleBackoff() {
  state.attempts++;
  const base = Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (state.attempts - 1));
  state.nextRetryAt = Date.now() + base * (0.8 + Math.random() * 0.4);
}

let inflight = null;

// Envia os itens pendentes do fiscal logado, em ordem cronológica. Uma sincronização por vez.
export function syncFiscalNow({ manual = false } = {}) {
  if (inflight) return inflight;
  inflight = (async () => {
    state.syncing = true; state.lastAttemptAt = Date.now(); emit();
    const summary = { sent: 0, accepted: [], superseded: [], rejected: [], offline: false, authExpired: false, error: null };
    try {
      const user = getSession(), token = getToken();
      if (!user || !token) { state.authExpired = true; summary.authExpired = true; return summary; }
      const pending = (await listFiscalQueue(user.id)).filter(q => q.status === FQ_STATUS.PENDENTE).sort((a, b) => a.evaluatedAt - b.evaluatedAt);
      const srv = await resolveServer({ force: manual });
      if (srv.kind === 'none') { summary.offline = true; if (pending.length) scheduleBackoff(); return summary; }
      if (!pending.length) { state.authExpired = false; return summary; }

      for (const q of pending) {
        let data;
        try {
          data = await serverFetch('/submissions/fiscal-suggestion', { method: 'POST', token, body: toWire(q), timeout: TIMEOUTS.sync });
        } catch (e) {
          if (e instanceof HttpError && e.status === 401) { state.authExpired = true; summary.authExpired = true; break; } // fila intacta
          if (e instanceof NetError) { summary.offline = true; scheduleBackoff(); break; }
          if (e instanceof HttpError && e.status >= 400 && e.status < 500) { // o servidor entendeu e recusou: não adianta repetir
            Object.assign(q, { status: FQ_STATUS.REJEITADO, message: e.message, attempts: q.attempts + 1, syncedAt: Date.now() });
            await idb.put('kv', q); summary.rejected.push(q); summary.sent++; emit(); continue;
          }
          q.attempts++; q.message = e.message; await idb.put('kv', q);          // 5xx: tenta de novo mais tarde
          summary.error = e.message; state.lastError = e.message; scheduleBackoff(); break;
        }
        state.authExpired = false;
        const superseded = data?.result === 'superseded';
        Object.assign(q, {
          status: superseded ? FQ_STATUS.SUBSTITUIDO : FQ_STATUS.ENVIADO, attempts: q.attempts + 1, syncedAt: Date.now(),
          message: superseded ? 'Já existe uma avaliação mais recente para este item — esta foi ignorada.' : '', submissionId: data?.id || null
        });
        await idb.put('kv', q);
        (superseded ? summary.superseded : summary.accepted).push(q);
        summary.sent++; emit();
      }
      if (summary.sent > 0 || manual) { state.lastSyncAt = Date.now(); state.attempts = 0; state.nextRetryAt = 0; state.lastError = null; }
      return summary;
    } finally { state.syncing = false; emit(); }
  })().finally(() => { inflight = null; });
  return inflight;
}

// Grava na fila e tenta enviar já. Espera no máximo `waitMs` pela resposta; depois disso o item segue na fila
// (e o chamador mostra "guardado, enviando quando o servidor voltar"). Devolve o item com o status atualizado.
export async function saveFiscalEvaluation(params, { waitMs = 4000 } = {}) {
  const item = await enqueueFiscal(params);
  let timer;
  await Promise.race([syncFiscalNow().catch(() => {}), new Promise(r => { timer = setTimeout(r, waitMs); })]);
  clearTimeout(timer);
  return (await idb.get('kv', item.key)) || item;
}

// Gatilhos automáticos: ao abrir, ao voltar a rede/foco, e periodicamente (com backoff) enquanto houver pendência.
export function startFiscalAutoSync({ intervalMs = 8_000 } = {}) {
  let lastNotified = null;
  const attempt = async ({ ignoreBackoff = false } = {}) => {
    const user = getSession();
    const now = Date.now();
    if (!user || state.syncing || now - state.lastAttemptAt < MIN_GAP_MS) return;
    if (!ignoreBackoff && now < state.nextRetryAt) return;
    if (!(await listFiscalQueue(user.id)).some(q => q.status === FQ_STATUS.PENDENTE)) return;
    const run = syncFiscalNow();
    if (run === lastNotified) return;   // gatilhos simultâneos (online + foco) compartilham a mesma sincronização → avisa uma vez só
    lastNotified = run;
    run.then(sum => syncListeners.forEach(cb => { try { cb(sum); } catch (e) { console.warn(e); } })).catch(() => {});
  };
  const onBack = () => { if (typeof document === 'undefined' || document.visibilityState !== 'hidden') attempt({ ignoreBackoff: true }); };
  const onOnline = () => { state.nextRetryAt = 0; attempt({ ignoreBackoff: true }); emit(); };
  const onOffline = () => emit();
  globalThis.addEventListener?.('online', onOnline);
  globalThis.addEventListener?.('offline', onOffline);
  globalThis.addEventListener?.('focus', onBack);
  globalThis.document?.addEventListener?.('visibilitychange', onBack);
  const tick = setInterval(() => attempt(), intervalMs);
  attempt({ ignoreBackoff: true });
  return () => {
    clearInterval(tick);
    globalThis.removeEventListener?.('online', onOnline);
    globalThis.removeEventListener?.('offline', onOffline);
    globalThis.removeEventListener?.('focus', onBack);
    globalThis.document?.removeEventListener?.('visibilitychange', onBack);
  };
}
