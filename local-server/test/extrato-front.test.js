// Extrato — telas (admin, região, conselheiro), botões de exportação, e o caminho da NUVEM (api.js com Firestore simulado:
// mesmo resultado do ranking e escopo por perfil).
import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../src/config.js';
import { computeUnitScores } from '../../shared/scoring.js';

const FAKE = pathToFileURL(path.resolve(REPO_ROOT, 'local-server/test/fake-firebase-capture.js')).href;
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(s, c, n) { return n(s === './firebase.js' ? ${JSON.stringify(FAKE)} : s, c); }`));
const read = f => fs.readFileSync(path.join(REPO_ROOT, f), 'utf8');

test('admin: clique na unidade do ranking abre o extrato; botões CSV da unidade, Excel de todas e Imprimir/PDF; filtro por origem', () => {
  const admin = read('js/admin.js'), ex = read('js/extrato.js');
  assert.match(admin, /onclick="W\.openStatement\('\$\{s\.id\}'\)"/, 'linha do ranking clicável');
  assert.match(admin, /openStatement\(unitId\)/); assert.match(admin, /Excel de todas as unidades/);
  assert.match(admin, /buildUnitStatement\(id, dados\(\), \{ viewer: 'admin' \}\)/, 'calcula com a função compartilhada');
  for (const label of ['📥 CSV da unidade', '🖨️ Imprimir/PDF', 'Excel da unidade']) assert.ok(ex.includes(label), label);
  assert.match(ex, /Excel de todas as unidades/); assert.match(ex, /ORIGEM_FILTROS\.map/, 'filtro por origem');
  for (const col of ['Data', 'Origem', 'Prova / motivo', 'Pontos', 'Saldo']) assert.ok(ex.includes(`>${col}<`), `coluna ${col}`);
  assert.match(ex, /XLSX\.utils\.book_append_sheet\(wb, window\.XLSX\.utils\.aoa_to_sheet\(data\.resumo\), 'Resumo'\)/, 'aba Resumo');
  assert.match(ex, /for \(const a of data\.abas\)/, 'uma aba por unidade');
  assert.match(ex, /iframe/, 'impressão limpa em iframe (sem pop-up)');
});

test('região: botão "📄 Extrato" (Excel da região, só as unidades da própria região); conselheiro: só a própria unidade; fiscal: sem acesso', () => {
  const reg = read('js/regiao.js'), cons = read('js/conselheiro.js');
  assert.match(reg, /W\.openExtrato\(\)[\s\S]{0,200}📄 Extrato/); assert.match(reg, /allLabel: 'Excel da região'/); assert.match(reg, /fetchStatements\(user\)/);
  assert.match(reg, /units\.filter\(u => u\.regionId === user\.regionId\)/, 'fallback offline também só da própria região');
  assert.match(cons, /W\.openExtrato\(\)[\s\S]{0,200}📄 Extrato/); assert.match(cons, /const unitId = S\.user\?\.unitId/); assert.match(cons, /fetchUnitStatement\(id, S\.user\)/);
  assert.match(cons, /fromSnapshot/, 'sem rede: monta com o snapshot do celular');
  assert.ok(!/extrato|Extrato/.test(read('js/fiscal.js')) && !/extrato/i.test(read('js/inspecao-uniforme.js')), 'fiscal não tem extrato');
  assert.ok(!/regionId\b.*statements/.test(reg.replace(/fetchStatements\(user\)/g, '')), 'a região não pede outra região');
});

test('Excel e shell offline: biblioteca XLSX nos portais, novos arquivos no service worker, cópia em server/shared idêntica', () => {
  for (const p of ['pages/admin.html', 'pages/conselheiro.html', 'pages/regiao/dbv.html', 'pages/regiao/avt.html']) assert.match(read(p), /xlsx\/0\.18\.5\/xlsx\.full\.min\.js/, p);
  const sw = read('sw.js');
  for (const f of ['/js/extrato.js', '/shared/extrato.js']) assert.ok(sw.includes(`"${f}"`), `${f} no shell (rode node scripts/build-sw.mjs)`);
  assert.equal(read('shared/extrato.js'), read('server/shared/extrato.js'));
  assert.ok(!/extrato/i.test(read('shared/scoring.js')), 'as regras de pontuação não foram tocadas');
});

// ── nuvem (Firestore simulado) ──────────────────────────────────────────────────────────────
const ts = s => ({ seconds: s, nanoseconds: 0 });
const T = 1_800_000_000;
let api, fake;
const docs = arr => arr.map(({ id, ...d }) => ({ id, data: () => d }));
before(async () => {
  globalThis.location = { hostname: 'campori.gdtmidia.com.br', port: '', origin: 'https://campori.gdtmidia.com.br' };
  globalThis.localStorage = { getItem: () => null };
  globalThis.document = { createElement: () => ({ style: {}, remove() {} }), body: { appendChild() {} } };
  api = await import('../../js/api.js'); fake = await import(FAKE);
  fake.fakeState.byCol = {
    regions: docs([{ id: 'R1', name: 'Região 1' }, { id: 'R2', name: 'Região 2' }]),
    units: docs([{ id: 'U1', name: 'Águias', regionId: 'R1' }, { id: 'U2', name: 'Leões', regionId: 'R1' }, { id: 'U3', name: 'Lobos', regionId: 'R2' }]),
    requirements: docs([{ id: 'RA', name: 'Relatório' }, { id: 'RS', name: 'Prova' }]),
    submissions: docs([
      { id: 's1', requirementId: 'RA', requirementName: 'Relatório', regionId: 'R1', status: 'approved', requirementPoints: 10, source: 'region', submittedAt: ts(T) },
      { id: 's2', requirementId: 'RS', requirementName: 'Prova', regionId: 'R1', unitId: 'U1', status: 'approved', requirementPoints: 30, source: 'region', submittedAt: ts(T + 1) },
      { id: 's3', requirementId: 'RS', requirementName: 'Prova', regionId: 'R2', unitId: 'U3', status: 'approved', requirementPoints: 70, source: 'region', submittedAt: ts(T + 2) }]),
    disciplinaryActions: docs([{ id: 'd1', targetType: 'unit', targetId: 'U1', reason: 'x', points: 5, createdAt: ts(T + 5) }]),
  };
});

test('NUVEM: total do extrato = ranking; escopo por perfil (admin tudo, região só a sua, conselheiro só a unidade dele, fiscal nada)', async () => {
  const d = fake.fakeState.byCol, plain = c => d[c].map(x => ({ id: x.id, ...x.data() }));
  const ranking = Object.fromEntries(computeUnitScores(plain('submissions'), plain('units'), plain('disciplinaryActions')).map(s => [s.id, s.total]));
  const admin = { role: 'admin' }, reg1 = { role: 'region', regionId: 'R1' }, c1 = { role: 'counselor', unitId: 'U1', regionId: 'R1' }, judge = { role: 'judge' };
  for (const u of ['U1', 'U2', 'U3']) assert.equal((await api.fetchUnitStatement(u, admin)).total, ranking[u], `admin ${u}`);
  assert.equal((await api.fetchUnitStatement('U1', reg1)).total, ranking.U1); assert.equal((await api.fetchUnitStatement('U1', c1)).total, ranking.U1);
  await assert.rejects(api.fetchUnitStatement('U3', reg1), /permiss/i); await assert.rejects(api.fetchUnitStatement('U2', c1), /permiss/i);
  await assert.rejects(api.fetchUnitStatement('U1', judge), /permiss/i); await assert.rejects(api.fetchUnitStatement('U1', undefined), /permiss/i);
  await assert.rejects(api.fetchUnitStatement('NAO', admin), /permiss/i);
  assert.deepEqual((await api.fetchStatements(reg1)).map(s => s.unidade.id).sort(), ['U1', 'U2']);
  assert.deepEqual((await api.fetchStatements(admin)).map(s => s.unidade.id).sort(), ['U1', 'U2', 'U3']);
  await assert.rejects(api.fetchStatements(c1), /permiss/i); await assert.rejects(api.fetchStatements(judge), /permiss/i);
  assert.ok(!JSON.stringify(await api.fetchStatements(reg1)).includes('Lobos'), 'não vaza outra região');
});
