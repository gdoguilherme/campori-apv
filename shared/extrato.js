// Extrato de pontos por unidade — módulo PURO (sem DOM/Node), usado pelo front (admin, região, conselheiro), pelo servidor local
// (GET /scores/units/:id/statement) e pela cópia em server/shared (nuvem).
//
// GARANTIA: o extrato usa a MESMA seleção de pontos de computeUnitScores (shared/scoring.js) — aprovadas, a mais recente por
// (unidade|região + requisito), disciplina sem duplicata local×nuvem — e o total devolvido é o do ranking. A soma das linhas = total
// (testes aleatórios conferem). NADA aqui altera regra de pontuação.
import { tsSeconds, computeUnitScores, dedupeDisciplinaryActions, DISCIPLINE_POINTS, reqFilledBy } from './scoring.js';

export const CATEGORIAS = ['provas', 'regionais', 'qr', 'uniforme', 'disciplina'];
export const CATEGORIA_LABEL = { provas: 'Provas da unidade', regionais: 'Pontos da região', qr: 'QR Codes', uniforme: 'Inspeção de uniforme', disciplina: 'Disciplina', piso: 'Ajuste de piso' };
// filtro por origem na tela do extrato
export const ORIGEM_FILTROS = [['', 'Todas'], ['provas', 'Provas'], ['regionais', 'Regional'], ['qr', 'QR Code'], ['uniforme', 'Uniforme'], ['disciplina', 'Disciplina']];

const ms = ts => tsSeconds(ts) * 1000;

// Seleciona as submissões que pontuam a unidade, com a MESMA regra de computeUnitScores:
// aprovadas, da mais recente para a mais antiga, uma por (unitId|regionId + requisito).
function pickApproved(unit, submissions) {
  const counted = new Set(), picked = [];
  [...submissions].filter(s => s.status === 'approved')
    .sort((a, b) => tsSeconds(b.submittedAt) - tsSeconds(a.submittedAt))
    .forEach(s => {
      if (s.unitId) {
        if (s.unitId !== unit.id) return;
        const key = `${s.unitId}:${s.requirementId}`;
        if (counted.has(key)) return;
        counted.add(key); picked.push({ s, nivel: 'unidade' });
      } else {
        if (s.regionId !== unit.regionId) return;
        const key = `${s.regionId}:${s.requirementId}`;
        if (counted.has(key)) return;
        counted.add(key); picked.push({ s, nivel: 'regiao' });
      }
    });
  return { picked, counted };
}

// Pendentes (ainda NÃO contam): a mais recente por chave que ainda não tem aprovada
function pickPending(unit, submissions, approvedKeys) {
  const seen = new Set(approvedKeys), out = [];
  [...submissions].filter(s => s.status === 'pending')
    .sort((a, b) => tsSeconds(b.submittedAt) - tsSeconds(a.submittedAt))
    .forEach(s => {
      let key;
      if (s.unitId) { if (s.unitId !== unit.id) return; key = `${s.unitId}:${s.requirementId}`; }
      else { if (s.regionId !== unit.regionId) return; key = `${s.regionId}:${s.requirementId}`; }
      if (seen.has(key)) return;
      seen.add(key); out.push({ s, nivel: s.unitId ? 'unidade' : 'regiao' });
    });
  return out;
}

