// QR Codes em lote — entrega 2: npm run gerar-qrcodes (PNG + TODOS-OS-QRCODES.pdf) e /status.
// Cada QR gerado é DECODIFICADO da imagem (jsQR) e resgatado contra o /qr/redeem do servidor local.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import bcrypt from 'bcryptjs';
import jsQR from 'jsqr';
import { PNG } from 'pngjs';
import { spawnSync } from 'node:child_process';
import { Store } from '../src/db.js';
import { createApp } from '../src/app.js';
import { createAuth } from '../src/auth.js';
import { generateQrFiles, qrStatus, defaultQrDir, qrRaster, pngGray, MANIFEST, PDF_NAME } from '../src/qrcodes.js';
import { buildSummary } from '../src/sync/status.js';
import { collectQrJobs } from '../../shared/qrsheet.js';
import { REPO_ROOT } from '../src/config.js';
import { QR_SECRET, startTestServer, seedScenario } from './helpers.js';
import { inspectPdf } from './pdf-check.js';

let t, tmp, config;
const decodeRgba = (data, width, height) => jsQR(new Uint8ClampedArray(data), width, height)?.data ?? null;
const decodePng = file => { const png = PNG.sync.read(fs.readFileSync(file)); return { text: decodeRgba(png.data, png.width, png.height), width: png.width, height: png.height }; };
const grayToRgba = ({ width, height, pixels }) => { const o = new Uint8ClampedArray(width * height * 4); for (let i = 0; i < pixels.length; i++) { o[i * 4] = o[i * 4 + 1] = o[i * 4 + 2] = pixels[i]; o[i * 4 + 3] = 255; } return o; };

before(async () => {
  t = await startTestServer(); await seedScenario(t.store);
  // mais provas com QR (incl. nomes com acento/caracteres inválidos) para passar de uma página
  for (let i = 1; i <= 4; i++) t.store.insert('requirements', { name: `Prova ${i}: Orientação/Nós "ç"?`, filledBy: 'conselheiro', points: 20, category: 'Eventos', active: true, order: 10 + i, qrVariants: [{ id: `a${i}`, label: 'Básica', points: 10 }, { id: `b${i}`, label: 'Avançada', points: 20 }] }, `P${i}`);
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'campori-qr-'));
  config = { qrSecret: QR_SECRET, jwtSecret: 'jwt-teste', qrSecretIsDev: false, dbPath: path.join(tmp, 'campori-local.db'), uploadDir: path.join(tmp, 'uploads'), backupDir: path.join(tmp, 'backups'), version: 't', port: 0, corsOrigins: [], frontendDir: null, statusPin: 'pin123' };
});
after(async () => { await t.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

const dest = path.join(os.tmpdir(), `campori-qr-out-${process.pid}`);
let result;

test('gera um PNG por QR (nome <prova>__<variante>__<pontos>pts.png, sem acentos), o PDF e o manifest', async () => {
  fs.rmSync(dest, { recursive: true, force: true });
  result = await generateQrFiles({ store: t.store, config, destDir: dest, now: Date.UTC(2026, 9, 9, 15, 0) });
  assert.equal(result.ok, true);
  const jobs = collectQrJobs(t.store.list('requirements'));
  assert.equal(result.count, jobs.length); assert.ok(jobs.length >= 10);
  const files = fs.readdirSync(dest).sort();
  assert.ok(files.includes(PDF_NAME) && files.includes(MANIFEST));
  const pngs = files.filter(f => f.endsWith('.png'));
  assert.equal(pngs.length, jobs.length);
  for (const f of pngs) assert.match(f, /^[A-Za-z0-9_,-]+__[A-Za-z0-9_,-]+__[0-9,]+pts\.png$/, f);
  assert.ok(pngs.includes('Prova-QR__Basico__5pts.png') && pngs.includes('Outra-prova-QR__Unico__3pts.png'), pngs.join('\n'));
  assert.ok(pngs.some(f => f.startsWith('Prova-1-Orientacao-Nos-c__Basica__10pts')), pngs.join('\n'));
  const manifest = JSON.parse(fs.readFileSync(path.join(dest, MANIFEST), 'utf8'));
  assert.equal(manifest.count, jobs.length); assert.equal(manifest.generatedAt, Date.UTC(2026, 9, 9, 15, 0)); assert.equal(manifest.pdf, PDF_NAME);
});

test('o QR do PNG carrega o payload certo: hash = HMAC do QR_SECRET atual (mesmo algoritmo do servidor), PNG ≥ 340 px', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(dest, MANIFEST), 'utf8'));
  const { signQr } = createAuth({ store: t.store, config });
  for (const f of manifest.files) {
    const img = decodePng(path.join(dest, f.file));
    assert.ok(img.width >= 340 && img.width === img.height, `${f.file}: ${img.width}px`);
    assert.deepEqual(JSON.parse(img.text), { requisitoId: f.requirementId, varianteId: f.variantId, pontos: f.points, hash: signQr(f.requirementId, f.variantId, f.points) }, f.file);
    assert.equal(img.text, JSON.stringify(f.payload), 'mesmo formato (e ordem de campos) do portal do Fiscal');
  }
});

