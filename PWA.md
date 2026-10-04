# PWA — app instalável e abertura offline (Fase 2)

O sistema é instalável ("Adicionar à tela inicial") e **abre e renderiza sem rede** depois
de ter sido aberto uma vez com internet. Dados (Firestore, API, uploads) **não** são
cacheados — sem rede as telas abrem, mas listas/pontuações ficam vazias ou com erro de rede.

## Peças
| Arquivo | Papel |
|---|---|
| `manifest.json` | Nome, cores ÍNTEGROS (`#0D2B6E`), `display: standalone`, ícones |
| `sw.js` | Service worker. Precache do app shell + CDNs; stale-while-revalidate (HTML/JS/CSS/logos, Tailwind) e cache-first (Firebase SDK, html5-qrcode, qrcodejs, xlsx — versionados) |
| `js/pwa.js` | Registra o SW e mostra o convite de instalação (Android: botão "Instalar"; iPhone: passo a passo) |
| `assets/pwa/` | Ícones 192/512, maskable e apple-touch (fundo azul opaco — iOS não aceita transparência) |
| `scripts/build-sw.mjs` | Gera a lista de arquivos + `VERSION` (hash) dentro do `sw.js` |

## ⚠️ ANTES DE CADA DEPLOY
```bash
node scripts/build-sw.mjs      # regenera lista/versão do cache no sw.js
git add sw.js && git commit ... && vercel --prod --yes
```
Sem isso o `sw.js` fica com a lista antiga (arquivos novos não entram no cache offline).
A versão muda sozinha quando qualquer arquivo do shell muda; o celular atualiza o cache na
próxima abertura com internet.

## Como testar no celular (precisa de HTTPS → use o domínio de produção)
Service worker e instalação só funcionam em **HTTPS** (ou localhost). O IP da rede local
(`http://192.168.x.x`) **não** instala/offline — ver "Pendência" abaixo.

**Android (Chrome):**
1. Abra `https://campori.gdtmidia.com.br` com internet e espere o login carregar (~5 s).
2. Aparece o convite "Instale o app ÍNTEGROS" → **Instalar** (ou menu ⋮ → *Instalar app*).
3. O ícone do brasão aparece na tela inicial. Abra por ele: deve abrir em tela cheia, sem barra.
4. **Desligue Wi-Fi e dados**, feche o app (deslizar para fora) e abra de novo pelo ícone → abre.

**iPhone (Safari — tem que ser o Safari):**
1. Abra o site, toque em **Compartilhar** → **Adicionar à Tela de Início**.
2. Abra pelo ícone (tela cheia). Depois desligue a rede, force-feche e abra de novo.

Diagnóstico (Chrome desktop/Android remoto): no console, `await __pwaStatus()` →
`{cached: 34, missing: []}` = tudo em cache.

## Desenvolvimento
O SW responde com cache primeiro (stale-while-revalidate): em `localhost` você pode ver a
versão anterior de um arquivo no 1º reload. Para limpar:
```js
for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
for (const k of await caches.keys()) await caches.delete(k);
```

## Pendências conhecidas (para as próximas fases)
1. **Sessão some ao fechar o app.** `js/auth.js` guarda a sessão em `sessionStorage`; ao
   fechar/reabrir o app o conselheiro cai no login, e **logar exige rede/servidor**. Em campo
   sem sinal isso é um problema real → mover para `localStorage` (mantendo o TTL de 8 h).
2. **HTTPS vs servidor local.** O PWA instalado vem de `https://…`; o navegador **bloqueia**
   chamadas dele para `http://IP-local` (mixed content), e a página em `http://IP-local` não
   pode registrar service worker. Precisa decidir (Fase 3/4): certificado HTTPS válido para o
   servidor local (ex.: subdomínio `local.gdtmidia.com.br` apontando para o IP da LAN +
   certificado Let's Encrypt via DNS-01 instalado no PC do evento).
