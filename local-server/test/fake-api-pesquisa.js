// Stubs para testar a página da pesquisa e o botão dos portais SEM rede: lista de pesquisas abertas controlada pelo teste.
export const hub = { cb: null, calls: [], push(list) { hub.cb?.(list); } };
export const subOpenSurveys = cb => { hub.cb = cb; return () => { hub.cb = null; }; };   // offline: nunca chama o cb sozinho
export const toast = () => {};
export const submitSurveyResponse = async args => { hub.calls.push(args); return { id: 'r', result: 'created' }; };
export const mountPortalBar = () => () => {};
export const fakeFirebase = {};
