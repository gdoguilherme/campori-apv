// Firestore simulado para testes do caminho da NUVEM (js/api.js): registra as escritas em `calls`.
export const calls = [];
export const db = {};
export const collection = (_db, name) => ({ name });
export const doc = (_db, name, id) => ({ name, id });
export const addDoc = async (c, data) => { calls.push({ op: 'add', col: c.name, data }); return { id: 'novo-id' }; };
export const updateDoc = async (d, data) => { calls.push({ op: 'update', col: d.name, id: d.id, data }); };
export const deleteDoc = async d => { calls.push({ op: 'delete', col: d.name, id: d.id }); };
export const setDoc = async (d, data, opts) => { calls.push({ op: 'set', col: d.name, id: d.id, data, opts }); };
export const fakeState = { docs: [] };   // o que getDocs devolve (cada item: { id, data() })
export const getDocs = async () => ({ docs: fakeState.docs });
export const query = (...a) => a[0];
export const where = (...w) => { calls.push({ op: 'where', w }); return {}; };
export const orderBy = () => ({});
export const onSnapshot = () => () => {};
export const serverTimestamp = () => ({ __serverTimestamp: true });
