// Extrato de pontos por unidade: soma das linhas = total do ranking (cenários fixos e ALEATÓRIOS), uniforme sem duplicar,
// disciplina local×nuvem uma vez, total igual em cada perfil (ranking × portal × extrato) e permissões no SERVIDOR.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { startTestServer, seedScenario } from './helpers.js';
import { computeUnitScores } from '../../shared/scoring.js';
import { counselorPortalTotals } from '../../shared/sync.js';
import { buildUnitStatement, buildStatements, statementCsv, sheetName, workbookData, filterLines, statementPrintHtml, CATEGORIAS } from '../../shared/extrato.js';

const ts = sec => ({ seconds: sec, nanoseconds: 0 });
const T = 1_800_000_000;
let seed = 12345;
const rnd = n => { seed = (Math.imul(seed, 1103515245) + 12345) & 0x7fffffff; return seed % n; };
const pick = a => a[rnd(a.length)];

// ── igualdade com o ranking ──────────────────────────────────────────────────────────────────
function scenario() {
  const regions = Array.from({ length: 1 + rnd(3) }, (_, i) => ({ id: `R${i}`, name: `Região ${i}` }));
  const units = Array.from({ length: 2 + rnd(6) }, (_, i) => ({ id: `U${i}`, name: `Unidade ${i}`, regionId: pick(regions).id }));
  const requirements = Array.from({ length: 6 }, (_, i) => ({ id: `Q${i}`, name: `Prova ${i}`, points: 5 + rnd(30), inspection: i === 5 ? 'uniforme' : undefined }));
  const submissions = [];
  for (let i = 0; i < 6 + rnd(40); i++) {
    const req = pick(requirements), level = rnd(3), unit = pick(units);
    const isQr = level === 1 && req.id !== 'Q5';
    submissions.push({
      id: `s${i}`, requirementId: req.id, requirementName: req.name, regionId: unit.regionId, unitId: level === 0 ? null : unit.id,
      status: pick(['approved', 'approved', 'approved', 'pending', 'rejected']), requirementPoints: rnd(40),
      source: isQr ? 'qr' : pick(['region', 'judge']), qrVariantLabel: isQr ? 'Básica' : undefined,
      uniformInspection: req.id === 'Q5' && level > 0 ? { erros: { mangaDireita: rnd(4) } } : undefined,
      submittedAt: ts(T + rnd(100000)), reviewedAt: rnd(2) ? ts(T + 100000 + rnd(5000)) : undefined,
    });
  }
  const disciplinaryActions = Array.from({ length: rnd(8) }, (_, i) => {
    const regionLevel = rnd(3) === 0, target = regionLevel ? pick(regions) : pick(units);
    return { id: `d${i}`, targetType: regionLevel ? 'region' : 'unit', targetId: target.id, reason: `Motivo ${i % 2}`, points: 5, origin: pick(['local', 'cloud', undefined]), createdAt: ts(T + rnd(100000)) };
  });
  return { regions, units, requirements, submissions, disciplinaryActions };
}

