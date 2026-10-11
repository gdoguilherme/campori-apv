// Excel do ADMIN com os requisitos NÃO pontuados (0 pt ou não preenchidos): critério, motivos, só admin, total intocado.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import bcrypt from 'bcryptjs';
import { startTestServer, seedScenario } from './helpers.js';
import { REPO_ROOT } from '../src/config.js';
import { computeUnitScores } from '../../shared/scoring.js';
import { buildUnitStatement, buildStatements, workbookData, naoPontuadosRows, statementCsv, statementPrintHtml } from '../../shared/extrato.js';

const ts = s => ({ seconds: s, nanoseconds: 0 });
const T = 1_800_000_000;
const read = f => fs.readFileSync(path.join(REPO_ROOT, f), 'utf8');
const D = () => ({
  regions: [{ id: 'R1', name: 'Região 1', competitionCategory: 'DBV' }, { id: 'R2', name: 'Região 2', competitionCategory: 'AVT' }],
  units: [{ id: 'U1', name: 'Águias', regionId: 'R1' }, { id: 'U2', name: 'Leões', regionId: 'R1' }, { id: 'U3', name: 'Lobos', regionId: 'R2' }],
  requirements: [
    { id: 'C1', name: 'Prova da unidade', filledBy: 'conselheiro', points: 10, order: 1, active: true },
    { id: 'C2', name: 'Prova pendente', filledBy: 'conselheiro', points: 8, order: 2, active: true },
    { id: 'C3', name: 'Prova rejeitada', filledBy: 'conselheiro', points: 6, order: 3, active: true },
    { id: 'C4', name: 'Prova zerada', filledBy: 'conselheiro', points: 5, order: 4, active: true },
    { id: 'C5', name: 'Prova nunca feita', filledBy: 'conselheiro', points: 4, order: 5, active: true },
    { id: 'RG', name: 'Relatório regional', filledBy: 'regional', points: 12, order: 6, active: true },
    { id: 'RD', name: 'Só para DBV', filledBy: 'regional', competitionCategory: 'DBV', points: 3, order: 7, active: true },
    { id: 'FS', name: 'Avaliação do fiscal', filledBy: 'fiscal', points: 9, order: 8, active: true },
    { id: 'UNI', name: 'Inspeção de uniforme', filledBy: 'fiscal', inspection: 'uniforme', points: 10, order: 9, active: true },
    { id: 'OFF', name: 'Inativa', filledBy: 'conselheiro', points: 99, order: 10, active: false },
  ],
  submissions: [
    { id: 'a', requirementId: 'C1', regionId: 'R1', unitId: 'U1', status: 'approved', requirementPoints: 10, source: 'region', submittedAt: ts(T) },
    { id: 'b', requirementId: 'C2', regionId: 'R1', unitId: 'U1', status: 'pending', requirementPoints: 8, source: 'region', submittedAt: ts(T + 1) },
    { id: 'c', requirementId: 'C3', regionId: 'R1', unitId: 'U1', status: 'rejected', requirementPoints: 6, source: 'region', submittedAt: ts(T + 2) },
    { id: 'd', requirementId: 'C4', regionId: 'R1', unitId: 'U1', status: 'approved', requirementPoints: 0, source: 'region', submittedAt: ts(T + 3) },
    { id: 'e', requirementId: 'RG', regionId: 'R1', status: 'approved', requirementPoints: 12, source: 'region', submittedAt: ts(T + 4) },
  ],
  disciplinaryActions: [],
});

