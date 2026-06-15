import { guardPage, logout as authLogout, saveSession, startExpiryWatcher } from './auth.js';
import {
  subReqs, subSubs, subRegions, setRegionCache,
  rname, fmtDate, toast,
  doFiscalSuggestion, updatePassword, SCORE_PCTS
} from './api.js';

// ── ESTADO ────────────────────────────────────────────────────
const S = {
  user: null,
  requirements: [],
  submissions: [],
  regions: [],
  fiscalRegionId: null,
  fiscalScores: {},   // { reqId: { siId: pct } }
  modal: null,        // 'change-password'
  loading: false,
};

let _unsubReqs = null, _unsubSubs = null, _unsubRegions = null;

// ── HELPERS ───────────────────────────────────────────────────
function isDeadlinePassed(req) {
  if (!req.deadline) return false;
  const d = req.deadline.toDate ? req.deadline.toDate() : new Date(req.deadline);
  return d < new Date();
}
function fmtDeadline(deadline) {
  if (!deadline) return '';
  const d = deadline.toDate ? deadline.toDate() : new Date(deadline);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit', hour: '2-digit', minute: '2-digit' });
}

// ── INIT ──────────────────────────────────────────────────────
export function init() {
  const user = guardPage(['judge']);
  if (!user) return;
  S.user = user;
  startExpiryWatcher();

  _unsubReqs    = subReqs(reqs  => { S.requirements = reqs; render(); });
  _unsubSubs    = subSubs(null, subs => { S.submissions = subs; render(); });
  _unsubRegions = subRegions(regs => { S.regions = regs; setRegionCache(regs); render(); });

  render();
}

// ── RENDER ────────────────────────────────────────────────────
function render() {
  const el = document.getElementById('app');
  if (!el) return;
  let html = S.fiscalRegionId ? vScore() : vSelectRegion();
  if (S.modal === 'change-password') html += mChangePassword();
  el.innerHTML = html;
}

// ── VIEW: SELECIONAR REGIÃO ────────────────────────────────────
function vSelectRegion() {
  const cat = S.user.judgeCategory;

  // Requisitos que este fiscal deve avaliar
  const evalReqs = S.requirements.filter(r =>
    r.active !== false &&
    (!cat || r.category === cat) &&
    (r.evaluatedBy === 'fiscal' || r.evaluatedBy === 'both' || !r.evaluatedBy)
  );
  const totalPossible = evalReqs.reduce((a, r) => a + r.points, 0);

  return `
  <div style="min-height:100dvh;background:#f5f3ff;">
    <div style="background:linear-gradient(135deg,#4c1d95,#7c3aed);color:#fff;padding:1rem 1rem 1.5rem;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.5rem;">
        <span style="font-size:.82rem;color:#ddd6fe;">👤 ${S.user.name}</span>
        <div style="display:flex;gap:.5rem;align-items:center;">
          <button onclick="W.openChangePwd()"
            style="background:rgba(0,0,0,.2);border:none;color:#ddd6fe;
            padding:.375rem .75rem;border-radius:.625rem;font-size:.8rem;cursor:pointer;">🔑</button>
          <button onclick="W.logout()"
            style="background:rgba(0,0,0,.25);border:none;color:#fff;
            padding:.4rem .875rem;border-radius:.625rem;font-size:.8rem;font-weight:700;cursor:pointer;">Sair</button>
        </div>
      </div>
      <h1 style="font-size:1.3rem;font-weight:800;margin:0;">⚖️ Fiscal de Prova</h1>
      <p style="color:#ddd6fe;font-size:.85rem;margin:.25rem 0 0;">
        ${cat ? `Categoria: ${cat}` : 'Selecione a região a avaliar'}
      </p>
    </div>

    <div style="padding:1rem;display:grid;grid-template-columns:1fr 1fr;gap:.625rem;">
      ${S.regions.map(reg => {
        const fiscalSubs = S.submissions.filter(s =>
          s.regionId === reg.id &&
          s.source === 'judge' &&
          (!cat || s.requirementCategory === cat)
        );
        const pts  = fiscalSubs.reduce((a, s) => a + (s.requirementPoints || 0), 0);
        const done = new Set(fiscalSubs.map(s => s.requirementId)).size;
        const pct  = totalPossible > 0 ? Math.round((pts / totalPossible) * 100) : 0;
        return `
        <button onclick="W.selectRegion('${reg.id}')"
          style="padding:1rem;border:1.5px solid #e2e8f0;border-radius:1rem;text-align:left;
          background:#fff;cursor:pointer;box-shadow:0 1px 3px rgba(0,0,0,.06);">
          <div style="font-size:.7rem;color:#94a3b8;margin-bottom:.2rem;">${reg.id}</div>
          <div style="font-weight:700;color:#1e293b;font-size:.9rem;">${reg.name}</div>
          <div style="font-size:.75rem;color:#7c3aed;font-weight:600;margin-top:.375rem;">
            ${pts} / ${totalPossible} pts
          </div>
          ${done > 0
            ? `<div style="font-size:.68rem;color:#94a3b8;">${done} req. avaliado${done !== 1 ? 's' : ''}</div>`
            : ''}
          <div style="background:#e2e8f0;border-radius:999px;height:.3rem;margin-top:.375rem;">
            <div style="background:#7c3aed;border-radius:999px;height:.3rem;width:${pct}%;"></div>
          </div>
        </button>`;
      }).join('')}
    </div>
  </div>`;
}

