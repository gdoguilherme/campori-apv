// Service worker — cache do APP SHELL (HTML/CSS/JS/logos + bibliotecas de CDN) para o app
// ABRIR e RENDERIZAR sem rede. NÃO cacheia dados (Firestore, API, uploads): só intercepta
// os arquivos listados/allowlisted abaixo; qualquer outra requisição passa direto à rede.
// A lista e a VERSION são geradas por `node scripts/build-sw.mjs` (rodar antes de cada deploy).

/* BUILD:START */
const VERSION = '2ac578c2e1';
const SHELL = [
  "/assets/favicon/favicon-16.png",
  "/assets/favicon/favicon-180.png",
  "/assets/favicon/favicon-32.png",
  "/assets/logo-apv.png",
  "/assets/logo-avt.png",
  "/assets/logo-dbv.png",
  "/assets/logo-integros-completo.png",
  "/assets/logo-integros-selo.png",
  "/assets/pwa/apple-touch-icon.png",
  "/css/avt.css",
  "/css/base.css",
  "/css/dbv.css",
  "/js/admin.js",
  "/js/api-local.js",
  "/js/api.js",
  "/js/auth.js",
  "/js/config.js",
  "/js/conselheiro.js",
  "/js/firebase-stub.js",
  "/js/firebase.js",
  "/js/fiscal.js",
  "/js/net.js",
  "/js/offlineDb.js",
  "/js/pwa.js",
  "/js/ranking.js",
  "/js/regiao.js",
  "/js/scanQueue.js",
  "/manifest.json",
  "/pages/admin.html",
  "/pages/conselheiro.html",
  "/pages/fiscal.html",
  "/pages/login.html",
  "/pages/regiao/avt.html",
  "/pages/regiao/dbv.html",
  "/shared/scoring.js",
  "/shared/sync.js"
];
/* BUILD:END */

// Bibliotecas externas que as páginas carregam (precisam estar em cache pro app abrir offline).
// Versionadas → cache-first; o Tailwind do CDN não tem versão fixa → stale-while-revalidate.
const EXTERNAL = [
  'https://cdn.tailwindcss.com',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js',
  'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js',
  'https://unpkg.com/html5-qrcode@2.3.8/html5-qrcode.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/qrcodejs/1.0.0/qrcode.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js',
];
const SWR_EXTERNAL = new Set(['https://cdn.tailwindcss.com/']);

// Origem do SERVIDOR LOCAL do evento (https://local.gdtmidia.com.br ou http://localhost:8787): lá as bibliotecas de CDN
// são servidas de /vendor e a página /ajuda existe. Na nuvem (Vercel) nada disto é requisitado.
const IS_LOCAL_ORIGIN = self.location.hostname === 'local.gdtmidia.com.br' || self.location.port === '8787';
const LOCAL_ONLY = ['/vendor/tailwindcss-3.4.17.js', '/vendor/xlsx.full.min.js', '/vendor/qrcode.min.js', '/vendor/html5-qrcode.min.js', '/ajuda'];

const CACHE = `campori-shell-${VERSION}`;

// fetch com prazo: o SW também não pode ficar pendurado em rede ruim (Starlink caindo)
function timed(input, init = {}, ms = 12000) {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), ms);
  return fetch(input, { ...init, signal: ctl.signal }).finally(() => clearTimeout(t));
}

// Respostas que passaram por redirect NÃO podem ser servidas a uma navegação; guardamos uma
// cópia "limpa" (mesmo corpo/headers, sem a flag redirected).
async function plain(res) {
  if (!res.redirected) return res;
  return new Response(await res.blob(), { status: res.status, statusText: res.statusText, headers: res.headers });
}
const FALLBACK_PAGE = '/pages/login.html';
const SHELL_SET = new Set(SHELL);
const EXTERNAL_SET = new Set(EXTERNAL.map(u => new URL(u).href));

