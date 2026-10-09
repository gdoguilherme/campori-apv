// Barra discreta de TODOS os portais: bolinha 🟢/🟡/🔴 + contagem de itens aguardando, botão "Sincronizar agora",
// versão do app (hash do sw.js) e "Atualizar app" (força o service worker novo e recarrega SEM apagar fila nem sessão).
// Fica fora do #app (que é redesenhado a cada dado novo).
import { LOCAL_APP } from './config.js';
import { getToken } from './auth.js';
import { fetchJson } from './net.js';

// Estado da bolinha — função pura (testada em local-server/test/portal-bar.test.js)
export function barState({ local = false, onLine = true, serverUp = true, pendingDevice = 0, pendingCloud = 0, cloudState = null, authExpired = false } = {}) {
  const pending = Math.max(0, pendingDevice) + Math.max(0, pendingCloud);
  if (local && !serverUp) return { color: 'red', icon: '🔴', pending, text: 'Sem conexão com o servidor local' };
  if (!local && !onLine) return { color: 'red', icon: '🔴', pending, text: 'Sem internet' };
  if (authExpired) return { color: 'yellow', icon: '🟡', pending, text: 'Sessão expirada — entre de novo (nada se perde)' };
  if (pending > 0) return { color: 'yellow', icon: '🟡', pending, text: `${pending} item(ns) aguardando envio` };
  if (local && cloudState && !['online', 'disabled', 'demo', 'unconfigured', 'unknown'].includes(cloudState)) {
    return { color: 'green', icon: '🟢', pending, text: 'Servidor local OK · nuvem fora do ar (normal sem internet)' };
  }
  return { color: 'green', icon: '🟢', pending, text: local ? 'Tudo certo · servidor local' : 'Tudo certo' };
}

const VERSION_RE = /const VERSION = '([0-9a-f]+)'/;
async function latestVersion() {
  try { const r = await fetch('/sw.js', { cache: 'no-store' }); return (await r.text()).match(VERSION_RE)?.[1] || null; } catch { return null; }
}
function runningVersion() {
  return new Promise(res => {
    const ctl = navigator.serviceWorker?.controller;
    if (!ctl) return res(null);
    const t = setTimeout(() => { navigator.serviceWorker.removeEventListener('message', on); res(null); }, 1500);
    const on = e => { if (e.data?.type === 'sw-status') { clearTimeout(t); navigator.serviceWorker.removeEventListener('message', on); res(e.data.version || null); } };
    navigator.serviceWorker.addEventListener('message', on);
    ctl.postMessage('status');
  });
}

// Força a busca do service worker novo e recarrega. localStorage (sessão) e IndexedDB (filas) NÃO são tocados.
export async function updateApp() {
  const reg = await navigator.serviceWorker?.getRegistration?.();
  if (!reg) { location.reload(); return { reloaded: true }; }
  const before = await latestVersion();
  if (before === null) return { reloaded: false, offline: true };   // sem servidor: não derruba o app que já funciona
  await reg.update();
  await new Promise(res => {
    if (!reg.installing && !reg.waiting) return res();
    const w = reg.installing || reg.waiting;
    const t = setTimeout(res, 20_000);
    w.addEventListener('statechange', () => { if (w.state === 'activated' || w.state === 'redundant') { clearTimeout(t); res(); } });
  });
  location.reload();
  return { reloaded: true };
}

