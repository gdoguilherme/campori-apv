import fs from 'node:fs';
import path from 'node:path';

// Log em arquivo diário (logs/campori-AAAA-MM-DD.log) + console. Mantém 14 dias.
export function createLogger(logDir, tag) {
  fs.mkdirSync(logDir, { recursive: true });
  prune(logDir);
  const write = (level, msg) => {
    const d = new Date();
    const day = d.toISOString().slice(0, 10);
    const line = `${d.toISOString()} [${tag}] ${level} ${msg}\n`;
    try { fs.appendFileSync(path.join(logDir, `campori-${day}.log`), line); } catch { /* disco cheio etc. */ }
    (level === 'ERROR' ? process.stderr : process.stdout).write(line);
  };
  return { info: m => write('INFO', m), warn: m => write('WARN', m), error: m => write('ERROR', m), raw: m => { for (const l of String(m).split(/\r?\n/)) if (l) write('OUT', l); } };
}

function prune(logDir) {
  const limit = Date.now() - 14 * 86400_000;
  for (const f of fs.readdirSync(logDir)) {
    const p = path.join(logDir, f);
    try { if (f.startsWith('campori-') && fs.statSync(p).mtimeMs < limit) fs.unlinkSync(p); } catch { /* ignora */ }
  }
}
