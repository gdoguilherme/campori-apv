import bcrypt from 'bcryptjs';
import { Store } from '../src/db.js';
import { createApp } from '../src/app.js';

export const QR_SECRET = 'segredo-de-teste';

export async function startTestServer() {
  const config = { port: 0, qrSecret: QR_SECRET, jwtSecret: 'jwt-teste', qrSecretIsDev: false, version: 'test', uploadDir: '/tmp/campori-test-uploads', frontendDir: null };
  const store = new Store(':memory:');
  const log = { info() {}, warn() {}, error: console.error };
  const app = createApp({ store, config, log });
  const server = await new Promise(res => { const s = app.listen(0, '127.0.0.1', () => res(s)); });
  const base = `http://127.0.0.1:${server.address().port}`;

  const call = async (method, path, body, token) => {
    const r = await fetch(base + path, {
      method, headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
    const json = await r.json().catch(() => ({}));
    return { status: r.status, body: json };
  };
  const login = async username => (await call('POST', '/users/login', { username, password: 'senha123' })).body.token;
  return { store, base, call, login, close: () => new Promise(res => server.close(() => { store.close(); res(); })) };
}

// Cenário: 2 regiões (R1 com unidades U1/U2, R2 com U3), usuários de todos os perfis, requisitos
export async function seedScenario(store) {
  const hash = await bcrypt.hash('senha123', 4);
  const user = (id, username, role, extra = {}) => store.insert('users', { name: username, username, role, active: true, passwordHash: hash, ...extra }, id);
  store.insert('regions', { name: 'Região 1', competitionCategory: 'DBV', active: true }, 'R1');
  store.insert('regions', { name: 'Região 2', competitionCategory: 'AVT', active: true }, 'R2');
  store.insert('units', { name: 'Unidade 1', regionId: 'R1' }, 'U1');
  store.insert('units', { name: 'Unidade 2', regionId: 'R1' }, 'U2');
  store.insert('units', { name: 'Unidade 3', regionId: 'R2' }, 'U3');
  user('adm', 'admin', 'superadmin');
  user('apr', 'aprovador', 'approver');
  user('jud', 'fiscal', 'judge');
  user('reg1', 'regiao1', 'region', { regionId: 'R1' });
  user('c1', 'cons1', 'counselor', { regionId: 'R1', unitId: 'U1' });
  user('c2', 'cons2', 'counselor', { regionId: 'R1', unitId: 'U2' });
  store.insert('requirements', { name: 'Regional A', points: 10, category: 'ADM', filledBy: 'regional', order: 0, active: true }, 'RA');
  store.insert('requirements', {
    name: 'Prova QR', points: 8, category: 'Outros', filledBy: 'conselheiro', order: 1, active: true,
    qrVariants: [{ id: 'v1', label: 'Básico', points: 5 }, { id: 'v2', label: 'Avançado', points: 8 }]
  }, 'RQ');
  store.insert('requirements', { name: 'Prova Simples', points: 7, category: 'Outros', filledBy: 'conselheiro', order: 2, active: true }, 'RS');
  store.insert('requirements', {
    name: 'Outra prova QR', points: 3, category: 'Outros', filledBy: 'conselheiro', order: 3, active: true,
    qrVariants: [{ id: 'x1', label: 'Único', points: 3 }]
  }, 'RQ2');
}