export function mountPortalBar({ getPending = null, syncNow = null, offsetBottom = '.6rem', showSync = true } = {}) {
  if (typeof document === 'undefined' || document.getElementById('portal-bar')) return () => {};
  const root = document.createElement('div');
  root.id = 'portal-bar';
  root.style.cssText = `position:fixed;left:.6rem;bottom:calc(${offsetBottom} + env(safe-area-inset-bottom,0px));z-index:996;font:600 .78rem/1.3 system-ui,sans-serif;`;
  document.body.appendChild(root);

  let st = barState({ local: LOCAL_APP }), open = false, busy = false, msg = '', versions = { running: null, latest: null }, stopped = false;

  function paint() {
    const ver = versions.running ? `v${versions.running}` : 'versão ?';
    const newer = versions.latest && versions.running && versions.latest !== versions.running;
    const fg = { green: '#166534', yellow: '#92400e', red: '#b91c1c' }[st.color];
    root.innerHTML = `
      ${open ? `<div style="background:#fff;color:#1e293b;border:1px solid #e2e8f0;border-radius:.9rem;box-shadow:0 8px 28px rgba(0,0,0,.25);padding:.7rem .8rem;margin-bottom:.4rem;min-width:15.5rem;max-width:20rem;">
        <div style="font-weight:800;color:${fg};">${st.icon} ${st.text}</div>
        ${showSync ? `<button id="pb-sync" ${busy ? 'disabled' : ''} style="margin-top:.5rem;width:100%;background:#0D2B6E;color:#fff;border:none;border-radius:.6rem;padding:.55rem;font-weight:800;cursor:pointer;opacity:${busy ? .6 : 1};">${busy ? '⏳ Sincronizando…' : '🔄 Sincronizar agora'}</button>` : ''}
        ${msg ? `<div style="margin-top:.4rem;color:#475569;font-weight:600;">${msg}</div>` : ''}
        <div style="margin-top:.55rem;padding-top:.5rem;border-top:1px solid #e2e8f0;display:flex;align-items:center;gap:.5rem;color:#64748b;">
          <span style="flex:1;">App ${ver}${newer ? ' · <b style="color:#b45309;">🆕 nova versão disponível</b>' : ''}</span>
          <button id="pb-update" style="background:${newer ? '#b45309' : '#f1f5f9'};color:${newer ? '#fff' : '#334155'};border:none;border-radius:.5rem;padding:.35rem .6rem;font-weight:700;cursor:pointer;">⟳ Atualizar app</button>
        </div></div>` : ''}
      <button id="pb-pill" aria-label="Estado da sincronização" style="display:flex;align-items:center;gap:.35rem;background:#fff;color:${fg};border:1.5px solid #e2e8f0;border-radius:999px;padding:.3rem .65rem;box-shadow:0 2px 10px rgba(0,0,0,.18);cursor:pointer;font:inherit;">
        <span style="font-size:.95rem;">${st.icon}</span>${st.pending ? `<span>${st.pending}</span>` : ''}${newer ? '<span>🆕</span>' : ''}</button>`;
    root.querySelector('#pb-pill').onclick = () => { open = !open; msg = ''; paint(); if (open) refreshVersions(); };
    root.querySelector('#pb-sync')?.addEventListener('click', doSync);
    root.querySelector('#pb-update')?.addEventListener('click', doUpdate);
  }

  async function refresh() {
    if (stopped || document.hidden) return;
    let pendingDevice = 0, pendingCloud = 0, cloudState = null, serverUp = true, authExpired = false;
    try { pendingDevice = (await getPending?.()) || 0; } catch { /* sem fila neste portal */ }
    if (LOCAL_APP) {
      try {
        const tk = getToken();
        const { ok, status, data } = await fetchJson(`${location.origin}/sync/state`, { headers: tk ? { Authorization: `Bearer ${tk}` } : {}, cache: 'no-store' }, 3000);
        if (status === 401) authExpired = !!tk;   // sem login (tela de entrada) não é "sessão expirada"
        else if (ok) { pendingCloud = data.pendingCloud || 0; cloudState = data.cloud?.state || null; }
      } catch { serverUp = false; }
    }
    st = barState({ local: LOCAL_APP, onLine: navigator.onLine !== false, serverUp, pendingDevice, pendingCloud, cloudState, authExpired });
    paint();
  }
  async function refreshVersions() { versions = { running: await runningVersion(), latest: await latestVersion() }; paint(); }

  async function doSync() {
    if (busy) return;
    busy = true; msg = ''; paint();
    try {
      const sum = await syncNow?.();
      let cloudMsg = '';
      if (LOCAL_APP) {
        try {
          const tk = getToken();
          const { data } = await fetchJson(`${location.origin}/sync/cloud-now`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(tk ? { Authorization: `Bearer ${tk}` } : {}) }, body: '{}' }, 25_000);
          cloudMsg = data.disabled ? '' : data.offline ? ' Nuvem: sem internet agora (os dados continuam salvos no PC).' : data.ok ? ' Nuvem: tudo enviado.' : ` Nuvem: ${data.message || 'aguardando'}`;
        } catch { cloudMsg = ' Servidor local não respondeu.'; }
      }
      const sent = (sum?.accepted?.length ?? sum?.sent ?? 0);
      msg = (sum?.offline ? 'Sem conexão com o servidor.' : sum?.authExpired ? 'Sessão expirada — entre de novo.' : sent ? `✅ ${sent} item(ns) enviado(s).` : 'Nada pendente neste aparelho.') + cloudMsg;
    } catch (e) { msg = `Não foi possível sincronizar: ${e.message}`; }
    busy = false;
    await refresh();
  }
  async function doUpdate() {
    msg = 'Procurando atualização…'; paint();
    try {
      const r = await updateApp();
      if (r.offline) { msg = 'Sem conexão com o servidor — não deu para atualizar agora. O app atual continua funcionando.'; paint(); }
    } catch (e) { msg = `Falha ao atualizar: ${e.message}`; paint(); }
  }

  const tick = setInterval(refresh, 5000);
  const onVis = () => refresh();
  document.addEventListener('visibilitychange', onVis);
  window.addEventListener('online', onVis); window.addEventListener('offline', onVis);
  paint(); refresh(); refreshVersions();
  return () => { stopped = true; clearInterval(tick); document.removeEventListener('visibilitychange', onVis); window.removeEventListener('online', onVis); window.removeEventListener('offline', onVis); root.remove(); };
}
