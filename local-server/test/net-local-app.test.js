// js/net.js em "modo local total" (flag injetada pelo servidor): nada sai para a nuvem.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

let srv, hits, net, origin;
before(async () => {
  hits = [];
  srv = http.createServer((req, res) => { hits.push(req.url); res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(req.url === '/health' ? { ok: true, mode: 'local', revision: 1 } : { ok: true })); });
  await new Promise(r => srv.listen(0, '127.0.0.1', r));
  origin = `http://127.0.0.1:${srv.address().port}`;
  globalThis.__CAMPORI_LOCAL_APP = 1;
  globalThis.localStorage = { getItem: () => null };
  globalThis.location = { hostname: '127.0.0.1', port: String(srv.address().port), origin };
  net = await import('../../js/net.js');
});
after(() => { srv.closeAllConnections?.(); srv.close(); });

test('o servidor ativo é a própria origem e isCloudReachable sonda o servidor local (não o Fly)', async () => {
  const s = await net.resolveServer({ force: true });
  assert.equal(s.kind, 'local'); assert.equal(s.base, origin);
  assert.equal(await net.isCloudReachable(), true);
  assert.ok(hits.every(u => u === '/health'));
});

test('servidor local fora do ar → "none"; NUNCA tenta a nuvem', async () => {
  const realFetch = globalThis.fetch; const urls = [];
  globalThis.fetch = (u, o) => { urls.push(String(u)); return Promise.reject(new TypeError('down')); };
  try {
    net.invalidateServer();
    const s = await net.resolveServer({ force: true });
    assert.equal(s.kind, 'none');
    assert.deepEqual(urls.filter(u => !u.startsWith(origin)), []);
  } finally { globalThis.fetch = realFetch; }
});