// ── VIEW: AVALIAR REGIÃO ──────────────────────────────────────
function vScore() {
  const cat = S.user.judgeCategory;
  const reg = S.regions.find(r => r.id === S.fiscalRegionId);

  const reqs = S.requirements.filter(r =>
    r.active !== false &&
    (!cat || r.category === cat) &&
    (r.evaluatedBy === 'fiscal' || r.evaluatedBy === 'both' || !r.evaluatedBy)
  );

  // Sugestões existentes do fiscal para esta região
  const existingMap = {};
  S.submissions
    .filter(s => s.regionId === S.fiscalRegionId && s.source === 'judge')
    .forEach(s => { existingMap[s.requirementId] = s; });

  return `
  <div style="min-height:100dvh;background:#f5f3ff;">
    <div style="background:linear-gradient(135deg,#4c1d95,#7c3aed);color:#fff;padding:1rem 1rem 1.5rem;">
      <div style="display:flex;justify-content:space-between;align-items:flex-start;">
        <div>
          <button onclick="W.selectRegion(null)"
            style="background:none;border:none;color:#ddd6fe;cursor:pointer;
            font-size:.85rem;display:block;margin-bottom:.25rem;padding:0;">← Regiões</button>
          <h1 style="font-size:1.25rem;font-weight:800;margin:0;">⚖️ ${reg?.name || S.fiscalRegionId}</h1>
          <p style="color:#ddd6fe;font-size:.82rem;margin:.25rem 0 0;">
            ${cat ? `Categoria: ${cat}` : 'Fiscal de Prova'}
          </p>
        </div>
        <div style="display:flex;gap:.5rem;align-items:center;padding-top:.25rem;">
          <button onclick="W.openChangePwd()"
            style="background:rgba(0,0,0,.2);border:none;color:#ddd6fe;
            padding:.375rem .75rem;border-radius:.625rem;font-size:.8rem;cursor:pointer;">🔑</button>
          <button onclick="W.logout()"
            style="background:rgba(0,0,0,.25);border:none;color:#fff;
            padding:.4rem .875rem;border-radius:.625rem;font-size:.8rem;font-weight:700;cursor:pointer;">Sair</button>
        </div>
      </div>
    </div>

    <div style="padding:1rem;display:flex;flex-direction:column;gap:.75rem;padding-bottom:5rem;">
      ${reqs.length === 0
        ? `<div style="text-align:center;padding:4rem 1rem;color:#94a3b8;">
            <div style="font-size:3rem;">📋</div>
            <p style="font-weight:600;margin:.5rem 0 0;">Nenhum requisito nesta categoria</p>
           </div>`
        : reqs.map(req => scoreCard(req, existingMap[req.id])).join('')}
    </div>
  </div>`;
}

