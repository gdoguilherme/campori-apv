// HTTPS do servidor local: sobe com o certificado, cai para HTTP com aviso claro quando algo falta,
// recarrega o certificado renovado sem reiniciar, e o CORS/preflight (Private Network Access).
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import tls from 'node:tls';
import https from 'node:https';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import { Store } from '../src/db.js';
import { createApp } from '../src/app.js';
import { startServers, loadTls } from '../src/https.js';

const hasOpenssl = (() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
const skip = hasOpenssl ? false : 'openssl não encontrado';

let dir;
const mkcert = (name, days = 30, cn = 'local.gdtmidia.com.br') => {
  const key = path.join(dir, `${name}-key.pem`), cert = path.join(dir, `${name}-chain.pem`);
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', String(days),
    '-subj', `/CN=${cn}`, '-addext', `subjectAltName=DNS:${cn}`], { stdio: 'ignore' });
  return { key, cert };
};
before(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campori-https-')); });
after(() => fs.rmSync(dir, { recursive: true, force: true }));

const logs = () => { const l = { info: [], warn: [], error: [] }; return { l, log: { info: m => l.info.push(m), warn: m => l.warn.push(m), error: m => l.error.push(m) } }; };
const baseConfig = extra => ({ port: 0, httpsPort: 0, qrSecret: 's', jwtSecret: 'j', qrSecretIsDev: false, version: 't', uploadDir: dir, frontendDir: null, corsOrigins: ['https://campori.gdtmidia.com.br', 'https://local.gdtmidia.com.br'], certWatchMs: 100, ...extra });
const launch = async (config) => {
  const store = new Store(':memory:'); const { l, log } = logs(); let servers;
  const app = createApp({ store, config, log, tls: () => servers?.tls() ?? null });
  servers = await startServers({ app, config, log });
  return { servers, l, store, httpPort: servers.http.address().port, httpsPort: servers.https?.address().port, stop: async () => { await servers.close(); store.close(); } };
};
const getJson = (port, urlPath, { secure, ca, headers = {}, method = 'GET' } = {}) => new Promise((resolve, reject) => {
  const req = (secure ? https : http).request({ host: '127.0.0.1', port, path: urlPath, method, headers, ...(secure ? { ca, servername: 'local.gdtmidia.com.br' } : {}) }, res => {
    let b = ''; res.on('data', d => (b += d)); res.on('end', () => { let json = null; try { json = JSON.parse(b); } catch {} resolve({ status: res.statusCode, headers: res.headers, json }); });
  });
  req.on('error', reject); req.end();
});
const peerFingerprint = port => new Promise((res, rej) => {
  const s = tls.connect({ host: '127.0.0.1', port, servername: 'local.gdtmidia.com.br', rejectUnauthorized: false }, () => { const fp = s.getPeerCertificate().fingerprint256; s.end(); res(fp); });
  s.on('error', rej);
});

test('com certificado: HTTPS no ar (cadeia válida p/ o domínio) + HTTP segue disponível; /health mostra o status', { skip }, async () => {
  const c = mkcert('a');
  const s = await launch(baseConfig({ httpsCertPath: c.cert, httpsKeyPath: c.key }));
  try {
    const r = await getJson(s.httpsPort, '/health', { secure: true, ca: fs.readFileSync(c.cert) }); // valida de verdade (sem -k)
    assert.equal(r.status, 200); assert.equal(r.json.ok, true);
    assert.equal(r.json.https.enabled, true); assert.equal(r.json.https.error, null);
    assert.match(r.json.https.subject, /local\.gdtmidia\.com\.br/); assert.ok(r.json.https.daysLeft >= 29);
    assert.equal((await getJson(s.httpPort, '/health')).json.https.enabled, true);
    assert.ok(s.l.info.some(m => /HTTPS ativo/.test(m)));
    assert.equal(s.l.warn.length + s.l.error.length, 0);
  } finally { await s.stop(); }
});

test('sem HTTPS_CERT_PATH/KEY no .env: cai para HTTP com aviso CLARO no log', async () => {
  const s = await launch(baseConfig({}));
  try {
    assert.equal(s.servers.https, null);
    assert.ok(s.l.warn.some(m => /HTTPS DESLIGADO/.test(m) && /GUIA-WINDOWS/.test(m) && /PWA/.test(m)), 'aviso explica a consequência e onde resolver');
    const r = await getJson(s.httpPort, '/health');
    assert.equal(r.status, 200); assert.equal(r.json.https.enabled, false); assert.equal(r.json.https.error, 'not-configured');
  } finally { await s.stop(); }
});

test('arquivo inexistente / só um dos dois / chave que não casa / lixo → HTTP + erro dizendo exatamente o quê', { skip }, async () => {
  const a = mkcert('x1'), b = mkcert('x2');
  const garbage = path.join(dir, 'lixo.pem'); fs.writeFileSync(garbage, 'isto não é um certificado');
  const cases = [
    [{ httpsCertPath: path.join(dir, 'nao-existe.pem'), httpsKeyPath: a.key }, 'missing-file', /não encontrado.*nao-existe\.pem.*HTTPS_CERT_PATH/],
    [{ httpsCertPath: a.cert, httpsKeyPath: path.join(dir, 'sem-chave.pem') }, 'missing-file', /sem-chave\.pem.*HTTPS_KEY_PATH/],
    [{ httpsCertPath: a.cert }, 'incomplete', /HTTPS_CERT_PATH E HTTPS_KEY_PATH/],
    [{ httpsCertPath: a.cert, httpsKeyPath: b.key }, 'key-mismatch', /não corresponde/],
    [{ httpsCertPath: garbage, httpsKeyPath: a.key }, 'invalid', /inválidos/],
  ];
  for (const [extra, code, re] of cases) {
    const s = await launch(baseConfig(extra));
    try {
      assert.equal(s.servers.https, null, code);
      assert.equal(s.servers.tls().error, code);
      assert.ok(s.l.error.some(m => /HTTPS DESLIGADO/.test(m) && re.test(m)), `${code}: ${s.l.error}`);
      assert.equal((await getJson(s.httpPort, '/health')).status, 200, 'o servidor segue de pé em HTTP');
    } finally { await s.stop(); }
  }
});

test('porta HTTPS ocupada (EADDRINUSE): não derruba o servidor, explica e segue em HTTP', { skip }, async () => {
  const c = mkcert('busy');
  const blocker = net.createServer(); await new Promise(r => blocker.listen(0, '0.0.0.0', r));
  try {
    const s = await launch(baseConfig({ httpsCertPath: c.cert, httpsKeyPath: c.key, httpsPort: blocker.address().port }));
    try {
      assert.equal(s.servers.https, null); assert.equal(s.servers.tls().error, 'EADDRINUSE');
      assert.ok(s.l.error.some(m => /já está em uso/.test(m) && /netstat/.test(m)));
      assert.equal((await getJson(s.httpPort, '/health')).status, 200);
    } finally { await s.stop(); }
  } finally { blocker.close(); }
});

test('certificado perto de vencer gera aviso; renovação (arquivos trocados) é recarregada SEM reiniciar', { skip }, async () => {
  const old = mkcert('old', 5), fresh = mkcert('fresh', 90);
  const cert = path.join(dir, 'live-chain.pem'), key = path.join(dir, 'live-key.pem');
  fs.copyFileSync(old.cert, cert); fs.copyFileSync(old.key, key);
  const s = await launch(baseConfig({ httpsCertPath: cert, httpsKeyPath: key }));
  try {
    assert.ok(s.l.warn.some(m => /vence em \d+ dia/.test(m)), 'aviso de vencimento próximo');
    const fpOld = await peerFingerprint(s.httpsPort);
    assert.equal(loadTls({ httpsCertPath: old.cert, httpsKeyPath: old.key }).info.fingerprint, fpOld);
    fs.copyFileSync(fresh.key, key); fs.copyFileSync(fresh.cert, cert); // o win-acme gravou os arquivos novos
    let fpNew = fpOld;
    for (let i = 0; i < 40 && fpNew === fpOld; i++) { await new Promise(r => setTimeout(r, 150)); fpNew = await peerFingerprint(s.httpsPort); }
    assert.notEqual(fpNew, fpOld, 'servidor passou a apresentar o certificado novo');
    assert.equal(loadTls({ httpsCertPath: fresh.cert, httpsKeyPath: fresh.key }).info.fingerprint, fpNew);
    assert.ok(s.l.info.some(m => /recarregado/.test(m)));
    assert.ok(s.servers.tls().daysLeft >= 89, '/health reflete o prazo novo');
  } finally { await s.stop(); }
});

// ── CORS / Private Network Access ──────────────────────────────────────────
test('preflight da origem de produção: ACAO + Access-Control-Allow-Private-Network: true + headers do app', async () => {
  const s = await launch(baseConfig({}));
  try {
    const origin = 'https://campori.gdtmidia.com.br';
    const r = await getJson(s.httpPort, '/sync/scans', { method: 'OPTIONS', headers: {
      Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type', 'Access-Control-Request-Private-Network': 'true' } });
    assert.equal(r.status, 204);
    assert.equal(r.headers['access-control-allow-origin'], origin);
    assert.equal(r.headers['access-control-allow-private-network'], 'true');
    assert.match(r.headers['access-control-allow-headers'], /authorization/i);
    assert.match(r.headers['access-control-allow-methods'], /POST/);
    assert.match(r.headers.vary || '', /Origin/i);
  } finally { await s.stop(); }
});

test('CORS: localhost (dev) e o próprio domínio local passam; origem desconhecida NÃO recebe cabeçalhos (nem Private Network)', async () => {
  const s = await launch(baseConfig({}));
  try {
    const pre = origin => getJson(s.httpPort, '/sync/scans', { method: 'OPTIONS', headers: { Origin: origin, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Private-Network': 'true' } });
    for (const o of ['http://localhost:5500', 'http://127.0.0.1:8787', 'https://local.gdtmidia.com.br']) {
      const r = await pre(o); assert.equal(r.headers['access-control-allow-origin'], o, o); assert.equal(r.headers['access-control-allow-private-network'], 'true', o);
    }
    for (const o of ['https://evil.example', 'https://campori.gdtmidia.com.br.evil.example', 'http://campori.gdtmidia.com.br']) {
      const r = await pre(o);
      assert.equal(r.headers['access-control-allow-origin'], undefined, o);
      assert.equal(r.headers['access-control-allow-private-network'], undefined, o);
    }
    // origens extras via CORS_ORIGINS
    const s2 = await launch(baseConfig({ corsOrigins: ['https://extra.example'] }));
    try { assert.equal((await getJson(s2.httpPort, '/health', { headers: { Origin: 'https://extra.example' } })).headers['access-control-allow-origin'], 'https://extra.example'); } finally { await s2.stop(); }
  } finally { await s.stop(); }
});

test('/health: sem autenticação, leve, e legível pelo app de produção (ACAO) — origem estranha não lê', async () => {
  const s = await launch(baseConfig({}));
  try {
    const t0 = Date.now();
    const ok = await getJson(s.httpPort, '/health', { headers: { Origin: 'https://campori.gdtmidia.com.br' } });
    assert.equal(ok.status, 200); assert.equal(ok.json.ok, true); assert.equal(ok.json.mode, 'local');
    assert.equal(ok.headers['access-control-allow-origin'], 'https://campori.gdtmidia.com.br');
    assert.ok(Date.now() - t0 < 500);
    const evil = await getJson(s.httpPort, '/health', { headers: { Origin: 'https://evil.example' } });
    assert.equal(evil.status, 200); assert.equal(evil.headers['access-control-allow-origin'], undefined);
    assert.equal((await getJson(s.httpPort, '/health')).status, 200); // sem Origin (curl, abrir no navegador)
  } finally { await s.stop(); }
});

// ── Certificado e chave jamais no git nem no deploy ─────────────────────────
test('git e deploy ignoram certificados/chaves/.env', () => {
  const root = path.resolve(import.meta.dirname, '..', '..');
  let git = true; try { execFileSync('git', ['--version'], { stdio: 'ignore' }); } catch { git = false; }
  if (git) {
    for (const f of ['local-server/certs/local.gdtmidia.com.br-chain.pem', 'local-server/certs/local.gdtmidia.com.br-key.pem', 'local-server/cert.crt', 'local-server/server.key',
      'local-server/x.pfx', 'local-server/.env', 'qualquer/lugar/chave.pem']) {
      try { execFileSync('git', ['check-ignore', '-q', '--no-index', f], { cwd: root }); } catch { assert.fail(`${f} NÃO está no .gitignore`); }
    }
    assert.throws(() => execFileSync('git', ['check-ignore', '-q', '--no-index', 'local-server/.env.example'], { cwd: root, stdio: 'ignore' }), 'o .env.example continua versionado');
  }
  const vercel = fs.readFileSync(path.join(root, '.vercelignore'), 'utf8').split('\n').map(s => s.trim());
  for (const l of ['local-server', '*.pem', '*.key', 'certs']) assert.ok(vercel.includes(l), `.vercelignore sem "${l}"`);
  // o Fly só enxerga server/: nada de certificado lá dentro
  const strays = []; (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { if (e.name === 'node_modules') continue; const p = path.join(d, e.name); e.isDirectory() ? walk(p) : /\.(pem|key|crt|pfx|p12)$/.test(e.name) && strays.push(p); } })(path.join(root, 'server'));
  assert.deepEqual(strays, []);
});
