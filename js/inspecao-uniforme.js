// Tela de Inspeção de Uniforme (Fiscal de Prova e Admin) — espelha a ficha de papel:
// 8 categorias com imagem de referência, contador de erros e observação; pontos da UNIDADE pela regra única de shared/uniforme.js.
// Modo local: a inspeção entra na fila offline do Fiscal (IndexedDB, idempotente) e é enviada ao servidor local;
// nuvem: grava direto (Firestore) como as demais avaliações. Em ambos fica PENDENTE para o admin aprovar.
import { guardPage, portalUrlForUser, startExpiryWatcher } from './auth.js';
import { subReqs, subSubs, subRegions, setRegionCache, subUnits, rname, fmtDate, toast, doUniformInspection, refreshNow } from './api.js';
import { mountPortalBar } from './portalBar.js';
import { LOCAL_APP, TIMEOUTS } from './config.js';
import { getServerState, onServerChange, resolveServer } from './net.js';
import { requestPersistence } from './offlineDb.js';
import {
  FQ_STATUS, listFiscalQueue, saveFiscalEvaluation, syncFiscalNow, startFiscalAutoSync,
  onFiscalQueueChange, onFiscalSynced, getFiscalSyncState, isQueuePersistent
} from './fiscalQueue.js';
import {
  UNIFORM_CATEGORIES, UNIFORM_NOTICE, UNIFORM_MAX_ERRORS, isUniformReq, uniformRuleText, computeUniformPoints, normalizeUniformInspection
} from '../shared/uniforme.js';

const S = {
  user: null, reqs: [], subs: [], regions: [], units: [], queue: [],
  regionId: '', unitId: '', reqId: '',
  erros: {}, obs: {}, loadedKey: '', saving: false, savedAt: null, zoom: null, fqOpen: false,
};

const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const imgSrc = name => `/assets/uniforme/${name}.png`;
const uniformReqs = () => S.reqs.filter(r => r.active !== false && isUniformReq(r));
const curReq = () => uniformReqs().find(r => r.id === S.reqId) || uniformReqs()[0] || null;
const curUnit = () => S.units.find(u => u.id === S.unitId) || null;
const scopeLabel = () => { const u = curUnit(); return u ? `${u.name} · ${rname(u.regionId)}` : ''; };

// avaliação já existente da unidade (nuvem/servidor) ou guardada na fila deste aparelho (a mais nova vence)
function existingFor(req, unit) {
  if (!req || !unit) return null;
  const sub = S.subs.find(s => s.requirementId === req.id && s.unitId === unit.id && s.source === 'judge') || null;
  const q = S.queue.filter(x => x.status === FQ_STATUS.PENDENTE && x.requirementId === req.id && x.unitId === unit.id && x.uniformInspection)
    .sort((a, b) => b.evaluatedAt - a.evaluatedAt)[0] || null;
  return { sub, queued: q };
}

// ── INIT ──────────────────────────────────────────────────────
export function init() {
  const user = guardPage(['judge', 'superadmin', 'admin']);
  if (!user) return;
  S.user = user;
  startExpiryWatcher();
  subReqs(r => { S.reqs = r; render(); });
  subSubs(null, s => { S.subs = s; render(); });
  subRegions(r => { S.regions = r; setRegionCache(r); render(); });
  subUnits(u => { S.units = u; render(); });
  if (LOCAL_APP) {
    requestPersistence();
    onFiscalQueueChange(() => refreshQueue());
    onFiscalSynced(sum => { if (sum.accepted.length) toast(`✅ ${sum.accepted.length} avaliação(ões) enviada(s)`); if (sum.rejected.length) toast(`⚠️ ${sum.rejected[0].message}`, 'error'); if (sum.authExpired) toast('🔒 Sessão expirada — entre de novo', 'error'); });
    onServerChange(() => refreshQueue());
    resolveServer().then(() => refreshQueue());
    startFiscalAutoSync();
    refreshQueue();
  }
  mountPortalBar({
    offsetBottom: '8.5rem',
    getPending: async () => (LOCAL_APP ? (await listFiscalQueue(S.user.id)).filter(q => q.status === FQ_STATUS.PENDENTE).length : 0),
    syncNow: async () => (LOCAL_APP ? syncFiscalNow({ manual: true }) : (await refreshNow(), { sent: 0 }))
  });
  render();
}
let _sig = '';
async function refreshQueue() {
  S.queue = await listFiscalQueue(S.user.id);
  const sy = getFiscalSyncState();
  const sig = JSON.stringify([S.queue.map(q => [q.id, q.status]), sy.syncing, sy.authExpired, getServerState().kind]);
  if (sig !== _sig) { _sig = sig; render(); }
}

