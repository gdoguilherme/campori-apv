// Pesquisa de Satisfação — regras compartilhadas, servidor local (criar/abrir/fechar, responder, idempotência, anonimato,
// permissões, CSV), REGRESSÃO (nada muda na pontuação) e sync local↔nuvem.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { startTestServer, seedScenario } from './helpers.js';
import { makeEnv, plainTs } from './sync-env.js';
import { REPO_ROOT } from '../src/config.js';
import { computeUnitScores } from '../../shared/scoring.js';
import { counselorPortalTotals } from '../../shared/sync.js';
import {
  SAMPLE_SURVEY, validateSurveyDef, normalizeAnswers, buildResponseDoc, summarize, filterResponses, buildSurveyCsv,
  responseDocId, RESPONSE_FIELDS, profileOfRole
} from '../../shared/survey.js';

let t;
before(async () => { t = await startTestServer(); await seedScenario(t.store); });
after(async () => { await t.close(); });
const read = f => fs.readFileSync(path.join(REPO_ROOT, f), 'utf8');
const ts = ms => ({ seconds: Math.floor(ms / 1000), nanoseconds: 0 });
const fields = d => Object.keys(d).filter(k => k !== 'id');   // `id` é o id do documento (não é campo gravado)

// ── regras compartilhadas ─────────────────────────────────────────────────────────────────
test('definição: título, perguntas, tipos e opções são validados; ids faltantes são gerados', () => {
  const ok = validateSurveyDef({ titulo: ' Evento ', aberta: 1, perguntas: [
    { tipo: 'nota5', texto: 'Geral?', obrigatoria: true }, { tipo: 'escolha', texto: 'Comida?', opcoes: ['Boa', ' Boa ', 'Ruim', ''] }, { tipo: 'simnao', texto: 'Voltaria?' }, { tipo: 'texto', texto: 'Obs' }] });
  assert.equal(ok.ok, true); assert.equal(ok.value.titulo, 'Evento'); assert.equal(ok.value.aberta, true);
  assert.deepEqual(ok.value.perguntas[1].opcoes, ['Boa', 'Ruim'], 'opções limpas e sem repetição');
  assert.equal(new Set(ok.value.perguntas.map(q => q.id)).size, 4); assert.ok(ok.value.perguntas.every(q => q.id));
  assert.equal(ok.value.perguntas[0].obrigatoria, true); assert.equal(ok.value.perguntas[2].obrigatoria, false);
  for (const bad of [{ titulo: '', perguntas: [{ tipo: 'texto', texto: 'x' }] }, { titulo: 'a', perguntas: [] }, { titulo: 'a', perguntas: [{ tipo: 'foto', texto: 'x' }] },
    { titulo: 'a', perguntas: [{ tipo: 'texto', texto: '' }] }, { titulo: 'a', perguntas: [{ tipo: 'escolha', texto: 'x', opcoes: ['só uma'] }] }]) assert.equal(validateSurveyDef(bad).ok, false, JSON.stringify(bad));
  assert.equal(validateSurveyDef({ titulo: 'a', perguntas: [{ id: 'q1', tipo: 'texto', texto: 'x' }, { id: 'q1', tipo: 'texto', texto: 'y' }] }).value.perguntas.map(q => q.id).filter(Boolean).length, 2);
});

test('pesquisa de exemplo: nota geral, organização, alimentação, programação, espiritual, pontuação/sistema de provas, o que melhorar, o que manter', () => {
  const v = validateSurveyDef(SAMPLE_SURVEY);
  assert.equal(v.ok, true); assert.equal(v.value.aberta, false, 'nasce fechada');
  assert.deepEqual(v.value.perguntas.map(q => q.tipo), ['nota5', 'nota5', 'nota5', 'nota5', 'nota5', 'nota5', 'texto', 'texto']);
  const txt = v.value.perguntas.map(q => q.texto.toLowerCase()).join(' | ');
  for (const k of ['nota geral', 'organização', 'alimentação', 'programação', 'espiritual', 'pontuação e o sistema de provas', 'melhorar', 'manter']) assert.ok(txt.includes(k), k);
  assert.equal(v.value.perguntas.filter(q => q.obrigatoria).length, 6, 'notas obrigatórias, textos opcionais');
});

