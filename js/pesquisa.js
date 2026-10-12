// Formulário da Pesquisa de Satisfação (conselheiro, região, fiscal) — mobile-first, sem pontos, ANÔNIMO.
// A resposta entra na fila do aparelho (IndexedDB) e é enviada quando houver conexão (barra 🟢🟡🔴). "Já respondeu" é um
// marcador só neste aparelho: o servidor nunca recebe nem guarda quem respondeu (só perfil e região).
import { guardPage, portalUrlForUser, startExpiryWatcher } from './auth.js';
import { subOpenSurveys, toast } from './api.js';
import { mountPortalBar } from './portalBar.js';
import {
  enqueueSurveyResponse, syncSurveyQueue, startSurveyAutoSync, onSurveyQueueChange, listSurveyQueue, SQ_STATUS,
  getAnsweredMarker, newClientId, cacheOpenSurveys, getCachedOpenSurveys
} from './surveyQueue.js';
import { normalizeAnswers, surveyEmoji } from '../shared/survey.js';

const S = { user: null, surveys: [], surveyId: null, answers: {}, errors: {}, step: 'choose', clientId: null, isEdit: false, sentStatus: null, saving: false };
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const FACES = ['😞', '😕', '😐', '🙂', '😍'];
const current = () => S.surveys.find(s => s.id === S.surveyId) || null;
const answered = id => !!getAnsweredMarker(S.user.id, id);   // marcador só deste aparelho

export async function init() {
  const user = guardPage(['counselor', 'region', 'judge']);
  if (!user) return;
  Object.assign(S, { user, surveys: [], surveyId: null, answers: {}, errors: {}, step: 'choose', clientId: null, isEdit: false, sentStatus: null, saving: false });
  startExpiryWatcher();
  S.surveys = await getCachedOpenSurveys();              // abre mesmo sem rede
  ensureView();
  subOpenSurveys(list => { S.surveys = list; cacheOpenSurveys(list); ensureView(); render(); });
  startSurveyAutoSync();
  onSurveyQueueChange(() => refreshSent());
  mountPortalBar({ getPending: async () => 0, syncNow: async () => ({ sent: 0 }) });   // a barra soma a fila da pesquisa sozinha
  render();
}

// Decide a tela: 1 pesquisa aberta → abre direto nela; 2 ou mais → tela de ESCOLHA (cartões); nenhuma → aviso.
function ensureView() {
  if (S.surveyId && !current()) { S.surveyId = null; S.step = 'choose'; }   // a pesquisa foi fechada
  if (!S.surveyId && S.surveys.length === 1) openSurvey(S.surveys[0].id);
  if (!S.surveyId) S.step = 'choose';
}

// abre o formulário: se já respondeu, edita substituindo (mesmo clientId) com as respostas pré-preenchidas (marcador local)
function openSurvey(id) {
  S.surveyId = id; S.errors = {}; S.step = 'form'; S.sentStatus = null;
  const mk = getAnsweredMarker(S.user.id, id);
  S.clientId = mk?.clientId || newClientId(); S.isEdit = !!mk; S.answers = mk ? { ...mk.answers } : {};
}
async function refreshSent() {
  const sv = current(); if (!sv || S.step !== 'thanks') return;
  const q = (await listSurveyQueue(S.user.id)).find(x => x.clientId === S.clientId);
  const st = q?.status || SQ_STATUS.ENVIADO;
  if (st !== S.sentStatus) { S.sentStatus = st; render(); }
}

function render() {
  const el = document.getElementById('app');
  if (!el) return;
  const focusId = document.activeElement?.id;
  el.innerHTML = vPage();
  if (focusId) document.getElementById(focusId)?.focus();
}