// ── ESTADO DO FORMULÁRIO ──────────────────────────────────────
// Ao trocar de unidade/requisito, carrega a inspeção que já existe (para corrigir) ou zera.
function loadForm() {
  const req = curReq(), unit = curUnit();
  const key = `${req?.id || ''}:${unit?.id || ''}`;
  if (key === S.loadedKey) return;
  S.loadedKey = key; S.savedAt = null;
  const ex = existingFor(req, unit);
  const src = ex?.queued?.uniformInspection || ex?.sub?.uniformInspection || null;
  const norm = normalizeUniformInspection(src);
  S.erros = norm.erros; S.obs = norm.observacoes;
}
const totals = () => computeUniformPoints(S.erros, curReq());

// ── RENDER ────────────────────────────────────────────────────
function render() {
  const el = document.getElementById('app');
  if (!el) return;
  const focusId = document.activeElement?.id, selStart = document.activeElement?.selectionStart;
  if (!S.reqId && uniformReqs()[0]) S.reqId = uniformReqs()[0].id;
  loadForm();
  el.innerHTML = vPage() + (S.zoom ? mZoom() : '');
  if (focusId) { const f = document.getElementById(focusId); if (f) { f.focus(); try { if (selStart != null) f.setSelectionRange(selStart, selStart); } catch { /* campo numérico */ } } }
}

function fqBar() {
  if (!LOCAL_APP) return '';
  const srv = getServerState(), sy = getFiscalSyncState(), online = srv.kind === 'local';
  const pend = S.queue.filter(q => q.status === FQ_STATUS.PENDENTE).length;
  return `<div style="background:#fff;border-bottom:1px solid #e2e8f0;padding:.45rem .75rem;font-size:.78rem;display:flex;align-items:center;gap:.5rem;flex-wrap:wrap;">
    <span style="font-weight:700;color:${online ? '#166534' : '#b91c1c'};">${online ? '🟢 Online · servidor local' : '🔴 Sem conexão com o servidor local'}</span>
    ${pend ? `<span style="background:#fef3c7;color:#92400e;font-weight:700;padding:.15rem .55rem;border-radius:999px;">🕓 ${pend} aguardando envio</span>` : ''}
    <span style="flex:1"></span>
    ${pend ? `<button onclick="W.sync()" ${sy.syncing ? 'disabled' : ''} style="background:#2D6A2A;color:#fff;border:none;border-radius:.6rem;padding:.35rem .8rem;font-weight:700;font-size:.78rem;cursor:pointer;">${sy.syncing ? '⏳ Enviando…' : '🔄 Sincronizar agora'}</button>` : ''}
    ${sy.authExpired ? '<div style="flex-basis:100%;color:#92400e;background:#fffbeb;border-radius:.5rem;padding:.35rem .5rem;">🔒 Sessão expirada — entre de novo; a inspeção guardada será enviada.</div>' : ''}
    ${!isQueuePersistent() ? '<div style="flex-basis:100%;color:#92400e;background:#fffbeb;border-radius:.5rem;padding:.35rem .5rem;">⚠️ Este navegador não guarda a fila ao fechar o app — mantenha esta tela aberta até enviar.</div>' : ''}
  </div>`;
}

