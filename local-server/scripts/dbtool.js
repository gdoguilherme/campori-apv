// Ferramenta de ÚLTIMO CASO para listar / ver / alterar / apagar registros do banco local.
//   npm run dbtool                       → ajuda e contagem por coleção
//   npm run dbtool -- list participants --where unitId=abc
//   npm run dbtool -- set participants ID --campo unitId=outra
// Detalhes e garantias: src/dbtool.js e GUIA-WINDOWS.md ("Ferramenta de último caso").
import readline from 'node:readline';
import { loadConfig } from '../src/config.js';
import { Store } from '../src/db.js';
import { runDbtool } from '../src/dbtool.js';

const config = loadConfig();
const store = new Store(config.dbPath);
const io = {
  out: s => console.log(s),
  err: s => console.error(s),
  confirm: q => new Promise(res => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    let answered = false;
    rl.on('close', () => { if (!answered) res(false); });          // entrada fechada sem resposta = cancelar (nunca trava)
    rl.question(q, a => { answered = true; rl.close(); res(a.trim().toUpperCase() === 'SIM'); });
  }),
};
console.log(`Banco: ${config.dbPath}`);
const code = await runDbtool(process.argv.slice(2), { store, config, io });
store.close();
process.exit(code);
