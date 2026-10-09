import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import jwt from 'jsonwebtoken';
import { startTestServer, seedScenario, QR_SECRET } from './helpers.js';

let t, adm, jud, c1, c2;
before(async () => {
  t = await startTestServer();
  await seedScenario(t.store);
  [adm, jud, c1, c2] = await Promise.all(['admin', 'fiscal', 'cons1', 'cons2'].map(t.login));
});
after(() => t.close());

const hash = (r, v, p) => crypto.createHmac('sha256', QR_SECRET).update(`${r}:${v}:${p}`).digest('hex').slice(0, 16);
let n = 0;
const item = (o = {}) => {
  const base = { requisitoId: 'RQ', varianteId: 'v1', pontos: 5, unitId: 'U1', scanTimestamp: Date.now() - 60_000 };
  const it = { id: `item-${String(++n).padStart(6, '0')}-${crypto.randomUUID().slice(0, 8)}`, ...base, ...o };
  it.hash = o.hash ?? hash(it.requisitoId, it.varianteId, it.pontos);
  return it;
};
const sync = (items, token = c1) => t.call('POST', '/sync/scans', { items }, token);
const subsOf = (unitId, req) => t.store.list('submissions', { filters: { unitId, requirementId: req } });
const scoreOf = async id => (await t.call('GET', '/scores/units', undefined, adm)).body.find(s => s.id === id).total;
const reset = () => { for (const s of t.store.list('submissions')) t.store.remove('submissions', s.id); };

test('auth: sem token 401, fiscal 403, token vencido 401; JWT do conselheiro dura 5 dias', async () => {
  assert.equal((await t.call('POST', '/sync/scans', { items: [] })).status, 401);
  assert.equal((await sync([], jud)).status, 403);
  assert.equal((await sync([], adm)).status, 403);
  const expired = jwt.sign({ sub: 'c1', role: 'counselor' }, 'jwt-teste', { expiresIn: -10 });
  assert.equal((await sync([item()], expired)).status, 401);
  const { exp, iat } = jwt.decode(c1);
  assert.equal(exp - iat, 5 * 86400);
  assert.equal(jwt.decode(adm).exp - jwt.decode(adm).iat, 8 * 3600);
  assert.equal((await t.call('POST', '/sync/scans', { items: 'x' }, c1)).status, 400);
  assert.equal((await sync(Array.from({ length: 101 }, () => item()))).status, 413);
});

test('aceito: grava aprovada, source qr, submittedAt = momento do scan, aparece no score', async () => {
  reset();
  const it = item({ scanTimestamp: Date.now() - 3600_000 });
  const r = await sync([it]);
  assert.equal(r.status, 200);
  assert.deepEqual([r.body.results[0].status, r.body.results[0].code, r.body.results[0].id], ['aceito', 'ACCEPTED', it.id]);
  const [s] = subsOf('U1', 'RQ');
  assert.deepEqual([s.status, s.source, s.requirementPoints, s.qrVariantId, s.clientId, s.id], ['approved', 'qr', 5, 'v1', it.id, `scan_${it.id}`]);
  assert.equal(s.scanTimestamp, it.scanTimestamp);
  assert.equal(s.submittedAt.seconds, Math.floor(it.scanTimestamp / 1000));
  assert.equal(await scoreOf('U1'), 5);
});

test('idempotência: reenviar o mesmo item (1x ou 5x em paralelo) devolve o mesmo resultado e não duplica', async () => {
  reset();
  const it = item();
  const first = (await sync([it])).body.results[0];
  const again = (await sync([it])).body.results[0];
  assert.equal(first.submissionId, again.submissionId);
  assert.equal(again.status, 'aceito'); assert.equal(again.alreadySynced, true);
  const par = await Promise.all(Array.from({ length: 5 }, () => sync([it])));
  assert.ok(par.every(r => r.body.results[0].status === 'aceito'));
  assert.equal(subsOf('U1', 'RQ').length, 1);
  assert.equal(await scoreOf('U1'), 5);
  // lote com o mesmo item repetido dentro do próprio lote
  reset();
  const dup = item(); const r = (await sync([dup, dup, dup])).body.results;
  assert.deepEqual(r.map(x => x.status), ['aceito', 'aceito', 'aceito']);
  assert.equal(subsOf('U1', 'RQ').length, 1);
});