const SV = { id: 's1', perguntas: [
  { id: 'a', tipo: 'nota5', texto: 'Nota', opcoes: [], obrigatoria: true }, { id: 'b', tipo: 'escolha', texto: 'Escolha', opcoes: ['X', 'Y'], obrigatoria: false },
  { id: 'c', tipo: 'simnao', texto: 'SN', opcoes: [], obrigatoria: false }, { id: 'd', tipo: 'texto', texto: 'Texto', opcoes: [], obrigatoria: false }] };
test('respostas: nota 1–5, escolha válida, sim/não, texto; obrigatória; perguntas desconhecidas descartadas', () => {
  const ok = normalizeAnswers(SV, { a: '4', b: 'Y', c: true, d: '  oi  ', zzz: 'lixo' });
  assert.deepEqual(ok.value, { a: 4, b: 'Y', c: 'sim', d: 'oi' }); assert.equal(ok.ok, true);
  assert.equal(normalizeAnswers(SV, {}).ok, false); assert.match(normalizeAnswers(SV, {}).errors[0], /Responda/);
  for (const bad of [{ a: 0 }, { a: 6 }, { a: 2.5 }, { a: 'x' }, { a: 3, b: 'Z' }, { a: 3, c: 'talvez' }]) assert.equal(normalizeAnswers(SV, bad).ok, false, JSON.stringify(bad));
  assert.equal(normalizeAnswers(SV, { a: 3, d: 'x'.repeat(5000) }).value.d.length, 1000);
  assert.equal(normalizeAnswers(SV, { a: 5, c: false }).value.c, 'nao');
});

test('resultado: média e distribuição, escolha, sim/não, textos livres; filtros por perfil e região', () => {
  const R = (id, perfil, regionId, answers, ms) => ({ id, surveyId: 's1', perfil, regionId, answers, criadoEm: ts(ms) });
  const rs = [R('1', 'conselheiro', 'R1', { a: 5, b: 'X', c: 'sim', d: 'ótimo' }, 3000), R('2', 'conselheiro', 'R2', { a: 3, b: 'X', c: 'nao' }, 1000),
    R('3', 'regiao', 'R1', { a: 4, b: 'Y', c: 'sim', d: 'mais água' }, 2000), R('4', 'fiscal', null, { a: 4 }, 4000)];
  const s = summarize(SV, rs);
  assert.equal(s.total, 4);
  const [a, b, c, d] = s.questions;
  assert.equal(a.avg, 4); assert.deepEqual(a.dist, { 1: 0, 2: 0, 3: 1, 4: 2, 5: 1 }); assert.equal(a.answered, 4);
  assert.deepEqual(b.counts, { X: 2, Y: 1 }); assert.equal(c.sim, 2); assert.equal(c.nao, 1); assert.equal(c.pctSim, 67);
  assert.deepEqual(d.texts.map(x => x.texto), ['ótimo', 'mais água'], 'mais recentes primeiro'); assert.equal(d.texts[1].perfil, 'regiao');
  assert.equal(summarize(SV, rs, { perfil: 'conselheiro' }).total, 2); assert.equal(summarize(SV, rs, { perfil: 'conselheiro' }).questions[0].avg, 4);
  assert.equal(summarize(SV, rs, { regionId: 'R1' }).total, 2); assert.equal(summarize(SV, rs, { perfil: 'conselheiro', regionId: 'R1' }).total, 1);
  assert.equal(summarize(SV, [], {}).questions[0].avg, null); assert.equal(filterResponses(rs, {}).length, 4);
});

test('CSV: BOM, separador ;, uma coluna por pergunta, Sim/Não, aspas escapadas, proteção de fórmula e NENHUMA coluna de identidade', () => {
  const csv = buildSurveyCsv(SV, [{ perfil: 'conselheiro', regionId: 'R1', clientId: 'segredo-do-aparelho', criadoEm: ts(5000), answers: { a: 5, b: 'X', c: 'nao', d: '=1+1 "ok"' } }], { regionName: () => 'Região 1', fmtDateTime: ms => `T${ms}` });
  assert.ok(csv.startsWith('﻿'));
  const [head, row] = csv.slice(1).split('\r\n');
  assert.equal(head, '"Data";"Perfil";"Região";"Nota";"Escolha";"SN";"Texto"');
  assert.equal(row, '"T5000";"Conselheiro";"Região 1";"5";"X";"Não";"\'=1+1 ""ok"""');
  assert.ok(!csv.includes('segredo-do-aparelho'), 'clientId não sai no CSV');
});