function catCard(c) {
  const n = S.erros[c.key] || 0;
  return `
  <div id="cat-${c.key}" style="background:#fff;border-radius:1rem;border:1px solid ${c.optional ? '#cbd5e1' : '#e2e8f0'};padding:.9rem;box-shadow:0 1px 3px rgba(0,0,0,.05);">
    <div style="display:flex;align-items:center;justify-content:space-between;gap:.5rem;margin-bottom:.5rem;">
      <div style="font-weight:800;color:#1e293b;font-size:.95rem;">${c.label}</div>
      ${c.optional ? '<span style="background:#f1f5f9;color:#64748b;font-size:.68rem;font-weight:700;padding:.15rem .55rem;border-radius:999px;">Opcional · não desconta</span>' : ''}
    </div>
    <div style="display:flex;gap:.4rem;overflow-x:auto;margin-bottom:.5rem;">
      ${c.images.map(i => `<img src="${imgSrc(i)}" alt="Referência: ${esc(c.label)}" loading="lazy" onclick="W.zoom('${i}')"
        style="height:7.5rem;max-width:100%;width:auto;border-radius:.6rem;border:1px solid #e2e8f0;cursor:zoom-in;object-fit:contain;background:#fff;">`).join('')}
    </div>
    ${c.hint ? `<div style="font-size:.74rem;color:#64748b;margin-bottom:.5rem;">${esc(c.hint)}</div>` : ''}
    <div style="display:flex;align-items:center;gap:.6rem;margin-bottom:.5rem;">
      <span style="font-size:.8rem;font-weight:700;color:#475569;">${c.optional ? 'Quantidade' : 'Erros'}</span>
      <button type="button" onclick="W.step('${c.key}',-1)" aria-label="Menos um erro: ${esc(c.label)}"
        style="width:2.6rem;height:2.6rem;border-radius:.8rem;border:1.5px solid #e2e8f0;background:#f8fafc;font-size:1.3rem;font-weight:800;cursor:pointer;">−</button>
      <input id="n-${c.key}" type="text" inputmode="numeric" pattern="[0-9]*" value="${n}" oninput="W.typed('${c.key}',this)" aria-label="Quantidade de erros: ${esc(c.label)}"
        style="width:4rem;height:2.6rem;text-align:center;font-size:1.15rem;font-weight:800;border:1.5px solid #e2e8f0;border-radius:.8rem;outline:none;">
      <button type="button" onclick="W.step('${c.key}',1)" aria-label="Mais um erro: ${esc(c.label)}"
        style="width:2.6rem;height:2.6rem;border-radius:.8rem;border:none;background:${c.optional ? '#64748b' : '#2D6A2A'};color:#fff;font-size:1.3rem;font-weight:800;cursor:pointer;">+</button>
    </div>
    <textarea id="o-${c.key}" rows="3" placeholder="Observação" oninput="W.note('${c.key}',this.value)"
      style="width:100%;border:1.5px solid #e2e8f0;border-radius:.8rem;padding:.6rem;font-size:.85rem;font-family:inherit;resize:vertical;outline:none;">${esc(S.obs[c.key] || '')}</textarea>
  </div>`;
}

