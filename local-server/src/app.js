import express from 'express';
import cors from 'cors';
import path from 'node:path';
import fs from 'node:fs';
import { createAuth } from './auth.js';
import { usersRouter } from './routes/users.js';
import { qrRouter } from './routes/qr.js';
import { dataRouter } from './routes/data.js';
import { businessRouter } from './routes/business.js';
import { uploadRouter } from './routes/upload.js';
import { syncRouter } from './routes/sync.js';
import { statusRouter } from './routes/status.js';
import { createPageInjector } from './html-inject.js';
import { COLLECTIONS } from './db.js';

export function createApp({ store, config, log, tls = () => null, engine = null, isLocalRequest }) {
  const startedAt = Date.now();
  const auth = createAuth({ store, config });
  const ctx = { store, config, log, auth };
  const app = express();
  app.disable('x-powered-by');

  // CORS: só as páginas do Campori (produção + este servidor) e localhost (desenvolvimento) podem
  // chamar a API a partir do navegador. Sem cabeçalho Origin (curl, mesmo site) passa; origem
  // desconhecida simplesmente não recebe os cabeçalhos CORS (o navegador bloqueia a leitura).
  const allowedOrigin = origin =>
    config.corsOrigins.includes(origin) || /^https?:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(origin);

  // Private Network Access: o Chrome faz um preflight extra quando um site público (https) chama um
  // servidor de rede privada (192.168.x.x) e só segue se a resposta trouxer este cabeçalho.
  // Vem ANTES do cors(), que encerra a resposta do preflight.
  app.use((req, res, next) => {
    if (req.method === 'OPTIONS' && req.headers['access-control-request-private-network'] === 'true' &&
        allowedOrigin(req.headers.origin || '')) {
      res.set('Access-Control-Allow-Private-Network', 'true');
    }
    next();
  });
  app.use(cors({
    origin: (origin, cb) => cb(null, !origin || allowedOrigin(origin) ? (origin || true) : false),
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'Authorization'],
    maxAge: 600,
  }));
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', (_req, res) => {
    res.json({
      ok: true, mode: 'local', version: config.version, pid: process.pid,
      uptime: Math.round(process.uptime()), time: new Date().toISOString(),
      revision: store.revision(),
      counts: Object.fromEntries(COLLECTIONS.map(c => [c, store.count(c)])),
      qrSecretConfigured: !config.qrSecretIsDev,
      https: tls(),   // { enabled, port, validTo, daysLeft, error } — para conferir do celular
      sync: engine ? (({ cloud, push }) => ({ cloud: cloud.state, pending: push.pending.total, lastSuccessAt: push.lastSuccessAt }))(engine.status()) : null,
    });
  });

  // /health: público (sem autenticação), leve — serve ao watchdog, ao app (teste de servidor) e para você abrir no celular
  // API — mesmos caminhos do backend da nuvem (/users, /qr, /upload) + dados e regras locais
  app.use('/users', usersRouter(ctx));
  app.use('/qr', qrRouter(ctx));
  app.use('/upload', uploadRouter(ctx));
  app.use('/data', dataRouter(ctx));
  app.use('/sync', syncRouter({ ...ctx, engine }));
  app.use('/status', statusRouter({ store, config, engine, startedAt, isLocalRequest, tls }));   // painel de status do PC
  app.use('/', businessRouter(ctx));
  // upload sem login (igual à nuvem): sem "adivinhar" tipo, e documentos ativos (html/svg/xml) não executam nada
  app.use('/files', express.static(config.uploadDir, { fallthrough: true, setHeaders: (res, file) => {
    res.set('X-Content-Type-Options', 'nosniff');
    if (/\.(html?|svg|xml|xhtml)$/i.test(file)) res.set('Content-Security-Policy', "sandbox; default-src 'none'");
  } }));

  // Frontend estático (opcional) — SÓ as pastas públicas; nunca a raiz (tem credenciais em server/)
  if (config.frontendDir && fs.existsSync(path.join(config.frontendDir, 'pages'))) {
    const injector = createPageInjector({ vendorDir: config.vendorDir, localAppMode: config.localAppMode, importMapJson: config.importMapJson });

    // Páginas HTML: servidas com as adaptações do modo local (bibliotecas em /vendor, ajuda, import map).
    // A nuvem (Vercel) serve os MESMOS arquivos sem nenhuma delas.
    app.get(/^\/(pages\/.+\.html|index\.html)$/, (req, res, next) => {
      const file = path.join(config.frontendDir, req.path);
      if (!file.startsWith(path.join(config.frontendDir, path.sep)) || !fs.existsSync(file)) return next();
      res.set('Cache-Control', 'no-cache').type('html').send(injector.inject(fs.readFileSync(file, 'utf8'), req.path));
    });

    for (const d of ['css', 'js', 'pages', 'assets', 'shared']) {
      app.use(`/${d}`, express.static(path.join(config.frontendDir, d)));
    }
    if (fs.existsSync(config.vendorDir)) app.use('/vendor', express.static(config.vendorDir, { maxAge: '7d' }));

    // PWA: sw.js e manifest.json precisam estar na RAIZ (escopo "/"), sempre revalidados
    for (const f of ['sw.js', 'manifest.json']) {
      app.get(`/${f}`, (_req, res) => {
        res.set('Cache-Control', 'no-cache');
        if (f === 'manifest.json') res.type('application/manifest+json'); else res.set('Service-Worker-Allowed', '/');
        res.sendFile(path.join(config.frontendDir, f));
      });
    }

    // Raiz abre o app (login); /ajuda: passo a passo curto (Wi-Fi + instalação), pública e offline
    app.get('/', (_req, res) => res.redirect('/pages/login.html'));
    app.get(['/ajuda', '/ajuda.html'], (_req, res) => {
      const hasWifi = !!config.helpWifiName, hasPass = !!config.helpWifiPassword;
      const esc = v => String(v).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
      const html = fs.readFileSync(new URL('./routes/help-page.html', import.meta.url), 'utf8')
        .replace('{{WIFI_STYLE}}', hasWifi ? '' : 'display:none').replace('{{WIFI_NAME}}', esc(config.helpWifiName))
        .replace('{{WIFI_PASS_STYLE}}', hasPass ? '' : 'display:none').replace('{{WIFI_PASSWORD}}', esc(config.helpWifiPassword))
        .replace('{{N_OPEN}}', hasWifi ? '2' : '1').replace('{{N_INSTALL}}', hasWifi ? '3' : '2');
      res.set('Cache-Control', 'no-cache').type('html').send(html);
    });
  }

  app.use((req, _res, next) => next(Object.assign(new Error('Rota não encontrada'), { status: 404 })));
  app.use((err, req, res, _next) => {
    const status = err.status || (err.name === 'MulterError' ? 400 : 500);
    if (status >= 500) log.error(`${req.method} ${req.originalUrl} → ${err.stack || err.message}`);
    res.status(status).json({ error: status >= 500 ? 'Erro interno do servidor' : err.message, ...(err.code ? { code: err.code } : {}) });
  });
  return app;
}