test('documento da resposta só tem campos anônimos (RESPONSE_FIELDS)', () => {
  const doc = buildResponseDoc({ surveyId: 's', answers: { a: 1 }, perfil: 'fiscal', regionId: null, clientId: 'c-12345678', criadoEm: 1, userId: 'x', nome: 'y' });
  assert.deepEqual(Object.keys(doc).sort(), ['answers', 'clientId', 'criadoEm', 'perfil', 'surveyId']);
  assert.ok(Object.keys(buildResponseDoc({ surveyId: 's', answers: {}, perfil: 'regiao', regionId: 'R1', clientId: 'c-12345678', criadoEm: 1 })).every(k => RESPONSE_FIELDS.includes(k)));
  assert.deepEqual(['counselor', 'region', 'judge', 'superadmin', 'approver'].map(profileOfRole), ['conselheiro', 'regiao', 'fiscal', null, null]);
  assert.equal(responseDocId('S', 'C'), 'resp_S_C');
});

// ── servidor local ───────────────────────────────────────────────────────────────────────────
const def = over => ({ titulo: 'Satisfação', aberta: true, perguntas: [{ id: 'n', tipo: 'nota5', texto: 'Nota geral', obrigatoria: true }, { id: 'e', tipo: 'escolha', texto: 'Comida', opcoes: ['Boa', 'Ruim'] }, { id: 's', tipo: 'simnao', texto: 'Volta?' }, { id: 't', tipo: 'texto', texto: 'Comentário' }], ...over });
let S1;

test('admin cria, abre e fecha; só as ABERTAS aparecem para os portais; validação devolve 400', async () => {
  const adm = await t.login('admin'), cons = await t.login('cons1');
  const bad = await t.call('POST', '/surveys', { titulo: '', perguntas: [] }, adm); assert.equal(bad.status, 400); assert.equal(bad.body.code, 'INVALID_SURVEY');
  const closed = (await t.call('POST', '/surveys', def({ aberta: false, titulo: 'Fechada' }), adm)).body;
  S1 = (await t.call('POST', '/surveys', def(), adm)).body;
  assert.ok(S1.id && S1.aberta === true && S1.criadoEm.seconds > 0);
  const open = (await t.call('GET', '/surveys/open', undefined, cons)).body;
  assert.deepEqual(open.map(x => x.id), [S1.id], 'só a aberta'); assert.deepEqual(Object.keys(open[0]).sort(), ['id', 'perguntas', 'titulo'], 'sem resultados nem metadados');
  await t.call('PATCH', `/surveys/${closed.id}`, { aberta: true }, adm);
  assert.equal((await t.call('GET', '/surveys/open', undefined, cons)).body.length, 2);
  const up = await t.call('PATCH', `/surveys/${closed.id}`, { titulo: 'Renomeada', perguntas: [{ id: 'z', tipo: 'texto', texto: 'Só texto' }] }, adm);
  assert.equal(up.status, 200); assert.equal(up.body.titulo, 'Renomeada'); assert.equal(up.body.perguntas.length, 1); assert.equal(up.body.aberta, true, 'PATCH parcial mantém o estado');
  await t.call('PATCH', `/surveys/${closed.id}`, { aberta: false }, adm);
  assert.deepEqual((await t.call('GET', '/surveys/open', undefined, cons)).body.map(x => x.id), [S1.id]);
  assert.equal((await t.call('GET', '/surveys', undefined, adm)).body.length, 2);
  assert.equal((await t.call('PATCH', '/surveys/NAO', { aberta: true }, adm)).status, 404);
  const sample = (await t.call('POST', '/surveys/sample', undefined, adm)).body;
  assert.equal(sample.perguntas.length, 8); assert.equal(sample.aberta, false);
});

