// Aviso de aparelho NÃO compatível com o modo local (precisa de "import maps": Chrome/Android ≥ 89, iOS Safari ≥ 16.4).
// Script CLÁSSICO (roda mesmo se os módulos falharem), injetado pelo servidor local no <head> das páginas que serve.
// Sem suporte, o app cairia no Firestore (internet) em vez de usar o servidor local → avisamos com instruções claras.
(function (root) {
  'use strict';
  function parse(ua) {
    ua = String(ua || '');
    var ios = /iPhone|iPad|iPod/i.test(ua);
    var m;
    var iosVer = ios && (m = ua.match(/OS (\d+)[_.](\d+)/)) ? [Number(m[1]), Number(m[2])] : null;
    var chrome = !ios && (m = ua.match(/(?:Chrome|CriOS)\/(\d+)/)) ? Number(m[1]) : null;
    var firefox = !ios && (m = ua.match(/Firefox\/(\d+)/)) ? Number(m[1]) : null;
    return { ios: ios, iosVer: iosVer, chrome: chrome, firefox: firefox, android: /Android/i.test(ua) };
  }
  // Suporte a import maps: teste direto quando o navegador sabe responder; senão, pela versão no User-Agent.
  function supportsImportMaps(ua, scriptCtor) {
    if (scriptCtor && typeof scriptCtor.supports === 'function') return !!scriptCtor.supports('importmap');
    var p = parse(ua);
    if (p.ios) return !!p.iosVer && (p.iosVer[0] > 16 || (p.iosVer[0] === 16 && p.iosVer[1] >= 4));
    if (p.chrome) return p.chrome >= 89;
    if (p.firefox) return p.firefox >= 108;
    return false;
  }
  function advice(ua) {
    var p = parse(ua);
    if (p.ios) return { title: 'Atualize o iPhone/iPad', text: 'Este aparelho precisa do iOS 16.4 ou mais novo para usar o app com o servidor do evento. Vá em Ajustes › Geral › Atualização de Software. Se não for possível, peça a um colega com aparelho mais novo para lançar por você.' };
    if (p.android || p.chrome) return { title: 'Atualize o navegador', text: 'Seu navegador está desatualizado. Atualize o Google Chrome na Play Store (versão 89 ou mais nova) e abra o app de novo.' };
    return { title: 'Use o Google Chrome', text: 'Este navegador pode não funcionar com o servidor do evento. Abra o endereço no Google Chrome atualizado (celular ou computador).' };
  }
  var api = { parse: parse, supportsImportMaps: supportsImportMaps, advice: advice };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.__camporiCompat = api;

  // Só avisa em páginas servidas pelo servidor local (o servidor injeta esta flag) e quando o aparelho NÃO suporta
  if (!root.__CAMPORI_LOCAL_APP || !root.document || !root.navigator) return;
  var ua = root.navigator.userAgent;
  if (supportsImportMaps(ua, root.HTMLScriptElement)) return;
  var a = advice(ua);
  function show() {
    if (root.document.getElementById('compat-warning')) return;
    var el = root.document.createElement('div');
    el.id = 'compat-warning';
    el.setAttribute('role', 'alert');
    el.style.cssText = 'position:fixed;left:0;right:0;top:0;z-index:1000;background:#b91c1c;color:#fff;padding:.8rem 1rem;font:600 .85rem/1.35 system-ui,sans-serif;box-shadow:0 4px 20px rgba(0,0,0,.35)';
    el.innerHTML = '<div style="font-weight:800;font-size:.95rem;margin-bottom:.2rem">⚠️ ' + a.title + '</div><div>' + a.text + '</div>' +
      '<div style="margin-top:.35rem;opacity:.9">Sem isso o app tentará usar a internet e pode não abrir no evento. <a href="/ajuda" style="color:#fff;text-decoration:underline">Ver ajuda</a></div>';
    root.document.body.appendChild(el);
  }
  if (root.document.readyState === 'loading') root.document.addEventListener('DOMContentLoaded', show); else show();
})(typeof window !== 'undefined' ? window : globalThis);