test('CADA QR gerado é aceito pelo /qr/redeem do servidor (valida o hash e pontua a unidade)', async () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(dest, MANIFEST), 'utf8'));
  const hash = await bcrypt.hash('senha123', 4);
  let n = 0;
  for (const f of manifest.files) {
    const uid = `U-qr-${n}`, cid = `c-qr-${n}`; n++;   // usuário em minúsculas (o login normaliza)
    t.store.insert('units', { name: `Unidade QR ${n}`, regionId: 'R1' }, uid);
    t.store.insert('users', { name: cid, username: cid, role: 'counselor', active: true, passwordHash: hash, regionId: 'R1', unitId: uid }, cid);
    const tok = await t.login(cid);
    const payload = JSON.parse(decodePng(path.join(dest, f.file)).text);          // o que o celular leria da imagem
    assert.equal((await t.call('POST', '/qr/verify', payload, tok)).status, 200, `${f.file}: /qr/verify`);
    const r = await t.call('POST', '/qr/redeem', { ...payload, selectedRequirementId: payload.requisitoId }, tok);
    assert.equal(r.status, 200, `${f.file}: ${JSON.stringify(r.body)}`);
    const sub = t.store.list('submissions', { filters: { unitId: uid, requirementId: payload.requisitoId } })[0];
    assert.equal(sub.requirementPoints, f.points, `${f.file}: pontos da variante`); assert.equal(sub.status, 'approved');
  }
  assert.ok(n >= 10);
  // e um QR adulterado NÃO passa
  const bad = JSON.parse(decodePng(path.join(dest, manifest.files[0].file)).text); bad.pontos += 1;
  const tok = await t.login('cons1');
  assert.equal((await t.call('POST', '/qr/verify', bad, tok)).status, 401);
});

test('TODOS-OS-QRCODES.pdf: PDF válido, 6 por página, e cada imagem do PDF também decodifica para o payload certo', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(dest, MANIFEST), 'utf8'));
  const info = inspectPdf(fs.readFileSync(path.join(dest, PDF_NAME)));
  assert.equal(info.pages, Math.ceil(manifest.files.length / 6)); assert.equal(info.images.length, manifest.files.length);
  info.images.forEach((im, i) => {
    assert.equal(decodeRgba(grayToRgba(im), im.width, im.height), JSON.stringify(manifest.files[i].payload), `QR ${i} dentro do PDF`);
  });
  assert.ok(info.text.includes('(Pontos') === false);
  assert.ok(info.text.includes(' pts)'), 'títulos e pontos impressos nos cartões');
});

test('nova geração apaga só o que a anterior criou (arquivos renomeados somem; arquivos alheios ficam)', async () => {
  const d2 = path.join(tmp, 'regen'); fs.mkdirSync(d2);
  fs.writeFileSync(path.join(d2, 'minhas-notas.txt'), 'não apague');
  await generateQrFiles({ store: t.store, config, destDir: d2 });
  const before = fs.readdirSync(d2).filter(f => f.startsWith('Prova-1-'));
  assert.ok(before.length === 2);
  t.store.update('requirements', 'P1', { name: 'Prova Renomeada' });
  await generateQrFiles({ store: t.store, config, destDir: d2 });
  const after2 = fs.readdirSync(d2);
  assert.ok(!after2.some(f => f.startsWith('Prova-1-')), 'PNGs antigos removidos');
  assert.ok(after2.some(f => f.startsWith('Prova-Renomeada__')));
  assert.ok(after2.includes('minhas-notas.txt'));
  t.store.update('requirements', 'P1', { name: 'Prova 1: Orientação/Nós "ç"?' });
});

test('recusa gerar sem prova com QR e sem QR_SECRET de verdade (segredo de desenvolvimento não vale na nuvem)', async () => {
  const s = new Store(':memory:');
  const e = await generateQrFiles({ store: s, config, destDir: path.join(tmp, 'vazio') });
  assert.equal(e.ok, false); assert.equal(e.empty, true); assert.match(e.message, /Nenhuma prova ativa com variantes de QR/);
  assert.ok(!fs.existsSync(path.join(tmp, 'vazio')), 'nada criado');
  const dev = await generateQrFiles({ store: t.store, config: { ...config, qrSecretIsDev: true }, destDir: path.join(tmp, 'dev') });
  assert.equal(dev.ok, false); assert.equal(dev.devSecret, true); assert.match(dev.message, /QR_SECRET/);
  assert.equal((await generateQrFiles({ store: t.store, config: { ...config, qrSecretIsDev: true }, destDir: path.join(tmp, 'dev'), allowDevSecret: true })).ok, true);
  s.close();
});

