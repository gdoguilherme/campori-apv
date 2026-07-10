import { guardPage, logout as authLogout, saveSession, getToken, startExpiryWatcher } from './auth.js';
import {
  subUnitById, subParticipantsByUnit, subRegions, setRegionCache,
  rname, toast, updatePassword
} from './api.js';

// ── CONFIGURAÇÃO POR MODALIDADE (herdada da região da unidade) ──
const THEMES = {
  dbv: { primary: '#1B2A6B', primary2: '#2D3E99', muted: 'rgba(255,255,255,.65)', label: 'Desbravadores' },
  avt: { primary: '#1E3A8A', primary2: '#2563EB', muted: 'rgba(255,255,255,.65)', label: 'Aventureiros' },
};

// ── ESTADO ────────────────────────────────────────────────────
const S = {
  user: null,
  unit: null,
  participants: [],
  modal: null,   // 'change-password'
  loading: false,
};

let _unsubUnit = null, _unsubParticipants = null, _unsubRegions = null;

// ── INIT ──────────────────────────────────────────────────────
export function init() {
  const user = guardPage(['counselor']);
  if (!user) return;
  S.user = user;
  startExpiryWatcher();

  _unsubRegions = subRegions(regs => { setRegionCache(regs); render(); });

  if (user.unitId) {
    _unsubUnit         = subUnitById(user.unitId, unit => { S.unit = unit; render(); });
    _unsubParticipants = subParticipantsByUnit(user.unitId, ps => { S.participants = ps; render(); });
  }

  render();
}

// ── HELPERS ───────────────────────────────────────────────────
function theme() { return S.user.competitionCategory === 'AVT' ? 'avt' : 'dbv'; }

// ── RENDER ────────────────────────────────────────────────────
function render() {
  const el = document.getElementById('app');
  if (!el) return;
  let html = vPortal();
  if (S.modal === 'change-password') html += mChangePassword();
  el.innerHTML = html;
}

// ── VIEW: PORTAL ──────────────────────────────────────────────
function vPortal() {
  const tc = THEMES[theme()];
  const unit = S.unit;
  const members = S.participants;

  if (!S.user.unitId) {
    return `
    <div style="min-height:100dvh;display:flex;align-items:center;justify-content:center;padding:1.5rem;text-align:center;">
      <div>
        <div style="font-size:3rem;margin-bottom:.5rem;">⚠️</div>
        <p style="font-weight:700;color:#374151;">Nenhuma unidade vinculada a este login.</p>
        <p style="font-size:.85rem;color:#64748b;">Fale com o administrador do Campori.</p>
        <button onclick="W.logout()" style="margin-top:1rem;background:#0D2B6E;color:#fff;border:none;padding:.75rem 1.25rem;border-radius:.75rem;cursor:pointer;">Sair</button>
      </div>
    </div>`;
  }

  return `
  <div style="min-height:100dvh;background:#f0f4f8;">
    <div style="background:linear-gradient(135deg,${tc.primary},${tc.primary2});color:#fff;padding:1rem 1rem 1.5rem;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.875rem;">
        <span style="font-size:.8rem;color:${tc.muted};">👤 ${S.user.name}</span>
        <div style="display:flex;gap:.5rem;align-items:center;">
          <button onclick="W.openChangePwd()"
            style="background:rgba(0,0,0,.2);border:none;color:rgba(255,255,255,.8);
            padding:.375rem .7rem;border-radius:.625rem;font-size:.8rem;cursor:pointer;">🔑</button>
          <button onclick="W.logout()"
            style="background:rgba(0,0,0,.25);border:none;color:#fff;
            padding:.4rem .875rem;border-radius:.625rem;font-size:.8rem;font-weight:700;cursor:pointer;">Sair</button>
        </div>
      </div>

      <h1 style="font-size:1.3rem;font-weight:800;margin:0 0 .2rem;">${unit ? unit.name : 'Carregando...'}</h1>
      ${unit?.warCry ? `<p style="color:${tc.muted};font-size:.85rem;font-style:italic;margin:0 0 .625rem;">"${unit.warCry}"</p>` : ''}

      <div style="display:flex;gap:.5rem;flex-wrap:wrap;">
        ${unit ? `<span style="background:rgba(255,255,255,.2);color:#fff;font-size:.72rem;font-weight:700;padding:.2rem .6rem;border-radius:999px;">${rname(unit.regionId)}</span>` : ''}
        <span style="background:rgba(255,255,255,.2);color:#fff;font-size:.72rem;font-weight:700;padding:.2rem .6rem;border-radius:999px;">👥 ${members.length} participante${members.length !== 1 ? 's' : ''}</span>
      </div>
    </div>

    <div style="padding:1rem;display:flex;flex-direction:column;gap:.625rem;padding-bottom:5rem;">
      <div style="font-weight:800;color:#1e293b;margin:.25rem 0;">Participantes da Unidade</div>
      ${members.length === 0
        ? `<div style="text-align:center;padding:3rem 1rem;color:#94a3b8;">
            <div style="font-size:3rem;">👥</div>
            <p style="font-weight:600;margin:.5rem 0 0;">Nenhum participante alocado ainda</p>
            <p style="font-size:.82rem;">Fale com o administrador para alocar participantes nesta unidade.</p>
           </div>`
        : members.map(p => `
        <div class="card" style="padding:.875rem 1rem;">
          <div style="font-weight:700;color:#1e293b;font-size:.9rem;">${p.name}</div>
          <div style="font-size:.78rem;color:#64748b;margin-top:.15rem;">
            ${p.club ? `${p.club} · ` : ''}${p.competitionCategory || ''}
            ${unit && p.regionId !== unit.regionId
              ? ` · <span style="color:#92400e;font-weight:700;">clube amigo (${rname(p.regionId)})</span>`
              : ''}
          </div>
        </div>`).join('')}
    </div>
  </div>`;
}

// ── MODAL: TROCAR SENHA ───────────────────────────────────────
function mChangePassword() {
  const tc = THEMES[theme()];
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
    if (_unsubUnit)         _unsubUnit();
    if (_unsubParticipants) _unsubParticipants();
    if (_unsubRegions)      _unsubRegions();
    authLogout();
  },

  closeModal()    { S.modal = null; render(); },
  openChangePwd() { S.modal = 'change-password'; render(); },

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