test('ALEATÓRIO (600 cenários): soma das linhas = total do ranking = computeUnitScores, em todas as unidades; subtotais fecham', () => {
  let negativos = 0, comDisciplina = 0;
  for (let n = 0; n < 600; n++) {
    const d = scenario();
    const ranking = computeUnitScores(d.submissions, d.units, d.disciplinaryActions);
    for (const u of d.units) {
      const st = buildUnitStatement(u.id, d);
      const expected = ranking.find(r => r.id === u.id).total;
      const soma = st.linhas.reduce((a, l) => a + l.pontos, 0);
      assert.equal(soma, expected, `cenário ${n} unidade ${u.id}: soma das linhas`);
      assert.equal(st.total, expected); assert.equal(st.confere, true);
      assert.equal(Object.values(st.subtotais).reduce((a, v) => a + v, 0), expected, 'subtotais fecham no total');
      assert.equal(st.linhas.at(-1)?.saldo ?? 0, expected, 'último saldo = total');
      assert.deepEqual(st.linhas.map(l => l.data), [...st.linhas.map(l => l.data)].sort((a, b) => a - b).slice(0, st.linhas.length).map((_, i) => st.linhas[i].data), 'cronológico');
      for (let i = 1; i < st.linhas.length; i++) if (st.linhas[i].categoria !== 'piso') assert.ok(st.linhas[i].data >= st.linhas[i - 1].data, 'datas em ordem');
      if (st.subtotais.piso) negativos++;
      if (st.subtotais.disciplina) comDisciplina++;
    }
    const all = buildStatements(d.units.map(u => u.id), d);
    assert.deepEqual(all.map(s => [s.unidade.id, s.total]), d.units.map(u => [u.id, ranking.find(r => r.id === u.id).total]));
  }
  assert.ok(negativos > 5 && comDisciplina > 200, `cenários cobriram piso (${negativos}) e disciplina (${comDisciplina})`);
});

const base = () => ({
  regions: [{ id: 'R1', name: 'Região 1' }, { id: 'R2', name: 'Região 2' }],
  units: [{ id: 'U1', name: 'Águias', regionId: 'R1' }, { id: 'U2', name: 'Leões', regionId: 'R1' }, { id: 'U3', name: 'Lobos', regionId: 'R2' }],
  requirements: [{ id: 'RA', name: 'Relatório' }, { id: 'RP', name: 'Prova de Nós' }, { id: 'UNI', name: 'Inspeção de uniforme', inspection: 'uniforme' }],
  submissions: [], disciplinaryActions: [],
});

test('origens e descrições: prova da unidade, regional (com a região), QR (variante), uniforme (erros), disciplina; pendentes só em "possíveis"', () => {
  const d = base();
  d.submissions = [
    { id: 'a', requirementId: 'RZ', requirementName: 'Prova do Fiscal', regionId: 'R1', unitId: 'U1', status: 'approved', requirementPoints: 20, source: 'region', submittedAt: ts(T + 10) },
    { id: 'b', requirementId: 'RA', requirementName: 'Relatório', regionId: 'R1', status: 'approved', requirementPoints: 10, source: 'region', submittedAt: ts(T + 5) },
    { id: 'c', requirementId: 'RP', requirementName: 'Prova de Nós', regionId: 'R1', unitId: 'U1', status: 'approved', requirementPoints: 50, source: 'qr', qrVariantLabel: 'Avançada', submittedAt: ts(T + 30) },
    { id: 'u', requirementId: 'UNI', regionId: 'R1', unitId: 'U1', status: 'approved', requirementPoints: 7, source: 'judge', uniformInspection: { erros: { mangaDireita: 2, bolsoDireito: 1, opcionais: 9 } }, submittedAt: ts(T + 40) },
    { id: 'p', requirementId: 'RP2', requirementName: 'Aguardando', regionId: 'R1', unitId: 'U1', status: 'pending', requirementPoints: 15, source: 'region', submittedAt: ts(T + 50) },
    { id: 'o', requirementId: 'RA', requirementName: 'Relatório', regionId: 'R2', status: 'approved', requirementPoints: 99, source: 'region', submittedAt: ts(T + 6) },
  ];
  d.disciplinaryActions = [{ id: 'd1', targetType: 'unit', targetId: 'U1', reason: 'Barulho', points: 5, createdAt: ts(T + 60) }, { id: 'd2', targetType: 'region', targetId: 'R1', reason: 'Atraso geral', points: 5, createdAt: ts(T + 70) }, { id: 'd3', targetType: 'unit', targetId: 'U2', reason: 'Outra unidade', points: 5, createdAt: ts(T + 61) }];
  const st = buildUnitStatement('U1', d);
  assert.equal(st.total, 20 + 10 + 50 + 7 - 5 - 5);
  assert.deepEqual(st.subtotais, { provas: 20, regionais: 10, qr: 50, uniforme: 7, disciplina: -10, piso: 0 });
  assert.deepEqual(st.linhas.map(l => l.origem), ['regional', 'unidade', 'qr', 'uniforme', 'disciplina-unidade', 'disciplina-regiao']);
  assert.equal(st.linhas[0].origemLabel, 'Regional · Região 1'); assert.equal(st.linhas[0].descricao, 'Relatório');
  assert.equal(st.linhas[1].descricao, 'Prova do Fiscal'); assert.equal(st.linhas[2].descricao, 'Prova de Nós — Avançada'); assert.equal(st.linhas[3].descricao, 'Inspeção de uniforme (3 erros)', 'opcionais não contam como erro');
  assert.deepEqual(st.linhas.map(l => l.saldo), [10, 30, 80, 87, 82, 77]);
  assert.equal(st.possiveis, 15); assert.deepEqual(st.pendentes.map(p => p.descricao), ['Aguardando']);
  assert.ok(!JSON.stringify(st).includes('Outra unidade') && !JSON.stringify(st).includes('99'), 'nada de outra unidade/região');
  assert.deepEqual(buildUnitStatement('U3', d).linhas.map(l => l.pontos), [99], 'a regional de R2 só vale para R2');
  assert.equal(buildUnitStatement('NAO', d), null);
});

