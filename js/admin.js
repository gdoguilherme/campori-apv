import { guardPage, logout as authLogout, saveSession, getToken, startExpiryWatcher } from './auth.js';
import {
  subReqs, subSubs, subRegions, setRegionCache, fetchUsers, subParticipants, subUnits,
  rname, fmtDate, badge, toast, genPassword, proofBlock, reqFilledBy,
  review as apiReview, saveReq as apiSaveReq, delReq as apiDelReq,
  createUser, updateUser, updatePassword, toggleUserActive as apiToggleUser,
  deleteUser as apiDeleteUser, deleteSubmission as apiDeleteSubmission,
  createRegion as apiCreateRegion, updateRegion as apiUpdateRegion, delRegion as apiDelRegion,
  createParticipant, updateParticipant, deleteParticipant as apiDeleteParticipant, createParticipantsBulk,
  createUnit, updateUnit, deleteUnit as apiDeleteUnit, allocateParticipant,
  computeUnitScores, computeStars,
  CATEGORIES, PHASES, ROLES, COMP_CATS, SCORE_PCTS, AREAS_ATUACAO, FILLED_BY
} from './api.js';

// ── ESTADO ────────────────────────────────────────────────────
const S = {
  user: null,
  adminTab: 'queue',
  sidebarOpen: false,
  requirements: [], submissions: [], users: [], regions: [], participants: [], units: [],
  filterStatus: 'Todos',
  participantFilterRegion: 'Todas', participantFilterCat: 'Todos',
  unitFilterRegion: 'Todas', unitParticipantSearch: '', counselorUnitId: null,
  editingReq: null, editingUser: null, editingRegion: null, editingParticipant: null, editingUnit: null,
  formRole: null, generatedPwd: '', createdCreds: null,
  importRows: [], importErrors: [],
  photoUrl: null, modal: null,
  loading: false,
};

let _unsubReqs = null, _unsubSubs = null, _unsubRegions = null, _unsubParticipants = null, _unsubUnits = null;

// ── INIT ──────────────────────────────────────────────────────
export function init() {
  const user = guardPage(['superadmin', 'admin', 'approver']);
  if (!user) return;
  S.user = user;
  startExpiryWatcher();

  _unsubReqs    = subReqs(reqs     => { S.requirements = reqs;   render(); });
  _unsubSubs    = subSubs(null, subs => { S.submissions = subs;  render(); });
  _unsubRegions = subRegions(regs  => {
    S.regions = regs;
    setRegionCache(regs);
    render();
  });
  _unsubParticipants = subParticipants(ps => { S.participants = ps; render(); });
  _unsubUnits        = subUnits(units => { S.units = units; render(); });

  refreshUsers();
  render();
}

// A coleção `users` não é mais lida em tempo real (ver firestore.rules) — o painel
// busca a lista sob demanda e recarrega após qualquer mutação de usuário/região.
async function refreshUsers() {
  if (!['superadmin', 'admin'].includes(S.user?.role)) return; // approver não gerencia usuários/regiões
  try {
    S.users = await fetchUsers(getToken());
    render();
  } catch (e) {
    toast('Erro ao carregar usuários: ' + e.message, 'error');
  }
}

// ── HELPERS ───────────────────────────────────────────────────
const isSuperAdmin = () => S.user?.role === 'superadmin';
const isAdmin      = () => ['superadmin', 'admin'].includes(S.user?.role);

function exportExcel() {
  if (typeof window.XLSX === 'undefined') { toast('Biblioteca XLSX não carregada', 'error'); return; }
  const wb = window.XLSX.utils.book_new();
  const rows = S.submissions.map(s => ({
    'Região': s.regionName || rname(s.regionId),
    'Requisito': s.requirementName,
    'Categoria': s.requirementCategory,
    'Pontos': s.requirementPoints || 0,
    'Status': s.status === 'approved' ? 'Aprovado' : s.status === 'rejected' ? 'Rejeitado' : 'Pendente',
    'Fonte': s.source === 'judge' ? 'Fiscal de Prova' : 'Região',
    'Sugestão Fiscal': s.fiscalSuggestion ? 'Sim' : 'Não',
    'Enviado por': s.submittedByName || s.regionName || '—',
    'Enviado em': fmtDate(s.submittedAt),
    'Avaliado por': s.reviewedByName || '—',
    'Avaliado em': fmtDate(s.reviewedAt),
    'Observações': s.notes || ''
  }));
  window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.json_to_sheet(rows), 'Comprovações');
  const sc = computeUnitScores(S.submissions, S.units);
  window.XLSX.utils.book_append_sheet(wb, window.XLSX.utils.json_to_sheet(
    sc.map((s, i) => ({ 'Posição': i + 1, 'Unidade': s.name, 'Região': rname(s.regionId), 'Pontos Totais': s.total, 'Aprovações': s.count }))
  ), 'Ranking');
  window.XLSX.writeFile(wb, `campori-${new Date().toISOString().slice(0, 10)}.xlsx`);
}

function subItemDetails(sub) {
  const req = S.requirements.find(r => r.id === sub.requirementId);
  if (!req?.subItems?.length || !sub.subItemPcts) return '';
  const rows = req.subItems.map(si => {
    const pct = sub.subItemPcts[si.id];
    const pts = sub.subItemScores?.[si.id] ?? 0;
    return pct !== undefined
      ? `<div style="font-size:.78rem;color:#475569;">• ${si.name}: ${pct}% → <strong>${pts} pts</strong></div>`
      : '';
  }).filter(Boolean);
  if (!rows.length) return '';
  return `<div style="background:#f5f3ff;border-radius:.625rem;padding:.625rem .75rem;margin-top:.5rem;">
    <div style="font-size:.75rem;font-weight:700;color:#5b21b6;margin-bottom:.25rem;">📊 Avaliação por sub-itens</div>
    ${rows.join('')}
  </div>`;
}

// ── RENDER ────────────────────────────────────────────────────
function render() {
  const el = document.getElementById('app');
  if (!el) return;
  let html = vAdmin();
  if (S.modal === 'req-form')            html += mReqForm();
  else if (S.modal === 'user-form')      html += mUserForm();
  else if (S.modal === 'region-form')    html += mRegionForm();
  else if (S.modal === 'participant-form')   html += mParticipantForm();
  else if (S.modal === 'participant-import') html += mParticipantImport();
  else if (S.modal === 'unit-form')          html += mUnitForm();
  else if (S.modal === 'unit-participants')  html += mUnitParticipants();
  else if (S.modal === 'counselor-form')     html += mCounselorForm();
  else if (S.modal === 'credentials')    html += mCredentialsModal();
  else if (S.modal === 'photo')          html += mPhoto();
  else if (S.modal === 'change-password') html += mChangePassword();
  el.innerHTML = html;
}

// ── VIEW: PAINEL ADMIN ────────────────────────────────────────
function vAdmin() {
  const pendingCount = S.submissions.filter(s => s.status === 'pending').length;
  const tabs = [
    { id: 'queue',        label: '📋 Fila',       count: pendingCount },
    ...(isAdmin() ? [{ id: 'requirements', label: '⚙️ Requisitos' }] : []),
    { id: 'history',      label: '📂 Histórico' },
    ...(isAdmin() ? [
      { id: 'dashboard',    label: '📊 Dashboard' },
      { id: 'ranking',      label: '🏆 Ranking'   },
      { id: 'participants', label: '👥 Participantes' },
      { id: 'units',        label: '🏕️ Unidades' },
    ] : []),
    ...(isSuperAdmin() ? [
      { id: 'regions', label: '🗺️ Regiões' },
      { id: 'users',   label: '👥 Usuários' },
    ] : []),
  ];

  return `
  <div class="admin-shell">
    <div class="admin-sidebar-overlay ${S.sidebarOpen ? 'open' : ''}" onclick="W.toggleSidebar(false)"></div>
    <nav class="admin-sidebar ${S.sidebarOpen ? 'open' : ''}">
      <div style="padding:1.25rem 1rem 1rem;">
        <div style="font-size:.78rem;color:#bbf7d0;margin-bottom:.2rem;">
          👤 ${S.user.name} · ${ROLES[S.user.role] || S.user.role}
        </div>
        <h1 style="font-size:1.15rem;font-weight:800;margin:0;">Painel ADM</h1>
      </div>
      <div style="flex:1;display:flex;flex-direction:column;gap:.2rem;padding:.25rem .625rem;">
        ${tabs.map(t => `
        <button class="sidebar-link ${S.adminTab === t.id ? 'active' : ''}" onclick="W.setTab('${t.id}')">
          <span>${t.label}</span>
          ${t.count ? `<span class="count">${t.count}</span>` : ''}
        </button>`).join('')}
      </div>
      <div style="padding:.75rem;display:flex;flex-direction:column;gap:.5rem;border-top:1px solid rgba(255,255,255,.12);">
        <button onclick="W.openChangePwd()"
          style="background:rgba(0,0,0,.15);border:none;color:#bbf7d0;text-align:left;
          padding:.625rem .875rem;border-radius:.625rem;font-size:.85rem;cursor:pointer;">🔑 Trocar senha</button>
        <button onclick="W.logout()"
          style="background:rgba(0,0,0,.2);border:none;color:#fff;text-align:left;
          padding:.625rem .875rem;border-radius:.625rem;font-size:.85rem;cursor:pointer;">🚪 Sair</button>
      </div>
    </nav>

    <div class="admin-main" style="background:#f0f4f8;min-height:100dvh;">
      <div style="background:#fff;border-bottom:1px solid #f1f5f9;padding:.75rem 1rem;display:flex;align-items:center;gap:.75rem;">
        <button class="admin-hamburger" onclick="W.toggleSidebar(true)">☰</button>
        <span style="font-weight:800;color:#1e293b;">${tabs.find(t => t.id === S.adminTab)?.label || 'Painel ADM'}</span>
      </div>

      <div style="padding:1rem;padding-bottom:5rem;">
        ${S.adminTab === 'queue'        ? tQueue()    : ''}
        ${S.adminTab === 'requirements' && isAdmin()  ? tReqs()    : ''}
        ${S.adminTab === 'history'      ? tHistory()  : ''}
        ${S.adminTab === 'dashboard'    && isAdmin()  ? tDashboard(): ''}
        ${S.adminTab === 'ranking'      && isAdmin()       ? tRanking()  : ''}
        ${S.adminTab === 'participants' && isAdmin()       ? tParticipants() : ''}
        ${S.adminTab === 'units'        && isAdmin()       ? tUnits()    : ''}
        ${S.adminTab === 'regions'      && isSuperAdmin()  ? tRegions()  : ''}
        ${S.adminTab === 'users'        && isSuperAdmin()  ? tUsers()    : ''}
      </div>
    </div>
  </div>`;
}

// ── TAB: FILA ─────────────────────────────────────────────────
function tQueue() {
  const pending = [...S.submissions]
    .filter(s => s.status === 'pending')
    .sort((a, b) => (a.submittedAt?.seconds || 0) - (b.submittedAt?.seconds || 0));

  if (!pending.length) return `
    <div style="text-align:center;padding:4rem 1rem;color:#94a3b8;">
      <div style="font-size:3.5rem;">🎉</div>
      <p style="font-weight:700;font-size:1.05rem;margin:.5rem 0 .25rem;">Fila limpa!</p>
      <p style="font-size:.85rem;margin:0;">Nenhuma comprovação pendente</p>
    </div>`;

  return `
  <p style="font-size:.8rem;color:#94a3b8;margin-bottom:.875rem;">${pending.length} aguardando revisão</p>
  <div style="display:flex;flex-direction:column;gap:.875rem;">
    ${pending.map(sub => {
      const isFiscal = sub.fiscalSuggestion === true;
      return `
      <div class="card">
        ${!isFiscal ? proofBlock(sub.proofUrl, 'queue') : ''}
        <div style="padding:1rem;">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:.5rem;margin-bottom:.875rem;">
            <div style="flex:1;">
              ${isFiscal ? `<div style="margin-bottom:.5rem;"><span class="badge-fiscal">⚖️ Sugestão do Fiscal</span></div>` : ''}
              <div style="font-weight:800;color:#1e293b;font-size:.95rem;">${sub.requirementName}</div>
              <div style="font-size:.82rem;color:#64748b;margin-top:.15rem;">
                ${sub.regionName || rname(sub.regionId)} · <strong style="color:#1d4ed8;">${sub.requirementPoints} pts</strong>
              </div>
              <div style="font-size:.72rem;color:#94a3b8;margin-top:.15rem;">
                ${fmtDate(sub.submittedAt)} · ${sub.submittedByName || sub.regionName || '—'}
              </div>
              ${sub.notes ? `<div style="background:#f8fafc;border-radius:.625rem;padding:.5rem .75rem;font-size:.82rem;color:#475569;margin-top:.5rem;">"${sub.notes}"</div>` : ''}
              ${subItemDetails(sub)}
            </div>
            <span style="background:#f1f5f9;color:#475569;font-size:.7rem;font-weight:600;padding:.2rem .6rem;border-radius:999px;white-space:nowrap;flex-shrink:0;">${sub.requirementCategory}</span>
          </div>
          <div style="display:flex;gap:.75rem;">
            <button onclick="W.approve('${sub.id}')"
              style="flex:1;background:#16a34a;color:#fff;border:none;padding:.875rem;border-radius:.875rem;font-weight:700;font-size:.9rem;cursor:pointer;">✅ Aprovar</button>
            <button onclick="W.reject('${sub.id}')"
              style="flex:1;background:#fee2e2;color:#dc2626;border:none;padding:.875rem;border-radius:.875rem;font-weight:700;font-size:.9rem;cursor:pointer;">❌ Rejeitar</button>
          </div>
        </div>
      </div>`;
    }).join('')}
  </div>`;
}

