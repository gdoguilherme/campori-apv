// Limpa pontuações/disciplinas/auditoria de ENSAIO (mantém regiões, unidades, participantes, requisitos e usuários).
//   npm run resetar-eventos-de-teste                 (dupla confirmação + backup automático)
//   npm run resetar-eventos-de-teste -- --dry-run    (só mostra o que faria)
//   npm run resetar-eventos-de-teste -- --so-local   (não propaga a exclusão à nuvem)
// PARE o servidor antes (ou aceite que ele reinicia pelo watchdog) — veja GUIA-WINDOWS.md.
import readline from 'node:readline';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/db.js';
import { runReset } from '../src/reset-events.js';

const args = process.argv.slice(2);
const config = loadConfig();
const store = new Store(config.dbPath);
const io = {
  out: s => console.log(s), err: s => console.error(s),
  ask: q => new Promise(res => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let done = false;
    rl.on('close', () => { if (!done) res(''); });   // entrada fechada = cancelar
    rl.question(q, a => { done = true; rl.close(); res(a); });
  }),
};
const code = await runReset({ store, config, io, flags: { dryRun: args.includes('--dry-run'), soLocal: args.includes('--so-local') } });
store.close();
process.exit(code);
