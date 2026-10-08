// Etapa 1 — modo local total: js/api-local.js contra um servidor local REAL (Express + SQLite em memória).
// Roda em Node com location/localStorage/document simulados; o hook de resolução troca ./firebase.js pelo stub
// (o mesmo que o import map faz no navegador), então nenhuma chamada ao Firestore é possível.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { startTestServer, seedScenario } from './helpers.js';
import { Store } from '../src/db.js';
import { createApp } from '../src/app.js';
import { REPO_ROOT } from '../src/config.js';

const stubUrl = pathToFileURL(path.join(REPO_ROOT, 'js', 'firebase-stub.js')).href;
register('data:text/javascript,' + encodeURIComponent(
  `export async function resolve(s, c, n) { return n(s === './firebase.js' ? ${JSON.stringify(stubUrl)} : s, c); }`));

let t, api, auth, ls, fetched;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const until = async (fn, ms = 6000) => { const end = Date.now() + ms; while (Date.now() < end) { if (fn()) return true; await sleep(25); } return false; };

const loginAs = async username => {
  const { user, token } = await api.loginUser(username, 'senha123');
  auth.saveSession(user, token);
  return { user, token };
};

before(async () => {
  t = await startTestServer();
  await seedScenario(t.store);
  ls = {};
  globalThis.localStorage = { getItem: k => ls[k] ?? null, setItem: (k, v) => { ls[k] = String(v); }, removeItem: k => { delete ls[k]; } };
  const u = new URL(t.base);
  globalThis.location = { hostname: u.hostname, port: u.port, origin: t.base, href: t.base + '/' };
  globalThis.document = { hidden: false, body: { appendChild() {} }, createElement: () => ({ style: {}, remove() {} }), addEventListener() {}, removeEventListener() {} };
  globalThis.__CAMPORI_POLL_MS = 80;
  fetched = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (url, ...rest) => { fetched.push(String(url)); return realFetch(url, ...rest); };
  auth = await import('../../js/auth.js');
  api = await import('../../js/api-local.js');
});
after(async () => { await t.close(); });

test('paridade: api-local exporta tudo que api.js exporta (as páginas não percebem a troca)', () => {
  const src = fs.readFileSync(path.join(REPO_ROOT, 'js', 'api.js'), 'utf8');
  const names = [...src.matchAll(/^export (?:async )?(?:function|const) (\w+)/gm)].map(m => m[1]);
  names.push('reqFilledBy', 'computeUnitScores', 'computeStars', 'findQrDuplicate', 'DISCIPLINE_POINTS');
  const missing = [...new Set(names)].filter(n => !(n in api));
  assert.deepEqual(missing, []);
});

test('timestamps do servidor viram objetos com toDate()/toMillis()/seconds', () => {
  const v = api.revive({ a: { seconds: 1700000000, nanoseconds: 5e8 }, n: [{ seconds: 1, nanoseconds: 0 }], x: 3 });
  assert.equal(v.a.seconds, 1700000000);
  assert.equal(v.a.toMillis(), 1700000000500);
  assert.ok(v.a.toDate() instanceof Date);
  assert.equal(v.n[0].seconds, 1);
  assert.equal(v.x, 3);
  assert.deepEqual(JSON.parse(JSON.stringify(v.a)), { seconds: 1700000000, nanoseconds: 5e8 });
  assert.match(api.fmtDate(v.a), /\d{2}\/\d{2}\/\d{2}/);
});

test('login de todos os perfis e ensureInitialAdmin (já existem usuários → null)', async () => {
  for (const [name, role] of [['admin', 'superadmin'], ['aprovador', 'approver'], ['fiscal', 'judge'], ['regiao1', 'region'], ['cons1', 'counselor']]) {
    const { user, token } = await loginAs(name);
    assert.equal(user.role, role); assert.ok(token);
  }
  await assert.rejects(api.loginUser('admin', 'errada'), e => e.status === 401);
  await loginAs('admin');
  assert.equal(await api.ensureInitialAdmin(), null);
});