// ── TAB: REQUISITOS ───────────────────────────────────────────
function tReqs() {
  return `
  <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.875rem;">
    <span style="font-weight:800;color:#1e293b;">Requisitos (${S.requirements.length})</span>
    <button onclick="W.openReqForm(null)"
      style="background:#0D2B6E;color:#fff;border:none;padding:.5rem 1rem;border-radius:.75rem;font-size:.85rem;font-weight:700;cursor:pointer;">+ Novo</button>
  </div>
  ${S.requirements.length === 0
    ? `<div style="text-align:center;padding:3rem 1rem;color:#94a3b8;"><div style="font-size:3rem;">📝</div><p style="font-weight:600;">Nenhum requisito cadastrado</p></div>`
    : `<div style="display:flex;flex-direction:column;gap:.625rem;">
      ${S.requirements.map(req => { const type = reqFilledBy(req); return `
      <div class="card" style="padding:1rem;overflow:visible;">
        <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:.5rem;">
          <div style="flex:1;">
            <div style="display:flex;gap:.375rem;flex-wrap:wrap;margin-bottom:.375rem;">
              <span style="background:#f1f5f9;color:#475569;font-size:.7rem;font-weight:600;padding:.2rem .6rem;border-radius:999px;">${req.category}</span>
              ${req.areaAtuacao ? `<span style="background:#eef2ff;color:#4338ca;font-size:.7rem;font-weight:600;padding:.2rem .6rem;border-radius:999px;">📌 ${req.areaAtuacao}</span>` : ''}
              <span style="background:#dbeafe;color:#1d4ed8;font-size:.7rem;font-weight:700;padding:.2rem .6rem;border-radius:999px;">${req.points} pts</span>
              ${req.phase ? `<span style="background:#f0fdf4;color:#0D2B6E;font-size:.7rem;font-weight:600;padding:.2rem .6rem;border-radius:999px;">${req.phase}</span>` : ''}
              ${req.competitionCategory && req.competitionCategory !== 'Ambos'
                ? `<span style="background:#fef3c7;color:#92400e;font-size:.7rem;font-weight:700;padding:.2rem .6rem;border-radius:999px;">${req.competitionCategory}</span>` : ''}
              <span class="badge-fiscal">${type === 'conselheiro' ? '🏕️' : type === 'fiscal' ? '⚖️' : '📍'} ${FILLED_BY[type]}</span>
              ${req.subItems?.length ? `<span style="background:#f5f3ff;color:#6d28d9;font-size:.7rem;font-weight:600;padding:.2rem .6rem;border-radius:999px;">📊 ${req.subItems.length} sub</span>` : ''}
              ${req.active === false ? `<span style="background:#fee2e2;color:#dc2626;font-size:.7rem;font-weight:600;padding:.2rem .6rem;border-radius:999px;">Inativo</span>` : ''}
            </div>
            <div style="font-weight:700;color:#1e293b;font-size:.9rem;">${req.name}</div>
            ${req.description ? `<div style="font-size:.78rem;color:#64748b;margin-top:.15rem;">${req.description}</div>` : ''}
          </div>
          <div style="display:flex;gap:.375rem;flex-shrink:0;">
            <button onclick="W.openReqForm('${req.id}')"
              style="background:#eff6ff;border:none;color:#1d4ed8;padding:.5rem;border-radius:.625rem;cursor:pointer;">✏️</button>
            <button onclick="W.delReq('${req.id}')"
              style="background:#fef2f2;border:none;color:#ef4444;padding:.5rem;border-radius:.625rem;cursor:pointer;">🗑️</button>
          </div>
        </div>
      </div>`; }).join('')}
    </div>`}`;
}

// ── TAB: HISTÓRICO ────────────────────────────────────────────
function tHistory() {
  const statuses = ['Todos', 'pending', 'approved', 'rejected'];
  const labels   = { Todos: 'Todos', pending: 'Pendentes', approved: 'Aprovados', rejected: 'Rejeitados' };
  const filtered = S.filterStatus === 'Todos'
    ? S.submissions
    : S.submissions.filter(s => s.status === S.filterStatus);

  return `
  <div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.625rem;flex-wrap:wrap;gap:.5rem;">
      <span style="font-weight:800;color:#1e293b;">Histórico (${filtered.length})</span>
      <div style="display:flex;gap:.375rem;">
        <button onclick="W.exportExcel()"
          style="background:#0D2B6E;color:#fff;border:none;padding:.375rem .875rem;border-radius:.625rem;font-size:.78rem;font-weight:700;cursor:pointer;">📊 Excel</button>
        <button onclick="window.print()"
          style="background:#1e3a8a;color:#fff;border:none;padding:.375rem .875rem;border-radius:.625rem;font-size:.78rem;font-weight:700;cursor:pointer;">🖨️ Imprimir</button>
      </div>
    </div>
    <div style="display:flex;gap:.375rem;margin-bottom:.875rem;flex-wrap:wrap;">
      ${statuses.map(st => `
      <button onclick="W.filterStatus('${st}')"
        style="padding:.3rem .75rem;border-radius:999px;border:none;font-size:.75rem;font-weight:600;cursor:pointer;
        background:${S.filterStatus === st ? '#0D2B6E' : '#f1f5f9'};
        color:${S.filterStatus === st ? '#fff' : '#64748b'};">
        ${labels[st]}
      </button>`).join('')}
    </div>
    ${filtered.length === 0
      ? `<div style="text-align:center;padding:3rem 1rem;color:#94a3b8;"><div style="font-size:3rem;">📂</div><p>Nenhum registro</p></div>`
      : `<div style="display:flex;flex-direction:column;gap:.625rem;">
        ${filtered.map(sub => `
        <div class="card">
          ${proofBlock(sub.proofUrl, 'history')}
          <div style="padding:.875rem;">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:.5rem;margin-bottom:.625rem;">
              <div>
                <div style="font-weight:700;color:#1e293b;font-size:.9rem;">${sub.requirementName}</div>
                <div style="font-size:.8rem;color:#64748b;">
                  ${sub.regionName || rname(sub.regionId)} · <strong style="color:#1d4ed8;">${sub.requirementPoints} pts</strong>
                </div>
                <div style="font-size:.7rem;color:#94a3b8;margin-top:.1rem;">
                  Enviado: ${fmtDate(sub.submittedAt)} · ${sub.submittedByName || sub.regionName || '—'}
                </div>
                ${sub.reviewedByName
                  ? `<div style="font-size:.7rem;color:#64748b;margin-top:.1rem;">Avaliado por: <strong>${sub.reviewedByName}</strong> · ${fmtDate(sub.reviewedAt)}</div>`
                  : ''}
              </div>
              <div style="display:flex;flex-direction:column;align-items:flex-end;gap:.25rem;flex-shrink:0;">
                ${badge(sub.status, sub.source, sub.fiscalSuggestion)}
                ${sub.source === 'judge' ? '<span style="font-size:.65rem;color:#7c3aed;">via Fiscal</span>' : ''}
              </div>
            </div>
            ${sub.rejectionReason ? `<div style="font-size:.78rem;color:#dc2626;margin-bottom:.5rem;background:#fff1f1;padding:.375rem .625rem;border-radius:.5rem;">Motivo: ${sub.rejectionReason}</div>` : ''}
            ${sub.notes ? `<div style="background:#f8fafc;border-radius:.5rem;padding:.4rem .625rem;font-size:.78rem;color:#475569;margin-bottom:.5rem;">"${sub.notes}"</div>` : ''}
            ${subItemDetails(sub)}
            <div style="display:flex;gap:.5rem;margin-top:.625rem;">
              ${sub.status !== 'pending'
                ? `<button onclick="W.reopen('${sub.id}')"
                    style="flex:1;padding:.625rem;background:#f8fafc;border:1.5px solid #e2e8f0;
                    border-radius:.75rem;color:#475569;font-size:.82rem;font-weight:600;cursor:pointer;">
                    🔄 Reverter
                  </button>`
                : ''}
              ${isSuperAdmin()
                ? `<button onclick="W.deleteSubmission('${sub.id}')"
                    style="padding:.625rem .875rem;background:#fef2f2;border:1.5px solid #fca5a5;
                    border-radius:.75rem;color:#dc2626;font-size:.82rem;font-weight:600;cursor:pointer;">
                    🗑️ Excluir
                  </button>`
                : ''}
            </div>
          </div>
        </div>`).join('')}
      </div>`}
  </div>`;
}

// ── TAB: DASHBOARD ────────────────────────────────────────────
function tDashboard() {
  const scores   = computeUnitScores(S.submissions, S.units);
  const total    = S.submissions.length;
  const approved = S.submissions.filter(s => s.status === 'approved').length;
  const pending  = S.submissions.filter(s => s.status === 'pending').length;
  const rejected = S.submissions.filter(s => s.status === 'rejected').length;
  // Soma de pontos únicos aprovados (não é a soma de scores[].total — isso duplicaria
  // pontos de requisitos Regionais, distribuídos pra todas as unidades da região)
  const totalPts = (() => {
    const counted = new Set();
    let sum = 0;
    [...S.submissions].filter(s => s.status === 'approved')
      .sort((a, b) => (b.submittedAt?.seconds || 0) - (a.submittedAt?.seconds || 0))
      .forEach(s => {
        const key = s.unitId ? `u:${s.unitId}:${s.requirementId}` : `r:${s.regionId}:${s.requirementId}`;
        if (counted.has(key)) return;
        counted.add(key);
        sum += s.requirementPoints || 0;
      });
    return sum;
  })();
  const maxPts   = scores[0]?.total || 1;
  const ptsByCat = {};
  S.submissions.filter(s => s.status === 'approved').forEach(s => {
    const c = s.requirementCategory || 'Outros';
    ptsByCat[c] = (ptsByCat[c] || 0) + (s.requirementPoints || 0);
  });
  const catMax = Math.max(...Object.values(ptsByCat), 1);

  return `
  <div style="display:flex;flex-direction:column;gap:1rem;">
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:.625rem;">
      ${[
        { v: approved, l: 'Aprovadas',  c: '#16a34a' },
        { v: pending,  l: 'Pendentes',  c: '#f59e0b' },
        { v: rejected, l: 'Rejeitadas', c: '#dc2626' },
        { v: totalPts, l: 'Pts Totais', c: '#1d4ed8' },
      ].map(({ v, l, c }) => `
      <div class="card" style="padding:.875rem;text-align:center;overflow:visible;">
        <div style="font-size:1.75rem;font-weight:800;color:${c};">${v}</div>
        <div style="font-size:.75rem;color:#64748b;margin-top:.2rem;">${l}</div>
      </div>`).join('')}
    </div>

    ${total > 0 ? `
    <div class="card" style="padding:1rem;overflow:visible;">
      <div style="font-weight:700;color:#1e293b;margin-bottom:.75rem;font-size:.9rem;">Taxa de Aprovação</div>
      <div style="background:#e2e8f0;border-radius:999px;height:.75rem;overflow:hidden;">
        <div style="background:#16a34a;height:.75rem;width:${Math.round(approved / total * 100)}%;border-radius:999px;"></div>
      </div>
      <div style="display:flex;justify-content:space-between;font-size:.75rem;color:#64748b;margin-top:.375rem;">
        <span>${Math.round(approved / total * 100)}% aprovadas</span>
        <span>${total} total</span>
      </div>
    </div>` : ''}

    <div class="card" style="padding:1rem;overflow:visible;">
      <div style="font-weight:700;color:#1e293b;margin-bottom:.875rem;font-size:.9rem;">🏆 Top 10 Unidades</div>
      <div style="display:flex;flex-direction:column;gap:.5rem;">
        ${scores.slice(0, 10).map((s, i) => `
        <div>
          <div style="display:flex;justify-content:space-between;font-size:.8rem;margin-bottom:.2rem;">
            <span style="font-weight:600;color:#374151;">${i + 1}. ${s.name}</span>
            <span style="font-weight:700;color:#1d4ed8;">${s.total} pts</span>
          </div>
          <div style="background:#e2e8f0;border-radius:999px;height:.4rem;">
            <div style="background:${i === 0 ? '#D4A017' : i === 1 ? '#9ca3af' : i === 2 ? '#92400e' : '#3b82f6'};
              border-radius:999px;height:.4rem;width:${Math.round(s.total / maxPts * 100)}%;"></div>
          </div>
        </div>`).join('')}
      </div>
    </div>

    ${Object.keys(ptsByCat).length > 0 ? `
    <div class="card" style="padding:1rem;overflow:visible;">
      <div style="font-weight:700;color:#1e293b;margin-bottom:.875rem;font-size:.9rem;">📊 Pontos por Categoria</div>
      <div style="display:flex;flex-direction:column;gap:.5rem;">
        ${Object.entries(ptsByCat).sort((a, b) => b[1] - a[1]).map(([cat, pts]) => `
        <div>
          <div style="display:flex;justify-content:space-between;font-size:.8rem;margin-bottom:.2rem;">
            <span style="color:#374151;">${cat}</span>
            <span style="font-weight:700;color:#0D2B6E;">${pts} pts</span>
          </div>
          <div style="background:#e2e8f0;border-radius:999px;height:.4rem;">
            <div style="background:#16a34a;border-radius:999px;height:.4rem;width:${Math.round(pts / catMax * 100)}%;"></div>
          </div>
        </div>`).join('')}
      </div>
    </div>` : ''}
  </div>`;
}