const answer = (id, tok, body) => t.call('POST', `/surveys/${id}/responses`, body, tok);
test('resposta online: grava só perfil e região (do token), nada de identidade; pesquisa fechada, obrigatória e valores inválidos são recusados', async () => {
  const body = { clientId: 'aparelho-0001', answers: { n: 5, e: 'Boa', s: 'sim', t: 'Muito bom!' } };
  const r = await answer(S1.id, await t.login('cons1'), body);
  assert.equal(r.status, 200); assert.deepEqual(r.body, { id: `resp_${S1.id}_aparelho-0001`, result: 'created' });
  const doc = t.store.get('surveyResponses', r.body.id);
  assert.deepEqual(fields(doc).sort(), ['answers', 'clientId', 'criadoEm', 'perfil', 'regionId', 'surveyId']);
  assert.equal(doc.perfil, 'conselheiro'); assert.equal(doc.regionId, 'R1'); assert.deepEqual(doc.answers, { n: 5, e: 'Boa', s: 'sim', t: 'Muito bom!' });
  const reg = await answer(S1.id, await t.login('regiao1'), { clientId: 'aparelho-0002', answers: { n: 3 } });
  assert.equal(t.store.get('surveyResponses', reg.body.id).perfil, 'regiao'); assert.equal(t.store.get('surveyResponses', reg.body.id).regionId, 'R1');
  const fis = await answer(S1.id, await t.login('fiscal'), { clientId: 'aparelho-0003', answers: { n: 4 } });
  const fdoc = t.store.get('surveyResponses', fis.body.id); assert.equal(fdoc.perfil, 'fiscal'); assert.ok(!('regionId' in fdoc), 'fiscal não tem região');
  const cons = await t.login('cons2');
  assert.equal((await answer(S1.id, cons, { clientId: 'aparelho-0004', answers: {} })).status, 400, 'obrigatória');
  assert.equal((await answer(S1.id, cons, { clientId: 'aparelho-0004', answers: { n: 9 } })).status, 400);
  assert.equal((await answer(S1.id, cons, { clientId: 'aparelho-0004', answers: { n: 3, e: 'Péssima' } })).status, 400);
  assert.equal((await answer(S1.id, cons, { clientId: '../x', answers: { n: 3 } })).body.code, 'INVALID_CLIENT_ID');
  assert.equal((await answer('NAO', cons, { clientId: 'aparelho-0004', answers: { n: 3 } })).status, 404);
  const adm = await t.login('admin');
  await t.call('PATCH', `/surveys/${S1.id}`, { aberta: false }, adm);
  const closed = await answer(S1.id, cons, { clientId: 'aparelho-0005', answers: { n: 3 } });
  assert.equal(closed.status, 409); assert.equal(closed.body.code, 'SURVEY_CLOSED');
  await t.call('PATCH', `/surveys/${S1.id}`, { aberta: true }, adm);
});

test('idempotência: mesmo clientId não duplica; editar SUBSTITUI e mantém a data original; outra pesquisa = outro documento', async () => {
  const cons = await t.login('cons1'), adm = await t.login('admin');
  const count = () => t.store.list('surveyResponses', { filters: { surveyId: S1.id } }).length;
  const before = count();
  const body = { clientId: 'idem-12345678', answers: { n: 2, t: 'primeira' } };
  const a = await answer(S1.id, cons, body), b = await answer(S1.id, cons, body);
  assert.equal(a.body.result, 'created'); assert.equal(b.body.result, 'unchanged'); assert.equal(count(), before + 1);
  const created = t.store.get('surveyResponses', a.body.id).criadoEm;
  const c = await answer(S1.id, cons, { clientId: 'idem-12345678', answers: { n: 5, t: 'editada' } });
  assert.equal(c.body.result, 'updated'); assert.equal(count(), before + 1, 'editar não cria outra');
  const doc = t.store.get('surveyResponses', a.body.id);
  assert.deepEqual(doc.answers, { n: 5, t: 'editada' }); assert.deepEqual(doc.criadoEm, created); assert.ok(doc.editadoEm.seconds > 0);
  const other = (await t.call('POST', '/surveys', def({ titulo: 'Outra' }), adm)).body;
  const o = await answer(other.id, cons, body);
  assert.equal(o.body.result, 'created'); assert.notEqual(o.body.id, a.body.id);
  assert.equal(t.store.list('surveyResponses').filter(r => r.clientId === 'idem-12345678').length, 2);
});

