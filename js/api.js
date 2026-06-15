import {
  db, collection, doc, getDocs, addDoc, updateDoc, deleteDoc, setDoc,
  query, where, orderBy, onSnapshot, serverTimestamp
} from './firebase.js';

// ── CONSTANTES ─────────────────────────────────────────────────

// Usado como seed inicial; depois substituído pelo Firestore
export const REGIONS_SEED = [
  { id: '001R1',  name: '1ª Região',  responsible: '', responsiblePhone: '', competitionCategory: 'DBV', active: true },
  { id: '002R2',  name: '2ª Região',  responsible: '', responsiblePhone: '', competitionCategory: 'DBV', active: true },
  { id: '003R3',  name: '3ª Região',  responsible: '', responsiblePhone: '', competitionCategory: 'DBV', active: true },
  { id: '004R4',  name: '4ª Região',  responsible: '', responsiblePhone: '', competitionCategory: 'DBV', active: true },
  { id: '005R5',  name: '5ª Região',  responsible: '', responsiblePhone: '', competitionCategory: 'DBV', active: true },
  { id: '006R6',  name: '6ª Região',  responsible: '', responsiblePhone: '', competitionCategory: 'DBV', active: true },
  { id: '007R7',  name: '7ª Região',  responsible: '', responsiblePhone: '', competitionCategory: 'DBV', active: true },
  { id: '008R8',  name: '8ª Região',  responsible: '', responsiblePhone: '', competitionCategory: 'DBV', active: true },
  { id: '009R9',  name: '9ª Região',  responsible: '', responsiblePhone: '', competitionCategory: 'DBV', active: true },
  { id: '010R10', name: '10ª Região', responsible: '', responsiblePhone: '', competitionCategory: 'DBV', active: true },
  { id: '011R11', name: '11ª Região', responsible: '', responsiblePhone: '', competitionCategory: 'DBV', active: true },
  { id: '012R12', name: '12ª Região', responsible: '', responsiblePhone: '', competitionCategory: 'DBV', active: true },
  { id: '013R13', name: '13ª Região', responsible: '', responsiblePhone: '', competitionCategory: 'DBV', active: true },
  { id: '014R14', name: '14ª Região', responsible: '', responsiblePhone: '', competitionCategory: 'DBV', active: true },
  { id: '015R15', name: '15ª Região', responsible: '', responsiblePhone: '', competitionCategory: 'DBV', active: true },
  { id: '016R16', name: '16ª Região', responsible: '', responsiblePhone: '', competitionCategory: 'DBV', active: true },
];

// Cache dinâmico — atualizado pelo subRegions; inicia com o seed
let _regionCache = REGIONS_SEED.map(r => ({ ...r }));
export const setRegionCache = regions => { _regionCache = regions; };

export const CATEGORIES = ['ADM','Nas Casas','Nos Templos','Nas Ruas','Acampamento','Cozinha','Saúde','Eventos','Outros'];
export const PHASES = ['Pré-Requisito','No Campori'];
// 'judge' mantido no DB para retrocompatibilidade; exibido como 'Fiscal de Prova'
export const ROLES = { superadmin:'Super Admin', admin:'Administrador', approver:'Aprovador', judge:'Fiscal de Prova', region:'Região' };
export const COMP_CATS = ['Ambos','DBV','AVT'];
export const SCORE_PCTS = [0, 30, 50, 70, 100];
export const UPLOAD_SERVER = 'https://campori-apv-upload.fly.dev';

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

export function subUsers(onUpdate) {
  return onSnapshot(collection(db, 'users'),
    snap => onUpdate(snap.docs.map(d => ({ id: d.id, ...d.data() }))),
    err => toast('Erro ao carregar usuários: ' + err.message, 'error')
  );
}

// ── AUTH ──────────────────────────────────────────────────────

export async function loginUser(username, password) {
  const snap = await getDocs(query(collection(db, 'users'), where('username', '==', username.toLowerCase().trim())));
  if (snap.empty) throw new Error('Usuário não encontrado');
  const user = { id: snap.docs[0].id, ...snap.docs[0].data() };
  if (user.password !== password) throw new Error('Senha incorreta');
  if (user.active === false) throw new Error('Usuário inativo');
  return user;
}

// Cria admin inicial se não houver nenhum usuário; retorna a senha gerada ou null
export async function ensureInitialAdmin() {
  const snap = await getDocs(collection(db, 'users'));
  if (snap.empty) {
    const pwd = genPassword();
    await setDoc(doc(db, 'users', 'initial-admin'), {
      name: 'Super Admin', phone: '', username: 'admin', password: pwd,
      role: 'superadmin', active: true, createdAt: serverTimestamp()
    });
    return pwd;
  }
  return null;
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

export async function createUser(data, currentUser) {
  const snap = await getDocs(query(collection(db, 'users'), where('username', '==', data.username)));
  if (!snap.empty) throw new Error('Este usuário já existe');
  await addDoc(collection(db, 'users'), {
    ...data,
    active: true,
    createdAt: serverTimestamp(),
    createdBy: currentUser?.username || 'system'
  });
}

export async function updateUser(id, data) {
  await updateDoc(doc(db, 'users', id), data);
}

export async function updatePassword(userId, newPassword) {
  await updateDoc(doc(db, 'users', userId), { password: newPassword });
}

export async function toggleUserActive(id, currentlyActive) {
  await updateDoc(doc(db, 'users', id), { active: !currentlyActive });
}

export async function deleteUser(id) {
  await deleteDoc(doc(db, 'users', id));
}

// ── REGIONS ───────────────────────────────────────────────────

export async function saveRegion(data) {
  if (data.id) {
    const { id, ...rest } = data;
    await updateDoc(doc(db, 'regions', id), rest);
  } else {
    await addDoc(collection(db, 'regions'), { ...data, active: true });
  }
}

export async function delRegion(id) {
  await deleteDoc(doc(db, 'regions', id));
}

export async function seedRegions() {
  const snap = await getDocs(collection(db, 'regions'));
  if (!snap.empty) return 0;
  for (const r of REGIONS_SEED) {
    await addDoc(collection(db, 'regions'), {
      name: r.name, responsible: '', responsiblePhone: '',
      competitionCategory: r.competitionCategory, active: true
    });
  }
  return REGIONS_SEED.length;
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
