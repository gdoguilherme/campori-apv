import os from 'node:os';
import { loadConfig, assertNodeVersion } from './config.js';
import { createLogger } from './logger.js';

assertNodeVersion();
const { Store } = await import('./db.js');
const { createApp } = await import('./app.js');
const { startBackups } = await import('./backup.js');

const config = loadConfig();
const log = createLogger(config.logDir, 'server');

if (!config.qrSecret) {
  log.error('QR_SECRET não configurado no arquivo .env — sem ele os QR Codes impressos não validam. Veja o GUIA-WINDOWS.');
  process.exit(12); // código 12 = configuração faltando (o supervisor não fica reiniciando em loop)
}
if (config.qrSecretIsDev) log.warn('Usando QR_SECRET de DESENVOLVIMENTO — NÃO use no evento.');

const store = new Store(config.dbPath);
startBackups(store, config, log);
const app = createApp({ store, config, log });

const server = app.listen(config.port, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
  log.info(`Servidor local Campori APV v${config.version} no ar — porta ${config.port} — banco ${config.dbPath}`);
  console.log('\n  ✅ SERVIDOR LOCAL RODANDO');
  console.log(`     Neste PC:      http://localhost:${config.port}`);
  ips.forEach(ip => console.log(`     Nos celulares: http://${ip}:${config.port}`));
  console.log('');
});

server.on('error', e => {
  if (e.code === 'EADDRINUSE') { log.error(`Porta ${config.port} já está em uso.`); process.exit(98); }
  log.error(`Erro no servidor HTTP: ${e.stack || e.message}`); process.exit(1);
});

// Qualquer erro inesperado: registra e sai — o supervisor sobe de novo em segundos
for (const ev of ['uncaughtException', 'unhandledRejection']) {
  process.on(ev, e => { log.error(`${ev}: ${e?.stack || e}`); process.exit(1); });
}
const shutdown = sig => { log.info(`Recebido ${sig}, encerrando...`); server.close(() => { try { store.close(); } catch {} process.exit(0); }); setTimeout(() => process.exit(0), 3000).unref(); };
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
