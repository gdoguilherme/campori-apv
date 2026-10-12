import fs from 'node:fs';
import path from 'node:path';

// Cópia consistente do banco (VACUUM INTO) a cada N minutos; guarda as últimas 48.
export function startBackups(store, config, log) {
  const run = () => {
    try {
      const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
      store.backupTo(path.join(config.backupDir, `campori-${stamp}.db`));
      const files = fs.readdirSync(config.backupDir).filter(f => f.endsWith('.db')).sort();
      files.slice(0, Math.max(0, files.length - 48)).forEach(f => fs.unlinkSync(path.join(config.backupDir, f)));
    } catch (e) { log.error(`Falha no backup: ${e.message}`); }
  };
  run();
  if (config.backupEveryMin <= 0) return null;
  const t = setInterval(run, config.backupEveryMin * 60_000);
  t.unref();
  return t;
}
