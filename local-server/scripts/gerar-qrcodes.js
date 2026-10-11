// Gera TODOS os QR Codes das provas (PNG + TODOS-OS-QRCODES.pdf) a partir do banco local — sem passar pelo portal do Fiscal.
//   npm run gerar-qrcodes                 → data\qrcodes\
//   npm run gerar-qrcodes -- E:\qr        → pasta de destino à escolha
// IMPRIMA SÓ DEPOIS de cadastrar os requisitos reais: trocar requisito, variante ou pontos depois invalida o QR impresso.
import path from 'node:path';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/db.js';
import { generateQrFiles } from '../src/qrcodes.js';

const args = process.argv.slice(2);
const dest = args.find(a => !a.startsWith('--'));
const config = loadConfig();
const store = new Store(config.dbPath);
try {
  const r = await generateQrFiles({ store, config, destDir: dest ? path.resolve(dest) : undefined, allowDevSecret: args.includes('--permitir-segredo-dev') });
  if (!r.ok) { console.error(`❌ ${r.message}`); process.exitCode = r.empty ? 1 : 2; }
  else {
    console.log(`✅ ${r.count} QR Code(s) gerado(s).\n   Pasta: ${r.dir}\n   PDF:   ${r.pdf}  (6 por página A4)\n`);
    console.log('⚠️  Imprima só depois de cadastrar os requisitos REAIS — trocar requisito, variante ou pontos invalida o QR já impresso.');
  }
} catch (e) { console.error(`❌ Falha ao gerar: ${e.message}`); process.exitCode = 1; }
store.close();