test('REINSPEÇÃO de uniforme substitui sem duplicar (mesma submission atualizada OU duas aprovadas: vale a mais recente)', () => {
  const d = base();
  const insp = (id, pts, at) => ({ id, requirementId: 'UNI', regionId: 'R1', unitId: 'U1', status: 'approved', requirementPoints: pts, source: 'judge', uniformInspection: { erros: { mangaDireita: 10 - pts } }, submittedAt: ts(at) });
  d.submissions = [insp('v1', 6, T + 10), insp('v2', 9, T + 20)];
  const st = buildUnitStatement('U1', d);
  assert.equal(st.linhas.length, 1); assert.equal(st.total, 9); assert.equal(st.subtotais.uniforme, 9); assert.equal(st.linhas[0].descricao, 'Inspeção de uniforme (1 erro)');
  assert.equal(st.total, computeUnitScores(d.submissions, d.units, []).find(u => u.id === 'U1').total);
  d.submissions = [insp('v1', 9, T + 20)];   // a mesma submission reavaliada (como o servidor faz)
  assert.equal(buildUnitStatement('U1', d).total, 9);
});

test('DISCIPLINA local + nuvem (mesma infração, <10 min) conta UMA vez e o duplicado aparece como "ignorado"; mesma origem conta as duas', () => {
  const d = base();
  d.submissions = [{ id: 'a', requirementId: 'RP', regionId: 'R1', unitId: 'U1', status: 'approved', requirementPoints: 40, source: 'region', submittedAt: ts(T) }];
  const disc = (id, origin, at, over = {}) => ({ id, targetType: 'unit', targetId: 'U1', reason: 'Barulho', points: 5, origin, createdAt: ts(at), ...over });
  d.disciplinaryActions = [disc('l', 'local', T + 100), disc('c', 'cloud', T + 160)];
  let st = buildUnitStatement('U1', d);
  assert.equal(st.total, 35); assert.equal(st.linhas.filter(l => l.categoria === 'disciplina').length, 1);
  assert.equal(st.ignorados.length, 1); assert.equal(st.ignorados[0].duplicadaDe, 'l');
  assert.equal(st.total, computeUnitScores(d.submissions, d.units, d.disciplinaryActions).find(u => u.id === 'U1').total);
  d.disciplinaryActions = [disc('l', 'local', T + 100), disc('m', 'local', T + 160)];
  assert.equal(buildUnitStatement('U1', d).total, 30, 'mesma origem: o admin confirmou, contam as duas');
});

