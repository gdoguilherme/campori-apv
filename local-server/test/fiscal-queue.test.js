// Etapa 3 — fila offline do Fiscal: idempotência/ordem/dedupe no servidor + js/fiscalQueue.js (IndexedDB → memória em Node)
// contra um servidor local real, incluindo queda de rede, resposta perdida, sessão expirada e recusa do servidor.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, seedScenario } from './helpers.js';

let t, auth, fq, net, cfg;
const mode = { net: 'ok' };           // 'ok' | 'down' | 'lost-response' | 'hang'
let fiscalPosts = 0;

before(async () => {
  t = await startTestServer();
  await seedScenario(t.store);
  const ls = {};
  globalThis.localStorage = { getItem: k => ls[k] ?? null, setItem: (k, v) => { ls[k] = String(v); }, removeItem: k => { delete ls[k]; } };
  globalThis.__CAMPORI_LOCAL_APP = 1;
  const u = new URL(t.base);
  globalThis.location = { hostname: u.hostname, port: u.port, origin: t.base };
  globalThis.document = { visibilityState: 'visible' };
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, opts = {}) => {
    if (mode.net === 'down') return Promise.reject(new TypeError('fetch failed'));
    if (mode.net === 'hang') return new Promise((_, rej) => opts.signal?.addEventListener('abort', () => rej(Object.assign(new Error('aborted'), { name: 'AbortError' }))));
    if (String(url).endsWith('/submissions/fiscal-suggestion')) fiscalPosts++;
    if (mode.net === 'lost-response' && String(url).endsWith('/submissions/fiscal-suggestion')) {
      return realFetch(url, opts).then(() => { throw new TypeError('connection reset'); }); // o servidor gravou, a resposta se perdeu
    }
    return realFetch(url, opts);
  };
  auth = await import('../../js/auth.js');
  cfg = await import('../../js/config.js');
  net = await import('../../js/net.js');
  fq = await import('../../js/fiscalQueue.js');
  cfg.TIMEOUTS.sync = 400; cfg.TIMEOUTS.probeLocal = 300;
});
after(async () => { await t.close(); });

const login = async username => {
  const { user, token } = (await t.call('POST', '/users/login', { username, password: 'senha123' })).body;
  auth.saveSession(user, token);
  return { user, token };
};
const REQ = { id: 'RA', name: 'Regional A' };
const subsOf = (regionId = 'R1', unitId = null) => t.store.list('submissions', { filters: { requirementId: 'RA', regionId } }).filter(s => s.source === 'judge' && (s.unitId || null) === unitId);
const reset = () => { mode.net = 'ok'; net.invalidateServer(); };

// ── servidor ──────────────────────────────────────────────────────────────────────────────────
test('servidor: reenvio do MESMO clientId não regrava (não "des-aprova" o que o admin já revisou)', async () => {
  const f = await t.login('fiscal'), a = await t.login('admin'), ap = await t.login('aprovador');
  const body = { requirementId: 'RA', regionId: 'R2', points: 7, clientId: 'c-1', evaluatedAt: 1000 };
  const r1 = await t.call('POST', '/submissions/fiscal-suggestion', body, f);
  assert.equal(r1.status, 200); assert.equal(r1.body.result, 'created');
  await t.call('POST', `/submissions/${r1.body.id}/review`, { status: 'approved' }, ap);
  const r2 = await t.call('POST', '/submissions/fiscal-suggestion', body, f);
  assert.equal(r2.body.result, 'idempotent'); assert.equal(r2.body.id, r1.body.id);
  assert.equal(t.store.get('submissions', r1.body.id).status, 'approved', 'continua aprovada');
  assert.equal(t.store.list('submissions', { filters: { requirementId: 'RA', regionId: 'R2' } }).length, 1);
  void a;
});

