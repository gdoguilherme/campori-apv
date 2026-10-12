// Portal do Conselheiro: o bootstrap (servidor local E nuvem) traz tudo para mostrar os pontos da REGIÃO offline,
// e o total calculado no aparelho bate com o ranking do servidor.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import jwt from 'jsonwebtoken';
import { startTestServer, seedScenario } from './helpers.js';
import { computeUnitBreakdown } from '../../shared/scoring.js';
import { buildCounselorBootstrap } from '../../shared/sync.js';

const ts = s => ({ seconds: s, nanoseconds: 0 });
let t, adm, c1, c2, c3;
before(async () => {
  t = await startTestServer(); await seedScenario(t.store);                // R1(DBV): U1,U2 · R2(AVT): U3
  t.store.insert('users', { name: 'cons3', username: 'cons3', role: 'counselor', active: true, regionId: 'R2', unitId: 'U3' }, 'c3');
  [adm, c1, c2] = await Promise.all(['admin', 'cons1', 'cons2'].map(t.login));
  c3 = jwt.sign({ sub: 'c3', role: 'counselor' }, 'jwt-teste', { expiresIn: '1h' });
  const req = (id, o) => t.store.insert('requirements', { category: 'Outros', active: true, order: 10, ...o }, id);
  req('C100', { name: 'Relatório da unidade', points: 100, filledBy: 'conselheiro' });
  req('QR50', { name: 'Prova QR', points: 50, filledBy: 'conselheiro', qrVariants: [{ id: 'q', label: 'Única', points: 50 }] });
  req('REG30', { name: 'Culto regional', points: 30, filledBy: 'regional', competitionCategory: 'Ambos' });
  req('FISC20', { name: 'Avaliação do fiscal', points: 20, filledBy: 'fiscal', competitionCategory: 'Ambos' });
  req('SODBV', { name: 'Só para Desbravadores', points: 15, filledBy: 'regional', competitionCategory: 'DBV' });
  req('SOAVT', { name: 'Só para Aventureiros', points: 12, filledBy: 'regional', competitionCategory: 'AVT' });
  req('OFF', { name: 'Desativado', points: 40, filledBy: 'regional', active: false });
  const sub = (o) => t.store.insert('submissions', { status: 'approved', submittedAt: ts(1000), requirementPoints: 0, ...o });
  sub({ unitId: 'U1', regionId: 'R1', requirementId: 'C100', requirementPoints: 100, source: 'region' });
  sub({ unitId: 'U1', regionId: 'R1', requirementId: 'QR50', requirementPoints: 50, source: 'qr' });
  sub({ unitId: null, regionId: 'R1', requirementId: 'REG30', requirementName: 'Culto regional', requirementPoints: 30, source: 'judge', fiscalSuggestion: true });
  sub({ unitId: null, regionId: 'R1', requirementId: 'FISC20', requirementPoints: 20, status: 'pending', source: 'judge' });
  sub({ unitId: null, regionId: 'R2', requirementId: 'SOAVT', requirementPoints: 12, source: 'region' });                    // outra região
  t.store.insert('disciplinaryActions', { targetType: 'unit', targetId: 'U1', targetName: 'Águias', reason: 'MOTIVO SECRETO', points: 5, createdAt: ts(1) });
  t.store.insert('disciplinaryActions', { targetType: 'region', targetId: 'R2', targetName: 'Região 2', reason: 'outro', points: 5, createdAt: ts(2) });
});
after(() => t.close());

const boot = async token => (await t.call('GET', '/sync/bootstrap', undefined, token)).body;
const rankingOf = async id => (await t.call('GET', '/scores/units', undefined, adm)).body.find(s => s.id === id).total;
const breakdown = (b) => computeUnitBreakdown({ unit: b.unit, unitSubmissions: b.submissions, regionSubmissions: b.regionSubmissions, disciplinaryActions: b.disciplinaryActions });

