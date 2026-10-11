// Pesquisa de Satisfação — caminho da NUVEM (js/api.js com Firestore simulado): grava só campos anônimos, ids determinísticos,
// editar usa merge (mantém a data), validação do admin e proteção contra apagar pesquisa com respostas.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../src/config.js';
import { RESPONSE_FIELDS } from '../../shared/survey.js';

const FAKE = pathToFileURL(path.resolve(REPO_ROOT, 'local-server/test/fake-firebase-capture.js')).href;
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(s, c, n) { return n(s === './firebase.js' ? ${JSON.stringify(FAKE)} : s, c); }`));

let api, fake;
before(async () => {
  globalThis.location = { hostname: 'campori.gdtmidia.com.br', port: '', origin: 'https://campori.gdtmidia.com.br' };
  globalThis.localStorage = { getItem: () => null };
  globalThis.document = { createElement: () => ({ style: {}, remove() {} }), body: { appendChild() {} } };
  api = await import('../../js/api.js'); fake = await import(FAKE);
});

test('nuvem: resposta anônima com id resp_<pesquisa>_<clientId>; editar usa merge e não recria a data', async () => {
  fake.calls.length = 0;
  await api.submitSurveyResponse({ surveyId: 'S1', clientId: 'aparelho-0001', answers: { n: 5 }, perfil: 'conselheiro', regionId: 'R1', isEdit: false });
  const c = fake.calls.find(x => x.op === 'set' && x.col === 'surveyResponses');
  assert.equal(c.id, 'resp_S1_aparelho-0001'); assert.deepEqual(c.opts, { merge: false });
  assert.ok(Object.keys(c.data).every(k => RESPONSE_FIELDS.includes(k)), Object.keys(c.data).join()); assert.ok(c.data.criadoEm && !c.data.editadoEm);
  assert.deepEqual([c.data.perfil, c.data.regionId], ['conselheiro', 'R1']);
  fake.calls.length = 0;
  await api.submitSurveyResponse({ surveyId: 'S1', clientId: 'aparelho-0001', answers: { n: 2 }, perfil: 'conselheiro', regionId: 'R1', isEdit: true });
  const e = fake.calls.find(x => x.op === 'set'); assert.equal(e.id, 'resp_S1_aparelho-0001'); assert.deepEqual(e.opts, { merge: true });
  assert.ok(e.data.editadoEm && !e.data.criadoEm, 'edição não troca a data de criação');
  fake.calls.length = 0;
  await api.submitSurveyResponse({ surveyId: 'S1', clientId: 'aparelho-0002', answers: {}, perfil: 'fiscal', regionId: null });
  assert.ok(!('regionId' in fake.calls.find(x => x.op === 'set').data), 'fiscal sem região');
});

test('nuvem: admin cria (validado), edita e só apaga pesquisa sem respostas; "abertas" filtram por aberta == true', async () => {
  fake.calls.length = 0;
  await assert.rejects(api.createSurvey({ titulo: '', perguntas: [] }), /título/i);
  const id = await api.createSurvey({ titulo: ' Evento ', aberta: true, perguntas: [{ tipo: 'nota5', texto: 'Nota?', obrigatoria: true }] });
  assert.equal(id, 'novo-id');
  const add = fake.calls.find(x => x.op === 'add' && x.col === 'surveys');
  assert.equal(add.data.titulo, 'Evento'); assert.equal(add.data.aberta, true); assert.ok(add.data.criadoEm); assert.ok(add.data.perguntas[0].id);
  await api.updateSurvey('S9', { titulo: 'Novo', aberta: false, perguntas: [{ id: 'a', tipo: 'texto', texto: 'x' }] });
  const up = fake.calls.find(x => x.op === 'update' && x.col === 'surveys'); assert.equal(up.id, 'S9'); assert.equal(up.data.aberta, false);
  await api.createSampleSurvey(); assert.equal(fake.calls.filter(x => x.op === 'add' && x.col === 'surveys').pop().data.perguntas.length, 8);
  fake.fakeState.docs = [{ id: 'r1', data: () => ({ surveyId: 'S9' }) }];
  await assert.rejects(api.deleteSurvey('S9'), /já tem respostas/);
  fake.fakeState.docs = [];
  await api.deleteSurvey('S9'); assert.ok(fake.calls.some(x => x.op === 'delete' && x.col === 'surveys' && x.id === 'S9'));
  api.subOpenSurveys(() => {}); assert.ok(fake.calls.some(x => x.op === 'where' && x.w[0] === 'aberta' && x.w[2] === true));
});
