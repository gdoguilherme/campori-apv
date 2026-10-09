// Ranking: lido do servidor LOCAL quando o aparelho está nele; da NUVEM caso contrário; com a hora da atualização.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startTestServer, seedScenario } from './helpers.js';

// ── lado do servidor local ──────────────────────────────────────────────────────
test('servidor local: /ranking e /scores/units com ?meta=1 trazem origem e hora; sem meta, o formato antigo', async () => {
  const t = await startTestServer(); await seedScenario(t.store);
  try {
    const adm = await t.login('admin'), c1 = await t.login('cons1');
    const reg = await t.call('POST', '/submissions', { requirementId: 'RA' }, await t.login('regiao1'));
    await t.call('POST', `/submissions/${reg.body.id}/review`, { status: 'approved' }, adm);
    t.store.setMeta('sync.lastSuccessAt', String(Date.UTC(2026, 9, 10, 12, 30)));

    const plain = await t.call('GET', '/ranking');
    assert.ok(Array.isArray(plain.body) && plain.body[0].total === 10, 'sem meta: lista, como antes');
    const m = await t.call('GET', '/ranking?meta=1');
    assert.equal(m.body.source, 'local'); assert.ok(Math.abs(m.body.updatedAt - Date.now()) < 5000);
    assert.equal(m.body.cloudSyncedAt, Date.UTC(2026, 9, 10, 12, 30));
    assert.deepEqual(m.body.ranking.map(r => Object.keys(r).sort().join()), ['position,stars,total', 'position,stars,total'], 'anônimo: sem nomes');
    assert.ok(!JSON.stringify(m.body).includes('Unidade 1'));

    assert.equal((await t.call('GET', '/scores/units?meta=1')).status, 401, 'identificado exige login');
    const id = await t.call('GET', '/scores/units?meta=1', undefined, adm);
    assert.equal(id.body.source, 'local'); assert.equal(id.body.scores.find(s => s.id === 'U1').name, 'Unidade 1');
    assert.equal(id.body.scores.find(s => s.id === 'U1').total, 10);
    assert.ok(Array.isArray((await t.call('GET', '/scores/units', undefined, c1)).body));
  } finally { await t.close(); }
});

// ── lado do app (js/ranking.js) ──────────────────────────────────────────────────
let local, cloud, R, store;
const mode = { local: 'ok', cloud: 'ok' };
const listen = s => new Promise(r => s.listen(0, '127.0.0.1', () => r(s.address().port)));
const handler = name => (req, res) => {
  const m = mode[name];
  if (m === 'down') return req.socket.destroy();
  const url = new URL(req.url, 'http://x');
  res.writeHead(200, { 'content-type': 'application/json' });
  if (url.pathname === '/health') return res.end(JSON.stringify({ ok: true, ...(name === 'local' ? { mode: 'local' } : {}) }));
  if (url.pathname === '/ranking') return res.end(JSON.stringify({ updatedAt: 1_800_000_000_000, cloudSyncedAt: 1_799_999_000_000, ranking: [{ position: 1, total: 40, stars: 3 }, { position: 2, total: 22, stars: 2 }] }));
  if (url.pathname === '/scores/units') {
    if (req.headers.authorization !== 'Bearer tok-admin') { res.statusCode = 401; return res.end('{"error":"x"}'); }
    return res.end(JSON.stringify({ updatedAt: 1_800_000_000_000, cloudSyncedAt: null, scores: [{ id: 'U1', name: 'Águias', regionId: 'R1', total: 40, count: 3, stars: 3 }] }));
  }
  res.end('{}');
};
before(async () => {
  local = http.createServer(handler('local')); cloud = http.createServer(handler('cloud'));
  const [lp, cp] = [await listen(local), await listen(cloud)];
  store = {};
  globalThis.localStorage = { getItem: k => (k.startsWith('campori_') && k.includes('url') ? ({ campori_local_url: `http://127.0.0.1:${lp}`, campori_cloud_url: `http://127.0.0.1:${cp}` })[k] ?? null : store[k] ?? null), setItem: (k, v) => { store[k] = v; } };
  globalThis.location = { hostname: 'campori.test', port: '', origin: 'https://campori.test' };
  R = { ranking: await import('../../js/ranking.js'), net: await import('../../js/net.js') };
});
after(() => { local.closeAllConnections?.(); cloud.closeAllConnections?.(); local.close(); cloud.close(); });
const fresh = () => { R.net.invalidateServer(); return R.net.resolveServer({ force: true }); };

