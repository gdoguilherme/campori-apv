// Popula o banco LOCAL com dados de demonstração (para validar o servidor sem a nuvem).
// Uso: npm run seed-demo            (recusa se o banco já tiver dados)
//      npm run seed-demo -- --reset (apaga TUDO e recria)
import bcrypt from 'bcryptjs';
import { loadConfig } from '../src/config.js';
import { Store, COLLECTIONS } from '../src/db.js';

const config = loadConfig();
const store = new Store(config.dbPath);
const reset = process.argv.includes('--reset');
const existing = COLLECTIONS.reduce((n, c) => n + store.count(c), 0);
if (existing > 0 && !reset) {
  console.error(`\nO banco ${config.dbPath} já tem ${existing} registros. Use "npm run seed-demo -- --reset" para apagar e recriar.\n`);
  process.exit(1);
}
if (reset) for (const c of COLLECTIONS) store.replaceCollection(c, []);

const PWD = 'demo1234';
const hash = await bcrypt.hash(PWD, 10);
const user = (id, username, name, role, extra = {}) =>
  store.insert('users', { name, username, role, active: true, passwordHash: hash, phone: '', ...extra }, id);

store.insert('regions', { name: '1ª Região (demo)', competitionCategory: 'DBV', active: true }, 'demoR1');
store.insert('regions', { name: '2ª Região (demo)', competitionCategory: 'AVT', active: true }, 'demoR2');
store.insert('units', { name: 'Unidade Águias', warCry: 'Voar alto!', regionId: 'demoR1', counselorId: 'demoC1' }, 'demoU1');
store.insert('units', { name: 'Unidade Leões', warCry: 'Rugir!', regionId: 'demoR1', counselorId: 'demoC2' }, 'demoU2');
store.insert('units', { name: 'Unidade Lobos', warCry: 'Uivar!', regionId: 'demoR2', counselorId: null }, 'demoU3');
store.insert('participants', { name: 'João Silva', club: 'Clube A', regionId: 'demoR1', competitionCategory: 'DBV', unitId: 'demoU1' });
store.insert('participants', { name: 'Maria Souza', club: 'Clube A', regionId: 'demoR1', competitionCategory: 'DBV', unitId: 'demoU2' });

user('demoAdmin', 'admin', 'Super Admin (demo)', 'superadmin');
user('demoFiscal', 'fiscal', 'Fiscal de Prova (demo)', 'judge');
user('demoRegiao1', 'regiao1', '1ª Região (demo)', 'region', { regionId: 'demoR1', competitionCategory: 'DBV' });
user('demoC1', 'conselheiro1', 'Conselheiro Águias (demo)', 'counselor', { regionId: 'demoR1', unitId: 'demoU1', competitionCategory: 'DBV' });
user('demoC2', 'conselheiro2', 'Conselheiro Leões (demo)', 'counselor', { regionId: 'demoR1', unitId: 'demoU2', competitionCategory: 'DBV' });

store.insert('requirements', { name: 'Relatório da região', points: 10, category: 'ADM', filledBy: 'regional', competitionCategory: 'Ambos', order: 0, active: true }, 'demoReqA');
store.insert('requirements', {
  name: 'Prova de Nós (QR)', points: 8, category: 'Acampamento', filledBy: 'conselheiro', competitionCategory: 'Ambos', order: 1, active: true,
  qrVariants: [{ id: 'basico', label: 'Nível básico', points: 5 }, { id: 'avancado', label: 'Nível avançado', points: 8 }]
}, 'demoReqQR');
store.insert('requirements', { name: 'Organização da barraca', points: 7, category: 'Acampamento', filledBy: 'conselheiro', competitionCategory: 'Ambos', order: 2, active: true }, 'demoReqB');
// marca como DEMO: a sincronização com a nuvem nunca liga num banco de demonstração
store.setMeta('dataset', 'demo');
for (const c of COLLECTIONS) store.db.exec(`UPDATE "${c}" SET dirty = 0`);
store.close();

console.log(`\n✅ Banco de demonstração criado em ${config.dbPath}`);
console.log(`   Todos os usuários têm a senha: ${PWD}`);
console.log('   admin · fiscal · regiao1 · conselheiro1 (Águias) · conselheiro2 (Leões)\n');
