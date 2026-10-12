import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { REPO_ROOT } from '../config.js';
import { withTimeout, classifyError } from './errors.js';

export class CloudConfigError extends Error {}

// Fachada do Firestore usada pela sincronização. `db`/`admin` são injetados — em produção vêm do
// firebase-admin (openFirebase); nos testes, de um Firestore falso em memória.
export class Cloud {
  constructor({ db, admin, probeTimeoutMs = 6000 }) { this.db = db; this.admin = admin; this.probeTimeoutMs = probeTimeoutMs; }
  get Timestamp() { return this.admin.firestore.Timestamp; }
  col(name) { return this.db.collection(name); }

  // "A nuvem responde?" — leitura de um documento (inexistente) com prazo curto.
  // → { ok:true } | { ok:false, kind:'network'|'quota'|'auth'|'other', message }
  async probe() {
    try {
      await withTimeout(this.db.collection('_sync').doc('ping').get(), this.probeTimeoutMs, 'teste de conexão com a nuvem');
      return { ok: true };
    } catch (e) { return { ok: false, kind: classifyError(e), message: e.message }; }
  }
}

// Credenciais: FIREBASE_CREDENTIALS_FILE ou ../server/campori-apv-firebase-adminsdk.json (as mesmas do pull-cloud)
export function openFirebase(config) {
  const credFile = process.env.FIREBASE_CREDENTIALS_FILE || path.join(REPO_ROOT, 'server', 'campori-apv-firebase-adminsdk.json');
  if (!fs.existsSync(credFile)) throw new CloudConfigError(`Credenciais do Firebase não encontradas: ${credFile} (defina FIREBASE_CREDENTIALS_FILE no .env)`);
  let admin;
  try { admin = createRequire(import.meta.url)('firebase-admin'); }
  catch { throw new CloudConfigError('Pacote firebase-admin não instalado — rode "npm install" na pasta local-server.'); }
  let creds;
  try { creds = JSON.parse(fs.readFileSync(credFile, 'utf8')); } catch (e) { throw new CloudConfigError(`Arquivo de credenciais inválido: ${e.message}`); }
  const app = admin.apps.find(a => a.name === 'campori-local-sync') || admin.initializeApp({ credential: admin.credential.cert(creds) }, 'campori-local-sync');
  const db = app.firestore();
  db.settings({ ignoreUndefinedProperties: true });
  return new Cloud({ db, admin: { ...admin, firestore: Object.assign(() => db, { Timestamp: admin.firestore.Timestamp }) } });
}
