// Watchdog: sobe o servidor, reinicia se ele cair (crash) ou travar (não responde ao /health).
// Sai com código 10 se já houver outro servidor rodando (evita duplo-clique duplicado) e
// 11/12 para erros de configuração (Node antigo / QR_SECRET ausente) — nesses casos o
// INICIAR.bat mostra a mensagem e espera, em vez de ficar reiniciando em loop.
import { spawn } from 'node:child_process';
import path from 'node:path';
import { loadConfig, assertNodeVersion, ROOT } from './config.js';
import { createLogger } from './logger.js';

assertNodeVersion();
const config = loadConfig();
const log = createLogger(config.logDir, 'watchdog');
const HEALTH_URL = `http://127.0.0.1:${config.port}/health`;
const GRACE_MS = 20_000, CHECK_EVERY_MS = 10_000, MAX_FAILS = 3, STABLE_MS = 60_000;

let child = null, failures = 0, startedAt = 0, healthFails = 0, stopping = false;

async function healthy() {
  try {
    const r = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(4000) });
    return r.ok;
  } catch { return false; }
}

async function start() {
  if (stopping) return;
  startedAt = Date.now(); healthFails = 0;
  log.info('Iniciando servidor...');
  child = spawn(process.execPath, [path.join(ROOT, 'src', 'server.js')], { cwd: ROOT, stdio: ['ignore', 'pipe', 'pipe'] });
  child.stdout.on('data', d => process.stdout.write(d));
  child.stderr.on('data', d => process.stderr.write(d));

  child.on('exit', async (code, signal) => {
    child = null;
    if (stopping) return;
    const upFor = Date.now() - startedAt;
    log.warn(`Servidor parou (código ${code}, sinal ${signal}) após ${Math.round(upFor / 1000)}s.`);
    if (code === 11 || code === 12) {
      log.error(code === 12 ? 'Falta configurar o QR_SECRET no arquivo .env.' : 'Versão do Node.js incompatível.');
      process.exit(code);
    }
    if (code === 98 && await healthy()) {
      console.log('\n  ℹ️  O servidor JÁ ESTÁ RODANDO em outra janela. Pode fechar esta.\n');
      process.exit(10);
    }
    failures = upFor > STABLE_MS ? 1 : failures + 1;
    const delay = Math.min(10_000, 1000 * 2 ** Math.min(failures - 1, 4));
    log.info(`Reiniciando em ${delay / 1000}s (falha consecutiva nº ${failures})...`);
    setTimeout(start, delay);
  });
}

// Servidor "vivo mas travado": 3 falhas seguidas de /health → mata; o handler de exit religa.
setInterval(async () => {
  if (!child || Date.now() - startedAt < GRACE_MS) return;
  if (await healthy()) { healthFails = 0; return; }
  if (++healthFails >= MAX_FAILS) {
    log.error('Servidor não responde ao /health — forçando reinício.');
    healthFails = 0;
    child.kill('SIGKILL');
  }
}, CHECK_EVERY_MS);

const stop = sig => {
  stopping = true; log.info(`Watchdog recebeu ${sig}, encerrando.`);
  if (child) { child.once('exit', () => process.exit(0)); child.kill('SIGTERM'); setTimeout(() => process.exit(0), 4000); }
  else process.exit(0);
};
process.on('SIGINT', () => stop('SIGINT'));
process.on('SIGTERM', () => stop('SIGTERM'));

console.log('\n  Campori APV — servidor local com reinício automático (watchdog)');
console.log('  Para parar: feche esta janela ou pressione Ctrl+C.\n');
start();
