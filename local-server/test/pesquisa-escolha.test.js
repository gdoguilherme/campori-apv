// Pesquisa: tela de ESCOLHA (2+ abertas), abertura direta (1), mensagem (0), selos "Respondida/Pendente" (marcador LOCAL),
// selo "N pendentes" no botão dos portais, emojis por título, offline pelo cache e anonimato.
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../src/config.js';
import { surveyEmoji, countPendingSurveys, pendingLabel } from '../../shared/survey.js';

const STUB = pathToFileURL(path.resolve(REPO_ROOT, 'local-server/test/fake-api-pesquisa.js')).href;
const FB = pathToFileURL(path.resolve(REPO_ROOT, 'local-server/test/fake-firebase-capture.js')).href;
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(s, c, n) {
  if (s === './api.js') return n(${JSON.stringify(STUB)}, c);
  if (s === './portalBar.js') return n(${JSON.stringify(STUB)}, c);
  if (s === './firebase.js') return n(${JSON.stringify(FB)}, c);
  return n(s, c); }`));
const read = f => fs.readFileSync(path.join(REPO_ROOT, f), 'utf8');

// ── DOM mínimo ──────────────────────────────────────────────────────────────────────────────
class El {
  constructor() { this.children = []; this.style = { cssText: '' }; this.hidden = false; this._t = ''; this.className = ''; }
  set textContent(v) { this._t = String(v); this.children = []; }
  get textContent() { return this._t + this.children.map(c => c.textContent).join(''); }
  appendChild(c) { this.children.push(c); return c; }
  remove() {} focus() {}
}
const app = { innerHTML: '' };
const store = {};
let hub, sq, auth, pesquisa, btnMod, btn;
const surveys = (...titles) => titles.map((t, i) => ({ id: `S${i + 1}`, titulo: t, perguntas: [{ id: 'n', tipo: 'nota5', texto: `Nota da ${t}`, opcoes: [], obrigatoria: true }, { id: 't', tipo: 'texto', texto: 'Comentário', opcoes: [], obrigatoria: false }] }));
const flush = () => new Promise(r => setTimeout(r, 30));
const user = { id: 'u-c1', role: 'counselor', unitId: 'U1', regionId: 'R1', name: 'Cons', username: 'cons1' };

before(async () => {
  const realSI = globalThis.setInterval; globalThis.setInterval = (f, ms) => { const t = realSI(f, ms); t.unref?.(); return t; };
  globalThis.localStorage = { getItem: k => store[k] ?? null, setItem: (k, v) => { store[k] = String(v); }, removeItem: k => { delete store[k]; } };
  globalThis.location = { hostname: 'x', port: '', origin: 'http://x', replace() {} };
  globalThis.window = globalThis; globalThis.scrollTo = () => {};
  globalThis.addEventListener = () => {}; globalThis.removeEventListener = () => {};
  globalThis.document = { getElementById: id => (id === 'app' ? app : null), createElement: () => new El(), body: new El(), activeElement: null, addEventListener() {}, removeEventListener() {}, hidden: false, visibilityState: 'visible' };
  auth = await import('../../js/auth.js'); sq = await import('../../js/surveyQueue.js'); ({ hub } = await import(STUB));
  auth.saveSession(user, 'tok');
  pesquisa = await import('../../js/pesquisa.js'); btnMod = await import('../../js/surveyButton.js');
});

const reset = async (list, { cache = true } = {}) => {
  for (const k of Object.keys(store)) delete store[k];
  auth.saveSession(user, 'tok'); app.innerHTML = ''; hub.cb = null; hub.calls.length = 0;
  await sq.cacheOpenSurveys(cache ? list : []);
};
const start = async list => { await pesquisa.init(); if (list) { hub.push(list); await flush(); } };
const html = () => app.innerHTML;

test('helpers: emoji por título (app → 📱, evento → 🎪, senão 📝) e contagem de pendentes só com o marcador local', () => {
  assert.equal(surveyEmoji('Pesquisa do APP do Campori'), '📱'); assert.equal(surveyEmoji('Avaliação do Evento'), '🎪'); assert.equal(surveyEmoji('Satisfação geral'), '📝');
  assert.equal(surveyEmoji('App do evento'), '📱', '"app" tem prioridade'); assert.equal(surveyEmoji('EVENTO'), '🎪'); assert.equal(surveyEmoji(''), '📝'); assert.equal(surveyEmoji(undefined), '📝');
  assert.equal(countPendingSurveys([{ id: 'a' }, { id: 'b' }, { id: 'c' }], id => id === 'b'), 2); assert.equal(countPendingSurveys([], () => false), 0);
  assert.deepEqual([pendingLabel(1), pendingLabel(2)], ['1 pendente', '2 pendentes']);
});

test('0 pesquisas abertas: mensagem de sempre', async () => {
  await reset([]); await start([]);
  assert.match(html(), /Nenhuma pesquisa aberta no momento/); assert.ok(!/pesquisas abertas/.test(html()));
});

test('1 pesquisa aberta: abre DIRETO no formulário (como antes), sem tela de escolha', async () => {
  const l = surveys('Avaliação do Evento'); await reset(l); await start(l);
  assert.match(html(), /Nota da Avaliação do Evento/); assert.match(html(), /Enviar resposta/); assert.ok(!/sv-card/.test(html()) && !/pesquisas abertas/.test(html()));
  assert.ok(!/W\.back\(\)/.test(html().split('Nota da')[0]), 'com 1 pesquisa o "Voltar" leva ao portal');
  assert.ok(!/<select/.test(html()), 'a lista suspensa foi removida');
});

test('2+ pesquisas: tela de ESCOLHA com cartões grandes (emoji, título, nº de perguntas) e selo "Pendente"; sem lista suspensa', async () => {
  const l = surveys('Pesquisa do App', 'Avaliação do Evento', 'Outras ideias'); await reset(l); await start(l);
  assert.match(html(), /Há <b>3 pesquisas abertas<\/b>/); assert.equal((html().match(/class="sv-card"/g) || []).length, 3);
  assert.match(html(), /📱<\/span>[\s\S]*?Pesquisa do App/); assert.match(html(), /🎪<\/span>[\s\S]*?Avaliação do Evento/); assert.match(html(), /📝<\/span>[\s\S]*?Outras ideias/);
  assert.equal((html().match(/2 perguntas/g) || []).length, 3); assert.equal((html().match(/>Pendente</g) || []).length, 3);
  assert.ok(!html().includes('Respondida neste aparelho')); assert.ok(!/<select/.test(html()));
  assert.ok(!/Enviar resposta/.test(html()), 'ainda não abriu nenhum formulário');
});

test('tocar no cartão abre aquela pesquisa; "← Voltar" dentro do formulário retorna à escolha', async () => {
  const l = surveys('Pesquisa do App', 'Avaliação do Evento'); await reset(l); await start(l);
  W.open('S2'); assert.match(html(), /Nota da Avaliação do Evento/); assert.ok(!/Nota da Pesquisa do App/.test(html()));
  assert.match(html(), /<button onclick="W\.back\(\)"[^>]*>← Voltar<\/button>/);
  W.back(); assert.match(html(), /Há <b>2 pesquisas abertas<\/b>/); assert.ok(!/Enviar resposta/.test(html()));
  W.open('NAO-EXISTE'); assert.match(html(), /Há <b>2 pesquisas abertas<\/b>/, 'id inválido não abre nada');
});

test('responder marca o selo "✅ Respondida neste aparelho" só daquela pesquisa (marcador local, sem identificar o autor)', async () => {
  const l = surveys('Pesquisa do App', 'Avaliação do Evento'); await reset(l); await start(l);
  W.open('S1'); W.set('n', 5); W.text('t', 'gostei'); await W.submit(); await flush();
  assert.match(html(), /Obrigado pela sua resposta/); assert.match(html(), /Ver outras pesquisas/);
  W.back();
  assert.equal((html().match(/✅ Respondida neste aparelho/g) || []).length, 1); assert.equal((html().match(/>Pendente</g) || []).length, 1);
  const cards = html().split('class="sv-card"').slice(1);
  assert.match(cards[0], /Pesquisa do App[\s\S]*Respondida neste aparelho/); assert.match(cards[1], /Avaliação do Evento[\s\S]*>Pendente</);
  // marcador: só no aparelho (localStorage), por login, com clientId e respostas — nada de identidade do servidor
  const keys = Object.keys(store).filter(k => k.startsWith('campori_survey_done:')); assert.deepEqual(keys, ['campori_survey_done:u-c1:S1']);
  assert.deepEqual(Object.keys(JSON.parse(store[keys[0]])).sort(), ['answers', 'at', 'clientId']);
  // editar uma respondida reabre pré-preenchida e substitui (mesmo clientId)
  const cid = JSON.parse(store[keys[0]]).clientId; W.open('S1');
  assert.match(html(), /Você já respondeu neste aparelho/); W.set('n', 3); await W.submit(); await flush();
  assert.equal(hub.calls.at(-1).clientId, cid);
});

test('anonimato: o que sai do aparelho é só surveyId/clientId/respostas/perfil/região — a escolha e os selos não chamam o servidor', async () => {
  const l = surveys('Pesquisa do App', 'Avaliação do Evento'); await reset(l); await start(l);
  W.open('S2'); W.back(); W.open('S1'); W.back();
  assert.equal(hub.calls.length, 0, 'navegar entre cartões não envia nada');
  W.open('S2'); W.set('n', 4); await W.submit(); await flush();
  assert.equal(hub.calls.length, 1); assert.deepEqual(Object.keys(hub.calls[0]).sort(), ['answers', 'clientId', 'isEdit', 'perfil', 'regionId', 'surveyId']);
  const wire = JSON.stringify(hub.calls[0]);
  for (const v of [user.id, user.name, user.username, 'u-c1', 'cons1']) assert.ok(!wire.includes(v), `a resposta leva "${v}"`);
  for (const f of ['js/pesquisa.js', 'js/surveyButton.js']) assert.ok(!/\bfetch\(|XMLHttpRequest|sendBeacon/.test(read(f)), `${f} não fala com o servidor`);
});

test('OFFLINE: a tela de escolha abre com a lista guardada no aparelho (cacheOpenSurveys) e os selos continuam valendo', async () => {
  const l = surveys('Pesquisa do App', 'Avaliação do Evento'); await reset(l, { cache: true });
  sq.setAnsweredMarker(user.id, 'S2', { clientId: 'x-12345678', answers: { n: 5 }, at: 1 });
  await start(null);                     // sem rede: o stub nunca entrega a lista ao vivo; só existe o cache
  assert.match(html(), /Há <b>2 pesquisas abertas<\/b>/); assert.match(html(), /Pesquisa do App/); assert.equal((html().match(/✅ Respondida neste aparelho/g) || []).length, 1);
  W.open('S1'); assert.match(html(), /Nota da Pesquisa do App/, 'o formulário também abre offline');
});

test('pesquisa fechada enquanto a escolha está aberta: some da lista; ficando só 1, abre direto; ficando 0, mensagem', async () => {
  const l = surveys('Pesquisa do App', 'Avaliação do Evento'); await reset(l); await start(l);
  hub.push([l[1]]); await flush(); assert.match(html(), /Nota da Avaliação do Evento/);
  hub.push([]); await flush(); assert.match(html(), /Nenhuma pesquisa aberta/);
});

// ── botão dos portais ──────────────────────────────────────────────────────────────────────
test('botão dos portais: selo "N pendentes" (só abertas, só neste aparelho); some quando todas foram respondidas; botão some sem pesquisa aberta', async () => {
  const l = surveys('Pesquisa do App', 'Avaliação do Evento', 'Outra'); await reset(l);
  btn = null; const orig = document.body.appendChild.bind(document.body); document.body.appendChild = c => { btn = c; return orig(c); };
  btnMod.mountSurveyButton({ offsetBottom: '3.6rem' }); await flush();
  assert.equal(btn.hidden, false); assert.equal(btn.textContent, '📝 Pesquisa de Satisfação3 pendentes', 'do cache, sem rede');
  hub.push(l); await flush(); assert.equal(btn.textContent, '📝 Pesquisa de Satisfação3 pendentes');
  assert.equal(btn.children.length, 1); assert.equal(btn.children[0].className, 'survey-badge');
  sq.setAnsweredMarker(user.id, 'S1', { clientId: 'a-12345678', answers: {}, at: 1 }); hub.push(l); await flush();
  assert.ok(btn.textContent.endsWith('2 pendentes'));
  sq.setAnsweredMarker(user.id, 'S2', { clientId: 'b-12345678', answers: {}, at: 1 }); hub.push(l); await flush();
  assert.ok(btn.textContent.endsWith('1 pendente') && !btn.textContent.endsWith('2 pendentes'));
  sq.setAnsweredMarker(user.id, 'S3', { clientId: 'c-12345678', answers: {}, at: 1 }); hub.push(l); await flush();
  assert.equal(btn.textContent, '📝 Pesquisa de Satisfação', 'respondeu todas: sem selo'); assert.equal(btn.hidden, false, 'o botão continua (há pesquisa aberta)');
  hub.push([l[0]]); await flush(); assert.equal(btn.hidden, false);
  hub.push([]); await flush(); assert.equal(btn.hidden, true, 'sem pesquisa aberta: some');
  // marcador de OUTRO login não conta
  sq.setAnsweredMarker('outro-usuario', 'S1', { clientId: 'z-12345678', answers: {}, at: 1 });
  for (const k of Object.keys(store)) delete store[k]; auth.saveSession(user, 'tok'); sq.setAnsweredMarker('outro-usuario', 'S1', { clientId: 'z-12345678', answers: {}, at: 1 });
  hub.push(l); await flush(); assert.ok(btn.textContent.endsWith('3 pendentes'));
  document.body.appendChild = orig;
});

test('fiação: portais usam o mesmo botão; nada mudou em ranking/pontuação/servidor; dados e respostas no mesmo formato', () => {
  for (const f of ['js/conselheiro.js', 'js/regiao.js', 'js/fiscal.js']) assert.match(read(f), /mountSurveyButton\(\{/, f);
  assert.ok(!/survey|pesquisa/i.test(read('shared/scoring.js') + read('shared/sync.js') + read('local-server/src/routes/business.js')));
  assert.equal(read('shared/survey.js'), read('server/shared/survey.js'));
  const sw = read('sw.js'); for (const f of ['/js/pesquisa.js', '/js/surveyButton.js', '/shared/survey.js']) assert.ok(sw.includes(`"${f}"`), f);
  assert.match(read('js/surveyQueue.js'), /key: `\$\{PREFIX\}\$\{user\.id\}:\$\{clientId\}`/, 'formato da fila inalterado');
});