test('servidor: avaliação mais antiga não sobrescreve a mais nova (result: superseded)', async () => {
  const f = await t.login('fiscal');
  const base = { requirementId: 'RA', regionId: 'R1', unitId: 'U1' };
  const n = await t.call('POST', '/submissions/fiscal-suggestion', { ...base, points: 9, clientId: 'new', evaluatedAt: 5000 }, f);
  const o = await t.call('POST', '/submissions/fiscal-suggestion', { ...base, points: 2, clientId: 'old', evaluatedAt: 4000 }, f);
  assert.equal(o.body.result, 'superseded');
  assert.equal(t.store.get('submissions', n.body.id).requirementPoints, 9);
  const upd = await t.call('POST', '/submissions/fiscal-suggestion', { ...base, points: 6, clientId: 'newer', evaluatedAt: 6000 }, f);
  assert.equal(upd.body.result, 'updated'); assert.equal(t.store.get('submissions', n.body.id).requirementPoints, 6);
});

test('servidor: nunca duplica — dois aparelhos sem existingSubId, ou id que sumiu, caem na mesma avaliação', async () => {
  const f = await t.login('fiscal');
  const b = { requirementId: 'RS', regionId: 'R1', unitId: 'U2', points: 3 };
  const a1 = await t.call('POST', '/submissions/fiscal-suggestion', { ...b, clientId: 'phoneA', evaluatedAt: 100 }, f);
  const a2 = await t.call('POST', '/submissions/fiscal-suggestion', { ...b, points: 5, clientId: 'phoneB', evaluatedAt: 200 }, f);
  assert.equal(a1.body.id, a2.body.id);
  assert.equal(t.store.list('submissions', { filters: { requirementId: 'RS', unitId: 'U2' } }).filter(s => s.source === 'judge').length, 1);
  const a3 = await t.call('POST', '/submissions/fiscal-suggestion', { ...b, points: 4, clientId: 'phoneC', evaluatedAt: 300, existingSubId: 'NAO-EXISTE' }, f);
  assert.equal(a3.status, 200); assert.equal(a3.body.id, a1.body.id);
  assert.equal(t.store.get('submissions', a1.body.id).requirementPoints, 4);
});

test('servidor: validações (points, clientId, requisito) e compatibilidade sem clientId (nuvem/antigo)', async () => {
  const f = await t.login('fiscal');
  assert.equal((await t.call('POST', '/submissions/fiscal-suggestion', { requirementId: 'RA', regionId: 'R1', points: -1 }, f)).status, 400);
  assert.equal((await t.call('POST', '/submissions/fiscal-suggestion', { requirementId: 'RA', regionId: 'R1', points: 1, clientId: 'x'.repeat(200) }, f)).status, 400);
  assert.equal((await t.call('POST', '/submissions/fiscal-suggestion', { requirementId: 'NADA', regionId: 'R1', points: 1 }, f)).status, 404);
  const ok = await t.call('POST', '/submissions/fiscal-suggestion', { requirementId: 'RQ', regionId: 'R2', points: 2 }, f);
  assert.equal(ok.status, 200); assert.equal(ok.body.result, 'created');
  assert.equal((await t.call('POST', '/submissions/fiscal-suggestion', { requirementId: 'RA', regionId: 'R1', points: 1 }, await t.login('regiao1'))).status, 403);
});

// ── cliente (js/fiscalQueue.js) ─────────────────────────────────────────────────────────────
test('cliente: avaliação entra na fila e é enviada; status por item; nada duplicado', async () => {
  reset(); const { user } = await login('fiscal');
  const item = await fq.saveFiscalEvaluation({ user, req: REQ, regionId: 'R1', points: 8, scopeLabel: 'Região 1' });
  assert.equal(item.status, 'enviado'); assert.ok(item.submissionId);
  assert.equal(subsOf('R1').length, 1); assert.equal(subsOf('R1')[0].requirementPoints, 8);
  assert.equal((await fq.listFiscalQueue(user.id)).length, 1);
});

