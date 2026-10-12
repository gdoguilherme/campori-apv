// Etapa 2 — acesso sem instalação prévia: a raiz abre o app, as páginas não dependem de CDN, /ajuda, e o PWA é instalável
// a partir da origem local.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { Store } from '../src/db.js';
import { createApp } from '../src/app.js';
import { REPO_ROOT } from '../src/config.js';
import { createPageInjector, VENDOR_MAP } from '../src/html-inject.js';

let server, port, store;
const config = (extra = {}) => ({ port: 0, qrSecret: 's', jwtSecret: 'j', qrSecretIsDev: false, version: 't', uploadDir: '/tmp', corsOrigins: [],
  frontendDir: REPO_ROOT, vendorDir: path.resolve(REPO_ROOT, 'local-server', 'vendor'), helpWifiName: '', helpWifiPassword: '', localAppMode: false, ...extra });
const start = async cfg => {
  const s = new Store(':memory:');
  const app = createApp({ store: s, config: cfg, log: { info() {}, warn() {}, error() {} } });
  const srv = await new Promise(r => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  return { srv, store: s, port: srv.address().port, stop: () => new Promise(r => { srv.closeAllConnections?.(); srv.close(() => { s.close(); r(); }); }) };
};
const get = (p, urlPath, headers = {}) => new Promise((resolve, reject) => {
  http.get({ host: '127.0.0.1', port: p, path: urlPath, headers }, res => { const c = []; res.on('data', d => c.push(d)); res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, buf: Buffer.concat(c), text: Buffer.concat(c).toString('utf8') })); }).on('error', reject);
});
before(async () => { const x = await start(config()); ({ srv: server, port, store } = x); server.stop = x.stop; });
after(() => server.stop());

const PAGES = ['login', 'admin', 'fiscal', 'conselheiro', 'regiao/dbv', 'regiao/avt'];

test('a raiz abre o app: / redireciona para o login (e /index.html é servido)', async () => {
  const r = await get(port, '/');
  assert.equal(r.status, 302); assert.equal(r.headers.location, '/pages/login.html');
  assert.equal((await get(port, '/pages/login.html')).status, 200);
  assert.equal((await get(port, '/index.html')).status, 200);
});

test('bibliotecas de terceiros servidas localmente: os 4 arquivos existem, são JS de verdade e têm tamanho de biblioteca', async () => {
  for (const [file, minKb] of [['tailwindcss-3.4.17.js', 300], ['xlsx.full.min.js', 700], ['qrcode.min.js', 15], ['html5-qrcode.min.js', 300]]) {
    const r = await get(port, `/vendor/${file}`);
    assert.equal(r.status, 200, file); assert.match(r.headers['content-type'], /javascript/, file);
    assert.ok(r.buf.length > minKb * 1000, `${file}: ${r.buf.length} bytes`);
    assert.ok(!/<html|<!doctype/i.test(r.text.slice(0, 200)), `${file} não é uma página de erro`);
  }
});

test('TODAS as páginas servidas pelo servidor local ficam SEM script de CDN externo (abrem sem internet)', async () => {
  for (const p of PAGES) {
    const r = await get(port, `/pages/${p}.html`);
    assert.equal(r.status, 200, p); assert.match(r.headers['content-type'], /html/);
    const external = [...r.text.matchAll(/<script[^>]*\bsrc=["'](https?:\/\/[^"']+)["']/gi)].map(m => m[1]);
    assert.deepEqual(external, [], `${p} ainda carrega: ${external}`);
    assert.match(r.text, /<link rel="help" href="\/ajuda">/);
  }
  // as que usam biblioteca apontam para /vendor
  assert.match((await get(port, '/pages/login.html')).text, /src="\/vendor\/tailwindcss-3\.4\.17\.js"/);
  assert.match((await get(port, '/pages/admin.html')).text, /src="\/vendor\/xlsx\.full\.min\.js"/);
  assert.match((await get(port, '/pages/fiscal.html')).text, /src="\/vendor\/qrcode\.min\.js"/);
  assert.match((await get(port, '/pages/conselheiro.html')).text, /src="\/vendor\/html5-qrcode\.min\.js"/);
});

