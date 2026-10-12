import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, seedScenario } from './helpers.js';

let t, adm, reg1, c1, c2, jud, apr;
before(async () => {
  t = await startTestServer();
  await seedScenario(t.store);
  [adm, reg1, c1, c2, jud, apr] = await Promise.all(['admin', 'regiao1', 'cons1', 'cons2', 'fiscal', 'aprovador'].map(t.login));
});
after(() => t.close());

const scoreOf = async id => (await t.call('GET', '/scores/units', undefined, adm)).body.find(s => s.id === id).total;

test('login e guardas de perfil', async () => {
  assert.equal((await t.call('POST', '/users/login', { username: 'admin', password: 'errada' })).status, 401);
  assert.equal((await t.call('GET', '/data/regions')).status, 401);
  assert.equal((await t.call('POST', '/data/regions', { name: 'X' }, c1)).status, 403);
  assert.equal((await t.call('GET', '/data/users', undefined, adm)).status, 404); // users nunca via /data
  assert.equal((await t.call('POST', '/data/disciplinaryActions', { points: 0 }, adm)).status, 403);
  const me = await t.call('GET', '/data/regions', undefined, c1);
  assert.equal(me.body.docs.length, 2);
});

test('Regional → pontua TODAS as unidades da região (e só dela)', async () => {
  const s = await t.call('POST', '/submissions', { requirementId: 'RA', notes: 'ok' }, reg1);
  assert.equal(s.status, 200);
  assert.equal(await scoreOf('U1'), 0, 'pendente não pontua');
  const rv = await t.call('POST', `/submissions/${s.body.id}/review`, { status: 'approved' }, apr);
  assert.equal(rv.status, 200);
  assert.deepEqual([await scoreOf('U1'), await scoreOf('U2'), await scoreOf('U3')], [10, 10, 0]);
  assert.equal(t.store.list('auditLog').length, 1);
});

test('Região não reenvia requisito já aprovado; perfis só enviam o tipo certo', async () => {
  assert.equal((await t.call('POST', '/submissions', { requirementId: 'RA' }, reg1)).status, 409);
  assert.equal((await t.call('POST', '/submissions', { requirementId: 'RS' }, reg1)).status, 403); // tipo conselheiro
  assert.equal((await t.call('POST', '/submissions', { requirementId: 'RA' }, c1)).status, 403);   // tipo regional
});

test('Conselheiro → pontua só a unidade dele', async () => {
  const s = await t.call('POST', '/submissions', { requirementId: 'RS' }, c1);
  assert.equal(s.body.unitId, 'U1');
  await t.call('POST', `/submissions/${s.body.id}/review`, { status: 'approved' }, adm);
  assert.deepEqual([await scoreOf('U1'), await scoreOf('U2')], [17, 10]);
});

test('Disciplina: -5 fixos (unidade ou região inteira), piso em 0, só admin', async () => {
  assert.equal((await t.call('POST', '/discipline', { targetType: 'unit', targetId: 'U1', reason: 'x' }, c1)).status, 403);
  const d = await t.call('POST', '/discipline', { targetType: 'unit', targetId: 'U1', reason: 'Atraso', points: 999 }, adm);
  assert.equal(d.body.points, 5, 'cliente não escolhe os pontos');
  assert.deepEqual([await scoreOf('U1'), await scoreOf('U2')], [12, 10]);
  await t.call('POST', '/discipline', { targetType: 'region', targetId: 'R1', reason: 'Barulho' }, adm);
  assert.deepEqual([await scoreOf('U1'), await scoreOf('U2'), await scoreOf('U3')], [7, 5, 0]);
  await t.call('DELETE', `/discipline/${d.body.id}`, undefined, adm);
  assert.equal(await scoreOf('U1'), 12);
  for (let i = 0; i < 4; i++) await t.call('POST', '/discipline', { targetType: 'unit', targetId: 'U3', reason: 'r' }, adm);
  assert.equal(await scoreOf('U3'), 0, 'nunca negativo');
  for (const x of t.store.list('disciplinaryActions', { filters: { targetId: 'U3' } })) await t.call('DELETE', `/discipline/${x.id}`, undefined, adm);
  for (const x of t.store.list('disciplinaryActions')) await t.call('DELETE', `/discipline/${x.id}`, undefined, adm);
});

test('Fiscal: sugestão fica pendente até o admin aprovar', async () => {
  const s = await t.call('POST', '/submissions/fiscal-suggestion', { requirementId: 'RA', regionId: 'R2', points: 6 }, jud);
  assert.equal(s.body.status, 'pending'); assert.equal(s.body.fiscalSuggestion, true);
  assert.equal(await scoreOf('U3'), 0);
  await t.call('POST', `/submissions/${s.body.id}/review`, { status: 'approved' }, adm);
  assert.equal(await scoreOf('U3'), 6);
  assert.equal((await t.call('POST', `/submissions/${s.body.id}/review`, { status: 'approved' }, c1)).status, 403);
});

test('Ranking público é anônimo (posição + pontos + estrelas)', async () => {
  const r = await t.call('GET', '/ranking');
  assert.equal(r.status, 200);
  assert.ok(r.body.length >= 1);
  assert.deepEqual(Object.keys(r.body[0]).sort(), ['position', 'stars', 'total']);
});

test('Sincronização futura: ?since devolve alterações e tombstones; revision sobe', async () => {
  const before = t.store.revision();
  const d = await t.call('POST', '/discipline', { targetType: 'unit', targetId: 'U2', reason: 'tmp' }, adm);
  assert.ok(t.store.revision() > before);
  const t0 = Date.now() - 1000;
  await t.call('DELETE', `/discipline/${d.body.id}`, undefined, adm);
  const changes = await t.call('GET', `/data/disciplinaryActions?since=${t0}`, undefined, adm);
  assert.ok(changes.body.docs.some(x => x.id === d.body.id), 'tombstone presente');
  const live = await t.call('GET', '/data/disciplinaryActions', undefined, adm);
  assert.ok(!live.body.docs.some(x => x.id === d.body.id));
});
