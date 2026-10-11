// Fila offline da Pesquisa de Satisfação (IndexedDB, store `kv`, chaves `surveyq:<userId>:<clientId>`) + marcador "já respondeu".
// ANONIMATO: o userId existe SÓ aqui, no aparelho, para separar filas de logins diferentes — nunca vai para o servidor.
// O item enviado leva { surveyId, clientId, answers, perfil, regionId }. "Já respondeu" também é local (localStorage).
import * as idb from './offlineDb.js';
import { submitSurveyResponse } from './api.js';
import { getSession } from './auth.js';
import { HttpError, NetError } from './net.js';
import { profileOfRole } from '../shared/survey.js';

export const SQ_STATUS = { PENDENTE: 'pendente', ENVIADO: 'enviado', ENCERRADA: 'encerrada', RECUSADA: 'recusada' };
const PREFIX = 'surveyq:';
const state = { syncing: false, lastError: null, nextRetryAt: 0, attempts: 0 };
const listeners = new Set();
export const onSurveyQueueChange = cb => { listeners.add(cb); return () => listeners.delete(cb); };
const emit = () => listeners.forEach(cb => { try { cb(); } catch (e) { console.warn(e); } });
export const getSurveySyncState = () => ({ ...state });

export const newClientId = () => (globalThis.crypto?.randomUUID ? crypto.randomUUID() : `c${Date.now().toString(36)}${Math.random().toString(36).slice(2, 12)}`);

// ── marcador "já respondeu" (local; guarda o clientId para editar substituindo, e as respostas para pré-preencher) ──
const markerKey = (userId, surveyId) => `campori_survey_done:${userId}:${surveyId}`;
export function getAnsweredMarker(userId, surveyId) {
  try { return JSON.parse(localStorage.getItem(markerKey(userId, surveyId)) || 'null'); } catch { return null; }
}
export function setAnsweredMarker(userId, surveyId, marker) {
  try { localStorage.setItem(markerKey(userId, surveyId), JSON.stringify(marker)); } catch { /* armazenamento indisponível: segue sem marcador */ }
}

// ── cache da pesquisa aberta (o botão e o formulário funcionam sem rede) ──
export async function cacheOpenSurveys(list) { try { await idb.put('kv', { key: 'survey-open', list, at: Date.now() }); } catch { /* sem cache */ } }
export async function getCachedOpenSurveys() { try { return (await idb.get('kv', 'survey-open'))?.list || []; } catch { return []; } }

// ── fila ──
export async function listSurveyQueue(userId) {
  return (await idb.getAll('kv')).filter(k => typeof k.key === 'string' && k.key.startsWith(PREFIX) && k.userId === userId).sort((a, b) => b.createdAt - a.createdAt);
}
export async function pendingSurveyCount(userId = getSession()?.id) {
  if (!userId) return 0;
  return (await listSurveyQueue(userId)).filter(q => q.status === SQ_STATUS.PENDENTE).length;
}

// Guarda (substituindo uma resposta pendente do mesmo clientId) e marca "já respondeu" neste aparelho.
export async function enqueueSurveyResponse({ user, surveyId, answers, clientId, isEdit = false }) {
  const prev = await idb.get('kv', `${PREFIX}${user.id}:${clientId}`);
  if (prev && prev.status === SQ_STATUS.PENDENTE) isEdit = prev.isEdit;   // a primeira ainda nem chegou: continua sendo "criação"
  const item = {
    key: `${PREFIX}${user.id}:${clientId}`, userId: user.id,
    surveyId, clientId, answers, isEdit,
    perfil: profileOfRole(user.role), regionId: user.role === 'judge' ? null : (user.regionId || null),
    status: SQ_STATUS.PENDENTE, message: '', attempts: 0, createdAt: Date.now(),
  };
  await idb.put('kv', item);
  setAnsweredMarker(user.id, surveyId, { clientId, answers, at: Date.now() });
  emit();
  return item;
}

function backoff() { state.attempts++; state.nextRetryAt = Date.now() + Math.min(120_000, 8_000 * 2 ** (state.attempts - 1)); }

let inflight = null;
export function syncSurveyQueue({ manual = false } = {}) {
  if (inflight) return inflight;
  inflight = (async () => {
    state.syncing = true; emit();
    const sum = { sent: 0, accepted: [], closed: [], rejected: [], offline: false };
    try {
      const user = getSession();
      if (!user) return sum;
      if (!manual && Date.now() < state.nextRetryAt) return sum;
      const pending = (await listSurveyQueue(user.id)).filter(q => q.status === SQ_STATUS.PENDENTE).sort((a, b) => a.createdAt - b.createdAt);
      for (const q of pending) {
        try {
          await submitSurveyResponse({ surveyId: q.surveyId, clientId: q.clientId, answers: q.answers, perfil: q.perfil, regionId: q.regionId, isEdit: q.isEdit });
          Object.assign(q, { status: SQ_STATUS.ENVIADO, attempts: q.attempts + 1, sentAt: Date.now() });
          sum.accepted.push(q); sum.sent++;
        } catch (e) {
          if (e instanceof NetError) { sum.offline = true; backoff(); break; }
          if (e instanceof HttpError && e.status === 401) { state.lastError = 'Sessão expirada'; break; }   // fila intacta
          if (e instanceof HttpError && (e.status === 409 || e.code === 'SURVEY_CLOSED')) { Object.assign(q, { status: SQ_STATUS.ENCERRADA, message: e.message }); sum.closed.push(q); }
          else if (e instanceof HttpError && e.status >= 400 && e.status < 500) { Object.assign(q, { status: SQ_STATUS.RECUSADA, message: e.message }); sum.rejected.push(q); }
          else { q.attempts++; q.message = e.message; state.lastError = e.message; await idb.put('kv', q); backoff(); break; }   // 5xx/erro de rede genérico: tenta depois
        }
        await idb.put('kv', q);
      }
      if (!sum.offline && (sum.sent || manual)) { state.attempts = 0; state.nextRetryAt = 0; state.lastError = null; }
      return sum;
    } finally { state.syncing = false; emit(); }
  })().finally(() => { inflight = null; });
  return inflight;
}

// Envio automático: ao abrir, ao voltar rede/foco e a cada 10 s enquanto houver pendência.
export function startSurveyAutoSync({ intervalMs = 10_000 } = {}) {
  const attempt = async () => {
    const user = getSession();
    if (!user || state.syncing) return;
    if (!(await pendingSurveyCount(user.id))) return;
    syncSurveyQueue().catch(() => {});
  };
  const onNet = () => { state.nextRetryAt = 0; attempt(); };
  globalThis.addEventListener?.('online', onNet);
  globalThis.document?.addEventListener?.('visibilitychange', () => { if (document.visibilityState !== 'hidden') onNet(); });
  const tick = setInterval(attempt, intervalMs);
  attempt();
  return () => { clearInterval(tick); globalThis.removeEventListener?.('online', onNet); };
}