test('piso: pontuação nunca negativa — a soma das linhas fecha com uma linha "Ajuste"', () => {
  const d = base();
  d.submissions = [{ id: 'a', requirementId: 'RP', regionId: 'R1', unitId: 'U1', status: 'approved', requirementPoints: 3, source: 'region', submittedAt: ts(T) }];
  d.disciplinaryActions = [{ id: 'x', targetType: 'unit', targetId: 'U1', reason: 'a', points: 5, createdAt: ts(T + 1) }, { id: 'y', targetType: 'region', targetId: 'R1', reason: 'b', points: 5, createdAt: ts(T + 2) }];
  const st = buildUnitStatement('U1', d);
  assert.equal(st.total, 0); assert.equal(st.soma, -7); assert.equal(st.linhas.reduce((a, l) => a + l.pontos, 0), 0);
  assert.deepEqual([st.linhas.at(-1).categoria, st.linhas.at(-1).pontos, st.linhas.at(-1).saldo], ['piso', 7, 0]); assert.equal(st.subtotais.piso, 7);
});

test('privacidade do motivo: o conselheiro vê o motivo da penalidade da própria unidade, não o da REGIÃO', () => {
  const d = base();
  d.disciplinaryActions = [{ id: 'x', targetType: 'unit', targetId: 'U1', reason: 'Atraso da unidade', points: 5, createdAt: ts(T) }, { id: 'y', targetType: 'region', targetId: 'R1', reason: 'Segredo da região', points: 5, createdAt: ts(T + 1) }];
  const c = buildUnitStatement('U1', d, { viewer: 'counselor' }), a = buildUnitStatement('U1', d, { viewer: 'admin' });
  assert.ok(JSON.stringify(c).includes('Atraso da unidade')); assert.ok(!JSON.stringify(c).includes('Segredo da região'));
  assert.ok(JSON.stringify(a).includes('Segredo da região')); assert.equal(c.total, a.total);
});

test('exportações: CSV (BOM, ;, subtotais, proteção de fórmula), Excel (Resumo + uma aba por unidade, nomes válidos e únicos), impressão (HTML limpo)', () => {
  const d = base();
  d.units.push({ id: 'U4', name: 'Águias', regionId: 'R2' }, { id: 'U5', name: '=Perigo/Nome:longo*com?caracteres[inválidos] e mais de trinta e um caracteres', regionId: 'R2' });
  d.submissions = [{ id: 'a', requirementId: 'RP', requirementName: '=HYPERLINK("x")', regionId: 'R1', unitId: 'U1', status: 'approved', requirementPoints: 20, source: 'region', submittedAt: ts(T) }];
  d.disciplinaryActions = [{ id: 'x', targetType: 'unit', targetId: 'U1', reason: 'Barulho "forte"', points: 5, createdAt: ts(T + 1) }];
  const st = buildUnitStatement('U1', d);
  const csv = statementCsv(st, { fmtDateTime: m => `T${m}` });
  assert.ok(csv.startsWith('﻿"Extrato de pontos"')); assert.match(csv, /"Unidade";"Águias"/); assert.match(csv, /"Total";"15"/);
  assert.match(csv, /"'=HYPERLINK\(""x""\)";"20";"20"/); assert.match(csv, /"-5";"15"/, 'negativo continua número'); assert.match(csv, /"Disciplina";"-5"/);
  assert.equal(statementCsv(st, { categoria: 'disciplina' }).split('\r\n').filter(l => /Penalidade/.test(l)).length, 1);
  const wb = workbookData(buildStatements(d.units.map(u => u.id), d));
  assert.deepEqual(wb.resumo[0].slice(0, 3), ['Unidade', 'Região', 'Total']); assert.equal(wb.resumo.length, 6); assert.equal(wb.abas.length, 5);
  const names = wb.abas.map(a => a.nome);
  assert.equal(new Set(names.map(n => n.toLowerCase())).size, 5, 'nomes de aba únicos'); assert.ok(names.every(n => n.length <= 31 && !/[\\/?*[\]:]/.test(n)));
  assert.deepEqual(names.filter(n => n.startsWith('Águias')), ['Águias', 'Águias (2)']); assert.notEqual(sheetName('Resumo', new Set()), 'Resumo');
  assert.deepEqual(wb.resumo[1].slice(0, 3), ['Águias', 'Região 1', 15]);
  const html = statementPrintHtml(st, { fmtDateTime: m => `T${m}` });
  assert.match(html, /<h1>Extrato de pontos — Águias<\/h1>/); assert.match(html, /Região: <b>Região 1<\/b>/); assert.match(html, /Gerado em T\d+/); assert.ok(html.includes('&quot;forte&quot;'), 'HTML escapado');
  assert.deepEqual(filterLines(st, 'disciplina').map(l => l.pontos), [-5]); assert.equal(filterLines(st, '').length, 2); assert.ok(CATEGORIAS.includes('uniforme'));
});