// ── TAB: RANKING ──────────────────────────────────────────────
// Ranking único por unidade — sem separação DBV/AVT, já que as unidades são mistas.
function tRanking() {
  const scores = computeUnitScores(S.submissions, S.units);
  const max    = scores[0]?.total || 1;
  const top3   = scores.filter(s => s.total > 0).slice(0, 3);

  return `
  <div>
    ${top3.length >= 3 ? `
    <div style="display:flex;align-items:flex-end;gap:.75rem;margin-bottom:1.25rem;">
      <div style="flex:1;text-align:center;">
        <div style="font-size:1.75rem;margin-bottom:.375rem;">🥈</div>
        <div style="background:#e2e8f0;border-radius:.875rem .875rem 0 0;padding:.75rem .5rem 1rem;min-height:5rem;display:flex;flex-direction:column;justify-content:flex-end;">
          <div style="font-weight:800;color:#1e293b;font-size:.8rem;">${top3[1]?.name}</div>
          <div style="color:#94a3b8;font-size:.65rem;">${rname(top3[1]?.regionId)}</div>
          <div style="color:#64748b;font-size:.75rem;font-weight:600;">${top3[1]?.total} pts</div>
          <div style="font-size:.7rem;">${'⭐'.repeat(computeStars(top3[1]?.total, max))}</div>
        </div>
      </div>
      <div style="flex:1;text-align:center;">
        <div style="font-size:2.25rem;margin-bottom:.375rem;">🥇</div>
        <div style="background:#fef3c7;border-radius:.875rem .875rem 0 0;padding:.75rem .5rem 1rem;min-height:7rem;display:flex;flex-direction:column;justify-content:flex-end;">
          <div style="font-weight:800;color:#1e293b;font-size:.85rem;">${top3[0]?.name}</div>
          <div style="color:#94a3b8;font-size:.65rem;">${rname(top3[0]?.regionId)}</div>
          <div style="color:#D4A017;font-size:.8rem;font-weight:800;">${top3[0]?.total} pts</div>
          <div style="font-size:.75rem;">${'⭐'.repeat(computeStars(top3[0]?.total, max))}</div>
        </div>
      </div>
      <div style="flex:1;text-align:center;">
        <div style="font-size:1.75rem;margin-bottom:.375rem;">🥉</div>
        <div style="background:#fee2e2;border-radius:.875rem .875rem 0 0;padding:.75rem .5rem 1rem;min-height:3.5rem;display:flex;flex-direction:column;justify-content:flex-end;">
          <div style="font-weight:800;color:#1e293b;font-size:.8rem;">${top3[2]?.name}</div>
          <div style="color:#94a3b8;font-size:.65rem;">${rname(top3[2]?.regionId)}</div>
          <div style="color:#dc2626;font-size:.75rem;font-weight:600;">${top3[2]?.total} pts</div>
          <div style="font-size:.7rem;">${'⭐'.repeat(computeStars(top3[2]?.total, max))}</div>
        </div>
      </div>
    </div>` : ''}

    <div style="display:flex;flex-direction:column;gap:.5rem;">
      ${scores.length === 0
        ? `<div style="text-align:center;padding:3rem;color:#94a3b8;"><p>Nenhuma pontuação ainda</p></div>`
        : scores.map((s, i) => `
        <div style="display:flex;align-items:center;gap:.875rem;padding:.875rem;border-radius:.875rem;
          background:${i < 3 && s.total > 0 ? '#f0fdf4' : '#f8fafc'};">
          <div style="width:2rem;text-align:center;font-weight:800;font-size:.9rem;flex-shrink:0;
            color:${i === 0 && s.total > 0 ? '#D4A017' : i === 1 && s.total > 0 ? '#6b7280' : i === 2 && s.total > 0 ? '#92400e' : '#94a3b8'};">
            ${i === 0 && s.total > 0 ? '🥇' : i === 1 && s.total > 0 ? '🥈' : i === 2 && s.total > 0 ? '🥉' : `${i + 1}º`}
          </div>
          <div style="flex:1;">
            <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.3rem;">
              <span>
                <span style="font-weight:700;color:#1e293b;font-size:.9rem;">${s.name}</span>
                <span style="color:#94a3b8;font-size:.72rem;"> · ${rname(s.regionId)}</span>
              </span>
              <span style="font-weight:800;color:${s.total > 0 ? '#0D2B6E' : '#94a3b8'};font-size:.9rem;">${s.total} pts</span>
            </div>
            <div style="background:#e2e8f0;border-radius:999px;height:.4rem;">
              <div style="background:#16a34a;border-radius:999px;height:.4rem;width:${Math.round((s.total / max) * 100)}%;"></div>
            </div>
            <div style="display:flex;justify-content:space-between;align-items:center;margin-top:.2rem;">
              ${s.count > 0 ? `<div style="font-size:.7rem;color:#94a3b8;">${s.count} aprovação${s.count !== 1 ? 'ões' : ''}</div>` : '<div></div>'}
              ${s.total > 0 ? `<div style="font-size:.7rem;">${'⭐'.repeat(computeStars(s.total, max))}</div>` : ''}
            </div>
          </div>
        </div>`).join('')}
    </div>
    <p style="text-align:center;font-size:.75rem;color:#94a3b8;margin-top:1rem;">Atualizado em tempo real</p>
  </div>`;
}

// ── TAB: REGIÕES ──────────────────────────────────────────────
function tRegions() {
  const sorted = [...S.regions].sort((a, b) => a.name.localeCompare(b.name));
  const linkedUserOf = regId => S.users.find(u => u.regionId === regId && u.role === 'region');
  return `
  <div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.875rem;">
      <span style="font-weight:800;color:#1e293b;">Regiões (${S.regions.length})</span>
      <div style="display:flex;gap:.5rem;">
        <button onclick="W.openRegionForm(null)"
          style="background:#0D2B6E;color:#fff;border:none;padding:.5rem 1rem;border-radius:.75rem;font-size:.85rem;font-weight:700;cursor:pointer;">+ Nova</button>
      </div>
    </div>
    ${sorted.length === 0
      ? `<div style="text-align:center;padding:3rem 1rem;color:#94a3b8;">
          <div style="font-size:3rem;">🗺️</div>
          <p style="font-weight:600;">Nenhuma região cadastrada</p>
          <p style="font-size:.85rem;">Clique em "+ Nova" para cadastrar as regiões</p>
        </div>`
      : `<div style="display:flex;flex-direction:column;gap:.625rem;">
        ${sorted.map(reg => `
        <div class="card" style="padding:1rem;overflow:visible;border:1px solid ${reg.active === false ? '#fee2e2' : '#e2e8f0'};">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:.5rem;">
            <div style="flex:1;">
              <div style="display:flex;gap:.375rem;flex-wrap:wrap;margin-bottom:.375rem;">
                <span style="background:${reg.competitionCategory === 'AVT' ? '#d1fae5' : '#dbeafe'};
                  color:${reg.competitionCategory === 'AVT' ? '#065f46' : '#1d4ed8'};
                  font-size:.7rem;font-weight:700;padding:.2rem .6rem;border-radius:999px;">
                  ${reg.competitionCategory || 'DBV'}
                </span>
                ${reg.active === false ? `<span style="background:#fee2e2;color:#dc2626;font-size:.7rem;font-weight:600;padding:.2rem .6rem;border-radius:999px;">Inativa</span>` : ''}
              </div>
              <div style="font-weight:700;color:#1e293b;">${reg.name}</div>
              ${reg.responsible
                ? `<div style="font-size:.78rem;color:#64748b;margin-top:.15rem;">
                    👤 ${reg.responsible}${reg.responsiblePhone ? ` · ${reg.responsiblePhone}` : ''}
                  </div>`
                : `<div style="font-size:.75rem;color:#94a3b8;margin-top:.15rem;">Sem responsável cadastrado</div>`}
              ${(() => { const lu = linkedUserOf(reg.id); return lu
                ? `<div style="font-size:.72rem;color:#94a3b8;margin-top:.2rem;">🔑 Login: <strong>${lu.username}</strong></div>`
                : `<div style="font-size:.72rem;color:#dc2626;margin-top:.2rem;">⚠️ Sem usuário vinculado</div>`; })()}
            </div>
            <div style="display:flex;gap:.375rem;flex-shrink:0;">
              <button onclick="W.openRegionForm('${reg.id}')"
                style="background:#eff6ff;border:none;color:#1d4ed8;padding:.5rem;border-radius:.625rem;cursor:pointer;">✏️</button>
              <button onclick="W.delRegion('${reg.id}','${reg.name}')"
                style="background:#fef2f2;border:none;color:#ef4444;padding:.5rem;border-radius:.625rem;cursor:pointer;">🗑️</button>
            </div>
          </div>
        </div>`).join('')}
      </div>`}
  </div>`;
}

// ── TAB: USUÁRIOS ─────────────────────────────────────────────
function tUsers() {
  const sorted = [...S.users].filter(u => u.role !== 'region').sort((a, b) => a.name.localeCompare(b.name));
  return `
  <div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.875rem;">
      <span style="font-weight:800;color:#1e293b;">Usuários (${sorted.length})</span>
      <button onclick="W.openUserForm(null)"
        style="background:#0D2B6E;color:#fff;border:none;padding:.5rem 1rem;border-radius:.75rem;font-size:.85rem;font-weight:700;cursor:pointer;">+ Novo</button>
    </div>
    ${sorted.length === 0
      ? `<div style="text-align:center;padding:3rem 1rem;color:#94a3b8;"><div style="font-size:3rem;">👥</div><p>Nenhum usuário</p></div>`
      : `<div style="display:flex;flex-direction:column;gap:.625rem;">
        ${sorted.map(u => `
        <div class="card" style="padding:1rem;overflow:visible;border:1px solid ${u.active === false ? '#fee2e2' : '#e2e8f0'};">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:.5rem;">
            <div style="flex:1;">
              <div style="display:flex;gap:.375rem;flex-wrap:wrap;margin-bottom:.375rem;">
                <span style="background:${u.role === 'superadmin' ? '#fef3c7' : u.role === 'admin' ? '#dbeafe' : u.role === 'judge' ? '#ede9fe' : '#f0fdf4'};
                  color:${u.role === 'superadmin' ? '#92400e' : u.role === 'admin' ? '#1d4ed8' : u.role === 'judge' ? '#6d28d9' : '#0D2B6E'};
                  font-size:.7rem;font-weight:700;padding:.2rem .6rem;border-radius:999px;">${ROLES[u.role] || u.role}</span>
                ${u.active === false ? `<span style="background:#fee2e2;color:#dc2626;font-size:.7rem;font-weight:600;padding:.2rem .6rem;border-radius:999px;">Inativo</span>` : ''}
                ${u.competitionCategory ? `<span style="background:#fef3c7;color:#92400e;font-size:.7rem;font-weight:700;padding:.2rem .6rem;border-radius:999px;">${u.competitionCategory}</span>` : ''}
                ${u.judgeCategory ? `<span style="background:#f5f3ff;color:#6d28d9;font-size:.7rem;padding:.2rem .6rem;border-radius:999px;">${u.judgeCategory}</span>` : ''}
              </div>
              <div style="font-weight:700;color:#1e293b;">${u.name}</div>
              <div style="font-size:.78rem;color:#64748b;">${u.username}${u.phone ? ` · ${u.phone}` : ''}</div>
              ${u.role === 'counselor' && u.unitId
                ? `<div style="font-size:.72rem;color:#94a3b8;margin-top:.1rem;">🏕️ ${S.units.find(x => x.id === u.unitId)?.name || u.unitId}</div>`
                : ''}
            </div>
            <div style="display:flex;gap:.375rem;flex-shrink:0;">
              <button onclick="W.openUserForm('${u.id}')"
                style="background:#eff6ff;border:none;color:#1d4ed8;padding:.5rem;border-radius:.625rem;cursor:pointer;">✏️</button>
              <button onclick="W.toggleUser('${u.id}',${u.active !== false})"
                style="background:${u.active === false ? '#f0fdf4' : '#fef2f2'};border:none;
                color:${u.active === false ? '#16a34a' : '#ef4444'};padding:.5rem;border-radius:.625rem;cursor:pointer;">
                ${u.active === false ? '✅' : '🚫'}
              </button>
              ${isSuperAdmin() ? `<button onclick="W.deleteUser('${u.id}','${u.name}')"
                style="background:#fef2f2;border:none;color:#dc2626;padding:.5rem;border-radius:.625rem;cursor:pointer;">🗑️</button>` : ''}
            </div>
          </div>
        </div>`).join('')}
      </div>`}
  </div>`;
}

