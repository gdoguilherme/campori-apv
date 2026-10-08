// Regras de negócio do Campori — módulo PURO (sem DOM, Firestore ou Node APIs).
// Usado pelo frontend (js/api.js, js/conselheiro.js) e pelo servidor local
// (local-server/), para a lógica de pontuação existir num único lugar.

export const DISCIPLINE_POINTS = 5;

// Tipo do requisito ('regional'|'conselheiro'|'fiscal') — com fallback pro campo
// antigo `evaluatedBy` em requisitos criados antes da Fase 6 (nunca migrados no banco)
export const reqFilledBy = req => req.filledBy || (req.evaluatedBy === 'fiscal' ? 'fiscal' : 'regional');

// Aceita Timestamp do Firestore ({seconds}/toDate()), {seconds,nanoseconds} serializado,
// milissegundos ou string ISO. Valor ausente (ex: serverTimestamp ainda pendente) = 0.
export function tsSeconds(ts) {
  if (!ts) return 0;
  if (typeof ts.seconds === 'number') return ts.seconds;
  if (typeof ts.toDate === 'function') return ts.toDate().getTime() / 1000;
  const ms = new Date(ts).getTime();
  return Number.isNaN(ms) ? 0 : ms / 1000;
}

export function isDeadlinePassed(req, nowMs = Date.now()) {
  if (!req.deadline) return false;
  const d = req.deadline.toDate ? req.deadline.toDate() : new Date(
    typeof req.deadline.seconds === 'number' ? req.deadline.seconds * 1000 : req.deadline
  );
  return nowMs > d.getTime();
}

// Pontuação por UNIDADE:
// - submission sem unitId (enviada/aprovada pela região, ou avaliada pelo Fiscal
//   no nível da região) → pontua TODAS as unidades daquela região
// - submission com unitId (enviada pelo Conselheiro, ou avaliada pelo Fiscal
//   no nível da unidade) → pontua só aquela unidade
// Unidades são mistas (sem separação DBV/AVT) — não há catFilter aqui.
export function computeUnitScores(submissions, units, disciplinaryActions = []) {
  const scores = {};
  units.forEach(u => { scores[u.id] = { name: u.name, regionId: u.regionId, total: 0, count: 0 }; });

  const counted = new Set();
  [...submissions]
    .filter(s => s.status === 'approved')
    .sort((a, b) => tsSeconds(b.submittedAt) - tsSeconds(a.submittedAt))
    .forEach(s => {
      if (s.unitId) {
        if (!scores[s.unitId]) return;
        const key = `${s.unitId}:${s.requirementId}`;
        if (counted.has(key)) return;
        counted.add(key);
        scores[s.unitId].total += s.requirementPoints || 0;
        scores[s.unitId].count++;
      } else {
        const regionUnits = units.filter(u => u.regionId === s.regionId);
        if (regionUnits.length === 0) return;
        const key = `${s.regionId}:${s.requirementId}`;
        if (counted.has(key)) return;
        counted.add(key);
        regionUnits.forEach(u => {
          scores[u.id].total += s.requirementPoints || 0;
          scores[u.id].count++;
        });
      }
    });

  // Disciplina: desconta pontos da unidade específica, ou de todas as unidades
  // da região (não altera "count" de aprovações — é só uma penalidade de pontos)
  disciplinaryActions.forEach(d => {
    const pts = d.points || DISCIPLINE_POINTS;
    if (d.targetType === 'unit') {
      if (scores[d.targetId]) scores[d.targetId].total -= pts;
    } else if (d.targetType === 'region') {
      units.filter(u => u.regionId === d.targetId).forEach(u => {
        if (scores[u.id]) scores[u.id].total -= pts;
      });
    }
  });
  Object.values(scores).forEach(s => { s.total = Math.max(0, s.total); });

  return Object.entries(scores).map(([id, v]) => ({ id, ...v })).sort((a, b) => b.total - a.total);
}

