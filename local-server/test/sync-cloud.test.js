// O backend da NUVEM (Fly.io) usa o mesmo shared/sync.js, mas grava no Firestore. Aqui o
// adaptador real (server/services/syncStore.js) roda contra um Firestore falso em memória
// — nada toca a produção.
import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { createRequire } from 'node:module';

process.env.QR_SECRET = 'segredo-de-teste';
process.env.JWT_SECRET = 'jwt-teste';
const require = createRequire(import.meta.url);
const syncStore = require('../../server/services/syncStore.js');
const { verifyQr } = require('../../server/services/qrTokens.js');
const hash = (r, v, p) => crypto.createHmac('sha256', 'segredo-de-teste').update(`${r}:${v}:${p}`).digest('hex').slice(0, 16);

class FakeTimestamp {
  constructor(ms) { this.seconds = Math.floor(ms / 1000); this.nanoseconds = (ms % 1000) * 1e6; }
  toMillis() { return this.seconds * 1000 + this.nanoseconds / 1e6; }
}
class FakeFirestore {
  constructor() { this.cols = {}; this._q = Promise.resolve(); }
  _col(n) { return (this.cols[n] ||= new Map()); }
  seed(col, id, data) { this._col(col).set(id, data); }
  collection(name) {
    const db = this;
    const snap = (id, obj) => ({ id, exists: !!obj, data: () => ({ ...obj }) });
    const mkQuery = filters => ({
      where: (f, op, v) => mkQuery([...filters, [f, v]]),
      __get: async () => ({ docs: [...db._col(name)].filter(([, o]) => filters.every(([f, v]) => o[f] === v)).map(([id, o]) => snap(id, o)) }),
      get() { return this.__get(); },
    });
    return {
      ...mkQuery([]),
      doc: id => ({
        id, __get: async () => snap(id, db._col(name).get(id)), get() { return this.__get(); },
        __set: d => db._col(name).set(id, { ...d }), __update: p => { if (!db._col(name).has(id)) throw new Error('NOT_FOUND'); db._col(name).set(id, { ...db._col(name).get(id), ...p }); },
      }),
    };
  }
  // transações serializadas (o Firestore real faz retry em contenção; o efeito é o mesmo)
  runTransaction(fn) {
    const run = async () => {
      const writes = [];
      const tx = { get: x => x.__get(), set: (ref, d) => writes.push(() => ref.__set(d)), update: (ref, p) => writes.push(() => ref.__update(p)) };
      const r = await fn(tx); writes.forEach(w => w()); return r;
    };
    const p = this._q.then(run); this._q = p.catch(() => {}); return p;
  }
}
const admin = { firestore: { Timestamp: { fromMillis: ms => new FakeTimestamp(ms) } } };

let db; const user = { id: 'c1', role: 'counselor', unitId: 'U1', regionId: 'R1', username: 'cons1', name: 'Cons 1' };
beforeEach(() => {
  db = new FakeFirestore();
  db.seed('regions', 'R1', { name: 'Região 1' });
  db.seed('units', 'U1', { name: 'Unidade 1', regionId: 'R1' });
  db.seed('units', 'U2', { name: 'Unidade 2', regionId: 'R1' });
  db.seed('users', 'c1', { ...user, passwordHash: 'x' });
  db.seed('requirements', 'RQ', { name: 'Prova QR', points: 8, category: 'Outros', filledBy: 'conselheiro', active: true, order: 1, deadline: new FakeTimestamp(Date.UTC(2026, 9, 12)), qrVariants: [{ id: 'v1', label: 'Básico', points: 5 }, { id: 'v2', label: 'Avançado', points: 8 }] });
  db.seed('requirements', 'RA', { name: 'Regional', points: 10, filledBy: 'regional', active: true, order: 0 });
  syncStore._resetRankingCache();
});
let n = 0;
const item = (o = {}) => {
  const it = { id: `cloud-${String(++n).padStart(5, '0')}-${crypto.randomUUID().slice(0, 8)}`, requisitoId: 'RQ', varianteId: 'v1', pontos: 5, unitId: 'U1', scanTimestamp: Date.now() - 60_000, ...o };
  it.hash = o.hash ?? hash(it.requisitoId, it.varianteId, it.pontos); return it;
};
const sync = (items, u = user) => syncStore.processScans({ db, admin, user: u, items, verifyQr });
const subs = () => [...db._col('submissions')].map(([id, d]) => ({ id, ...d }));

test('nuvem: aceito, grava Timestamp do Firestore no momento do scan e é idempotente', async () => {
  const it = item({ scanTimestamp: Date.now() - 7200_000 });
  const r = (await sync([it])).results[0];
  assert.deepEqual([r.status, r.code, r.submissionId], ['aceito', 'ACCEPTED', `scan_${it.id}`]);
  const [s] = subs();
  assert.ok(s.submittedAt instanceof FakeTimestamp && s.syncedAt instanceof FakeTimestamp);
  assert.equal(s.submittedAt.toMillis(), it.scanTimestamp);
  assert.deepEqual([s.status, s.source, s.unitId, s.regionName, s.requirementPoints], ['approved', 'qr', 'U1', 'Região 1', 5]);
  const again = (await sync([it])).results[0];
  assert.deepEqual([again.status, again.alreadySynced], ['aceito', true]);
  await Promise.all([sync([it]), sync([it]), sync([it])]);
  assert.equal(subs().length, 1);
});