// ── TAB: PARTICIPANTES ────────────────────────────────────────
function tParticipants() {
  const regFilter = S.participantFilterRegion;
  const catFilter = S.participantFilterCat;
  const filtered = S.participants.filter(p =>
    (regFilter === 'Todas' || p.regionId === regFilter) &&
    (catFilter === 'Todos' || p.competitionCategory === catFilter)
  ).sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const sortedRegions = [...S.regions].sort((a, b) => a.name.localeCompare(b.name));

  return `
  <div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.875rem;flex-wrap:wrap;gap:.5rem;">
      <span style="font-weight:800;color:#1e293b;">Participantes (${filtered.length})</span>
      <div style="display:flex;gap:.5rem;">
        <button onclick="W.openParticipantImport()"
          style="background:#eff6ff;color:#1d4ed8;border:none;padding:.5rem 1rem;border-radius:.75rem;font-size:.85rem;font-weight:700;cursor:pointer;">📥 Importar</button>
        <button onclick="W.openParticipantForm(null)"
          style="background:#0D2B6E;color:#fff;border:none;padding:.5rem 1rem;border-radius:.75rem;font-size:.85rem;font-weight:700;cursor:pointer;">+ Novo</button>
      </div>
    </div>

    <div style="display:flex;gap:.5rem;margin-bottom:.875rem;flex-wrap:wrap;">
      <select onchange="W.setParticipantFilterRegion(this.value)"
        style="border:1.5px solid #e2e8f0;border-radius:.625rem;padding:.4rem .625rem;font-size:.82rem;background:#fff;">
        <option value="Todas" ${regFilter === 'Todas' ? 'selected' : ''}>Todas as regiões</option>
        ${sortedRegions.map(r => `<option value="${r.id}" ${regFilter === r.id ? 'selected' : ''}>${r.name}</option>`).join('')}
      </select>
      <select onchange="W.setParticipantFilterCat(this.value)"
        style="border:1.5px solid #e2e8f0;border-radius:.625rem;padding:.4rem .625rem;font-size:.82rem;background:#fff;">
        ${['Todos', 'DBV', 'AVT'].map(c => `<option value="${c}" ${catFilter === c ? 'selected' : ''}>${c}</option>`).join('')}
      </select>
    </div>

    ${filtered.length === 0
      ? `<div style="text-align:center;padding:3rem 1rem;color:#94a3b8;"><div style="font-size:3rem;">👥</div><p style="font-weight:600;">Nenhum participante</p></div>`
      : `<div style="display:flex;flex-direction:column;gap:.625rem;">
        ${filtered.map(p => `
        <div class="card" style="padding:1rem;overflow:visible;">
          <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:.5rem;">
            <div style="flex:1;">
              <div style="display:flex;gap:.375rem;flex-wrap:wrap;margin-bottom:.375rem;">
                <span style="background:${p.competitionCategory === 'AVT' ? '#d1fae5' : '#dbeafe'};
                  color:${p.competitionCategory === 'AVT' ? '#065f46' : '#1d4ed8'};
                  font-size:.7rem;font-weight:700;padding:.2rem .6rem;border-radius:999px;">${p.competitionCategory || '—'}</span>
                ${p.unitId ? `<span style="background:#fef3c7;color:#92400e;font-size:.7rem;font-weight:600;padding:.2rem .6rem;border-radius:999px;">Alocado em unidade</span>` : ''}
              </div>
              <div style="font-weight:700;color:#1e293b;">${p.name}</div>
              <div style="font-size:.78rem;color:#64748b;">${p.club ? `${p.club} · ` : ''}${rname(p.regionId)}</div>
            </div>
            <div style="display:flex;gap:.375rem;flex-shrink:0;">
              <button onclick="W.openParticipantForm('${p.id}')"
                style="background:#eff6ff;border:none;color:#1d4ed8;padding:.5rem;border-radius:.625rem;cursor:pointer;">✏️</button>
              ${isSuperAdmin() ? `<button onclick="W.deleteParticipant('${p.id}','${p.name}')"
                style="background:#fef2f2;border:none;color:#dc2626;padding:.5rem;border-radius:.625rem;cursor:pointer;">🗑️</button>` : ''}
            </div>
          </div>
        </div>`).join('')}
      </div>`}
  </div>`;
}

// ── TAB: UNIDADES ─────────────────────────────────────────────
function tUnits() {
  const regFilter = S.unitFilterRegion;
  const filtered = S.units.filter(u => regFilter === 'Todas' || u.regionId === regFilter)
    .sort((a, b) => (a.name || '').localeCompare(b.name || ''));
  const sortedRegions = [...S.regions].sort((a, b) => a.name.localeCompare(b.name));

  return `
  <div>
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.875rem;flex-wrap:wrap;gap:.5rem;">
      <span style="font-weight:800;color:#1e293b;">Unidades (${filtered.length})</span>
      <button onclick="W.openUnitForm(null)"
        style="background:#0D2B6E;color:#fff;border:none;padding:.5rem 1rem;border-radius:.75rem;font-size:.85rem;font-weight:700;cursor:pointer;">+ Nova</button>
    </div>

    <div style="margin-bottom:.875rem;">
      <select onchange="W.setUnitFilterRegion(this.value)"
        style="border:1.5px solid #e2e8f0;border-radius:.625rem;padding:.4rem .625rem;font-size:.82rem;background:#fff;">
        <option value="Todas" ${regFilter === 'Todas' ? 'selected' : ''}>Todas as regiões</option>
        ${sortedRegions.map(r => `<option value="${r.id}" ${regFilter === r.id ? 'selected' : ''}>${r.name}</option>`).join('')}
      </select>
    </div>

    ${filtered.length === 0
      ? `<div style="text-align:center;padding:3rem 1rem;color:#94a3b8;"><div style="font-size:3rem;">🏕️</div><p style="font-weight:600;">Nenhuma unidade cadastrada</p></div>`
      : `<div style="display:flex;flex-direction:column;gap:.625rem;">
        ${filtered.map(u => {
          const members = S.participants.filter(p => p.unitId === u.id);
          const guestCount = members.filter(p => p.regionId !== u.regionId).length;
          const counselor = S.users.find(cu => cu.role === 'counselor' && cu.unitId === u.id);
          return `
          <div class="card" style="padding:1rem;overflow:visible;">
            <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:.5rem;">
              <div style="flex:1;">
                <div style="display:flex;gap:.375rem;flex-wrap:wrap;margin-bottom:.375rem;">
                  <span style="background:#f1f5f9;color:#475569;font-size:.7rem;font-weight:600;padding:.2rem .6rem;border-radius:999px;">${rname(u.regionId)}</span>
                  <span style="background:#dbeafe;color:#1d4ed8;font-size:.7rem;font-weight:700;padding:.2rem .6rem;border-radius:999px;">${members.length} membro${members.length !== 1 ? 's' : ''}</span>
                  ${guestCount > 0 ? `<span style="background:#fef3c7;color:#92400e;font-size:.7rem;font-weight:600;padding:.2rem .6rem;border-radius:999px;">${guestCount} clube amigo</span>` : ''}
                </div>
                <div style="font-weight:700;color:#1e293b;">${u.name}</div>
                ${u.warCry ? `<div style="font-size:.78rem;color:#64748b;margin-top:.15rem;">"${u.warCry}"</div>` : ''}
              </div>
              <div style="display:flex;gap:.375rem;flex-shrink:0;">
                <button onclick="W.openUnitParticipants('${u.id}')"
                  style="background:#f0fdf4;border:none;color:#166534;padding:.5rem;border-radius:.625rem;cursor:pointer;">👥</button>
                <button onclick="W.openUnitForm('${u.id}')"
                  style="background:#eff6ff;border:none;color:#1d4ed8;padding:.5rem;border-radius:.625rem;cursor:pointer;">✏️</button>
                ${isSuperAdmin() ? `<button onclick="W.deleteUnit('${u.id}','${u.name}')"
                  style="background:#fef2f2;border:none;color:#dc2626;padding:.5rem;border-radius:.625rem;cursor:pointer;">🗑️</button>` : ''}
              </div>
            </div>
            <div style="margin-top:.75rem;padding-top:.625rem;border-top:1px solid #f1f5f9;display:flex;align-items:center;justify-content:space-between;gap:.5rem;flex-wrap:wrap;">
              ${counselor
                ? `<div style="font-size:.78rem;color:#64748b;">👤 Conselheiro: <strong>${counselor.name}</strong> (${counselor.username})</div>`
                : `<div style="font-size:.78rem;color:#94a3b8;">Sem conselheiro vinculado</div>`}
              ${!counselor ? `<button onclick="W.openCounselorForm('${u.id}')"
                  style="background:#eff6ff;color:#1d4ed8;border:none;padding:.4rem .75rem;border-radius:.625rem;font-size:.78rem;font-weight:700;cursor:pointer;">+ Vincular Conselheiro</button>` : ''}
            </div>
          </div>`;
        }).join('')}
      </div>`}
  </div>`;
}