test('cliente: servidor fora do ar → fica pendente (nada se perde); volta → "Sincronizar agora" envia sem duplicar', async () => {
  reset(); const { user } = await login('fiscal');
  mode.net = 'down';
  const item = await fq.saveFiscalEvaluation({ user, req: REQ, regionId: 'R2', points: 4, scopeLabel: 'Região 2' }, { waitMs: 1500 });
  assert.equal(item.status, 'pendente');
  assert.equal(subsOf('R2').filter(s => s.fiscalClientId === item.id).length, 0);
  const sum = await fq.syncFiscalNow({ manual: true });
  assert.equal(sum.offline, true);
  assert.ok(fq.getFiscalSyncState().nextRetryAt > Date.now(), 'backoff agendado');
  mode.net = 'ok'; net.invalidateServer();
  const sum2 = await fq.syncFiscalNow({ manual: true });
  assert.equal(sum2.accepted.length, 1); assert.equal(sum2.accepted[0].id, item.id);
  assert.equal(subsOf('R2').filter(s => s.fiscalClientId === item.id).length, 1);
  assert.equal((await fq.syncFiscalNow({ manual: true })).sent, 0, 'sem pendências → não reenvia');
});

test('cliente: resposta perdida (servidor gravou) → reenvio é idempotente e preserva a aprovação do admin', async () => {
  reset(); const { user } = await login('fiscal');
  mode.net = 'lost-response';
  const item = await fq.saveFiscalEvaluation({ user, req: { id: 'RQ', name: 'Prova QR' }, regionId: 'R1', unitId: 'U1', points: 5, scopeLabel: 'Unidade 1' }, { waitMs: 1500 });
  assert.equal(item.status, 'pendente', 'o aparelho não sabe que gravou');
  const row = t.store.list('submissions', { filters: { requirementId: 'RQ', unitId: 'U1' } }).find(s => s.source === 'judge' && s.fiscalClientId === item.id);
  assert.ok(row, 'o servidor gravou');
  const ap = await t.login('aprovador');
  await t.call('POST', `/submissions/${row.id}/review`, { status: 'approved' }, ap);
  mode.net = 'ok'; net.invalidateServer();
  const sum = await fq.syncFiscalNow({ manual: true });
  assert.equal(sum.accepted.length, 1);
  assert.equal(t.store.get('submissions', row.id).status, 'approved');
  assert.equal(t.store.list('submissions', { filters: { requirementId: 'RQ', unitId: 'U1' } }).filter(s => s.source === 'judge').length, 1);
});

test('cliente: várias avaliações offline do mesmo item são enviadas em ordem — vale a última', async () => {
  reset(); const { user } = await login('fiscal');
  mode.net = 'down';
  const mk = (points, evaluatedAt) => fq.enqueueFiscal({ user, req: { id: 'RS', name: 'Prova Simples' }, regionId: 'R1', unitId: 'U1', points, evaluatedAt, scopeLabel: 'U1' });
  await mk(1, Date.now() + 10); await mk(3, Date.now() + 30); await mk(2, Date.now() + 20);
  mode.net = 'ok'; net.invalidateServer();
  const sum = await fq.syncFiscalNow({ manual: true });
  assert.equal(sum.accepted.length, 3);
  const rows = t.store.list('submissions', { filters: { requirementId: 'RS', unitId: 'U1' } }).filter(s => s.source === 'judge');
  assert.equal(rows.length, 1); assert.equal(rows[0].requirementPoints, 3);
});

