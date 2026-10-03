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
import { COLLECTIONS } from './db.js';

export function createApp({ store, config, log }) {
  const auth = createAuth({ store, config });
  const ctx = { store, config, log, auth };
  const app = express();
  app.disable('x-powered-by');

  app.use(cors()); // rede local do evento; a autorização é por token Bearer
  app.use(express.json({ limit: '2mb' }));

  app.get('/health', (_req, res) => {
    res.json({
      ok: true, mode: 'local', version: config.version, pid: process.pid,
      uptime: Math.round(process.uptime()), time: new Date().toISOString(),
      revision: store.revision(),
      counts: Object.fromEntries(COLLECTIONS.map(c => [c, store.count(c)])),
      qrSecretConfigured: !config.qrSecretIsDev,
    });
  });

  // API — mesmos caminhos do backend da nuvem (/users, /qr, /upload) + dados e regras locais
  app.use('/users', usersRouter(ctx));
  app.use('/qr', qrRouter(ctx));
  app.use('/upload', uploadRouter(ctx));
  app.use('/data', dataRouter(ctx));
  app.use('/', businessRouter(ctx));
  app.use('/files', express.static(config.uploadDir, { fallthrough: true }));

  // Frontend estático (opcional) — SÓ as pastas públicas; nunca a raiz (tem credenciais em server/)
  if (config.frontendDir && fs.existsSync(path.join(config.frontendDir, 'pages'))) {
    for (const d of ['css', 'js', 'pages', 'assets', 'shared']) {
      app.use(`/${d}`, express.static(path.join(config.frontendDir, d)));
    }
    app.get('/', (_req, res) => res.redirect('/pages/login.html'));
  }

  app.use((req, _res, next) => next(Object.assign(new Error('Rota não encontrada'), { status: 404 })));
  app.use((err, req, res, _next) => {
    const status = err.status || (err.name === 'MulterError' ? 400 : 500);
    if (status >= 500) log.error(`${req.method} ${req.originalUrl} → ${err.stack || err.message}`);
    res.status(status).json({ error: status >= 500 ? 'Erro interno do servidor' : err.message, ...(err.code ? { code: err.code } : {}) });
  });
  return app;
}