// ── servidor local: permissões, privacidade e igualdade por perfil ──────────────────────────────────
let t, tok;
before(async () => {
  t = await startTestServer(); await seedScenario(t.store);
  const hash = await bcrypt.hash('senha123', 4);
  // R2 ganha usuário de região, unidade com conselheiro e dados próprios (para provar que nada vaza entre unidades/regiões)
  t.store.insert('users', { name: 'reg2', username: 'regiao2', role: 'region', active: true, passwordHash: hash, regionId: 'R2' }, 'reg2');
  t.store.insert('users', { name: 'cons3', username: 'cons3', role: 'counselor', active: true, passwordHash: hash, regionId: 'R2', unitId: 'U3' }, 'c3');
  t.store.insert('participants', { name: 'Clube Amigo da R2 na U1', regionId: 'R2', unitId: 'U1', competitionCategory: 'DBV' }, 'amigo');   // "clube amigo": outra região dentro da U1
  t.store.update('units', 'U1', { name: 'Águias Secretas' }); t.store.update('units', 'U3', { name: 'Lobos Confidenciais' });
  const sub = (id, o) => t.store.insert('submissions', { requirementName: 'Prova', status: 'approved', source: 'region', submittedAt: { seconds: T, nanoseconds: 0 }, reviewedAt: { seconds: T + 5, nanoseconds: 0 }, ...o }, id);
  sub('s-r1', { regionId: 'R1', requirementId: 'RA', requirementName: 'Relatório da R1', requirementPoints: 10 });                      // regional R1 → U1 e U2
  sub('s-u1', { regionId: 'R1', unitId: 'U1', requirementId: 'RS', requirementName: 'Prova U1', requirementPoints: 30 });
  sub('s-u2', { regionId: 'R1', unitId: 'U2', requirementId: 'RS', requirementName: 'Prova U2', requirementPoints: 25 });
  sub('s-u3', { regionId: 'R2', unitId: 'U3', requirementId: 'RS', requirementName: 'Prova secreta da U3', requirementPoints: 77 });
  sub('s-pend', { regionId: 'R1', unitId: 'U1', requirementId: 'RQ', requirementName: 'Pendente U1', requirementPoints: 8, status: 'pending' });
  t.store.insert('disciplinaryActions', { targetType: 'unit', targetId: 'U1', targetName: 'x', reason: 'Barulho da U1', points: 5, createdAt: { seconds: T + 9, nanoseconds: 0 } }, 'd1');
  t.store.insert('disciplinaryActions', { targetType: 'region', targetId: 'R1', targetName: 'x', reason: 'Segredo da região 1', points: 5, createdAt: { seconds: T + 10, nanoseconds: 0 } }, 'd2');
  t.store.insert('disciplinaryActions', { targetType: 'unit', targetId: 'U3', targetName: 'x', reason: 'Motivo da U3', points: 5, createdAt: { seconds: T + 11, nanoseconds: 0 } }, 'd3');
  tok = { adm: await t.login('admin'), reg1: await t.login('regiao1'), reg2: await t.login('regiao2'), c1: await t.login('cons1'), c2: await t.login('cons2'), c3: await t.login('cons3'), fis: await t.login('fiscal'), apr: await t.login('aprovador') };
});
after(async () => { await t.close(); });
const get = (p, k) => t.call('GET', p, undefined, k ? tok[k] : undefined);

