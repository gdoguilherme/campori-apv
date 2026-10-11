// Pesquisa de Satisfação — regras PURAS (sem DOM/Node), usadas pelo servidor local, pelo front e pela cópia em server/shared.
// ISOLADA da pontuação: nada aqui (nem as coleções `surveys`/`surveyResponses`) entra em submissions, ranking, pontos ou disciplina.
//
// ANONIMATO: a resposta guarda SÓ { surveyId, answers, perfil, regionId?, clientId, criadoEm, editadoEm? } — nunca userId, nome ou username.
// "Já respondeu" é um marcador LOCAL no aparelho (o servidor não sabe quem respondeu). Reenviar/editar usa o mesmo clientId e SUBSTITUI.

export const QUESTION_TYPES = ['nota5', 'escolha', 'simnao', 'texto'];
export const TYPE_LABEL = { nota5: '⭐ Nota de 1 a 5', escolha: '🔘 Múltipla escolha', simnao: '👍 Sim / Não', texto: '✍️ Texto livre' };
export const PROFILES = ['conselheiro', 'regiao', 'fiscal'];
export const PROFILE_LABEL = { conselheiro: 'Conselheiro', regiao: 'Região', fiscal: 'Fiscal' };
export const PROFILE_OF_ROLE = { counselor: 'conselheiro', region: 'regiao', judge: 'fiscal' };   // só estes perfis respondem
export const profileOfRole = role => PROFILE_OF_ROLE[role] || null;

// Campos permitidos numa resposta (teste de anonimato confere que NADA além disto é gravado)
export const RESPONSE_FIELDS = ['surveyId', 'answers', 'perfil', 'regionId', 'clientId', 'criadoEm', 'editadoEm'];
export const CLIENT_ID_RE = /^[A-Za-z0-9_-]{8,80}$/;
export const responseDocId = (surveyId, clientId) => `resp_${surveyId}_${clientId}`;

const LIMITS = { title: 120, question: 300, option: 80, options: 12, questions: 40, text: 1000 };

// ── pesquisa pronta ──────────────────────────────────────────────────────────────────────
export const SAMPLE_SURVEY = {
  titulo: 'Pesquisa de Satisfação — III Campori de Líderes APV',
  aberta: false,
  perguntas: [
    { id: 'q1', tipo: 'nota5', texto: 'Qual a sua nota geral para o evento?', opcoes: [], obrigatoria: true },
    { id: 'q2', tipo: 'nota5', texto: 'Como você avalia a organização do evento?', opcoes: [], obrigatoria: true },
    { id: 'q3', tipo: 'nota5', texto: 'Como você avalia a alimentação?', opcoes: [], obrigatoria: true },
    { id: 'q4', tipo: 'nota5', texto: 'Como você avalia a programação?', opcoes: [], obrigatoria: true },
    { id: 'q5', tipo: 'nota5', texto: 'Como você avalia a parte espiritual?', opcoes: [], obrigatoria: true },
    { id: 'q6', tipo: 'nota5', texto: 'Como você avalia a pontuação e o sistema de provas?', opcoes: [], obrigatoria: true },
    { id: 'q7', tipo: 'texto', texto: 'O que podemos melhorar?', opcoes: [], obrigatoria: false },
    { id: 'q8', tipo: 'texto', texto: 'O que devemos manter?', opcoes: [], obrigatoria: false },
  ],
};

const str = (v, max) => String(v ?? '').trim().slice(0, max);

// Valida e normaliza a DEFINIÇÃO de uma pesquisa (admin). Gera ids de pergunta que faltarem. → { ok, errors, value }
export function validateSurveyDef(def) {
  const errors = [];
  const titulo = str(def?.titulo, LIMITS.title);
  if (!titulo) errors.push('Informe o título da pesquisa.');
  const raw = Array.isArray(def?.perguntas) ? def.perguntas : [];
  if (raw.length === 0) errors.push('Adicione pelo menos uma pergunta.');
  if (raw.length > LIMITS.questions) errors.push(`No máximo ${LIMITS.questions} perguntas.`);
  const ids = new Set();
  const perguntas = raw.slice(0, LIMITS.questions).map((q, i) => {
    const n = i + 1;
    let id = str(q?.id, 40).replace(/[^A-Za-z0-9_-]/g, '');
    if (!id || ids.has(id)) id = `q${Date.now().toString(36)}${n}`;
    ids.add(id);
    const tipo = QUESTION_TYPES.includes(q?.tipo) ? q.tipo : null;
    if (!tipo) errors.push(`Pergunta ${n}: tipo inválido.`);
    const texto = str(q?.texto, LIMITS.question);
    if (!texto) errors.push(`Pergunta ${n}: escreva o texto.`);
    let opcoes = [];
    if (tipo === 'escolha') {
      opcoes = [...new Set((Array.isArray(q?.opcoes) ? q.opcoes : []).map(o => str(o, LIMITS.option)).filter(Boolean))].slice(0, LIMITS.options);
      if (opcoes.length < 2) errors.push(`Pergunta ${n}: informe pelo menos 2 opções.`);
    }
    return { id, tipo: tipo || 'texto', texto, opcoes, obrigatoria: !!q?.obrigatoria };
  });
  return { ok: errors.length === 0, errors, value: { titulo, aberta: !!def?.aberta, perguntas } };
}

