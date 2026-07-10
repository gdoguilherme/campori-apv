import {
  db, collection, doc, addDoc, updateDoc, deleteDoc,
  query, where, orderBy, onSnapshot, serverTimestamp
} from './firebase.js';

// ── CONSTANTES ─────────────────────────────────────────────────

// Cache dinâmico — atualizado pelo subRegions; inicia vazio (sem hardcode)
let _regionCache = [];
export const setRegionCache = regions => { _regionCache = regions; };

export const CATEGORIES = ['ADM','Nas Casas','Nos Templos','Nas Ruas','Acampamento','Cozinha','Saúde','Eventos','Outros'];
export const PHASES = ['Pré-Requisito','No Campori'];
// 'judge' mantido no DB para retrocompatibilidade; exibido como 'Fiscal de Prova'
export const ROLES = { superadmin:'Super Admin', admin:'Administrador', approver:'Aprovador', judge:'Fiscal de Prova', region:'Região' };
export const COMP_CATS = ['Ambos','DBV','AVT'];
export const SCORE_PCTS = [0, 30, 50, 70, 100];
export const UPLOAD_SERVER = 'https://campori-apv-upload.fly.dev';
const SERVER_BASE = UPLOAD_SERVER; // mesmo servidor Express (Fly.io) hospeda upload + autenticação/usuários