test('app NA rede do evento: ranking vem do servidor local, com a hora e a sincronização da nuvem', async () => {
  await fresh(); let called = 0;
  const info = await R.ranking.loadAnonRanking({ fallback: async () => { called++; return []; } });
  assert.equal(info.source, 'local'); assert.deepEqual(info.rows, [{ total: 40 }, { total: 22 }]); assert.equal(called, 0, 'não foi à nuvem');
  assert.equal(info.updatedAt, 1_800_000_000_000);
  assert.match(R.ranking.rankingStampText(info), /Atualizado às \d\d:\d\d · servidor local \(nuvem sincronizada às \d\d:\d\d\)/);
  assert.match(R.ranking.rankingStampHtml(info), /rank-stamp/);
});

test('app FORA da rede do evento (servidor local ausente): ranking vem da nuvem', async () => {
  mode.local = 'down';
  try {
    await fresh();
    const info = await R.ranking.loadAnonRanking({ fallback: async () => [{ total: 7 }] });
    assert.equal(info.source, 'cloud'); assert.deepEqual(info.rows, [{ total: 7 }]);
    assert.match(R.ranking.rankingStampText(info), /· nuvem$/);
  } finally { mode.local = 'ok'; }
});

test('SEM NENHUMA rede: mostra a última cópia guardada, avisando; sem cópia, erro claro', async () => {
  const savedStore = { ...store };
  mode.local = 'down'; mode.cloud = 'down'; await fresh();
  let called = 0;
  const info = await R.ranking.loadAnonRanking({ fallback: async () => { called++; throw new Error('sem rede'); } });
  assert.equal(info.source, 'cache'); assert.equal(info.stale, true); assert.equal(called, 0, 'sem rede nem tenta a nuvem');
  assert.ok(info.rows.length > 0);
  assert.match(R.ranking.rankingStampText(info), /sem conexão — último ranking guardado/);
  for (const k of Object.keys(store)) delete store[k];
  await assert.rejects(R.ranking.loadAnonRanking({ fallback: async () => [] }), /Sem conexão e sem ranking guardado/);
  Object.assign(store, savedStore); mode.local = 'ok'; mode.cloud = 'ok';
});

test('nuvem lenta/falhando mas com servidor "cloud" no ar: cai para a cópia guardada em vez de travar', async () => {
  mode.local = 'down';
  try {
    await fresh();
    const t0 = Date.now();
    const info = await R.ranking.loadAnonRanking({ fallback: () => new Promise(() => {}), timeoutMs: 500 });   // fallback que nunca responde
    assert.equal(info.source, 'cache'); assert.ok(Date.now() - t0 < 10_000, 'tem prazo (não fica esperando para sempre)');
  } finally { mode.local = 'ok'; }
});

test('ranking IDENTIFICADO (admin): servidor local com o token; sem token válido cai para a nuvem', async () => {
  await fresh();
  const ok = await R.ranking.loadIdentifiedRanking({ token: 'tok-admin', fallback: async () => [{ id: 'X' }] });
  assert.equal(ok.source, 'local'); assert.equal(ok.rows[0].name, 'Águias'); assert.match(R.ranking.rankingStampText(ok), /ainda não sincronizado com a nuvem/);
  const bad = await R.ranking.loadIdentifiedRanking({ token: 'vencido', fallback: async () => [{ id: 'X', name: 'da nuvem' }] });
  assert.equal(bad.source, 'cloud'); assert.equal(bad.rows[0].name, 'da nuvem');
});