test('ANONIMATO: nenhuma resposta guarda userId, nome, usuário nem IP — nem em colunas nem no JSON', () => {
  const rows = t.store.list('surveyResponses'); assert.ok(rows.length >= 5);
  const users = t.store.list('users');
  const idValues = new Set(users.flatMap(u => [u.id, u.username, u.name]).filter(Boolean));      // nenhum VALOR pode ser um id/usuário/nome
  const forbiddenKeys = ['userId', 'username', 'name', 'nome', 'submittedBy', 'createdBy', 'authorId', 'ip', 'deviceId'];
  const strings = (v, out = []) => { if (typeof v === 'string') out.push(v); else if (v && typeof v === 'object') Object.values(v).forEach(x => strings(x, out)); return out; };
  for (const r of rows) {
    assert.ok(fields(r).every(k => RESPONSE_FIELDS.includes(k)), `campos: ${fields(r)}`);
    assert.ok(!fields(r).some(k => forbiddenKeys.includes(k)));
    const { id: _docId, perfil, ...stored } = r;
    assert.ok(['conselheiro', 'regiao', 'fiscal'].includes(perfil), 'perfil é só a categoria, nunca a pessoa');
    for (const v of strings(stored)) {
      assert.ok(!idValues.has(v), `a resposta contém o valor identificável "${v}"`);
      for (const n of idValues) if (n.length >= 5) assert.ok(!v.toLowerCase().includes(n.toLowerCase()), `"${v}" contém "${n}"`);
    }
  }
  const raw = t.store.db.prepare('SELECT * FROM surveyResponses').all();
  assert.deepEqual(Object.keys(raw[0]).filter(k => !['data', 'createdAt', 'updatedAt', 'deleted', 'dirty', 'baseData', 'syncError', 'syncAttempts', 'syncTriedAt', 'syncedAt'].includes(k)).sort(), ['clientId', 'id', 'perfil', 'regionId', 'surveyId']);
  for (const r of raw) for (const [k, v] of Object.entries(r)) if (k !== 'perfil' && typeof v === 'string') for (const x of strings(k === 'data' ? JSON.parse(v) : v)) assert.ok(k === 'data' && JSON.parse(v).perfil === x || !idValues.has(x), `linha crua contém "${x}"`);
});

test('permissões: só admin edita perguntas e vê resultados; conselheiro/região/fiscal só abertas e só respondem; admin/aprovador não respondem', async () => {
  const roles = { cons: await t.login('cons1'), reg: await t.login('regiao1'), fis: await t.login('fiscal'), apr: await t.login('aprovador'), adm: await t.login('admin') };
  for (const [who, tok] of Object.entries(roles).filter(([k]) => k !== 'adm')) {
    assert.equal((await t.call('POST', '/surveys', def(), tok)).status, 403, `${who} cria`);
    assert.equal((await t.call('POST', '/surveys/sample', undefined, tok)).status, 403, `${who} exemplo`);
    assert.equal((await t.call('PATCH', `/surveys/${S1.id}`, { aberta: false }, tok)).status, 403, `${who} edita`);
    assert.equal((await t.call('DELETE', `/surveys/${S1.id}`, undefined, tok)).status, 403, `${who} apaga`);
    assert.equal((await t.call('GET', '/surveys', undefined, tok)).status, 403, `${who} lista tudo`);
    assert.equal((await t.call('GET', `/surveys/${S1.id}/responses`, undefined, tok)).status, 403, `${who} vê respostas`);
    assert.equal((await t.call('GET', '/data/surveyResponses', undefined, tok)).status, 403, `${who} lê pela rota genérica`);
  }
  assert.equal((await t.call('GET', '/surveys/open')).status, 401);
  assert.equal((await answer(S1.id, roles.apr, { clientId: 'aprovador-001', answers: { n: 3 } })).status, 403);
  assert.equal((await answer(S1.id, roles.adm, { clientId: 'admin-0000001', answers: { n: 3 } })).status, 403, 'admin vê resultados, não responde');
  assert.equal((await t.call('POST', '/data/surveys', def(), roles.adm)).status, 403, 'a rota genérica não grava pesquisa (nem do admin)');
  assert.equal((await t.call('POST', '/data/surveyResponses', { surveyId: S1.id, answers: { n: 1 }, perfil: 'fiscal' }, roles.adm)).status, 403);
  const results = await t.call('GET', `/surveys/${S1.id}/responses`, undefined, roles.adm);
  assert.equal(results.status, 200); assert.ok(results.body.length >= 4);
  assert.equal((await t.call('GET', '/data/surveyResponses', undefined, roles.adm)).status, 200);
  const del = await t.call('DELETE', `/surveys/${S1.id}`, undefined, roles.adm);
  assert.equal(del.status, 409); assert.equal(del.body.code, 'HAS_RESPONSES');
  const empty = (await t.call('POST', '/surveys', def({ titulo: 'Vazia' }), roles.adm)).body;
  assert.equal((await t.call('DELETE', `/surveys/${empty.id}`, undefined, roles.adm)).status, 200);
});

