// Etapa E — operação do evento no PC: /status ampliado + backup baixável, npm run preflight, npm run resetar-eventos-de-teste.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { execFileSync, spawnSync } from 'node:child_process';
import { Store } from '../src/db.js';
import { createApp } from '../src/app.js';
import { buildSummary } from '../src/sync/status.js';
import { runPreflight, formatPreflight, EVENT_HOST } from '../src/preflight.js';
import { runReset, RESET_COLLECTIONS } from '../src/reset-events.js';
import { collectionCounts, lastBackup } from '../src/ops.js';
import { seedScenario } from './helpers.js';
import { REPO_ROOT } from '../src/config.js';

const hasOpenssl = (() => { try { execFileSync('openssl', ['version'], { stdio: 'ignore' }); return true; } catch { return false; } })();
let tmp, store, config;
const log = { info() {}, warn() {}, error() {} };

before(async () => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'campori-ops-'));
  config = { port: 8787, httpsPort: 443, qrSecret: 's', jwtSecret: 'j', qrSecretIsDev: false, version: 't', uploadDir: path.join(tmp, 'uploads'), backupDir: path.join(tmp, 'backups'),
    dbPath: path.join(tmp, 'campori-local.db'), corsOrigins: [], frontendDir: null, statusPin: 'pin123', cloudSync: true, backupEveryMin: 10 };
  store = new Store(config.dbPath); await seedScenario(store);
  store.insert('participants', { name: 'P', regionId: 'R1', unitId: 'U1' }, 'p1');
  store.insert('submissions', { regionId: 'R1', unitId: 'U1', requirementId: 'RS', requirementPoints: 7, status: 'approved', source: 'region' }, 's1');
  store.insert('submissions', { regionId: 'R1', unitId: 'U2', requirementId: 'RS', requirementPoints: 7, status: 'pending', source: 'region' }, 's2');
  store.insert('disciplinaryActions', { targetType: 'unit', targetId: 'U1', targetName: 'Unidade 1', reason: 'x', points: 5 }, 'd1');
  store.insert('auditLog', { action: 'approved', submissionId: 's1' }, 'a1');
});
after(() => { store.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

// ── E.1 /status ───────────────────────────────────────────────────────────────────────────
test('/status: contagens, espaço em disco, certificado, uploads, último backup', () => {
  fs.mkdirSync(config.backupDir, { recursive: true }); fs.writeFileSync(path.join(config.backupDir, 'campori-20261009-1200.db'), 'x');
  const s = buildSummary({ store, config, engine: null, startedAt: Date.now(), tls: { enabled: true, daysLeft: 41, validTo: '2026-11-19T00:00:00Z' } });
  assert.deepEqual(s.ops.counts.submissions, { total: 2, pending: 1, approved: 1, rejected: 0 });
  assert.equal(s.ops.counts.regions, 2); assert.equal(s.ops.counts.units, 3); assert.equal(s.ops.counts.requirements, 4); assert.equal(s.ops.counts.users, 6);
  assert.ok(s.ops.disk.freeBytes > 0 && typeof s.ops.disk.free === 'string');
  assert.equal(s.ops.cert.daysLeft, 41); assert.equal(s.ops.backup.count, 1);
  assert.ok('count' in s.uploads); assert.ok('lastSuccessAt' in s.sync);
  assert.equal(lastBackup(path.join(tmp, 'nao-existe')), null);
  assert.equal(collectionCounts(store).disciplinaryActions, 1);
});

const req = (port, p, headers = {}) => new Promise((res, rej) => http.get({ host: '127.0.0.1', port, path: p, headers }, r => { const c = []; r.on('data', d => c.push(d)); r.on('end', () => res({ status: r.statusCode, headers: r.headers, body: Buffer.concat(c) })); }).on('error', rej));
test('Baixar backup agora: PIN protege, gera SQLite válido e guarda cópia em backups/; a página tem o botão', async () => {
  const app = createApp({ store, config, log, tls: () => ({ enabled: false }), isLocalRequest: () => false });
  const srv = await new Promise(r => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  try {
    const port = srv.address().port;
    assert.equal((await req(port, '/status/api/backup')).status, 401, 'fora do PC sem PIN não baixa o banco');
    assert.equal((await req(port, '/status/api/backup', { 'x-status-pin': 'errado' })).status, 401);
    const ok = await req(port, '/status/api/backup', { 'x-status-pin': 'pin123' });
    assert.equal(ok.status, 200); assert.match(ok.headers['content-disposition'], /campori-\d{8}-\d{4}-manual\.db/);
    assert.equal(ok.body.subarray(0, 15).toString(), 'SQLite format 3');
    assert.ok(fs.readdirSync(config.backupDir).some(f => f.endsWith('-manual.db')));
    const page = (await req(port, '/status/')).body.toString();
    assert.match(page, /Baixar backup agora/); assert.match(page, /Operação do PC/);
    const sum = JSON.parse((await req(port, '/status/api/summary', { 'x-status-pin': 'pin123' })).body);
    assert.equal(sum.ops.counts.submissions.total, 2); assert.equal(sum.ops.cert.enabled, false);
  } finally { srv.closeAllConnections?.(); srv.close(); }
});

// ── E.2 preflight ─────────────────────────────────────────────────────────────────────────
const goodDeps = (over = {}) => ({
  nodeVersion: () => '22.14.0', portFree: async () => true, isOurServer: async () => false, resolveHost: async () => ['192.168.50.10'],
  localIps: () => ['192.168.50.10', '10.0.0.5'], cloudProbe: async () => true, envFileExists: () => true, credentialsFile: () => path.join(tmp, 'cred.json'), ...over,
});
const env = { QR_SECRET: 'segredo-de-verdade-123' };
let certCfg;
test('preflight: tudo certo → ✅ para cada item e código de saída 0', { skip: hasOpenssl ? false : 'openssl não encontrado' }, async () => {
  fs.writeFileSync(path.join(tmp, 'cred.json'), '{}');
  const key = path.join(tmp, 'k.pem'), cert = path.join(tmp, 'c.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '60', '-subj', `/CN=${EVENT_HOST}`], { stdio: 'ignore' });
  certCfg = { ...config, httpsCertPath: cert, httpsKeyPath: key };
  fs.writeFileSync(path.join(config.backupDir, 'campori-fresh.db'), 'x');
  const r = await runPreflight({ config: certCfg, env, deps: goodDeps() });
  assert.deepEqual(r.checks.filter(c => c.level !== 'ok').map(c => `${c.id}:${c.level}:${c.detail}`), []);
  assert.equal(r.ok, true); assert.deepEqual(r.checks.map(c => c.id), ['node', 'env', 'cloud-sync', 'cert', 'port-https', 'port-http', 'db', 'backup', 'disk', 'dns', 'cloud']);
  const txt = formatPreflight(r); assert.match(txt, /✅ Node\.js 22\.14\.0/); assert.match(txt, /✅ PRONTO/);
});

const only = async (over, cfg = certCfg || config, e = env) => (await runPreflight({ config: cfg, env: e, deps: goodDeps(over) }));
const lvl = (r, id) => r.checks.find(c => c.id === id).level;
test('preflight: cada problema vira ❌ com a instrução do que fazer (e os informativos viram ⚠️ sem bloquear)', { skip: hasOpenssl ? false : 'openssl não encontrado' }, async () => {
  let r = await only({ nodeVersion: () => '20.11.0' }); assert.equal(lvl(r, 'node'), 'fail'); assert.equal(r.ok, false); assert.match(formatPreflight(r), /❌ Node\.js 20\.11\.0/);
  r = await only({ envFileExists: () => false }); assert.equal(lvl(r, 'env'), 'fail');
  r = await only({}, certCfg, {}); assert.equal(lvl(r, 'env'), 'fail'); assert.match(r.checks.find(c => c.id === 'env').title, /QR_SECRET/);
  r = await only({}, { ...certCfg, cloudSync: false }); assert.equal(lvl(r, 'cloud-sync'), 'fail');
  r = await only({ credentialsFile: () => path.join(tmp, 'nao-tem.json') }); assert.equal(lvl(r, 'cloud-sync'), 'fail');
  r = await only({}, { ...certCfg, httpsCertPath: null, httpsKeyPath: null }); assert.equal(lvl(r, 'cert'), 'fail');
  r = await only({}, { ...certCfg, httpsKeyPath: path.join(tmp, 'c.pem') }); assert.equal(lvl(r, 'cert'), 'fail', 'chave que não casa com o certificado');
  r = await only({ portFree: async p => p !== 443 }); assert.equal(lvl(r, 'port-https'), 'fail'); assert.equal(lvl(r, 'port-http'), 'ok');
  r = await only({ portFree: async () => false, isOurServer: async () => true }); assert.equal(lvl(r, 'port-http'), 'ok', 'porta em uso pelo próprio servidor do Campori é ok');
  r = await only({}, { ...certCfg, dbPath: path.join(tmp, 'sumiu.db') }); assert.equal(lvl(r, 'db'), 'fail');
  r = await only({ resolveHost: async () => ['203.0.113.9'] }); assert.equal(lvl(r, 'dns'), 'fail'); assert.match(r.checks.find(c => c.id === 'dns').title, /203\.0\.113\.9/);
  r = await only({ resolveHost: async () => { throw Object.assign(new Error('x'), { code: 'ENOTFOUND' }); } }); assert.equal(lvl(r, 'dns'), 'warn'); assert.equal(r.ok, true, 'DNS sem internet é aviso, não bloqueio');
  r = await only({ cloudProbe: async () => false }); assert.equal(lvl(r, 'cloud'), 'warn'); assert.equal(r.ok, true, 'nuvem é informativa');
  const old = path.join(tmp, 'bk-old'); fs.mkdirSync(old); const f = path.join(old, 'campori-old.db'); fs.writeFileSync(f, 'x'); const past = new Date(Date.now() - 40 * 60000); fs.utimesSync(f, past, past);
  r = await only({}, { ...certCfg, backupDir: old }); assert.equal(lvl(r, 'backup'), 'fail'); assert.match(r.checks.find(c => c.id === 'backup').title, /há 4\d min/);
  r = await only({}, { ...certCfg, backupDir: path.join(tmp, 'vazio') }); assert.equal(lvl(r, 'backup'), 'fail');
});

test('preflight: banco vazio é ❌ e certificado perto de vencer é ⚠️', { skip: hasOpenssl ? false : 'openssl não encontrado' }, async () => {
  const empty = path.join(tmp, 'vazio.db'); new Store(empty).close();
  assert.equal(lvl(await only({}, { ...certCfg, dbPath: empty }), 'db'), 'fail');
  const key = path.join(tmp, 'k2.pem'), cert = path.join(tmp, 'c2.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', key, '-out', cert, '-days', '5', '-subj', `/CN=${EVENT_HOST}`], { stdio: 'ignore' });
  const r = await only({}, { ...certCfg, httpsCertPath: cert, httpsKeyPath: key }); assert.equal(lvl(r, 'cert'), 'warn'); assert.equal(r.ok, true);
});

test('npm run preflight (CLI): imprime o relatório e sai com código ≠ 0 quando falta algo', () => {
  const data = path.join(tmp, 'cli'); fs.mkdirSync(data);
  const r = spawnSync(process.execPath, ['scripts/preflight.js'], { cwd: path.join(REPO_ROOT, 'local-server'), env: { ...process.env, DATA_DIR: data, QR_SECRET: '', ALLOW_DEV_SECRETS: '1', HTTPS_CERT_PATH: '', HTTPS_KEY_PATH: '' }, encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 1); assert.match(r.stdout, /Verificando o PC do evento/); assert.match(r.stdout, /❌/); assert.match(r.stdout, /para corrigir antes do evento/);
});

// ── E.3 resetar-eventos-de-teste ──────────────────────────────────────────────────────────
const mkIo = answers => { const out = [], err = []; const q = [...answers]; return { out: s => out.push(s), err: s => err.push(s), ask: async p => { out.push(p); return q.shift() ?? ''; }, outText: () => out.join('\n'), errText: () => err.join('\n') }; };
const freshStore = async () => { const s = new Store(':memory:'); await seedScenario(s);
  s.insert('submissions', { regionId: 'R1', unitId: 'U1', requirementId: 'RS', status: 'approved', requirementPoints: 7 }, 'x1'); s.insert('submissions', { regionId: 'R1', requirementId: 'RA', status: 'pending', requirementPoints: 10 }, 'x2');
  s.insert('disciplinaryActions', { targetType: 'unit', targetId: 'U1', reason: 'x', points: 5 }, 'dx'); s.insert('auditLog', { action: 'approved' }, 'ax'); return s; };
const cfgFor = name => ({ ...config, dbPath: ':memory:', backupDir: path.join(tmp, name) });

test('reset: confirmação dupla + backup ANTES; remove só submissões/disciplinas/auditoria; mantém o resto; exclusões vão para a nuvem (dirty)', async () => {
  const s = await freshStore();
  const keep = { regions: s.count('regions'), units: s.count('units'), participants: s.count('participants'), requirements: s.count('requirements'), users: s.count('users') };
  const io = mkIo(['SIM', 'APAGAR 4']);
  assert.equal(await runReset({ store: s, config: cfgFor('bk-reset'), io }), 0);
  for (const c of RESET_COLLECTIONS) assert.equal(s.count(c), 0, c);
  for (const [c, n] of Object.entries(keep)) assert.equal(s.count(c), n, `${c} mantido`);
  assert.ok(fs.readdirSync(path.join(tmp, 'bk-reset')).some(f => /^campori-pre-reset-\d{8}-\d{4}\.db$/.test(f)), 'backup antes');
  assert.match(io.outText(), /Backup feito/); assert.match(io.outText(), /Limpo\. Removidos: 4/);
  assert.ok(s.listDirty('submissions').some(r => r.deleted), 'tombstone para a nuvem');
  assert.ok(s.listEvents({ limit: 5 }).some(e => e.kind === 'reset-test-events'));
  assert.equal(await runReset({ store: s, config: cfgFor('bk-reset'), io: mkIo([]) }), 0, 'sem nada a limpar não pergunta nada');
  s.close();
});

test('reset: qualquer resposta errada CANCELA sem alterar (e sem backup); --dry-run só mostra; --so-local apaga sem tombstone', async () => {
  for (const answers of [[], ['sim'.slice(0, 1)], ['SIM', ''], ['SIM', 'APAGAR'], ['SIM', 'APAGAR 3'], ['talvez']]) {
    const s = await freshStore(); const io = mkIo(answers);
    assert.equal(await runReset({ store: s, config: cfgFor('bk-nao'), io }), 1, JSON.stringify(answers));
    assert.equal(s.count('submissions'), 2); assert.equal(s.count('disciplinaryActions'), 1); assert.match(io.outText(), /Cancelado/);
    s.close();
  }
  assert.ok(!fs.existsSync(path.join(tmp, 'bk-nao')), 'cancelou antes do backup: nada criado');
  let s = await freshStore();
  assert.equal(await runReset({ store: s, config: cfgFor('bk-dry'), io: mkIo([]), flags: { dryRun: true } }), 0); assert.equal(s.count('submissions'), 2); s.close();
  s = await freshStore();
  assert.equal(await runReset({ store: s, config: cfgFor('bk-local'), io: mkIo(['SIM', 'APAGAR 4']), flags: { soLocal: true } }), 0);
  assert.equal(s.count('submissions'), 0); assert.equal(s.listDirty('submissions').filter(r => r.deleted).length, 0, 'sem tombstone: não propaga'); s.close();
});

test('reset: se o backup falhar, NADA é apagado', async () => {
  const s = await freshStore(); fs.writeFileSync(path.join(tmp, 'arquivo-no-lugar-da-pasta'), 'x');
  const io = mkIo(['SIM', 'APAGAR 4']);
  assert.equal(await runReset({ store: s, config: { ...cfgFor('x'), backupDir: path.join(tmp, 'arquivo-no-lugar-da-pasta', 'sub') }, io }), 2);
  assert.equal(s.count('submissions'), 2); assert.equal(s.count('disciplinaryActions'), 1); assert.match(io.errText(), /NADA foi apagado/); s.close();
});

test('npm run resetar-eventos-de-teste (CLI): stdin fechado = cancelar (nunca apaga sozinho)', () => {
  const data = path.join(tmp, 'cli-reset'); fs.mkdirSync(data);
  const db = new Store(path.join(data, 'campori-local.db')); db.insert('submissions', { status: 'approved', regionId: 'R1' }, 'q1'); db.close();
  const r = spawnSync(process.execPath, ['scripts/resetar-eventos-de-teste.js'], { cwd: path.join(REPO_ROOT, 'local-server'), env: { ...process.env, DATA_DIR: data, ALLOW_DEV_SECRETS: '1' }, input: '', encoding: 'utf8', timeout: 60000 });
  assert.equal(r.status, 1); assert.match(r.stdout, /Cancelado/);
  const chk = new Store(path.join(data, 'campori-local.db')); assert.equal(chk.count('submissions'), 1); chk.close();
});
