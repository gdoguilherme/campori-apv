// Pesquisa de Satisfação — fila offline do aparelho contra um servidor local REAL: online/offline, resposta perdida (idempotência),
// editar substituindo, pesquisa encerrada, filas separadas por login e ANONIMATO do que sai do aparelho.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { startTestServer, seedScenario } from './helpers.js';
import { REPO_ROOT } from '../src/config.js';

// no navegador o import map troca ./api.js por api-local.js e ./firebase.js pelo stub — aqui, o mesmo, por um hook de resolução
const LOCAL = pathToFileURL(path.join(REPO_ROOT, 'js/api-local.js')).href, STUB = pathToFileURL(path.join(REPO_ROOT, 'js/firebase-stub.js')).href;
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(s, c, n) { return n(s === './api.js' ? ${JSON.stringify(LOCAL)} : s === './firebase.js' ? ${JSON.stringify(STUB)} : s, c); }`));

let t, auth, sq, net, mode, posts;
before(async () => {
  t = await startTestServer(); await seedScenario(t.store);
  const ls = {};
  globalThis.localStorage = { getItem: k => ls[k] ?? null, setItem: (k, v) => { ls[k] = String(v); }, removeItem: k => { delete ls[k]; } };
  globalThis.__CAMPORI_LOCAL_APP = 1;
  const u = new URL(t.base);
  globalThis.location = { hostname: u.hostname, port: u.port, origin: t.base };
  globalThis.document = { hidden: false, visibilityState: 'visible', body: { appendChild() {} }, createElement: () => ({ style: {}, remove() {} }), addEventListener() {}, removeEventListener() {} };
  mode = 'ok'; posts = [];
  const real = globalThis.fetch;
  globalThis.fetch = (url, opts = {}) => {
    const isPost = /\/surveys\/[^/]+\/responses$/.test(String(url)) && opts.method === 'POST';
    if (mode === 'down') return Promise.reject(new TypeError('fetch failed'));
    if (isPost) posts.push({ url: String(url), body: JSON.parse(opts.body), headers: opts.headers });
    if (isPost && mode === 'lost') return real(url, opts).then(() => { throw new TypeError('connection reset'); });
    return real(url, opts);
  };
  auth = await import('../../js/auth.js'); net = await import('../../js/net.js'); sq = await import('../../js/surveyQueue.js');
});
after(async () => { await t.close(); });

const loginAs = async u => { const { user, token } = (await t.call('POST', '/users/login', { username: u, password: 'senha123' })).body; auth.saveSession(user, token); return user; };
const survey = (over = {}) => t.store.insert('surveys', { titulo: 'Fila', aberta: true, perguntas: [{ id: 'n', tipo: 'nota5', texto: 'Nota', opcoes: [], obrigatoria: true }, { id: 't', tipo: 'texto', texto: 'Obs', opcoes: [], obrigatoria: false }], criadoEm: { seconds: 1, nanoseconds: 0 }, ...over });
const serverDocs = sid => t.store.list('surveyResponses', { filters: { surveyId: sid } });

test('online: entra na fila, sobe, marca "já respondeu" neste aparelho e a fila fica vazia', async () => {
  mode = 'ok'; net.invalidateServer(); const user = await loginAs('cons1'); const sv = survey();
  const clientId = sq.newClientId();
  assert.equal(sq.getAnsweredMarker(user.id, sv.id), null);
  await sq.enqueueSurveyResponse({ user, surveyId: sv.id, answers: { n: 5, t: 'ótimo' }, clientId });
  assert.equal(await sq.pendingSurveyCount(user.id), 1); assert.equal(sq.getAnsweredMarker(user.id, sv.id).clientId, clientId);
  const sum = await sq.syncSurveyQueue({ manual: true });
  assert.equal(sum.accepted.length, 1); assert.equal(await sq.pendingSurveyCount(user.id), 0);
  const docs = serverDocs(sv.id); assert.equal(docs.length, 1);
  assert.deepEqual([docs[0].perfil, docs[0].regionId, docs[0].answers.n], ['conselheiro', 'R1', 5]);
  assert.equal(sq.getAnsweredMarker(user.id, sv.id).answers.t, 'ótimo', 'o marcador guarda as respostas só no aparelho (para editar)');
});

test('OFFLINE: guarda no aparelho (🟡 conta 1), não perde nada, e ao voltar a conexão envia UMA vez', async () => {
  const user = await loginAs('cons2'); const sv = survey();
  mode = 'down'; net.invalidateServer();
  await sq.enqueueSurveyResponse({ user, surveyId: sv.id, answers: { n: 3 }, clientId: 'offline-0001' });
  const off = await sq.syncSurveyQueue({ manual: true });
  assert.equal(off.offline, true); assert.equal(await sq.pendingSurveyCount(user.id), 1); assert.equal(serverDocs(sv.id).length, 0);
  assert.ok(sq.getSurveySyncState().nextRetryAt > Date.now(), 'backoff agendado');
  mode = 'ok'; net.invalidateServer();
  const on = await sq.syncSurveyQueue({ manual: true });
  assert.equal(on.accepted.length, 1); assert.equal(await sq.pendingSurveyCount(user.id), 0); assert.equal(serverDocs(sv.id).length, 1);
  await sq.syncSurveyQueue({ manual: true }); assert.equal(serverDocs(sv.id).length, 1, 'sem pendência não reenvia');
});

test('resposta perdida (servidor gravou, celular não soube): o reenvio é idempotente — continua 1 resposta', async () => {
  const user = await loginAs('cons1'); const sv = survey();
  mode = 'lost';
  await sq.enqueueSurveyResponse({ user, surveyId: sv.id, answers: { n: 4 }, clientId: 'lost-00000001' });
  const a = await sq.syncSurveyQueue({ manual: true });
  assert.equal(a.offline, true); assert.equal(serverDocs(sv.id).length, 1, 'o servidor gravou'); assert.equal(await sq.pendingSurveyCount(user.id), 1);
  mode = 'ok'; net.invalidateServer();
  const b = await sq.syncSurveyQueue({ manual: true });
  assert.equal(b.accepted.length, 1); assert.equal(serverDocs(sv.id).length, 1, 'não duplicou');
});

test('editar substitui: mesmo clientId, mesma resposta no servidor (atualizada), marcador atualizado; editar antes de enviar continua sendo a mesma', async () => {
  const user = await loginAs('cons1'); const sv = survey();
  mode = 'ok'; net.invalidateServer();
  await sq.enqueueSurveyResponse({ user, surveyId: sv.id, answers: { n: 2 }, clientId: 'edit-0000001' }); await sq.syncSurveyQueue({ manual: true });
  await sq.enqueueSurveyResponse({ user, surveyId: sv.id, answers: { n: 5, t: 'mudei de ideia' }, clientId: 'edit-0000001', isEdit: true }); await sq.syncSurveyQueue({ manual: true });
  const docs = serverDocs(sv.id); assert.equal(docs.length, 1); assert.deepEqual(docs[0].answers, { n: 5, t: 'mudei de ideia' }); assert.ok(docs[0].editadoEm);
  assert.deepEqual(sq.getAnsweredMarker(user.id, sv.id).answers, { n: 5, t: 'mudei de ideia' });
  // editar ENQUANTO ainda está na fila (offline): vira uma só resposta pendente, ainda "criação"
  mode = 'down'; net.invalidateServer();
  const sv2 = survey();
  await sq.enqueueSurveyResponse({ user, surveyId: sv2.id, answers: { n: 1 }, clientId: 'edit-0000002' });
  const second = await sq.enqueueSurveyResponse({ user, surveyId: sv2.id, answers: { n: 4 }, clientId: 'edit-0000002', isEdit: true });
  assert.equal(second.isEdit, false); assert.equal(await sq.pendingSurveyCount(user.id), 1, 'continua 1 item');
  mode = 'ok'; net.invalidateServer(); await sq.syncSurveyQueue({ manual: true });
  assert.deepEqual(serverDocs(sv2.id).map(d => d.answers.n), [4]);
});

test('pesquisa encerrada antes do envio: item vira "encerrada" (sem insistir); resposta inválida é "recusada"', async () => {
  const user = await loginAs('regiao1'); mode = 'ok'; net.invalidateServer();
  const sv = survey({ aberta: false });
  await sq.enqueueSurveyResponse({ user, surveyId: sv.id, answers: { n: 3 }, clientId: 'closed-000001' });
  const n0 = posts.length;
  const sum = await sq.syncSurveyQueue({ manual: true });
  assert.equal(sum.closed.length, 1); assert.equal((await sq.listSurveyQueue(user.id)).find(q => q.clientId === 'closed-000001').status, sq.SQ_STATUS.ENCERRADA);
  await sq.syncSurveyQueue({ manual: true }); assert.equal(posts.length, n0 + 1, 'não reenvia o encerrado');
  const open = survey();
  await sq.enqueueSurveyResponse({ user, surveyId: open.id, answers: { n: 99 }, clientId: 'bad-00000001' });
  const bad = await sq.syncSurveyQueue({ manual: true }); assert.equal(bad.rejected.length, 1);
});

test('filas e marcadores são separados por login no mesmo aparelho; o servidor nunca recebe quem respondeu', async () => {
  const a = await loginAs('cons1'); const sv = survey(); mode = 'ok'; net.invalidateServer();
  await sq.enqueueSurveyResponse({ user: a, surveyId: sv.id, answers: { n: 5 }, clientId: 'userA-0000001' });
  const b = await loginAs('fiscal');
  assert.equal(await sq.pendingSurveyCount(b.id), 0, 'a fila de outro login não aparece'); assert.equal(sq.getAnsweredMarker(b.id, sv.id), null);
  await loginAs('cons1'); posts.length = 0;
  await sq.syncSurveyQueue({ manual: true });
  assert.equal(posts.length, 1);
  assert.deepEqual(Object.keys(posts[0].body).sort(), ['answers', 'clientId'], 'só clientId e respostas no corpo');
  const wire = JSON.stringify(posts[0].body);
  for (const id of [a.id, a.username, a.name, 'cons1']) assert.ok(!wire.includes(id), `o corpo contém "${id}"`);
  assert.equal(serverDocs(sv.id)[0].perfil, 'conselheiro');
});

test('pesquisa aberta fica em cache no aparelho (o botão e o formulário funcionam sem rede)', async () => {
  await sq.cacheOpenSurveys([{ id: 's1', titulo: 'X', perguntas: [] }]);
  assert.deepEqual((await sq.getCachedOpenSurveys()).map(s => s.id), ['s1']);
  await sq.cacheOpenSurveys([]); assert.deepEqual(await sq.getCachedOpenSurveys(), []);
});