// Requisitos que se aplicam à unidade e em que ela NÃO pontuou (0 pt): só INFORMATIVO (não entra em total/linhas) e só para o ADMIN.
// Aplica: ativo; do Conselheiro e inspeção de uniforme → a unidade; Regional e "Só Fiscal" → a região dela (se a modalidade combina,
// como no portal). Motivo: Aprovado com 0 pts · Aguardando aprovação · Rejeitado · Não preenchido.
export function buildNaoPontuados(unit, region, dados, picked) {
  const { submissions = [], requirements = [] } = dados;
  const earned = new Map();
  for (const { s } of picked) earned.set(s.requirementId, (earned.get(s.requirementId) || 0) + (s.requirementPoints || 0));
  const cat = region?.competitionCategory || null;
  const out = [];
  for (const r of [...requirements].filter(x => x.active !== false).sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9) || String(a.name).localeCompare(String(b.name), 'pt'))) {
    const tipoReq = r.inspection === 'uniforme' ? 'uniforme' : reqFilledBy(r);
    const regional = tipoReq === 'regional' || tipoReq === 'fiscal';
    if (regional && cat && r.competitionCategory && r.competitionCategory !== 'Ambos' && r.competitionCategory !== cat) continue;   // não vale para esta modalidade
    if (earned.get(r.id) > 0) continue;                                                                                     // pontuou
    const mine = submissions.filter(s => s.requirementId === r.id && (s.unitId ? s.unitId === unit.id : s.regionId === unit.regionId))
      .sort((a, b) => tsSeconds(b.submittedAt) - tsSeconds(a.submittedAt));
    const motivo = picked.some(({ s }) => s.requirementId === r.id) ? 'Aprovado com 0 pts'
      : mine.some(s => s.status === 'pending') ? 'Aguardando aprovação'
      : mine[0]?.status === 'rejected' ? 'Rejeitado' : 'Não preenchido';
    out.push({ requirementId: r.id, requisito: r.name || r.id, tipo: ({ conselheiro: 'Unidade', regional: 'Regional', fiscal: 'Fiscal (região)', uniforme: 'Uniforme' })[tipoReq] || 'Unidade', pontosPossiveis: r.points || 0, motivo });
  }
  return out;
}