function qCard(q, i) {
  const v = S.answers[q.id], err = S.errors[q.id];
  const btn = (on, label, onclick, extra = '') => `<button type="button" onclick="${onclick}" style="flex:1;min-width:3.2rem;padding:.9rem .4rem;border-radius:.9rem;border:2px solid ${on ? '#2D6A2A' : '#e2e8f0'};background:${on ? '#e3f0e2' : '#fff'};font-size:1.05rem;font-weight:800;color:#1e293b;cursor:pointer;${extra}">${label}</button>`;
  let body = '';
  if (q.tipo === 'nota5') body = `<div style="display:flex;gap:.4rem;">${[1, 2, 3, 4, 5].map(n => btn(v === n, `<div style="font-size:1.5rem">${FACES[n - 1]}</div>${n}`, `W.set('${q.id}',${n})`)).join('')}</div>
    <div style="display:flex;justify-content:space-between;font-size:.7rem;color:#94a3b8;margin-top:.25rem;"><span>Péssimo</span><span>Excelente</span></div>`;
  else if (q.tipo === 'simnao') body = `<div style="display:flex;gap:.5rem;">${btn(v === 'sim', '👍 Sim', `W.set('${q.id}','sim')`)}${btn(v === 'nao', '👎 Não', `W.set('${q.id}','nao')`)}</div>`;
  else if (q.tipo === 'escolha') body = `<div style="display:flex;flex-direction:column;gap:.45rem;">${q.opcoes.map((o, k) => `<button type="button" onclick="W.set('${q.id}',${k})" style="text-align:left;padding:.8rem .9rem;border-radius:.9rem;border:2px solid ${v === o ? '#2D6A2A' : '#e2e8f0'};background:${v === o ? '#e3f0e2' : '#fff'};font-size:.95rem;font-weight:${v === o ? 800 : 600};color:#1e293b;cursor:pointer;">${v === o ? '🔘' : '⚪'} ${esc(o)}</button>`).join('')}</div>`;
  else body = `<textarea id="t-${q.id}" rows="4" maxlength="1000" placeholder="Escreva aqui (opcional)…" oninput="W.text('${q.id}',this.value)" style="width:100%;border:2px solid #e2e8f0;border-radius:.9rem;padding:.7rem;font-size:1rem;font-family:inherit;resize:vertical;outline:none;">${esc(v || '')}</textarea>`;
  return `<div id="q-${q.id}" style="background:#fff;border-radius:1rem;border:1.5px solid ${err ? '#ef4444' : '#e2e8f0'};padding:1rem;">
    <div style="font-weight:800;color:#1e293b;font-size:.98rem;margin-bottom:.65rem;">${i + 1}. ${esc(q.texto)}${q.obrigatoria ? ' <span style="color:#dc2626">*</span>' : ''}</div>${body}
    ${err ? `<div style="color:#dc2626;font-size:.78rem;margin-top:.4rem;">${esc(err)}</div>` : ''}</div>`;
}

function vChoose(head) {
  return `<div style="min-height:100dvh;background:#eef6ee;">${head}
    <div style="padding:1rem;max-width:36rem;margin:0 auto;display:flex;flex-direction:column;gap:.8rem;">
      <p style="margin:0;color:#475569;font-size:.9rem;">Há <b>${S.surveys.length} pesquisas abertas</b>. Escolha uma para responder:</p>
      ${S.surveys.map(x => { const done = answered(x.id); return `
      <button type="button" onclick="W.open('${x.id}')" class="sv-card" style="display:flex;align-items:center;gap:.9rem;text-align:left;width:100%;padding:1.1rem 1rem;border-radius:1.1rem;border:2px solid ${done ? '#86b382' : '#D4A017'};background:#fff;cursor:pointer;box-shadow:0 2px 8px rgba(0,0,0,.06);">
        <span style="font-size:2.4rem;line-height:1;">${surveyEmoji(x.titulo)}</span>
        <span style="flex:1;min-width:0;"><span style="display:block;font-weight:800;color:#1e293b;font-size:1.02rem;">${esc(x.titulo)}</span>
          <span style="display:block;color:#64748b;font-size:.82rem;margin-top:.2rem;">${x.perguntas.length} pergunta${x.perguntas.length === 1 ? '' : 's'}</span></span>
        <span class="sv-badge" style="white-space:nowrap;font-size:.74rem;font-weight:800;padding:.3rem .65rem;border-radius:999px;background:${done ? '#dcfce7' : '#fef3c7'};color:${done ? '#166534' : '#92400e'};">${done ? '✅ Respondida neste aparelho' : 'Pendente'}</span>
      </button>`; }).join('')}
    </div></div>`;
}

