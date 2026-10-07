import express from 'express';
import os from 'node:os';
import crypto from 'node:crypto';
import { buildSummary } from '../sync/status.js';
import { statusPageHtml } from './status-page.js';

// Painel de status do PC (pessoas não técnicas). A página em si é pública (não contém dados);
// os DADOS (/status/api/*) só saem no próprio PC ou com o PIN (STATUS_PIN no .env).
export function statusRouter({ store, config, engine, startedAt, isLocalRequest }) {
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
  r.get('/api/summary', guard, (_req, res) => res.json(buildSummary({ store, config, engine, startedAt })));
  r.post('/api/ping', guard, (_req, res) => res.json({ ok: true, local: isLocal(_req) }));   // o PIN digitado está certo?
  r.post('/api/ack', guard, (_req, res) => res.json({ ok: true, acknowledged: store.ackAlerts() }));

  // "Sincronizar agora": envia e (Etapa 2) traz. Responde com o resultado e o MOTIVO se falhar.
  r.post('/api/sync-now', guard, async (_req, res, next) => {
    try {
      if (!engine) return res.json({ ok: false, message: 'Sincronização indisponível neste servidor.' });
      const result = await engine.syncNow({ manual: true });
      res.json({ ...result, summary: buildSummary({ store, config, engine, startedAt }) });
    } catch (e) { next(e); }
  });
  return r;
}