test('trava (unidade, prova): 2º scan diferente chegando DEPOIS e MAIS NOVO → duplicado', async () => {
  reset();
  const older = item({ scanTimestamp: Date.UTC(2026, 8, 1) + 10_000 });
  const newer = item({ varianteId: 'v2', pontos: 8, scanTimestamp: Date.UTC(2026, 8, 1) + 99_000 });
  assert.equal((await sync([older])).body.results[0].status, 'aceito');
  const r = (await sync([newer])).body.results[0];
  assert.deepEqual([r.status, r.code], ['duplicado', 'DUPLICATE']);
  assert.equal(subsOf('U1', 'RQ').length, 1);
  assert.equal(await scoreOf('U1'), 5);
});

test('DOIS APARELHOS offline: vence o scanTimestamp mais ANTIGO, mesmo chegando por último', async () => {
  reset();
  const now = Date.now();
  const deviceA = item({ varianteId: 'v2', pontos: 8, scanTimestamp: now - 600_000 }); // escaneou MAIS TARDE
  const deviceB = item({ varianteId: 'v1', pontos: 5, scanTimestamp: now - 1_200_000 }); // escaneou ANTES
  assert.equal((await sync([deviceA], c1)).body.results[0].status, 'aceito'); // A sincroniza primeiro
  assert.equal(await scoreOf('U1'), 8);
  const rb = (await sync([deviceB], c1)).body.results[0];                       // B (mais antigo) chega depois
  assert.deepEqual([rb.status, rb.code], ['aceito', 'ACCEPTED_SUPERSEDED']);
  assert.equal(await scoreOf('U1'), 5, 'só o mais antigo pontua');
  const subs = subsOf('U1', 'RQ');
  assert.equal(subs.filter(s => s.status === 'approved').length, 1);
  const lost = subs.find(s => s.id === `scan_${deviceA.id}`);
  assert.deepEqual([lost.status, lost.qrConflict, lost.supersededBy], ['rejected', 'superseded', `scan_${deviceB.id}`]);
  // o aparelho A, ao reenviar, descobre que perdeu (resultado estável)
  const replayA = (await sync([deviceA])).body.results[0];
  assert.deepEqual([replayA.status, replayA.code], ['duplicado', 'SUPERSEDED']);
  assert.equal((await sync([deviceB])).body.results[0].alreadySynced, true);
  assert.equal(await scoreOf('U1'), 5);
});

test('no MESMO lote a ordem de chegada não importa: processa pelo scanTimestamp e responde na ordem enviada', async () => {
  reset();
  const now = Date.now();
  const late = item({ varianteId: 'v2', pontos: 8, scanTimestamp: now - 1000 });
  const early = item({ varianteId: 'v1', pontos: 5, scanTimestamp: now - 9000 });
  const r = (await sync([late, early])).body.results;
  assert.deepEqual(r.map(x => x.id), [late.id, early.id]);
  assert.deepEqual(r.map(x => x.status), ['duplicado', 'aceito']);
  assert.equal(await scoreOf('U1'), 5);
  assert.equal(subsOf('U1', 'RQ').filter(s => s.status === 'approved')[0].qrVariantId, 'v1');
});

test('aprovação manual do admin nunca é substituída por scan (mesmo mais antigo)', async () => {
  reset();
  t.store.insert('submissions', { unitId: 'U1', regionId: 'R1', requirementId: 'RQ', status: 'approved', source: 'region', requirementPoints: 8, submittedAt: { seconds: Math.floor(Date.now() / 1000), nanoseconds: 0 } });
  const r = (await sync([item({ scanTimestamp: Date.now() - 86400_000 })])).body.results[0];
  assert.deepEqual([r.status, r.code], ['duplicado', 'DUPLICATE']);
});

