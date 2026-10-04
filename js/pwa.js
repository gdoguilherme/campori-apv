// PWA: registra o service worker (app shell offline) e mostra o convite de instalação.
// Carregado por todas as páginas via <script src="/js/pwa.js" defer>.
(function () {
  const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', () => {
      navigator.serviceWorker.register('/sw.js').then(reg => {
        // diagnóstico: window.__pwaStatus() no console mostra o que está em cache
        window.__pwaStatus = () => new Promise(res => {
          const onMsg = e => { if (e.data?.type === 'sw-status') { navigator.serviceWorker.removeEventListener('message', onMsg); res(e.data); } };
          navigator.serviceWorker.addEventListener('message', onMsg);
          (reg.active || navigator.serviceWorker.controller)?.postMessage('status');
        });
      }).catch(err => console.warn('[pwa] service worker não registrado:', err.message));
    });
  }

  // ── Convite de instalação (fora do #app, que é re-renderizado a cada mudança de dados) ──
  const KEY = 'campori_pwa_install_dismissed';
  const dismissed = () => { try { return localStorage.getItem(KEY) === '1'; } catch { return false; } };
  const ua = navigator.userAgent;
  const isIos = /iphone|ipad|ipod/i.test(ua) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isIosSafari = isIos && /safari/i.test(ua) && !/crios|fxios|edgios/i.test(ua);
  let deferredPrompt = null;

  function banner(html, onInstall) {
    if (standalone || dismissed() || document.getElementById('pwa-install')) return;
    const el = document.createElement('div');
    el.id = 'pwa-install';
    el.style.cssText = 'position:fixed;left:.75rem;right:.75rem;bottom:calc(.75rem + env(safe-area-inset-bottom,0px));z-index:997;' +
      'background:#0D2B6E;color:#fff;border-radius:1rem;padding:.75rem .875rem;display:flex;align-items:center;gap:.625rem;' +
      'box-shadow:0 8px 28px rgba(0,0,0,.35);font:600 .82rem/1.3 system-ui,sans-serif;max-width:420px;margin:0 auto;border:1px solid #D4A017;';
    el.innerHTML = `<img src="/assets/favicon/favicon-32.png" width="32" height="32" alt="" style="flex:none">
      <div style="flex:1">${html}</div>
      ${onInstall ? '<button id="pwa-yes" style="background:#D4A017;color:#1e293b;border:none;border-radius:.625rem;padding:.5rem .75rem;font-weight:800;cursor:pointer">Instalar</button>' : ''}
      <button id="pwa-no" aria-label="Fechar" style="background:none;border:none;color:#cbd5e1;font-size:1.1rem;cursor:pointer;padding:.25rem">✕</button>`;
    document.body.appendChild(el);
    el.querySelector('#pwa-no').onclick = () => { try { localStorage.setItem(KEY, '1'); } catch {} el.remove(); };
    if (onInstall) el.querySelector('#pwa-yes').onclick = () => { el.remove(); onInstall(); };
  }

  // Android/Chrome/Edge: o navegador avisa quando o app é instalável
  window.addEventListener('beforeinstallprompt', e => {
    e.preventDefault();
    deferredPrompt = e;
    banner('📲 Instale o app <b>ÍNTEGROS</b> para abrir mais rápido e sem barra do navegador.', async () => {
      deferredPrompt.prompt();
      await deferredPrompt.userChoice.catch(() => {});
      deferredPrompt = null;
    });
  });
  window.addEventListener('appinstalled', () => document.getElementById('pwa-install')?.remove());

  // iPhone/iPad: não existe prompt automático — mostra o passo a passo
  if (isIosSafari && !standalone) {
    window.addEventListener('load', () => setTimeout(() =>
      banner('📲 Para instalar: toque em <b>Compartilhar</b> <span style="font-size:1rem">⎙</span> e depois em <b>“Adicionar à Tela de Início”</b>.'), 1500));
  }
})();
