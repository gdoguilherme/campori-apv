import { guardPage, logout as authLogout, saveSession, getToken, startExpiryWatcher } from './auth.js';
import {
  subReqs, subSubs, subRegions, setRegionCache, rname, fmtDate, toast, showBanner,
  addSubmission, uploadFile, updateSubmissionProof, updatePassword,
  CATEGORIES
} from './api.js';

// ── CONFIGURAÇÃO POR TEMA ──────────────────────────────────────
const THEMES = {
  dbv: {
    logo: '/assets/logo-dbv.png',
    label: 'Desbravadores',
    primary: '#1B2A6B',
    primary2: '#2D3E99',
    muted: 'rgba(255,255,255,.65)',
    css: '/css/dbv.css',
  },
  avt: {
    logo: '/assets/logo-avt.png',
    label: 'Aventureiros',
    primary: '#1E3A8A',
    primary2: '#2563EB',
    muted: 'rgba(255,255,255,.65)',
    css: '/css/avt.css',
  },
};

// ── ESTADO ────────────────────────────────────────────────────
const S = {
  user: null,
  theme: 'dbv',
  requirements: [],
  submissions: [],
  filterCat: 'Todos',
  selectedReq: null,
  photoFile: null,
  photoUrl: null,
  modal: null,   // 'submit' | 'photo' | 'change-password'
  loading: false,
};

let _unsubReqs = null, _unsubSubs = null, _unsubRegions = null;

// ── INIT ──────────────────────────────────────────────────────
export function init(theme) {
  S.theme = theme;

  const user = guardPage(['region']);
  if (!user) return;

  // Garante que o usuário está na página correta para sua modalidade
  const expected = user.competitionCategory === 'AVT' ? 'avt' : 'dbv';
  if (expected !== theme) {
    location.replace(expected === 'avt' ? '/pages/regiao/avt.html' : '/pages/regiao/dbv.html');
    return;
  }

  S.user = user;
  startExpiryWatcher();

  _unsubReqs    = subReqs(reqs => { S.requirements = reqs; render(); });
  _unsubSubs    = subSubs(user.regionId, subs => { S.submissions = subs; render(); });
  _unsubRegions = subRegions(regs => { setRegionCache(regs); render(); });

  render();
}

// ── HELPERS ───────────────────────────────────────────────────
function isDeadlinePassed(req) {
  if (!req.deadline) return false;
  const d = req.deadline.toDate ? req.deadline.toDate() : new Date(req.deadline);
  return Date.now() > d.getTime();
}