test('resultados do admin batem com as respostas gravadas (e o CSV sai sem identidade)', async () => {
  const adm = await t.login('admin');
  const sv = (await t.call('GET', '/surveys', undefined, adm)).body.find(x => x.id === S1.id);
  const responses = (await t.call('GET', `/surveys/${S1.id}/responses`, undefined, adm)).body;
  const sum = summarize(sv, responses);
  assert.equal(sum.total, responses.length);
  assert.equal(sum.questions[0].answered, responses.filter(r => r.answers.n).length);
  assert.equal(summarize(sv, responses, { perfil: 'fiscal' }).total, responses.filter(r => r.perfil === 'fiscal').length);
  const csv = buildSurveyCsv(sv, responses, { regionName: id => t.store.get('regions', id)?.name });
  assert.equal(csv.split('\r\n').length, responses.length + 1);
  for (const r of responses) assert.ok(!csv.includes(r.clientId), 'clientId não vai para o CSV');
});

// ── REGRESSÃO: a pesquisa não mexe em NENHUM total ──────────────────────────────────────────
test('REGRESSÃO: criar pesquisas e centenas de respostas não muda ranking, pontos confirmados/possíveis, pontuação por unidade nem disciplina', async () => {
  const adm = await t.login('admin'), ap = await t.login('aprovador'), fis = await t.login('fiscal'), cons = await t.login('cons1');
  const sub = (await t.call('POST', '/submissions', { requirementId: 'RS', notes: '' }, cons)).body;
  await t.call('POST', `/submissions/${sub.id}/review`, { status: 'approved' }, ap);
  await t.call('POST', '/discipline', { targetType: 'unit', targetId: 'U1', reason: 'Teste', clientId: 'disc-reg-0001' }, adm);
  await t.call('POST', '/submissions/fiscal-suggestion', { requirementId: 'RA', regionId: 'R1', points: 4, clientId: 'fs-reg-0001', evaluatedAt: 1 }, fis);
  const snapshot = async () => ({
    ranking: (await t.call('GET', '/ranking')).body,
    scores: (await t.call('GET', '/scores/units', undefined, adm)).body,
    boot: (await t.call('GET', '/sync/bootstrap', undefined, cons)).body,
    submissions: t.store.list('submissions').map(s => [s.id, s.status, s.requirementPoints]).sort(),
    discipline: t.store.list('disciplinaryActions').map(d => [d.id, d.points]).sort(),
    local: computeUnitScores(t.store.list('submissions'), t.store.list('units'), t.store.list('disciplinaryActions')),
  });
  const before = await snapshot();
  assert.ok(before.scores.find(s => s.id === 'U1').total > 0);
  const surveys = [(await t.call('POST', '/surveys/sample', undefined, adm)).body, (await t.call('POST', '/surveys', def(), adm)).body];
  for (const sv of surveys) await t.call('PATCH', `/surveys/${sv.id}`, { aberta: true }, adm);
  const toks = [cons, await t.login('cons2'), await t.login('regiao1'), fis];
  for (let i = 0; i < 40; i++) for (const sv of surveys) await answer(sv.id, toks[i % 4], { clientId: `reg-${sv.id.slice(0, 6)}-${String(i).padStart(4, '0')}`, answers: sv.perguntas[0].id === 'q1' ? { q1: 5, q2: 5, q3: 5, q4: 5, q5: 5, q6: 5 } : { n: 5, e: 'Boa', s: 'sim' } });
  assert.ok(t.store.count('surveyResponses') >= 80);
  const after = await snapshot();
  const strip = x => { const { serverTime, ...rest } = x.boot; return { ...x, boot: rest }; };
  assert.deepEqual(strip(after), strip(before), 'nenhum total mudou');
  const tot = o => counselorPortalTotals(o.boot);
  assert.deepEqual([tot(after).confirmed, tot(after).possible], [tot(before).confirmed, tot(before).possible]);
  assert.ok(!JSON.stringify(after.boot).includes('survey'), 'o celular do conselheiro nem recebe pesquisa no bootstrap de pontos');
  const src = ['shared/scoring.js', 'shared/sync.js', 'shared/uniforme.js', 'local-server/src/routes/business.js'].map(read).join('\n');
  assert.ok(!/survey/i.test(src), 'as regras de pontuação nem conhecem a pesquisa');
  assert.ok(!/survey/i.test(read('local-server/src/routes/qr.js')));
});

