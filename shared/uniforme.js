// Inspeção de Uniforme — regra ÚNICA de pontuação (módulo PURO, sem DOM/Firestore/Node).
// Usado pelo front (js/inspecao-uniforme.js, js/api.js), pelo servidor local e pela cópia em server/shared (nuvem).
//
// Regra: pontos da unidade = max(0, máx − total_de_erros × desconto_por_erro)
//   · máx e desconto vêm do CADASTRO do requisito (admin): `points` e `uniformPenalty`
//     (padrão sugerido quando não preenchidos: máx 10, −1 por erro);
//   · todas as categorias contam erros, exceto as marcadas `optional` (OPCIONAIS só registra quantidade/observação).

export const UNIFORM_DEFAULTS = { max: 10, penalty: 1 };
export const UNIFORM_MAX_ERRORS = 999;       // teto por categoria (evita lixo/typos)
export const UNIFORM_MAX_NOTE = 500;         // caracteres por observação

// Mesmas 8 colunas da ficha de papel ("QUANTIDADE DE ERROS"). `images`: recortes em /assets/uniforme/.
export const UNIFORM_CATEGORIES = [
  { key: 'mangaDireita',       label: 'Manga direita',          optional: false, images: ['mangas'],        hint: 'Medidas: 1,5 cm · 1,5 cm · 1 cm · 2,6 cm' },
  { key: 'mangaEsquerda',      label: 'Manga esquerda',         optional: false, images: ['mangas'],        hint: 'Medidas: 1 cm · 1 cm · 2,6 cm' },
  { key: 'bolsoDireito',       label: 'Bolso direito',          optional: false, images: ['bolsos-lenco'],  hint: 'Tira com nome, distintivos de classes de liderança e avançadas, insígnia de excelência' },
  { key: 'bolsoEsquerdo',      label: 'Bolso esquerdo',         optional: false, images: ['bolsos-lenco'],  hint: 'Distintivos de classes regulares' },
  { key: 'lencoArganel',       label: 'Lenço / Arganel',        optional: false, images: ['bolsos-lenco'],  hint: 'Lenço e argola' },
  { key: 'calcadosMeias',      label: 'Calçados / Meias',       optional: false, images: ['faixa-calcados'], hint: '' },
  { key: 'faixaBandeiraGlobo', label: 'Faixa / Bandeira / Globo', optional: false, images: ['faixa-calcados', 'bandeira-globo-opcionais'], hint: 'Faixa/cinto, bandeira e globo' },
  { key: 'opcionais',          label: 'Opcionais',              optional: true,  images: ['bandeira-globo-opcionais'], hint: 'Apto, boné, pin de batismo, nome próprio e tira de classe na faixa são opcionais — não descontam pontos' },
];
export const UNIFORM_KEYS = UNIFORM_CATEGORIES.map(c => c.key);
export const UNIFORM_NOTICE = 'Apto, Boné, Pin de batismo, Nome Próprio e Tira de classe na faixa são opcionais.';

export const isUniformReq = req => !!req && req.inspection === 'uniforme';

const num = v => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const round2 = n => Math.round(n * 100) / 100;

// Regra vigente de um requisito de uniforme (com padrão quando o admin não preencheu)
export function uniformRule(req) {
  const max = num(req?.points);
  const penalty = num(req?.uniformPenalty);
  return {
    max: max !== null && max > 0 ? max : UNIFORM_DEFAULTS.max,
    penalty: penalty !== null && penalty >= 0 ? penalty : UNIFORM_DEFAULTS.penalty,
  };
}

export function uniformRuleText(req) {
  const { max, penalty } = uniformRule(req);
  return `Regra atual: máximo ${max} pts, −${penalty} pt${penalty === 1 ? '' : 's'} por erro (mínimo 0). Opcionais não descontam.`;
}

// Saneia a entrada (do aparelho ou da rede): só as 8 chaves conhecidas, inteiros 0..999, observações até 500 caracteres.
export function normalizeUniformInspection(raw) {
  const erros = {}, observacoes = {};
  for (const k of UNIFORM_KEYS) {
    const n = Math.floor(Number(raw?.erros?.[k]));
    erros[k] = Number.isFinite(n) && n > 0 ? Math.min(n, UNIFORM_MAX_ERRORS) : 0;
    const o = raw?.observacoes?.[k];
    if (typeof o === 'string' && o.trim()) observacoes[k] = o.trim().slice(0, UNIFORM_MAX_NOTE);
  }
  return { erros, observacoes };
}

export function countUniformErrors(erros) {
  let counted = 0, optional = 0;
  for (const c of UNIFORM_CATEGORIES) {
    const n = Math.max(0, Math.floor(Number(erros?.[c.key])) || 0);
    if (c.optional) optional += n; else counted += n;
  }
  return { counted, optional };
}

// → { totalErros, opcionais, descontados, pontos, max, penalty }
export function computeUniformPoints(erros, req) {
  const { max, penalty } = uniformRule(req);
  const { counted, optional } = countUniformErrors(erros);
  const descontados = round2(counted * penalty);
  return { totalErros: counted, opcionais: optional, descontados, pontos: Math.max(0, round2(max - descontados)), max, penalty };
}

// ── EXPORTAÇÃO CSV (admin) ───────────────────────────────────────────────────────────────
const STATUS_PT = { approved: 'Aprovada', rejected: 'Rejeitada', pending: 'Pendente' };
// aspas duplicadas + proteção contra "injeção de fórmula" (=, +, -, @ no começo viram texto no Excel)
const csvCell = v => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return `"${s.replace(/"/g, '""')}"`;
};

// Linhas: região, unidade, avaliador, data, 8 contagens, total de erros, pontos, status, observações.
// Separador `;` e BOM (abre direto no Excel em português). Só submissions com `uniformInspection`.
export function buildUniformCsv({ submissions = [], units = [], regions = [], requirements = [], fmtDateTime = ms => new Date(ms).toISOString() } = {}) {
  const unitName = id => units.find(u => u.id === id)?.name || id || '';
  const regionName = id => regions.find(r => r.id === id)?.name || id || '';
  const reqOf = id => requirements.find(r => r.id === id);
  const head = ['Região', 'Unidade', 'Avaliador', 'Avaliado em', ...UNIFORM_CATEGORIES.map(c => c.label), 'Total de erros', 'Pontos', 'Status', 'Observações'];
  const lines = [head.map(csvCell).join(';')];
  for (const s of submissions.filter(x => x.uniformInspection)) {
    const ui = s.uniformInspection;
    const t = computeUniformPoints(ui.erros, reqOf(s.requirementId));
    const obs = UNIFORM_CATEGORIES.filter(c => ui.observacoes?.[c.key]).map(c => `${c.label}: ${ui.observacoes[c.key]}`).join(' | ');
    lines.push([
      s.regionName || regionName(s.regionId), unitName(s.unitId), ui.avaliadorNome || s.submittedByName || '',
      ui.avaliadoEm ? fmtDateTime(ui.avaliadoEm) : '',
      ...UNIFORM_CATEGORIES.map(c => Math.max(0, Math.floor(Number(ui.erros?.[c.key])) || 0)),
      t.totalErros, s.requirementPoints ?? t.pontos, STATUS_PT[s.status] || s.status, obs
    ].map(csvCell).join(';'));
  }
  return '﻿' + lines.join('\r\n');
}