// ── MODAL: REQUISITO ──────────────────────────────────────────
function mReqForm() {
  const r = S.editingReq || {};
  const isEdit   = !!r.id;
  const subItems = r.subItems || [];
  const subTotal = subItems.reduce((a, si) => a + Number(si.points || 0), 0);
  const hasSub   = subItems.length > 0;
  const lbl = t => `<label style="display:block;font-size:.82rem;font-weight:700;color:#374151;margin-bottom:.375rem;">${t}</label>`;
  const sel = (id, opts, cur) =>
    `<select id="${id}" style="width:100%;border:1.5px solid #e2e8f0;border-radius:.875rem;padding:.875rem;font-size:.9rem;outline:none;background:#fff;">
      ${opts.map(o => typeof o === 'string'
        ? `<option value="${o}" ${cur === o ? 'selected' : ''}>${o}</option>`
        : `<option value="${o.v}" ${cur === o.v ? 'selected' : ''}>${o.l}</option>`
      ).join('')}
    </select>`;

  return `
  <div class="modal-overlay" onclick="if(event.target===this)W.closeModal()">
    <div class="modal-content">
      <div style="width:2.5rem;height:.25rem;background:#e2e8f0;border-radius:999px;margin:0 auto .875rem;"></div>
      <h2 style="font-size:1.15rem;font-weight:800;color:#1e293b;margin:0 0 1.25rem;">${isEdit ? 'Editar' : 'Novo'} Requisito</h2>
      <div style="display:flex;flex-direction:column;gap:.875rem;">
        <div>${lbl('Nome *')}<input id="rq-name" type="text" value="${r.name || ''}" placeholder="Ex: Planejamento Anual"
          style="width:100%;border:1.5px solid #e2e8f0;border-radius:.875rem;padding:.875rem;font-size:.9rem;outline:none;"></div>
        <div>${lbl('Código da pasta')}<input id="rq-code" type="text" value="${r.code || ''}" placeholder="ex: planejamento-anual"
          style="width:100%;border:1.5px solid #e2e8f0;border-radius:.875rem;padding:.875rem;font-size:.9rem;outline:none;"
          oninput="this.value=this.value.toLowerCase().replace(/[^a-z0-9-_]/g,'-')"></div>
        <div>${lbl('Descrição')}<textarea id="rq-desc" rows="2" placeholder="Orientações..."
          style="width:100%;border:1.5px solid #e2e8f0;border-radius:.875rem;padding:.875rem;font-size:.9rem;resize:none;outline:none;font-family:inherit;">${r.description || ''}</textarea></div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem;">
          <div>${lbl('Categoria *')}${sel('rq-cat', CATEGORIES, r.category || CATEGORIES[0])}</div>
          <div>${lbl('Fase *')}${sel('rq-phase', PHASES, r.phase || PHASES[0])}</div>
        </div>
        <div>${lbl('Área de Atuação')}${sel('rq-areaatuacao', AREAS_ATUACAO, r.areaAtuacao || AREAS_ATUACAO[0])}</div>
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:.75rem;">
          <div>${lbl('Modalidade')}${sel('rq-compcat', COMP_CATS, r.competitionCategory || 'Ambos')}</div>
          <div>${lbl('Tipo *')}${sel('rq-filledby', [
            { v: 'regional', l: '📍 Regional' },
            { v: 'conselheiro', l: '🏕️ Conselheiro' },
            { v: 'fiscal', l: '⚖️ Só Fiscal' }
          ], reqFilledBy(r))}</div>
        </div>
        <div style="font-size:.72rem;color:#94a3b8;margin-top:-.5rem;">
          Regional: aparece no portal da região, pontua para todas as unidades. Conselheiro: aparece no portal do conselheiro (sem distinção de modalidade), pontua só para a unidade. Fiscal: só o Fiscal de Prova avalia.
        </div>

        <div style="border:1.5px solid #e2e8f0;border-radius:.875rem;padding:1rem;background:#fafafa;">
          <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.5rem;">
            <div>
              <div style="font-size:.85rem;font-weight:700;color:#374151;">📊 Sub-itens (opcional)</div>
              <div style="font-size:.72rem;color:#94a3b8;">Fiscal avalia cada um em % (0/30/50/70/100)</div>
            </div>
            <button onclick="W.addSubItem()"
              style="background:#7c3aed;color:#fff;border:none;padding:.375rem .75rem;border-radius:.625rem;font-size:.8rem;font-weight:700;cursor:pointer;">+ Add</button>
          </div>
          <div id="subitems-list">
            ${subItems.map((si, i) => `
            <div class="sub-item-row" data-id="${si.id || ''}" style="display:flex;gap:.5rem;align-items:center;margin-bottom:.5rem;">
              <input class="si-name" type="text" value="${si.name || ''}" placeholder="Nome do sub-item"
                style="flex:1;border:1.5px solid #e2e8f0;border-radius:.625rem;padding:.625rem;font-size:.85rem;outline:none;">
              <input class="si-pts" type="number" value="${si.points || 0}" min="0" placeholder="pts"
                style="width:70px;border:1.5px solid #e2e8f0;border-radius:.625rem;padding:.625rem;font-size:.85rem;outline:none;text-align:center;">
              <button onclick="W.removeSubItem(${i})"
                style="background:#fef2f2;border:none;color:#ef4444;padding:.5rem;border-radius:.5rem;cursor:pointer;flex-shrink:0;">🗑️</button>
            </div>`).join('')}
          </div>
          ${hasSub
            ? `<div style="text-align:right;font-size:.82rem;color:#7c3aed;font-weight:700;">Total: ${subTotal} pts</div>`
            : `<div style="font-size:.75rem;color:#94a3b8;text-align:center;">Sem sub-itens — use o campo Pontuação abaixo</div>`}
        </div>

        <div>${lbl(hasSub ? 'Pontuação (soma dos sub-itens)' : 'Pontuação *')}
          <input id="rq-pts" type="number" value="${hasSub ? subTotal : (r.points || '')}" placeholder="Ex: 50"
            ${hasSub ? 'readonly' : ''}
            style="width:100%;border:1.5px solid #e2e8f0;border-radius:.875rem;padding:.875rem;font-size:.9rem;outline:none;${hasSub ? 'background:#f8fafc;' : ''}">
        </div>

        ${isEdit ? `
        <div style="display:flex;align-items:center;gap:.75rem;">
          <input type="checkbox" id="rq-active" ${r.active !== false ? 'checked' : ''} style="width:1.1rem;height:1.1rem;">
          <label for="rq-active" style="font-size:.9rem;font-weight:600;color:#374151;">Requisito ativo</label>
        </div>` : ''}

        <button onclick="W.saveReq()" ${S.loading ? 'disabled' : ''}
          style="width:100%;background:#0D2B6E;color:#fff;border:none;padding:1.1rem;border-radius:1rem;font-size:1rem;font-weight:800;cursor:pointer;opacity:${S.loading ? .6 : 1};">
          ${S.loading ? '⏳ Salvando...' : (isEdit ? '💾 Salvar' : '+ Criar Requisito')}
        </button>
      </div>
      <button onclick="W.closeModal()"
        style="width:100%;margin-top:.625rem;padding:.875rem;background:none;border:none;color:#9ca3af;cursor:pointer;">Cancelar</button>
    </div>
  </div>`;
}

// ── MODAL: USUÁRIO ────────────────────────────────────────────
function mUserForm() {
  const u           = S.editingUser;
  const isEdit      = !!u?.id;
  // 'region' e 'counselor' não são criáveis aqui: precisam de regionId/unitId,
  // que só existem nos fluxos dedicados (aba Regiões / botão "Vincular Conselheiro" em Unidades)
  const roleOptions = Object.entries(ROLES).filter(([k]) => k !== 'region' && k !== 'counselor');
  const role        = S.formRole || u?.role || null;
  const showRest    = isEdit || !!role;
  const isCounselor = isEdit && u?.role === 'counselor';
  const lbl = t => `<label style="display:block;font-size:.82rem;font-weight:700;color:#374151;margin-bottom:.375rem;">${t}</label>`;

  return `
  <div class="modal-overlay center" onclick="if(event.target===this)W.closeModal()">
    <div class="modal-content" style="max-width:420px;">
      <h2 style="font-size:1.15rem;font-weight:800;color:#1e293b;margin:0 0 1.25rem;">${isEdit ? 'Editar' : 'Novo'} Usuário</h2>
      <div style="display:flex;flex-direction:column;gap:.875rem;">
        ${isCounselor
          ? `<div>${lbl('Perfil')}<div style="background:#f8fafc;border-radius:.875rem;padding:.875rem;font-weight:700;color:#374151;">🏕️ Conselheiro</div></div>`
          : `<div>${lbl('Perfil *')}
          <select id="u-role" onchange="W.setFormRole(this.value)"
            style="width:100%;border:1.5px solid #e2e8f0;border-radius:.875rem;padding:.875rem;font-size:.9rem;outline:none;background:#fff;">
            ${!isEdit ? `<option value="" disabled ${!role ? 'selected' : ''}>Selecione o perfil...</option>` : ''}
            ${roleOptions.map(([k, v]) => `<option value="${k}" ${role === k ? 'selected' : ''}>${v}</option>`).join('')}
          </select>
        </div>`}
        ${showRest ? `
        <div>${lbl('Nome completo *')}<input id="u-name" type="text" value="${u?.name || ''}" placeholder="João Silva"
          style="width:100%;border:1.5px solid #e2e8f0;border-radius:.875rem;padding:.875rem;font-size:.9rem;outline:none;"></div>
        <div>${lbl('Telefone')}<input id="u-phone" type="tel" value="${u?.phone || ''}" placeholder="(11) 99999-9999"
          style="width:100%;border:1.5px solid #e2e8f0;border-radius:.875rem;padding:.875rem;font-size:.9rem;outline:none;"></div>
        ${isEdit
          ? `<div style="background:#f8fafc;border-radius:.875rem;padding:.75rem;font-size:.85rem;color:#64748b;">Usuário: <strong>${u?.username}</strong></div>`
          : `<div style="background:#f8fafc;border-radius:.875rem;padding:.75rem 1rem;font-size:.8rem;color:#64748b;">🔑 Login e senha serão gerados automaticamente a partir do nome</div>`}
        ${role === 'judge' ? `
          <div>${lbl('Categoria *')}<select id="u-cat"
            style="width:100%;border:1.5px solid #e2e8f0;border-radius:.875rem;padding:.875rem;font-size:.9rem;outline:none;background:#fff;">
            <option value="">Todas as categorias</option>
            ${CATEGORIES.map(c => `<option value="${c}" ${u?.judgeCategory === c ? 'selected' : ''}>${c}</option>`).join('')}
          </select></div>` : ''}
        <button onclick="W.saveUser()" ${S.loading ? 'disabled' : ''}
          style="width:100%;background:#0D2B6E;color:#fff;border:none;padding:1.1rem;border-radius:1rem;font-size:1rem;font-weight:800;cursor:pointer;opacity:${S.loading ? .6 : 1};">
          ${S.loading ? '⏳ Salvando...' : (isEdit ? '💾 Salvar' : '+ Criar Usuário')}
        </button>` : ''}
      </div>
      <button onclick="W.closeModal()"
        style="width:100%;margin-top:.625rem;padding:.875rem;background:none;border:none;color:#9ca3af;cursor:pointer;">Cancelar</button>
    </div>
  </div>`;
}

// ── MODAL: FOTO ───────────────────────────────────────────────
function mPhoto() {
  return `
  <div class="modal-overlay" style="background:rgba(0,0,0,.92);align-items:center;padding:1rem;" onclick="W.closeModal()">
    <div style="position:relative;width:100%;max-width:500px;">
      <button onclick="W.closeModal()"
        style="position:absolute;top:-2.5rem;right:0;background:rgba(255,255,255,.15);
        border:none;color:#fff;width:2rem;height:2rem;border-radius:50%;cursor:pointer;">✕</button>
      <img src="${S.photoUrl}" style="width:100%;border-radius:1rem;max-height:80dvh;object-fit:contain;">
      <div style="display:flex;gap:.75rem;margin-top:.75rem;justify-content:center;">
        <a href="${S.photoUrl}" target="_blank" style="color:#93c5fd;font-size:.85rem;text-decoration:none;">🔗 Tela cheia</a>
      </div>
    </div>
  </div>`;
}

// ── MODAL: REGIÃO ─────────────────────────────────────────────
function mRegionForm() {
  const r      = S.editingRegion || {};
  const isEdit = !!r.id;
  const linkedUser = isEdit ? S.users.find(u => u.regionId === r.id && u.role === 'region') : null;
  const lbl = t => `<label style="display:block;font-size:.82rem;font-weight:700;color:#374151;margin-bottom:.375rem;">${t}</label>`;

  return `
  <div class="modal-overlay center" onclick="if(event.target===this)W.closeModal()">
    <div class="modal-content" style="max-width:420px;">
      <h2 style="font-size:1.15rem;font-weight:800;color:#1e293b;margin:0 0 1.25rem;">${isEdit ? 'Editar' : 'Nova'} Região</h2>
      <div style="display:flex;flex-direction:column;gap:.875rem;">
        <div>${lbl('Nome *')}<input id="reg-name" type="text" value="${r.name || ''}" placeholder="Ex: 1ª Região"
          style="width:100%;border:1.5px solid #e2e8f0;border-radius:.875rem;padding:.875rem;font-size:.9rem;outline:none;"></div>
        <div>${lbl('Responsável')}<input id="reg-responsible" type="text" value="${r.responsible || ''}" placeholder="Nome do responsável"
          style="width:100%;border:1.5px solid #e2e8f0;border-radius:.875rem;padding:.875rem;font-size:.9rem;outline:none;"></div>
        <div>${lbl('Telefone do Responsável')}<input id="reg-phone" type="tel" value="${r.responsiblePhone || ''}" placeholder="(11) 99999-9999"
          style="width:100%;border:1.5px solid #e2e8f0;border-radius:.875rem;padding:.875rem;font-size:.9rem;outline:none;"></div>
        <div>${lbl('Modalidade *')}
          <select id="reg-compcat" style="width:100%;border:1.5px solid #e2e8f0;border-radius:.875rem;padding:.875rem;font-size:.9rem;outline:none;background:#fff;">
            <option value="DBV" ${(r.competitionCategory || 'DBV') === 'DBV' ? 'selected' : ''}>DBV — Desbravadores</option>
            <option value="AVT" ${r.competitionCategory === 'AVT' ? 'selected' : ''}>AVT — Aventureiros</option>
          </select>
        </div>
        ${isEdit ? `
        <div style="background:#f8fafc;border:1.5px solid #e2e8f0;border-radius:.875rem;padding:.875rem;">
          <div style="font-size:.82rem;font-weight:700;color:#374151;margin-bottom:.375rem;">
            🔑 Usuário vinculado: <strong>${linkedUser ? linkedUser.username : '— não encontrado'}</strong>
          </div>
          <div style="display:flex;align-items:center;gap:.75rem;">
            <input id="reg-pwd" type="text" value="${S.generatedPwd}" placeholder="Deixe em branco para manter a senha atual"
              style="flex:1;border:1.5px solid #e2e8f0;border-radius:.625rem;padding:.625rem;font-size:1rem;font-weight:700;letter-spacing:.1rem;background:#fff;outline:none;">
            <button onclick="W.regenPwd()"
              style="background:#0D2B6E;border:none;color:#fff;padding:.625rem .875rem;border-radius:.625rem;font-size:.8rem;cursor:pointer;">🔄 Gerar nova</button>
          </div>
          <div style="font-size:.75rem;color:#64748b;margin-top:.375rem;">A senha atual é criptografada e não pode ser exibida — gere uma nova apenas se precisar redefini-la</div>
        </div>` : `
        <div style="background:#f8fafc;border-radius:.875rem;padding:.75rem 1rem;font-size:.8rem;color:#64748b;">
          🔑 Login e senha serão gerados automaticamente a partir do nome do responsável
        </div>`}
        ${isEdit ? `
        <div style="display:flex;align-items:center;gap:.75rem;">
          <input type="checkbox" id="reg-active" ${r.active !== false ? 'checked' : ''} style="width:1.1rem;height:1.1rem;">
          <label for="reg-active" style="font-size:.9rem;font-weight:600;color:#374151;">Região ativa</label>
        </div>` : ''}
        <button onclick="W.saveRegion()" ${S.loading ? 'disabled' : ''}
          style="width:100%;background:#0D2B6E;color:#fff;border:none;padding:1.1rem;border-radius:1rem;font-size:1rem;font-weight:800;cursor:pointer;opacity:${S.loading ? .6 : 1};">
          ${S.loading ? '⏳ Salvando...' : isEdit ? '💾 Salvar' : '+ Criar Região'}
        </button>
      </div>
      <button onclick="W.closeModal()"
        style="width:100%;margin-top:.625rem;padding:.875rem;background:none;border:none;color:#9ca3af;cursor:pointer;">Cancelar</button>
    </div>
  </div>`;
}