// Total de UMA unidade com a composição "X da unidade + Y da região − Z de disciplina", calculado pela MESMA
// computeUnitScores do ranking (então o número do portal do Conselheiro sempre bate com o ranking):
//   unitSubmissions   — submissões com unitId = unidade (Conselheiro / QR / fiscal no nível da unidade)
//   regionSubmissions — submissões SEM unitId da região da unidade (Regional / fiscal no nível da região): valem p/ todas as unidades
//   disciplinaryActions — qualquer lista; só entram as da unidade ou da região dela
export function computeUnitBreakdown({ unit, unitSubmissions = [], regionSubmissions = [], disciplinaryActions = [] }) {
  const one = (subs, disc = []) => computeUnitScores(subs, [unit], disc)[0]?.total ?? 0;
  const own = one(unitSubmissions.filter(s => s.unitId === unit.id));
  const region = one(regionSubmissions.filter(s => !s.unitId && s.regionId === unit.regionId));
  const discipline = disciplinaryActions
    .filter(d => (d.targetType === 'unit' && d.targetId === unit.id) || (d.targetType === 'region' && d.targetId === unit.regionId))
    .reduce((a, d) => a + (d.points || DISCIPLINE_POINTS), 0);
  const total = one([...unitSubmissions, ...regionSubmissions], disciplinaryActions);   // exatamente o que o ranking calcula (com o piso em 0)
  return { own, region, discipline, total, floored: own + region - discipline < 0 };
}

// Classificação relativa à maior pontuação (não a um total fixo de pontos possíveis):
// ⭐⭐⭐ 80-100% · ⭐⭐ 60-79% · ⭐ abaixo de 59%
export function computeStars(total, maxTotal) {
  if (!maxTotal || total <= 0) return 0;
  const pct = (total / maxTotal) * 100;
  if (pct >= 80) return 3;
  if (pct >= 60) return 2;
  return 1;
}

// ── QR CODE ───────────────────────────────────────────────────

// Trava de duplicidade: chave (unitId, requirementId-pai) — NÃO o id da variante,
// então a unidade só pode pontuar UMA variante da mesma prova, nunca duas.
// `unitId` opcional: o frontend já passa só as submissions da própria unidade.
export function findQrDuplicate(submissions, unitId, requirementId) {
  return submissions.find(s =>
    s.requirementId === requirementId &&
    s.status === 'approved' &&
    (unitId === undefined || unitId === null || s.unitId === unitId)
  ) || null;
}

// Decide se um scan de QR (cujo hash JÁ foi verificado) pode pontuar a unidade.
// Retorna { ok:true, variant } ou { ok:false, status, code, message }.
export function evaluateQrScan({ selectedRequirementId, payload, requirement, submissions, unitId }) {
  const { requisitoId, varianteId, pontos } = payload;

  if (selectedRequirementId && requisitoId !== selectedRequirementId) {
    return fail(409, 'WRONG_PROVA', 'Este QR Code pertence a uma prova diferente da que você selecionou.');
  }
  if (!requirement) return fail(404, 'REQUIREMENT_NOT_FOUND', 'Requisito não encontrado');
  if (requirement.active === false) return fail(422, 'REQUIREMENT_INACTIVE', 'Este requisito está desativado');
  if (reqFilledBy(requirement) !== 'conselheiro') {
    return fail(422, 'NOT_COUNSELOR_REQUIREMENT', 'Este requisito não é pontuado pelo Conselheiro');
  }

  const variant = (requirement.qrVariants || []).find(v => v.id === varianteId);
  if (!variant) return fail(422, 'VARIANT_NOT_FOUND', 'Variante de QR Code não existe mais neste requisito');
  if (variant.points !== pontos) {
    return fail(422, 'POINTS_MISMATCH', 'Pontuação do QR Code não confere com o requisito (QR desatualizado)');
  }

  if (findQrDuplicate(submissions, unitId, requisitoId)) {
    return fail(409, 'DUPLICATE', 'Esta unidade já registrou pontuação para esta prova.');
  }
  return { ok: true, variant };
}

function fail(status, code, message) { return { ok: false, status, code, message }; }
