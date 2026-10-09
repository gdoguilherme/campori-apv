import { guardPage, logout as authLogout, saveSession, getToken, startExpiryWatcher } from './auth.js';
import {
  rname, toast, showBanner, updatePassword, addSubmission, uploadFile, updateSubmissionProof, reqFilledBy,
  renderAnonRanking, setRegionCache
} from './api.js';
import { isDeadlinePassed, computeUnitBreakdown } from '../shared/scoring.js';
import { evaluateOfflineScan } from '../shared/sync.js';
import { getServerState, onServerChange, resolveServer, isCloudReachable, withTimeout } from './net.js';
import { TIMEOUTS } from './config.js';
import { isPersistent, requestPersistence } from './offlineDb.js';
import { rankingStampHtml } from './ranking.js';
import {
  STATUS, listQueue, enqueueScan, syncNow, refreshSnapshot, loadSnapshot, clearSnapshot,
  startAutoSync, onQueueChange, onAutoSyncResult, getSyncState
} from './scanQueue.js';

// ── CONFIGURAÇÃO POR MODALIDADE (herdada da região da unidade) ──
const THEMES = {
  dbv: { primary: '#1B2A6B', primary2: '#2D3E99', muted: 'rgba(255,255,255,.65)', label: 'Desbravadores' },
  avt: { primary: '#1E3A8A', primary2: '#2563EB', muted: 'rgba(255,255,255,.65)', label: 'Aventureiros' },
};

// ── ESTADO ────────────────────────────────────────────────────
// Os dados da unidade vêm do SNAPSHOT guardado no aparelho (IndexedDB) e são atualizados pelo
// servidor ativo (local → nuvem). Sem rede o portal abre e funciona com o último snapshot.
const S = {
  user: null,
  snapshot: null,      // { data, updatedAt, source } — última atualização baixada
  unit: null,
  participants: [],
  requirements: [],
  submissions: [],     // submissions da unidade (confirmadas pelo servidor)
  inspectionRequirements: [], // Inspeção de uniforme (pontua só a unidade; avaliada pelo Fiscal)
  regionRequirements: [], // requisitos que valem para toda a região (Regional / Só Fiscal), da modalidade dela
  regionSubmissions: [],  // submissões no nível da região (sem unitId): pontuam TODAS as unidades da região
  disciplinary: [],       // descontos de disciplina que atingem a unidade ou a região dela
  ranking: [],         // ranking anônimo [{ total }]
  queue: [],           // fila de scans deste aparelho/usuário (IndexedDB)
  net: { kind: 'none', online: true },
  sync: {},
  selectedReq: null,
  photoFile: null,
  photoUrl: null,
  qrSelectedReqId: null, // prova selecionada antes de escanear
  modal: null,   // 'submit' | 'photo' | 'change-password' | 'qr-scanner' | 'logout-confirm'
  loading: false,
};

// ── INIT ──────────────────────────────────────────────────────
export async function init() {
  const user = guardPage(['counselor']);
  if (!user) return;
  S.user = user;
  startExpiryWatcher();
  requestPersistence(); // pede ao navegador para não apagar a fila/dados quando faltar espaço

  // renderiza JÁ com o que está guardado no aparelho (funciona offline)
  await reloadFromStore();
  render();

  onQueueChange(() => reloadFromStore().then(softRender));
  onServerChange(() => reloadFromStore().then(softRender));
  onAutoSyncResult(sum => notifySync(sum, false));
  startAutoSync();
  resolveServer().then(() => reloadFromStore()).then(softRender);
  refreshSnapshot();
}

let _reloading = false, _again = false;
async function reloadFromStore() {
  if (_reloading) { _again = true; return; }
  _reloading = true;
  try {
    do {
      _again = false;
      S.queue = await listQueue(S.user.id);
      applySnapshot(await loadSnapshot(S.user.id));
      S.net = getServerState();
      S.sync = getSyncState();
    } while (_again);
  } finally { _reloading = false; }
}

function applySnapshot(snap) {
  S.snapshot = snap;
  const d = snap?.data;
  S.unit = d?.unit || null;
  S.participants = d?.participants || [];
  S.requirements = d?.requirements || [];
  S.submissions = d?.submissions || [];
  S.regionRequirements = d?.regionRequirements || [];
  S.inspectionRequirements = d?.inspectionRequirements || [];
  S.regionSubmissions = d?.regionSubmissions || [];
  S.disciplinary = d?.disciplinaryActions || [];
  S.ranking = d?.ranking || [];
  if (d?.regions) setRegionCache(d.regions);
}

// ── HELPERS ───────────────────────────────────────────────────
function theme() { return S.user.competitionCategory === 'AVT' ? 'avt' : 'dbv'; }