test('qrStatus: quantos foram gerados, quando; avisa se requisitos ou QR_SECRET mudaram depois da geração', async () => {
  const s = new Store(':memory:'); await seedScenario(s);
  assert.deepEqual([qrStatus({ store: s, config }).generated, qrStatus({ store: s, config }).count], [false, 0]);
  const r = await generateQrFiles({ store: s, config, destDir: path.join(tmp, 'st'), now: 1_800_000_000_000 });
  let st = qrStatus({ store: s, config });
  assert.equal(st.generated, true); assert.equal(st.count, r.count); assert.equal(st.generatedAt, 1_800_000_000_000); assert.equal(st.dir, path.join(tmp, 'st'));
  assert.equal(st.requirementsChanged, false); assert.equal(st.secretChanged, false); assert.match(st.warning, /invalida o QR já impresso/);
  s.update('requirements', 'RQ', { qrVariants: [{ id: 'v1', label: 'Básico', points: 6 }, { id: 'v2', label: 'Avançado', points: 8 }] });
  st = qrStatus({ store: s, config }); assert.equal(st.requirementsChanged, true, 'pontos mudaram → QR impresso inválido');
  assert.equal(qrStatus({ store: s, config: { ...config, qrSecret: 'outro-segredo' } }).secretChanged, true);
  assert.equal(defaultQrDir({ dbPath: '/x/data/campori-local.db' }), path.join('/x/data', 'qrcodes'));
  s.close();
});

const req = (port, method, p, headers = {}) => new Promise((res, rej) => { const r = http.request({ host: '127.0.0.1', port, path: p, method, headers }, x => { const c = []; x.on('data', d => c.push(d)); x.on('end', () => res({ status: x.statusCode, body: Buffer.concat(c).toString() })); }); r.on('error', rej); r.end(method === 'POST' ? '{}' : undefined); });
test('/status: mostra contagem e data dos QR, botão "Gerar QR Codes" (protegido por PIN) roda o mesmo código e informa a pasta', async () => {
  const s = new Store(':memory:'); await seedScenario(s);
  const cfg = { ...config, dbPath: path.join(tmp, 'sdata', 'campori-local.db') };
  const app = createApp({ store: s, config: cfg, log: { info() {}, warn() {}, error() {} }, isLocalRequest: () => false });
  const srv = await new Promise(r => { const x = app.listen(0, '127.0.0.1', () => r(x)); });
  try {
    const port = srv.address().port, pin = { 'x-status-pin': 'pin123', 'content-type': 'application/json' };
    assert.equal((await req(port, 'POST', '/status/api/gerar-qrcodes')).status, 401, 'sem PIN, de outro aparelho, não gera');
    const before = JSON.parse((await req(port, 'GET', '/status/api/summary', pin)).body);
    assert.equal(before.qrcodes.generated, false);
    const r = JSON.parse((await req(port, 'POST', '/status/api/gerar-qrcodes', pin)).body);
    assert.equal(r.ok, true); assert.equal(r.dir, path.join(tmp, 'sdata', 'qrcodes')); assert.match(r.message, /QR Code\(s\) gerado\(s\) em/);
    assert.ok(fs.existsSync(path.join(r.dir, PDF_NAME)));
    assert.equal(r.summary.qrcodes.generated, true); assert.equal(r.summary.qrcodes.count, r.count); assert.ok(r.summary.qrcodes.generatedAt > 0);
    const page = (await req(port, 'GET', '/status/')).body;
    assert.match(page, /Gerar QR Codes/); assert.match(page, /QR Codes das provas/); assert.match(page, /gerar-qrcodes/);
  } finally { srv.closeAllConnections?.(); srv.close(); s.close(); }
  assert.ok(buildSummary({ store: t.store, config, engine: null, startedAt: Date.now() }).qrcodes, 'o resumo sempre traz a situação dos QR');
});