// ── MODAL: PARTICIPANTE ────────────────────────────────────────
function mParticipantForm() {
  const p = S.editingParticipant || {};
  const isEdit = !!p.id;
  const region = S.regions.find(r => r.id === p.regionId);
  const sortedRegions = [...S.regions].sort((a, b) => a.name.localeCompare(b.name));
  const lbl = t => `<label style="display:block;font-size:.82rem;font-weight:700;color:#374151;margin-bottom:.375rem;">${t}</label>`;

  return `
  <div class="modal-overlay center" onclick="if(event.target===this)W.closeModal()">
    <div class="modal-content" style="max-width:420px;">
      <h2 style="font-size:1.15rem;font-weight:800;color:#1e293b;margin:0 0 1.25rem;">${isEdit ? 'Editar' : 'Novo'} Participante</h2>
      <div style="display:flex;flex-direction:column;gap:.875rem;">
        <div>${lbl('Nome *')}<input id="pt-name" type="text" value="${p.name || ''}" placeholder="Nome completo"
          style="width:100%;border:1.5px solid #e2e8f0;border-radius:.875rem;padding:.875rem;font-size:.9rem;outline:none;"></div>
        <div>${lbl('Clube de origem')}<input id="pt-club" type="text" value="${p.club || ''}" placeholder="Ex: Águias Douradas"
          style="width:100%;border:1.5px solid #e2e8f0;border-radius:.875rem;padding:.875rem;font-size:.9rem;outline:none;"></div>
        <div>${lbl('Região *')}
          <select id="pt-region" onchange="W.setParticipantRegion(this.value)"
            style="width:100%;border:1.5px solid #e2e8f0;border-radius:.875rem;padding:.875rem;font-size:.9rem;outline:none;background:#fff;">
            <option value="" ${!p.regionId ? 'selected' : ''} disabled>Selecione a região...</option>
            ${sortedRegions.map(r => `<option value="${r.id}" ${p.regionId === r.id ? 'selected' : ''}>${r.name}</option>`).join('')}
          </select>
        </div>
        ${region ? `<div style="background:#f8fafc;border-radius:.875rem;padding:.75rem 1rem;font-size:.82rem;color:#64748b;">
          Modalidade: <strong>${region.competitionCategory || 'DBV'}</strong> (derivada da região selecionada)
        </div>` : ''}
        <button onclick="W.saveParticipant()" ${S.loading ? 'disabled' : ''}
          style="width:100%;background:#0D2B6E;color:#fff;border:none;padding:1.1rem;border-radius:1rem;font-size:1rem;font-weight:800;cursor:pointer;opacity:${S.loading ? .6 : 1};">
          ${S.loading ? '⏳ Salvando...' : (isEdit ? '💾 Salvar' : '+ Criar Participante')}
        </button>
      </div>
      <button onclick="W.closeModal()"
        style="width:100%;margin-top:.625rem;padding:.875rem;background:none;border:none;color:#9ca3af;cursor:pointer;">Cancelar</button>
    </div>
  </div>`;
}

// ── MODAL: IMPORTAR PARTICIPANTES (CSV/Excel) ──────────────────
function mParticipantImport() {
  const rows = S.importRows;
  const errors = S.importErrors;
  const hasResults = rows.length > 0 || errors.length > 0;

  return `
  <div class="modal-overlay" onclick="if(event.target===this)W.closeModal()">
    <div class="modal-content">
      <div style="width:2.5rem;height:.25rem;background:#e2e8f0;border-radius:999px;margin:0 auto .875rem;"></div>
      <h2 style="font-size:1.15rem;font-weight:800;color:#1e293b;margin:0 0 .5rem;">📥 Importar Participantes</h2>
      <p style="font-size:.82rem;color:#64748b;margin:0 0 1rem;">
        Arquivo CSV ou Excel com colunas: <strong>Nome, Clube, Região, Modalidade</strong><br>
        <span style="font-size:.75rem;color:#94a3b8;">A região precisa bater com o nome cadastrado — a modalidade é derivada dela automaticamente.</span>
      </p>
      <div class="upload-area" onclick="document.getElementById('import-file').click()" style="margin-bottom:1rem;">
        <div style="font-size:2rem;margin-bottom:.5rem;">📄</div>
        <div style="font-weight:700;color:#374151;">Toque para selecionar o arquivo</div>
        <div style="font-size:.78rem;color:#9ca3af;margin-top:.3rem;">.csv, .xlsx ou .xls</div>
      </div>
      <input type="file" id="import-file" accept=".csv,.xlsx,.xls" onchange="W.handleImportFile(event)">

      ${hasResults ? `
      <div style="display:flex;gap:.5rem;margin-bottom:.75rem;flex-wrap:wrap;">
        <span style="background:#d1fae5;color:#065f46;font-size:.78rem;font-weight:700;padding:.3rem .75rem;border-radius:999px;">✅ ${rows.length} válido${rows.length !== 1 ? 's' : ''}</span>
        ${errors.length ? `<span style="background:#fee2e2;color:#991b1b;font-size:.78rem;font-weight:700;padding:.3rem .75rem;border-radius:999px;">⚠️ ${errors.length} com erro</span>` : ''}
      </div>
      <div style="max-height:220px;overflow-y:auto;border:1px solid #e2e8f0;border-radius:.75rem;margin-bottom:1rem;">
        ${rows.map(r => `<div style="padding:.5rem .75rem;border-bottom:1px solid #f1f5f9;font-size:.82rem;">
          <strong>${r.name}</strong> — ${r.club || '—'} · ${rname(r.regionId)} (${r.competitionCategory})
        </div>`).join('')}
        ${errors.map(e => `<div style="padding:.5rem .75rem;border-bottom:1px solid #f1f5f9;font-size:.82rem;color:#dc2626;">
          ⚠️ Linha ${e.row}: ${e.reason}
        </div>`).join('')}
      </div>
      <button onclick="W.confirmImport()" ${S.loading || rows.length === 0 ? 'disabled' : ''}
        style="width:100%;background:#0D2B6E;color:#fff;border:none;padding:1.1rem;border-radius:1rem;font-size:1rem;font-weight:800;cursor:pointer;opacity:${(S.loading || rows.length === 0) ? .6 : 1};">
        ${S.loading ? '⏳ Importando...' : `+ Importar ${rows.length} participante${rows.length !== 1 ? 's' : ''}`}
      </button>` : ''}

      <button onclick="W.closeModal()"
        style="width:100%;margin-top:.625rem;padding:.875rem;background:none;border:none;color:#9ca3af;cursor:pointer;">Cancelar</button>
    </div>
  </div>`;
}

// ── MODAL: UNIDADE ──────────────────────────────────────────────
function mUnitForm() {
  const u = S.editingUnit || {};
  const isEdit = !!u.id;
  const sortedRegions = [...S.regions].sort((a, b) => a.name.localeCompare(b.name));
  const countIn = rid => S.units.filter(x => x.regionId === rid && x.id !== u.id).length;
  const lbl = t => `<label style="display:block;font-size:.82rem;font-weight:700;color:#374151;margin-bottom:.375rem;">${t}</label>`;

  return `
  <div class="modal-overlay center" onclick="if(event.target===this)W.closeModal()">
    <div class="modal-content" style="max-width:420px;">
      <h2 style="font-size:1.15rem;font-weight:800;color:#1e293b;margin:0 0 1.25rem;">${isEdit ? 'Editar' : 'Nova'} Unidade</h2>
      <div style="display:flex;flex-direction:column;gap:.875rem;">
        <div>${lbl('Nome *')}<input id="un-name" type="text" value="${u.name || ''}" placeholder="Ex: Águias"
          style="width:100%;border:1.5px solid #e2e8f0;border-radius:.875rem;padding:.875rem;font-size:.9rem;outline:none;"></div>
        <div>${lbl('Grito de guerra')}<input id="un-warcry" type="text" value="${u.warCry || ''}" placeholder="Ex: Águias voam alto!"
          style="width:100%;border:1.5px solid #e2e8f0;border-radius:.875rem;padding:.875rem;font-size:.9rem;outline:none;"></div>
        <div>${lbl('Região *')}
          <select id="un-region" ${isEdit ? 'disabled' : ''}
            style="width:100%;border:1.5px solid #e2e8f0;border-radius:.875rem;padding:.875rem;font-size:.9rem;outline:none;background:${isEdit ? '#f8fafc' : '#fff'};">
            <option value="" ${!u.regionId ? 'selected' : ''} disabled>Selecione a região...</option>
            ${sortedRegions.map(r => {
              const count = countIn(r.id);
              const full = count >= 3 && r.id !== u.regionId;
              return `<option value="${r.id}" ${u.regionId === r.id ? 'selected' : ''} ${full ? 'disabled' : ''}>${r.name} (${count}/3)${full ? ' — cheia' : ''}</option>`;
            }).join('')}
          </select>
        </div>
        ${isEdit ? `<div style="font-size:.75rem;color:#94a3b8;">A região de uma unidade não pode ser alterada depois de criada.</div>` : ''}
        <button onclick="W.saveUnit()" ${S.loading ? 'disabled' : ''}
          style="width:100%;background:#0D2B6E;color:#fff;border:none;padding:1.1rem;border-radius:1rem;font-size:1rem;font-weight:800;cursor:pointer;opacity:${S.loading ? .6 : 1};">
          ${S.loading ? '⏳ Salvando...' : (isEdit ? '💾 Salvar' : '+ Criar Unidade')}
        </button>
      </div>
      <button onclick="W.closeModal()"
        style="width:100%;margin-top:.625rem;padding:.875rem;background:none;border:none;color:#9ca3af;cursor:pointer;">Cancelar</button>
    </div>
  </div>`;
}

// ── MODAL: ALOCAR PARTICIPANTES NA UNIDADE ─────────────────────
function mUnitParticipants() {
  const unit = S.units.find(u => u.id === S.editingUnit?.id) || S.editingUnit;
  if (!unit) return '';
  const search = (S.unitParticipantSearch || '').toLowerCase();
  const list = S.participants
    .filter(p => !search || (p.name || '').toLowerCase().includes(search))
    .sort((a, b) => {
      const aIn = a.unitId === unit.id, bIn = b.unitId === unit.id;
      if (aIn !== bIn) return aIn ? -1 : 1;
      return (a.name || '').localeCompare(b.name || '');
    });

  return `
  <div class="modal-overlay" onclick="if(event.target===this)W.closeModal()">
    <div class="modal-content">
      <div style="width:2.5rem;height:.25rem;background:#e2e8f0;border-radius:999px;margin:0 auto .875rem;"></div>
      <h2 style="font-size:1.15rem;font-weight:800;color:#1e293b;margin:0 0 .25rem;">👥 ${unit.name}</h2>
      <p style="font-size:.82rem;color:#64748b;margin:0 0 1rem;">Selecione os participantes desta unidade — participantes de outras regiões podem ser alocados como "clube amigo".</p>
      <input type="text" placeholder="🔎 Buscar participante..." value="${S.unitParticipantSearch || ''}"
        oninput="W.setUnitParticipantSearch(this.value)"
        style="width:100%;border:1.5px solid #e2e8f0;border-radius:.875rem;padding:.75rem;font-size:.9rem;outline:none;margin-bottom:.875rem;">
      <div style="max-height:50vh;overflow-y:auto;display:flex;flex-direction:column;gap:.375rem;">
        ${list.length === 0 ? `<p style="text-align:center;color:#94a3b8;padding:1.5rem;">Nenhum participante encontrado</p>` : list.map(p => {
          const inThis  = p.unitId === unit.id;
          const inOther = !!p.unitId && !inThis;
          const isGuest = p.regionId !== unit.regionId;
          return `
          <label style="display:flex;align-items:center;gap:.75rem;padding:.625rem .75rem;border-radius:.75rem;background:${inThis ? '#f0fdf4' : '#f8fafc'};cursor:pointer;">
            <input type="checkbox" ${inThis ? 'checked' : ''} onchange="W.toggleUnitParticipant('${p.id}', this.checked)" style="width:1.1rem;height:1.1rem;flex-shrink:0;">
            <div style="flex:1;min-width:0;">
              <div style="font-weight:600;color:#1e293b;font-size:.88rem;">${p.name}${isGuest ? ' <span style="color:#92400e;font-size:.75rem;">(clube amigo)</span>' : ''}</div>
              <div style="font-size:.75rem;color:#94a3b8;">${p.club ? `${p.club} · ` : ''}${rname(p.regionId)}${inOther ? ' · já em outra unidade' : ''}</div>
            </div>
          </label>`;
        }).join('')}
      </div>
      <button onclick="W.closeModal()"
        style="width:100%;margin-top:1rem;padding:.875rem;background:#0D2B6E;color:#fff;border:none;border-radius:1rem;font-weight:700;cursor:pointer;">Concluído</button>
    </div>
  </div>`;
}

