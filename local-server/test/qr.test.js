import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { startTestServer, seedScenario, QR_SECRET } from './helpers.js';

let t, adm, jud, c1, c2, reg1;
before(async () => {
  t = await startTestServer();
  await seedScenario(t.store);
  [adm, jud, c1, c2, reg1] = await Promise.all(['admin', 'fiscal', 'cons1', 'cons2', 'regiao1'].map(t.login));
});
after(() => t.close());

const gen = async (requirementId, variantId, points) =>
  (await t.call('POST', '/qr/generate', { requirementId, variantId, points }, jud)).body;
const redeem = (payload, token, extra = {}) => t.call('POST', '/qr/redeem', { ...payload, ...extra }, token);

test('paridade: hash do servidor local == hash do backend da nuvem (QR impresso continua válido)', async () => {
  process.env.QR_SECRET = QR_SECRET; // o módulo da nuvem lê o segredo ao ser carregado
  const cloud = createRequire(import.meta.url)('../../server/services/qrTokens.js');
  for (const [r, v, p] of [['RQ', 'v1', 5], ['abc123', 'zz', 0], ['Prova ç', 'v-9', 12]]) {
    assert.equal((await gen(r, v, p)).hash, cloud.signQr(r, v, p));
    assert.equal(cloud.verifyQr(r, v, p, (await gen(r, v, p)).hash), true);
  }
});

test('Fiscal gera; Conselheiro não gera; hash adulterado é recusado', async () => {
  assert.equal((await t.call('POST', '/qr/generate', { requirementId: 'RQ', variantId: 'v1', points: 5 }, c1)).status, 403);
  const p = await gen('RQ', 'v1', 5);
  assert.equal(p.hash.length, 16);
  assert.equal((await t.call('POST', '/qr/verify', p, c1)).body.valid, true);
  assert.equal((await redeem({ ...p, hash: '0000000000000000' }, c1)).status, 401);
  assert.equal((await redeem({ ...p, pontos: 999 }, c1)).status, 401, 'mudar os pontos invalida o hash');
});

test('prova errada selecionada → 409 WRONG_PROVA, nada pontua', async () => {
  const p = await gen('RQ', 'v1', 5);
  const r = await redeem(p, c1, { selectedRequirementId: 'RQ2' });
  assert.equal(r.status, 409); assert.equal(r.body.code, 'WRONG_PROVA');
  assert.equal(t.store.list('submissions', { filters: { unitId: 'U1' } }).length, 0);
});

test('sucesso → aprovada na hora, só na unidade do conselheiro, com variante e pontos do QR', async () => {
  const p = await gen('RQ', 'v1', 5);
  const r = await redeem(p, c1, { selectedRequirementId: 'RQ' });
  assert.equal(r.status, 200);
  assert.deepEqual(
    [r.body.submission.status, r.body.submission.source, r.body.submission.unitId, r.body.submission.requirementPoints, r.body.submission.qrVariantId],
    ['approved', 'qr', 'U1', 5, 'v1']
  );
  const sc = (await t.call('GET', '/scores/units', undefined, adm)).body;
  assert.deepEqual(['U1', 'U2', 'U3'].map(id => sc.find(s => s.id === id).total), [5, 0, 0]);
});

test('trava (unitId, prova): mesma unidade NÃO pontua 2ª variante nem repete a mesma', async () => {
  const again = await redeem(await gen('RQ', 'v1', 5), c1);
  assert.equal(again.status, 409); assert.equal(again.body.code, 'DUPLICATE');
  const other = await redeem(await gen('RQ', 'v2', 8), c1);
  assert.equal(other.status, 409); assert.equal(other.body.code, 'DUPLICATE');
  assert.equal(t.store.list('submissions', { filters: { unitId: 'U1', requirementId: 'RQ' } }).length, 1);
});

test('outra unidade pontua a MESMA prova normalmente; mesma unidade pode outra prova', async () => {
  assert.equal((await redeem(await gen('RQ', 'v2', 8), c2)).status, 200);
  assert.equal((await redeem(await gen('RQ2', 'x1', 3), c1)).status, 200);
  const sc = (await t.call('GET', '/scores/units', undefined, adm)).body;
  assert.deepEqual(['U1', 'U2'].map(id => sc.find(s => s.id === id).total), [8, 8]);
});

test('2 scans simultâneos da mesma unidade → só 1 pontua', async () => {
  t.store.insert('requirements', { name: 'Corrida', points: 4, category: 'Outros', filledBy: 'conselheiro', order: 9, active: true, qrVariants: [{ id: 'c1', label: 'A', points: 4 }, { id: 'c2', label: 'B', points: 4 }] }, 'RC');
  const [pa, pb] = await Promise.all([gen('RC', 'c1', 4), gen('RC', 'c2', 4)]);
  const rs = await Promise.all([redeem(pa, c2), redeem(pb, c2), redeem(pa, c2)]);
  assert.equal(rs.filter(r => r.status === 200).length, 1);
  assert.equal(t.store.list('submissions', { filters: { unitId: 'U2', requirementId: 'RC' } }).length, 1);
});

test('variante removida/alterada depois de impresso → recusa; só conselheiro resgata', async () => {
  t.store.update('requirements', 'RQ2', { qrVariants: [{ id: 'x1', label: 'Único', points: 4 }] }); // pontos mudaram
  const stale = await redeem(await gen('RQ2', 'x1', 3), c2);
  assert.equal(stale.status, 422); assert.equal(stale.body.code, 'POINTS_MISMATCH');
  assert.equal((await redeem(await gen('RQ2', 'x1', 4), reg1)).status, 403);
});
