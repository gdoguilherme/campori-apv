// MODO LOCAL — substitui js/api.js quando a página foi aberta pelo servidor do evento
// (o servidor injeta um import map: /js/api.js → /js/api-local.js, /js/firebase.js → firebase-stub.js).
// Mesmas exportações e mesmos formatos de retorno do api.js, mas TUDO vai para o servidor local da
// própria origem (REST + Bearer): sem Firestore, sem nuvem, sem internet. Os listeners em tempo real
// viram polling leve (GET /health → `revision`; só rebaixa a coleção quando algo mudou).
// O app da nuvem (campori.gdtmidia.com.br) continua usando js/api.js, sem nenhuma mudança.
import { fetchJson, HttpError, NetError } from './net.js';
import { TIMEOUTS } from './config.js';
import { getToken } from './auth.js';
import * as orig from './api.js?orig';
import { DISCIPLINE_POINTS } from '../shared/scoring.js';

// Funções puras/constantes: reaproveitadas do api.js original (mesma implementação, mesmos textos)
export const {
  CATEGORIES, PHASES, ROLES, COMP_CATS, AREAS_ATUACAO, FILLED_BY, SCORE_PCTS, UPLOAD_SERVER,
  setRegionCache, rname, fmtDate, badge, toast, showBanner, genPassword, proofBlock, renderAnonRanking,
  reqFilledBy, computeUnitScores, computeStars, findQrDuplicate
} = orig;
export { DISCIPLINE_POINTS };

const POLL_MS = Number(globalThis.__CAMPORI_POLL_MS) || 3000;
const baseUrl = () => location.origin;

// ── Timestamp compatível (o servidor local devolve {seconds, nanoseconds}) ──────────────────
class LocalTimestamp {
  constructor(seconds, nanoseconds) { this.seconds = seconds; this.nanoseconds = nanoseconds; }
  toMillis() { return this.seconds * 1000 + Math.floor(this.nanoseconds / 1e6); }
  toDate() { return new Date(this.toMillis()); }
  toJSON() { return { seconds: this.seconds, nanoseconds: this.nanoseconds }; }
}
export function revive(v) {
  if (Array.isArray(v)) return v.map(revive);
  if (v && typeof v === 'object') {
    const keys = Object.keys(v);
    if (keys.length === 2 && typeof v.seconds === 'number' && typeof v.nanoseconds === 'number') return new LocalTimestamp(v.seconds, v.nanoseconds);
    const out = {};
    for (const k of keys) out[k] = revive(v[k]);
    return out;
  }
  return v;
}

// ── HTTP ─────────────────────────────────────────────────────────────────────────────────────
async function apiFetch(path, { method = 'GET', body, token, timeout = TIMEOUTS.api } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  const tk = token || getToken();
  if (tk) headers.Authorization = `Bearer ${tk}`;
  const { ok, status, data } = await fetchJson(`${baseUrl()}${path}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined
  }, timeout);
  if (!ok) throw new HttpError(status, data);
  return data;
}
const dataPath = (col, filters) => {
  const q = filters ? '?' + Object.entries(filters).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v === null ? 'null' : v)}`).join('&') : '';
  return `/data/${col}${q}`;
};

// ── Polling (substitui onSnapshot) ──────────────────────────────────────────────────────────
const subs = new Set();
let timer = null;
let lastRev = null;

async function pollTick() {
  if (typeof document !== 'undefined' && document.hidden) return;
  let rev;
  try {
    const { ok, data } = await fetchJson(`${baseUrl()}/health`, { cache: 'no-store' }, 2500);
    if (!ok) return;
    rev = data?.revision;
  } catch { return; } // servidor local fora do ar por instantes: mantém o que já está na tela
  lastRev = rev;
  for (const s of [...subs]) if (s.rev !== rev) s.refresh(rev);
}
function ensureTimer() {
  if (timer || !subs.size) return;
  timer = setInterval(pollTick, POLL_MS);
  if (timer.unref) timer.unref();
  if (typeof document !== 'undefined') document.addEventListener?.('visibilitychange', pollTick);
  if (typeof window !== 'undefined') window.addEventListener?.('online', pollTick);
}
function stopTimerIfIdle() {
  if (subs.size || !timer) return;
  clearInterval(timer); timer = null;
  if (typeof document !== 'undefined') document.removeEventListener?.('visibilitychange', pollTick);
  if (typeof window !== 'undefined') window.removeEventListener?.('online', pollTick);
}