function vPage() {
  const sv = current();
  const many = S.surveys.length > 1;
  const head = `<div style="background:linear-gradient(135deg,#1d4a1a,#2D6A2A);color:#fff;padding:1rem 1rem 1.25rem;">
    ${many && S.step !== 'choose' ? `<button onclick="W.back()" style="background:none;border:none;padding:0;color:#cfe8ca;font-size:.85rem;cursor:pointer;">← Voltar</button>`
      : `<a href="${portalUrlForUser(S.user)}" style="color:#cfe8ca;font-size:.85rem;text-decoration:none;">← Voltar</a>`}
    <h1 style="font-size:1.25rem;font-weight:800;margin:.35rem 0 .2rem;">📝 Pesquisa de Satisfação</h1>
    <p style="margin:0;font-size:.82rem;color:#e3f0e2;">${sv ? esc(sv.titulo) : ''}</p></div>`;
  if (S.surveys.length >= 2 && S.step === 'choose' && !sv) return vChoose(head);
  if (!sv) return `<div style="min-height:100dvh;background:#eef6ee;">${head}<div style="padding:2rem 1rem;text-align:center;color:#64748b;"><div style="font-size:3rem;">📝</div><p style="font-weight:700;">Nenhuma pesquisa aberta no momento.</p><p style="font-size:.85rem;">Quando o evento abrir uma pesquisa, ela aparece aqui.</p></div></div>`;
  if (S.step === 'thanks') {
    const sent = S.sentStatus === SQ_STATUS.ENVIADO, closed = S.sentStatus === SQ_STATUS.ENCERRADA, bad = S.sentStatus === SQ_STATUS.RECUSADA;
    return `<div style="min-height:100dvh;background:#eef6ee;">${head}<div style="padding:2rem 1rem;max-width:30rem;margin:0 auto;text-align:center;">
      <div style="font-size:3.5rem;">${closed || bad ? '⚠️' : '🙏'}</div>
      <h2 style="font-size:1.35rem;font-weight:800;color:#1e293b;margin:.5rem 0;">${closed ? 'Pesquisa encerrada' : bad ? 'Não foi possível enviar' : 'Obrigado pela sua resposta!'}</h2>
      <p style="color:#475569;font-size:.92rem;">${sent ? 'Sua opinião é anônima e vai nos ajudar a melhorar os próximos eventos.' : closed ? 'Esta pesquisa foi encerrada antes do envio.' : bad ? 'O servidor recusou a resposta. Tente editar e enviar de novo.' : '🕓 Sua resposta está guardada neste aparelho e será enviada sozinha quando a conexão voltar (veja a bolinha 🟡 no canto).'}</p>
      <div style="display:flex;flex-direction:column;gap:.6rem;margin-top:1.25rem;">
        <button onclick="W.edit()" style="padding:.9rem;border-radius:.9rem;border:2px solid #2D6A2A;background:#fff;color:#166534;font-weight:800;font-size:.95rem;cursor:pointer;">✏️ Editar minha resposta</button>
        ${many ? '<button onclick="W.back()" style="padding:.9rem;border-radius:.9rem;border:2px solid #D4A017;background:#fff;color:#92400e;font-weight:800;font-size:.95rem;cursor:pointer;">📝 Ver outras pesquisas</button>' : ''}
        <a href="${portalUrlForUser(S.user)}" style="padding:.9rem;border-radius:.9rem;background:#2D6A2A;color:#fff;font-weight:800;font-size:.95rem;text-decoration:none;">Voltar ao painel</a></div></div></div>`;
  }
  return `<div style="min-height:100dvh;background:#eef6ee;padding-bottom:6rem;">${head}
    <div style="padding:1rem;max-width:36rem;margin:0 auto;display:flex;flex-direction:column;gap:.75rem;">
      <div style="background:#fff;border-radius:1rem;padding:.7rem .9rem;font-size:.8rem;color:#475569;border:1px solid #e2e8f0;">🔒 <b>Anônima</b> — não guardamos seu nome nem seu usuário, só o perfil (${esc(({ counselor: 'Conselheiro', region: 'Região', judge: 'Fiscal' })[S.user.role])})${S.user.role === 'judge' ? '' : ' e a região'}.</div>
      ${S.isEdit ? '<div style="background:#fffbeb;color:#92400e;border-radius:1rem;padding:.7rem .9rem;font-size:.82rem;">✏️ Você já respondeu neste aparelho. Pode alterar e reenviar — a nova resposta <b>substitui</b> a anterior.</div>' : ''}
      ${sv.perguntas.map(qCard).join('')}
    </div>
    <div style="position:fixed;left:0;right:0;bottom:0;z-index:40;background:#fff;border-top:1px solid #e2e8f0;padding:.7rem 1rem;">
      <button onclick="W.submit()" ${S.saving ? 'disabled' : ''} style="width:100%;max-width:36rem;display:block;margin:0 auto;background:#2D6A2A;color:#fff;border:none;padding:1rem;border-radius:.9rem;font-size:1rem;font-weight:800;cursor:pointer;opacity:${S.saving ? .6 : 1};">${S.saving ? '⏳ Enviando…' : S.isEdit ? '📨 Reenviar (substituir)' : '📨 Enviar resposta'}</button></div></div>`;
}

window.W = {
  open(id) { if (S.surveys.some(x => x.id === id)) { openSurvey(id); render(); window.scrollTo?.(0, 0); } },
  back() { S.surveyId = null; S.step = 'choose'; S.sentStatus = null; render(); },
  set(qid, v) {
    const q = current().perguntas.find(x => x.id === qid);
    S.answers[qid] = q.tipo === 'escolha' ? q.opcoes[v] : v;
    delete S.errors[qid]; render();
  },
  text(qid, v) { S.answers[qid] = v; },
  edit() { S.step = 'form'; S.isEdit = true; render(); },
  async submit() {
    const sv = current(); if (!sv || S.saving) return;
    const norm = normalizeAnswers(sv, S.answers);
    if (!norm.ok) {
      S.errors = {};
      for (const q of sv.perguntas) { const one = normalizeAnswers({ perguntas: [q] }, S.answers); if (!one.ok) S.errors[q.id] = one.errors[0]; }
      render();
      document.getElementById(`q-${Object.keys(S.errors)[0]}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      toast('Responda as perguntas obrigatórias.', 'error');
      return;
    }
    S.saving = true; render();
    await enqueueSurveyResponse({ user: S.user, surveyId: sv.id, answers: norm.value, clientId: S.clientId, isEdit: S.isEdit });
    S.isEdit = true;                                        // dali em diante, qualquer novo envio substitui
    await Promise.race([syncSurveyQueue({ manual: true }), new Promise(r => setTimeout(r, 4000))]);
    S.saving = false; S.step = 'thanks'; S.sentStatus = null; await refreshSent(); S.sentStatus ??= SQ_STATUS.PENDENTE; render();
  },
};