// ── MODAL: VINCULAR CONSELHEIRO ────────────────────────────────
function mCounselorForm() {
  const unit = S.units.find(u => u.id === S.counselorUnitId);
  const lbl = t => `<label style="display:block;font-size:.82rem;font-weight:700;color:#374151;margin-bottom:.375rem;">${t}</label>`;

  return `
  <div class="modal-overlay center" onclick="if(event.target===this)W.closeModal()">
    <div class="modal-content" style="max-width:400px;">
      <h2 style="font-size:1.15rem;font-weight:800;color:#1e293b;margin:0 0 .25rem;">Vincular Conselheiro</h2>
      <p style="font-size:.82rem;color:#64748b;margin:0 0 1.25rem;">Unidade: <strong>${unit?.name || '—'}</strong></p>
      <div style="display:flex;flex-direction:column;gap:.875rem;">
        <div>${lbl('Nome completo *')}<input id="cn-name" type="text" placeholder="Nome do conselheiro"
          style="width:100%;border:1.5px solid #e2e8f0;border-radius:.875rem;padding:.875rem;font-size:.9rem;outline:none;"></div>
        <div>${lbl('Telefone')}<input id="cn-phone" type="tel" placeholder="(11) 99999-9999"
          style="width:100%;border:1.5px solid #e2e8f0;border-radius:.875rem;padding:.875rem;font-size:.9rem;outline:none;"></div>
        <div style="background:#f8fafc;border-radius:.875rem;padding:.75rem 1rem;font-size:.8rem;color:#64748b;">
          🔑 Login e senha serão gerados automaticamente a partir do nome
        </div>
        <button onclick="W.saveCounselor()" ${S.loading ? 'disabled' : ''}
          style="width:100%;background:#0D2B6E;color:#fff;border:none;padding:1.1rem;border-radius:1rem;font-size:1rem;font-weight:800;cursor:pointer;opacity:${S.loading ? .6 : 1};">
          ${S.loading ? '⏳ Salvando...' : '+ Vincular Conselheiro'}
        </button>
      </div>
      <button onclick="W.closeModal()"
        style="width:100%;margin-top:.625rem;padding:.875rem;background:none;border:none;color:#9ca3af;cursor:pointer;">Cancelar</button>
    </div>
  </div>`;
}

// ── MODAL: CREDENCIAIS GERADAS (região ou usuário) ─────────────
function mCredentialsModal() {
  const { title, username, password } = S.createdCreds || {};
  const row = (label, value, field) => `
    <div>
      <div style="font-size:.72rem;font-weight:700;color:#0D2B6E;">${label}</div>
      <div style="display:flex;align-items:center;justify-content:space-between;gap:.5rem;">
        <span style="font-size:1.05rem;font-weight:800;letter-spacing:${field === 'password' ? '.1rem' : '0'};color:#1e293b;">${value}</span>
        <button onclick="W.copyCred('${field}')"
          style="background:#0D2B6E;border:none;color:#fff;padding:.4rem .7rem;border-radius:.5rem;font-size:.72rem;font-weight:700;cursor:pointer;flex-shrink:0;">📋 Copiar</button>
      </div>
    </div>`;
  return `
  <div class="modal-overlay center" onclick="if(event.target===this)W.closeCredentials()">
    <div class="modal-content" style="max-width:380px;text-align:center;">
      <div style="font-size:2.5rem;margin-bottom:.5rem;">✅</div>
      <h2 style="font-size:1.15rem;font-weight:800;color:#1e293b;margin:0 0 .375rem;">${title || 'Criado com sucesso!'}</h2>
      <p style="font-size:.85rem;color:#64748b;margin:0 0 1.25rem;">Anote as credenciais de acesso:</p>
      <div style="background:#f0fdf4;border:1.5px solid #bbf7d0;border-radius:.875rem;padding:1rem;text-align:left;margin-bottom:1.25rem;display:flex;flex-direction:column;gap:.75rem;">
        ${row('Usuário', username, 'username')}
        ${row('Senha', password, 'password')}
      </div>
      <button onclick="W.closeCredentials()"
        style="width:100%;background:#0D2B6E;color:#fff;border:none;padding:1rem;border-radius:1rem;font-size:.95rem;font-weight:800;cursor:pointer;">Fechar</button>
    </div>
  </div>`;
}

// ── MODAL: TROCAR SENHA ───────────────────────────────────────
function mChangePassword() {
  return `
  <div class="modal-overlay center" onclick="if(event.target===this)W.closeModal()">
    <div class="modal-content" style="max-width:360px;">
      <h2 style="font-size:1.1rem;font-weight:800;color:#1e293b;margin:0 0 1.25rem;">🔑 Trocar Senha</h2>
      <div style="display:flex;flex-direction:column;gap:.875rem;">
        <div>
          <label style="display:block;font-size:.82rem;font-weight:700;color:#374151;margin-bottom:.375rem;">Senha Atual</label>
          <input type="password" id="pwd-current" placeholder="••••••••"
            style="width:100%;border:1.5px solid #e2e8f0;border-radius:.875rem;padding:.875rem;font-size:1rem;outline:none;">
        </div>
        <div>
          <label style="display:block;font-size:.82rem;font-weight:700;color:#374151;margin-bottom:.375rem;">Nova Senha</label>
          <input type="password" id="pwd-new" placeholder="••••••••"
            style="width:100%;border:1.5px solid #e2e8f0;border-radius:.875rem;padding:.875rem;font-size:1rem;outline:none;">
        </div>
        <div>
          <label style="display:block;font-size:.82rem;font-weight:700;color:#374151;margin-bottom:.375rem;">Confirmar Nova Senha</label>
          <input type="password" id="pwd-confirm" placeholder="••••••••"
            style="width:100%;border:1.5px solid #e2e8f0;border-radius:.875rem;padding:.875rem;font-size:1rem;outline:none;"
            onkeydown="if(event.key==='Enter')W.doChangePassword()">
        </div>
        <button onclick="W.doChangePassword()" ${S.loading ? 'disabled' : ''}
          style="width:100%;background:#0D2B6E;color:#fff;border:none;padding:1.1rem;
          border-radius:1rem;font-size:1rem;font-weight:800;cursor:pointer;opacity:${S.loading ? .6 : 1};">
          ${S.loading ? '⏳ Salvando...' : 'Salvar Nova Senha'}
        </button>
      </div>
      <button onclick="W.closeModal()"
        style="width:100%;margin-top:.625rem;padding:.875rem;background:none;border:none;color:#9ca3af;cursor:pointer;">Cancelar</button>
    </div>
  </div>`;
}

