// Copia (UMA VEZ, antes do evento) os dados da nuvem (Firestore) para o banco local.
// SOMENTE LEITURA na nuvem. Sobrescreve as coleções locais — por isso exige --yes.
//   npm run pull-cloud -- --dry-run   → só mostra quantos documentos existem na nuvem
//   npm run pull-cloud -- --yes       → faz backup do banco local e importa tudo
// Credenciais: arquivo JSON da service account em FIREBASE_CREDENTIALS_FILE, ou
// ../server/campori-apv-firebase-adminsdk.json (padrão do projeto).
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { loadConfig, REPO_ROOT } from '../src/config.js';
import { Store, COLLECTIONS } from '../src/db.js';

const dry = process.argv.includes('--dry-run');
if (!dry && !process.argv.includes('--yes')) {
  console.error('\nIsto SUBSTITUI os dados locais pelos da nuvem. Rode com --dry-run para ver o que viria, ou --yes para confirmar.\n');
  process.exit(1);
}

let admin;
try { admin = createRequire(import.meta.url)('firebase-admin'); }
catch { console.error('\nfirebase-admin não instalado. Rode:  npm install firebase-admin\n'); process.exit(1); }

const credFile = process.env.FIREBASE_CREDENTIALS_FILE || path.join(REPO_ROOT, 'server', 'campori-apv-firebase-adminsdk.json');
if (!fs.existsSync(credFile)) { console.error(`\nArquivo de credenciais não encontrado: ${credFile}\nDefina FIREBASE_CREDENTIALS_FILE.\n`); process.exit(1); }
admin.initializeApp({ credential: admin.credential.cert(JSON.parse(fs.readFileSync(credFile, 'utf8'))) });
const fs_ = admin.firestore();

// Timestamp do Firestore → {seconds, nanoseconds}; GeoPoint/Reference não são usados neste sistema
function convert(v) {
  if (v === null || typeof v !== 'object') return v;
  if (typeof v.toDate === 'function' && typeof v.seconds === 'number') return { seconds: v.seconds, nanoseconds: v.nanoseconds };
  if (Array.isArray(v)) return v.map(convert);
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, convert(x)]));
}

const pulled = {};
for (const col of COLLECTIONS) {
  const snap = await fs_.collection(col).get();
  pulled[col] = snap.docs.map(d => ({ id: d.id, ...convert(d.data()) }));
  console.log(`  ${col.padEnd(22)} ${String(pulled[col].length).padStart(5)} documentos na nuvem`);
}
if (dry) { console.log('\n(dry-run: nada foi gravado)\n'); process.exit(0); }

const config = loadConfig();
const store = new Store(config.dbPath);
store.backupTo(path.join(config.backupDir, `antes-do-pull-${new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19)}.db`));
for (const col of COLLECTIONS) store.replaceCollection(col, pulled[col]);
store.setMeta('dataset', 'cloud');
store.close();
console.log(`\n✅ Importado para ${config.dbPath} (backup do banco anterior em ${config.backupDir})\n`);
process.exit(0);