test('critério e motivos: não preenchido, aguardando aprovação, rejeitado, aprovado com 0 pts; só o que se aplica à unidade; pontuados e inativos fora', () => {
  const st = buildUnitStatement('U1', D(), { incluirNaoPontuados: true });
  const por = Object.fromEntries(st.naoPontuados.map(n => [n.requirementId, n]));
  assert.equal(por.C2.motivo, 'Aguardando aprovação'); assert.equal(por.C3.motivo, 'Rejeitado'); assert.equal(por.C4.motivo, 'Aprovado com 0 pts'); assert.equal(por.C5.motivo, 'Não preenchido');
  assert.equal(por.FS.motivo, 'Não preenchido'); assert.equal(por.FS.tipo, 'Fiscal (região)'); assert.equal(por.UNI.tipo, 'Uniforme'); assert.equal(por.RD.tipo, 'Regional');
  assert.ok(!por.C1, 'pontuou → fora'); assert.ok(!por.RG, 'a regional aprovada vale para a unidade → fora'); assert.ok(!por.OFF, 'inativa → fora');
  assert.deepEqual(st.naoPontuados.map(n => n.requirementId), ['C2', 'C3', 'C4', 'C5', 'RD', 'FS', 'UNI'], 'ordem do cadastro');
  assert.deepEqual([por.C2.pontosPossiveis, por.RD.pontosPossiveis], [8, 3]);
  // U2 (mesma região, nada próprio): a regional aprovada conta; as da unidade ficam sem pontuação
  assert.ok(buildUnitStatement('U2', D(), { incluirNaoPontuados: true }).naoPontuados.some(n => n.requirementId === 'C1' && n.motivo === 'Não preenchido'));
  // modalidade: "Só para DBV" não se aplica à região AVT
  assert.ok(!buildUnitStatement('U3', D(), { incluirNaoPontuados: true }).naoPontuados.some(n => n.requirementId === 'RD'));
  assert.ok(buildUnitStatement('U3', D(), { incluirNaoPontuados: true }).naoPontuados.some(n => n.requirementId === 'RG' && n.motivo === 'Não preenchido'), 'a regional da R1 não vale para a R2');
});

test('informativo: total, linhas, subtotais e ranking IGUAIS com e sem o bloco; pendentes continuam fora do total', () => {
  const d = D();
  const sem = buildUnitStatement('U1', d), com = buildUnitStatement('U1', d, { incluirNaoPontuados: true });
  const { naoPontuados, ...resto } = com;
  assert.deepEqual(resto, { ...sem, geradoEm: resto.geradoEm }, 'nada além do bloco muda');
  assert.equal(com.total, computeUnitScores(d.submissions, d.units, []).find(u => u.id === 'U1').total);
  assert.ok(!('naoPontuados' in sem)); assert.ok(!('naoPontuados' in buildUnitStatement('U1', d, { viewer: 'region', incluirNaoPontuados: true })), 'região não recebe, mesmo pedindo');
  assert.ok(!('naoPontuados' in buildUnitStatement('U1', d, { viewer: 'counselor', incluirNaoPontuados: true })));
});

test('ALEATÓRIO: para cada unidade, requisitos aplicáveis = pontuados + não pontuados (partição, sem repetir)', () => {
  let seed = 7; const rnd = n => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed % n; };
  for (let n = 0; n < 300; n++) {
    const d = D();
    d.submissions = Array.from({ length: rnd(14) }, (_, i) => { const r = d.requirements[rnd(9)]; const u = d.units[rnd(3)]; return { id: `s${i}`, requirementId: r.id, regionId: u.regionId, unitId: r.filledBy === 'conselheiro' || rnd(2) ? u.id : null, status: ['approved', 'pending', 'rejected'][rnd(3)], requirementPoints: rnd(3) ? 1 + rnd(20) : 0, source: 'region', submittedAt: ts(T + rnd(500)) }; });
    for (const u of d.units) {
      const st = buildUnitStatement(u.id, d, { incluirNaoPontuados: true });
      const ids = st.naoPontuados.map(x => x.requirementId);
      assert.equal(new Set(ids).size, ids.length, 'sem repetir');
      const pontuados = new Set(st.linhas.filter(l => l.requirementId && l.pontos > 0).map(l => l.requirementId));
      for (const id of ids) assert.ok(!pontuados.has(id), `${id} está nos dois lados`);
      assert.ok(!ids.includes('OFF'));
    }
  }
});

