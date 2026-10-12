// Páginas servidas PELO SERVIDOR LOCAL recebem pequenas adaptações (a nuvem/Vercel serve os mesmos arquivos SEM elas):
//   • bibliotecas de CDN (Tailwind, xlsx, qrcodejs, html5-qrcode) → cópias em /vendor (app abre sem internet);
//   • link/botão de ajuda na tela de login (/ajuda);
//   • (etapa 1) import map que troca a camada de dados do Firestore pela do servidor local.
import fs from 'node:fs';
import path from 'node:path';

// URL do CDN → arquivo em vendor/. Só reescreve se o arquivo existir (nunca quebra a página).
export const VENDOR_MAP = [
  [/https:\/\/cdn\.tailwindcss\.com\/?/, 'tailwindcss-3.4.17.js'],
  [/https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/xlsx\/0\.18\.5\/xlsx\.full\.min\.js/, 'xlsx.full.min.js'],
  [/https:\/\/cdnjs\.cloudflare\.com\/ajax\/libs\/qrcodejs\/1\.0\.0\/qrcode\.min\.js/, 'qrcode.min.js'],
  [/https:\/\/unpkg\.com\/html5-qrcode@2\.3\.8\/html5-qrcode\.min\.js/, 'html5-qrcode.min.js'],
];

const HELP_PILL = `<script>document.addEventListener('DOMContentLoaded',function(){var a=document.createElement('a');a.href='/ajuda';a.textContent='ℹ️ Ajuda';
a.style.cssText='position:fixed;top:.6rem;right:.6rem;z-index:900;background:rgba(255,255,255,.92);color:#0D2B6E;font:700 .78rem system-ui,sans-serif;padding:.35rem .7rem;border-radius:999px;text-decoration:none;box-shadow:0 2px 8px rgba(0,0,0,.25)';document.body.appendChild(a);});</script>`;

export function createPageInjector({ vendorDir, localAppMode = false, importMapJson = null }) {
  const available = new Map(VENDOR_MAP.filter(([, file]) => vendorDir && fs.existsSync(path.join(vendorDir, file))));

  function inject(html, pathname) {
    // 1) bibliotecas externas → /vendor (só nos atributos src="...")
    let out = html.replace(/(\bsrc=)(["'])(https:\/\/[^"']+)\2/gi, (m, attr, q, url) => {
      for (const [re, file] of VENDOR_MAP) if (available.has(re) && re.test(url) && url.replace(re, '') === '') return `${attr}${q}/vendor/${file}${q}`;
      return m;
    });
    // 2) o que vai logo no começo do <head> (import map precisa vir ANTES de qualquer script de módulo)
    let head = '<link rel="help" href="/ajuda">';
    if (localAppMode && importMapJson) head = `<script>window.__CAMPORI_LOCAL_APP=1</script><script type="importmap">${importMapJson}</script><script src="/js/compat.js"></script>` + head;
    if (/\/login\.html$/.test(pathname)) head += HELP_PILL;
    out = /<head[^>]*>/i.test(out) ? out.replace(/<head[^>]*>/i, m => `${m}\n  ${head}`) : head + out;
    return out;
  }
  return { inject, vendorFiles: [...available.values()] };
}
