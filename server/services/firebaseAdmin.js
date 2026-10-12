const admin = require('firebase-admin');

let _initialized = false;

function ensureInit() {
  if (_initialized) return;
  const creds = process.env.FIREBASE_CREDENTIALS_JSON
    ? JSON.parse(process.env.FIREBASE_CREDENTIALS_JSON)
    : require('../firebase-credentials.json');
  admin.initializeApp({ credential: admin.credential.cert(creds) });
  _initialized = true;
}

function firestore() {
  ensureInit();
  return admin.firestore();
}

module.exports = { firestore, admin };