// dados: { units, regions, submissions, disciplinaryActions, requirements }
// opts:  { viewer: 'admin'|'region'|'counselor' (counselor não vê o motivo da penalidade da REGIÃO), generatedAt, ranking (mapa id→total já calculado) }
export function buildUnitStatement(unitId, dados, { viewer = 'admin', generatedAt = Date.now(), ranking = null, incluirNaoPontuados = false } = {}) {
  const { units = [], regions = [], submissions = [], disciplinaryActions = [], requirements = [] } = dados || {};
  const unit = units.find(u => u.id === unitId);
  if (!unit) return null;
  const region = regions.find(r => r.id === unit.regionId) || null;
  const regionName = region?.name || unit.regionId || '';
  const reqName = id => requirements.find(r => r.id === id)?.name;
  const reqOf = id => requirements.find(r => r.id === id);

  const describe = (s, nivel) => {
    const nome = s.requirementName || reqName(s.requirementId) || s.requirementId;
    const isUniform = !!s.uniformInspection || reqOf(s.requirementId)?.inspection === 'uniforme';
    if (s.source === 'qr') return { categoria: 'qr', origem: 'qr', origemLabel: 'QR Code', descricao: s.qrVariantLabel ? `${nome} — ${s.qrVariantLabel}` : nome };
    if (isUniform) {
      const erros = s.uniformInspection ? Object.entries(s.uniformInspection.erros || {}).filter(([k]) => k !== 'opcionais').reduce((a, [, n]) => a + (Number(n) || 0), 0) : null;
      return { categoria: 'uniforme', origem: 'uniforme', origemLabel: 'Fiscal · Uniforme', descricao: `Inspeção de uniforme${erros === null ? '' : ` (${erros} erro${erros === 1 ? '' : 's'})`}` };
    }
    if (nivel === 'regiao') return { categoria: 'regionais', origem: 'regional', origemLabel: `Regional · ${regionName}`, descricao: nome };
    return { categoria: 'provas', origem: s.source === 'judge' ? 'fiscal' : 'unidade', origemLabel: s.source === 'judge' ? 'Fiscal' : 'Unidade', descricao: nome };
  };

  const { picked, counted } = pickApproved(unit, submissions);
  const linhas = picked.map(({ s, nivel }, i) => ({
    id: s.id ?? `sub${i}`, data: ms(s.reviewedAt) || ms(s.submittedAt), ...describe(s, nivel), pontos: s.requirementPoints || 0, requirementId: s.requirementId,
  }));

  // disciplina: da unidade e da região (−5 cada), sem contar em dobro a mesma infração lançada local × nuvem
  const { kept, duplicates } = dedupeDisciplinaryActions(disciplinaryActions);
  for (const d of kept) {
    const daUnidade = d.targetType === 'unit' && d.targetId === unit.id;
    const daRegiao = d.targetType === 'region' && d.targetId === unit.regionId;
    if (!daUnidade && !daRegiao) continue;
    const motivo = daRegiao && viewer === 'counselor' ? '' : (d.reason ? `: ${d.reason}` : '');
    linhas.push({
      id: d.id ?? `disc${linhas.length}`, data: ms(d.createdAt), categoria: 'disciplina',
      origem: daUnidade ? 'disciplina-unidade' : 'disciplina-regiao', origemLabel: daUnidade ? 'Disciplina · Unidade' : `Disciplina · Região (${regionName})`,
      descricao: `${daUnidade ? 'Penalidade da unidade' : 'Penalidade da região'}${motivo}`, pontos: -(d.points || DISCIPLINE_POINTS),
    });
  }
  const ignorados = duplicates.filter(d => (d.targetType === 'unit' && d.targetId === unit.id) || (d.targetType === 'region' && d.targetId === unit.regionId))
    .map(d => ({ id: d.id, descricao: 'Mesma infração lançada no servidor local e na nuvem — contada uma vez', duplicadaDe: d.duplicateOf }));

  // cronológico (empate: ordem de montagem) + saldo acumulado
  linhas.forEach((l, i) => { l._i = i; });
  linhas.sort((a, b) => a.data - b.data || a._i - b._i);
  const soma = linhas.reduce((a, l) => a + l.pontos, 0);   // soma bruta (antes do piso)
  // a pontuação da unidade nunca fica abaixo de 0 (igual ao ranking): se a soma é negativa, uma linha final explica
  if (soma < 0) linhas.push({ id: 'piso', data: Math.max(0, ...linhas.map(l => l.data)), categoria: 'piso', origem: 'piso', origemLabel: 'Ajuste', descricao: 'A pontuação da unidade não fica abaixo de 0', pontos: -soma, _i: 1e9 });
  let saldo = 0;
  for (const l of linhas) { saldo += l.pontos; l.saldo = saldo; delete l._i; }

  const subtotais = { provas: 0, regionais: 0, qr: 0, uniforme: 0, disciplina: 0, piso: 0 };
  for (const l of linhas) subtotais[l.categoria] += l.pontos;

  const totalRanking = ranking ? ranking[unit.id] : computeUnitScores(submissions, units, disciplinaryActions).find(s => s.id === unit.id)?.total;
  const pend = pickPending(unit, submissions, counted).map(({ s, nivel }) => ({ ...describe(s, nivel), id: s.id, data: ms(s.submittedAt), pontos: s.requirementPoints || 0 }));

  return {
    unidade: { id: unit.id, nome: unit.name, regionId: unit.regionId, regiao: regionName },
    geradoEm: generatedAt,
    total: totalRanking ?? Math.max(0, soma),
    soma, confere: Math.max(0, soma) === (totalRanking ?? Math.max(0, soma)),
    subtotais,
    linhas,
    pendentes: pend.sort((a, b) => b.data - a.data),
    possiveis: pend.reduce((a, p) => a + p.pontos, 0),
    ignorados,
    ...(incluirNaoPontuados && viewer === 'admin' ? { naoPontuados: buildNaoPontuados(unit, region, dados, picked) } : {}),   // só o ADMIN pede e recebe
  };
}

// Extrato de várias unidades (região inteira / todas): calcula o ranking UMA vez
export function buildStatements(unitIds, dados, opts = {}) {
  const rk = Object.fromEntries(computeUnitScores(dados.submissions || [], dados.units || [], dados.disciplinaryActions || []).map(s => [s.id, s.total]));
  return unitIds.map(id => buildUnitStatement(id, dados, { ...opts, ranking: rk })).filter(Boolean);
}

