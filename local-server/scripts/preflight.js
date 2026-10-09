// Verificação pré-evento: Node, .env, certificado, portas, banco, CLOUD_SYNC, backup recente, nuvem e DNS.
//   npm run preflight        (código de saída 0 = pronto; 1 = há ❌ para corrigir)
import { loadConfig } from '../src/config.js';
import { runPreflight, formatPreflight } from '../src/preflight.js';

const config = loadConfig();
console.log('Verificando o PC do evento…\n');
const r = await runPreflight({ config });
console.log(formatPreflight(r));
process.exit(r.ok ? 0 : 1);