test('nuvem: dois aparelhos — vence o scanTimestamp mais antigo (também com Timestamps do Firestore)', async () => {
  const now = Date.now();
  const A = item({ varianteId: 'v2', pontos: 8, scanTimestamp: now - 600_000 });
  const B = item({ varianteId: 'v1', pontos: 5, scanTimestamp: now - 1_200_000 });
  assert.equal((await sync([A])).results[0].status, 'aceito');
  const rb = (await sync([B])).results[0];
  assert.deepEqual([rb.status, rb.code], ['aceito', 'ACCEPTED_SUPERSEDED']);
  const all = subs();
  assert.equal(all.filter(s => s.status === 'approved').length, 1);
  assert.equal(all.find(s => s.id === `scan_${A.id}`).qrConflict, 'superseded');
  const ra = (await sync([A])).results[0];
  assert.deepEqual([ra.status, ra.code], ['duplicado', 'SUPERSEDED']);
  // mais novo chegando depois → duplicado
  const C = item({ scanTimestamp: now - 10 });
  assert.equal((await sync([C])).results[0].code, 'DUPLICATE');
  assert.equal(subs().length, 2);
});

test('nuvem: lote fora de ordem é processado pelo scanTimestamp; rejeições; ids perigosos', async () => {
  const now = Date.now();
  const late = item({ varianteId: 'v2', pontos: 8, scanTimestamp: now - 1000 }), early = item({ scanTimestamp: now - 9000 });
  const r = (await sync([late, early])).results;
  assert.deepEqual(r.map(x => x.status), ['duplicado', 'aceito']);
  db = new FakeFirestore(); beforeEachSeed();
  const res = (await sync([
    item({ hash: '0000000000000000' }), item({ selectedRequirementId: 'OUTRA' }), item({ unitId: 'U2' }),
    item({ requisitoId: 'a/b' }), { ...item(), id: '../x' }, item({ requisitoId: 'RA', varianteId: 'x', pontos: 1 }), null,
  ])).results;
  assert.deepEqual(res.map(x => x.code), ['INVALID_HASH', 'WRONG_PROVA', 'UNIT_MISMATCH', 'REQUIREMENT_NOT_FOUND', 'INVALID_ITEM', 'NOT_COUNSELOR_REQUIREMENT', 'INVALID_ITEM']);
  assert.equal(subs().length, 0);
});
function beforeEachSeed() {
  db.seed('regions', 'R1', { name: 'Região 1' }); db.seed('units', 'U1', { name: 'U1', regionId: 'R1' });
  db.seed('requirements', 'RQ', { name: 'Prova QR', points: 8, filledBy: 'conselheiro', active: true, qrVariants: [{ id: 'v1', label: 'B', points: 5 }, { id: 'v2', label: 'A', points: 8 }] });
  db.seed('requirements', 'RA', { name: 'Regional', points: 10, filledBy: 'regional', active: true });
}

test('nuvem: bootstrap converte Timestamps, não vaza hash/senha e cacheia o ranking', async () => {
  db.seed('participants', 'p1', { name: 'João', unitId: 'U1', regionId: 'R1', secretNote: 'x' });
  db.seed('participants', 'p2', { name: 'Outra unidade', unitId: 'U2' });
  await sync([item()]);
  const b = await syncStore.bootstrap({ db, user });
  assert.equal(b.unit.name, 'Unidade 1'); assert.equal(b.region.name, 'Região 1');
  assert.deepEqual(b.participants.map(p => p.name), ['João']);
  assert.ok(!('secretNote' in b.participants[0]));
  assert.deepEqual(b.requirements.map(r => r.id), ['RQ']);
  assert.deepEqual(b.requirements[0].deadline, { seconds: Math.floor(Date.UTC(2026, 9, 12) / 1000), nanoseconds: 0 });
  assert.equal(b.submissions.length, 1);
  assert.deepEqual(b.ranking, [{ total: 5 }]);
  assert.ok(!/passwordHash|"hash"/.test(JSON.stringify(b)));
  // 2ª chamada dentro de 60s reaproveita o ranking (não relê as coleções inteiras)
  let fullReads = 0; const orig = db.collection.bind(db);
  db.collection = n => { const c = orig(n); if (['submissions', 'units', 'disciplinaryActions'].includes(n)) { const g = c.get.bind(c); c.get = () => { fullReads++; return g(); }; } return c; };
  await syncStore.bootstrap({ db, user });
  assert.equal(fullReads, 0, 'ranking veio do cache');
});

test('nuvem: loadUser recusa usuário inexistente/inativo e remove o hash de senha', async () => {
  assert.equal(await syncStore.loadUser(db, 'naoexiste'), null);
  db.seed('users', 'off', { role: 'counselor', active: false });
  assert.equal(await syncStore.loadUser(db, 'off'), null);
  const u = await syncStore.loadUser(db, 'c1');
  assert.ok(u && !('passwordHash' in u) && u.unitId === 'U1');
});
