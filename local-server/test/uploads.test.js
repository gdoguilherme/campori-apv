// Etapa B — fotos/comprovações ficam SÓ no PC: upload local, URL relativa que vale em qualquer endereço,
// nuvem mostra "disponível apenas no PC", painel /status com tamanho dos uploads e backup-uploads.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';
import { register } from 'node:module';
import { pathToFileURL } from 'node:url';
import { Store } from '../src/db.js';
import { createApp } from '../src/app.js';
import { REPO_ROOT } from '../src/config.js';
import { backupUploads, dirStats, diskFree } from '../src/ops.js';
import { buildSummary } from '../src/sync/status.js';
import { localProofPath, proofFileName, resolveProof } from '../../shared/proof.js';

const FAKE = pathToFileURL(path.resolve(REPO_ROOT, 'local-server/test/fake-firebase-capture.js')).href;
register('data:text/javascript,' + encodeURIComponent(`export async function resolve(s, c, n) { return n(s === './firebase.js' ? ${JSON.stringify(FAKE)} : s, c); }`));

let srv, port, store, tmp, uploadDir, config, cloudApi;
const raw = (hostHeader, p, opts = {}) => new Promise((res, rej) => {
  const r = http.request({ host: '127.0.0.1', port, path: p, method: opts.method || 'GET', headers: { host: hostHeader, ...(opts.headers || {}) } }, x => { const c = []; x.on('data', d => c.push(d)); x.on('end', () => res({ status: x.statusCode, headers: x.headers, body: Buffer.concat(c) })); });
  r.on('error', rej); if (opts.body) r.write(opts.body); r.end();
});
const multipart = (name, content, fields) => {
  const b = '----t' + Date.now();
  const parts = [`--${b}\r\nContent-Disposition: form-data; name="file"; filename="${name}"\r\nContent-Type: application/octet-stream\r\n\r\n`, content, '\r\n',
    ...Object.entries(fields).map(([k, v]) => `--${b}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`), `--${b}--\r\n`];
  return { headers: { 'content-type': `multipart/form-data; boundary=${b}` }, body: Buffer.from(parts.join('')) };
};

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'campori-up-'));
  uploadDir = path.join(tmp, 'uploads');
  config = { port: 0, qrSecret: 's', jwtSecret: 'j', qrSecretIsDev: false, version: 't', uploadDir, backupDir: path.join(tmp, 'backups'), corsOrigins: [], frontendDir: null, statusPin: '' };
  store = new Store(':memory:');
  const app = createApp({ store, config, log: { info() {}, warn() {}, error() {} } });
  srv = await new Promise(r => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  port = srv.address().port;
  globalThis.location = { hostname: 'campori.gdtmidia.com.br', port: '', origin: 'https://campori.gdtmidia.com.br' };
  globalThis.localStorage = { getItem: () => null };
  globalThis.document = { createElement: () => ({ style: {}, remove() {} }), body: { appendChild() {} } };
  cloudApi = await import('../../js/api.js'); // modo NUVEM (sem flag do servidor local)
});
after(() => { srv.closeAllConnections?.(); srv.close(); store.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('upload local grava em data/uploads e devolve URL RELATIVA; abre por domínio e por IP', async () => {
  const m = multipart('foto.png', 'PNGDATA', { reqCode: 'RA', regionId: 'R1' });
  const up = await raw('127.0.0.1:8787', '/upload', { method: 'POST', ...m });
  assert.equal(up.status, 200);
  const { url, name } = JSON.parse(up.body);
  assert.match(url, /^\/files\/R1\/RA-\d+-[0-9a-f]{6}\.png$/);
  assert.ok(fs.existsSync(path.join(uploadDir, 'R1', name)), 'arquivo no disco do PC');
  for (const host of ['local.gdtmidia.com.br', '192.168.0.50:8787', 'localhost:8787']) {
    const r = await raw(host, url);
    assert.equal(r.status, 200, host); assert.equal(r.body.toString(), 'PNGDATA');
    assert.equal(r.headers['x-content-type-options'], 'nosniff');
  }
});

test('segurança de /files: html/svg ganham sandbox; não sai da pasta (../)', async () => {
  fs.mkdirSync(path.join(uploadDir, 'R1'), { recursive: true });
  fs.writeFileSync(path.join(uploadDir, 'R1', 'x.html'), '<script>alert(1)</script>');
  fs.writeFileSync(path.join(tmp, 'segredo.txt'), 'nao-sair');
  const h = await raw('x', '/files/R1/x.html');
  assert.match(h.headers['content-security-policy'], /sandbox/);
  const t = await raw('x', '/files/..%2fsegredo.txt'); const t2 = await raw('x', '/files/R1/%2e%2e/%2e%2e/segredo.txt');
  assert.ok(![t.status, t2.status].includes(200) && !t.body.toString().includes('nao-sair') && !t2.body.toString().includes('nao-sair'));
});

test('resolveProof: relativo e URLs antigas de host local viram o MESMO caminho; Drive/outros ficam como estão', () => {
  assert.equal(localProofPath('/files/R1/a.jpg'), '/files/R1/a.jpg');
  assert.equal(localProofPath('http://192.168.0.50:8787/files/R1/a.jpg'), '/files/R1/a.jpg');
  assert.equal(localProofPath('https://local.gdtmidia.com.br/files/R1/a%20b.jpg'), '/files/R1/a%20b.jpg');
  assert.equal(localProofPath('https://drive.google.com/file/d/xyz/view'), null);
  assert.equal(localProofPath('https://evil.example.com/files/R1/a.jpg'), null, 'host não local não é "arquivo do PC"');
  assert.equal(proofFileName('/files/R1/a%20b.jpg'), 'a b.jpg');
  assert.deepEqual(resolveProof('/files/R1/a.jpg', { isLocalApp: true, origin: 'https://local.gdtmidia.com.br' }), { kind: 'local', src: 'https://local.gdtmidia.com.br/files/R1/a.jpg', name: 'a.jpg' });
  assert.equal(resolveProof('http://192.168.0.9:8787/files/R1/a.jpg', { isLocalApp: true, origin: 'http://192.168.0.50:8787' }).src, 'http://192.168.0.50:8787/files/R1/a.jpg', 'abre pelo endereço em que a pessoa está');
  assert.deepEqual(resolveProof('/files/R1/a.jpg', { isLocalApp: false }), { kind: 'pc-only', name: 'a.jpg' });
  assert.deepEqual(resolveProof('https://drive.google.com/x', { isLocalApp: false }), { kind: 'remote', src: 'https://drive.google.com/x' });
  assert.deepEqual(resolveProof(null), { kind: 'none' });
});

test('NUVEM: proofBlock mostra "foto disponível apenas no PC do evento" (nunca link quebrado); Drive/vazio como antes', () => {
  const pc = cloudApi.proofBlock('/files/R1/RA-1-abc.jpg');
  assert.match(pc, /Foto disponível apenas no PC do evento/); assert.match(pc, /RA-1-abc\.jpg/);
  assert.ok(!pc.includes('<img') && !pc.includes('href='));
  assert.match(cloudApi.proofBlock('http://192.168.0.9:8787/files/R1/x.jpg'), /apenas no PC do evento/);
  assert.match(cloudApi.proofBlock('https://drive.google.com/file/d/1/view'), /Abrir PDF/);
  assert.match(cloudApi.proofBlock(null), /Sem arquivo anexado/);
});

test('/status: nº de arquivos, tamanho e o aviso "ficam só neste PC"', () => {
  const s = buildSummary({ store, config, engine: null, startedAt: Date.now() });
  assert.ok(s.uploads.count >= 2); assert.ok(s.uploads.bytes > 0); assert.match(s.uploads.size, /B|KB|MB/);
  assert.match(s.uploads.warning, /só neste PC.*copie ao fim do dia/);
  assert.equal(s.uploads.count, dirStats(uploadDir).count);
  assert.doesNotThrow(() => buildSummary({ store, config: { ...config, uploadDir: '/proc/1/fd' }, engine: null, startedAt: Date.now() }), 'pasta ilegível não derruba o painel');
});

test('backupUploads: copia, confere, aceita destino (pen-drive), não sobrescreve nem entra em si mesmo', () => {
  const stick = path.join(tmp, 'pendrive');
  const a = backupUploads({ uploadDir, destRoot: stick, now: new Date(2026, 9, 9, 18, 30) });
  assert.ok(a.ok); assert.equal(a.dest, path.join(stick, 'uploads-20261009-1830'));
  assert.equal(dirStats(a.dest).count, dirStats(uploadDir).count);
  const b = backupUploads({ uploadDir, destRoot: stick, now: new Date(2026, 9, 9, 18, 30) });
  assert.notEqual(b.dest, a.dest, 'no mesmo minuto cria outra pasta'); assert.ok(b.ok);
  assert.throws(() => backupUploads({ uploadDir, destRoot: path.join(uploadDir, 'dentro') }), /dentro de data\/uploads/);
  assert.equal(backupUploads({ uploadDir: path.join(tmp, 'nao-existe'), destRoot: stick }).empty, true);
  assert.ok(diskFree(tmp)?.freeBytes > 0);
});

test('npm run backup-uploads (CLI): padrão em backups/ e destino informado', () => {
  const data = path.join(tmp, 'cli-data'); fs.mkdirSync(path.join(data, 'uploads', 'R9'), { recursive: true });
  fs.writeFileSync(path.join(data, 'uploads', 'R9', 'f.jpg'), 'abc');
  const env = { ...process.env, DATA_DIR: data, ALLOW_DEV_SECRETS: '1' };
  const run = args => spawnSync(process.execPath, ['scripts/backup-uploads.js', ...args], { cwd: path.join(REPO_ROOT, 'local-server'), env, encoding: 'utf8' });
  const stick = path.join(tmp, 'usb');
  const r = run([stick]);
  assert.equal(r.status, 0, r.stderr + r.stdout); assert.match(r.stdout, /1 arquivo\(s\) copiados e conferidos/);
  assert.ok(fs.readdirSync(stick).some(d => d.startsWith('uploads-')));
  const bad = run([path.join(data, 'uploads', 'x')]);
  assert.notEqual(bad.status, 0); assert.match(bad.stderr, /dentro de data\/uploads/);
});
