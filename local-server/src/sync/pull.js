// Nuvem → local. Mantém o SQLite atualizado com o que acontece na nuvem (cadastros, requisitos com variantes de QR,
// usuários do login, disciplina, scans/aprovações feitos lá) usando os LISTENERS do Firestore: depois da carga
// inicial só chegam as MUDANÇAS (poucas leituras) e exclusões são percebidas. A "reconciliação" lê tudo de novo
// (botão do painel e a cada 2h) para pegar qualquer coisa que um listener tenha perdido.
// Regra de ouro: NUNCA sobrescreve alteração local ainda não enviada (store.applyRemote ignora linhas dirty).
import { fromCloud } from './convert.js';
import { withTimeout, classifyError } from './errors.js';

// auditLog não desce (só sobe); os demais refletem a nuvem
export const PULL_COLLECTIONS = ['regions', 'units', 'requirements', 'users', 'participants', 'disciplinaryActions', 'submissions'];
const READ_TIMEOUT_MS = 45_000;

export function createPuller({ store, log, now = () => Date.now(), readTimeoutMs = READ_TIMEOUT_MS }) {
  const st = { listening: false, error: null, lastPullAt: null, lastFullAt: null, collections: {} };
  const stats = { created: 0, updated: 0, removed: 0, unchanged: 0, skippedDirty: 0 };
  let unsubs = [], gen = 0, ready = {};

  const touch = () => { st.lastPullAt = now(); };
  const count = r => { if (r === 'created') stats.created++; else if (r === 'updated') stats.updated++; else if (r === 'unchanged') stats.unchanged++; else if (r === 'skipped-dirty') stats.skippedDirty++; };

  // lê o documento de um snapshot do Firestore → formato local
  const docOf = d => ({ id: d.id, ...fromCloud(d.data()) });

  // coleção inteira: aplica tudo e remove o que sumiu da nuvem
  function applyFull(col, docs) {
    store.tx(() => {
      for (const d of docs) count(store.applyRemote(col, d.id, d));
      stats.removed += store.sweepMissing(col, docs.map(d => d.id));
    });
    st.collections[col] = { ...(st.collections[col] || {}), ready: true, fullAt: now(), docs: docs.length };
    st.lastFullAt = Math.min(...PULL_COLLECTIONS.map(c => st.collections[c]?.fullAt ?? Infinity));
    if (!Number.isFinite(st.lastFullAt)) st.lastFullAt = null;
    touch();
  }

  function onSnapshot(col, snap, myGen, first) {
    if (myGen !== gen) return;                                   // listener antigo (reiniciado)
    try {
      if (first) {
        applyFull(col, snap.docs.map(docOf));
        ready[col]?.resolve();
      } else {
        store.tx(() => {
          for (const ch of snap.docChanges()) {
            if (ch.type === 'removed') { if (store.removeRemote(col, ch.doc.id) === 'removed') stats.removed++; }
            else count(store.applyRemote(col, ch.doc.id, docOf(ch.doc)));
          }
        });
        st.collections[col] = { ...(st.collections[col] || {}), lastEventAt: now() };
        touch();
      }
    } catch (e) { log.error(`pull ${col}: ${e.stack || e.message}`); }
  }

  function onError(col, err, myGen) {
    if (myGen !== gen) return;
    st.error = { collection: col, message: err.message, kind: classifyError(err) };
    log.warn(`Listener de ${col} caiu (${err.message}) — será reiniciado no próximo ciclo.`);
    store.logEvent({ kind: 'pull-error', level: 'warn', collection: col, message: `Atualização automática de ${col} interrompida: ${err.message}` });
    stop();                                                      // o engine recria os listeners quando a nuvem responder
  }

  function start(cloud) {
    if (st.listening) return;
    st.listening = true; st.error = null; const myGen = ++gen; ready = {};
    for (const col of PULL_COLLECTIONS) {
      let resolve; const promise = new Promise(r => { resolve = r; }); ready[col] = { promise, resolve };
      let first = true;
      unsubs.push(cloud.col(col).onSnapshot(snap => { const f = first; first = false; onSnapshot(col, snap, myGen, f); }, err => onError(col, err, myGen)));
    }
  }

  function stop() {
    gen++; st.listening = false;
    for (const u of unsubs) { try { u(); } catch { /* ignora */ } }
    unsubs = [];
  }

  // espera a carga inicial de TODAS as coleções (usado pelo "Sincronizar agora")
  const waitReady = (ms = readTimeoutMs) => withTimeout(Promise.all(PULL_COLLECTIONS.map(c => ready[c]?.promise ?? Promise.resolve())), ms, 'carga inicial da nuvem');

  // leitura completa (botão "Atualizar dados da nuvem" / a cada 2h)
  async function reconcile(cloud) {
    for (const col of PULL_COLLECTIONS) {
      const snap = await withTimeout(cloud.col(col).get(), readTimeoutMs, `lendo ${col} da nuvem`);
      applyFull(col, snap.docs.map(docOf));
    }
    if (!store.getMeta('dataset')) store.setMeta('dataset', 'cloud');
  }

  const fullDue = (reconcileMs) => !st.lastFullAt || now() - st.lastFullAt > reconcileMs;

  return {
    start, stop, waitReady, reconcile, fullDue,
    takeStats() { const out = { ...stats }; for (const k of Object.keys(stats)) stats[k] = 0; return out; },
    status: () => ({ listening: st.listening, error: st.error, lastPullAt: st.lastPullAt, lastFullAt: st.lastFullAt, collections: st.collections }),
  };
}