// ── fiação no front ─────────────────────────────────────────────────────────────────────────
test('front: aba do admin, botão nos portais (só com pesquisa aberta), formulário, fila e barra 🟢🟡🔴 contam a pesquisa; shell offline', () => {
  const admin = read('js/admin.js');
  assert.match(admin, /\{ id: 'survey', +label: '📝 Pesquisa' \}/); assert.match(admin, /S\.adminTab === 'survey' +&& isAdmin\(\)/);
  assert.match(admin, /isAdmin\(\)\) _unsubSurveys = subSurveys/, 'só admin carrega pesquisas/resultados');
  for (const f of ['js/conselheiro.js', 'js/regiao.js', 'js/fiscal.js']) { assert.match(read(f), /import \{ mountSurveyButton \}/, f); assert.match(read(f), /mountSurveyButton\(\{/, f); }
  const btn = read('js/surveyButton.js');
  assert.match(btn, /📝 Pesquisa de Satisfação/); assert.match(btn, /a\.hidden = !\(list && list\.length\)/, 'some quando não há pesquisa aberta'); assert.match(btn, /getCachedOpenSurveys/, 'aparece offline');
  const page = read('js/pesquisa.js');
  assert.match(page, /guardPage\(\['counselor', 'region', 'judge'\]\)/); assert.match(page, /enqueueSurveyResponse/); assert.match(page, /Obrigado pela sua resposta/);
  assert.match(page, /Anônima/); assert.ok(!/userId|username/.test(read('js/surveyQueue.js').split('\n').filter(l => /submitSurveyResponse\(\{/.test(l)).join('')), 'o envio não leva usuário');
  const bar = read('js/portalBar.js'); assert.match(bar, /pendingSurveyCount/); assert.match(bar, /syncSurveyQueue/);
  const sw = read('sw.js');
  for (const f of ['/pages/pesquisa.html', '/js/pesquisa.js', '/js/surveyQueue.js', '/js/surveyButton.js', '/shared/survey.js']) assert.ok(sw.includes(`"${f}"`), `${f} no shell offline (rode node scripts/build-sw.mjs)`);
  assert.equal(fs.readFileSync(path.join(REPO_ROOT, 'shared/survey.js'), 'utf8'), fs.readFileSync(path.join(REPO_ROOT, 'server/shared/survey.js'), 'utf8'));
  assert.match(read('firestore.rules'), /match \/surveys\/\{surveyId\}/); assert.match(read('firestore.rules'), /match \/surveyResponses\/\{responseId\}/);
});

// ── sync local ↔ nuvem ─────────────────────────────────────────────────────────────────────
test('SYNC: pesquisa e respostas sobem para a nuvem com os mesmos ids; editar atualiza; excluir local NÃO apaga a resposta da nuvem; resposta de outro PC desce', async () => {
  const env = makeEnv();
  const sv = env.store.insert('surveys', { titulo: 'Sync', aberta: true, perguntas: [{ id: 'n', tipo: 'nota5', texto: 'Nota', opcoes: [], obrigatoria: true }], criadoEm: plainTs(1) }, 'sv-sync');
  const resp = (id, extra = {}) => env.store.insert('surveyResponses', { surveyId: sv.id, answers: { n: 4 }, perfil: 'conselheiro', regionId: 'R1', clientId: id, criadoEm: plainTs(2), ...extra }, `resp_${sv.id}_${id}`);
  resp('aparelho-aaaa'); resp('aparelho-bbbb');
  assert.equal(env.store.dirtyCounts().byCollection.surveys, 1); assert.equal(env.store.dirtyCounts().byCollection.surveyResponses, 2);
  const r1 = await env.engine.syncNow();
  assert.equal(r1.ok, true);
  assert.equal(env.store.dirtyCounts().total, 0);
  assert.equal(env.fake.get('surveys', 'sv-sync').titulo, 'Sync');
  const cloudResp = env.fake.get('surveyResponses', 'resp_sv-sync_aparelho-aaaa');
  assert.deepEqual(Object.keys(cloudResp).filter(k => k !== 'id').sort(), ['answers', 'clientId', 'criadoEm', 'perfil', 'regionId', 'surveyId'], 'nenhuma identidade sobe para a nuvem');
  // idempotente: sincronizar de novo não duplica
  await env.engine.syncNow(); assert.equal(env.fake.all('surveyResponses').length, 2);
  // editar (mesmo clientId) → atualiza o MESMO documento na nuvem
  env.store.update('surveyResponses', 'resp_sv-sync_aparelho-aaaa', { answers: { n: 5 }, editadoEm: plainTs(9) });
  await env.engine.syncNow();
  assert.equal(env.fake.get('surveyResponses', 'resp_sv-sync_aparelho-aaaa').answers.n, 5); assert.equal(env.fake.all('surveyResponses').length, 2);
  // fechar a pesquisa localmente também sobe
  env.store.update('surveys', 'sv-sync', { aberta: false }); await env.engine.syncNow();
  assert.equal(env.fake.get('surveys', 'sv-sync').aberta, false);
  // exclusão local de uma resposta (ex.: dbtool) NÃO apaga na nuvem: respostas só acrescentam
  env.store.remove('surveyResponses', 'resp_sv-sync_aparelho-bbbb');
  const r2 = await env.engine.syncNow(); assert.equal(r2.ok, true);
  assert.ok(env.fake.get('surveyResponses', 'resp_sv-sync_aparelho-bbbb'), 'continua na nuvem');
  // resposta que chegou à nuvem por outro caminho (outro PC / celular em modo nuvem) desce para o local
  env.fake.seed('surveyResponses', 'resp_sv-sync_nuvem-cccc', { surveyId: 'sv-sync', answers: { n: 3 }, perfil: 'fiscal', clientId: 'nuvem-cccc', criadoEm: new (await import('./fake-firestore.js')).FakeTimestamp(5000) });
  await env.engine.syncNow(); await env.engine.pullNow();
  assert.deepEqual(env.store.get('surveyResponses', 'resp_sv-sync_nuvem-cccc').answers, { n: 3 });
  assert.equal(env.store.get('surveyResponses', 'resp_sv-sync_nuvem-cccc').perfil, 'fiscal');
});

test('SYNC: pesquisa criada/editada na nuvem chega ao local (admin em modo nuvem) e as pendências aparecem na contagem do /status', async () => {
  const env = makeEnv();
  const { FakeTimestamp } = await import('./fake-firestore.js');
  env.fake.seed('surveys', 'sv-cloud', { titulo: 'Da nuvem', aberta: true, perguntas: [{ id: 'q', tipo: 'texto', texto: 'Algo?', opcoes: [], obrigatoria: false }], criadoEm: new FakeTimestamp(1000) });
  await env.engine.syncNow();
  assert.equal(env.store.get('surveys', 'sv-cloud').titulo, 'Da nuvem'); assert.equal(env.store.dirtyCounts().total, 0, 'o que veio da nuvem não vira pendência');
  assert.deepEqual(env.store.list('surveys', { filters: { aberta: 'true' } }).map(s => s.id), ['sv-cloud']);
  env.store.insert('surveyResponses', { surveyId: 'sv-cloud', answers: {}, perfil: 'regiao', clientId: 'xx-12345678', criadoEm: plainTs(1) }, 'resp_sv-cloud_xx-12345678');
  assert.equal(env.store.dirtyCounts().byCollection.surveyResponses, 1);
  const { buildSummary } = await import('../src/sync/status.js');
  const s = buildSummary({ store: env.store, config: { uploadDir: '/tmp' }, engine: env.engine, startedAt: Date.now() });
  assert.equal(s.sync.pending, 1);
  assert.ok(s.units.every(u => u.pending === 0), 'a pesquisa não aparece como pendência de unidade/requisito');
});