test('listeners: regiões ordenadas, requisitos por order, unidade única, participantes/submissões por filtro', async () => {
  await loginAs('admin');
  const got = {};
  const stops = [
    api.subRegions(d => { got.regions = d; }), api.subReqs(d => { got.reqs = d; }),
    api.subUnits(d => { got.units = d; }), api.subUnitById('U1', d => { got.u1 = d; }), api.subUnitById('NAO', d => { got.none = d; }),
    api.subParticipants(d => { got.parts = d; }), api.subParticipantsByUnit('U1', d => { got.partsU1 = d; }),
    api.subSubs(null, d => { got.subs = d; }), api.subSubs('R1', d => { got.subsR1 = d; }), api.subSubsByUnit('U1', d => { got.subsU1 = d; }),
    api.subDisciplinaryActions(d => { got.disc = d; })
  ];
  assert.ok(await until(() => Object.keys(got).length === 11), 'todos os listeners devem entregar o primeiro resultado');
  assert.deepEqual(got.regions.map(r => r.name), ['Região 1', 'Região 2']);
  assert.deepEqual(got.reqs.map(r => r.id), ['RA', 'RQ', 'RS', 'RQ2']);
  assert.equal(got.units.length, 3);
  assert.equal(got.u1.name, 'Unidade 1'); assert.equal(got.u1.id, 'U1');
  assert.equal(got.none, null);
  assert.ok(Array.isArray(got.parts) && Array.isArray(got.partsU1) && Array.isArray(got.disc));
  stops.forEach(s => s());
});

test('polling: mudança no servidor chega ao listener; sem mudança não re-renderiza; cancelar para tudo', async () => {
  await loginAs('admin');
  let calls = 0, last;
  const stop = api.subRegions(d => { calls++; last = d; });
  assert.ok(await until(() => calls === 1));
  await sleep(400);
  assert.equal(calls, 1, 'nada mudou → callback não repete');
  t.store.insert('regions', { name: 'Região 0', competitionCategory: 'DBV', active: true }, 'R0');
  assert.ok(await until(() => calls === 2), 'inserção vista pelo polling');
  assert.equal(last[0].name, 'Região 0');
  t.store.remove('regions', 'R0');
  assert.ok(await until(() => calls === 3), 'exclusão vista pelo polling');
  assert.equal(last.length, 2);
  stop();
  t.store.insert('regions', { name: 'Região Z', competitionCategory: 'DBV', active: true }, 'RZ');
  await sleep(400);
  assert.equal(calls, 3, 'depois de cancelar, nenhum callback');
  t.store.remove('regions', 'RZ');
});

test('região e conselheiro enviam; duplicidade aprovada → 409; prova anexada; aprovador revisa', async () => {
  const reg = await loginAs('regiao1');
  const id = await api.addSubmission(reg.user, { id: 'RA', name: 'Regional A' }, 'ok', null);
  assert.ok(id);
  await api.updateSubmissionProof(id, 'http://x/y.jpg');
  const cons = await loginAs('cons1');
  const cid = await api.addSubmission(cons.user, { id: 'RS' }, 'n', 'http://x/p.jpg');
  assert.ok(cid);
  await loginAs('aprovador');
  await api.review(id, 'approved', '', { username: 'aprovador' });
  const row = t.store.get('submissions', id);
  assert.equal(row.status, 'approved'); assert.equal(row.proofUrl, 'http://x/y.jpg');
  assert.ok(t.store.list('auditLog').some(a => a.submissionId === id && a.action === 'approved'));
  await loginAs('regiao1');
  await assert.rejects(api.addSubmission(reg.user, { id: 'RA' }, 'de novo'), e => e.status === 409);
});

test('fiscal cria e atualiza a sugestão (fica pendente)', async () => {
  const f = await loginAs('fiscal');
  await api.doFiscalSuggestion({ id: 'RA', name: 'Regional A' }, 'R2', 6, { a: 1 }, { a: 60 }, f.user, null, null);
  const sug = t.store.list('submissions', { filters: { regionId: 'R2', requirementId: 'RA' } })[0];
  assert.equal(sug.status, 'pending'); assert.equal(sug.fiscalSuggestion, true); assert.equal(sug.requirementPoints, 6);
  await api.doFiscalSuggestion({ id: 'RA', name: 'Regional A' }, 'R2', 9, null, null, f.user, sug.id, null);
  assert.equal(t.store.get('submissions', sug.id).requirementPoints, 9);
});

