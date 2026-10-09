// Etapa D — robustez dos celulares: estado da barra, compat.js (iOS < 16.4 / Chrome < 89), /sync/state e /sync/cloud-now,
// injeção só no servidor local, barra montada em TODOS os portais e shell offline.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { startTestServer, seedScenario } from './helpers.js';
import { REPO_ROOT } from '../src/config.js';
import { createPageInjector } from '../src/html-inject.js';

let t;
before(async () => { globalThis.location = { hostname: 'x', port: '', origin: 'http://x' }; globalThis.localStorage = { getItem: () => null }; t = await startTestServer(); await seedScenario(t.store); });
after(async () => { await t.close(); });
const read = f => fs.readFileSync(path.join(REPO_ROOT, f), 'utf8');

test('bolinha 🟢/🟡/🔴 e contagem: servidor fora = vermelho; pendências = amarelo; tudo certo = verde', async () => {
  const { barState } = await import('../../js/portalBar.js');
  assert.deepEqual(barState({ local: true, serverUp: false, pendingDevice: 3 }), { color: 'red', icon: '🔴', pending: 3, text: 'Sem conexão com o servidor local' });
  assert.equal(barState({ local: false, onLine: false }).color, 'red');
  const y = barState({ local: true, pendingDevice: 2, pendingCloud: 5 });
  assert.equal(y.color, 'yellow'); assert.equal(y.pending, 7); assert.match(y.text, /7 item/);
  assert.equal(barState({ local: true, authExpired: true }).color, 'yellow');
  assert.equal(barState({ local: true, cloudState: 'offline' }).color, 'green', 'nuvem fora do ar sem pendência não é problema no evento');
  assert.match(barState({ local: true, cloudState: 'offline' }).text, /nuvem fora do ar/);
  assert.equal(barState({ local: true }).color, 'green'); assert.equal(barState({ local: false }).color, 'green');
});

test('compat.js: iOS < 16.4 e Chrome < 89 não suportam; ≥ suportam; mensagem certa para cada caso', () => {
  const C = createRequire(import.meta.url)('../../js/compat.js');
  const ua = {
    ios163: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_3 like Mac OS X) AppleWebKit/605.1.15 Version/16.3 Mobile/15E148 Safari/604.1',
    ios164: 'Mozilla/5.0 (iPhone; CPU iPhone OS 16_4 like Mac OS X) AppleWebKit/605.1.15 Version/16.4 Mobile/15E148 Safari/604.1',
    ios17chrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_2 like Mac OS X) AppleWebKit/605.1.15 CriOS/120.0 Mobile/15E148 Safari/604.1',
    ios15chrome: 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_7 like Mac OS X) AppleWebKit/605.1.15 CriOS/120.0 Mobile/15E148 Safari/604.1',
    chrome88: 'Mozilla/5.0 (Linux; Android 9; SM-J600) AppleWebKit/537.36 Chrome/88.0.4324.93 Mobile Safari/537.36',
    chrome89: 'Mozilla/5.0 (Linux; Android 10; SM-A105) AppleWebKit/537.36 Chrome/89.0.4389.90 Mobile Safari/537.36',
    chrome120: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36',
    firefox100: 'Mozilla/5.0 (Android 12; Mobile; rv:100.0) Gecko/100.0 Firefox/100.0',
    desconhecido: 'Mozilla/5.0 (X11; U; Linux i686; en-US) Gecko/20040000 Netscape/7.1',
  };
  const sup = k => C.supportsImportMaps(ua[k], undefined);
  assert.deepEqual(['ios163', 'ios164', 'ios17chrome', 'ios15chrome', 'chrome88', 'chrome89', 'chrome120', 'firefox100', 'desconhecido'].map(sup),
    [false, true, true, false, false, true, true, false, false]);
  assert.equal(C.supportsImportMaps(ua.chrome88, { supports: x => x === 'importmap' }), true, 'quando o navegador sabe responder, vale a resposta dele');
  assert.equal(C.supportsImportMaps(ua.chrome120, { supports: () => false }), false);
  assert.match(C.advice(ua.ios163).text, /iOS 16\.4/); assert.match(C.advice(ua.chrome88).title, /Atualize o navegador/); assert.match(C.advice(ua.desconhecido).title, /Chrome/);
});

test('compat.js mostra o banner SÓ no servidor local e só quando não suporta (execução real do script)', () => {
  const code = read('js/compat.js');
  const run = ({ flag, ua, supports }) => {
    const els = [];
    const doc = { readyState: 'complete', getElementById: id => els.find(e => e.id === id) || null, createElement: () => ({ style: {}, setAttribute() {} }), body: { appendChild: e => els.push(e) }, addEventListener() {} };
    const win = { document: doc, navigator: { userAgent: ua }, HTMLScriptElement: supports === undefined ? undefined : { supports: () => supports }, __CAMPORI_LOCAL_APP: flag };
    vm.runInNewContext(code, { window: win, globalThis: win, module: undefined, ...win });
    return els;
  };
  const old = 'Mozilla/5.0 (iPhone; CPU iPhone OS 15_0 like Mac OS X) AppleWebKit/605.1.15 Version/15.0 Mobile Safari/604.1';
  const e1 = run({ flag: 1, ua: old }); assert.equal(e1.length, 1); assert.match(e1[0].innerHTML, /iOS 16\.4/); assert.equal(e1[0].id, 'compat-warning');
  assert.equal(run({ flag: undefined, ua: old }).length, 0, 'na nuvem não avisa');
  assert.equal(run({ flag: 1, ua: old, supports: true }).length, 0, 'suporta → sem banner');
});