// ── ACTIONS ───────────────────────────────────────────────────
window.W = {
  logout() {
    if (_unsubReqs)         _unsubReqs();
    if (_unsubSubs)         _unsubSubs();
    if (_unsubRegions)      _unsubRegions();
    if (_unsubParticipants) _unsubParticipants();
    if (_unsubUnits)        _unsubUnits();
    authLogout();
  },

  setTab(tab)      { S.adminTab = tab; S.sidebarOpen = false; render(); },
  toggleSidebar(open) { S.sidebarOpen = open; render(); },
  closeModal()     { S.modal = null; render(); },
  closeCredentials() { S.modal = null; S.createdCreds = null; render(); },
  copyCred(field) {
    const text = S.createdCreds?.[field];
    if (!text) return;
    navigator.clipboard?.writeText(text)
      .then(() => toast('Copiado! 📋'))
      .catch(() => toast('Não foi possível copiar', 'error'));
  },
  openChangePwd()  { S.modal = 'change-password'; render(); },
  openPhoto(url)   { S.photoUrl = url; S.modal = 'photo'; render(); },
  filterStatus(st) { S.filterStatus = st; render(); },
  exportExcel()    { exportExcel(); },

  approve(id) { apiReview(id, 'approved', '', S.user).then(() => toast('✅ Aprovado!')); },
  reject(id)  {
    const r = prompt('Motivo da rejeição (opcional):') || '';
    apiReview(id, 'rejected', r, S.user).then(() => toast('❌ Rejeitado.', 'error'));
  },
  reopen(id)  {
    if (confirm('Reverter para pendente?'))
      apiReview(id, 'pending', '', S.user).then(() => toast('🔄 Reaberto.', 'info'));
  },

  // ── Requisitos ─────────────────────────────────────────────
  openReqForm(id) {
    S.editingReq = id ? { ...S.requirements.find(r => r.id === id) } : {};
    S.modal = 'req-form'; render();
  },
  addSubItem() {
    const rows = [...document.querySelectorAll('#subitems-list .sub-item-row')];
    const current = rows.map(row => ({
      id: row.dataset.id || `si_${Date.now()}_${Math.random().toString(36).slice(2, 5)}`,
      name: row.querySelector('.si-name').value,
      points: parseInt(row.querySelector('.si-pts').value) || 0
    }));
    current.push({ id: `si_${Date.now()}`, name: '', points: 0 });
    S.editingReq = { ...S.editingReq, subItems: current };
    render();
  },
  removeSubItem(idx) {
    const rows = [...document.querySelectorAll('#subitems-list .sub-item-row')];
    const current = rows.map(row => ({
      id: row.dataset.id || '',
      name: row.querySelector('.si-name').value,
      points: parseInt(row.querySelector('.si-pts').value) || 0
    }));
    current.splice(idx, 1);
    S.editingReq = { ...S.editingReq, subItems: current };
    render();
  },
  async saveReq() {
    const name     = document.getElementById('rq-name')?.value?.trim();
    const code     = document.getElementById('rq-code')?.value?.trim() || name?.toLowerCase().replace(/[^a-z0-9]+/g, '-');
    const desc     = document.getElementById('rq-desc')?.value?.trim();
    const cat      = document.getElementById('rq-cat')?.value;
    const phase    = document.getElementById('rq-phase')?.value;
    const compCat  = document.getElementById('rq-compcat')?.value || 'Ambos';
    const areaAtuacao = document.getElementById('rq-areaatuacao')?.value || '';
    const filledBy = document.getElementById('rq-filledby')?.value || 'regional';
    const activeEl = document.getElementById('rq-active');
    const active   = activeEl ? activeEl.checked : true;
    const rows     = [...document.querySelectorAll('#subitems-list .sub-item-row')];
    const subItems = rows.map((row, i) => ({
      id: row.dataset.id || `si_${i}_${Date.now()}`,
      name: row.querySelector('.si-name').value.trim(),
      points: parseInt(row.querySelector('.si-pts').value) || 0
    })).filter(si => si.name);
    const pts = subItems.length > 0
      ? subItems.reduce((a, si) => a + si.points, 0)
      : parseInt(document.getElementById('rq-pts')?.value) || 0;
    if (!name) { toast('Nome é obrigatório', 'error'); return; }
    if (!pts)  { toast('Pontuação inválida', 'error'); return; }
    S.loading = true; render();
    try {
      await apiSaveReq({
        ...(S.editingReq?.id ? { id: S.editingReq.id } : {}),
        name, code, description: desc || '', category: cat, phase, points: pts,
        competitionCategory: compCat, areaAtuacao, filledBy,
        subItems: subItems.length > 0 ? subItems : null, active
      }, S.requirements.length);
      S.modal = null; S.editingReq = null;
      toast('Requisito salvo! ✅');
    } catch (e) { toast('Erro ao salvar.', 'error'); }
    S.loading = false; render();
  },
  delReq(id) {
    if (!confirm('Excluir este requisito?')) return;
    apiDelReq(id).then(() => toast('Excluído.', 'info'));
  },

  // ── Usuários ───────────────────────────────────────────────
  openUserForm(id) {
    S.editingUser  = id ? S.users.find(u => u.id === id) : null;
    S.formRole     = S.editingUser?.role || null;
    S.generatedPwd = genPassword();
    S.modal = 'user-form'; render();
  },
  setFormRole(role) { S.formRole = role; render(); },
  regenPwd()        { S.generatedPwd = genPassword(); render(); },
  async saveUser() {
    const name     = document.getElementById('u-name')?.value?.trim();
    const phone    = document.getElementById('u-phone')?.value?.trim();
    // Conselheiro não mostra o select de perfil (é fixo) — mantém o role atual do usuário
    const role     = document.getElementById('u-role')?.value || S.editingUser?.role;
    const judgeCat = document.getElementById('u-cat')?.value || null;
    const pwd      = document.getElementById('u-pwd')?.value || S.generatedPwd;
    if (!name || !role) { toast('Nome e perfil são obrigatórios', 'error'); return; }
    S.loading = true; render();
    try {
      if (S.editingUser) {
        await updateUser(S.editingUser.id, {
          name, phone: phone || '', role,
          judgeCategory: judgeCat || null
        }, getToken());
        toast('Usuário atualizado! ✅');
        S.modal = null; S.editingUser = null;
      } else {
        const { username } = await createUser({
          name, phone: phone || '', password: pwd, role,
          judgeCategory: judgeCat || null
        }, getToken());
        S.createdCreds = { title: 'Usuário criado!', username, password: pwd };
        S.modal = 'credentials';
        S.editingUser = null;
      }
      await refreshUsers();
    } catch (e) { toast(e.message, 'error'); }
    S.loading = false; render();
  },
  toggleUser(id, currentlyActive) {
    apiToggleUser(id, currentlyActive, getToken())
      .then(() => { toast(currentlyActive ? 'Usuário desativado' : 'Usuário ativado!'); refreshUsers(); });
  },
  deleteUser(id, name) {
    if (!confirm(`Excluir permanentemente o usuário "${name}"?\n\nEsta ação não pode ser desfeita.`)) return;
    apiDeleteUser(id, getToken()).then(() => { toast('Usuário excluído.', 'info'); refreshUsers(); });
  },
  deleteSubmission(id) {
    if (!confirm('Excluir esta comprovação permanentemente?\n\nEsta ação não pode ser desfeita.')) return;
    apiDeleteSubmission(id).then(() => toast('Comprovação excluída.', 'info'));
  },

  // ── Regiões ────────────────────────────────────────────────
  openRegionForm(id) {
    S.editingRegion = id ? S.regions.find(r => r.id === id) : null;
    // Ao editar, a senha não é mais recuperável (hash) — o campo começa vazio
    // e só é enviada se o admin explicitamente gerar/preencher uma nova.
    S.generatedPwd = id ? '' : genPassword();
    S.modal = 'region-form'; render();
  },
  async saveRegion() {
    const name          = document.getElementById('reg-name')?.value?.trim();
    const responsible   = document.getElementById('reg-responsible')?.value?.trim();
    const phone         = document.getElementById('reg-phone')?.value?.trim();
    const compCat       = document.getElementById('reg-compcat')?.value || 'DBV';
    const pwd           = document.getElementById('reg-pwd')?.value || S.generatedPwd;
    const activeEl      = document.getElementById('reg-active');
    const active        = activeEl ? activeEl.checked : true;
    if (!name) { toast('Nome é obrigatório', 'error'); return; }
    S.loading = true; render();
    try {
      if (S.editingRegion?.id) {
        const linkedUser = S.users.find(u => u.regionId === S.editingRegion.id && u.role === 'region');
        await apiUpdateRegion(S.editingRegion.id, {
          name, responsible: responsible || '', responsiblePhone: phone || '',
          competitionCategory: compCat, active
        }, linkedUser?.id, pwd, getToken());
        toast('Região salva! ✅');
        S.modal = null; S.editingRegion = null;
      } else {
        const { username, password } = await apiCreateRegion({
          name, responsible: responsible || '', responsiblePhone: phone || '',
          competitionCategory: compCat, password: pwd
        }, getToken());
        S.createdCreds = { title: 'Região criada!', username, password };
        S.editingRegion = null;
        S.modal = 'credentials';
      }
      await refreshUsers();
    } catch (e) { toast(e.message || 'Erro ao salvar.', 'error'); }
    S.loading = false; render();
  },
  delRegion(id, name) {
    if (!confirm(`Excluir a região "${name}"?\n\nIsso também excluirá o usuário/login vinculado.\nEsta ação não pode ser desfeita.`)) return;
    const linkedUser = S.users.find(u => u.regionId === id && u.role === 'region');
    apiDelRegion(id, linkedUser?.id, getToken()).then(() => { toast('Região e usuário excluídos.', 'info'); refreshUsers(); });
  },

  // ── Participantes ──────────────────────────────────────────
  setParticipantFilterRegion(v) { S.participantFilterRegion = v; render(); },
  setParticipantFilterCat(v)    { S.participantFilterCat = v; render(); },
  openParticipantForm(id) {
    S.editingParticipant = id ? { ...S.participants.find(p => p.id === id) } : {};
    S.modal = 'participant-form'; render();
  },
  setParticipantRegion(regionId) {
    S.editingParticipant = { ...S.editingParticipant, regionId };
    render();
  },
  async saveParticipant() {
    const name   = document.getElementById('pt-name')?.value?.trim();
    const club   = document.getElementById('pt-club')?.value?.trim();
    const regionId = document.getElementById('pt-region')?.value;
    if (!name || !regionId) { toast('Nome e região são obrigatórios', 'error'); return; }
    const region = S.regions.find(r => r.id === regionId);
    const competitionCategory = region?.competitionCategory || 'DBV';
    S.loading = true; render();
    try {
      if (S.editingParticipant?.id) {
        await updateParticipant(S.editingParticipant.id, { name, club: club || '', regionId, competitionCategory });
        toast('Participante atualizado! ✅');
      } else {
        await createParticipant({ name, club: club || '', regionId, competitionCategory });
        toast('Participante criado! ✅');
      }
      S.modal = null; S.editingParticipant = null;
    } catch (e) { toast(e.message || 'Erro ao salvar.', 'error'); }
    S.loading = false; render();
  },
  deleteParticipant(id, name) {
    if (!confirm(`Excluir permanentemente o participante "${name}"?\n\nEsta ação não pode ser desfeita.`)) return;
    apiDeleteParticipant(id).then(() => toast('Participante excluído.', 'info'));
  },

  openParticipantImport() {
    S.importRows = []; S.importErrors = [];
    S.modal = 'participant-import'; render();
  },
  handleImportFile(evt) {
    const file = evt.target.files[0];
    if (!file) return;
    if (typeof window.XLSX === 'undefined') { toast('Biblioteca XLSX não carregada', 'error'); return; }
    const isCsv = /\.csv$/i.test(file.name);
    const reader = new FileReader();
    reader.onload = e => {
      try {
        // CSV é lido como texto UTF-8 (readAsText); type:'array' em CSV faz o SheetJS
        // tratar os bytes como binário/latin1 e corromper acentuação (ex: "João" → "JoÃ£o")
        const wb = isCsv
          ? window.XLSX.read(e.target.result, { type: 'string' })
          : window.XLSX.read(e.target.result, { type: 'array' });
        const ws = wb.Sheets[wb.SheetNames[0]];
        const rows = window.XLSX.utils.sheet_to_json(ws, { header: 1, defval: '' });
        if (rows.length < 2) { toast('Arquivo vazio ou sem dados', 'error'); return; }

        const headers  = rows[0].map(h => String(h).trim().toLowerCase());
        const idxName   = headers.findIndex(h => h.includes('nome'));
        const idxClub   = headers.findIndex(h => h.includes('clube'));
        const idxRegion = headers.findIndex(h => h.includes('regi'));

        const valid = [];
        const errors = [];
        rows.slice(1).forEach((row, i) => {
          const rowNum = i + 2;
          const name       = idxName   >= 0 ? String(row[idxName]   || '').trim() : '';
          const club       = idxClub   >= 0 ? String(row[idxClub]   || '').trim() : '';
          const regionName = idxRegion >= 0 ? String(row[idxRegion] || '').trim() : '';
          if (!name && !club && !regionName) return; // linha em branco, ignora
          if (!name)       { errors.push({ row: rowNum, reason: 'nome vazio' }); return; }
          if (!regionName) { errors.push({ row: rowNum, reason: `"${name}": região vazia` }); return; }
          const region = S.regions.find(r => r.name.toLowerCase() === regionName.toLowerCase());
          if (!region)     { errors.push({ row: rowNum, reason: `"${name}": região "${regionName}" não encontrada` }); return; }
          valid.push({ name, club, regionId: region.id, competitionCategory: region.competitionCategory || 'DBV' });
        });

        S.importRows = valid;
        S.importErrors = errors;
        render();
      } catch (err) {
        toast('Erro ao ler arquivo: ' + err.message, 'error');
      }
    };
    if (isCsv) reader.readAsText(file, 'UTF-8');
    else reader.readAsArrayBuffer(file);
  },
  async confirmImport() {
    if (S.importRows.length === 0) return;
    S.loading = true; render();
    try {
      const count = await createParticipantsBulk(S.importRows);
      toast(`✅ ${count} participante${count !== 1 ? 's' : ''} importado${count !== 1 ? 's' : ''}!`);
      S.modal = null; S.importRows = []; S.importErrors = [];
    } catch (e) { toast(e.message || 'Erro ao importar.', 'error'); }
    S.loading = false; render();
  },

  // ── Unidades ───────────────────────────────────────────────
  setUnitFilterRegion(v) { S.unitFilterRegion = v; render(); },
  openUnitForm(id) {
    S.editingUnit = id ? { ...S.units.find(u => u.id === id) } : {};
    S.modal = 'unit-form'; render();
  },
  async saveUnit() {
    const name     = document.getElementById('un-name')?.value?.trim();
    const warCry   = document.getElementById('un-warcry')?.value?.trim();
    const regionId = document.getElementById('un-region')?.value;
    if (!name || !regionId) { toast('Nome e região são obrigatórios', 'error'); return; }
    const isEdit = !!S.editingUnit?.id;
    if (!isEdit && S.units.filter(u => u.regionId === regionId).length >= 3) {
      toast('Esta região já tem 3 unidades (limite máximo)', 'error'); return;
    }
    S.loading = true; render();
    try {
      if (isEdit) {
        await updateUnit(S.editingUnit.id, { name, warCry: warCry || '' });
        toast('Unidade atualizada! ✅');
      } else {
        await createUnit({ name, warCry: warCry || '', regionId });
        toast('Unidade criada! ✅');
      }
      S.modal = null; S.editingUnit = null;
    } catch (e) { toast(e.message || 'Erro ao salvar.', 'error'); }
    S.loading = false; render();
  },
  deleteUnit(id, name) {
    if (!confirm(`Excluir a unidade "${name}"?\n\nOs participantes alocados serão desvinculados (não excluídos).\nEsta ação não pode ser desfeita.`)) return;
    const memberIds = S.participants.filter(p => p.unitId === id).map(p => p.id);
    apiDeleteUnit(id, memberIds).then(() => toast('Unidade excluída.', 'info'));
  },
  openUnitParticipants(id) {
    S.editingUnit = S.units.find(u => u.id === id);
    S.unitParticipantSearch = '';
    S.modal = 'unit-participants'; render();
  },
  setUnitParticipantSearch(v) { S.unitParticipantSearch = v; render(); },
  toggleUnitParticipant(participantId, checked) {
    allocateParticipant(participantId, checked ? S.editingUnit.id : null)
      .catch(e => toast(e.message || 'Erro ao alocar participante', 'error'));
  },

  openCounselorForm(unitId) {
    S.counselorUnitId = unitId;
    S.modal = 'counselor-form'; render();
  },
  async saveCounselor() {
    const name  = document.getElementById('cn-name')?.value?.trim();
    const phone = document.getElementById('cn-phone')?.value?.trim();
    if (!name) { toast('Nome é obrigatório', 'error'); return; }
    const unit   = S.units.find(u => u.id === S.counselorUnitId);
    const region = S.regions.find(r => r.id === unit?.regionId);
    S.loading = true; render();
    try {
      const { username, password } = await createUser({
        name, phone: phone || '', role: 'counselor',
        unitId: S.counselorUnitId, regionId: unit?.regionId || null,
        competitionCategory: region?.competitionCategory || 'DBV'
      }, getToken());
      S.createdCreds = { title: 'Conselheiro vinculado!', username, password };
      S.modal = 'credentials';
      await refreshUsers();
    } catch (e) { toast(e.message || 'Erro ao vincular.', 'error'); }
    S.loading = false; render();
  },

  // ── Senha ──────────────────────────────────────────────────
  async doChangePassword() {
    const current = document.getElementById('pwd-current')?.value;
    const newPwd  = document.getElementById('pwd-new')?.value;
    const confirm = document.getElementById('pwd-confirm')?.value;
    if (!current || !newPwd || !confirm) { toast('Preencha todos os campos', 'error'); return; }
    if (newPwd.length < 4)               { toast('Mínimo 4 caracteres', 'error');     return; }
    if (newPwd !== confirm)              { toast('As senhas não coincidem', 'error'); return; }
    S.loading = true; render();
    try {
      await updatePassword(S.user.id, newPwd, getToken(), current);
      saveSession(S.user);
      toast('✅ Senha alterada com sucesso!');
      S.modal = null;
    } catch (e) { toast(e.message || 'Erro ao alterar senha', 'error'); }
    S.loading = false; render();
  },
};