test('admin: requisitos, usuários, regiões (com login), participantes, unidades, envios e disciplina', async () => {
  const { token } = await loginAs('admin');
  // requisitos
  await api.saveReq({ name: 'Novo', points: 4, category: 'ADM', filledBy: 'regional' }, 4);
  const novo = t.store.list('requirements').find(r => r.name === 'Novo');
  assert.equal(novo.order, 4); assert.equal(novo.active, true);
  await api.saveReq({ id: novo.id, points: 5 }, 4);
  assert.equal(t.store.get('requirements', novo.id).points, 5);
  await api.delReq(novo.id);
  assert.equal(t.store.get('requirements', novo.id), null);
  // usuários
  const cu = await api.createUser({ name: 'Zé Teste', role: 'judge', password: 'abcd1234' }, token);
  assert.ok(cu.id && cu.username);
  assert.ok((await api.fetchUsers(token)).some(u => u.id === cu.id));
  await api.updateUser(cu.id, { name: 'Zé Editado' }, token);
  await api.toggleUserActive(cu.id, true, token);
  assert.equal(t.store.get('users', cu.id).active, false); assert.equal(t.store.get('users', cu.id).name, 'Zé Editado');
  assert.equal(t.store.db.prepare('SELECT dirty FROM users WHERE id = ?').get(cu.id).dirty, 1, 'gravado no SQLite com dirty=1');
  await api.updatePassword(cu.id, 'nova1234', token);
  await api.toggleUserActive(cu.id, false, token);
  assert.equal((await api.loginUser(cu.username, 'nova1234')).user.role, 'judge');
  await loginAs('admin');
  await api.deleteUser(cu.id, token);
  assert.equal(t.store.get('users', cu.id), null);
  // regiões (+ usuário vinculado)
  const r = await api.createRegion({ name: 'Região Nova', responsible: 'Maria Silva', responsiblePhone: '1', competitionCategory: 'AVT', password: 'senha9999' }, token);
  assert.ok(r.id && r.username);
  assert.equal((await api.loginUser(r.username, 'senha9999')).user.regionId, r.id);
  await loginAs('admin');
  const linked = t.store.list('users').find(u => u.regionId === r.id).id;
  await api.updateRegion(r.id, { name: 'Região Nova 2', competitionCategory: 'DBV', active: true }, linked, 'outra1234', token);
  assert.equal(t.store.get('regions', r.id).name, 'Região Nova 2');
  assert.equal((await api.loginUser(r.username, 'outra1234')).user.name, 'Região Nova 2');
  await loginAs('admin');
  await api.delRegion(r.id, linked, token);
  assert.equal(t.store.get('regions', r.id), null); assert.equal(t.store.get('users', linked), null);
  // unidades e participantes
  const uid = await api.createUnit({ name: 'U Nova', warCry: 'grito', regionId: 'R1' });
  await api.createParticipant({ name: 'P1', regionId: 'R1', competitionCategory: 'DBV', unitId: uid });
  assert.equal(await api.createParticipantsBulk([{ name: 'P2', regionId: 'R1', competitionCategory: 'AVT' }, { name: 'P3', regionId: 'R1', competitionCategory: 'AVT' }]), 2);
  const ps = t.store.list('participants').filter(p => p.regionId === 'R1');
  assert.equal(ps.length, 3);
  const p2 = ps.find(p => p.name === 'P2');
  await api.allocateParticipant(p2.id, uid);
  await api.updateParticipant(p2.id, { club: 'Clube X' });
  assert.equal(t.store.get('participants', p2.id).unitId, uid); assert.equal(t.store.get('participants', p2.id).club, 'Clube X');
  await api.updateUnit(uid, { warCry: 'novo' });
  await api.deleteUnit(uid, ps.filter(p => p.unitId === uid).map(p => p.id).concat(p2.id));
  assert.equal(t.store.get('units', uid), null);
  assert.ok(t.store.list('participants').filter(p => p.regionId === 'R1').every(p => !p.unitId));
  await api.deleteParticipant(p2.id);
  assert.equal(t.store.get('participants', p2.id), null);
  // envio apagado
  const sid = t.store.list('submissions')[0].id;
  await api.deleteSubmission(sid);
  assert.equal(t.store.get('submissions', sid), null);
  // disciplina
  await api.createDisciplinaryAction({ targetType: 'unit', targetId: 'U2', targetName: 'x', reason: 'barulho' }, { username: 'admin' });
  const d = t.store.list('disciplinaryActions')[0];
  assert.equal(d.points, 5); assert.equal(d.targetName, 'Unidade 2');
  await api.deleteDisciplinaryAction(d.id);
  assert.equal(t.store.list('disciplinaryActions').length, 0);
  // QR
  const qr = await api.generateQrPayload('RQ', 'v1', 5, token);
  assert.ok(Object.keys(qr).length > 0);
});