export const filterLines = (stmt, categoria = '') => (categoria ? stmt.linhas.filter(l => l.categoria === categoria) : stmt.linhas);

// ── exportações ────────────────────────────────────────────────────────────────────────────
const csvCell = v => {
  let s = String(v ?? '');
  if (/^[=+@\t\r]/.test(s) || (/^-/.test(s) && !/^-?\d+([.,]\d+)?$/.test(s))) s = `'${s}`;   // proteção contra fórmula; números negativos ficam números
  return `"${s.replace(/"/g, '""')}"`;
};
const fmtDate = (msv, fmt) => (msv ? fmt(msv) : '');
const defaultFmt = msv => new Date(msv).toISOString().slice(0, 16).replace('T', ' ');

// CSV da unidade (separador ';', BOM — abre direto no Excel em português)
export function statementCsv(stmt, { fmtDateTime = defaultFmt, categoria = '' } = {}) {
  const rows = [
    ['Extrato de pontos'], ['Unidade', stmt.unidade.nome], ['Região', stmt.unidade.regiao], ['Gerado em', fmtDate(stmt.geradoEm, fmtDateTime)], ['Total', stmt.total], [],
    ['Data', 'Origem', 'Descrição', 'Pontos', 'Saldo'],
    ...filterLines(stmt, categoria).map(l => [fmtDate(l.data, fmtDateTime), l.origemLabel, l.descricao, l.pontos, l.saldo]),
    [], ['Subtotais'], ...Object.entries(stmt.subtotais).filter(([k, v]) => v !== 0 || k !== 'piso').map(([k, v]) => [CATEGORIA_LABEL[k], v]),
    ['Pontos possíveis (aguardando aprovação)', stmt.possiveis],
  ];
  return '﻿' + rows.map(r => r.map(csvCell).join(';')).join('\r\n');
}

// Excel: aba "Resumo" (uma linha por unidade) + uma aba por unidade. Devolve { resumo: [[…]], abas: [{ nome, linhas: [[…]] }] }
export function sheetName(nome, usados = new Set()) {
  const base = (String(nome ?? '').replace(/[\\/?*[\]:]/g, ' ').replace(/\s+/g, ' ').trim() || 'Unidade').slice(0, 31);
  let n = base, i = 2;
  while (usados.has(n.toLowerCase()) || n.toLowerCase() === 'resumo') { const suf = ` (${i++})`; n = base.slice(0, 31 - suf.length) + suf; }
  usados.add(n.toLowerCase());
  return n;
}
export function workbookData(statements, { fmtDateTime = defaultFmt, titulo = 'Resumo' } = {}) {
  const comNao = statements.some(st => st.naoPontuados);   // só o Excel do ADMIN traz os requisitos sem pontuação
  const resumo = [['Unidade', 'Região', 'Total', 'Provas', 'Regional', 'QR Code', 'Uniforme', 'Disciplina', 'Pontos possíveis', ...(comNao ? ['Requisitos sem pontuação'] : [])]];
  const usados = new Set();
  const abas = statements.map(st => {
    resumo.push([st.unidade.nome, st.unidade.regiao, st.total, st.subtotais.provas, st.subtotais.regionais, st.subtotais.qr, st.subtotais.uniforme, st.subtotais.disciplina + st.subtotais.piso, st.possiveis, ...(comNao ? [st.naoPontuados?.length ?? 0] : [])]);
    return {
      nome: sheetName(st.unidade.nome, usados),
      linhas: [['Unidade', st.unidade.nome], ['Região', st.unidade.regiao], ['Gerado em', fmtDate(st.geradoEm, fmtDateTime)], ['Total', st.total], [],
        ['Data', 'Origem', 'Descrição', 'Pontos', 'Saldo'], ...st.linhas.map(l => [fmtDate(l.data, fmtDateTime), l.origemLabel, l.descricao, l.pontos, l.saldo]),
        ...(st.naoPontuados ? [[], ['Requisitos sem pontuação (não preenchidos ou com 0 pt)'], ['Requisito', 'Tipo', 'Pontos possíveis', 'Motivo'],
          ...(st.naoPontuados.length ? st.naoPontuados.map(n => [n.requisito, n.tipo, n.pontosPossiveis, n.motivo]) : [['Todos os requisitos aplicáveis pontuaram']])] : [])],
    };
  });
  return { resumo, abas, titulo };
}