function fmtDeadline(ts) {
  if (!ts) return null;
  const d = ts.toDate ? ts.toDate() : new Date(typeof ts.seconds === 'number' ? ts.seconds * 1000 : ts);
  return d.toLocaleDateString('pt-BR', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

const fmtClock = ms => new Date(ms).toLocaleString('pt-BR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
function ago(ms) {
  const m = Math.floor((Date.now() - ms) / 60000);
  return m < 1 ? 'agora há pouco' : m < 60 ? `há ${m} min` : m < 1440 ? `há ${Math.floor(m / 60)} h` : `há ${Math.floor(m / 1440)} d`;
}
const esc = v => String(v ?? '').replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const pendingItems = () => S.queue.filter(q => q.status === STATUS.PENDENTE);

// ── RENDER ────────────────────────────────────────────────────
function render() {
  const el = document.getElementById('app');
  if (!el) return;
  let html = vPortal();
  if (S.modal === 'submit')          html += mSubmit();
  else if (S.modal === 'photo')      html += mPhoto();
  else if (S.modal === 'change-password') html += mChangePassword();
  else if (S.modal === 'qr-scanner') html += mQrScanner();
  else if (S.modal === 'logout-confirm') html += mLogoutConfirm();
  el.innerHTML = html;
}

// Atualizações em segundo plano (rede, fila, snapshot) NÃO re-renderizam com modal aberto:
// recriar o DOM destruiria a câmera do scanner / o formulário em preenchimento.
function softRender() { if (!S.modal) render(); }

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

  // Requisitos do tipo Conselheiro — sem distinção de modalidade (unidades são mistas)
  const visibleReqs = S.requirements.filter(r => r.active !== false && reqFilledBy(r) === 'conselheiro');
  const regionPossible = S.regionRequirements.reduce((a, r) => a + (r.points || 0), 0);
  const inspectionPossible = S.inspectionRequirements.reduce((a, r) => a + (r.points || 0), 0);
  const totalPossible = visibleReqs.reduce((a, r) => a + (r.points || 0), 0) + inspectionPossible + regionPossible;   // da unidade + os que valem da região

  // Submission que representa o requisito no card: aprovada > pendente > mais recente.
  // Registros "substituídos" (scan de QR que perdeu para um mais antigo de outro aparelho)
  // não contam — a unidade já pontuou pelo outro.
  const rank = s => (s.status === 'approved' ? 2 : s.status === 'pending' ? 1 : 0);
  const subByReq = {};
  S.submissions.filter(s => s.qrConflict !== 'superseded').forEach(s => {
    const cur = subByReq[s.requirementId];
    if (!cur || rank(s) > rank(cur) || (rank(s) === rank(cur) && (s.submittedAt?.seconds || 0) > (cur.submittedAt?.seconds || 0)))
      subByReq[s.requirementId] = s;
  });
  // ✅ PONTUAÇÃO TOTAL DA UNIDADE = a mesma função do ranking (computeUnitScores, via computeUnitBreakdown):
  //    pontos da unidade + pontos da região (valem p/ todas as unidades) − disciplina.
  // Inclui scans que o servidor já aceitou mas o snapshot ainda não trouxe (até a próxima atualização).
  const knownIds = new Set(S.submissions.map(s => s.id));
  const acceptedNotInSnapshot = S.queue
    .filter(q => q.status === STATUS.SINCRONIZADO && q.submissionId && !knownIds.has(q.submissionId))
    .map(q => ({ id: q.submissionId, unitId: q.unitId, regionId: unit?.regionId, requirementId: q.requisitoId, status: 'approved',
      requirementPoints: q.pontos, submittedAt: { seconds: Math.floor(q.scanTimestamp / 1000), nanoseconds: 0 } }));
  const bd = unit
    ? computeUnitBreakdown({ unit, unitSubmissions: [...S.submissions, ...acceptedNotInSnapshot], regionSubmissions: S.regionSubmissions, disciplinaryActions: S.disciplinary })
    : { own: 0, region: 0, discipline: 0, total: 0, floored: false };
  const approvedPts = bd.total;
  const queuedPts = pendingItems().reduce((a, q) => a + (q.pontos || 0), 0); // 🕓 só no aparelho — ainda NÃO contam
  const pendingPts = S.submissions                                  // ⏳ comprovações aguardando aprovação do admin
    .filter(s => s.status === 'pending')
    .reduce((a, s) => a + (s.requirementPoints || 0), 0);
  const queueByReq = {};
  pendingItems().forEach(q => { queueByReq[q.requisitoId] = q; });

  return `
  <div style="min-height:100dvh;background:#f0f4f8;">
    ${statusBar()}
    <div style="background:linear-gradient(135deg,${tc.primary},${tc.primary2});color:#fff;padding:1rem 1rem 1.5rem;">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:.875rem;">
        <div style="display:flex;align-items:center;gap:.625rem;">
          <div style="border-radius:.4rem;overflow:hidden;line-height:0;">
            <img src="/assets/logo-integros-selo.png" alt="ÍNTEGROS" style="height:1.75rem;width:auto;object-fit:contain;display:block;">
          </div>
          <span style="font-size:.8rem;color:${tc.muted};">👤 ${S.user.name}</span>
        </div>
        <div style="display:flex;gap:.5rem;align-items:center;">
          <img src="/assets/logo-apv.png" alt="APV" style="height:1.3rem;width:auto;object-fit:contain;opacity:.85;">
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

      <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:.875rem;">
        ${unit ? `<span style="background:rgba(255,255,255,.2);color:#fff;font-size:.72rem;font-weight:700;padding:.2rem .6rem;border-radius:999px;">${rname(unit.regionId)}</span>` : ''}
        <span style="background:rgba(255,255,255,.2);color:#fff;font-size:.72rem;font-weight:700;padding:.2rem .6rem;border-radius:999px;">👥 ${members.length} participante${members.length !== 1 ? 's' : ''}</span>
      </div>

      <div style="display:grid;grid-template-columns:1fr 1fr;gap:.5rem;">
        <div id="pts-confirmed" style="background:rgba(255,255,255,.18);border-radius:.875rem;padding:.65rem .75rem;text-align:center;">
          <div style="font-size:1.5rem;font-weight:800;">${approvedPts}</div>
          <div style="font-size:.68rem;color:${tc.muted};">✅ pts confirmados</div>
          <div id="pts-breakdown" style="font-size:.62rem;color:${tc.muted};margin-top:.2rem;line-height:1.25;">${bd.own} da unidade + ${bd.region} da região − ${bd.discipline} de disciplina${bd.floored ? ' (mínimo 0)' : ''}</div>
        </div>
        <div id="pts-queued" style="background:rgba(251,191,36,.22);border:1px dashed rgba(253,230,138,.7);border-radius:.875rem;padding:.65rem .75rem;text-align:center;">
          <div style="font-size:1.5rem;font-weight:800;color:#fde68a;">${queuedPts}</div>
          <div style="font-size:.68rem;color:#fde68a;">🕓 na fila (ainda não contam)</div>
        </div>
        <div style="background:rgba(255,255,255,.18);border-radius:.875rem;padding:.65rem .75rem;text-align:center;">
          <div style="font-size:1.25rem;font-weight:800;">${pendingPts}</div>
          <div style="font-size:.68rem;color:${tc.muted};">⏳ aguardando aprovação</div>
        </div>
        <div style="background:rgba(255,255,255,.18);border-radius:.875rem;padding:.65rem .75rem;text-align:center;">
          <div style="font-size:1.25rem;font-weight:800;color:#bbf7d0;">${totalPossible}</div>
          <div style="font-size:.68rem;color:${tc.muted};">pts possíveis <span style="font-size:.6rem;">(${totalPossible - regionPossible} da unidade + ${regionPossible} da região)</span></div>
        </div>
      </div>
    </div>

    <div style="padding:1rem;display:flex;flex-direction:column;gap:.75rem;">
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div style="font-weight:800;color:#1e293b;">Requisitos da Unidade</div>
        <button onclick="W.openQrScanner()"
          style="background:${tc.primary};color:#fff;border:none;padding:.5rem .875rem;border-radius:.75rem;font-size:.8rem;font-weight:700;cursor:pointer;">📷 Escanear QR</button>
      </div>
      ${visibleReqs.length === 0
        ? `<div style="text-align:center;padding:2.5rem 1rem;color:#94a3b8;">
            <div style="font-size:2.5rem;">📋</div>
            <p style="font-weight:600;margin:.5rem 0 0;">${S.snapshot ? 'Nenhum requisito de Conselheiro cadastrado ainda' : 'Dados ainda não baixados. Conecte-se ao servidor ao menos uma vez.'}</p>
           </div>`
        : visibleReqs.map(req => reqCard(req, subByReq[req.id], tc, queueByReq[req.id])).join('')}
      ${S.inspectionRequirements.map(r => {
        const sub = subByReq[r.id];
        const [bg, fg, txt] = sub?.status === 'approved' ? ['#d1fae5', '#065f46', `✅ Aprovado · ${sub.requirementPoints ?? 0} pts recebidos`]
          : sub?.status === 'pending' ? ['#fef3c7', '#92400e', '⏳ Aguardando aprovação'] : ['#f1f5f9', '#64748b', 'Ainda não avaliado pelo Fiscal'];
        return `<div class="inspection-req" style="background:#fff;border-radius:1rem;border:1px solid #e2e8f0;border-left:4px solid #7c3aed;padding:.8rem 1rem;">
          <div style="display:flex;gap:.375rem;margin-bottom:.4rem;"><span style="background:#dbeafe;color:#1d4ed8;font-size:.68rem;font-weight:700;padding:.15rem .55rem;border-radius:999px;">até ${r.points} pts</span>
          <span style="background:#ede9fe;color:#5b21b6;font-size:.68rem;font-weight:700;padding:.15rem .55rem;border-radius:999px;">👔 Avaliado pelo Fiscal</span></div>
          <div style="font-weight:700;color:#1e293b;font-size:.9rem;">${esc(r.name)}</div>
          <div style="margin-top:.45rem;"><span style="background:${bg};color:${fg};font-size:.76rem;font-weight:700;padding:.25rem .7rem;border-radius:999px;display:inline-block;">${txt}</span></div></div>`;
      }).join('')}
    </div>

    ${regionSection(bd.region)}

    ${qrHistory()}

    <div style="padding:0 1rem 5rem;display:flex;flex-direction:column;gap:.625rem;">
      <div style="font-weight:800;color:#1e293b;margin:.5rem 0 .25rem;">Participantes da Unidade</div>
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

    <!-- RANKING GERAL (anônimo, por unidade) -->
    <div style="padding:0 1rem 5rem;">
      <div class="card" style="padding:1rem;">
        <div style="font-weight:800;color:#1e293b;font-size:.9rem;margin-bottom:.75rem;">🏆 Ranking Geral das Unidades</div>
        ${renderAnonRanking(S.ranking)}
        ${S.snapshot ? rankingStampHtml({ updatedAt: S.snapshot.updatedAt, source: S.snapshot.source === 'local' ? 'local' : 'cloud' }) : ''}
      </div>
    </div>
  </div>`;
}

// ── PONTOS DA REGIÃO (somente leitura) — valem para TODAS as unidades da região ──
function regionSection(regionPts) {
  if (!S.snapshot) return '';
  const rank = s => (s.status === 'approved' ? 2 : s.status === 'pending' ? 1 : 0);
  const subByReq = {};
  S.regionSubmissions.forEach(s => {
    const cur = subByReq[s.requirementId];
    if (!cur || rank(s) > rank(cur) || (rank(s) === rank(cur) && (s.submittedAt?.seconds || 0) > (cur.submittedAt?.seconds || 0))) subByReq[s.requirementId] = s;
  });
  const row = r => {
    const sub = subByReq[r.id];
    const [bg, fg, txt, border] =
      sub?.status === 'approved' ? ['#d1fae5', '#065f46', `✅ Aprovado · ${sub.requirementPoints ?? r.points} pts recebidos`, '#16a34a']
      : sub?.status === 'pending' ? ['#fef3c7', '#92400e', '⏳ Aguardando aprovação', '#f59e0b']
      : sub?.status === 'rejected' ? ['#fee2e2', '#991b1b', '❌ Recusado', '#ef4444']
      : ['#f1f5f9', '#64748b', 'Ainda não enviado pela região', '#cbd5e1'];
    return `
    <div class="region-req" data-status="${sub?.status || 'none'}" style="background:#fff;border-radius:1rem;border:1px solid #e2e8f0;border-left:4px solid ${border};padding:.8rem 1rem;">
      <div style="display:flex;flex-wrap:wrap;gap:.375rem;margin-bottom:.4rem;">
        ${r.category ? `<span style="background:#eef2ff;color:#4338ca;font-size:.68rem;font-weight:600;padding:.15rem .55rem;border-radius:999px;">${esc(r.category)}</span>` : ''}
        <span style="background:#dbeafe;color:#1d4ed8;font-size:.68rem;font-weight:700;padding:.15rem .55rem;border-radius:999px;">${r.points} pts</span>
        ${r.filledBy === 'fiscal' ? '<span style="background:#ede9fe;color:#5b21b6;font-size:.68rem;font-weight:700;padding:.15rem .55rem;border-radius:999px;">⚖️ Avaliado pelo Fiscal</span>' : ''}
      </div>
      <div style="font-weight:700;color:#1e293b;font-size:.9rem;">${esc(r.name)}</div>
      <div style="margin-top:.45rem;"><span style="background:${bg};color:${fg};font-size:.76rem;font-weight:700;padding:.25rem .7rem;border-radius:999px;display:inline-block;">${txt}</span></div>
    </div>`;
  };
  return `
    <div id="region-section" style="padding:0 1rem 1rem;display:flex;flex-direction:column;gap:.5rem;">
      <div>
        <div style="font-weight:800;color:#1e293b;">🗺️ Pontos da região <span style="font-weight:600;color:#64748b;font-size:.8rem;">(valem para todas as unidades)</span></div>
        <div style="font-size:.75rem;color:#64748b;margin-top:.15rem;">Somente leitura — enviados pela região ou avaliados pelo Fiscal. <strong id="region-total">${regionPts} pts</strong> já contam para a sua unidade.</div>
      </div>
      ${S.regionRequirements.length === 0
        ? '<div style="text-align:center;padding:1.25rem;color:#94a3b8;font-size:.85rem;">Nenhum requisito regional para a modalidade desta região.</div>'
        : S.regionRequirements.map(row).join('')}
    </div>`;
}

// ── BARRA DE ESTADO (online/offline, servidor, pendentes, última atualização) ──
function statusBar() {
  const net = S.net, sy = S.sync, pend = pendingItems().length;
  const offline = net.kind === 'none' || net.online === false;
  let bg, label;
  if (sy.authExpired) { bg = '#b45309'; label = `🔐 Sessão expirada — entre de novo para enviar ${pend ? pend + ' registro(s) guardado(s)' : 'os dados'}`; }
  else if (offline)   { bg = '#b91c1c'; label = '🔴 Sem conexão — os QR Codes ficam guardados no aparelho'; }
  else if (net.kind === 'local') { bg = '#15803d'; label = '🟢 Online · servidor local'; }
  else                { bg = '#15803d'; label = '🟢 Online · nuvem'; }
  const upd = S.snapshot ? `Atualizado ${fmtClock(S.snapshot.updatedAt)} (${ago(S.snapshot.updatedAt)})` : 'Dados ainda não baixados';
  return `
  <div id="status-bar" style="position:sticky;top:0;z-index:60;background:${bg};color:#fff;padding:.5rem .875rem;font-size:.78rem;">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:.5rem;flex-wrap:wrap;">
      <span id="net-label" style="font-weight:700;">${label}</span>
      ${pend > 0 ? `<span id="pending-count" style="background:rgba(255,255,255,.25);border-radius:999px;padding:.15rem .6rem;font-weight:800;">🕓 ${pend} pendente${pend > 1 ? 's' : ''}</span>` : ''}
    </div>
    <div style="display:flex;align-items:center;justify-content:space-between;gap:.5rem;margin-top:.3rem;">
      <span id="last-update" style="opacity:.9;">${upd}</span>
      ${sy.authExpired
        ? `<button onclick="W.reloginKeepQueue()" style="background:#fff;color:#92400e;border:none;border-radius:.5rem;padding:.3rem .7rem;font-weight:800;font-size:.75rem;cursor:pointer;">Entrar</button>`
        : `<button id="btn-sync" onclick="W.syncManual()" ${sy.syncing ? 'disabled' : ''} style="background:rgba(255,255,255,.22);color:#fff;border:1px solid rgba(255,255,255,.5);border-radius:.5rem;padding:.3rem .7rem;font-weight:800;font-size:.75rem;cursor:pointer;opacity:${sy.syncing ? .6 : 1};">${sy.syncing ? '⏳ Sincronizando…' : '🔄 Sincronizar agora'}</button>`}
    </div>
    ${sy.lastError ? `<div style="margin-top:.25rem;opacity:.9;">⚠️ ${esc(sy.lastError)}</div>` : ''}
    ${!isPersistent() ? `<div style="margin-top:.25rem;background:rgba(0,0,0,.25);border-radius:.4rem;padding:.25rem .5rem;">⚠️ Armazenamento do aparelho indisponível (aba anônima?): registros offline se perdem ao fechar o app.</div>` : ''}
  </div>`;
}

// ── REGISTROS DE QR CODE deste aparelho, com o estado de cada um ──
function qrHistory() {
  if (S.queue.length === 0) return '';
  const row = q => {
    // aceito na hora, mas depois outro aparelho da unidade (scan mais antigo) tomou o lugar
    const lost = q.status === STATUS.SINCRONIZADO && S.submissions.some(s => s.id === q.submissionId && s.qrConflict === 'superseded');
    const [icon, bg, fg, txt] =
      lost ? ['⚠️', '#fef3c7', '#92400e', 'Substituído — outro aparelho da unidade escaneou esta prova antes e o registro dele foi mantido']
      : q.status === STATUS.SINCRONIZADO ? ['✅', '#d1fae5', '#065f46', 'Sincronizado']
      : q.status === STATUS.DUPLICADO  ? ['⚠️', '#fef3c7', '#92400e', 'Duplicado — esta unidade já tinha pontuado nesta prova']
      : q.status === STATUS.REJEITADO  ? ['❌', '#fee2e2', '#991b1b', `Rejeitado — ${esc(q.message || 'o servidor recusou este QR Code')}`]
      : ['🕓', '#dbeafe', '#1e40af', 'Pendente, aguardando conexão'];
    return `
    <div class="qr-row" data-status="${lost ? 'substituido' : q.status}" style="background:#fff;border:1px solid #e2e8f0;border-radius:.875rem;padding:.7rem .875rem;">
      <div style="display:flex;justify-content:space-between;gap:.5rem;align-items:flex-start;">
        <div style="min-width:0;">
          <div style="font-weight:700;color:#1e293b;font-size:.85rem;">${esc(q.requirementName || q.requisitoId)}</div>
          <div style="font-size:.74rem;color:#64748b;">${esc(q.variantLabel || q.varianteId)} · ${q.pontos} pts · escaneado ${fmtClock(q.scanTimestamp)}</div>
        </div>
        <span style="font-size:1.25rem;">${icon}</span>
      </div>
      <div style="margin-top:.4rem;background:${bg};color:${fg};font-size:.76rem;font-weight:700;border-radius:.5rem;padding:.3rem .6rem;">${txt}</div>
    </div>`;
  };
  return `
    <div id="qr-history" style="padding:0 1rem 1rem;display:flex;flex-direction:column;gap:.5rem;">
      <div style="font-weight:800;color:#1e293b;margin:.25rem 0;">📷 Registros por QR Code <span style="font-weight:400;color:#94a3b8;font-size:.75rem;">(este aparelho)</span></div>
      ${S.queue.slice(0, 15).map(row).join('')}
    </div>`;
}

function reqCard(req, sub, tc, queued) {
  const isApproved = sub?.status === 'approved';
  const isPending  = sub?.status === 'pending';
  const isRejected = sub?.status === 'rejected';
  const deadlinePassed = isDeadlinePassed(req);
  const deadlineFmt    = fmtDeadline(req.deadline);
  const isQueued = !!queued && !isApproved;

  const bl = isQueued ? '4px solid #3b82f6' : isApproved ? '4px solid #16a34a'
           : isPending  ? '4px solid #f59e0b'
           : isRejected ? '4px solid #ef4444'
           : 'none';

  return `
  <div style="background:#fff;border-radius:1rem;border:1px solid #e2e8f0;border-left:${bl};
    padding:1rem;box-shadow:0 1px 3px rgba(0,0,0,.06);">
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:.75rem;">
      <div style="flex:1;min-width:0;">
        <div style="display:flex;flex-wrap:wrap;gap:.375rem;margin-bottom:.5rem;">
          ${req.areaAtuacao ? `<span style="background:#eef2ff;color:#4338ca;font-size:.7rem;font-weight:600;padding:.2rem .6rem;border-radius:999px;">📌 ${req.areaAtuacao}</span>` : ''}
          <span style="background:#dbeafe;color:#1d4ed8;font-size:.7rem;font-weight:700;padding:.2rem .6rem;border-radius:999px;">${req.points} pts</span>
          ${deadlineFmt && !deadlinePassed
            ? `<span style="background:#fef3c7;color:#92400e;font-size:.7rem;font-weight:600;padding:.2rem .6rem;border-radius:999px;">📅 ${deadlineFmt}</span>` : ''}
          ${deadlinePassed
            ? `<span style="background:#fee2e2;color:#991b1b;font-size:.7rem;font-weight:700;padding:.2rem .6rem;border-radius:999px;">🔒 Prazo encerrado</span>` : ''}
        </div>

        <div style="font-weight:700;color:#1e293b;font-size:.95rem;">${req.name}</div>
        ${req.description ? `<div style="font-size:.8rem;color:#64748b;margin-top:.2rem;">${req.description}</div>` : ''}

        ${isQueued ? `<div style="margin-top:.625rem;"><span class="q-pending" style="background:#dbeafe;color:#1e40af;font-size:.8rem;font-weight:700;padding:.3rem .8rem;border-radius:999px;display:inline-block;">🕓 Pendente, aguardando conexão · ${queued.pontos} pts</span></div>` : ''}
        ${sub ? `<div style="margin-top:.625rem;">
          ${isApproved
            ? `<span style="background:#d1fae5;color:#065f46;font-size:.8rem;font-weight:700;padding:.3rem .8rem;border-radius:999px;display:inline-block;">✅ Aprovado · ${sub.requirementPoints} pts</span>`
            : isPending
            ? `<span style="background:#fef3c7;color:#92400e;font-size:.8rem;font-weight:700;padding:.3rem .8rem;border-radius:999px;display:inline-block;">⏳ Aguardando aprovação</span>`
            : `<span style="background:#fee2e2;color:#991b1b;font-size:.8rem;font-weight:700;padding:.3rem .8rem;border-radius:999px;display:inline-block;">❌ Recusado</span>`}
          ${isRejected && sub.rejectionReason
            ? `<div style="font-size:.8rem;color:#b91c1c;background:#fff1f1;border-radius:.5rem;padding:.4rem .75rem;margin-top:.375rem;"><strong>Motivo:</strong> ${sub.rejectionReason}</div>` : ''}
        </div>`
        : (isQueued ? '' : `<div style="margin-top:.5rem;font-size:.8rem;color:#94a3b8;">Não enviado</div>`)}
      </div>

      <div style="flex-shrink:0;padding-top:.25rem;">
        ${isQueued    ? `<span style="font-size:1.75rem;">🕓</span>`
        : isApproved  ? `<span style="font-size:1.75rem;">✅</span>`
        : isPending   ? `<span style="font-size:1.75rem;">⏳</span>`
        : deadlinePassed ? `<span style="font-size:1.5rem;">🔒</span>`
        : `<button onclick="W.openSubmit('${req.id}')"
            style="background:${tc.primary};color:#fff;border:none;padding:.5rem 1rem;
            border-radius:.75rem;font-size:.85rem;font-weight:700;cursor:pointer;">Enviar</button>`}
      </div>
    </div>

    ${isRejected && !deadlinePassed ? `
    <button onclick="W.openSubmit('${req.id}')"
      style="width:100%;margin-top:.75rem;padding:.75rem;background:#eff6ff;border:1.5px solid #bfdbfe;
      border-radius:.75rem;color:#1d4ed8;font-size:.875rem;font-weight:700;cursor:pointer;">
      🔄 Reenviar comprovação
    </button>` : ''}
  </div>`;
}

// ── MODAL: ENVIAR COMPROVAÇÃO ─────────────────────────────────
function mSubmit() {
  const req = S.requirements.find(r => r.id === S.selectedReq);
  if (!req) return '';
  const tc = THEMES[theme()];

  return `
  <div class="modal-overlay" onclick="if(event.target===this)W.closeModal()">
    <div class="modal-content">
      <div style="width:2.5rem;height:.25rem;background:#e2e8f0;border-radius:999px;margin:0 auto .875rem;"></div>

      <div style="display:flex;gap:.5rem;flex-wrap:wrap;margin-bottom:.5rem;">
        ${req.areaAtuacao ? `<span style="background:#eef2ff;color:#4338ca;font-size:.75rem;font-weight:600;padding:.25rem .75rem;border-radius:999px;">📌 ${req.areaAtuacao}</span>` : ''}
        <span style="background:#dbeafe;color:#1d4ed8;font-size:.75rem;font-weight:700;padding:.25rem .75rem;border-radius:999px;">${req.points} pontos</span>
      </div>

      <h2 style="font-size:1.15rem;font-weight:800;color:#1e293b;margin:.25rem 0 .5rem;">${req.name}</h2>
      ${req.description ? `<p style="font-size:.85rem;color:#64748b;margin-bottom:1rem;">${req.description}</p>` : ''}

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
    </div>
  </div>`;
}

// ── MODAL: ESCANEAR QR CODE ─────────────────────────────────────
function mQrScanner() {
  // Provas disponíveis pra esta unidade: tipo Conselheiro, com pelo menos uma variante de QR
  const provas = S.requirements.filter(r => r.active !== false && reqFilledBy(r) === 'conselheiro' && (r.qrVariants || []).length > 0);
  const selected = S.qrSelectedReqId;
  const done = id => S.submissions.some(s => s.requirementId === id && s.status === 'approved') ||
                     S.queue.some(q => q.requisitoId === id && (q.status === STATUS.PENDENTE || q.status === STATUS.SINCRONIZADO));
  const offline = S.net.kind === 'none' || S.net.online === false;

  return `
  <div class="modal-overlay center" onclick="if(event.target===this)W.closeQrScanner()">
    <div class="modal-content" style="max-width:420px;">
      <h2 style="font-size:1.1rem;font-weight:800;color:#1e293b;margin:0 0 .75rem;">📷 Escanear QR Code</h2>
      ${offline ? `<div style="background:#fee2e2;color:#991b1b;border-radius:.75rem;padding:.5rem .75rem;font-size:.78rem;font-weight:600;margin-bottom:.75rem;">🔴 Sem conexão: o QR será guardado no aparelho e enviado quando houver rede. A autenticidade do QR só é conferida ao sincronizar.</div>` : ''}
      <div style="margin-bottom:.875rem;">
        <label style="display:block;font-size:.82rem;font-weight:700;color:#374151;margin-bottom:.375rem;">Qual prova você está aplicando? *</label>
        <select id="qr-prova-select" onchange="W.selectQrProva(this.value)"
          style="width:100%;border:1.5px solid #e2e8f0;border-radius:.875rem;padding:.875rem;font-size:.9rem;outline:none;background:#fff;">
          <option value="" disabled ${!selected ? 'selected' : ''}>Selecione a prova...</option>
          ${provas.map(r => `<option value="${r.id}" ${selected === r.id ? 'selected' : ''}>${esc(r.name)}${done(r.id) ? ' ✔ (já pontuada)' : ''}</option>`).join('')}
        </select>
        ${provas.length === 0 ? `<p style="font-size:.78rem;color:#b45309;margin:.5rem 0 0;">Nenhuma prova com QR Code baixada. Conecte-se ao servidor ao menos uma vez para baixar as provas da unidade.</p>` : ''}
      </div>
      ${selected
        ? `<div id="qr-reader" style="width:100%;border-radius:1rem;overflow:hidden;background:#000;"></div>
           <p style="font-size:.78rem;color:#64748b;margin-top:.625rem;">Aponte a câmera para o QR Code mostrado/impresso pelo Fiscal de Prova.</p>`
        : `<p style="font-size:.82rem;color:#94a3b8;text-align:center;padding:1.5rem 0;">Selecione a prova acima para iniciar a câmera.</p>`}
      <button onclick="W.closeQrScanner()"
        style="width:100%;margin-top:1rem;padding:.875rem;background:none;border:none;color:#9ca3af;cursor:pointer;">Cancelar</button>
    </div>
  </div>`;
}

// ── MODAL: CONFIRMAR SAÍDA (com registros pendentes) ──────────
function mLogoutConfirm() {
  const n = pendingItems().length;
  return `
  <div class="modal-overlay center" onclick="if(event.target===this)W.closeModal()">
    <div class="modal-content" style="max-width:380px;">
      <h2 style="font-size:1.1rem;font-weight:800;color:#1e293b;margin:0 0 .5rem;">🕓 Registros ainda não enviados</h2>
      <p style="font-size:.88rem;color:#475569;margin:0 0 1rem;">Você tem <strong>${n} registro${n > 1 ? 's' : ''} de QR Code</strong> guardado${n > 1 ? 's' : ''} neste aparelho, sem conexão com o servidor. Se sair agora, ${n > 1 ? 'eles continuam guardados' : 'ele continua guardado'} e ${n > 1 ? 'serão enviados' : 'será enviado'} quando você entrar de novo com esta mesma conta.</p>
      <button onclick="W.syncManual().then(()=>W.closeModal())" style="width:100%;background:#0D2B6E;color:#fff;border:none;padding:.9rem;border-radius:.875rem;font-weight:800;cursor:pointer;">🔄 Tentar sincronizar agora</button>
      <button id="btn-logout-anyway" onclick="W.confirmLogout()" style="width:100%;margin-top:.5rem;background:#fee2e2;color:#991b1b;border:none;padding:.9rem;border-radius:.875rem;font-weight:800;cursor:pointer;">Sair mesmo assim</button>
      <button onclick="W.closeModal()" style="width:100%;margin-top:.375rem;padding:.75rem;background:none;border:none;color:#9ca3af;cursor:pointer;">Cancelar</button>
    </div>
  </div>`;
}

// ── QR SCANNER (html5-qrcode) ───────────────────────────────────
let _qrScanner = null;

function startQrScanner() {
  if (typeof window.Html5Qrcode === 'undefined') { toast('Biblioteca de QR Code não carregada', 'error'); return; }
  const el = document.getElementById('qr-reader');
  if (!el) return; // modal fechou ou prova ainda não selecionada
  _qrScanner = new window.Html5Qrcode('qr-reader');
  _qrScanner.start(
    { facingMode: 'environment' },
    { fps: 10, qrbox: 240 },
    onQrScanSuccess,
    () => {} // ignora falhas de decodificação quadro a quadro
  ).catch(err => {
    toast('Não foi possível acessar a câmera: ' + err, 'error');
  });
}

function stopQrScanner() {
  if (_qrScanner) {
    const s = _qrScanner;
    _qrScanner = null;
    s.stop().then(() => s.clear()).catch(() => {});
  }
}

// Depois de um scan rejeitado (prova errada, duplicidade, hash inválido), a tela
// do scanner continua aberta — só pausa a câmera brevemente e retoma sozinha,
// pra não disparar o mesmo frame em loop nem precisar reabrir o modal
function resumeQrScannerAfterError() {
  if (!_qrScanner) return;
  try { _qrScanner.pause(true); } catch (_) {}
  setTimeout(() => {
    if (_qrScanner) { try { _qrScanner.resume(); } catch (_) {} }
  }, 1800);
}

let _scanBusy = false; // a câmera dispara o callback várias vezes para o mesmo QR

async function onQrScanSuccess(decodedText) {
  if (_scanBusy) return;
  _scanBusy = true;
  try { await handleScan(decodedText, Date.now()); } finally { _scanBusy = false; }
}

// Fluxo: validar offline (só com dados já baixados) → entrar na FILA (IndexedDB) → tentar enviar
// na hora. O hash NÃO é validado aqui: só o servidor tem o segredo (acontece na sincronização).
async function handleScan(decodedText, scanTimestamp /* momento exato do escaneamento */) {
  let payload;
  try { payload = JSON.parse(decodedText); } catch {
    toast('QR Code inválido', 'error'); resumeQrScannerAfterError(); return;
  }
  const { requisitoId, varianteId, pontos, hash } = payload || {};
  if (!requisitoId || !varianteId || pontos === undefined || !hash) {
    toast('QR Code inválido', 'error'); resumeQrScannerAfterError(); return;
  }

  const req = S.requirements.find(r => r.id === requisitoId);
  const verdict = evaluateOfflineScan({
    selectedRequirementId: S.qrSelectedReqId, payload: { requisitoId, varianteId, pontos }, requirement: req,
    confirmedSubs: S.submissions, queueItems: S.queue, unitId: S.user.unitId,
  });
  if (!verdict.ok) {
    // prova errada / já pontuou (confirmado OU pendente na fila) / prova ou variante desconhecida
    toast(verdict.code === 'WRONG_PROVA' ? `⚠️ ${verdict.message}` : verdict.message, 'error');
    resumeQrScannerAfterError();
    return;
  }

  const item = await enqueueScan({
    user: S.user, requirement: req, variant: verdict.variant, selectedRequirementId: S.qrSelectedReqId,
    payload: { requisitoId, varianteId, pontos, hash }, scanTimestamp,
  });
  try { _qrScanner?.pause(true); } catch (_) {} // não lê o mesmo QR de novo enquanto envia

  // tenta enviar agora, no máximo ~4s: se não der, fica 🕓 pendente e a sincronização segue sozinha
  const cur = await syncItemNow(item.id, TIMEOUTS.immediateScan);
  await reloadFromStore();
  const label = `${req.name} — ${verdict.variant.label || ''} (${verdict.variant.points} pts)`;

  if (cur.status === STATUS.PENDENTE) {
    stopQrScanner(); S.modal = null; S.qrSelectedReqId = null; render();
    showBanner(`🕓 ${label} guardado no aparelho — será enviado quando houver conexão.`, '#b45309');
  } else if (cur.status === STATUS.SINCRONIZADO) {
    stopQrScanner(); S.modal = null; S.qrSelectedReqId = null; render();
    showBanner(`✅ ${label} registrado na unidade!`);
  } else {
    // duplicado / rejeitado pelo servidor: mostra o motivo e MANTÉM o scanner aberto
    toast(cur.message || (cur.status === STATUS.DUPLICADO ? 'Esta unidade já tinha pontuado nesta prova.' : 'QR Code recusado pelo servidor.'), 'error');
    try { _qrScanner?.resume(); } catch (_) {}
  }
}

// Sincroniza até o item sair de "pendente" (ou o prazo/rede acabar). Uma sincronização já em
// andamento pode não ter incluído o item novo — por isso repetimos até 2 vezes.
async function syncItemNow(itemId, ms) {
  const deadline = Date.now() + ms;
  const read = async () => (await listQueue(S.user.id)).find(q => q.id === itemId);
  for (let i = 0; i < 2; i++) {
    const left = deadline - Date.now();
    if (left <= 0) break;
    const sum = await Promise.race([syncNow(), new Promise(r => setTimeout(() => r(null), left))]);
    const cur = await read();
    if (!cur || cur.status !== STATUS.PENDENTE || !sum || sum.offline || sum.authExpired || sum.error) break;
  }
  return (await read()) || { status: STATUS.PENDENTE };
}

// Alertas de sincronização (manual: sempre; automática: só quando há novidade)
function notifySync(sum, manual) {
  if (!sum) return;
  if (sum.authExpired) { toast('🔐 Sessão expirada. Entre de novo — seus registros pendentes continuam guardados.', 'error'); return; }
  if (sum.error) { toast(`⚠️ Erro ao sincronizar: ${sum.error}`, 'error'); return; }
  const name = q => `"${q.requirementName || q.requisitoId}"`;
  if (sum.accepted.length) {
    const n = sum.accepted.length;
    showBanner(`✅ ${n} registro${n > 1 ? 's' : ''} sincronizado${n > 1 ? 's' : ''}!`);
  }
  if (sum.duplicates.length) toast(`⚠️ ${sum.duplicates.map(name).join(', ')}: esta unidade já tinha pontuado nesta prova — registro não contado.`, 'error');
  if (sum.rejected.length) toast(`❌ ${sum.rejected.map(q => `${name(q)}: ${q.message}`).join(' · ')}`, 'error');
  if (manual && sum.offline) toast('📡 Sem conexão com o servidor. Os registros continuam guardados e serão enviados automaticamente.', 'error');
  if (manual && !sum.offline && sum.sent === 0) toast(pendingItems().length ? '⏳ Nada foi enviado ainda. Tente de novo em instantes.' : '✅ Tudo sincronizado — nada pendente.');
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
  // Sair: a sessão é limpa, mas a FILA de scans pendentes fica no aparelho (IndexedDB)
  // e é enviada quando a pessoa entrar de novo. Se há pendentes, pede confirmação antes.
  logout() {
    if (pendingItems().length > 0) { S.modal = 'logout-confirm'; render(); return; }
    W.confirmLogout();
  },
  async confirmLogout() {
    await clearSnapshot(S.user.id); // dados baixados (privacidade) — nunca a fila
    authLogout();
  },
  // Sessão expirou com fila cheia: vai ao login SEM apagar nada; após entrar a fila é enviada
  reloginKeepQueue() { authLogout(); },

  async syncManual() {
    const sum = await syncNow({ manual: true });
    await refreshSnapshot();
    await reloadFromStore();
    notifySync(sum, true);
    softRender();
  },

  closeModal()    { S.modal = null; render(); },
  openChangePwd() { S.modal = 'change-password'; render(); },
  openPhoto(url)  { S.photoUrl = url; S.modal = 'photo'; render(); },

  openQrScanner() {
    S.qrSelectedReqId = null;
    S.modal = 'qr-scanner';
    render();
  },
  selectQrProva(reqId) {
    stopQrScanner(); // troca de prova no meio do escaneamento reinicia a câmera
    S.qrSelectedReqId = reqId;
    render();
    setTimeout(startQrScanner, 50); // espera o #qr-reader existir no DOM
  },
  closeQrScanner() {
    stopQrScanner();
    S.modal = null;
    S.qrSelectedReqId = null;
    render();
  },

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
    // Comprovação (foto) grava direto na nuvem: sem internet, avisa na hora em vez de deixar
    // o botão preso. (Só o registro por QR Code funciona offline.)
    if (!(await isCloudReachable())) {
      toast('📡 Sem internet: enviar comprovação exige conexão com a nuvem. Só o QR Code funciona offline.', 'error');
      return;
    }
    S.loading = true; render();

    try {
      const subId = await withTimeout(addSubmission(S.user, req, notes, null), 20000, 'Tempo esgotado ao enviar. Verifique a conexão e tente de novo.');
      const fileToUpload = S.photoFile;
      S.modal = null; S.selectedReq = null; S.photoFile = null; S.loading = false;
      render();
      showBanner('✅ Requisito registrado! Aguardando aprovação.');
      refreshSnapshot();

      if (fileToUpload) {
        try {
          const url = await uploadFile(fileToUpload, S.user.unitId, req.code || req.id);
          await withTimeout(updateSubmissionProof(subId, url), 20000, 'Tempo esgotado ao anexar o arquivo');
          toast('📎 Arquivo enviado com sucesso!');
        } catch (e) {
          toast(`⚠️ Falha no upload: ${e.message}`, 'error');
        }
      }
    } catch (e) {
      toast(e?.name === 'NetError' ? e.message : 'Erro ao enviar. Tente novamente.', 'error');
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

// Gancho de teste (SÓ em localhost): simula a leitura de um QR sem câmera
if (location.hostname === 'localhost' || location.hostname === '127.0.0.1') {
  window.__camporiTest = {
    scan: text => onQrScanSuccess(text), state: () => S,
    select: id => { S.qrSelectedReqId = id; S.modal = 'qr-scanner'; render(); }, // sem ligar a câmera
  };
}
