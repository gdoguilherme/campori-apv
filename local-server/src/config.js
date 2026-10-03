import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(ROOT, '..');

// Parser de .env próprio (tolera CRLF do Windows e não depende da versão do Node)
export function loadEnvFile(file = path.join(ROOT, '.env')) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 1) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if (/^(['"]).*\1$/.test(val)) val = val.slice(1, -1);
    if (val !== '' && process.env[key] === undefined) process.env[key] = val;
  }
}

// overrides: usado pelos testes (DB em memória, porta aleatória, segredos fixos)
export function loadConfig(overrides = {}) {
  loadEnvFile();
  const env = process.env;
  const dataDir = overrides.dataDir || env.DATA_DIR || path.join(ROOT, 'data');
  fs.mkdirSync(dataDir, { recursive: true });

  const allowDev = env.ALLOW_DEV_SECRETS === '1';
  const qrSecret = overrides.qrSecret || env.QR_SECRET || (allowDev ? 'dev-qr-secret-NAO-USAR-NO-EVENTO' : '');

  // JWT: .env, ou gerado uma vez e guardado em data/ (sessões sobrevivem a reinícios)
  let jwtSecret = overrides.jwtSecret || env.JWT_SECRET;
  if (!jwtSecret) {
    const f = path.join(dataDir, 'jwt.secret');
    if (!fs.existsSync(f)) fs.writeFileSync(f, crypto.randomBytes(32).toString('hex'));
    jwtSecret = fs.readFileSync(f, 'utf8').trim();
  }

  return {
    port: Number(overrides.port ?? env.PORT ?? 8787),
    dbPath: overrides.dbPath || path.join(dataDir, 'campori-local.db'),
    uploadDir: overrides.uploadDir || path.join(dataDir, 'uploads'),
    backupDir: overrides.backupDir || path.join(ROOT, 'backups'),
    logDir: path.join(ROOT, 'logs'),
    backupEveryMin: Number(overrides.backupEveryMin ?? env.BACKUP_EVERY_MIN ?? 10),
    qrSecret, jwtSecret,
    qrSecretIsDev: !env.QR_SECRET && !overrides.qrSecret,
    // Frontend estático servido pelo próprio servidor (mesma origem — evita bloqueio de
    // "mixed content" de páginas https chamando http local). Só estas pastas são expostas.
    frontendDir: overrides.frontendDir === undefined ? REPO_ROOT : overrides.frontendDir,
    version: '1.0.0',
  };
}

export function assertNodeVersion() {
  const [maj, min] = process.versions.node.split('.').map(Number);
  if (maj < 22 || (maj === 22 && min < 13)) {
    console.error(`\n[ERRO] Node.js ${process.versions.node} é antigo demais. Instale o Node.js 22 LTS ou 24 LTS (https://nodejs.org).\n`);
    process.exit(11);
  }
}