// fetchDocs(): Promise<array|null>  (devolve docs brutos); onUpdate recebe o resultado já tratado
function listen(fetchDocs, project, onUpdate, label) {
  let stopped = false, last, warned = false;
  const sub = {
    rev: undefined,
    async refresh(rev) {
      if (stopped) return;
      try {
        const raw = await fetchDocs();
        if (stopped) return;
        sub.rev = rev ?? lastRev;
        const sig = JSON.stringify(raw);
        if (sig === last) return;      // nada mudou de fato → não re-renderiza a tela
        last = sig;
        warned = false;
        onUpdate(project(revive(raw)));
      } catch (e) {
        if (stopped || e instanceof NetError || warned) return;
        warned = true;
        toast(`Erro ao carregar ${label}: ${e.message}`, 'error');
      }
    }
  };
  subs.add(sub);
  ensureTimer();
  sub.refresh();
  return () => { stopped = true; subs.delete(sub); stopTimerIfIdle(); };
}

const listDocs = (col, filters) => async () => (await apiFetch(dataPath(col, filters))).docs;
const byName = (a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
const byOrder = (a, b) => (a.order ?? 1e9) - (b.order ?? 1e9);
const bySubmittedDesc = (a, b) => (b.submittedAt?.seconds || 0) - (a.submittedAt?.seconds || 0);
const ident = d => d;

// ── SUBSCRIPTIONS ─────────────────────────────────────────────────────────────────────────
export const subRegions = onUpdate => listen(listDocs('regions'), d => d.sort(byName), onUpdate, 'regiões');
export const subParticipants = onUpdate => listen(listDocs('participants'), ident, onUpdate, 'participantes');
export const subUnits = onUpdate => listen(listDocs('units'), ident, onUpdate, 'unidades');
export const subParticipantsByUnit = (unitId, onUpdate) => listen(listDocs('participants', { unitId }), ident, onUpdate, 'participantes');
export const subReqs = onUpdate => listen(listDocs('requirements'), d => d.sort(byOrder), onUpdate, 'requisitos');
export const subSubs = (regionId, onUpdate) =>
  listen(listDocs('submissions', regionId ? { regionId } : undefined), d => d.sort(bySubmittedDesc), onUpdate, 'dados');
export const subSubsByUnit = (unitId, onUpdate) => listen(listDocs('submissions', { unitId }), d => d.sort(bySubmittedDesc), onUpdate, 'dados');
export const subDisciplinaryActions = onUpdate => listen(listDocs('disciplinaryActions'), ident, onUpdate, 'disciplina');

export function subUnitById(unitId, onUpdate) {
  const fetchOne = async () => {
    try { return await apiFetch(`/data/units/${encodeURIComponent(unitId)}`); }
    catch (e) { if (e instanceof HttpError && e.status === 404) return null; throw e; }
  };
  return listen(fetchOne, d => d, onUpdate, 'unidade');
}

export const fetchUsers = token => apiFetch('/users', { token });

// ── AUTH ──────────────────────────────────────────────────────────────────────────────────
export const loginUser = (username, password) => apiFetch('/users/login', { method: 'POST', body: { username, password } });

export async function ensureInitialAdmin() {
  const { created, password } = await apiFetch('/users/ensure-initial-admin', { method: 'POST' });
  return created ? password : null;
}

// ── SUBMISSIONS ───────────────────────────────────────────────────────────────────────────
export async function addSubmission(user, req, notes, proofUrl = null) {
  const sub = await apiFetch('/submissions', { method: 'POST', body: { requirementId: req.id, notes, proofUrl } });
  return sub.id;
}

export async function updateSubmissionProof(subId, url) {
  await apiFetch(`/data/submissions/${encodeURIComponent(subId)}`, { method: 'PATCH', body: { proofUrl: url } });
}

export async function review(subId, status, reason, currentUser) {
  await apiFetch(`/submissions/${encodeURIComponent(subId)}/review`, { method: 'POST', body: { status, reason: reason || '' } });
}

export async function doFiscalSuggestion(req, regionId, totalPts, subItemScores, subItemPcts, currentUser, existingSubId, unitId = null) {
  await apiFetch('/submissions/fiscal-suggestion', {
    method: 'POST',
    body: {
      requirementId: req.id, regionId, unitId: unitId || null, points: totalPts,
      subItemScores: subItemScores || null, subItemPcts: subItemPcts || null, existingSubId: existingSubId || null
    }
  });
  toast(`✅ ${req.name} — ${totalPts} pts (aguardando aprovação)`);
}

export async function doUniformInspection(req, unit, inspection, currentUser, existingSubId = null) {
  const sub = await apiFetch('/submissions/fiscal-suggestion', {
    method: 'POST',
    body: { requirementId: req.id, unitId: unit.id, regionId: unit.regionId, uniformInspection: inspection, existingSubId: existingSubId || null }
  });
  toast(`✅ ${req.name} — ${sub.requirementPoints} pts (aguardando aprovação)`);
  return { points: sub.requirementPoints };
}

export async function deleteSubmission(id) {
  await apiFetch(`/data/submissions/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ── REQUIREMENTS ──────────────────────────────────────────────────────────────────────────
export async function saveReq(data, currentReqsLength) {
  if (data.id) {
    const { id, ...rest } = data;
    await apiFetch(`/data/requirements/${encodeURIComponent(id)}`, { method: 'PATCH', body: rest });
  } else {
    await apiFetch('/data/requirements', { method: 'POST', body: { ...data, order: currentReqsLength, active: true } });
  }
}

export async function delReq(id) {
  await apiFetch(`/data/requirements/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ── USERS ─────────────────────────────────────────────────────────────────────────────────
export const createUser = (data, token) => apiFetch('/users', { method: 'POST', token, body: data });
export const updateUser = (id, data, token) => apiFetch(`/users/${id}`, { method: 'PATCH', token, body: data });
export const updatePassword = (userId, newPassword, token, currentPassword) =>
  apiFetch(`/users/${userId}/password`, { method: 'POST', token, body: { newPassword, ...(currentPassword ? { currentPassword } : {}) } });
export const toggleUserActive = (id, currentlyActive, token) => apiFetch(`/users/${id}/active`, { method: 'PATCH', token, body: { active: !currentlyActive } });
export const deleteUser = (id, token) => apiFetch(`/users/${id}`, { method: 'DELETE', token });

// ── REGIONS ───────────────────────────────────────────────────────────────────────────────
export async function createRegion(data, token) {
  const reg = await apiFetch('/data/regions', {
    method: 'POST', token,
    body: {
      name: data.name, responsible: data.responsible || '', responsiblePhone: data.responsiblePhone || '',
      competitionCategory: data.competitionCategory, active: true
    }
  });
  const { username, password } = await apiFetch('/users', {
    method: 'POST', token,
    body: {
      name: data.name, phone: data.responsiblePhone || '', password: data.password,
      usernameSeed: data.responsible || data.name,
      role: 'region', regionId: reg.id, competitionCategory: data.competitionCategory
    }
  });
  return { id: reg.id, username, password };
}

export async function updateRegion(id, data, linkedUserId, password, token) {
  await apiFetch(`/data/regions/${encodeURIComponent(id)}`, { method: 'PATCH', token, body: data });
  if (linkedUserId) {
    await apiFetch(`/users/${linkedUserId}`, {
      method: 'PATCH', token,
      body: { name: data.name, competitionCategory: data.competitionCategory, active: data.active }
    });
    if (password) await apiFetch(`/users/${linkedUserId}/password`, { method: 'POST', token, body: { newPassword: password } });
  }
}

export async function delRegion(id, linkedUserId, token) {
  await apiFetch(`/data/regions/${encodeURIComponent(id)}`, { method: 'DELETE', token });
  if (linkedUserId) await apiFetch(`/users/${linkedUserId}`, { method: 'DELETE', token });
}

export async function updateRegionProfile(regionId, data) {
  await apiFetch(`/data/regions/${encodeURIComponent(regionId)}`, { method: 'PATCH', body: data });
}

// ── QR ────────────────────────────────────────────────────────────────────────────────────
export const generateQrPayload = (requirementId, variantId, points, token) =>
  apiFetch('/qr/generate', { method: 'POST', token, body: { requirementId, variantId, points } });

// ── PARTICIPANTS ──────────────────────────────────────────────────────────────────────────
export async function createParticipant(data) {
  await apiFetch('/data/participants', {
    method: 'POST',
    body: {
      name: data.name, club: data.club || '', regionId: data.regionId,
      competitionCategory: data.competitionCategory, unitId: data.unitId || null
    }
  });
}
export const updateParticipant = (id, data) => apiFetch(`/data/participants/${encodeURIComponent(id)}`, { method: 'PATCH', body: data });
export const deleteParticipant = id => apiFetch(`/data/participants/${encodeURIComponent(id)}`, { method: 'DELETE' });

export async function createParticipantsBulk(list) {
  let count = 0;
  for (const p of list) { await createParticipant(p); count++; }
  return count;
}

// ── UNITS ─────────────────────────────────────────────────────────────────────────────────
export async function createUnit(data) {
  const u = await apiFetch('/data/units', {
    method: 'POST', body: { name: data.name, warCry: data.warCry || '', regionId: data.regionId, counselorId: null }
  });
  return u.id;
}
export const updateUnit = (id, data) => apiFetch(`/data/units/${encodeURIComponent(id)}`, { method: 'PATCH', body: data });

export async function deleteUnit(id, participantIds) {
  await apiFetch(`/data/units/${encodeURIComponent(id)}`, { method: 'DELETE' });
  for (const pid of participantIds) await apiFetch(`/data/participants/${encodeURIComponent(pid)}`, { method: 'PATCH', body: { unitId: null } });
}

export const allocateParticipant = (participantId, unitId) =>
  apiFetch(`/data/participants/${encodeURIComponent(participantId)}`, { method: 'PATCH', body: { unitId } });

// ── UPLOAD ────────────────────────────────────────────────────────────────────────────────
export async function uploadFile(file, regionId, reqCode) {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('reqCode', reqCode || 'geral');
  fd.append('regionId', regionId || 'geral');
  const { ok, status, data } = await fetchJson(`${baseUrl()}/upload`, { method: 'POST', body: fd }, TIMEOUTS.upload);
  if (!ok || data.error) throw new Error(data.error || `HTTP ${status}`);
  return data.url;
}

// ── RANKING / DISCIPLINA ──────────────────────────────────────────────────────────────────
// Ranking público (login): o servidor calcula; o client só precisa de `total` para desenhar
export async function fetchPublicRanking() {
  const rows = await apiFetch('/ranking');
  return rows.map(r => ({ total: r.total, position: r.position, stars: r.stars }));
}

export async function createDisciplinaryAction(data, currentUser) {
  await apiFetch('/discipline', { method: 'POST', body: { targetType: data.targetType, targetId: data.targetId, reason: data.reason } });
}
export const deleteDisciplinaryAction = id => apiFetch(`/discipline/${encodeURIComponent(id)}`, { method: 'DELETE' });
