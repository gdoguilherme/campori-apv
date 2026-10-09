// Classifica erros de chamadas à nuvem. A diferença importa: erro de REDE (Starlink caiu) só pausa e
// tenta de novo depois; erro de um item (dado inválido, permissão) é registrado nele e NÃO trava os demais.
export class TimeoutError extends Error {
  constructor(message = 'Tempo esgotado ao falar com a nuvem') { super(message); this.name = 'TimeoutError'; }
}

const NETWORK_CODES = new Set([1, 4, 14, 'unavailable', 'deadline-exceeded', 'cancelled', 'aborted',
  'ENOTFOUND', 'ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'EAI_AGAIN', 'ENETUNREACH', 'EHOSTUNREACH', 'EPIPE', 'ECONNABORTED']);
const NETWORK_RE = /UNAVAILABLE|DEADLINE_EXCEEDED|getaddrinfo|socket hang up|GOAWAY|ECONNRESET|ENOTFOUND|network|Total timeout|timed? ?out|Could not reach|EAI_AGAIN/i;

// → 'network' | 'quota' | 'auth' | 'other'
export function classifyError(e) {
  if (!e) return 'other';
  if (e instanceof TimeoutError || e.name === 'TimeoutError') return 'network';
  if (e.code === 8 || e.code === 'resource-exhausted' || /RESOURCE_EXHAUSTED|quota/i.test(e.message || '')) return 'quota';
  if (e.code === 16 || e.code === 'unauthenticated' || /UNAUTHENTICATED|invalid_grant|Invalid JWT|account not found/i.test(e.message || '')) return 'auth';
  if (NETWORK_CODES.has(e.code) || NETWORK_RE.test(e.message || '')) return 'network';
  return 'other';
}
export const isNetworkError = e => classifyError(e) === 'network';

// Prazo para qualquer operação que dependa da nuvem. Se estourar, a operação original pode
// ainda terminar "por baixo dos panos" — por isso todo envio é idempotente.
export function withTimeout(promise, ms, label = 'operação') {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, rej) => { timer = setTimeout(() => rej(new TimeoutError(`Tempo esgotado (${Math.round(ms / 1000)}s) — ${label}`)), ms); }),
  ]).finally(() => clearTimeout(timer));
}
