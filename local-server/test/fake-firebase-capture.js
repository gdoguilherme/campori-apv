// Firestore simulado para testes do caminho da NUVEM (js/api.js): registra as escritas em `calls`.
export const calls = [];
export const db = {};
export const collection = (_db, name) => ({ name });
export const doc = (_db, name, id) => ({ name, id });
export const addDoc = async (c, data) => { calls.push({ op: 'add', col: c.name, data }); return { id: 'novo-id' }; };
export const updateDoc = async (d, data) => { calls.push({ op: 'update', col: d.name, id: d.id, data }); };
export const deleteDoc = async d => { calls.push({ op: 'delete', col: d.name, id: d.id }); };
export const setDoc = async () => {};
export const getDocs = async () => ({ docs: [] });
export const query = (...a) => a[0];
export const where = () => ({});
export const orderBy = () => ({});
export const onSnapshot = () => () => {};
export const serverTimestamp = () => ({ __serverTimestamp: true });
