// Módulo de rede do app (js/net.js): servidor local primeiro, nuvem como reserva, e NADA sem timeout.
// Roda em Node com location/localStorage simulados (config.js os lê ao carregar).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

let local, cloud, net;
const mode = { local: 'ok', cloud: 'ok', syncLocal: 'ok' };
const listen = srv => new Promise(res => srv.listen(0, '127.0.0.1', () => res(srv.address().port)));
const handler = (name, extra = {}) => (req, res) => {
  const m = req.url.startsWith('/sync/') ? (name === 'local' ? mode.syncLocal : 'ok') : mode[name];
  if (m === 'down') return req.socket.destroy();
  if (m === 'hang') return;                                   // nunca responde
  if (m === 'half') { res.writeHead(200, { 'content-type': 'application/json' }); res.write('{"ok":'); return; } // corpo nunca termina
  res.writeHead(m === '401' ? 401 : 200, { 'content-type': 'application/json' });
  res.end(JSON.stringify(req.url === '/health' ? { ok: true, ...extra } : m === '401' ? { error: 'Sessão inválida ou expirada' } : { from: name, url: req.url }));
};

before(async () => {
  local = http.createServer(handler('local', { mode: 'local' }));
  cloud = http.createServer(handler('cloud'));
  const [lp, cp] = [await listen(local), await listen(cloud)];
  const store = { campori_local_url: `http://127.0.0.1:${lp}`, campori_cloud_url: `http://127.0.0.1:${cp}` };
  globalThis.localStorage = { getItem: k => store[k] ?? null };
  globalThis.location = { hostname: 'campori.test', port: '', origin: 'https://campori.test' };
  net = await import('../../js/net.js');
});
after(() => { local.closeAllConnections?.(); cloud.closeAllConnections?.(); local.close(); cloud.close(); });

const fresh = async () => { net.invalidateServer(); return net.resolveServer({ force: true }); };

test('servidor local no ar → é o escolhido (e não a nuvem)', async () => {
  const s = await fresh();
  assert.equal(s.kind, 'local');
  assert.equal((await net.serverFetch('/algo')).from, 'local');
});

test('local fora do ar → cai para a nuvem', async () => {
  mode.local = 'down';
  const s = await fresh();
  assert.equal(s.kind, 'cloud');
  assert.equal((await net.serverFetch('/algo')).from, 'cloud');
  mode.local = 'ok';
});

test('local "pendurado" (Starlink/Wi-Fi ruim): desiste em ~3s e usa a nuvem — nunca fica esperando', async () => {
  mode.local = 'hang';
  const t0 = Date.now();
  let s, dt;
  try { s = await fresh(); dt = Date.now() - t0; } finally { mode.local = 'ok'; }
  assert.equal(s.kind, 'cloud');
  // só o limite INFERIOR é conferido (esperou o prazo de ~3s antes de desistir); o superior depende do relógio da máquina
  // e é coberto pelo timeout do próprio teste: se ficasse esperando para sempre, ele nunca terminaria
  assert.ok(dt >= 2800, `desistiu cedo demais (${dt}ms)`);
  mode.local = 'ok';
});

test('nenhum servidor → kind none e serverFetch falha rápido com NetError', async () => {
  mode.local = 'down'; mode.cloud = 'down';
  assert.equal((await fresh()).kind, 'none');
  const t0 = Date.now();
  await assert.rejects(net.serverFetch('/algo'), e => e instanceof net.NetError && e.kind === 'offline');
  assert.ok(Date.now() - t0 < 500, 'resultado "none" é reaproveitado por alguns segundos');
  mode.local = 'ok'; mode.cloud = 'ok';
});

test('o local cai NO MEIO da chamada → refaz na nuvem sem o chamador perceber', async () => {
  assert.equal((await fresh()).kind, 'local');
  mode.syncLocal = 'down'; mode.local = 'down'; // o PC do evento desligou: nem a chamada nem o /health respondem
  const r = await net.serverFetch('/sync/scans', { method: 'POST', body: { items: [] }, token: 'x' });
  assert.equal(r.from, 'cloud');
  mode.syncLocal = 'ok'; mode.local = 'ok';
});

test('erro HTTP do servidor (ex: 401) NÃO dispara fallback — vira HttpError com o status', async () => {
  assert.equal((await fresh()).kind, 'local');
  mode.syncLocal = '401';
  await assert.rejects(net.serverFetch('/sync/scans', { method: 'POST', body: {}, token: 'vencido' }),
    e => e instanceof net.HttpError && e.status === 401 && /expirada/.test(e.message));
  mode.syncLocal = 'ok';
});

test('fetchJson: corpo que nunca termina também estoura o timeout', async () => {
  mode.cloud = 'half';
  const port = cloud.address().port;
  const t0 = Date.now();
  try {
    await assert.rejects(net.fetchJson(`http://127.0.0.1:${port}/x`, {}, 600), e => e instanceof net.NetError && e.kind === 'timeout');
    assert.ok(Date.now() - t0 < 1500);
  } finally { mode.cloud = 'ok'; }
});

test('withTimeout rejeita promessas que nunca resolvem (ex: escrita direta no Firestore sem rede)', async () => {
  await assert.rejects(net.withTimeout(new Promise(() => {}), 150, 'prazo'), e => e instanceof net.NetError && e.message === 'prazo');
  assert.equal(await net.withTimeout(Promise.resolve(7), 150), 7);
});

test('isCloudReachable reflete a nuvem', async () => {
  assert.equal(await net.isCloudReachable(), true);
});
