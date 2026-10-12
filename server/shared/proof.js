// Comprovações (fotos/PDF): no evento ficam SOMENTE no PC (data/uploads) — nada vai ao Drive.
// A submission guarda o caminho RELATIVO ("/files/<região>/<arquivo>"), que vale em qualquer endereço do servidor local
// (https://local.gdtmidia.com.br ou o IP). Na nuvem esse caminho não abre nada: mostramos "foto disponível apenas no PC do evento".
// Módulo PURO (sem DOM/Node), usado pelo front e testado no local-server.

const LOCAL_HOST = /^(localhost|127\.\d+\.\d+\.\d+|\[::1\]|10\.\d+\.\d+\.\d+|192\.168\.\d+\.\d+|172\.(1[6-9]|2\d|3[01])\.\d+\.\d+|local\.gdtmidia\.com\.br)$/i;

// '/files/R1/foto.jpg' para uploads do servidor local (relativos OU absolutos antigos de host local); senão null
export function localProofPath(url) {
  if (typeof url !== 'string') return null;
  const u = url.trim();
  if (/^\/files\/[^?#]+/.test(u)) return u.replace(/[?#].*$/, '');
  try {
    const p = new URL(u);
    if (/^\/files\/./.test(p.pathname) && LOCAL_HOST.test(p.hostname)) return p.pathname;
  } catch { /* não é URL absoluta */ }
  return null;
}

export function proofFileName(url) {
  const p = localProofPath(url);
  if (!p) return null;
  try { return decodeURIComponent(p.split('/').pop()); } catch { return p.split('/').pop(); }
}

// → { kind: 'none' } | { kind: 'remote', src } | { kind: 'local', src, name } | { kind: 'pc-only', name }
//   isLocalApp: a página foi aberta pelo servidor local (consegue abrir /files); origin: location.origin
export function resolveProof(url, { isLocalApp = false, origin = '' } = {}) {
  if (!url) return { kind: 'none' };
  const p = localProofPath(url);
  if (!p) return { kind: 'remote', src: url };
  const name = proofFileName(url);
  return isLocalApp ? { kind: 'local', src: `${origin}${p}`, name } : { kind: 'pc-only', name };
}
