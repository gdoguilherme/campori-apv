// Etapa A — Inspeção de Uniforme: regra única (shared/uniforme.js), servidor local, fila offline, caminho da nuvem
// (api.js com Firestore simulado), permissões, ranking anônimo e CSV.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { startTestServer, seedScenario } from './helpers.js';
import { REPO_ROOT } from '../src/config.js';
import { computeUnitScores } from '../../shared/scoring.js';
import * as U from '../../shared/uniforme.js';

// Firestore simulado: grava o que o api.js (nuvem) tentaria escrever
const FAKE = pathToFileURL(path.resolve(REPO_ROOT, 'local-server/test/fake-firebase-capture.js')).href;
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(s, c, n) { return n(s === './firebase.js' ? ${JSON.stringify(FAKE)} : s, c); }`));

let t, fq, net, auth, cfg, cloudApi, fake;
const REQ = { id: 'UNI', name: 'Inspeção de uniforme', points: 10, uniformPenalty: 1, inspection: 'uniforme', filledBy: 'fiscal', category: 'ADM', order: 9, active: true };

before(async () => {
  t = await startTestServer();
  await seedScenario(t.store);
  t.store.insert('requirements', { ...REQ }, 'UNI');
  const ls = {};
  globalThis.localStorage = { getItem: k => ls[k] ?? null, setItem: (k, v) => { ls[k] = String(v); }, removeItem: k => { delete ls[k]; } };
  globalThis.__CAMPORI_LOCAL_APP = 1;
  const u = new URL(t.base);
  globalThis.location = { hostname: u.hostname, port: u.port, origin: t.base };
  globalThis.document = { visibilityState: 'visible', body: { appendChild() {} }, createElement: () => ({ style: {}, remove() {} }) };
  auth = await import('../../js/auth.js'); cfg = await import('../../js/config.js'); net = await import('../../js/net.js');
  fq = await import('../../js/fiscalQueue.js');
  fake = await import(FAKE);
  cloudApi = await import('../../js/api.js');
  cfg.TIMEOUTS.sync = 500; cfg.TIMEOUTS.probeLocal = 300;
});
after(async () => { await t.close(); });

const post = (body, token) => t.call('POST', '/submissions/fiscal-suggestion', body, token);
const unitSubs = (unitId = 'U1') => t.store.list('submissions', { filters: { requirementId: 'UNI', unitId } });

// ── regra única ────────────────────────────────────────────────────────────────────────────
test('regra: máx − erros × desconto, mínimo 0; OPCIONAIS não desconta; só as 8 categorias da ficha', () => {
  assert.equal(U.UNIFORM_CATEGORIES.length, 8);
  assert.deepEqual(U.UNIFORM_KEYS, ['mangaDireita', 'mangaEsquerda', 'bolsoDireito', 'bolsoEsquerdo', 'lencoArganel', 'calcadosMeias', 'faixaBandeiraGlobo', 'opcionais']);
  assert.equal(U.UNIFORM_CATEGORIES.filter(c => c.optional).map(c => c.key).join(), 'opcionais');
  assert.equal(U.computeUniformPoints({}, REQ).pontos, 10);
  assert.equal(U.computeUniformPoints({ mangaDireita: 2, bolsoEsquerdo: 1 }, REQ).pontos, 7);
  assert.equal(U.computeUniformPoints({ opcionais: 50 }, REQ).pontos, 10, 'opcionais não descontam');
  assert.equal(U.computeUniformPoints({ opcionais: 50 }, REQ).opcionais, 50);
  assert.equal(U.computeUniformPoints({ mangaDireita: 99 }, REQ).pontos, 0, 'nunca negativo');
  assert.equal(U.computeUniformPoints({ mangaDireita: 3 }, { ...REQ, points: 20, uniformPenalty: 2.5 }).pontos, 12.5);
  assert.equal(U.computeUniformPoints({ mangaDireita: 3 }, { inspection: 'uniforme' }).pontos, 7, 'sem cadastro → padrão máx 10, −1');
  assert.match(U.uniformRuleText({ ...REQ, points: 15, uniformPenalty: 2 }), /máximo 15 pts, −2 pts por erro/);
});

test('entrada saneada: chaves desconhecidas, negativos, decimais, textos enormes', () => {
  const n = U.normalizeUniformInspection({ erros: { mangaDireita: '3.9', bolsoDireito: -4, hack: 5, calcadosMeias: 'abc', opcionais: 100000 }, observacoes: { mangaDireita: '  torta  ', hack: 'x', lencoArganel: 'y'.repeat(900) } });
  assert.equal(n.erros.mangaDireita, 3); assert.equal(n.erros.bolsoDireito, 0); assert.equal(n.erros.calcadosMeias, 0);
  assert.equal(n.erros.opcionais, U.UNIFORM_MAX_ERRORS); assert.ok(!('hack' in n.erros) && !('hack' in n.observacoes));
  assert.equal(n.observacoes.mangaDireita, 'torta'); assert.equal(n.observacoes.lencoArganel.length, U.UNIFORM_MAX_NOTE);
  assert.deepEqual(Object.keys(U.normalizeUniformInspection(null).erros), U.UNIFORM_KEYS);
});

test('paridade: server/shared tem a MESMA regra (nuvem) e o servidor local devolve o que a função calcula (300 casos)', async () => {
  assert.equal(fs.readFileSync(path.join(REPO_ROOT, 'shared/uniforme.js'), 'utf8'), fs.readFileSync(path.join(REPO_ROOT, 'server/shared/uniforme.js'), 'utf8'));
  const cloudCopy = await import('../../server/shared/uniforme.js');
  const f = await t.login('fiscal');
  let seed = 7; const rnd = n => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let i = 0; i < 300; i++) {
    const erros = Object.fromEntries(U.UNIFORM_KEYS.map(k => [k, rnd(4) === 0 ? rnd(8) : 0]));
    const req = { ...REQ, points: 5 + rnd(30), uniformPenalty: [0, 0.5, 1, 2, 3][rnd(5)] };
    const expected = U.computeUniformPoints(erros, req).pontos;
    assert.equal(cloudCopy.computeUniformPoints(erros, req).pontos, expected);
    if (i % 30 === 0) { // servidor: muda o cadastro e confere ponta a ponta
      t.store.update('requirements', 'UNI', { points: req.points, uniformPenalty: req.uniformPenalty });
      const r = await post({ requirementId: 'UNI', unitId: 'U3', uniformInspection: { erros }, clientId: `par-${i}`, evaluatedAt: 1000 + i }, f);
      assert.equal(r.status, 200); assert.equal(r.body.requirementPoints, expected);
    }
  }
  t.store.update('requirements', 'UNI', { points: 10, uniformPenalty: 1 });
});

// ── servidor local ───────────────────────────────────────────────────────────────────────────
test('servidor: grava submission da UNIDADE (pendente), região derivada, pontos recalculados no servidor (ignora pontos do cliente)', async () => {
  const f = await t.login('fiscal');
  const r = await post({ requirementId: 'UNI', unitId: 'U1', regionId: 'R2', points: 999, clientId: 'u1-a', evaluatedAt: 5000,
    uniformInspection: { erros: { mangaDireita: 2, lencoArganel: 1, opcionais: 4 }, observacoes: { mangaDireita: 'costura solta' } } }, f);
  assert.equal(r.status, 200); assert.equal(r.body.result, 'created');
  const s = t.store.get('submissions', r.body.id);
  assert.equal(s.requirementPoints, 7); assert.equal(s.status, 'pending'); assert.equal(s.unitId, 'U1'); assert.equal(s.regionId, 'R1', 'região vem da unidade, não do cliente');
  assert.equal(s.fiscalSuggestion, true); assert.equal(s.source, 'judge');
  assert.equal(s.uniformInspection.erros.mangaDireita, 2); assert.equal(s.uniformInspection.avaliadorId, 'jud'); assert.equal(s.uniformInspection.avaliadoEm, 5000);
  assert.equal(s.uniformInspection.observacoes.mangaDireita, 'costura solta');
});

test('servidor: reavaliar a mesma unidade SUBSTITUI (a mais recente vale), sem duplicar; a mais antiga é ignorada; reenvio é idempotente', async () => {
  const f = await t.login('fiscal');
  const base = { requirementId: 'UNI', unitId: 'U2' };
  const a = await post({ ...base, uniformInspection: { erros: { mangaDireita: 5 } }, clientId: 'x1', evaluatedAt: 100 }, f);
  const b = await post({ ...base, uniformInspection: { erros: { mangaDireita: 1 } }, clientId: 'x2', evaluatedAt: 200 }, f);
  assert.equal(b.body.id, a.body.id); assert.equal(b.body.result, 'updated');
  assert.equal(unitSubs('U2').length, 1); assert.equal(unitSubs('U2')[0].requirementPoints, 9);
  const old = await post({ ...base, uniformInspection: { erros: { mangaDireita: 9 } }, clientId: 'x0', evaluatedAt: 50 }, f);
  assert.equal(old.body.result, 'superseded'); assert.equal(unitSubs('U2')[0].requirementPoints, 9);
  const again = await post({ ...base, uniformInspection: { erros: { mangaDireita: 1 } }, clientId: 'x2', evaluatedAt: 200 }, f);
  assert.equal(again.body.result, 'idempotent');
  // "pontos duplicados": aprovada uma vez, a unidade soma só uma vez
  const ap = await t.login('aprovador');
  await t.call('POST', `/submissions/${a.body.id}/review`, { status: 'approved' }, ap);
  const sc = computeUnitScores(t.store.list('submissions'), t.store.list('units'), []);
  assert.equal(sc.find(x => x.id === 'U2').total, 9);
});

test('pontos só na UNIDADE inspecionada (a outra unidade da região e a região não ganham)', async () => {
  const f = await t.login('fiscal'), ap = await t.login('aprovador');
  const r = await post({ requirementId: 'UNI', unitId: 'U1', uniformInspection: { erros: { bolsoDireito: 3 } }, clientId: 'only', evaluatedAt: 9000 }, f);
  await t.call('POST', `/submissions/${r.body.id}/review`, { status: 'approved' }, ap);
  const sc = Object.fromEntries(computeUnitScores(t.store.list('submissions'), t.store.list('units'), []).map(s => [s.id, s.total]));
  assert.equal(sc.U1, 7); assert.equal(sc.U3, 0);
  assert.ok(sc.U2 === 9, 'U2 só tem os pontos da própria inspeção (9), nada de U1');
});

test('servidor: validações e permissões (conselheiro/região não; requisito comum não; unidade obrigatória)', async () => {
  const f = await t.login('fiscal');
  const ok = { requirementId: 'UNI', unitId: 'U1', uniformInspection: { erros: {} } };
  assert.equal((await post(ok, await t.login('cons1'))).status, 403);
  assert.equal((await post(ok, await t.login('regiao1'))).status, 403);
  assert.equal((await post(ok)).status, 401);
  assert.equal((await post({ requirementId: 'UNI', uniformInspection: { erros: {} } }, f)).status, 422, 'sem unidade');
  assert.equal((await post({ requirementId: 'UNI', unitId: 'NAO', uniformInspection: { erros: {} } }, f)).status, 422);
  assert.equal((await post({ requirementId: 'RA', unitId: 'U1', uniformInspection: { erros: {} } }, f)).status, 422, 'requisito que não é uniforme');
  assert.equal((await post({ requirementId: 'UNI', regionId: 'R1', points: 5 }, f)).status, 422, 'uniforme não passa pela avaliação comum');
  assert.equal((await post(ok, await t.login('admin'))).status, 200, 'admin também pode');
});

test('ranking anônimo continua anônimo e o conselheiro vê "Inspeção" só leitura em pontos possíveis (bootstrap)', async () => {
  const rows = (await t.call('GET', '/ranking')).body;
  assert.ok(rows.length > 0 && rows.every(r => Object.keys(r).sort().join() === 'position,stars,total'));
  const boot = (await t.call('GET', '/sync/bootstrap', undefined, await t.login('cons1'))).body;
  assert.equal(boot.inspectionRequirements.length, 1); assert.equal(boot.inspectionRequirements[0].points, 10);
  assert.ok(!boot.regionRequirements.some(r => r.id === 'UNI'), 'uniforme não é "da região"');
  assert.ok(!boot.requirements.some(r => r.id === 'UNI'), 'conselheiro não envia uniforme');
  assert.ok(!JSON.stringify(boot).includes('uniformInspection'), 'o conselheiro não recebe o detalhe da ficha');
});

// ── fila offline do Fiscal ────────────────────────────────────────────────────────────────
test('fila offline: inspeção feita sem servidor fica guardada e sobe depois, idempotente', async () => {
  const { user, token } = (await t.call('POST', '/users/login', { username: 'fiscal', password: 'senha123' })).body;
  auth.saveSession(user, token);
  const realFetch = globalThis.fetch; let down = true;
  globalThis.fetch = (u, o) => (down ? Promise.reject(new TypeError('fetch failed')) : realFetch(u, o));
  try {
    net.invalidateServer();
    const item = await fq.saveFiscalEvaluation({ user, req: REQ, regionId: 'R1', unitId: 'U2', points: 6, scopeLabel: 'U2',
      uniformInspection: { erros: { mangaDireita: 4 }, observacoes: { mangaDireita: 'ok' } }, evaluatedAt: Date.now() + 1000 }, { waitMs: 800 });
    assert.equal(item.status, 'pendente');
    down = false; net.invalidateServer();
    const sum = await fq.syncFiscalNow({ manual: true });
    assert.equal(sum.accepted.length, 1);
    assert.equal(unitSubs('U2')[0].requirementPoints, 6);
    assert.equal(unitSubs('U2')[0].uniformInspection.observacoes.mangaDireita, 'ok');
    assert.equal(unitSubs('U2').length, 1);
  } finally { globalThis.fetch = realFetch; }
});

// ── nuvem (Firestore simulado) ──────────────────────────────────────────────────────────────
test('nuvem: api.doUniformInspection usa a mesma regra, cria PENDENTE e reavaliação atualiza a existente', async () => {
  const user = { id: 'jud', name: 'Fiscal', username: 'fiscal' };
  const unit = { id: 'U1', regionId: 'R1', name: 'Unidade 1' };
  const insp = { erros: { mangaDireita: 3, opcionais: 9 }, observacoes: { opcionais: 'boné' } };
  const r1 = await cloudApi.doUniformInspection(REQ, unit, insp, user, null);
  assert.equal(r1.points, 7);
  const add = fake.calls.find(c => c.op === 'add');
  assert.equal(add.data.requirementPoints, 7); assert.equal(add.data.status, 'pending'); assert.equal(add.data.unitId, 'U1'); assert.equal(add.data.fiscalSuggestion, true);
  assert.equal(add.data.uniformInspection.erros.mangaDireita, 3); assert.equal(add.data.uniformInspection.avaliadorId, 'jud');
  await cloudApi.doUniformInspection(REQ, unit, { erros: { mangaDireita: 1 } }, user, 'sub-existente');
  const upd = fake.calls.find(c => c.op === 'update');
  assert.equal(upd.id, 'sub-existente'); assert.equal(upd.data.requirementPoints, 9); assert.equal(upd.data.status, 'pending');
  assert.ok(!('regionId' in upd.data), 'atualização não recria a submission');
});

// ── CSV ──────────────────────────────────────────────────────────────────────────────────────
test('CSV: colunas da ficha, total/pontos, observações, aspas e proteção contra fórmula', () => {
  const subs = [{
    id: 's1', requirementId: 'UNI', unitId: 'U1', regionId: 'R1', regionName: 'Região 1', status: 'approved', requirementPoints: 7,
    uniformInspection: { erros: { mangaDireita: 2, lencoArganel: 1, opcionais: 3 }, observacoes: { mangaDireita: 'costura "solta"', opcionais: '=HYPERLINK("x")' }, avaliadorNome: '+Fiscal', avaliadoEm: 5000 }
  }, { id: 's2', requirementId: 'RA', status: 'pending' }];
  const csv = U.buildUniformCsv({ submissions: subs, units: [{ id: 'U1', name: 'Águias' }], regions: [], requirements: [REQ], fmtDateTime: ms => `T${ms}` });
  assert.ok(csv.startsWith('﻿'));
  const [head, row, extra] = csv.slice(1).split('\r\n');
  assert.equal(extra, undefined, 'só submissions com inspeção');
  assert.equal(head.split(';').length, 4 + 8 + 4);
  assert.match(head, /"Manga direita";"Manga esquerda";"Bolso direito";"Bolso esquerdo";"Lenço \/ Arganel";"Calçados \/ Meias";"Faixa \/ Bandeira \/ Globo";"Opcionais";"Total de erros";"Pontos";"Status";"Observações"/);
  assert.match(row, /^"Região 1";"Águias";"'\+Fiscal";"T5000";"2";"0";"0";"0";"1";"0";"0";"3";"3";"7";"Aprovada";/);
  assert.match(row, /costura ""solta""/); assert.match(row, /Opcionais: =HYPERLINK/, 'a observação sempre começa com o nome da categoria → nunca vira fórmula');
  const evil = U.buildUniformCsv({ submissions: [{ ...subs[0], uniformInspection: { ...subs[0].uniformInspection, avaliadorNome: '=cmd|calc' } }], units: [], regions: [], requirements: [REQ] });
  assert.match(evil, /"'=cmd\|calc"/);
});

test('arquivos: imagens de referência existem, ≤ 300 KB, e a página entra no app-shell offline (sw.js)', () => {
  for (const n of ['mangas', 'bolsos-lenco', 'faixa-calcados', 'bandeira-globo-opcionais']) {
    const f = path.join(REPO_ROOT, 'assets/uniforme', `${n}.png`);
    assert.ok(fs.statSync(f).size <= 300 * 1024, n);
  }
  const sw = fs.readFileSync(path.join(REPO_ROOT, 'sw.js'), 'utf8');
  for (const p of ['/pages/inspecao-uniforme.html', '/js/inspecao-uniforme.js', '/shared/uniforme.js', '/assets/uniforme/mangas.png', '/assets/uniforme/bolsos-lenco.png', '/assets/uniforme/faixa-calcados.png', '/assets/uniforme/bandeira-globo-opcionais.png'])
    assert.ok(sw.includes(`"${p}"`), `${p} no shell do SW (rode node scripts/build-sw.mjs)`);
  assert.ok(!sw.includes('ficha-original.pdf'), 'o PDF original não vai para o cache');
});