self.addEventListener('install', event => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE);
    // Arquivos do próprio site: tudo-ou-nada (um shell incompleto não abre offline)
    await Promise.all(SHELL.map(async url => {
      const res = await timed(url, { cache: 'reload' }, 30000);
      if (!res.ok) throw new Error(`precache falhou: ${url} (${res.status})`);
      await cache.put(url, await plain(res));
    }));
    // CDNs: melhor esforço (um CDN fora do ar não deve impedir a instalação);
    // o que faltar é completado em runtime e reportado ao pwa.js
    await Promise.all(EXTERNAL.map(async url => {
      try {
        let res;
        try { res = await timed(url, { mode: 'cors' }, 20000); } catch { res = await timed(url, { mode: 'no-cors' }, 20000); }
        if (res.ok || res.type === 'opaque') await cache.put(url, res);
      } catch { /* sem rede agora; tenta de novo no próximo update do SW */ }
    }));
    // Só no servidor local: bibliotecas (/vendor) e ajuda também ficam em cache para abrir sem rede
    if (IS_LOCAL_ORIGIN) {
      await Promise.all(LOCAL_ONLY.map(async url => {
        try { const res = await timed(url, { cache: 'reload' }, 30000); if (res.ok) await cache.put(url, await plain(res)); } catch { /* tenta de novo em runtime */ }
      }));
    }
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', event => {
  event.waitUntil((async () => {
    for (const k of await caches.keys()) if (k.startsWith('campori-shell-') && k !== CACHE) await caches.delete(k);
    await self.clients.claim();
  })());
});

self.addEventListener('message', async event => {
  if (event.data !== 'status') return;
  const cache = await caches.open(CACHE);
  const missing = [];
  for (const u of [...SHELL, ...EXTERNAL]) if (!(await cache.match(u))) missing.push(u);
  event.source?.postMessage({ type: 'sw-status', version: VERSION, cached: SHELL.length + EXTERNAL.length - missing.length, missing });
});

// Páginas aceitam variações de URL ("/pages/login", "?x=1") → tenta achar a versão .html em cache
async function matchPage(cache, url) {
  const u = new URL(url);
  return (await cache.match(u.origin + u.pathname)) ||
         (await cache.match(u.origin + u.pathname + '.html')) ||
         (u.pathname === '/' || u.pathname === '/index.html' ? await cache.match(FALLBACK_PAGE) : undefined);
}

async function staleWhileRevalidate(event, { navigate }) {
  const cache = await caches.open(CACHE);
  const req = event.request;
  const cached = navigate ? await matchPage(cache, req.url) : await cache.match(req, { ignoreSearch: true });
  // navegação usa redirect:'manual'; pra buscar de verdade seguimos redirects e guardamos a cópia limpa
  const network = timed(navigate ? new Request(req.url, { credentials: 'same-origin' }) : req).then(async res => {
    if (res && (res.ok || res.type === 'opaque')) {
      const copy = res.clone();
      cache.put(navigate ? new URL(req.url).origin + new URL(req.url).pathname : req, await plain(copy)).catch(() => {});
    }
    return navigate && res.redirected ? plain(res) : res;
  }).catch(() => null);
  event.waitUntil(network);
  if (cached) return cached;
  const res = await network;
  if (res) return res;
  // Sem rede e sem cache: navegação cai no login (que já está no shell), resto é erro de rede normal
  if (navigate) { const fb = await cache.match(FALLBACK_PAGE); if (fb) return fb; }
  return Response.error();
}

async function cacheFirst(event) {
  const cache = await caches.open(CACHE);
  const hit = await cache.match(event.request);
  if (hit) return hit;
  const res = await timed(event.request);
  if (res && (res.ok || res.type === 'opaque')) cache.put(event.request, res.clone()).catch(() => {});
  return res;
}

self.addEventListener('fetch', event => {
  const req = event.request;
  if (req.method !== 'GET') return;
  const url = new URL(req.url);

  if (url.origin === self.location.origin) {
    const navigate = req.mode === 'navigate';
    const isShell = SHELL_SET.has(url.pathname) || (IS_LOCAL_ORIGIN && url.pathname.startsWith('/vendor/'));
    const isPage = navigate && (url.pathname.startsWith('/pages/') || url.pathname === '/' || url.pathname === '/index.html' || (IS_LOCAL_ORIGIN && url.pathname === '/ajuda'));
    if (isShell || isPage) return event.respondWith(staleWhileRevalidate(event, { navigate }));
    return; // API, /files, /health, uploads… nunca interceptados
  }

  const href = url.href;
  if (EXTERNAL_SET.has(href) || EXTERNAL_SET.has(href.replace(/\/$/, ''))) {
    return event.respondWith(SWR_EXTERNAL.has(href) ? staleWhileRevalidate(event, { navigate: false }) : cacheFirst(event));
  }
  // demais origens (Firestore, Fly.io, Google Drive…) → rede direta, sem cache
});
