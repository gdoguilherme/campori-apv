import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js';
import {
  getFirestore, collection, doc, getDocs, addDoc, updateDoc,
  deleteDoc, setDoc, query, where, orderBy, onSnapshot, serverTimestamp
} from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const firebaseConfig = {
  apiKey: 'AIzaSyAUSqOEZ06Tekk-YMvX0X4UQpENJWhFm3g',
  authDomain: 'campori-apv.firebaseapp.com',
  projectId: 'campori-apv',
  storageBucket: 'campori-apv.firebasestorage.app',
  messagingSenderId: '235508891969',
  appId: '1:235508891969:web:58944479146eef0fc261c0'
};

export const db = getFirestore(initializeApp(firebaseConfig));
export {
  collection, doc, getDocs, addDoc, updateDoc, deleteDoc, setDoc,
  query, where, orderBy, onSnapshot, serverTimestamp
};