test('npm run gerar-qrcodes [destino] (CLI): gera na pasta pedida, avisa para imprimir só com requisitos reais; sem prova → erro claro', async () => {
  const data = path.join(tmp, 'cli'); fs.mkdirSync(data);
  const db = new Store(path.join(data, 'campori-local.db'));
  db.insert('requirements', { name: 'Prova CLI', filledBy: 'conselheiro', points: 9, active: true, qrVariants: [{ id: 'x', label: 'Único', points: 9 }] }, 'RC'); db.close();
  const env = { ...process.env, DATA_DIR: data, QR_SECRET: 'segredo-cli-123456' };
  delete env.ALLOW_DEV_SECRETS;
  const run = args => spawnSync(process.execPath, ['scripts/gerar-qrcodes.js', ...args], { cwd: path.join(REPO_ROOT, 'local-server'), env, encoding: 'utf8', timeout: 60000 });
  const out = path.join(tmp, 'pen-drive', 'qr');
  const r = run([out]);
  assert.equal(r.status, 0, r.stderr + r.stdout);
  assert.match(r.stdout, /1 QR Code\(s\) gerado\(s\)/); assert.match(r.stdout, /Imprima só depois de cadastrar os requisitos REAIS/);
  assert.deepEqual(fs.readdirSync(out).sort(), [MANIFEST, 'Prova-CLI__Unico__9pts.png', PDF_NAME].sort());
  const manifest = JSON.parse(fs.readFileSync(path.join(out, MANIFEST), 'utf8'));
  assert.equal(JSON.parse(decodePng(path.join(out, 'Prova-CLI__Unico__9pts.png')).text).hash, manifest.files[0].payload.hash);
  const def = run([]); assert.equal(def.status, 0); assert.ok(fs.existsSync(path.join(data, 'qrcodes', PDF_NAME)), 'padrão: data/qrcodes');
  // sem QR_SECRET real: recusa
  const noSecret = spawnSync(process.execPath, ['scripts/gerar-qrcodes.js', path.join(tmp, 'x')], { cwd: path.join(REPO_ROOT, 'local-server'), env: { ...env, QR_SECRET: '', ALLOW_DEV_SECRETS: '1' }, encoding: 'utf8', timeout: 60000 });
  assert.equal(noSecret.status, 2); assert.match(noSecret.stderr, /QR_SECRET/);
  // banco sem provas com QR
  const empty = path.join(tmp, 'cli-vazio'); fs.mkdirSync(empty); new Store(path.join(empty, 'campori-local.db')).close();
  const e = spawnSync(process.execPath, ['scripts/gerar-qrcodes.js'], { cwd: path.join(REPO_ROOT, 'local-server'), env: { ...env, DATA_DIR: empty }, encoding: 'utf8', timeout: 60000 });
  assert.equal(e.status, 1); assert.match(e.stderr, /Nenhuma prova ativa com variantes de QR/);
});

test('PNG e raster: o encoder escreve PNG válido em tons de cinza (assinatura, IHDR, IDAT, IEND)', async () => {
  const r = await qrRaster('teste', 100);
  const buf = pngGray(r);
  assert.deepEqual([...buf.subarray(0, 8)], [137, 80, 78, 71, 13, 10, 26, 10]);
  const png = PNG.sync.read(buf); assert.equal(png.width, r.width); assert.ok(r.width >= 100);
  assert.equal(decodeRgba(png.data, png.width, png.height), 'teste');
});

test('pasta data/qrcodes NÃO vai para o git; dependências são JS puro (sem compilação nativa) e declaradas no package.json', () => {
  for (const p of ['local-server/data/qrcodes/TODOS-OS-QRCODES.pdf', 'local-server/data/qrcodes/a.png', 'local-server/data/qrcodes/manifest.json']) {
    const r = spawnSync('git', ['check-ignore', '-q', p], { cwd: REPO_ROOT }); assert.equal(r.status, 0, `${p} deveria estar no .gitignore`);
  }
  const pkg = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'local-server/package.json'), 'utf8'));
  assert.ok(pkg.dependencies.qrcode, 'qrcode em dependencies (o PC do evento roda npm install normal)');
  assert.ok(pkg.devDependencies.jsqr && pkg.devDependencies.pngjs, 'só os testes usam jsqr/pngjs');
  assert.equal(pkg.scripts['gerar-qrcodes'], 'node scripts/gerar-qrcodes.js');
  const nm = path.join(REPO_ROOT, 'local-server/node_modules');
  for (const dep of ['qrcode', ...Object.keys(JSON.parse(fs.readFileSync(path.join(nm, 'qrcode/package.json'), 'utf8')).dependencies)]) {
    const dir = path.join(nm, dep);
    if (!fs.existsSync(dir)) continue;                                // dependência hoisted em outro lugar
    assert.ok(!fs.existsSync(path.join(dir, 'binding.gyp')), `${dep} exigiria compilação nativa (binding.gyp)`);
    const j = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    assert.ok(!j.gypfile && !/node-gyp|prebuild-install/.test(JSON.stringify(j.scripts || {})), `${dep}: scripts nativos`);
  }
  const readme = fs.readFileSync(path.join(REPO_ROOT, 'local-server/README.md'), 'utf8');
  assert.match(readme, /npm run gerar-qrcodes/); assert.match(readme, /invalida o QR impresso|invalida o QR já impresso/);
});
