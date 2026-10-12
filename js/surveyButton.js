// Botão "📝 Pesquisa de Satisfação" dos portais (conselheiro, região, fiscal): pílula flutuante que SÓ aparece quando existe uma
// pesquisa ABERTA (lista ao vivo + cache do aparelho, então também aparece sem rede). Fica fora do #app (que é redesenhado).
import { subOpenSurveys } from './api.js';
import { cacheOpenSurveys, getCachedOpenSurveys, getAnsweredMarker } from './surveyQueue.js';
import { getSession } from './auth.js';
import { countPendingSurveys, pendingLabel } from '../shared/survey.js';

export function mountSurveyButton({ offsetBottom = '3.6rem' } = {}) {
  if (typeof document === 'undefined' || document.getElementById('survey-btn')) return () => {};
  const a = document.createElement('a');
  a.id = 'survey-btn'; a.href = '/pages/pesquisa.html'; a.hidden = true;
  a.textContent = '📝 Pesquisa de Satisfação';
  a.style.cssText = `position:fixed;left:.6rem;bottom:calc(${offsetBottom} + env(safe-area-inset-bottom,0px));z-index:995;background:#D4A017;color:#1e293b;` +
    'text-decoration:none;font:800 .8rem/1 system-ui,sans-serif;padding:.55rem .9rem;border-radius:999px;box-shadow:0 2px 10px rgba(0,0,0,.25);border:1.5px solid #fff;';
  document.body.appendChild(a);
  let last = [];
  // selo: pesquisas ABERTAS ainda não respondidas NESTE aparelho (marcador local; nada vai ao servidor); some quando todas foram respondidas
  const show = list => {
    last = list || [];
    a.hidden = !last.length;
    const uid = getSession()?.id;
    const n = uid ? countPendingSurveys(last, id => !!getAnsweredMarker(uid, id)) : 0;
    a.textContent = '📝 Pesquisa de Satisfação';
    if (n > 0) {
      const b = document.createElement('span');
      b.className = 'survey-badge'; b.textContent = pendingLabel(n);
      b.style.cssText = 'margin-left:.5rem;background:#b91c1c;color:#fff;font-size:.68rem;padding:.2rem .5rem;border-radius:999px;';
      a.appendChild(b);
    }
  };
  getCachedOpenSurveys().then(show);
  const unsub = subOpenSurveys(list => { cacheOpenSurveys(list); show(list); });
  const refresh = () => show(last);     // voltar da página da pesquisa (ou do cache do navegador) atualiza o selo
  window.addEventListener('pageshow', refresh); document.addEventListener('visibilitychange', refresh); window.addEventListener('focus', refresh);
  return () => { unsub?.(); window.removeEventListener('pageshow', refresh); document.removeEventListener('visibilitychange', refresh); window.removeEventListener('focus', refresh); a.remove(); };
}