// Valida/normaliza as RESPOSTAS contra a pesquisa. Perguntas desconhecidas são descartadas. → { ok, errors, value }
export function normalizeAnswers(survey, answers) {
  const errors = [], value = {};
  for (const q of survey?.perguntas || []) {
    let v = answers?.[q.id];
    if (typeof v === 'string') v = v.trim();
    const empty = v === undefined || v === null || v === '';
    if (empty) { if (q.obrigatoria) errors.push(`Responda: “${q.texto}”`); continue; }
    if (q.tipo === 'nota5') {
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 5) { errors.push(`Nota inválida em “${q.texto}” (1 a 5).`); continue; }
      value[q.id] = n;
    } else if (q.tipo === 'simnao') {
      const s = v === true ? 'sim' : v === false ? 'nao' : String(v).toLowerCase();
      if (s !== 'sim' && s !== 'nao') { errors.push(`Responda Sim ou Não em “${q.texto}”.`); continue; }
      value[q.id] = s;
    } else if (q.tipo === 'escolha') {
      if (!(q.opcoes || []).includes(v)) { errors.push(`Opção inválida em “${q.texto}”.`); continue; }
      value[q.id] = v;
    } else {
      value[q.id] = String(v).slice(0, LIMITS.text);
    }
  }
  return { ok: errors.length === 0, errors, value };
}

// Monta o documento da resposta — SÓ campos anônimos (RESPONSE_FIELDS). Quem chama passa perfil/regionId; nunca identidade.
export function buildResponseDoc({ surveyId, answers, perfil, regionId = null, clientId, criadoEm }) {
  const doc = { surveyId, answers, perfil, clientId, criadoEm };
  if (regionId) doc.regionId = regionId;
  return doc;
}

// ── resultados ───────────────────────────────────────────────────────────────────────────
export function filterResponses(responses, { perfil = '', regionId = '' } = {}) {
  return (responses || []).filter(r => (!perfil || r.perfil === perfil) && (!regionId || r.regionId === regionId));
}

const tsMs = ts => (!ts ? 0 : typeof ts.seconds === 'number' ? ts.seconds * 1000 : typeof ts.toMillis === 'function' ? ts.toMillis() : Number(ts) || 0);

// → { total, questions: [{ id, tipo, texto, answered, avg?, dist?, counts?, sim?, nao?, pctSim?, texts? }] }
export function summarize(survey, responses, filters = {}) {
  const list = filterResponses(responses, filters);
  const questions = (survey?.perguntas || []).map(q => {
    const vals = list.map(r => ({ v: r.answers?.[q.id], r })).filter(x => x.v !== undefined && x.v !== null && x.v !== '');
    const out = { id: q.id, tipo: q.tipo, texto: q.texto, answered: 0 };
    if (q.tipo === 'nota5') {
      const dist = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 };
      for (const { v } of vals) { const n = Number(v); if (dist[n] !== undefined) { dist[n]++; out.answered++; } }
      const sum = Object.entries(dist).reduce((a, [k, c]) => a + Number(k) * c, 0);
      Object.assign(out, { dist, avg: out.answered ? Math.round((sum / out.answered) * 100) / 100 : null });
    } else if (q.tipo === 'escolha') {
      const counts = Object.fromEntries((q.opcoes || []).map(o => [o, 0]));
      for (const { v } of vals) if (counts[v] !== undefined) { counts[v]++; out.answered++; }
      out.counts = counts;
    } else if (q.tipo === 'simnao') {
      let sim = 0, nao = 0;
      for (const { v } of vals) { if (v === 'sim') sim++; else if (v === 'nao') nao++; }
      Object.assign(out, { sim, nao, answered: sim + nao, pctSim: sim + nao ? Math.round((sim / (sim + nao)) * 100) : null });
    } else {
      out.texts = vals.map(({ v, r }) => ({ texto: String(v), perfil: r.perfil, regionId: r.regionId ?? null, criadoEm: tsMs(r.criadoEm) }))
        .sort((a, b) => b.criadoEm - a.criadoEm);
      out.answered = out.texts.length;
    }
    return out;
  });
  return { total: list.length, questions };
}

// ── CSV (admin): uma linha por resposta, SEM identidade; separador ';' + BOM (abre direto no Excel em português) ──
const csvCell = v => {
  let s = String(v ?? '');
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;          // proteção contra injeção de fórmula
  return `"${s.replace(/"/g, '""')}"`;
};
export function buildSurveyCsv(survey, responses, { regionName = id => id || '', fmtDateTime = ms => (ms ? new Date(ms).toISOString() : '') } = {}) {
  const qs = survey?.perguntas || [];
  const head = ['Data', 'Perfil', 'Região', ...qs.map(q => q.texto)];
  const lines = [head.map(csvCell).join(';')];
  for (const r of [...(responses || [])].sort((a, b) => tsMs(a.criadoEm) - tsMs(b.criadoEm))) {
    lines.push([fmtDateTime(tsMs(r.criadoEm)), PROFILE_LABEL[r.perfil] || r.perfil || '', r.regionId ? regionName(r.regionId) : '',
      ...qs.map(q => { const v = r.answers?.[q.id]; return v === 'sim' ? 'Sim' : v === 'nao' ? 'Não' : (v ?? ''); })].map(csvCell).join(';'));
  }
  return '﻿' + lines.join('\r\n');
}
