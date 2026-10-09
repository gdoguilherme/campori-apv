// Substituto de firebase.js no MODO LOCAL (página aberta pelo servidor do evento).
// Garante que nenhum código dispare Firestore/gstatic: se algo chamar, falha alto em vez de
// tentar sair para a internet. (O mapa de imports só é injetado pelo servidor local.)
const blocked = name => () => { throw new Error(`Firestore indisponível no modo local (${name})`); };

export const db = null;
export const collection = blocked('collection');
export const doc = blocked('doc');
export const getDocs = blocked('getDocs');
export const addDoc = blocked('addDoc');
export const updateDoc = blocked('updateDoc');
export const deleteDoc = blocked('deleteDoc');
export const setDoc = blocked('setDoc');
export const query = blocked('query');
export const where = blocked('where');
export const orderBy = blocked('orderBy');
export const onSnapshot = blocked('onSnapshot');
export const serverTimestamp = () => ({ __serverTimestamp: true });
