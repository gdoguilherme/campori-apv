// Botão "📝 Pesquisa de Satisfação" dos portais (conselheiro, região, fiscal): pílula flutuante que SÓ aparece quando existe uma
// pesquisa ABERTA (lista ao vivo + cache do aparelho, então também aparece sem rede). Fica fora do #app (que é redesenhado).
import { subOpenSurveys } from './api.js';
import { cacheOpenSurveys, getCachedOpenSurveys } from './surveyQueue.js';

export function mountSurveyButton({ offsetBottom = '3.6rem' } = {}) {
  if (typeof document === 'undefined' || document.getElementById('survey-btn')) return () => {};
  const a = document.createElement('a');
  a.id = 'survey-btn'; a.href = '/pages/pesquisa.html'; a.hidden = true;
  a.textContent = '📝 Pesquisa de Satisfação';
  a.style.cssText = `position:fixed;left:.6rem;bottom:calc(${offsetBottom} + env(safe-area-inset-bottom,0px));z-index:995;background:#D4A017;color:#1e293b;` +
    'text-decoration:none;font:800 .8rem/1 system-ui,sans-serif;padding:.55rem .9rem;border-radius:999px;box-shadow:0 2px 10px rgba(0,0,0,.25);border:1.5px solid #fff;';
  document.body.appendChild(a);
  const show = list => { a.hidden = !(list && list.length); };
  getCachedOpenSurveys().then(show);
  const unsub = subOpenSurveys(list => { cacheOpenSurveys(list); show(list); });
  return () => { unsub?.(); a.remove(); };
}
