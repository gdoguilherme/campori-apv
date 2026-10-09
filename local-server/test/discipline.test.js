// Etapa C — Disciplina em um único lugar: idempotente por clientId, sem penalidade dupla local × nuvem, exclusão vence,
// aviso de mesma infração em < 10 min.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { startTestServer, seedScenario } from './helpers.js';
import { REPO_ROOT } from '../src/config.js';
import { computeUnitScores, computeUnitBreakdown, dedupeDisciplinaryActions, findRecentSameInfraction, normalizeReason, DISCIPLINE_DUP_WINDOW_MS } from '../../shared/scoring.js';

const FAKE = pathToFileURL(path.resolve(REPO_ROOT, 'local-server/test/fake-firebase-capture.js')).href;
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(s, c, n) { return n(s === './firebase.js' ? ${JSON.stringify(FAKE)} : s, c); }`));

let t, cloudApi, fake;
const ts = ms => ({ seconds: Math.floor(ms / 1000), nanoseconds: 0 });
const T0 = 1_800_000_000_000, MIN = 60_000;
const act = (id, origin, atMin, over = {}) => ({ id, origin, targetType: 'unit', targetId: 'U1', reason: 'Barulho no silêncio', points: 5, createdAt: ts(T0 + atMin * MIN), ...over });

before(async () => {
  t = await startTestServer(); await seedScenario(t.store);
  globalThis.location = { hostname: 'campori.gdtmidia.com.br', port: '', origin: 'https://campori.gdtmidia.com.br' };
  globalThis.localStorage = { getItem: () => null };
  globalThis.document = { createElement: () => ({ style: {}, remove() {} }), body: { appendChild() {} } };
  cloudApi = await import('../../js/api.js'); fake = await import(FAKE);
});
after(async () => { await t.close(); });

const units = [{ id: 'U1', name: 'U1', regionId: 'R1' }, { id: 'U2', name: 'U2', regionId: 'R1' }];
const subs = [{ id: 's', status: 'approved', unitId: 'U1', regionId: 'R1', requirementId: 'x', requirementPoints: 20, submittedAt: ts(T0) }];
const total = (disc, id = 'U1') => computeUnitScores(subs, units, disc).find(u => u.id === id).total;

// ── regra (shared) ─────────────────────────────────────────────────────────────────────────
test('mesma infração lançada local E nuvem em < 10 min conta UMA vez (a mais antiga)', () => {
  assert.equal(total([act('a', 'local', 0)]), 15);
  assert.equal(total([act('a', 'local', 0), act('b', 'cloud', 3)]), 15, 'duplicada: não soma duas vezes');
  const { kept, duplicates } = dedupeDisciplinaryActions([act('b', 'cloud', 3), act('a', 'local', 0)]);
  assert.deepEqual(kept.map(d => d.id), ['a']); assert.deepEqual(duplicates.map(d => [d.id, d.duplicateOf]), [['b', 'a']]);
});

test('NÃO colapsa: mesma origem (admin confirmou), >10 min, motivo/alvo diferente, dados antigos sem origin', () => {
  assert.equal(total([act('a', 'local', 0), act('b', 'local', 3)]), 10, 'mesma origem: o admin foi avisado e confirmou');
  assert.equal(total([act('a', 'local', 0), act('b', 'cloud', 11)]), 10, 'fora da janela de 10 min');
  assert.equal(total([act('a', 'local', 0), act('b', 'cloud', 3, { reason: 'Outro motivo' })]), 10);
  assert.equal(total([act('a', 'local', 0), act('b', 'cloud', 3, { targetId: 'U2' })], 'U1'), 15);
  assert.equal(total([act('a', undefined, 0), act('b', undefined, 3)]), 10, 'legado sem origin = comportamento de sempre');
  assert.equal(normalizeReason('  BARULHO  no   Silêncio '), normalizeReason('barulho no silencio'), 'maiúsculas/acentos/espaços não enganam');
  assert.equal(total([act('a', 'local', 0), act('b', 'cloud', 3, { reason: ' BARULHO no silencio' })]), 15);
});

test('o total do portal (breakdown/bootstrap) continua igual ao ranking com duplicatas', async () => {
  const disc = [act('a', 'local', 0), act('b', 'cloud', 2), act('c', 'cloud', 30, { targetType: 'region', targetId: 'R1', reason: 'Região' })];
  const bd = computeUnitBreakdown({ unit: units[0], unitSubmissions: subs, regionSubmissions: [], disciplinaryActions: disc });
  assert.equal(bd.total, total(disc)); assert.equal(bd.discipline, 10, 'unidade (1x) + região (1x)');
  // ponta a ponta no servidor: ranking × bootstrap do conselheiro
  t.store.insert('submissions', { regionId: 'R1', unitId: 'U1', requirementId: 'RS', requirementPoints: 30, status: 'approved', submittedAt: ts(T0), source: 'region' }, 'sx');
  const now = Date.now();
  t.store.insert('disciplinaryActions', { ...act('x', 'local', 0), createdAt: ts(now - 2 * MIN) }, 'd-local');
  t.store.insert('disciplinaryActions', { ...act('y', 'cloud', 0), createdAt: ts(now - 1 * MIN) }, 'd-cloud');
  const cons = await t.login('cons1');
  const boot = (await t.call('GET', '/sync/bootstrap', undefined, cons)).body;
  const adm = await t.login('admin');
  const scores = (await t.call('GET', '/scores/units', undefined, adm)).body;
  const portal = computeUnitBreakdown({ unit: boot.unit, unitSubmissions: boot.submissions, regionSubmissions: boot.regionSubmissions, disciplinaryActions: boot.disciplinaryActions });
  assert.equal(portal.total, scores.find(s => s.id === 'U1').total);
  assert.equal(boot.disciplinaryActions.length, 1, 'o celular recebe a infração uma vez só');
});

// ── servidor local: idempotência ─────────────────────────────────────────────────────────────
const post = (body, tok) => t.call('POST', '/discipline', body, tok);
const discs = () => t.store.list('disciplinaryActions');

test('POST /discipline com o mesmo clientId (clique duplo / reenvio) cria UMA ação; exclusão vence', async () => {
  const adm = await t.login('admin');
  const before = discs().length;
  const body = { targetType: 'unit', targetId: 'U2', reason: 'Atraso no culto', clientId: 'form-uuid-0001' };
  const a = await post(body, adm), b = await post(body, adm);
  assert.equal(a.body.result, 'created'); assert.equal(b.body.result, 'idempotent'); assert.equal(a.body.id, 'disc_form-uuid-0001');
  assert.equal(discs().length, before + 1);
  assert.equal(discs().find(d => d.id === a.body.id).origin, 'local');
  await t.call('DELETE', `/discipline/${a.body.id}`, undefined, adm);
  const c = await post(body, adm);
  assert.equal(c.body.result, 'deleted-wins'); assert.equal(discs().length, before, 'não ressuscita o que foi excluído');
});

test('mesma infração em < 10 min → 409 DUPLICATE_RECENT; com confirmDuplicate registra; outro motivo/alvo passam', async () => {
  const adm = await t.login('admin');
  const base = { targetType: 'region', targetId: 'R2', reason: 'Descumprimento do horário' };
  assert.equal((await post({ ...base, clientId: 'abc-12345' }, adm)).status, 200);
  const dup = await post({ ...base, reason: ' descumprimento do HORÁRIO', clientId: 'abc-67890' }, adm);
  assert.equal(dup.status, 409); assert.equal(dup.body.code, 'DUPLICATE_RECENT'); assert.match(dup.body.error, /há \d+ min/);
  assert.equal((await post({ ...base, reason: ' descumprimento do HORÁRIO', clientId: 'abc-67890', confirmDuplicate: true }, adm)).status, 200);
  assert.equal((await post({ ...base, reason: 'Outro motivo', clientId: 'abc-99999' }, adm)).status, 200);
  assert.equal((await post({ targetType: 'region', targetId: 'R1', reason: base.reason, clientId: 'abc-55555' }, adm)).status, 200);
});

test('validações e permissões continuam: clientId inválido, alvo inexistente, só admin', async () => {
  const adm = await t.login('admin');
  assert.equal((await post({ targetType: 'unit', targetId: 'U1', reason: 'x', clientId: '../etc' }, adm)).status, 400);
  assert.equal((await post({ targetType: 'unit', targetId: 'NAO', reason: 'x' }, adm)).status, 404);
  assert.equal((await post({ targetType: 'unit', targetId: 'U1', reason: 'x' }, await t.login('fiscal'))).status, 403);
  assert.equal((await post({ targetType: 'unit', targetId: 'U1', reason: 'sem id de cliente (compat.)' }, adm)).status, 200);
});

// ── nuvem ────────────────────────────────────────────────────────────────────────────────────
test('nuvem: mesmo id determinístico (disc_<clientId>) e origin cloud — o servidor local usa o MESMO id, então o sync não duplica', async () => {
  await cloudApi.createDisciplinaryAction({ targetType: 'unit', targetId: 'U1', targetName: 'U1', reason: 'Motivo', clientId: 'form-uuid-0002' }, { username: 'admin', name: 'Adm' });
  const set = fake.calls.find(c => c.op === 'set' && c.col === 'disciplinaryActions');
  assert.equal(set.id, 'disc_form-uuid-0002'); assert.equal(set.data.origin, 'cloud'); assert.equal(set.data.clientId, 'form-uuid-0002'); assert.equal(set.data.points, 5);
  const adm = await t.login('admin');
  const loc = await post({ targetType: 'unit', targetId: 'U1', reason: 'Motivo local', clientId: 'form-uuid-0002' }, adm);
  assert.equal(loc.body.id, set.id, 'mesmo documento nos dois lados');
});

// ── aviso do admin ───────────────────────────────────────────────────────────────────────────
test('aviso no admin: findRecentSameInfraction acha a mesma infração só dentro de 10 min', () => {
  const list = [act('a', 'local', 0)];
  const q = { targetType: 'unit', targetId: 'U1', reason: 'barulho no silencio' };
  assert.equal(findRecentSameInfraction(list, q, T0 + 9 * MIN)?.id, 'a');
  assert.equal(findRecentSameInfraction(list, q, T0 + 10 * MIN + 1), null);
  assert.equal(findRecentSameInfraction(list, { ...q, targetId: 'U2' }, T0 + MIN), null);
  assert.equal(DISCIPLINE_DUP_WINDOW_MS, 600000);
});