test('perfil da região: só nome de guerra/logo/info da PRÓPRIA região', async () => {
  await loginAs('regiao1');
  await api.updateRegionProfile('R1', { warCry: 'Fogo!', extraInfo: 'info', logoUrl: 'http://x/l.png', name: 'HACK', active: false });
  const r1 = t.store.get('regions', 'R1');
  assert.equal(r1.warCry, 'Fogo!'); assert.equal(r1.logoUrl, 'http://x/l.png'); assert.equal(r1.name, 'Região 1'); assert.equal(r1.active, true);
  await assert.rejects(api.updateRegionProfile('R2', { warCry: 'x' }), e => e.status === 403);
});

test('upload grava no servidor local e devolve a URL local', async () => {
  await loginAs('regiao1');
  const url = await api.uploadFile(new File([new Uint8Array([1, 2, 3])], 'foto.png', { type: 'image/png' }), 'R1', 'RA');
  assert.ok(url.startsWith(t.base + '/files/R1/') || /\/files\/R1\//.test(url), url);
});

test('ranking público sem login', async () => {
  for (const k of Object.keys(ls)) delete ls[k];
  const rows = await api.fetchPublicRanking();
  assert.ok(Array.isArray(rows));
  assert.ok(rows.every(r => typeof r.total === 'number'));
  assert.equal(typeof api.renderAnonRanking(rows), 'string');
});

test('NENHUMA requisição saiu do servidor local (sem Firestore/gstatic/Fly)', () => {
  assert.ok(fetched.length > 50);
  assert.deepEqual(fetched.filter(u => !u.startsWith(t.base)), []);
});

test('firebase-stub: qualquer uso de Firestore falha alto', async () => {
  const stub = await import('../../js/firebase-stub.js');
  assert.throws(() => stub.onSnapshot(), /indispon/);
  assert.throws(() => stub.collection(), /indispon/);
  assert.deepEqual(stub.serverTimestamp(), { __serverTimestamp: true });
});

test('injeção: página servida ganha o import map só com LOCAL_APP_MODE ligado (kill switch)', async () => {
  const mk = async localAppMode => {
    const store = new Store(':memory:');
    const importMapJson = JSON.stringify({ imports: { '/js/api.js': '/js/api-local.js', '/js/firebase.js': '/js/firebase-stub.js' } });
    const cfg = { port: 0, qrSecret: 's', jwtSecret: 'j', qrSecretIsDev: false, version: 't', uploadDir: '/tmp', corsOrigins: [], frontendDir: REPO_ROOT,
      vendorDir: path.resolve(REPO_ROOT, 'local-server', 'vendor'), helpWifiName: '', helpWifiPassword: '', localAppMode, importMapJson };
    const app = createApp({ store, config: cfg, log: { info() {}, warn() {}, error() {} } });
    const srv = await new Promise(r => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
    const pages = {};
    for (const p of ['login', 'admin', 'fiscal', 'conselheiro', 'regiao/dbv', 'regiao/avt']) {
      pages[p] = await new Promise((res, rej) => http.get({ host: '127.0.0.1', port: srv.address().port, path: `/pages/${p}.html` }, r => { let s = ''; r.on('data', d => { s += d; }); r.on('end', () => res(s)); }).on('error', rej));
    }
    srv.closeAllConnections?.(); srv.close(); store.close();
    return pages;
  };
  const on = await mk(true), off = await mk(false);
  for (const [p, html] of Object.entries(on)) {
    assert.match(html, /<script type="importmap">/, p);
    assert.ok(html.indexOf('importmap') < html.indexOf('type="module"'), `${p}: import map antes dos módulos`);
    assert.match(html, /"\/js\/api\.js":"\/js\/api-local\.js"/, p);
  }
  for (const [p, html] of Object.entries(off)) assert.doesNotMatch(html, /importmap/, p);
});

test('a nuvem não muda: os arquivos da nuvem não referenciam api-local/firebase-stub nem import map', () => {
  for (const f of ['js/api.js', 'js/firebase.js', 'js/auth.js', 'js/net.js', 'js/config.js', 'js/scanQueue.js']) {
    assert.doesNotMatch(fs.readFileSync(path.join(REPO_ROOT, f), 'utf8'), /api-local|firebase-stub/, f);
  }
  for (const f of fs.readdirSync(path.join(REPO_ROOT, 'pages'), { recursive: true }).filter(x => x.endsWith('.html'))) {
    assert.doesNotMatch(fs.readFileSync(path.join(REPO_ROOT, 'pages', f), 'utf8'), /api-local|importmap/, f);
  }
});
