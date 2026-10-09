// Etapa D.4 — regressão ponta a ponta no MODO LOCAL: "pontos confirmados" e "pontos possíveis" do portal do Conselheiro
// acompanham CADA sincronização (scan de QR, aprovação da região, inspeção de uniforme, disciplina, mudança de requisito)
// e o total é sempre igual ao ranking do servidor. Usa o cliente real (scanQueue + counselorPortalTotals) contra um servidor real.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, seedScenario } from './helpers.js';
import { counselorPortalTotals } from '../../shared/sync.js';

let t, auth, net, sq, cfg, tok;
before(async () => {
  t = await startTestServer(); await seedScenario(t.store);
  t.store.insert('requirements', { name: 'Inspeção de uniforme', points: 10, uniformPenalty: 1, inspection: 'uniforme', filledBy: 'fiscal', category: 'ADM', order: 9, active: true }, 'UNI');
  const ls = {};
  globalThis.localStorage = { getItem: k => ls[k] ?? null, setItem: (k, v) => { ls[k] = String(v); }, removeItem: k => { delete ls[k]; } };
  globalThis.__CAMPORI_LOCAL_APP = 1;
  const u = new URL(t.base);
  globalThis.location = { hostname: u.hostname, port: u.port, origin: t.base };
  globalThis.document = { visibilityState: 'visible' };
  auth = await import('../../js/auth.js'); net = await import('../../js/net.js'); cfg = await import('../../js/config.js'); sq = await import('../../js/scanQueue.js');
  cfg.TIMEOUTS.probeLocal = 500;
  const { user, token } = (await t.call('POST', '/users/login', { username: 'cons1', password: 'senha123' })).body;
  auth.saveSession(user, token); tok = { user, token };
});
after(async () => { await t.close(); });

// o que o celular mostra depois de sincronizar: baixa o snapshot e calcula com a função do portal
async function portal() {
  net.invalidateServer();
  await sq.refreshSnapshot();
  const snap = await sq.loadSnapshot(tok.user.id);
  const totals = counselorPortalTotals(snap.data);
  return totals;
}
async function ranking() {
  const adm = await t.login('admin');
  return (await t.call('GET', '/scores/units', undefined, adm)).body.find(s => s.id === 'U1').total;
}
const check = async (label, expect) => {
  const p = await portal();
  assert.equal(p.confirmed, await ranking(), `${label}: total do portal = ranking`);
  if (expect.confirmed !== undefined) assert.equal(p.confirmed, expect.confirmed, `${label}: confirmados`);
  if (expect.possible !== undefined) assert.equal(p.possible, expect.possible, `${label}: possíveis`);
  return p;
};

test('modo local: confirmados e possíveis atualizam após cada sincronização e batem com o ranking', async () => {
  // possíveis iniciais: unidade (8+7+3) + região (10) + inspeção (10)
  await check('inicial', { confirmed: 0, possible: 38 });
  const adm = await t.login('admin'), ap = await t.login('aprovador'), f = await t.login('fiscal'), reg = await t.login('regiao1');

  // 1) a região envia e o aprovador aprova → vale para todas as unidades da região
  const sub = (await t.call('POST', '/submissions', { requirementId: 'RA', notes: 'ok' }, reg)).body;
  await check('região enviou (pendente não conta)', { confirmed: 0 });
  await t.call('POST', `/submissions/${sub.id}/review`, { status: 'approved' }, ap);
  const p1 = await check('região aprovada', { confirmed: 10 });
  assert.equal(p1.breakdown.region, 10); assert.equal(p1.breakdown.own, 0);

  // 2) scan de QR do conselheiro: entra na fila, sincroniza e soma na unidade
  const qr = (await t.call('POST', '/qr/generate', { requirementId: 'RQ', variantId: 'v1', points: 5 }, f)).body;
  await sq.enqueueScan({ user: tok.user, requirement: { name: 'Prova QR' }, variant: { label: 'Básico' }, payload: qr, selectedRequirementId: 'RQ' });
  const sum = await sq.syncNow({ manual: true });
  assert.equal(sum.accepted.length, 1);
  const p2 = await check('scan de QR sincronizado', { confirmed: 15 });
  assert.equal(p2.breakdown.own, 5);

  // 3) inspeção de uniforme aprovada → só a unidade inspecionada (U1) ganha
  const insp = await t.call('POST', '/submissions/fiscal-suggestion', { requirementId: 'UNI', unitId: 'U1', uniformInspection: { erros: { mangaDireita: 2 } }, clientId: 'reg-1', evaluatedAt: 1 }, f);
  await check('inspeção pendente não conta', { confirmed: 15 });
  await t.call('POST', `/submissions/${insp.body.id}/review`, { status: 'approved' }, ap);
  const p3 = await check('inspeção aprovada', { confirmed: 23 });
  assert.equal(p3.breakdown.own, 13);
  const sc = (await t.call('GET', '/scores/units', undefined, adm)).body;
  assert.equal(sc.find(s => s.id === 'U2').total, 10, 'a outra unidade da região só tem os pontos da região (sem uniforme/QR de U1)');

  // 4) disciplina desconta (e a mesma infração lançada nos 2 lados conta uma vez)
  await t.call('POST', '/discipline', { targetType: 'unit', targetId: 'U1', reason: 'Barulho', clientId: 'disc-reg-1' }, adm);
  const p4 = await check('disciplina', { confirmed: 18 });
  assert.equal(p4.breakdown.discipline, 5);
  t.store.insert('disciplinaryActions', { targetType: 'unit', targetId: 'U1', targetName: 'x', reason: 'barulho', points: 5, origin: 'cloud', createdAt: { seconds: Math.floor(Date.now() / 1000), nanoseconds: 0 } }, 'cloud-twin');
  await check('mesma infração local+nuvem conta uma vez', { confirmed: 18 });

  // 5) o admin muda os pontos de um requisito → "possíveis" acompanham; desativar tira dos possíveis
  await t.call('PATCH', '/data/requirements/RA', { points: 15 }, adm);
  await check('requisito regional 10→15', { possible: 43 });
  await t.call('PATCH', '/data/requirements/RS', { active: false }, adm);
  await check('requisito do conselheiro desativado', { possible: 36 });
  await t.call('PATCH', '/data/requirements/UNI', { points: 20 }, adm);
  await check('inspeção 10→20', { possible: 46 });
});

test('o snapshot offline guarda os últimos números; sem servidor o portal continua mostrando o que já baixou', async () => {
  const before = await portal();
  const realFetch = globalThis.fetch; globalThis.fetch = () => Promise.reject(new TypeError('fetch failed'));
  try {
    net.invalidateServer();
    const snap = await sq.refreshSnapshot();            // falha em silêncio (offline)
    assert.equal(snap, null);
    const kept = counselorPortalTotals((await sq.loadSnapshot(tok.user.id)).data);
    assert.equal(kept.confirmed, before.confirmed); assert.equal(kept.possible, before.possible);
  } finally { globalThis.fetch = realFetch; }
});