function vPage() {
  const req = curReq(), unit = curUnit(), reqs = uniformReqs();
  const t = totals(), ex = existingFor(req, unit);
  const regionUnits = S.regionId ? S.units.filter(u => u.regionId === S.regionId) : S.units;
  const sel = 'width:100%;border:1.5px solid #e2e8f0;border-radius:.8rem;padding:.75rem;font-size:.9rem;background:#fff;outline:none;';
  const lbl = x => `<label style="display:block;font-size:.78rem;font-weight:700;color:#374151;margin:.1rem 0 .3rem;">${x}</label>`;
  return `
  <div style="min-height:100dvh;background:#eef6ee;padding-bottom:9rem;">
    <div style="background:linear-gradient(135deg,#1d4a1a,#2D6A2A);color:#fff;padding:1rem 1rem 1.25rem;">
      <a href="${portalUrlForUser(S.user)}" style="color:#cfe8ca;font-size:.85rem;text-decoration:none;">← Voltar</a>
      <h1 style="font-size:1.3rem;font-weight:800;margin:.35rem 0 .2rem;">👔 Inspeção de Uniforme</h1>
      <p style="color:#e3f0e2;font-size:.8rem;margin:0;background:rgba(0,0,0,.18);border-radius:.6rem;padding:.45rem .6rem;">ℹ️ ${UNIFORM_NOTICE}</p>
    </div>
    ${fqBar()}
    <div style="padding:1rem;display:flex;flex-direction:column;gap:.75rem;">
      ${!req ? `<div style="background:#fff;border-radius:1rem;padding:1.5rem;text-align:center;color:#64748b;">
          <div style="font-size:2.5rem;">👔</div>
          <p style="font-weight:700;margin:.5rem 0 .25rem;">Requisito de Inspeção de uniforme não cadastrado</p>
          <p style="font-size:.85rem;margin:0;">O administrador precisa criar o requisito (Requisitos → Novo → marcar “Inspeção de uniforme”).</p></div>` : `
      <div style="background:#fff;border-radius:1rem;padding:.9rem;border:1px solid #e2e8f0;display:grid;gap:.5rem;">
        <div style="display:grid;grid-template-columns:1fr 1fr;gap:.6rem;">
          <div>${lbl('Região')}<select id="f-region" onchange="W.pickRegion(this.value)" style="${sel}">
            <option value="">— todas —</option>${S.regions.map(r => `<option value="${r.id}" ${S.regionId === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></div>
          <div>${lbl('Unidade *')}<select id="f-unit" onchange="W.pickUnit(this.value)" style="${sel}">
            <option value="">Selecione…</option>${regionUnits.map(u => `<option value="${u.id}" ${S.unitId === u.id ? 'selected' : ''}>${esc(u.name)}${S.regionId ? '' : ' · ' + esc(rname(u.regionId))}</option>`).join('')}</select></div>
        </div>
        ${reqs.length > 1 ? `<div>${lbl('Requisito')}<select id="f-req" onchange="W.pickReq(this.value)" style="${sel}">${reqs.map(r => `<option value="${r.id}" ${req.id === r.id ? 'selected' : ''}>${esc(r.name)}</option>`).join('')}</select></div>` : ''}
        <div>${lbl('Avaliador')}<div style="padding:.65rem .75rem;border-radius:.8rem;background:#f1f5f9;color:#334155;font-size:.88rem;">${esc(S.user.name)} · <span id="now-stamp">${new Date().toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' })}</span></div></div>
        <div style="font-size:.78rem;color:#475569;background:#f0fdf4;border-radius:.6rem;padding:.45rem .6rem;">${esc(uniformRuleText(req))}</div>
        ${ex?.sub || ex?.queued ? `<div style="font-size:.78rem;color:#92400e;background:#fffbeb;border-radius:.6rem;padding:.45rem .6rem;">
          ${ex.queued ? `🕓 Há uma inspeção desta unidade guardada neste aparelho (${ex.queued.points} pts) aguardando envio.` : `Esta unidade já foi inspecionada${ex.sub.uniformInspection?.avaliadoEm ? ' em ' + new Date(ex.sub.uniformInspection.avaliadoEm).toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : ''} (${ex.sub.requirementPoints} pts — ${ex.sub.status === 'approved' ? 'aprovada' : ex.sub.status === 'rejected' ? 'rejeitada' : 'aguardando aprovação'}).`}
          Salvar de novo <strong>substitui</strong> a anterior (vale a mais recente).</div>` : ''}
      </div>
      ${unit ? UNIFORM_CATEGORIES.map(catCard).join('') : '<div style="text-align:center;color:#64748b;padding:1.5rem;">Selecione a unidade para iniciar a inspeção.</div>'}`}
    </div>
    ${req && unit ? `
    <div style="position:fixed;left:0;right:0;bottom:0;z-index:40;background:#fff;border-top:1px solid #e2e8f0;padding:.7rem 1rem;box-shadow:0 -4px 16px rgba(0,0,0,.08);">
      <div id="totals" style="display:flex;justify-content:space-between;align-items:baseline;margin-bottom:.5rem;">${totalsHtml(t)}</div>
      <button onclick="W.save()" ${S.saving ? 'disabled' : ''} style="width:100%;background:#2D6A2A;color:#fff;border:none;padding:.95rem;border-radius:.9rem;font-size:1rem;font-weight:800;cursor:pointer;opacity:${S.saving ? .6 : 1};">
        ${S.saving ? '⏳ Salvando…' : '💾 Salvar inspeção'}</button>
      ${S.savedAt ? `<div style="text-align:center;font-size:.75rem;color:#166534;margin-top:.35rem;">Salva às ${S.savedAt}</div>` : ''}
    </div>` : ''}
  </div>`;
}
const totalsHtml = t => `<div style="font-size:.85rem;color:#475569;">${t.totalErros} erro${t.totalErros === 1 ? '' : 's'} · −${t.descontados} pts${t.opcionais ? ` · ${t.opcionais} opcional(is)` : ''}</div>
  <div style="font-size:1.15rem;font-weight:800;color:#166534;">${t.pontos} <span style="font-size:.8rem;color:#64748b;font-weight:600;">/ ${t.max} pts</span></div>`;
const mZoom = () => `<div class="modal-overlay center" onclick="W.zoom(null)" style="z-index:80;"><img src="${imgSrc(S.zoom)}" alt="Referência ampliada" style="max-width:100%;max-height:90dvh;background:#fff;border-radius:1rem;"></div>`;
const refreshTotals = () => { const e = document.getElementById('totals'); if (e) e.innerHTML = totalsHtml(totals()); };

// ── AÇÕES ─────────────────────────────────────────────────────
window.W = {
  pickRegion(id) { S.regionId = id; if (S.unitId && id && curUnit()?.regionId !== id) S.unitId = ''; render(); },
  pickUnit(id) { S.unitId = id; const u = curUnit(); if (u) S.regionId = u.regionId; render(); },   // ao escolher a unidade a região é preenchida sozinha
  pickReq(id) { S.reqId = id; render(); },
  step(key, d) {
    S.erros[key] = Math.max(0, Math.min(UNIFORM_MAX_ERRORS, (S.erros[key] || 0) + d));
    const i = document.getElementById(`n-${key}`); if (i) i.value = S.erros[key];
    refreshTotals();
  },
  typed(key, input) {
    const n = Math.min(UNIFORM_MAX_ERRORS, parseInt(input.value.replace(/\D/g, ''), 10) || 0);
    S.erros[key] = n;
    if (input.value !== '' && input.value !== String(n)) input.value = n;
    refreshTotals();
  },
  note(key, v) { S.obs[key] = v; },
  zoom(name) { S.zoom = name; render(); },
  async sync() {
    const sum = await syncFiscalNow({ manual: true });
    toast(sum.accepted.length ? `✅ ${sum.accepted.length} enviada(s)` : sum.offline ? '📡 Sem conexão com o servidor local' : 'Nada pendente', sum.offline ? 'error' : 'info');
  },
  async save() {
    const req = curReq(), unit = curUnit();
    if (!req || !unit || S.saving) return;
    const inspection = normalizeUniformInspection({ erros: S.erros, observacoes: S.obs });
    const pts = computeUniformPoints(inspection.erros, req).pontos;
    const ex = existingFor(req, unit);
    S.saving = true; render();
    try {
      if (LOCAL_APP) {
        const item = await saveFiscalEvaluation({
          user: S.user, req, regionId: unit.regionId, unitId: unit.id, points: pts, existingSubId: ex?.sub?.id || null,
          scopeLabel: scopeLabel(), uniformInspection: inspection
        }, { waitMs: Math.min(TIMEOUTS.immediateScan, 4000) });
        await refreshQueue();
        if (item.status === FQ_STATUS.ENVIADO) toast(`✅ ${req.name} — ${pts} pts (aguardando aprovação)`);
        else if (item.status === FQ_STATUS.SUBSTITUIDO) toast('ℹ️ Já existia uma inspeção mais recente desta unidade — a sua foi ignorada', 'info');
        else if (item.status === FQ_STATUS.REJEITADO) toast(`⚠️ Inspeção não aceita: ${item.message}`, 'error');
        else toast(`📥 Inspeção guardada no aparelho (${pts} pts). Será enviada quando o servidor local voltar.`, 'info');
      } else {
        await doUniformInspection(req, unit, inspection, S.user, ex?.sub?.id || null);
      }
      S.savedAt = new Date().toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
    } catch (e) {
      toast('Erro ao salvar. Tente novamente.', 'error');
    }
    S.saving = false; render();
  },
};