test('bootstrap traz os pontos da região: requisitos (da modalidade), aprovações regionais e disciplina aplicável — sem segredos', async () => {
  const b = await boot(c1);
  assert.deepEqual(b.regionRequirements.map(r => r.id).sort(), ['FISC20', 'RA', 'REG30', 'SODBV'], 'regionais + "só fiscal" da modalidade DBV; sem o do Conselheiro, sem o AVT, sem o desativado');
  assert.equal(b.regionRequirements.find(r => r.id === 'FISC20').filledBy, 'fiscal');
  assert.deepEqual(b.regionSubmissions.map(s => s.requirementId).sort(), ['FISC20', 'REG30'], 'só as da região R1 sem unitId (nada da R2, nada das unidades)');
  assert.deepEqual(b.disciplinaryActions.map(d => [d.targetType, d.targetId, d.points]), [['unit', 'U1', 5]], 'só a que atinge a U1 (a da R2 não)');
  assert.ok(!JSON.stringify(b).includes('MOTIVO SECRETO'), 'motivo da disciplina não vai para o celular');
  assert.equal(b.region.competitionCategory, 'DBV');
  assert.ok(!/passwordHash|"hash"/.test(JSON.stringify(b)));
});

test('total no aparelho (mesma função do ranking) == ranking do servidor, com a composição X + Y − Z', async () => {
  const b1 = await boot(c1);
  const bd = breakdown(b1);
  assert.deepEqual([bd.own, bd.region, bd.discipline, bd.total], [150, 30, 5, 175]);
  assert.equal(bd.total, await rankingOf('U1'), 'U1: portal == ranking (100 + 50 + 30 − 5)');
  const b2 = breakdown(await boot(c2));                                         // outra unidade da mesma região
  assert.deepEqual([b2.own, b2.region, b2.discipline, b2.total], [0, 30, 0, 30]);
  assert.equal(b2.total, await rankingOf('U2'));
  const b3 = breakdown(await boot(c3));                                         // outra região: só os pontos DELA, com o desconto da região dela
  assert.deepEqual([b3.own, b3.region, b3.discipline, b3.total], [0, 12, 5, 7]);
  assert.equal(b3.total, await rankingOf('U3'));
});

test('modalidade: a região AVT vê os requisitos AVT/Ambos, não os só-DBV; "pts possíveis" = unidade + região', async () => {
  const b3 = await boot(c3);
  assert.deepEqual(b3.regionRequirements.map(r => r.id).sort(), ['FISC20', 'RA', 'REG30', 'SOAVT']);
  const possible = b => b.requirements.reduce((a, r) => a + r.points, 0) + b.regionRequirements.reduce((a, r) => a + r.points, 0);
  const b1 = await boot(c1);
  assert.equal(b1.requirements.reduce((a, r) => a + r.points, 0), 100 + 50 + 8 + 7 + 3, 'requisitos do Conselheiro (os deste cenário + os de seedScenario)');
  assert.equal(possible(b1), b1.requirements.reduce((a, r) => a + r.points, 0) + 10 + 30 + 20 + 15);
});

test('o total continua batendo com o ranking quando a região recebe mais pontos e mais disciplina (inclusive piso em 0)', async () => {
  t.store.insert('submissions', { unitId: null, regionId: 'R1', requirementId: 'SODBV', requirementPoints: 15, status: 'approved', source: 'region', submittedAt: ts(2000) });
  for (let i = 0; i < 3; i++) t.store.insert('disciplinaryActions', { targetType: 'region', targetId: 'R1', points: 5, createdAt: ts(10 + i) });
  for (const [token, id] of [[c1, 'U1'], [c2, 'U2']]) {
    const bd = breakdown(await boot(token));
    assert.equal(bd.total, await rankingOf(id), id);
  }
  assert.deepEqual(Object.values(breakdown(await boot(c1))).slice(0, 4), [150, 45, 20, 175]);   // 150 + 45 − (5 + 15)
  for (let i = 0; i < 12; i++) t.store.insert('disciplinaryActions', { targetType: 'unit', targetId: 'U2', points: 5, createdAt: ts(50 + i) });
  const floored = breakdown(await boot(c2));
  assert.deepEqual([floored.total, floored.floored], [0, true]); assert.equal(await rankingOf('U2'), 0);
});

test('o snapshot é só JSON (guardável no IndexedDB) e o bootstrap sem região/disciplina não quebra', async () => {
  const b = await boot(c1);
  assert.deepEqual(JSON.parse(JSON.stringify(b)), b);
  const bare = buildCounselorBootstrap({ user: { id: 'x' }, unit: { id: 'U1', regionId: 'R1' }, region: { id: 'R1' }, nowMs: 1 });
  assert.deepEqual([bare.regionRequirements, bare.regionSubmissions, bare.disciplinaryActions], [[], [], []]);
});