test('/sync/state e /sync/cloud-now: exigem login (qualquer perfil); estado reporta pendências para a nuvem', async () => {
  assert.equal((await t.call('GET', '/sync/state')).status, 401);
  assert.equal((await t.call('POST', '/sync/cloud-now')).status, 401);
  for (const u of ['admin', 'aprovador', 'fiscal', 'regiao1', 'cons1']) {
    const tok = await t.login(u);
    const s = await t.call('GET', '/sync/state', undefined, tok);
    assert.equal(s.status, 200, u); assert.equal(typeof s.body.revision, 'number'); assert.equal(s.body.cloud.state, 'disabled');
    assert.equal(s.body.pendingCloud, 0, 'sincronização desligada: nada aguarda a nuvem');
  }
  const r = await t.call('POST', '/sync/cloud-now', {}, await t.login('regiao1'));
  assert.equal(r.status, 200); assert.equal(r.body.ok, false); assert.equal(r.body.disabled, true); assert.match(r.body.message, /desligada/);
});

test('/sync/cloud-now aciona o motor de sincronização quando existe e devolve o resultado', async () => {
  const { Store } = await import('../src/db.js'); const { createApp } = await import('../src/app.js');
  const store = new Store(':memory:'); await seedScenario(store);
  let calls = 0;
  const engine = { status: () => ({ enabled: true, cloud: { state: 'online' }, push: { lastSuccessAt: 123, pending: { total: 0 } } }), syncNow: async o => { calls++; assert.equal(o.manual, true); return { ok: true, offline: false, message: 'ok' }; } };
  const app = createApp({ store, config: { port: 0, qrSecret: 's', jwtSecret: 'j', qrSecretIsDev: false, version: 'v9', uploadDir: '/tmp', corsOrigins: [], frontendDir: null }, log: { info() {}, warn() {}, error() {} }, engine });
  const srv = await new Promise(r => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  try {
    const base = `http://127.0.0.1:${srv.address().port}`;
    const { token } = await (await fetch(base + '/users/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'fiscal', password: 'senha123' }) })).json();
    const h = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
    const st = await (await fetch(base + '/sync/state', { headers: h })).json();
    assert.equal(st.cloud.state, 'online'); assert.equal(st.cloud.lastSuccessAt, 123); assert.equal(st.version, 'v9');
    assert.ok(st.pendingCloud > 0, 'com a sincronização ligada, as linhas dirty aguardam a nuvem');
    const r = await (await fetch(base + '/sync/cloud-now', { method: 'POST', headers: h, body: '{}' })).json();
    assert.equal(r.ok, true); assert.equal(calls, 1);
  } finally { srv.closeAllConnections?.(); srv.close(); store.close(); }
});

test('injeção: compat.js só nas páginas do servidor local com o modo local ligado; arquivo servido e no shell offline', () => {
  const on = createPageInjector({ vendorDir: null, localAppMode: true, importMapJson: '{"imports":{}}' }).inject('<html><head></head></html>', '/pages/x.html');
  const off = createPageInjector({ vendorDir: null, localAppMode: false, importMapJson: '{"imports":{}}' }).inject('<html><head></head></html>', '/pages/x.html');
  assert.match(on, /__CAMPORI_LOCAL_APP=1.*<script src="\/js\/compat\.js">/s); assert.doesNotMatch(off, /compat\.js/);
  const sw = read('sw.js');
  for (const f of ['/js/compat.js', '/js/portalBar.js']) assert.ok(sw.includes(`"${f}"`), `${f} no shell do SW`);
});

test('barra montada em TODOS os portais (admin, fiscal, região, conselheiro, inspeção, login) com "Sincronizar agora"', () => {
  for (const f of ['js/admin.js', 'js/fiscal.js', 'js/regiao.js', 'js/conselheiro.js', 'js/inspecao-uniforme.js']) {
    const s = read(f);
    assert.match(s, /import \{ mountPortalBar \} from '\.\/portalBar\.js'/, f); assert.match(s, /mountPortalBar\(\{/, f); assert.match(s, /syncNow:/, `${f}: botão Sincronizar agora`);
  }
  assert.match(read('pages/login.html'), /mountPortalBar\(\{ showSync: false \}\)/);
  const bar = read('js/portalBar.js');
  assert.match(bar, /Sincronizar agora/); assert.match(bar, /Atualizar app/); assert.match(bar, /localStorage|IndexedDB/);
  assert.ok(!/localStorage\.(clear|removeItem)|indexedDB\.deleteDatabase|caches\.delete|serviceWorker.*unregister/.test(bar), 'atualizar app NÃO apaga sessão, fila nem cache à força');
});

test('versão do app = VERSION do sw.js (hash do build) e o botão compara com a versão publicada', () => {
  const sw = read('sw.js'); const v = sw.match(/const VERSION = '([0-9a-f]+)'/)[1];
  assert.equal(v.length, 10);
  assert.match(read('js/portalBar.js'), /const VERSION_RE = \/const VERSION = '\(\[0-9a-f\]\+\)'\//);
});