function fmtDeadline(ts) {
  if (!ts) return null;
  const d = ts.toDate ? ts.toDate() : new Date(ts);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

function canRegionSubmit(req) {
  const ev = req.evaluatedBy || 'both';
  return ev === 'region' || ev === 'both';
}

// ── RENDER ────────────────────────────────────────────────────
function render() {
  const el = document.getElementById('app');
  if (!el) return;
  let html = vPortal();
  if (S.modal === 'submit')          html += mSubmit();
  else if (S.modal === 'photo')      html += mPhoto();
  else if (S.modal === 'change-password') html += mChangePassword();
  el.innerHTML = html;
}

// ── VIEW: PORTAL ──────────────────────────────────────────────
function vPortal() {
  const { user, theme } = S;
  const tc = THEMES[theme];
  const rid = user.regionId;

  // Última submission por requisito (qualquer source)
  const subByReq = {};
  S.submissions.forEach(s => {
    const cur = subByReq[s.requirementId];
    if (!cur || (s.submittedAt?.seconds || 0) > (cur.submittedAt?.seconds || 0))
      subByReq[s.requirementId] = s;
  });

  const approvedPts = S.submissions
    .filter(s => s.status === 'approved')
    .reduce((a, s) => a + (s.requirementPoints || 0), 0);
  const pendingPts = S.submissions
    .filter(s => s.status === 'pending')
    .reduce((a, s) => a + (s.requirementPoints || 0), 0);

  const userCompCat = user.competitionCategory || null;
  const visibleReqs = S.requirements.filter(r =>
    r.active !== false &&
    (!userCompCat || !r.competitionCategory || r.competitionCategory === 'Ambos' || r.competitionCategory === userCompCat)
  );
  const totalPossible = visibleReqs.reduce((a, r) => a + r.points, 0);

  const cats = ['Todos', ...new Set(visibleReqs.map(r => r.category))];
  const list = S.filterCat === 'Todos' ? visibleReqs : visibleReqs.filter(r => r.category === S.filterCat);

  return `
  <div style="min-height:100dvh;background:#f0f4f8;">

    <!-- CABEÇALHO -->
    <div style="background:linear-gradient(135deg,${tc.primary},${tc.primary2});color:#fff;padding:1rem 1rem 1.5rem;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.875rem;">
        <div style="display:flex;align-items:center;gap:.625rem;">
          <img src="${tc.logo}" style="height:2.25rem;width:auto;object-fit:contain;" alt="${tc.label}">
          <span style="font-size:.8rem;color:${tc.muted};">👤 ${user.name}</span>
        </div>
        <div style="display:flex;gap:.5rem;align-items:center;">
          <button onclick="W.openChangePwd()"
            style="background:rgba(0,0,0,.2);border:none;color:rgba(255,255,255,.8);
            padding:.375rem .7rem;border-radius:.625rem;font-size:.8rem;cursor:pointer;">🔑</button>
          <button onclick="W.logout()"
            style="background:rgba(0,0,0,.25);border:none;color:#fff;
            padding:.4rem .875rem;border-radius:.625rem;font-size:.8rem;font-weight:700;cursor:pointer;">Sair</button>
        </div>
      </div>

      <h1 style="font-size:1.3rem;font-weight:800;margin:0 0 .2rem;">${rname(rid)}</h1>
      <div style="display:flex;align-items:center;gap:.5rem;margin-bottom:1rem;">
        <p style="color:${tc.muted};font-size:.8rem;margin:0;">Portal de Comprovações</p>
        ${userCompCat ? `<span style="background:rgba(255,255,255,.2);color:#fff;font-size:.72rem;font-weight:700;padding:.15rem .5rem;border-radius:999px;">${userCompCat}</span>` : ''}
      </div>

      <div style="display:flex;gap:.625rem;">
        <div style="background:rgba(255,255,255,.18);border-radius:.875rem;padding:.75rem 1rem;text-align:center;flex:1;">
          <div style="font-size:1.5rem;font-weight:800;">${approvedPts}</div>
          <div style="font-size:.68rem;color:${tc.muted};">pts aprovados</div>
        </div>
        <div style="background:rgba(255,255,255,.18);border-radius:.875rem;padding:.75rem 1rem;text-align:center;flex:1;">
          <div style="font-size:1.5rem;font-weight:800;color:#fde68a;">${pendingPts}</div>
          <div style="font-size:.68rem;color:${tc.muted};">pts pendentes</div>
        </div>
        <div style="background:rgba(255,255,255,.18);border-radius:.875rem;padding:.75rem 1rem;text-align:center;flex:1;">
          <div style="font-size:1.5rem;font-weight:800;color:#bbf7d0;">${totalPossible}</div>
          <div style="font-size:.68rem;color:${tc.muted};">pts possíveis</div>
        </div>
      </div>
    </div>

    <!-- FILTRO CATEGORIA -->
    <div style="background:#fff;border-bottom:1px solid #f1f5f9;padding:.625rem 1rem;display:flex;gap:.5rem;overflow-x:auto;scrollbar-width:none;">
      ${cats.map(c => `
      <button onclick="W.filterCat('${c}')"
        style="white-space:nowrap;padding:.375rem .875rem;border-radius:999px;border:none;
        font-size:.8rem;font-weight:600;cursor:pointer;flex-shrink:0;
        background:${S.filterCat === c ? tc.primary : '#f1f5f9'};
        color:${S.filterCat === c ? '#fff' : '#64748b'};">
        ${c}
      </button>`).join('')}
    </div>

    <!-- LISTA DE REQUISITOS -->
    <div style="padding:1rem;display:flex;flex-direction:column;gap:.75rem;padding-bottom:5rem;">
      ${list.length === 0
        ? `<div style="text-align:center;padding:4rem 1rem;color:#94a3b8;">
            <div style="font-size:3rem;">📋</div>
            <p style="font-weight:600;margin:.5rem 0 0;">Nenhum requisito</p>
           </div>`
        : list.map(req => reqCard(req, subByReq[req.id], tc)).join('')}
    </div>
  </div>`;
}

function reqCard(req, sub, tc) {
  const isApproved = sub?.status === 'approved';
  const isPending  = sub?.status === 'pending';
  const isRejected = sub?.status === 'rejected';
  const isFiscalSuggestion = sub?.fiscalSuggestion === true;
  const fiscalOnly = (req.evaluatedBy || 'both') === 'fiscal';
  const canSend    = canRegionSubmit(req);
  const deadlinePassed = isDeadlinePassed(req);
  const deadlineFmt    = fmtDeadline(req.deadline);

  const bl = isApproved ? '4px solid #16a34a'
           : isPending  ? '4px solid #f59e0b'
           : isRejected ? '4px solid #ef4444'
           : 'none';

  return `
  <div style="background:#fff;border-radius:1rem;border:1px solid #e2e8f0;border-left:${bl};
    padding:1rem;box-shadow:0 1px 3px rgba(0,0,0,.06);">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:.75rem;">
      <div style="flex:1;min-width:0;">

        <!-- Badges -->
        <div style="display:flex;flex-wrap:wrap;gap:.375rem;margin-bottom:.5rem;">
          <span style="background:#f1f5f9;color:#475569;font-size:.7rem;font-weight:600;padding:.2rem .6rem;border-radius:999px;">${req.category}</span>
          <span style="background:#dbeafe;color:#1d4ed8;font-size:.7rem;font-weight:700;padding:.2rem .6rem;border-radius:999px;">${req.points} pts</span>
          ${req.phase ? `<span style="background:#f0fdf4;color:#166534;font-size:.7rem;font-weight:600;padding:.2rem .6rem;border-radius:999px;">${req.phase}</span>` : ''}
          ${req.competitionCategory && req.competitionCategory !== 'Ambos'
            ? `<span style="background:#fef3c7;color:#92400e;font-size:.7rem;font-weight:700;padding:.2rem .6rem;border-radius:999px;">${req.competitionCategory}</span>` : ''}
          ${fiscalOnly ? `<span class="badge-fiscal">⚖️ Só Fiscal</span>` : ''}
          ${deadlineFmt && !deadlinePassed
            ? `<span style="background:#fef3c7;color:#92400e;font-size:.7rem;font-weight:600;padding:.2rem .6rem;border-radius:999px;">📅 ${deadlineFmt}</span>` : ''}
          ${deadlinePassed
            ? `<span style="background:#fee2e2;color:#991b1b;font-size:.7rem;font-weight:700;padding:.2rem .6rem;border-radius:999px;">🔒 Prazo encerrado</span>` : ''}
        </div>

        <!-- Nome -->
        <div style="font-weight:700;color:#1e293b;font-size:.95rem;">${req.name}</div>
        ${req.description ? `<div style="font-size:.8rem;color:#64748b;margin-top:.2rem;">${req.description}</div>` : ''}
        ${req.subItems?.length ? `<div style="font-size:.78rem;color:#7c3aed;margin-top:.25rem;">📊 ${req.subItems.length} sub-iten${req.subItems.length !== 1 ? 's' : ''} avaliados pelo Fiscal</div>` : ''}

        <!-- Status -->
        ${sub ? `<div style="margin-top:.625rem;">
          ${isApproved
            ? `<span style="background:#d1fae5;color:#065f46;font-size:.8rem;font-weight:700;padding:.3rem .8rem;border-radius:999px;display:inline-block;">✅ Aprovado · ${sub.requirementPoints} pts</span>`
            : isPending && isFiscalSuggestion
            ? `<span style="background:#ede9fe;color:#5b21b6;font-size:.8rem;font-weight:700;padding:.3rem .8rem;border-radius:999px;display:inline-block;">⚖️ Avaliado pelo Fiscal — aguardando aprovação</span>`
            : isPending
            ? `<span style="background:#fef3c7;color:#92400e;font-size:.8rem;font-weight:700;padding:.3rem .8rem;border-radius:999px;display:inline-block;">⏳ Aguardando aprovação</span>`
            : `<span style="background:#fee2e2;color:#991b1b;font-size:.8rem;font-weight:700;padding:.3rem .8rem;border-radius:999px;display:inline-block;">❌ Recusado</span>`}
          ${isRejected && sub.rejectionReason
            ? `<div style="font-size:.8rem;color:#b91c1c;background:#fff1f1;border-radius:.5rem;padding:.4rem .75rem;margin-top:.375rem;"><strong>Motivo:</strong> ${sub.rejectionReason}</div>` : ''}
        </div>`
        : `<div style="margin-top:.5rem;font-size:.8rem;color:#94a3b8;">Não enviado</div>`}
      </div>

      <!-- Botão de ação -->
      <div style="flex-shrink:0;padding-top:.25rem;">
        ${isApproved  ? `<span style="font-size:1.75rem;">✅</span>`
        : isPending   ? `<span style="font-size:1.75rem;">⏳</span>`
        : fiscalOnly  ? `<span style="font-size:1.5rem;color:#7c3aed;">⚖️</span>`
        : deadlinePassed ? `<span style="font-size:1.5rem;">🔒</span>`
        : canSend     ? `<button onclick="W.openSubmit('${req.id}')"
            style="background:${tc.primary};color:#fff;border:none;padding:.5rem 1rem;
            border-radius:.75rem;font-size:.85rem;font-weight:700;cursor:pointer;">Enviar</button>`
        : ''}
      </div>
    </div>

    <!-- Botão de reenvio (se rejeitado) -->
    ${isRejected && canSend && !deadlinePassed ? `
    <button onclick="W.openSubmit('${req.id}')"
      style="width:100%;margin-top:.75rem;padding:.75rem;background:#eff6ff;border:1.5px solid #bfdbfe;
      border-radius:.75rem;color:#1d4ed8;font-size:.875rem;font-weight:700;cursor:pointer;">
      🔄 Reenviar comprovação
    </button>` : ''}

    ${isPending && !isFiscalSuggestion ? `
    <div style="margin-top:.625rem;font-size:.78rem;color:#92400e;background:#fef9c3;
      border-radius:.5rem;padding:.4rem .75rem;text-align:center;">
      Aguardando revisão do administrador
    </div>` : ''}
  </div>`;
}

// ── MODAL: ENVIAR COMPROVAÇÃO ─────────────────────────────────
function mSubmit() {
  const req = S.requirements.find(r => r.id === S.selectedReq);
  if (!req) return '';
  const tc = THEMES[S.theme];

  return `
  <div class="modal-overlay" onclick="if(event.target===this)W.closeModal()">
    <div class="modal-content">
      <div style="width:2.5rem;height:.25rem;background:#e2e8f0;border-radius:999px;margin:0 auto .875rem;"></div>

      <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:.5rem;">
        <span style="background:#f1f5f9;color:#475569;font-size:.75rem;font-weight:600;padding:.25rem .75rem;border-radius:999px;">${req.category}</span>
        <span style="background:#dbeafe;color:#1d4ed8;font-size:.75rem;font-weight:700;padding:.25rem .75rem;border-radius:999px;">${req.points} pontos</span>
        ${req.phase ? `<span style="background:#f0fdf4;color:#166534;font-size:.75rem;font-weight:600;padding:.25rem .75rem;border-radius:999px;">${req.phase}</span>` : ''}
      </div>

      <h2 style="font-size:1.15rem;font-weight:800;color:#1e293b;margin:.25rem 0 .5rem;">${req.name}</h2>
      ${req.description ? `<p style="font-size:.85rem;color:#64748b;margin-bottom:1rem;">${req.description}</p>` : ''}

      ${req.subItems?.length ? `
      <div style="background:#f5f3ff;border-radius:.75rem;padding:.75rem;margin-bottom:1rem;">
        <div style="font-size:.82rem;font-weight:700;color:#5b21b6;margin-bottom:.375rem;">📊 Sub-itens avaliados pelo Fiscal de Prova</div>
        <div style="font-size:.8rem;color:#6d28d9;">${req.subItems.map(si => `• ${si.name} (${si.points} pts)`).join('<br>')}</div>
      </div>` : ''}

      <!-- Upload -->
      <div style="margin-bottom:1rem;">
        <label style="display:block;font-size:.85rem;font-weight:700;color:#374151;margin-bottom:.5rem;">📎 Comprovação</label>
        <div class="upload-area ${S.photoFile ? 'filled' : ''}" onclick="document.getElementById('file-inp').click()">
          ${S.photoFile
            ? `<div style="color:#16a34a;font-weight:700;font-size:.95rem;">✅ ${S.photoFile.name}</div>
               <div style="font-size:.75rem;color:#6b7280;margin-top:.3rem;">Toque para trocar</div>`
            : `<div style="font-size:2.75rem;margin-bottom:.5rem;">📷</div>
               <div style="font-weight:700;color:#374151;font-size:1rem;">Toque para selecionar</div>
               <div style="font-size:.78rem;color:#9ca3af;margin-top:.3rem;">Foto ou PDF · máx 10 MB</div>`}
        </div>
        <input type="file" id="file-inp" accept="image/*,application/pdf" capture="environment" onchange="W.handleFile(event)">
      </div>

      <!-- Observações -->
      <div style="margin-bottom:1.25rem;">
        <label style="display:block;font-size:.85rem;font-weight:700;color:#374151;margin-bottom:.5rem;">
          💬 Observações <span style="font-weight:400;color:#94a3b8;">(opcional)</span>
        </label>
        <textarea id="sub-notes" rows="2" placeholder="Informações adicionais..."
          style="width:100%;border:1.5px solid #e2e8f0;border-radius:.875rem;padding:.75rem;
          font-size:.9rem;resize:none;outline:none;font-family:inherit;"></textarea>
      </div>

      <button onclick="W.doSubmit()" ${S.loading ? 'disabled' : ''}
        style="width:100%;background:${tc.primary};color:#fff;border:none;padding:1.1rem;
        border-radius:1rem;font-size:1rem;font-weight:800;cursor:pointer;opacity:${S.loading ? .6 : 1};">
        ${S.loading ? '⏳ Enviando...' : '✅ Enviar Comprovação'}
      </button>
      <button onclick="W.closeModal()"
        style="width:100%;margin-top:.625rem;padding:.875rem;background:none;border:none;color:#9ca3af;cursor:pointer;">
        Cancelar
      </button>
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

// ── MODAL: TROCAR SENHA ───────────────────────────────────────
function mChangePassword() {
  const tc = THEMES[S.theme];
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
          style="width:100%;background:${tc.primary};color:#fff;border:none;padding:1.1rem;
          border-radius:1rem;font-size:1rem;font-weight:800;cursor:pointer;opacity:${S.loading ? .6 : 1};">
          ${S.loading ? '⏳ Salvando...' : 'Salvar Nova Senha'}
        </button>
      </div>
      <button onclick="W.closeModal()"
        style="width:100%;margin-top:.625rem;padding:.875rem;background:none;border:none;color:#9ca3af;cursor:pointer;">
        Cancelar
      </button>
    </div>
  </div>`;
}

// ── ACTIONS ───────────────────────────────────────────────────
window.W = {
  logout() {
    if (_unsubReqs) _unsubReqs();
    if (_unsubSubs) _unsubSubs();
    if (_unsubRegions) _unsubRegions();
    authLogout();
  },

  filterCat(cat) { S.filterCat = cat; render(); },
  closeModal()   { S.modal = null; render(); },
  openPhoto(url) { S.photoUrl = url; S.modal = 'photo'; render(); },
  openChangePwd(){ S.modal = 'change-password'; render(); },

  openSubmit(reqId) {
    S.selectedReq = reqId;
    S.photoFile   = null;
    S.modal       = 'submit';
    render();
  },

  handleFile(evt) {
    const f = evt.target.files[0] || null;
    if (f && f.size > 10_485_760) {
      toast('⚠️ Arquivo muito grande! Máximo 10 MB.', 'error');
      evt.target.value = '';
      S.photoFile = null;
    } else {
      S.photoFile = f;
    }
    render();
  },

  async doSubmit() {
    const req = S.requirements.find(r => r.id === S.selectedReq);
    if (!req) return;

    if (isDeadlinePassed(req)) {
      toast('Prazo para este requisito foi encerrado', 'error');
      return;
    }

    const notes = document.getElementById('sub-notes')?.value || '';
    S.loading = true; render();

    try {
      const subId = await addSubmission(S.user, req, notes, null);
      const fileToUpload = S.photoFile;
      S.modal = null; S.selectedReq = null; S.photoFile = null; S.loading = false;
      render();
      showBanner('✅ Requisito registrado! Aguardando aprovação.');

      if (fileToUpload) {
        try {
          const file = fileToUpload;
          const url = await uploadFile(file, S.user.regionId, req.code || req.id);
          await updateSubmissionProof(subId, url);
          toast('📎 Arquivo enviado com sucesso!');
        } catch (e) {
          toast(`⚠️ Falha no upload: ${e.message}`, 'error');
        }
      }
    } catch (e) {
      toast('Erro ao enviar. Tente novamente.', 'error');
      S.loading = false; render();
    }
  },

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
    } catch (e) {
      toast(e.message || 'Erro ao alterar senha', 'error');
    }
    S.loading = false; render();
  },
};
