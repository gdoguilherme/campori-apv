// Copia as fotos/comprovações (data/uploads) para uma pasta de backup. Elas ficam SÓ neste PC — copie ao fim do dia.
//   npm run backup-uploads                      → backups/uploads-AAAAMMDD-HHMM/
//   npm run backup-uploads -- E:\               → pen-drive (cria E:\uploads-AAAAMMDD-HHMM\)
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { backupUploads, fmtBytes } from '../src/ops.js';

const config = loadConfig();
const destRoot = process.argv[2] ? path.resolve(process.argv[2]) : config.backupDir;
try {
  const r = backupUploads({ uploadDir: config.uploadDir, destRoot });
  if (r.empty) { console.log(`ℹ️  ${r.message}`); process.exit(0); }
  console.log(`${r.ok ? '✅' : '❌'} ${r.message}\n   Origem:  ${config.uploadDir}\n   Destino: ${r.dest}  (${fmtBytes(r.bytes)})`);
  process.exit(r.ok ? 0 : 2);
} catch (e) {
  console.error(`❌ Não foi possível copiar: ${e.message}`);
  process.exit(1);
}