test('rejeições: prova errada, hash inválido/pontos adulterados, outra unidade, variante inexistente, requisito inativo', async () => {
  reset();
  const wrong = (await sync([item({ selectedRequirementId: 'RQ2' })])).body.results[0];
  assert.deepEqual([wrong.status, wrong.code], ['rejeitado', 'WRONG_PROVA']);
  const bad = (await sync([item({ hash: '0000000000000000' })])).body.results[0];
  assert.deepEqual([bad.status, bad.code], ['rejeitado', 'INVALID_HASH']);
  const forged = item({ pontos: 8 }); forged.hash = hash('RQ', 'v1', 5); // hash do QR de 5 pts, pontos trocados p/ 8
  assert.equal((await sync([forged])).body.results[0].code, 'INVALID_HASH');
  const other = (await sync([item({ unitId: 'U2' })])).body.results[0];
  assert.deepEqual([other.status, other.code], ['rejeitado', 'UNIT_MISMATCH']);
  const noVar = (await sync([item({ varianteId: 'zzz' })])).body.results[0];
  assert.deepEqual([noVar.status, noVar.code], ['rejeitado', 'VARIANT_NOT_FOUND']);
  const noReq = (await sync([item({ requisitoId: 'naoexiste' })])).body.results[0];
  assert.equal(noReq.status, 'rejeitado');
  const notCounselor = (await sync([item({ requisitoId: 'RA', varianteId: 'x', pontos: 1 })])).body.results[0];
  assert.deepEqual([notCounselor.status, notCounselor.code], ['rejeitado', 'NOT_COUNSELOR_REQUIREMENT']);
  t.store.update('requirements', 'RQ', { active: false });
  assert.equal((await sync([item()])).body.results[0].code, 'REQUIREMENT_INACTIVE');
  t.store.update('requirements', 'RQ', { active: true });
  // QR desatualizado (pontos da variante mudaram depois de impresso)
  t.store.update('requirements', 'RQ2', { qrVariants: [{ id: 'x1', label: 'Único', points: 4 }] });
  assert.equal((await sync([item({ requisitoId: 'RQ2', varianteId: 'x1', pontos: 3 })])).body.results[0].code, 'POINTS_MISMATCH');
  assert.equal(subsOf('U1', 'RQ').length + subsOf('U1', 'RQ2').length, 0, 'nada foi pontuado');
  // rejeições são estáveis (reenvio dá o mesmo veredito)
  const it = item({ hash: 'ffffffffffffffff' });
  assert.equal((await sync([it])).body.results[0].code, (await sync([it])).body.results[0].code);
});

test('formato inválido não derruba o lote; id com caracteres perigosos é recusado', async () => {
  reset();
  const ok = item();
  const r = (await sync([null, { id: 'x' }, { ...item(), id: '../../etc' }, { ...item(), scanTimestamp: 'ontem' }, ok])).body.results;
  assert.deepEqual(r.map(x => x.status), ['rejeitado', 'rejeitado', 'rejeitado', 'rejeitado', 'aceito']);
  assert.ok(r.slice(0, 4).every(x => x.code === 'INVALID_ITEM'));
});

test('relógio do celular adiantado: scanTimestamp do futuro é limitado ao agora', async () => {
  reset();
  const it = item({ scanTimestamp: Date.now() + 3 * 86400_000 });
  assert.equal((await sync([it])).body.results[0].status, 'aceito');
  const [s] = subsOf('U1', 'RQ');
  assert.ok(s.scanTimestamp <= Date.now());
  assert.equal(s.scanTimestampClamped, true);
});

test('unidades diferentes pontuam a mesma prova de forma independente', async () => {
  reset();
  assert.equal((await sync([item()], c1)).body.results[0].status, 'aceito');
  assert.equal((await sync([item({ unitId: 'U2' })], c2)).body.results[0].status, 'aceito');
  assert.deepEqual([await scoreOf('U1'), await scoreOf('U2')], [5, 5]);
});

test('bootstrap: dados da unidade, SEM hashes; requisitos só do tipo conselheiro; ranking anônimo', async () => {
  reset();
  await sync([item()], c1);
  const r = await t.call('GET', '/sync/bootstrap', undefined, c1);
  assert.equal(r.status, 200);
  const b = r.body;
  assert.equal(b.unit.id, 'U1'); assert.equal(b.region.name, 'Região 1');
  assert.ok(b.requirements.length >= 2 && b.requirements.every(q => q.filledBy === 'conselheiro'));
  const rq = b.requirements.find(q => q.id === 'RQ');
  assert.deepEqual(rq.qrVariants.map(v => Object.keys(v).sort().join()), ['id,label,points', 'id,label,points']);
  assert.ok(!JSON.stringify(b).includes(hash('RQ', 'v1', 5)), 'hash do QR nunca vai pro celular');
  assert.ok(!/"hash"|passwordHash|"password"/.test(JSON.stringify(b)));
  assert.equal(b.submissions.length, 1);
  assert.deepEqual(b.ranking, [{ total: 5 }]);
  assert.equal((await t.call('GET', '/sync/bootstrap?ranking=0', undefined, c1)).body.ranking, null);
  assert.equal((await t.call('GET', '/sync/bootstrap', undefined, jud)).status, 403);
});

test('server/shared (usado pelo Fly.io) é cópia idêntica de shared/ — rode `node scripts/sync-shared.mjs`', () => {
  for (const f of fs.readdirSync(new URL('../../shared', import.meta.url)).filter(f => f.endsWith('.js'))) {
    assert.equal(
      fs.readFileSync(new URL(`../../server/shared/${f}`, import.meta.url), 'utf8'),
      fs.readFileSync(new URL(`../../shared/${f}`, import.meta.url), 'utf8'), `server/shared/${f} desatualizado`);
  }
});