// HTML limpo para Imprimir/PDF (nome da unidade, região, data de geração, tabela)
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
export function statementPrintHtml(stmt, { fmtDateTime = defaultFmt, categoria = '' } = {}) {
  const rows = filterLines(stmt, categoria).map(l => `<tr><td>${esc(fmtDate(l.data, fmtDateTime))}</td><td>${esc(l.origemLabel)}</td><td>${esc(l.descricao)}</td><td class="n ${l.pontos < 0 ? 'neg' : ''}">${l.pontos > 0 ? '+' : ''}${l.pontos}</td><td class="n">${l.saldo}</td></tr>`).join('');
  const sub = Object.entries(stmt.subtotais).filter(([k, v]) => v !== 0 || k !== 'piso').map(([k, v]) => `<span>${esc(CATEGORIA_LABEL[k])}: <b>${v}</b></span>`).join('');
  return `<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><title>Extrato — ${esc(stmt.unidade.nome)}</title><style>
    @page{size:A4;margin:14mm} body{font:12px/1.4 system-ui,-apple-system,"Segoe UI",sans-serif;color:#111;margin:0}
    h1{font-size:18px;margin:0 0 2px} .meta{color:#444;margin-bottom:10px} .tot{font-size:16px;margin:8px 0} .sub{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:10px;font-size:11px;color:#333}
    table{width:100%;border-collapse:collapse} th,td{border-bottom:1px solid #ddd;padding:4px 6px;text-align:left;vertical-align:top} th{background:#f1f5f9;font-size:11px}
    td.n,th.n{text-align:right;white-space:nowrap} .neg{color:#b91c1c} tr{page-break-inside:avoid} .foot{margin-top:10px;color:#666;font-size:10px}
  </style></head><body>
    <h1>Extrato de pontos — ${esc(stmt.unidade.nome)}</h1>
    <div class="meta">Região: <b>${esc(stmt.unidade.regiao)}</b> · Gerado em ${esc(fmtDate(stmt.geradoEm, fmtDateTime))} · ÍNTEGROS · III Campori de Líderes APV</div>
    <div class="tot">Total: <b>${stmt.total} pts</b>${stmt.possiveis ? ` <span style="color:#666;font-size:12px">(+ ${stmt.possiveis} possíveis aguardando aprovação)</span>` : ''}</div>
    <div class="sub">${sub}</div>
    <table><thead><tr><th>Data</th><th>Origem</th><th>Prova / motivo</th><th class="n">Pontos</th><th class="n">Saldo</th></tr></thead><tbody>${rows || '<tr><td colspan="5">Nenhuma pontuação ainda.</td></tr>'}</tbody></table>
    <div class="foot">Pontos pendentes de aprovação não entram no total. Documento gerado pelo sistema de pontuação.</div>
  </body></html>`;
}

// Linhas da aba "Sem pontuação" do Excel do Histórico (admin): uma por unidade × requisito sem pontos
export const naoPontuadosRows = statements => [
  ['Unidade', 'Região', 'Requisito', 'Tipo', 'Pontos possíveis', 'Motivo'],
  ...statements.flatMap(st => (st.naoPontuados || []).map(n => [st.unidade.nome, st.unidade.regiao, n.requisito, n.tipo, n.pontosPossiveis, n.motivo])),
];
