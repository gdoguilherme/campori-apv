import express from 'express';
import { httpError, newId } from '../db.js';
import { ADMIN_ROLES, wrap } from '../auth.js';
import {
  SAMPLE_SURVEY, validateSurveyDef, normalizeAnswers, buildResponseDoc, responseDocId, profileOfRole, CLIENT_ID_RE
} from '../../../shared/survey.js';

// Pesquisa de Satisfação — ISOLADA da pontuação (não toca em submissions/ranking/pontos/disciplina).
//  · admin (superadmin/admin): cria/edita/abre/fecha pesquisas e vê as respostas;
//  · conselheiro/região/fiscal: veem só as pesquisas ABERTAS e enviam respostas ANÔNIMAS (o servidor grava só perfil e regionId).
export function surveyRouter({ store, auth }) {
  const r = express.Router();
  const { requireAuth } = auth;
  const RESPONDERS = ['counselor', 'region', 'judge'];

  // pesquisas abertas (definição das perguntas, sem resultados)
  r.get('/open', requireAuth(), (_req, res) => {
    res.set('Cache-Control', 'no-store').json(store.list('surveys', { filters: { aberta: 'true' } }).map(({ id, titulo, perguntas }) => ({ id, titulo, perguntas })));
  });

  r.get('/', requireAuth(ADMIN_ROLES), (_req, res) => res.json(store.list('surveys')));

  const save = (id, body, base = {}) => {
    const v = validateSurveyDef({ ...base, ...body });
    if (!v.ok) throw httpError(400, v.errors[0], 'INVALID_SURVEY');
    return id ? store.update('surveys', id, v.value) : store.insert('surveys', { ...v.value, criadoEm: { __serverTimestamp: true } }, newId());
  };

  r.post('/', requireAuth(ADMIN_ROLES), (req, res) => res.json(save(null, req.body || {})));

  r.post('/sample', requireAuth(ADMIN_ROLES), (_req, res) =>
    res.json(store.insert('surveys', { ...validateSurveyDef(SAMPLE_SURVEY).value, criadoEm: { __serverTimestamp: true } }, newId())));

  r.patch('/:id', requireAuth(ADMIN_ROLES), (req, res) => {
    const cur = store.get('surveys', req.params.id);
    if (!cur) throw httpError(404, 'Pesquisa não encontrada');
    res.json(save(req.params.id, req.body || {}, cur));
  });

  // não apaga pesquisa com respostas (feche-a): evita perder dados por engano
  r.delete('/:id', requireAuth(ADMIN_ROLES), (req, res) => {
    if (!store.get('surveys', req.params.id)) throw httpError(404, 'Pesquisa não encontrada');
    if (store.list('surveyResponses', { filters: { surveyId: req.params.id } }).length) throw httpError(409, 'Esta pesquisa já tem respostas — feche-a em vez de apagar.', 'HAS_RESPONSES');
    store.remove('surveys', req.params.id);
    res.json({ ok: true });
  });

  r.get('/:id/responses', requireAuth(ADMIN_ROLES), (req, res) => {
    if (!store.get('surveys', req.params.id)) throw httpError(404, 'Pesquisa não encontrada');
    res.set('Cache-Control', 'no-store').json(store.list('surveyResponses', { filters: { surveyId: req.params.id } }));
  });

  // Resposta ANÔNIMA e idempotente: o id do documento vem do clientId (o app guarda o marcador "já respondeu" no aparelho).
  // Reenviar/editar com o MESMO clientId substitui as respostas (mantém criadoEm). O perfil vem do token; regionId só de região/conselheiro.
  r.post('/:id/responses', requireAuth(RESPONDERS), wrap(async (req, res) => {
    const { clientId, answers } = req.body || {};
    if (!CLIENT_ID_RE.test(String(clientId ?? ''))) throw httpError(400, 'clientId inválido', 'INVALID_CLIENT_ID');
    const survey = store.get('surveys', req.params.id);
    if (!survey) throw httpError(404, 'Pesquisa não encontrada');
    if (survey.aberta !== true) throw httpError(409, 'Esta pesquisa está encerrada.', 'SURVEY_CLOSED');
    const norm = normalizeAnswers(survey, answers);
    if (!norm.ok) throw httpError(400, norm.errors[0], 'INVALID_ANSWERS');
    const id = responseDocId(survey.id, clientId);
    const out = store.tx(() => {
      const existing = store.get('surveyResponses', id);
      if (existing) {
        if (JSON.stringify(existing.answers) === JSON.stringify(norm.value)) return { id, result: 'unchanged' };
        store.update('surveyResponses', id, { answers: norm.value, editadoEm: { __serverTimestamp: true } });
        return { id, result: 'updated' };
      }
      store.insert('surveyResponses', buildResponseDoc({
        surveyId: survey.id, answers: norm.value, perfil: profileOfRole(req.user.role),
        regionId: req.user.role === 'judge' ? null : (req.user.regionId || null), clientId, criadoEm: { __serverTimestamp: true },
      }), id);
      return { id, result: 'created' };
    });
    res.json(out);          // nada que identifique o autor volta (nem é gravado)
  }));

  return r;
}