// Chamada JSON autenticada (opcional) ao backend — usada por tudo que toca a coleção `users`,
// que não é mais lida/escrita direto do client (ver firestore.rules)
async function apiFetch(path, { method = 'GET', body, token } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(`${SERVER_BASE}${path}`, {
    method, headers, body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ── HELPERS ────────────────────────────────────────────────────

export const rname = id => _regionCache.find(r => r.id === id)?.name || id;

export function fmtDate(ts) {
  if (!ts) return '—';
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('pt-BR', { day:'2-digit', month:'2-digit', year:'2-digit', hour:'2-digit', minute:'2-digit' });
}

export function badge(status, source, fiscalSuggestion) {
  if (fiscalSuggestion) return '<span class="badge-fiscal">⚖️ Sugestão Fiscal</span>';
  if (source === 'judge') return '<span class="badge-fiscal">⚖️ Fiscal</span>';
  if (status === 'approved') return '<span class="badge-approved">✅ Aprovado</span>';
  if (status === 'rejected') return '<span class="badge-rejected">❌ Rejeitado</span>';
  return '<span class="badge-pending">⏳ Pendente</span>';
}

export function toast(msg, type = 'success') {
  const bg = type === 'success' ? '#16a34a' : type === 'error' ? '#dc2626' : '#1e3a8a';
  const t = document.createElement('div');
  t.style.cssText = `position:fixed;bottom:5rem;left:50%;transform:translateX(-50%);
    background:${bg};color:#fff;padding:.75rem 1.25rem;border-radius:1rem;
    font-size:.875rem;font-weight:600;z-index:999;white-space:nowrap;max-width:90vw;
    box-shadow:0 4px 20px rgba(0,0,0,.2);text-align:center;`;
  t.textContent = msg;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

export function showBanner(msg) {
  const b = document.createElement('div');
  b.style.cssText = `position:fixed;top:0;left:0;right:0;z-index:998;background:#15803d;color:#fff;
    text-align:center;padding:1.1rem 1rem;font-size:1rem;font-weight:800;
    box-shadow:0 4px 20px rgba(0,0,0,.2);animation:slideDown .3s ease;`;
  b.innerHTML = msg;
  document.body.appendChild(b);
  setTimeout(() => {
    b.style.transition = 'opacity .4s';
    b.style.opacity = '0';
    setTimeout(() => b.remove(), 400);
  }, 3500);
  if (!document.getElementById('banner-css')) {
    const s = document.createElement('style');
    s.id = 'banner-css';
    s.textContent = '@keyframes slideDown{from{transform:translateY(-100%)}to{transform:translateY(0)}}';
    document.head.appendChild(s);
  }
}

export function genPassword(len = 8) {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: len }, () => c[Math.floor(Math.random() * c.length)]).join('');
}

export function proofBlock(url, context = 'queue') {
  if (!url) return `<div style="height:52px;background:#f8fafc;display:flex;align-items:center;
    justify-content:center;color:#94a3b8;font-size:.82rem;">Sem arquivo anexado</div>`;
  const isPdf = url.toLowerCase().includes('.pdf') || url.includes('/file/d/');
  if (isPdf) {
    return `<div style="background:#f8fafc;">
      <button onclick="window.open('${url}','_blank')" style="display:flex;align-items:center;justify-content:center;gap:.5rem;width:100%;padding:.75rem;background:#1e3a8a;color:#fff;font-size:.85rem;font-weight:700;border:none;cursor:pointer;">📄 Abrir PDF</button>
    </div>`;
  }
  const maxH = context === 'queue' ? '220px' : '140px';
  return `<div style="cursor:pointer;position:relative;" onclick="W.openPhoto('${url}')">
    <img src="${url}" style="width:100%;max-height:${maxH};object-fit:cover;display:block;"
      onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
    <div style="display:none;padding:.875rem;background:#fff1f1;color:#dc2626;font-size:.82rem;text-align:center;flex-direction:column;gap:.375rem;">
      <span>⚠️ Imagem não carregou</span>
      <a href="${url}" target="_blank" style="color:#1d4ed8;text-decoration:underline;">Abrir arquivo</a>
    </div>
    <div style="background:rgba(30,58,138,.85);color:#fff;text-align:center;font-size:.72rem;padding:.3rem;">
      👆 Toque para ampliar · <a href="${url}" target="_blank" style="color:#93c5fd;text-decoration:none;">⬇ Baixar</a>
    </div>
  </div>`;
}

// ── SUBSCRIPTIONS ─────────────────────────────────────────────

export function subRegions(onUpdate) {
  const q = query(collection(db, 'regions'), orderBy('name', 'asc'));
  return onSnapshot(q,
    snap => onUpdate(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    err => toast('Erro ao carregar regiões: ' + err.message, 'error')
  );
}

export function subReqs(onUpdate) {
  const q = query(collection(db, 'requirements'), orderBy('order', 'asc'));
  return onSnapshot(q,
    snap => onUpdate(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    err => toast('Erro ao carregar requisitos: ' + err.message, 'error')
  );
}

export function subSubs(regionId, onUpdate) {
  const q = regionId
    ? query(collection(db, 'submissions'), where('regionId', '==', regionId))
    : query(collection(db, 'submissions'), orderBy('submittedAt', 'desc'));
  return onSnapshot(q, snap => {
    const docs = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    if (regionId) docs.sort((a, b) => (b.submittedAt?.seconds || 0) - (a.submittedAt?.seconds || 0));
    onUpdate(docs);
  }, err => toast('Erro ao carregar dados: ' + err.message, 'error'));
}

// A coleção `users` não é mais lida em tempo real pelo client (regra do Firestore
// nega leitura/escrita direta — ver firestore.rules). O painel admin busca a lista
// via este endpoint (backend, Firebase Admin SDK) e recarrega após cada mutação.
export async function fetchUsers(token) {
  return apiFetch('/users', { token });
}

// ── AUTH ──────────────────────────────────────────────────────

// Login e verificação de senha (bcrypt) acontecem no backend — retorna { user, token }
export async function loginUser(username, password) {
  return apiFetch('/users/login', { method: 'POST', body: { username, password } });
}

// Cria admin inicial se não houver nenhum usuário; retorna a senha gerada ou null
export async function ensureInitialAdmin() {
  const { created, password } = await apiFetch('/users/ensure-initial-admin', { method: 'POST' });
  return created ? password : null;
}

// ── SUBMISSIONS ───────────────────────────────────────────────

// Envio da região: cria submission pending com prova
export async function addSubmission(user, req, notes, proofUrl = null) {
  const rid = user.regionId;
  const ref = await addDoc(collection(db, 'submissions'), {
    regionId: rid, regionName: rname(rid),
    requirementId: req.id, requirementName: req.name,
    requirementPoints: req.points, requirementCategory: req.category,
    competitionCategory: req.competitionCategory || 'Ambos',
    notes, proofUrl, status: 'pending',
    source: 'region', fiscalSuggestion: false,
    submittedAt: serverTimestamp(),
    submittedBy: user.username, submittedByName: user.name,
    requirementDeadlineSnapshot: req.deadline || null
  });
  return ref.id;
}

export async function updateSubmissionProof(subId, url) {
  await updateDoc(doc(db, 'submissions', subId), { proofUrl: url });
}

// Aprovar / Rejeitar / Reabrir (admin)
export async function review(subId, status, reason, currentUser) {
  await updateDoc(doc(db, 'submissions', subId), {
    status,
    rejectionReason: reason || '',
    reviewedAt: serverTimestamp(),
    reviewedBy: currentUser?.username || 'admin',
    reviewedByName: currentUser?.name || 'Administrador'
  });
  try {
    await addDoc(collection(db, 'auditLog'), {
      action: status, submissionId: subId,
      by: currentUser?.username, byName: currentUser?.name, byRole: currentUser?.role,
      reason, at: serverTimestamp()
    });
  } catch (_) {}
}

// V3: fiscal cria/atualiza sugestão pending (admin aprova)
// existingSubId: id da submission existente do fiscal para esta região+req, ou null
export async function doFiscalSuggestion(req, regionId, totalPts, subItemScores, subItemPcts, currentUser, existingSubId) {
  const baseData = {
    requirementPoints: totalPts,
    subItemScores: subItemScores || null,
    subItemPcts: subItemPcts || null,
    status: 'pending',
    fiscalSuggestion: true,
    notes: `Avaliado por: ${currentUser.name}`,
    submittedAt: serverTimestamp(),
    submittedBy: currentUser.username,
    submittedByName: currentUser.name
  };
  if (existingSubId) {
    await updateDoc(doc(db, 'submissions', existingSubId), baseData);
  } else {
    await addDoc(collection(db, 'submissions'), {
      regionId, regionName: rname(regionId),
      requirementId: req.id, requirementName: req.name,
      requirementCategory: req.category,
      competitionCategory: req.competitionCategory || 'Ambos',
      proofUrl: null,
      source: 'judge',
      requirementDeadlineSnapshot: req.deadline || null,
      ...baseData
    });
  }
  toast(`✅ ${req.name} — ${totalPts} pts (aguardando aprovação)`);
}

// ── REQUIREMENTS ──────────────────────────────────────────────

export async function saveReq(data, currentReqsLength) {
  if (data.id) {
    const { id, ...rest } = data;
    await updateDoc(doc(db, 'requirements', id), rest);
  } else {
    await addDoc(collection(db, 'requirements'), { ...data, order: currentReqsLength, active: true });
  }
}

export async function delReq(id) {
  await deleteDoc(doc(db, 'requirements', id));
}

// ── USERS ─────────────────────────────────────────────────────

export async function createUser(data, token) {
  return apiFetch('/users', { method: 'POST', token, body: data }); // { id, username, password }
}

export async function updateUser(id, data, token) {
  return apiFetch(`/users/${id}`, { method: 'PATCH', token, body: data });
}

// currentPassword: exigido no autoatendimento (troca pelo próprio usuário); admin pode omitir
export async function updatePassword(userId, newPassword, token, currentPassword) {
  return apiFetch(`/users/${userId}/password`, {
    method: 'POST', token, body: { newPassword, ...(currentPassword ? { currentPassword } : {}) }
  });
}

export async function toggleUserActive(id, currentlyActive, token) {
  return apiFetch(`/users/${id}/active`, { method: 'PATCH', token, body: { active: !currentlyActive } });
}

export async function deleteUser(id, token) {
  return apiFetch(`/users/${id}`, { method: 'DELETE', token });
}

// ── REGIONS ───────────────────────────────────────────────────
// (username/slugify agora vivem no backend — ver server/routes/users.js)




// Cria a região e o usuário/login vinculado automaticamente (login a partir do nome do responsável)
export async function createRegion(data, token) {
  const regRef = await addDoc(collection(db, 'regions'), {
    name: data.name, responsible: data.responsible || '', responsiblePhone: data.responsiblePhone || '',
    competitionCategory: data.competitionCategory, active: true
  });
  const { username, password } = await apiFetch('/users', {
    method: 'POST', token,
    body: {
      name: data.name, phone: data.responsiblePhone || '', password: data.password,
      usernameSeed: data.responsible || data.name,
      role: 'region', regionId: regRef.id, competitionCategory: data.competitionCategory
    }
  });
  return { id: regRef.id, username, password };
}

// Atualiza a região e sincroniza nome/modalidade/status do usuário vinculado.
// password: só é enviada (e trocada) se o admin explicitamente preencheu o campo.
export async function updateRegion(id, data, linkedUserId, password, token) {
  await updateDoc(doc(db, 'regions', id), data);
  if (linkedUserId) {
    await apiFetch(`/users/${linkedUserId}`, {
      method: 'PATCH', token,
      body: { name: data.name, competitionCategory: data.competitionCategory, active: data.active }
    });
    if (password) {
      await apiFetch(`/users/${linkedUserId}/password`, { method: 'POST', token, body: { newPassword: password } });
    }
  }
}

// Exclui a região e o usuário vinculado
export async function delRegion(id, linkedUserId, token) {
  await deleteDoc(doc(db, 'regions', id));
  if (linkedUserId) await apiFetch(`/users/${linkedUserId}`, { method: 'DELETE', token });
}

// ── SUBMISSIONS ───────────────────────────────────────────────

export async function deleteSubmission(id) {
  await deleteDoc(doc(db, 'submissions', id));
}

// ── UPLOAD ────────────────────────────────────────────────────

export async function uploadFile(file, regionId, reqCode) {
  const fd = new FormData();
  fd.append('file', file);
  fd.append('reqCode', reqCode || 'geral');
  fd.append('regionId', regionId || 'geral');
  const res = await fetch(`${UPLOAD_SERVER}/upload`, { method: 'POST', body: fd });
  const data = await res.json();
  if (!res.ok || data.error) throw new Error(data.error || `HTTP ${res.status}`);
  return data.url;
}

// ── SCORING ───────────────────────────────────────────────────

export function computeScores(submissions, requirements, users, catFilter = 'Todos') {
  const scores = {};
  _regionCache.forEach(r => { scores[r.id] = { name: r.name, total: 0, count: 0, compCat: r.competitionCategory || null }; });
  users.forEach(u => {
    if (u.role === 'region' && u.regionId && u.competitionCategory && scores[u.regionId])
      scores[u.regionId].compCat = u.competitionCategory;
  });
  const counted = new Set();
  [...submissions]
    .filter(s => s.status === 'approved')
    .sort((a, b) => (b.submittedAt?.seconds || 0) - (a.submittedAt?.seconds || 0))
    .forEach(s => {
      if (!scores[s.regionId]) return;
      const key = `${s.regionId}:${s.requirementId}`;
      if (counted.has(key)) return;
      const req = requirements.find(r => r.id === s.requirementId);
      const reqCat = req?.competitionCategory || 'Ambos';
      if (catFilter === 'Todos' || reqCat === 'Ambos' || reqCat === catFilter) {
        counted.add(key);
        scores[s.regionId].total += s.requirementPoints || 0;
        scores[s.regionId].count++;
      }
    });
  let result = Object.entries(scores).map(([id, v]) => ({ id, ...v })).sort((a, b) => b.total - a.total);
  if (catFilter !== 'Todos') result = result.filter(r => !r.compCat || r.compCat === catFilter);
  return result;
}
