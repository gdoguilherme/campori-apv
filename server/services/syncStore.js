// Adaptador Firestore da sincronização de scans (fila offline do Conselheiro).
// A DECISÃO de cada item vive em shared/sync.js (a mesma do servidor local); aqui só lemos
// o Firestore, chamamos a decisão e gravamos o resultado — tudo numa transação por item.
// `db` e `admin` são injetados (nos testes entra um Firestore falso).

let _shared;
const shared = async () => (_shared ||= await import('../shared/sync.js')); // ESM carregado a partir de CJS

const safeId = s => typeof s === 'string' && s.length > 0 && s.length < 200 && !s.includes('/') && !/^\.\.?$/.test(s) && !/^__.*__$/.test(s);

// Timestamp do Firestore → {seconds, nanoseconds} (o resto do sistema/shared trabalha com isso)
function toPlain(v) {
  if (v === null || typeof v !== 'object') return v;
  if (typeof v.toMillis === 'function' && typeof v.seconds === 'number') return { seconds: v.seconds, nanoseconds: v.nanoseconds };
  if (Array.isArray(v)) return v.map(toPlain);
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toPlain(x)]));
}
const docOf = snap => (snap && snap.exists ? { id: snap.id, ...toPlain(snap.data()) } : null);
const docsOf = qs => qs.docs.map(d => ({ id: d.id, ...toPlain(d.data()) }));

async function loadUser(db, id) {
  const snap = await db.collection('users').doc(id).get();
  const u = docOf(snap);
  if (!u || u.active === false) return null;
  const { password, passwordHash, ...rest } = u;
  return rest;
}

async function processScans({ db, admin, user, items, verifyQr, nowMs = Date.now() }) {
  const { decideScanItem, orderBatch, scanDocId, isValidClientId } = await shared();
  const makeTs = ms => admin.firestore.Timestamp.fromMillis(ms);
  const subs = db.collection('submissions');
  const regionName = user.regionId ? (docOf(await db.collection('regions').doc(user.regionId).get())?.name ?? user.regionId) : null;

  const byItem = new Map();
  for (const item of orderBatch(items)) {
    const ok = item && typeof item === 'object';
    const requisitoId = ok ? String(item.requisitoId || '') : '';
    const result = await db.runTransaction(async tx => {
      // todas as leituras ANTES das escritas (regra das transações do Firestore)
      const [reqSnap, existingSnap, unitSubsSnap] = await Promise.all([
        safeId(requisitoId) ? tx.get(db.collection('requirements').doc(requisitoId)) : null,
        ok && isValidClientId(item.id) ? tx.get(subs.doc(scanDocId(item.id))) : null,
        user.unitId && safeId(requisitoId) ? tx.get(subs.where('unitId', '==', user.unitId).where('requirementId', '==', requisitoId)) : null,
      ]);
      const { result, writes } = decideScanItem({
        item, user,
        requirement: docOf(reqSnap), existing: docOf(existingSnap),
        unitSubs: unitSubsSnap ? docsOf(unitSubsSnap) : [],
        hashValid: ok && verifyQr(requisitoId, item.varianteId, item.pontos, item.hash),
        regionName, makeTs, nowMs,
      });
      for (const w of writes) {
        if (w.op === 'insert') tx.set(subs.doc(w.id), w.doc);
        else tx.update(subs.doc(w.id), w.patch);
      }
      return result;
    });
    byItem.set(item, result);
  }
  return { serverTime: nowMs, results: items.map(it => byItem.get(it)) };
}

// O ranking lê TODAS as submissions/unidades — cache de 60s para não estourar a cota do
// Firestore quando muitos celulares atualizam ao mesmo tempo
let _rankingCache = { at: 0, data: null };

async function bootstrap({ db, user, withRanking = true, nowMs = Date.now() }) {
  const { buildCounselorBootstrap } = await shared();
  const unit = user.unitId ? docOf(await db.collection('units').doc(user.unitId).get()) : null;
  const regionId = unit?.regionId || user.regionId;
  const [regions, participants, requirements, unitSubmissions] = await Promise.all([
    db.collection('regions').get().then(docsOf),
    user.unitId ? db.collection('participants').where('unitId', '==', user.unitId).get().then(docsOf) : [],
    db.collection('requirements').get().then(docsOf),
    user.unitId ? db.collection('submissions').where('unitId', '==', user.unitId).get().then(docsOf) : [],
  ]);
  let ranking = {};
  if (withRanking) {
    if (!_rankingCache.data || nowMs - _rankingCache.at > 60_000) {
      const [allSubmissions, allUnits, disciplinaryActions] = await Promise.all(
        ['submissions', 'units', 'disciplinaryActions'].map(c => db.collection(c).get().then(docsOf)));
      _rankingCache = { at: nowMs, data: { allSubmissions, allUnits, disciplinaryActions } };
    }
    ranking = _rankingCache.data;
  }
  const region = regions.find(r => r.id === regionId) || null;
  return buildCounselorBootstrap({ user, unit, region, regions, participants, requirements, unitSubmissions, ...ranking, nowMs });
}

const _resetRankingCache = () => { _rankingCache = { at: 0, data: null }; };
module.exports = { processScans, bootstrap, loadUser, _resetRankingCache };
