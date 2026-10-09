// Operação do evento no PC: tamanho dos uploads, backup das fotos, espaço em disco, contagens.
// Funções puras de disco (sem Express) — usadas pelo painel /status e pelos scripts (backup-uploads, preflight).
import fs from 'node:fs';
import path from 'node:path';

export function dirStats(dir) {
  let count = 0, bytes = 0;
  const walk = d => {
    let entries = [];
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }   // pasta ilegível não derruba o painel
    for (const e of entries) {
      const p = path.join(d, e.name);
      try {
        if (e.isDirectory()) walk(p);
        else if (e.isFile()) { count++; bytes += fs.statSync(p).size; }
      } catch { /* arquivo sumiu/ilegível no meio da contagem */ }
    }
  };
  if (!dir || !fs.existsSync(dir)) return { exists: false, count: 0, bytes: 0 };
  walk(dir);
  return { exists: true, count, bytes };
}

// O painel atualiza a cada 4 s: não varre o disco toda vez (cache curto)
const _cache = new Map();
export function cachedDirStats(dir, ttlMs = 15_000, now = Date.now()) {
  const c = _cache.get(dir);
  if (c && now - c.at < ttlMs) return c.v;
  const v = dirStats(dir); _cache.set(dir, { at: now, v });
  return v;
}

export const stamp = (d = new Date()) => {
  const z = n => String(n).padStart(2, '0');
  return `${d.getFullYear()}${z(d.getMonth() + 1)}${z(d.getDate())}-${z(d.getHours())}${z(d.getMinutes())}`;
};

// Copia data/uploads → <destRoot>/uploads-AAAAMMDD-HHMM/ e CONFERE (mesmo nº de arquivos e bytes). Nunca apaga a origem.
export function backupUploads({ uploadDir, destRoot, now = new Date() }) {
  if (!fs.existsSync(uploadDir)) return { ok: true, empty: true, files: 0, bytes: 0, dest: null, message: 'Ainda não há fotos em data/uploads — nada a copiar.' };
  const src = dirStats(uploadDir);
  let dest = path.join(destRoot, `uploads-${stamp(now)}`);
  for (let i = 2; fs.existsSync(dest); i++) dest = path.join(destRoot, `uploads-${stamp(now)}-${i}`); // dois backups no mesmo minuto não se misturam
  fs.mkdirSync(destRoot, { recursive: true });
  if (path.resolve(dest).startsWith(path.resolve(uploadDir) + path.sep)) throw new Error('O destino não pode ficar dentro de data/uploads.');
  fs.cpSync(uploadDir, dest, { recursive: true, errorOnExist: true, force: false });
  const out = dirStats(dest);
  const ok = out.count === src.count && out.bytes === src.bytes;
  return { ok, files: out.count, bytes: out.bytes, dest, message: ok ? `${out.count} arquivo(s) copiados e conferidos.` : `ATENÇÃO: a cópia não confere (origem ${src.count} arq./${src.bytes} bytes, cópia ${out.count} arq./${out.bytes} bytes).` };
}

export function diskFree(dir) {
  try {
    const target = fs.existsSync(dir) ? dir : path.dirname(dir);
    const s = fs.statfsSync(target);
    return { freeBytes: Number(s.bavail) * Number(s.bsize), totalBytes: Number(s.blocks) * Number(s.bsize) };
  } catch { return null; }
}

export const fmtBytes = n => (n >= 1073741824 ? `${(n / 1073741824).toFixed(1)} GB` : n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);
