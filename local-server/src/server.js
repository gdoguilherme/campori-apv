import os from 'node:os';
import { loadConfig, assertNodeVersion } from './config.js';
import { createLogger } from './logger.js';

assertNodeVersion();
const { Store } = await import('./db.js');
const { createApp } = await import('./app.js');
const { startBackups } = await import('./backup.js');
const { startServers } = await import('./https.js');

const config = loadConfig();
const log = createLogger(config.logDir, 'server');

if (!config.qrSecret) {
  log.error('QR_SECRET não configurado no arquivo .env — sem ele os QR Codes impressos não validam. Veja o GUIA-WINDOWS.');
  process.exit(12); // código 12 = configuração faltando (o supervisor não fica reiniciando em loop)
}
if (config.qrSecretIsDev) log.warn('Usando QR_SECRET de DESENVOLVIMENTO — NÃO use no evento.');

const store = new Store(config.dbPath);
startBackups(store, config, log);
let servers = null;
const app = createApp({ store, config, log, tls: () => servers?.tls() ?? null });

try {
  servers = await startServers({ app, config, log });
} catch (e) {
  if (e.code === 'EADDRINUSE') { log.error(`Porta ${config.port} já está em uso.`); process.exit(98); }
  log.error(`Erro no servidor HTTP: ${e.stack || e.message}`); process.exit(1);
}

const ips = Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address);
const tls = servers.tls();
log.info(`Servidor local Campori APV v${config.version} no ar — HTTP :${config.port}${tls.enabled ? ` · HTTPS :${config.httpsPort}` : ' · HTTPS desligado'} — banco ${config.dbPath}`);
console.log('\n  ✅ SERVIDOR LOCAL RODANDO');
console.log(`     Neste PC:      http://localhost:${config.port}`);
if (tls.enabled) {
  const portSuffix = config.httpsPort === 443 ? '' : `:${config.httpsPort}`;
  console.log(`     Celulares:     https://local.gdtmidia.com.br${portSuffix}   (HTTPS ativo, certificado até ${tls.validTo.slice(0, 10)})`);
  console.log(`     Teste rápido:  https://local.gdtmidia.com.br${portSuffix}/health`);
} else {
  console.log('     ⚠️  HTTPS DESLIGADO — o app instalado nos celulares NÃO vai conseguir conectar (veja o log / GUIA-WINDOWS.md)');
  ips.forEach(ip => console.log(`     Celulares (só HTTP, sem PWA): http://${ip}:${config.port}`));
}
console.log('');

// Qualquer erro inesperado: registra e sai — o supervisor sobe de novo em segundos
for (const ev of ['uncaughtException', 'unhandledRejection']) {
  process.on(ev, e => { log.error(`${ev}: ${e?.stack || e}`); process.exit(1); });
}
const shutdown = sig => { log.info(`Recebido ${sig}, encerrando...`); servers.close().then(() => { try { store.close(); } catch {} process.exit(0); }); setTimeout(() => process.exit(0), 3000).unref(); };
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
