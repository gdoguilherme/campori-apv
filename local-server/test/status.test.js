// Painel de status (/status): semáforos, pendências por unidade e requisito, alertas, PIN fora do PC.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createApp } from '../src/app.js';
import { makeEnv, localScan, cloudScan, T0, REF } from './sync-env.js';

async function serve(env, { statusPin = '', isLocalRequest } = {}) {
  const config = { port: 0, qrSecret: 's', jwtSecret: 'j', qrSecretIsDev: false, version: 't', uploadDir: '/tmp', frontendDir: null, corsOrigins: [], statusPin };
  const app = createApp({ store: env.store, config, log: env.log, engine: env.engine, isLocalRequest });
  const server = await new Promise(r => { const s = app.listen(0, '127.0.0.1', () => r(s)); });
  const port = server.address().port;
  const call = (method, path, { headers = {}, body } = {}) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path, method, headers: { 'content-type': 'application/json', ...headers } }, res => {
      let b = ''; res.on('data', d => (b += d)); res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode, json, text: b, headers: res.headers }); });
    });
    req.on('error', reject); req.end(body ? JSON.stringify(body) : undefined);
  });
  return { call, close: () => new Promise(r => { server.closeAllConnections?.(); server.close(r); }) };
}
const get = (s, p, o) => s.call('GET', p, o);

test('página /status é servida (HTML simples, sem dados) e os dados vêm de /status/api/summary', async () => {
  const env = makeEnv(); const s = await serve(env);
  try {
    const page = await get(s, '/status');
    assert.equal(page.status, 200); assert.match(page.headers['content-type'], /html/);
    assert.match(page.text, /Painel do servidor/); assert.match(page.text, /Sincronizar agora/);
    assert.ok(!/Águias|Prova de Nós/.test(page.text), 'a página em si não carrega dados');
    const sum = await get(s, '/status/api/summary');
    assert.equal(sum.status, 200); assert.equal(sum.json.lights.server.color, 'green');
  } finally { await s.close(); }
});

test('com a NUVEM FORA DO AR: servidor verde, nuvem vermelha, tudo seguro; pendências por unidade e por requisito', async () => {
  const env = makeEnv(); const s = await serve(env);
  try {
    localScan(env, { unit: 'U1', user: 'c1', req: 'RQ', variant: 'v1', ago: 20_000 });
    localScan(env, { unit: 'U2', user: 'c2', req: 'RQ2', variant: 'f1', ago: 10_000 });
    env.store.insert('submissions', { regionId: 'R1', unitId: null, requirementId: 'RA', requirementName: 'Relatório', status: 'pending', source: 'region', requirementPoints: 10, submittedAt: { seconds: 1, nanoseconds: 0 } }); // da REGIÃO → todas as unidades da região
    env.fake.online = false;
    const r = await s.call('POST', '/status/api/sync-now');
    assert.equal(r.status, 200); assert.equal(r.json.offline, true); assert.match(r.json.message, /seguros|conexão/);
    const d = (await get(s, '/status/api/summary')).json;
    assert.deepEqual([d.lights.server.color, d.lights.cloud.color, d.lights.data.color], ['green', 'red', 'yellow']);
    assert.equal(d.overall.color, 'yellow'); assert.match(d.overall.title, /Sem internet.*3 item/);
    assert.equal(d.sync.pending, 3); assert.equal(d.sync.lastSuccessAt, null);
    const u = Object.fromEntries(d.units.map(x => [x.id, x]));
    assert.deepEqual([u.U1.state, u.U1.pending], ['pendente', 2]);        // scan dela + relatório da região
    assert.deepEqual([u.U2.state, u.U2.pending], ['pendente', 2]);
    assert.deepEqual([u.U3.state, u.U3.pending], ['sincronizado', 0]);    // outra região: nada pendente
    const q = Object.fromEntries(d.requirements.map(x => [x.id, x]));
    assert.deepEqual([q.RQ.state, q.RQ2.state, q.RA.state], ['pendente', 'pendente', 'pendente']);
    assert.equal(d.units.length, 3);
    // a internet volta → "Sincronizar agora" → tudo verde
    env.fake.online = true;
    const ok = await s.call('POST', '/status/api/sync-now');
    assert.equal(ok.json.ok, true); assert.match(ok.json.message, /3 item/);
    assert.equal(ok.json.summary.overall.color, 'green'); assert.equal(ok.json.summary.sync.pending, 0);
    assert.equal(ok.json.summary.sync.lastSuccessAt, T0);
    assert.ok(ok.json.summary.units.every(x => x.state === 'sincronizado')); assert.ok(ok.json.summary.requirements.every(x => x.state === 'sincronizado'));
  } finally { await s.close(); }
});

test('alerta "pontos que já estavam cadastrados": aparece no painel e no resultado da sincronização; "entendi" limpa', async () => {
  const env = makeEnv(); const s = await serve(env);
  try {
    await cloudScan(env, { variant: 'v1', pts: 5, ago: 900_000 });
    localScan(env, { variant: 'v2', pts: 8, ago: 10_000 });
    const r = (await s.call('POST', '/status/api/sync-now')).json;
    assert.equal(r.ok, true); assert.equal(r.alerts.length, 1);
    const d = (await get(s, '/status/api/summary')).json;
    assert.equal(d.alerts.length, 1); assert.match(d.alerts[0].message, /Águias.*Prova de Nós.*já existia pontuação/s);
    assert.equal((await s.call('POST', '/status/api/ack')).json.acknowledged, 1);
    assert.equal((await get(s, '/status/api/summary')).json.alerts.length, 0);
  } finally { await s.close(); }
});