test('PERMISSÕES no servidor: conselheiro só a própria unidade; região só as unidades da própria região; admin qualquer; fiscal/aprovador/sem login não', async () => {
  const ok = [['adm', 'U1'], ['adm', 'U3'], ['reg1', 'U1'], ['reg1', 'U2'], ['reg2', 'U3'], ['c1', 'U1'], ['c2', 'U2'], ['c3', 'U3']];
  for (const [who, unit] of ok) assert.equal((await get(`/scores/units/${unit}/statement`, who)).status, 200, `${who} → ${unit}`);
  const no = [['c1', 'U2'], ['c1', 'U3'], ['c2', 'U1'], ['c3', 'U1'], ['reg1', 'U3'], ['reg2', 'U1'], ['reg2', 'U2'], ['fis', 'U1'], ['apr', 'U1']];
  for (const [who, unit] of no) assert.equal((await get(`/scores/units/${unit}/statement`, who)).status, 403, `${who} → ${unit} deve ser 403`);
  assert.equal((await get('/scores/units/U1/statement')).status, 401, 'sem login');
  assert.equal((await get('/scores/units/NAO-EXISTE/statement', 'adm')).status, 404);
  assert.equal((await get('/scores/units/NAO-EXISTE/statement', 'c1')).status, 403, 'quem não pode não descobre se a unidade existe');
  assert.equal((await get('/scores/units/%2e%2e%2fU2/statement', 'c1')).status, 403);
  // lista (Excel): admin todas; região SÓ a própria; conselheiro/fiscal não
  assert.equal((await get('/scores/statements', 'c1')).status, 403); assert.equal((await get('/scores/statements', 'fis')).status, 403); assert.equal((await get('/scores/statements')).status, 401);
  assert.deepEqual((await get('/scores/statements', 'adm')).body.map(s => s.unidade.id).sort(), ['U1', 'U2', 'U3']);
  assert.deepEqual((await get('/scores/statements', 'reg1')).body.map(s => s.unidade.id).sort(), ['U1', 'U2']);
  assert.deepEqual((await get('/scores/statements?regionId=R2', 'reg1')).body.map(s => s.unidade.id).sort(), ['U1', 'U2'], 'região não consegue pedir outra região');
  assert.deepEqual((await get('/scores/statements?regionId=R2', 'adm')).body.map(s => s.unidade.id), ['U3']);
});

test('"clube amigo": participante de outra região alocado na unidade NÃO muda quem pode ver o extrato (vale o regionId da unidade)', async () => {
  assert.equal(t.store.get('units', 'U1').regionId, 'R1');
  assert.equal((await get('/scores/units/U1/statement', 'reg2')).status, 403, 'a região do clube amigo continua sem acesso');
  assert.equal((await get('/scores/units/U1/statement', 'reg1')).status, 200);
});

test('PRIVACIDADE: o extrato de uma unidade nunca traz nomes, provas ou pontos de outras unidades/regiões', async () => {
  const leaks = ['Lobos Confidenciais', 'Prova secreta da U3', 'Motivo da U3', 'Prova U2', 'Clube Amigo', 'regiao2', 'cons3'];
  for (const [who, unit, forbidden] of [['c1', 'U1', [...leaks, 'Segredo da região 1']], ['reg1', 'U1', leaks.filter(x => x !== 'Prova U2')], ['adm', 'U1', ['Lobos Confidenciais', 'Prova secreta da U3', 'Motivo da U3', 'Prova U2']]]) {
    const body = JSON.stringify((await get(`/scores/units/${unit}/statement`, who)).body);
    for (const f of forbidden) assert.ok(!body.includes(f), `${who} vê "${f}" no extrato da ${unit}`);
  }
  const cons = (await get('/scores/units/U1/statement', 'c1')).body;
  assert.ok(JSON.stringify(cons).includes('Barulho da U1'), 'motivo da própria unidade aparece'); assert.ok(!JSON.stringify(cons).includes('Segredo da região 1'), 'motivo da penalidade da região não');
  assert.ok(cons.linhas.some(l => l.descricao.startsWith('Penalidade da região')), 'mas o desconto da região está lá (soma fecha)');
  assert.deepEqual(Object.keys(cons).sort(), ['confere', 'geradoEm', 'ignorados', 'linhas', 'pendentes', 'possiveis', 'soma', 'subtotais', 'total', 'unidade']);
  const reg = JSON.stringify((await get('/scores/statements', 'reg1')).body);
  for (const f of ['Lobos Confidenciais', 'Prova secreta da U3', 'Motivo da U3']) assert.ok(!reg.includes(f), `lista da região vaza "${f}"`);
});