test('cliente: sessão expirada (401) → fila intacta e alerta; recusa do servidor (4xx) → item "rejeitado", sem repetir', async () => {
  reset(); const { user } = await login('fiscal');
  auth.saveSession(user, 'token-invalido');
  const item = await fq.enqueueFiscal({ user, req: REQ, regionId: 'R1', points: 1, scopeLabel: 'x' });
  const s1 = await fq.syncFiscalNow({ manual: true });
  assert.equal(s1.authExpired, true); assert.equal(fq.getFiscalSyncState().authExpired, true);
  assert.equal((await fq.listFiscalQueue(user.id)).find(q => q.id === item.id).status, 'pendente');
  await login('fiscal');
  const bad = await fq.enqueueFiscal({ user, req: { id: 'REQ-APAGADO', name: 'x' }, regionId: 'R1', points: 1, scopeLabel: 'x' });
  const before = fiscalPosts;
  const s2 = await fq.syncFiscalNow({ manual: true });
  assert.equal(s2.rejected.length, 1); assert.match(s2.rejected[0].message, /Requisito/);
  assert.equal(fq.getFiscalSyncState().authExpired, false);
  await fq.syncFiscalNow({ manual: true });
  assert.equal(fiscalPosts - before, 2, 'o item recusado não é reenviado (só o pendente de antes foi)');
  assert.equal((await fq.listFiscalQueue(user.id)).find(q => q.id === bad.id).status, 'rejeitado');
});

test('cliente: servidor pendurado → grava e responde rápido ("guardado"); descarte só de itens resolvidos; poda', async () => {
  reset(); const { user } = await login('fiscal');
  mode.net = 'hang';
  const t0 = Date.now();
  const item = await fq.saveFiscalEvaluation({ user, req: REQ, regionId: 'R2', points: 2, scopeLabel: 'x' }, { waitMs: 150 });
  assert.ok(Date.now() - t0 < 3000);
  assert.equal(item.status, 'pendente');
  assert.equal(await fq.discardFiscalItem(item), false, 'pendente não pode ser descartado');
  for (let i = 0; i < 100 && fq.getFiscalSyncState().syncing; i++) await new Promise(r => setTimeout(r, 50)); // o envio pendurado estoura o timeout e termina
  assert.equal(fq.getFiscalSyncState().syncing, false);
  mode.net = 'ok'; net.invalidateServer();
  await fq.syncFiscalNow({ manual: true });
  const q = (await fq.listFiscalQueue(user.id)).find(x => x.id === item.id);
  assert.equal(q.status, 'enviado');
  assert.equal(await fq.discardFiscalItem(q), true);
  assert.equal((await fq.listFiscalQueue(user.id)).some(x => x.id === item.id), false);
  const old = await fq.enqueueFiscal({ user, req: REQ, regionId: 'R1', points: 1, scopeLabel: 'x' });
  await fq.syncFiscalNow({ manual: true });
  const done = (await fq.listFiscalQueue(user.id)).find(x => x.id === old.id);
  assert.equal(done.status, 'enviado');
  await fq.pruneFiscalQueue(user.id, -1000); // enviados/ignorados somem; recusados ficam até o fiscal ver e descartar
  const left = await fq.listFiscalQueue(user.id);
  assert.equal(left.filter(x => x.status === 'enviado' || x.status === 'substituido').length, 0);
  assert.ok(left.every(x => x.status !== 'enviado'));
});

test('cliente: a fila de cada fiscal é separada e a de scans do conselheiro (store "queue") não é tocada', async () => {
  reset(); const { user } = await login('fiscal');
  const idb = await import('../../js/offlineDb.js');
  await idb.put('queue', { id: 'scan-1', userId: 'c1', status: 'pendente' });
  const mine = await fq.enqueueFiscal({ user, req: REQ, regionId: 'R1', points: 1, scopeLabel: 'x' });
  const other = await fq.enqueueFiscal({ user: { id: 'outro-fiscal' }, req: REQ, regionId: 'R1', points: 1, scopeLabel: 'x' });
  const list = await fq.listFiscalQueue(user.id);
  assert.ok(list.some(x => x.id === mine.id)); assert.ok(!list.some(x => x.id === other.id));
  assert.deepEqual(await idb.get('queue', 'scan-1'), { id: 'scan-1', userId: 'c1', status: 'pendente' });
  assert.equal(fq.isQueuePersistent(), false, 'em Node cai para memória e avisa (a UI mostra o alerta)');
});