test('o arquivo ORIGINAL no repositório (o que a nuvem/Vercel serve) NÃO é alterado: continua com os CDNs', () => {
  const login = fs.readFileSync(path.join(REPO_ROOT, 'pages', 'login.html'), 'utf8');
  assert.match(login, /https:\/\/cdn\.tailwindcss\.com/); assert.doesNotMatch(login, /\/vendor\//); assert.doesNotMatch(login, /rel="help"/);
});

test('botão de ajuda só na tela de login; /ajuda é pública e explica Wi-Fi + instalação (Android e iPhone) com QR code', async () => {
  assert.match((await get(port, '/pages/login.html')).text, /href='\/ajuda'|a\.href='\/ajuda'/);
  assert.doesNotMatch((await get(port, '/pages/admin.html')).text, /a\.href='\/ajuda'/);
  const r = await get(port, '/ajuda');
  assert.equal(r.status, 200); assert.match(r.headers['content-type'], /html/);
  for (const re of [/Wi-Fi/, /Instalar app/, /Adicionar à Tela de Início/, /dados móveis/, /QRCode/, /\/vendor\/qrcode\.min\.js/, /Ir para o login/]) assert.match(r.text, re);
  assert.doesNotMatch(r.text, /<script[^>]*src=["']https?:/i, 'a ajuda também não depende de internet');
  assert.equal((await get(port, '/ajuda.html')).status, 200);
  assert.doesNotMatch(r.text, /\{\{/, 'sem marcadores sobrando');
  assert.match(r.text, /display:none/, 'sem nome de Wi-Fi configurado, o cartão do Wi-Fi fica escondido');
});

test('ajuda com o Wi-Fi do evento configurado (nome e senha), escapado contra HTML', async () => {
  const x = await start(config({ helpWifiName: 'Campori <APV>', helpWifiPassword: 'senha"123' }));
  try {
    const r = await get(x.port, '/ajuda');
    assert.match(r.text, /Campori &lt;APV&gt;/); assert.match(r.text, /senha&quot;123/); assert.doesNotMatch(r.text, /<APV>/);
    assert.doesNotMatch(r.text.match(/id="wifiCard" style="([^"]*)"/)[1], /display:none/);
  } finally { await x.stop(); }
});

test('PWA instalável a partir da origem local: manifest, ícones, start_url, service worker e escopo', async () => {
  const m = await get(port, '/manifest.json');
  assert.equal(m.status, 200); assert.match(m.headers['content-type'], /manifest\+json/);
  const man = JSON.parse(m.text);
  assert.equal(man.display, 'standalone'); assert.equal(man.start_url, '/pages/login.html'); assert.equal(man.scope, '/');
  const sizes = man.icons.map(i => i.sizes); assert.ok(sizes.includes('192x192') && sizes.includes('512x512'));
  assert.ok(man.icons.some(i => i.purpose === 'maskable'));
  for (const i of man.icons) { const r = await get(port, i.src); assert.equal(r.status, 200, i.src); assert.match(r.headers['content-type'], /image\/png/); }
  assert.equal((await get(port, man.start_url)).status, 200, 'start_url responde 200');
  const sw = await get(port, '/sw.js');
  assert.equal(sw.status, 200); assert.match(sw.headers['content-type'], /javascript/); assert.equal(sw.headers['service-worker-allowed'], '/'); assert.match(sw.headers['cache-control'], /no-cache/);
  const login = (await get(port, '/pages/login.html')).text;
  assert.match(login, /rel="manifest" href="\/manifest\.json"/); assert.match(login, /<script src="\/js\/pwa\.js" defer>/);
  // o service worker conhece /vendor e /ajuda (cache p/ abrir sem rede) só na origem local
  assert.match(sw.text, /IS_LOCAL_ORIGIN/); assert.match(sw.text, /\/vendor\/tailwindcss-3\.4\.17\.js/);
});

test('o service worker NÃO faz requisição nova na origem da nuvem (isolamento por origem)', () => {
  const sw = fs.readFileSync(path.join(REPO_ROOT, 'sw.js'), 'utf8');
  assert.match(sw, /const IS_LOCAL_ORIGIN = self\.location\.hostname === 'local\.gdtmidia\.com\.br' \|\| self\.location\.port === '8787'/);
  assert.match(sw, /if \(IS_LOCAL_ORIGIN\) \{\s*await Promise\.all\(LOCAL_ONLY/, 'pré-cache de /vendor e /ajuda só na origem local');
  assert.match(sw, /\(IS_LOCAL_ORIGIN && url\.pathname\.startsWith\('\/vendor\/'\)\)/);
});

test('o injetor: só reescreve src="https://..." conhecidos e só se o arquivo existir; não mexe em outras URLs nem em texto', () => {
  const inj = createPageInjector({ vendorDir: path.resolve(REPO_ROOT, 'local-server', 'vendor') });
  const html = `<!doctype html><html><head><meta charset="UTF-8">
    <script src="https://cdn.tailwindcss.com"></script><script src="https://exemplo.com/outra.js"></script>
    <link rel="stylesheet" href="https://cdn.tailwindcss.com/estilo.css"></head><body><p>veja https://cdn.tailwindcss.com no texto</p></body></html>`;
  const out = inj.inject(html, '/pages/x.html');
  assert.match(out, /<script src="\/vendor\/tailwindcss-3\.4\.17\.js">/);
  assert.match(out, /src="https:\/\/exemplo\.com\/outra\.js"/); assert.match(out, /href="https:\/\/cdn\.tailwindcss\.com\/estilo\.css"/); assert.match(out, /veja https:\/\/cdn\.tailwindcss\.com no texto/);
  // sem a pasta vendor: nada é reescrito (a página continua funcionando com o CDN)
  const none = createPageInjector({ vendorDir: path.join(REPO_ROOT, 'nao-existe') });
  assert.match(none.inject(html, '/pages/x.html'), /src="https:\/\/cdn\.tailwindcss\.com"/);
  assert.equal(none.vendorFiles.length, 0);
  assert.equal(VENDOR_MAP.length, 4);
});

test('sem frontendDir (testes de API) nada disso é montado e a API segue igual', async () => {
  const x = await start(config({ frontendDir: null }));
  try { assert.equal((await get(x.port, '/ajuda')).status, 404); assert.equal((await get(x.port, '/health')).status, 200); } finally { await x.stop(); }
});