test('TOTAL IGUAL em cada perfil: ranking (admin) = extrato (admin, região, conselheiro) = portal do conselheiro, em todas as unidades', async () => {
  const ranking = Object.fromEntries((await get('/scores/units', 'adm')).body.map(s => [s.id, s.total]));
  assert.equal(ranking.U1, 10 + 30 - 5 - 5); assert.equal(ranking.U2, 10 + 25 - 5); assert.equal(ranking.U3, 77 - 5);
  // admin
  for (const u of ['U1', 'U2', 'U3']) {
    const st = (await get(`/scores/units/${u}/statement`, 'adm')).body;
    assert.equal(st.total, ranking[u], `admin ${u}`); assert.equal(st.linhas.reduce((a, l) => a + l.pontos, 0), ranking[u]); assert.equal(st.confere, true);
  }
  // região (todas as unidades da própria região) e lista
  for (const u of ['U1', 'U2']) assert.equal((await get(`/scores/units/${u}/statement`, 'reg1')).body.total, ranking[u], `região ${u}`);
  assert.equal((await get('/scores/units/U3/statement', 'reg2')).body.total, ranking.U3);
  assert.deepEqual(Object.fromEntries((await get('/scores/statements', 'reg1')).body.map(s => [s.unidade.id, s.total])), { U1: ranking.U1, U2: ranking.U2 });
  // conselheiro: extrato do servidor, portal (bootstrap) e extrato montado SÓ com o que o celular tem (offline) — os três iguais
  for (const [k, u] of [['c1', 'U1'], ['c2', 'U2'], ['c3', 'U3']]) {
    const st = (await get(`/scores/units/${u}/statement`, k)).body;
    const boot = (await get('/sync/bootstrap', k)).body;
    const portal = counselorPortalTotals(boot).confirmed;
    assert.equal(st.total, ranking[u], `conselheiro ${u}: extrato × ranking`); assert.equal(portal, ranking[u], `conselheiro ${u}: portal × ranking`);
    const offline = buildUnitStatement(u, {
      units: [boot.unit], regions: [boot.region], requirements: [...boot.requirements, ...boot.regionRequirements, ...boot.inspectionRequirements],
      submissions: [...boot.submissions.map(s => ({ ...s, regionId: boot.unit.regionId })), ...boot.regionSubmissions], disciplinaryActions: boot.disciplinaryActions.map(d => ({ ...d, reason: '' })),
    }, { viewer: 'counselor' });
    assert.equal(offline.total, ranking[u], `conselheiro ${u}: extrato offline (só com o snapshot do celular)`); assert.equal(offline.linhas.reduce((a, l) => a + l.pontos, 0), ranking[u]);
  }
  assert.equal((await get('/scores/units/U1/statement', 'c1')).body.possiveis, 8, 'pendente fica em "possíveis", fora do total');
});

test('o ranking público continua anônimo e o extrato não o altera', async () => {
  const rows = (await t.call('GET', '/ranking')).body;
  assert.ok(rows.length > 0 && rows.every(r => Object.keys(r).sort().join() === 'position,stars,total'));
  assert.ok(!JSON.stringify(rows).includes('Águias'));
});
