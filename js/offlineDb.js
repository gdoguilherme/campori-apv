// IndexedDB do app: fila de scans (`queue`) e dados baixados (`kv`: snapshot da unidade).
// Se o IndexedDB não estiver disponível (aba anônima etc.) cai para memória — e avisa via
// isPersistent() para a interface alertar que a fila NÃO sobrevive ao fechar o app.
const DB_NAME = 'campori-offline', VERSION = 1;
let dbPromise = null;
let persistent = true;
const mem = { queue: new Map(), kv: new Map() };
const keyOf = { queue: 'id', kv: 'key' };

export const isPersistent = () => persistent;

function open() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      if (typeof indexedDB === 'undefined') return reject(new Error('sem IndexedDB'));
      const req = indexedDB.open(DB_NAME, VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        db.createObjectStore('queue', { keyPath: 'id' }).createIndex('userId', 'userId');
        db.createObjectStore('kv', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
      req.onblocked = () => reject(new Error('IndexedDB bloqueado'));
    }).catch(err => { persistent = false; console.warn('[offlineDb] usando memória:', err.message); return null; });
  }
  return dbPromise;
}

const done = req => new Promise((res, rej) => { req.onsuccess = () => res(req.result); req.onerror = () => rej(req.error); });

async function run(store, mode, fn) {
  const db = await open();
  if (!db) return fn(null);
  const tx = db.transaction(store, mode);
  const out = await fn(tx.objectStore(store));
  if (mode === 'readwrite') await new Promise((res, rej) => { tx.oncomplete = res; tx.onerror = () => rej(tx.error); tx.onabort = () => rej(tx.error); });
  return out;
}

export const put = (store, value) => run(store, 'readwrite', os => os ? done(os.put(value)) : (mem[store].set(value[keyOf[store]], structuredClone(value)), undefined));
export const get = (store, key) => run(store, 'readonly', os => os ? done(os.get(key)) : structuredClone(mem[store].get(key)));
export const del = (store, key) => run(store, 'readwrite', os => os ? done(os.delete(key)) : (mem[store].delete(key), undefined));
export const getAll = store => run(store, 'readonly', os => os ? done(os.getAll()) : [...mem[store].values()].map(v => structuredClone(v)));

// Pede ao navegador para NÃO apagar estes dados quando faltar espaço (Android/iOS podem limpar)
export async function requestPersistence() {
  try { return (await navigator.storage?.persist?.()) ?? false; } catch { return false; }
}
