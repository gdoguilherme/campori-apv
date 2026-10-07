// Ambiente de teste da sincronização: banco local (SQLite em memória) + Firestore falso + engine.
import crypto from 'node:crypto';
import { createRequire } from 'node:module';
import { Store } from '../src/db.js';
import { Cloud } from '../src/sync/cloud.js';
import { createSyncEngine } from '../src/sync/engine.js';
import { toCloud } from '../src/sync/convert.js';
import { decideScanItem } from '../../shared/sync.js';
import { FakeFirestore, FakeTimestamp, fakeAdmin } from './fake-firestore.js';

process.env.QR_SECRET ||= 'segredo-de-teste'; process.env.JWT_SECRET ||= 'jwt-teste';
export const cloudStore = createRequire(import.meta.url)('../../server/services/syncStore.js'); // adaptador que a nuvem usa em /sync/scans

export const T0 = Date.UTC(2026, 9, 10, 12, 0, 0);           // "agora" fixo dos testes (10/10/2026 12:00)
const ts = ms => ({ seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1e6 });
export const plainTs = ts;

export const REF = {
  regions: [['R1', { name: 'Região 1', competitionCategory: 'DBV', active: true }], ['R2', { name: 'Região 2', competitionCategory: 'AVT', active: true }]],
  units: [['U1', { name: 'Águias', regionId: 'R1' }], ['U2', { name: 'Leões', regionId: 'R1' }], ['U3', { name: 'Lobos', regionId: 'R2' }]],
  requirements: [
    ['RQ', { name: 'Prova de Nós', points: 8, category: 'Acampamento', filledBy: 'conselheiro', active: true, order: 1, qrVariants: [{ id: 'v1', label: 'Básico', points: 5 }, { id: 'v2', label: 'Avançado', points: 8 }] }],
    ['RQ2', { name: 'Fogueira', points: 5, category: 'Acampamento', filledBy: 'conselheiro', active: true, order: 2, qrVariants: [{ id: 'f1', label: 'Única', points: 5 }] }],
    ['RA', { name: 'Relatório', points: 10, category: 'ADM', filledBy: 'regional', active: true, order: 0 }],
  ],
  users: [['c1', { name: 'Cons Águias', username: 'cons1', role: 'counselor', regionId: 'R1', unitId: 'U1', active: true, passwordHash: 'x' }],
          ['c2', { name: 'Cons Leões', username: 'cons2', role: 'counselor', regionId: 'R1', unitId: 'U2', active: true, passwordHash: 'x' }]],
};

export function makeEnv({ config = {}, seedCloud = true } = {}) {
  const store = new Store(':memory:');
  const fake = new FakeFirestore();
  let clock = T0;
  const logs = { info: [], warn: [], error: [] };
  const log = { info: m => logs.info.push(m), warn: m => logs.warn.push(m), error: m => logs.error.push(m) };
  for (const [col, rows] of Object.entries(REF)) {
    store.replaceCollection(col, rows.map(([id, d]) => ({ id, ...d })));                    // local: sincronizado (dirty=0, com base)
    if (seedCloud) for (const [id, d] of rows) fake.seed(col, id, toCloud(d, FakeTimestamp));
  }
  const cloud = new Cloud({ db: fake, admin: fakeAdmin, probeTimeoutMs: 120 });
  const mkEngine = (extra = {}) => createSyncEngine({ store, log, getCloud: async () => cloud, now: () => clock,
    config: { cloudSync: true, syncRowTimeoutMs: 400, syncTickMs: 10, ...config, ...extra } });
  return { store, fake, cloud, logs, log, engine: mkEngine(), mkEngine, advance: ms => { clock += ms; }, now: () => clock };
}

// Scan feito no servidor local (mesma decisão do POST /sync/scans), com scanTimestamp relativo a T0
let n = 0;
export function localScan(env, { unit = 'U1', user = 'c1', req = 'RQ', variant = 'v1', pts = 5, ago = 60_000, clientId } = {}) {
  clientId ||= `loc-${String(++n).padStart(5, '0')}-${crypto.randomUUID().slice(0, 8)}`;
  const u = env.store.get('users', user);
  const item = { id: clientId, unitId: unit, requisitoId: req, varianteId: variant, pontos: pts, hash: 'h', scanTimestamp: T0 - ago };
  const { result, writes } = decideScanItem({
    item, user: u, requirement: env.store.get('requirements', req), existing: env.store.get('submissions', `scan_${clientId}`),
    unitSubs: env.store.list('submissions', { filters: { unitId: unit, requirementId: req } }), hashValid: true,
    regionName: env.store.get('regions', u.regionId)?.name, makeTs: ts, nowMs: T0,
  });
  for (const w of writes) w.op === 'insert' ? env.store.insert('submissions', w.doc, w.id) : env.store.update('submissions', w.id, w.patch);
  return { clientId, result };
}

// Scan que chegou à nuvem por outro caminho (backend Fly: POST /sync/scans de um celular em modo nuvem)
export async function cloudScan(env, { user = 'c1', unit = 'U1', req = 'RQ', variant = 'v1', pts = 5, ago = 60_000, clientId } = {}) {
  clientId ||= `cld-${String(++n).padStart(5, '0')}-${crypto.randomUUID().slice(0, 8)}`;
  const u = { id: user, ...REF.users.find(([id]) => id === user)[1] };
  const r = await cloudStore.processScans({ db: env.fake, admin: fakeAdmin, user: u, verifyQr: () => true, nowMs: T0,
    items: [{ id: clientId, unitId: unit, requisitoId: req, varianteId: variant, pontos: pts, hash: 'h', scanTimestamp: T0 - ago }] });
  return { clientId, result: r.results[0] };
}
export const cloudApproved = (env, unit = 'U1', req = 'RQ') => env.fake.all('submissions').filter(s => s.unitId === unit && s.requirementId === req && s.status === 'approved');
export const localApproved = (env, unit = 'U1', req = 'RQ') => env.store.list('submissions', { filters: { unitId: unit, requirementId: req } }).filter(s => s.status === 'approved');