function scoreCard(req, existing) {
  const hasSubItems    = req.subItems?.length > 0;
  const curScores      = S.fiscalScores[req.id] || {};
  const deadlinePassed = isDeadlinePassed(req);
  const deadlineFmt    = fmtDeadline(req.deadline);
  const borderLeft     = deadlinePassed ? '4px solid #ef4444' : existing ? '4px solid #7c3aed' : 'none';

  const statusBadge = existing
    ? existing.status === 'approved'
      ? `<span class="badge-approved">✅ Aprovado: ${existing.requirementPoints} pts</span>`
      : `<span class="badge-fiscal">⚖️ Sugestão: ${existing.requirementPoints} pts — aguardando</span>`
    : '';

  if (hasSubItems) {
    let calcTotal = 0;
    const rows = req.subItems.map(si => {
      const selPct = curScores[si.id] !== undefined
        ? curScores[si.id]
        : (existing?.subItemPcts?.[si.id] !== undefined ? existing.subItemPcts[si.id] : null);
      const earned = selPct !== null ? Math.round(si.points * selPct / 100) : 0;
      if (selPct !== null) calcTotal += earned;
      return `
      <div style="background:#f8fafc;border-radius:.75rem;padding:.75rem;margin-bottom:.5rem;">
        <div style="font-size:.85rem;font-weight:600;color:#1e293b;margin-bottom:.375rem;">
          ${si.name} <span style="color:#7c3aed;font-weight:700;">(máx ${si.points} pts)</span>
        </div>
        <div style="display:flex;gap:.375rem;flex-wrap:wrap;">
          ${SCORE_PCTS.map(pct => `
          <button class="pct-btn ${selPct === pct ? 'sel' : ''}"
            onclick="W.selectSubPct('${req.id}','${si.id}',${pct})">
            ${pct}%${pct > 0 ? ` · ${Math.round(si.points * pct / 100)}pts` : ''}
          </button>`).join('')}
        </div>
        ${selPct !== null
          ? `<div style="font-size:.75rem;color:#7c3aed;font-weight:700;margin-top:.375rem;">→ ${earned} pts atribuídos</div>`
          : ''}
      </div>`;
    });

    return `
    <div style="background:#fff;border-radius:1rem;border:1px solid ${deadlinePassed ? '#fca5a5' : existing ? '#a78bfa' : '#e2e8f0'};
      border-left:${borderLeft};padding:1rem;box-shadow:0 1px 3px rgba(0,0,0,.06);">
      <div style="display:flex;flex-wrap:wrap;gap:.375rem;margin-bottom:.5rem;">
        <span style="background:#ede9fe;color:#6d28d9;font-size:.7rem;font-weight:700;padding:.2rem .6rem;border-radius:999px;">${req.points} pts máx</span>
        ${statusBadge}
        ${deadlinePassed
          ? `<span style="background:#fee2e2;color:#991b1b;font-size:.7rem;font-weight:700;padding:.2rem .6rem;border-radius:999px;">🔒 Prazo encerrado</span>`
          : deadlineFmt
            ? `<span style="background:#fef3c7;color:#92400e;font-size:.7rem;font-weight:600;padding:.2rem .6rem;border-radius:999px;">📅 ${deadlineFmt}</span>`
            : ''}
      </div>
      <div style="font-weight:700;color:#1e293b;font-size:.95rem;margin-bottom:.75rem;">${req.name}</div>
      ${req.description ? `<div style="font-size:.8rem;color:#64748b;margin-bottom:.75rem;">${req.description}</div>` : ''}
      ${rows.join('')}
      <div style="display:flex;align-items:center;justify-content:space-between;gap:.75rem;margin-top:.25rem;">
        <div style="font-size:.9rem;font-weight:700;color:#1e293b;">
          Total: <span style="color:#7c3aed;">${calcTotal} / ${req.points} pts</span>
        </div>
        ${deadlinePassed
          ? `<span style="font-size:.85rem;color:#dc2626;font-weight:700;">🔒 Encerrado</span>`
          : `<button onclick="W.submitSubItems('${req.id}')" ${S.loading ? 'disabled' : ''}
              style="background:#7c3aed;color:#fff;border:none;padding:.625rem 1.25rem;
              border-radius:.75rem;font-size:.9rem;font-weight:700;cursor:pointer;opacity:${S.loading ? .6 : 1};">
              ${existing ? '🔄 Atualizar' : '✅ Confirmar'}
            </button>`}
      </div>
    </div>`;
  }

  // Sem sub-itens: entrada numérica
  return `
  <div style="background:#fff;border-radius:1rem;border:1px solid ${deadlinePassed ? '#fca5a5' : existing ? '#a78bfa' : '#e2e8f0'};
    border-left:${borderLeft};padding:1rem;box-shadow:0 1px 3px rgba(0,0,0,.06);">
    <div style="display:flex;flex-wrap:wrap;gap:.375rem;margin-bottom:.5rem;">
      <span style="background:#ede9fe;color:#6d28d9;font-size:.7rem;font-weight:700;padding:.2rem .6rem;border-radius:999px;">${req.points} pts máx</span>
      ${statusBadge}
      ${deadlinePassed
        ? `<span style="background:#fee2e2;color:#991b1b;font-size:.7rem;font-weight:700;padding:.2rem .6rem;border-radius:999px;">🔒 Prazo encerrado</span>`
        : deadlineFmt
          ? `<span style="background:#fef3c7;color:#92400e;font-size:.7rem;font-weight:600;padding:.2rem .6rem;border-radius:999px;">📅 ${deadlineFmt}</span>`
          : ''}
    </div>
    <div style="font-weight:700;color:#1e293b;font-size:.95rem;margin-bottom:.5rem;">${req.name}</div>
    ${req.description ? `<div style="font-size:.8rem;color:#64748b;margin-bottom:.75rem;">${req.description}</div>` : ''}
    <div style="display:flex;gap:.5rem;align-items:center;flex-wrap:wrap;">
      <input type="number" id="pts-${req.id}"
        value="${existing?.requirementPoints ?? ''}" min="0" max="${req.points}" placeholder="0"
        ${deadlinePassed ? 'readonly' : ''}
        style="width:80px;border:1.5px solid ${deadlinePassed ? '#fca5a5' : '#e2e8f0'};border-radius:.625rem;padding:.5rem;
        font-size:1rem;text-align:center;outline:none;font-weight:700;${deadlinePassed ? 'background:#fff1f1;' : ''}">
      <span style="font-size:.85rem;color:#64748b;">/ ${req.points} pts</span>
      ${deadlinePassed
        ? `<span style="flex:1;min-width:120px;text-align:center;font-size:.85rem;color:#dc2626;font-weight:700;">🔒 Encerrado</span>`
        : `<button onclick="W.submitScore('${req.id}')" ${S.loading ? 'disabled' : ''}
            style="flex:1;min-width:120px;background:#7c3aed;color:#fff;border:none;
            padding:.625rem 1rem;border-radius:.75rem;font-size:.9rem;font-weight:700;cursor:pointer;
            opacity:${S.loading ? .6 : 1};">
            ${existing ? '🔄 Atualizar' : '✅ Confirmar'}
          </button>`}
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
          style="width:100%;background:#7c3aed;color:#fff;border:none;padding:1.1rem;
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
    if (_unsubReqs)    _unsubReqs();
    if (_unsubSubs)    _unsubSubs();
    if (_unsubRegions) _unsubRegions();
    authLogout();
  },

  closeModal()   { S.modal = null; render(); },
  openChangePwd(){ S.modal = 'change-password'; render(); },

  selectRegion(id) {
    S.fiscalRegionId = id;
    S.fiscalScores   = {};
    render();
  },

  selectSubPct(reqId, siId, pct) {
    if (!S.fiscalScores[reqId]) S.fiscalScores[reqId] = {};
    S.fiscalScores[reqId][siId] = pct;
    render();
  },

  async submitSubItems(reqId) {
    const req = S.requirements.find(r => r.id === reqId);
    if (!req) return;
    if (isDeadlinePassed(req)) { toast('Prazo para este requisito foi encerrado', 'error'); return; }
    const existing = S.submissions.find(s =>
      s.regionId === S.fiscalRegionId && s.requirementId === reqId && s.source === 'judge'
    );
    const subItems  = req.subItems || [];
    const curScores = S.fiscalScores[reqId] || {};
    const subItemScores = {};
    const subItemPcts   = {};
    let total  = 0;
    let allSet = true;

    for (const si of subItems) {
      const pct = curScores[si.id] !== undefined
        ? curScores[si.id]
        : (existing?.subItemPcts?.[si.id] !== undefined ? existing.subItemPcts[si.id] : undefined);
      if (pct === undefined) { allSet = false; break; }
      const pts = Math.round(si.points * pct / 100);
      subItemScores[si.id] = pts;
      subItemPcts[si.id]   = pct;
      total += pts;
    }

    if (!allSet) { toast('Avalie todos os sub-itens antes de confirmar', 'error'); return; }

    S.loading = true; render();
    try {
      await doFiscalSuggestion(req, S.fiscalRegionId, total, subItemScores, subItemPcts, S.user, existing?.id || null);
      delete S.fiscalScores[reqId];
    } catch (e) {
      toast('Erro ao salvar. Tente novamente.', 'error');
    }
    S.loading = false; render();
  },

  async submitScore(reqId) {
    const req = S.requirements.find(r => r.id === reqId);
    if (!req) return;
    if (isDeadlinePassed(req)) { toast('Prazo para este requisito foi encerrado', 'error'); return; }
    const existing = S.submissions.find(s =>
      s.regionId === S.fiscalRegionId && s.requirementId === reqId && s.source === 'judge'
    );
    const pts = parseInt(document.getElementById(`pts-${reqId}`)?.value) || 0;
    if (pts < 0 || pts > req.points) { toast(`Valor entre 0 e ${req.points}`, 'error'); return; }

    S.loading = true; render();
    try {
      await doFiscalSuggestion(req, S.fiscalRegionId, pts, null, null, S.user, existing?.id || null);
    } catch (e) {
      toast('Erro ao salvar. Tente novamente.', 'error');
    }
    S.loading = false; render();
  },

  async doChangePassword() {
    const current = document.getElementById('pwd-current')?.value;
    const newPwd  = document.getElementById('pwd-new')?.value;
    const confirm = document.getElementById('pwd-confirm')?.value;

    if (!current || !newPwd || !confirm) { toast('Preencha todos os campos', 'error'); return; }
    if (S.user.password !== current)     { toast('Senha atual incorreta', 'error');   return; }
    if (newPwd.length < 4)               { toast('Mínimo 4 caracteres', 'error');     return; }
    if (newPwd !== confirm)              { toast('As senhas não coincidem', 'error'); return; }

    S.loading = true; render();
    try {
      await updatePassword(S.user.id, newPwd);
      S.user = { ...S.user, password: newPwd };
      saveSession(S.user);
      toast('✅ Senha alterada com sucesso!');
      S.modal = null;
    } catch (e) {
      toast('Erro ao alterar senha', 'error');
    }
    S.loading = false; render();
  },
};