test('Excel do admin: aba da unidade ganha a seção "Requisitos sem pontuação", o Resumo ganha a contagem; aba "Sem pontuação" do Histórico; sem o bloco, nada muda', () => {
  const d = D();
  const adm = buildStatements(['U1', 'U2', 'U3'], d, { incluirNaoPontuados: true }), normal = buildStatements(['U1', 'U2', 'U3'], d);
  const wb = workbookData(adm);
  assert.equal(wb.resumo[0].at(-1), 'Requisitos sem pontuação'); assert.equal(wb.resumo[1].at(-1), adm[0].naoPontuados.length);
  const linhas = wb.abas[0].linhas, i = linhas.findIndex(r => r[0] === 'Requisitos sem pontuação (não preenchidos ou com 0 pt)');
  assert.ok(i > 0); assert.deepEqual(linhas[i + 1], ['Requisito', 'Tipo', 'Pontos possíveis', 'Motivo']); assert.deepEqual(linhas[i + 2], ['Prova pendente', 'Unidade', 8, 'Aguardando aprovação']);
  const wbN = workbookData(normal);
  assert.equal(wbN.resumo[0].length, 9, 'Excel de região/conselheiro: sem a coluna'); assert.ok(!JSON.stringify(wbN.abas).includes('sem pontuação'));
  const rows = naoPontuadosRows(adm);
  assert.deepEqual(rows[0], ['Unidade', 'Região', 'Requisito', 'Tipo', 'Pontos possíveis', 'Motivo']);
  assert.equal(rows.length - 1, adm.reduce((a, s) => a + s.naoPontuados.length, 0)); assert.deepEqual(rows[1].slice(0, 3), ['Águias', 'Região 1', 'Prova pendente']);
  // CSV e impressão (todos os perfis) NÃO mudam
  assert.ok(!statementCsv(adm[0]).includes('Prova nunca feita') && !statementPrintHtml(adm[0]).includes('Prova nunca feita'));
  const tudo = buildUnitStatement('U1', { ...d, requirements: d.requirements.filter(r => ['C1'].includes(r.id)) }, { incluirNaoPontuados: true });
  assert.deepEqual(workbookData([tudo]).abas[0].linhas.at(-1), ['Todos os requisitos aplicáveis pontuaram']);
});

// ── servidor: só admin e só quando pedido ───────────────────────────────────────────────────────
let t, tok;
before(async () => {
  t = await startTestServer(); await seedScenario(t.store);
  const hash = await bcrypt.hash('senha123', 4);
  t.store.insert('users', { name: 'reg2', username: 'regiao2', role: 'region', active: true, passwordHash: hash, regionId: 'R2' }, 'reg2');
  tok = { adm: await t.login('admin'), reg1: await t.login('regiao1'), c1: await t.login('cons1') };
});
after(async () => { await t.close(); });
const get = (p, k) => t.call('GET', p, undefined, tok[k]);

test('servidor: o bloco só vai para o ADMIN que pede (?naoPontuados=1); região e conselheiro nunca recebem, mesmo pedindo', async () => {
  assert.ok(Array.isArray((await get('/scores/units/U1/statement?naoPontuados=1', 'adm')).body.naoPontuados));
  assert.ok(!('naoPontuados' in (await get('/scores/units/U1/statement', 'adm')).body), 'sem pedir, não vem');
  assert.ok(!('naoPontuados' in (await get('/scores/units/U1/statement?naoPontuados=1', 'reg1')).body));
  assert.ok(!('naoPontuados' in (await get('/scores/units/U1/statement?naoPontuados=1', 'c1')).body));
  const all = (await get('/scores/statements?naoPontuados=1', 'adm')).body; assert.ok(all.every(s => Array.isArray(s.naoPontuados)));
  assert.ok((await get('/scores/statements?naoPontuados=1', 'reg1')).body.every(s => !('naoPontuados' in s)));
  assert.equal((await get('/scores/statements?naoPontuados=1', 'c1')).status, 403);
  const tot = Object.fromEntries((await get('/scores/units', 'adm')).body.map(s => [s.id, s.total]));
  for (const s of all) assert.equal(s.total, tot[s.unidade.id], 'o total não muda');
});

test('front: o Excel do Histórico e o do Extrato (todas as unidades) do ADMIN incluem o bloco; região e conselheiro não pedem', () => {
  const admin = read('js/admin.js'), reg = read('js/regiao.js'), cons = read('js/conselheiro.js');
  assert.match(admin, /'Sem pontuação'/); assert.match(admin, /naoPontuadosRows\(sts\)/);
  assert.equal((admin.match(/incluirNaoPontuados: true/g) || []).length, 3, 'histórico + extrato da unidade + todas as unidades');
  assert.ok(!/incluirNaoPontuados|naoPontuados/.test(reg + cons), 'região/conselheiro não pedem nem mostram');
  assert.ok(!/naoPontuados/.test(read('js/api.js') + read('js/api-local.js')), 'a API do portal não envia o parâmetro');
  assert.equal(read('shared/extrato.js'), read('server/shared/extrato.js'));
});