test('itens com erro aparecem em vermelho com o motivo; semáforo geral fica vermelho', async () => {
  const env = makeEnv(); const s = await serve(env);
  try {
    env.store.insert('participants', { name: 'Ruim', unitId: 'U1', regionId: 'R1' }, 'p-bad'); env.fake.denyDocs.add('p-bad');
    const r = (await s.call('POST', '/status/api/sync-now')).json;
    assert.equal(r.ok, false); assert.match(r.message, /não puderam ser enviados/);
    const d = (await get(s, '/status/api/summary')).json;
    assert.equal(d.overall.color, 'red'); assert.equal(d.lights.data.color, 'red');
    assert.equal(d.errors.failing.length, 1); assert.match(d.errors.failing[0].message, /PERMISSION_DENIED/);
  } finally { await s.close(); }
});

test('sem CLOUD_SYNC / banco demo / sem credenciais: painel funciona e explica ("só neste PC")', async () => {
  const demo = makeEnv(); demo.store.setMeta('dataset', 'demo'); await demo.engine.syncNow();
  const none = makeEnv({ config: { cloudSync: false } }); await none.engine.syncNow();
  for (const env of [demo, none]) {
    const s = await serve(env);
    try {
      const d = (await get(s, '/status/api/summary')).json;
      assert.equal(d.overall.color, 'gray'); assert.match(d.overall.title, /só neste PC/);
      assert.equal(d.lights.cloud.color, 'gray');
    } finally { await s.close(); }
  }
  // servidor sem engine nenhum (ex: testes antigos) também responde
  const env = makeEnv(); const config = { port: 0, qrSecret: 's', jwtSecret: 'j', qrSecretIsDev: false, version: 't', uploadDir: '/tmp', frontendDir: null, corsOrigins: [] };
  const app = createApp({ store: env.store, config, log: env.log });
  const server = await new Promise(r => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  const res = await fetch(`http://127.0.0.1:${server.address().port}/status/api/summary`); assert.equal(res.status, 200); server.close();
});

test('PIN: no próprio PC não pede; de outro aparelho exige PIN, compara certo e bloqueia após 5 erros', async () => {
  const env = makeEnv();
  // outro aparelho SEM PIN configurado → recusa com a instrução
  let s = await serve(env, { statusPin: '', isLocalRequest: () => false });
  let r = await get(s, '/status/api/summary'); assert.equal(r.status, 403); assert.equal(r.json.code, 'PIN_NOT_CONFIGURED'); await s.close();
  // com PIN
  s = await serve(env, { statusPin: '4821', isLocalRequest: () => false });
  try {
    assert.equal((await get(s, '/status')).status, 200, 'a página (sem dados) abre para pedir o PIN');
    r = await get(s, '/status/api/summary'); assert.equal(r.status, 401); assert.equal(r.json.code, 'PIN_REQUIRED');
    assert.equal((await s.call('POST', '/status/api/sync-now')).status, 401, 'ações também exigem PIN');
    assert.equal((await get(s, '/status/api/summary', { headers: { 'x-status-pin': '4821' } })).status, 200);
    for (let i = 0; i < 5; i++) assert.equal((await get(s, '/status/api/summary', { headers: { 'x-status-pin': `000${i}` } })).status, 401);
    r = await get(s, '/status/api/summary', { headers: { 'x-status-pin': '4821' } });
    assert.equal(r.status, 429, 'depois de 5 erros até o PIN certo fica bloqueado por 1 min'); assert.equal(r.json.code, 'PIN_LOCKED');
  } finally { await s.close(); }
  // no próprio PC: nunca pede PIN
  s = await serve(env, { statusPin: '4821' });
  try { assert.equal((await get(s, '/status/api/summary')).status, 200); } finally { await s.close(); }
});

test('/health (público) traz um resumo da sincronização', async () => {
  const env = makeEnv(); const s = await serve(env);
  try {
    localScan(env); await env.engine.syncNow(); localScan(env, { unit: 'U2', user: 'c2', req: 'RQ2', variant: 'f1' });
    const h = (await get(s, '/health')).json;
    assert.deepEqual([h.sync.cloud, h.sync.pending], ['online', 1]); assert.equal(h.sync.lastSuccessAt, T0);
  } finally { await s.close(); }
});

test('painel traz o botão "Atualizar dados da nuvem": /status/api/pull-now só traz, e o resumo mostra a última atualização', async () => {
  const env = makeEnv(); const s = await serve(env);
  try {
    assert.match((await get(s, '/status')).text, /Atualizar dados da nuvem/);
    await s.call('POST', '/status/api/sync-now');                                      // liga os listeners e faz a carga
    env.store.insert('participants', { name: 'Pendente', unitId: 'U1', regionId: 'R1' }, 'p-pend');        // pendência local: pull-now NÃO envia
    env.fake._col('requirements').set('RA', { ...REF.requirements[2][1], points: 77 });                       // mudança "perdida" na nuvem
    const r = await s.call('POST', '/status/api/pull-now');
    assert.equal(r.json.ok, true); assert.equal(r.json.pushed, 0); assert.match(r.json.message, /atualizado\(s\)/);
    assert.equal(env.store.get('requirements', 'RA').points, 77);
    assert.equal(env.fake.get('participants', 'p-pend'), null, 'pull-now não envia');
    const d = r.json.summary;
    assert.equal(d.pull.listening, true); assert.ok(d.pull.lastPullAt); assert.equal(d.pull.ready, 7);
    assert.equal(d.sync.pending, 1);
    env.fake.online = false;
    const off = await s.call('POST', '/status/api/pull-now');
    assert.equal(off.json.offline, true); assert.match(off.json.message, /sem internet|Sem acesso/i);
  } finally { await s.close(); }
});
