import express from 'express';
import os from 'node:os';
import crypto from 'node:crypto';
import { buildSummary } from '../sync/status.js';
import { statusPageHtml } from './status-page.js';
import fs from 'node:fs';
import path from 'node:path';
import { stamp } from '../ops.js';

// Painel de status do PC (pessoas não técnicas). A página em si é pública (não contém dados);
// os DADOS (/status/api/*) só saem no próprio PC ou com o PIN (STATUS_PIN no .env).
export function statusRouter({ store, config, engine, startedAt, isLocalRequest, tls = () => null }) {
  const r = express.Router();

  // "No próprio PC" = conexão vinda do loopback OU de um IP da própria máquina (ex: acessou por https://local.gdtmidia.com.br)
  const isLocal = isLocalRequest || (req => {
    const a = (req.socket.remoteAddress || '').replace(/^::ffff:/, '');
    if (a === '127.0.0.1' || a === '::1') return true;
    return Object.values(os.networkInterfaces()).flat().some(i => i && i.address === a);
  });

  // PIN: comparação em tempo constante + limite de tentativas por IP (5 erros/min → bloqueia 1 min)
  const fails = new Map();
  const samePin = given => {
    const a = crypto.createHash('sha256').update(String(given ?? '')).digest(), b = crypto.createHash('sha256').update(config.statusPin).digest();
    return crypto.timingSafeEqual(a, b);
  };
  function guard(req, res, next) {
    if (isLocal(req)) return next();
    if (!config.statusPin) return res.status(403).json({ error: 'Para abrir o painel de outro aparelho, defina STATUS_PIN no .env do servidor.', code: 'PIN_NOT_CONFIGURED' });
    const ip = req.socket.remoteAddress || '?', f = fails.get(ip);
    if (f && f.count >= 5 && Date.now() - f.at < 60_000) return res.status(429).json({ error: 'Muitas tentativas. Aguarde 1 minuto.', code: 'PIN_LOCKED' });
    if (samePin(req.headers['x-status-pin'])) { fails.delete(ip); return next(); }
    if (req.headers['x-status-pin']) fails.set(ip, { count: (f && Date.now() - f.at < 60_000 ? f.count : 0) + 1, at: Date.now() });
    return res.status(401).json({ error: 'PIN necessário', code: 'PIN_REQUIRED' });
  }

  r.get('/', (_req, res) => { res.set('Cache-Control', 'no-store'); res.type('html').send(statusPageHtml()); });
  r.get('/api/summary', guard, (_req, res) => res.json(buildSummary({ store, config, engine, startedAt, tls: tls() })));
  r.post('/api/ping', guard, (_req, res) => res.json({ ok: true, local: isLocal(_req) }));   // o PIN digitado está certo?
  r.post('/api/ack', guard, (_req, res) => res.json({ ok: true, acknowledged: store.ackAlerts() }));

  // "Sincronizar agora": envia e (Etapa 2) traz. Responde com o resultado e o MOTIVO se falhar.
  r.post('/api/sync-now', guard, async (_req, res, next) => {
    try {
      if (!engine) return res.json({ ok: false, message: 'Sincronização indisponível neste servidor.' });
      const result = await engine.syncNow({ manual: true });
      res.json({ ...result, summary: buildSummary({ store, config, engine, startedAt, tls: tls() }) });
    } catch (e) { next(e); }
  });

  // "Atualizar dados da nuvem": só traz (não envia). Responde com o resultado e o motivo se falhar.
  r.post('/api/pull-now', guard, async (_req, res, next) => {
    try {
      if (!engine) return res.json({ ok: false, message: 'Sincronização indisponível neste servidor.' });
      const result = await engine.pullNow();
      res.json({ ...result, summary: buildSummary({ store, config, engine, startedAt, tls: tls() }) });
    } catch (e) { next(e); }
  });

  // "Baixar backup agora": gera um backup consistente do banco (VACUUM INTO), guarda em backups/ e entrega o arquivo.
  r.get('/api/backup', guard, (_req, res, next) => {
    try {
      fs.mkdirSync(config.backupDir, { recursive: true });
      const name = `campori-${stamp()}-manual.db`;
      const file = path.join(config.backupDir, name);
      store.backupTo(file);
      res.set('Cache-Control', 'no-store');
      res.download(file, name, err => { if (err && !res.headersSent) next(err); });
    } catch (e) { next(e); }
  });
  return r;
}
