// dbtool: ferramenta de último caso — backup antes, dirty=1, índices coerentes, validação, nada de gravar às cegas.
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { Store } from '../src/db.js';
import { runDbtool } from '../src/dbtool.js';
import { makeEnv, plainTs } from './sync-env.js';

let dir, store, config, out, errs, answer;
const io = () => ({ out: s => out.push(s), err: s => errs.push(s), confirm: async q => { out.push(q); return answer; } });
const run = (...argv) => runDbtool(argv, { store, config, io: io(), now: () => Date.UTC(2026, 9, 9, 15, 30, 0) });
const text = () => out.join('\n');
const backups = () => { const d = path.join(config.backupDir, 'dbtool'); return fs.existsSync(d) ? fs.readdirSync(d) : []; };
const raw = (col, id) => store.db.prepare(`SELECT * FROM "${col}" WHERE id = ?`).get(id);

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campori-dbtool-'));
  config = { backupDir: path.join(dir, 'backups'), dbPath: path.join(dir, 'campori.db') };
  store = new Store(config.dbPath);
  out = []; errs = []; answer = true;
  store.replaceCollection('regions', [{ id: 'R1', name: 'Região 1', competitionCategory: 'DBV' }]);
  store.replaceCollection('units', [{ id: 'U1', name: 'Águias', regionId: 'R1' }, { id: 'U2', name: 'Leões', regionId: 'R1' }]);
  store.replaceCollection('participants', [{ id: 'p1', name: 'João', regionId: 'R1', unitId: 'U1', competitionCategory: 'DBV' }, { id: 'p2', name: 'Maria', regionId: 'R1', unitId: 'U2' }]);
  store.replaceCollection('users', [{ id: 'u1', username: 'admin', role: 'superadmin', active: true, passwordHash: '$2a$10$SEGREDOSEGREDO' }]);
  store.replaceCollection('requirements', [{ id: 'RA', name: 'Relatório', points: 10, filledBy: 'regional', active: true }]);
});
afterEach(() => { try { store.close(); } catch {} fs.rmSync(dir, { recursive: true, force: true }); });

test('sem argumentos: mostra a ajuda e a contagem por coleção (registros · pendentes)', async () => {
  store.insert('participants', { name: 'Novo', unitId: 'U1', regionId: 'R1' }, 'p3');
  assert.equal(await run(), 0);
  assert.match(text(), /ÚLTIMO CASO/); assert.match(text(), /participants\s+3 · 1/); assert.match(text(), /BACKUP antes/);
});

test('list: filtra por campo indexado, só pendentes, inclui apagados; segredos mascarados; erros claros', async () => {
  store.insert('participants', { name: 'Pendente', unitId: 'U1', regionId: 'R1' }, 'p3');
  store.remove('participants', 'p2');
  await run('list', 'participants', '--where', 'unitId=U1');
  assert.match(text(), /p1/); assert.match(text(), /Pendente/); assert.doesNotMatch(text(), /Maria/);
  out = []; await run('list', 'participants', '--dirty');
  assert.match(text(), /p3/); assert.doesNotMatch(text(), /\bp1\b/);
  out = []; await run('list', 'participants', '--deleted');
  assert.match(text(), /DEL/);
  out = []; await run('list', 'users', '--raw');
  assert.match(text(), /\*\*\*/); assert.doesNotMatch(text(), /SEGREDOSEGREDO/);
  errs = []; assert.equal(await run('list', 'naoexiste'), 1); assert.match(errs.join(), /Coleção desconhecida/);
  errs = []; assert.equal(await run('list', 'participants', '--where', 'name=João'), 1); assert.match(errs.join(), /indexados/);
});

test('show: JSON + situação (sincronizado/pendente), mascara segredo, avisa de coluna fora do JSON', async () => {
  await run('show', 'users', 'u1');
  assert.match(text(), /sincronizado/); assert.match(text(), /"passwordHash": "\*\*\*"/); assert.doesNotMatch(text(), /SEGREDOSEGREDO/);
  out = []; await run('show', 'users', 'u1', '--show-secrets'); assert.match(text(), /SEGREDOSEGREDO/);
  store.db.prepare(`UPDATE participants SET unitId = 'ERRADA' WHERE id = 'p1'`).run();
  out = []; await run('show', 'participants', 'p1'); assert.match(text(), /colunas indexadas fora do JSON/);
  errs = []; assert.equal(await run('show', 'participants', 'xxx'), 1); assert.match(errs.join(), /não encontrado/);
});

test('set: faz BACKUP (com o valor antigo), grava dirty=1, atualiza a coluna indexada, mantém a base e registra o evento', async () => {
  const before = raw('participants', 'p1'); const rev = store.revision();
  assert.equal(before.dirty, 0); assert.ok(before.baseData);
  assert.equal(await run('set', 'participants', 'p1', '--campo', 'unitId=U2', '--campo', 'name=João Silva', '--yes'), 0);
  assert.match(text(), /unitId: "U1"\s+→\s+"U2"/);
  // backup existe, é um SQLite válido e tem o valor ANTIGO
  const [bk] = backups(); assert.ok(bk, 'backup criado'); assert.match(bk, /^dbtool-2026-10-09-15-30-00-set-participants-p1\.db$/);
  const old = new DatabaseSync(path.join(config.backupDir, 'dbtool', bk)); assert.equal(old.prepare(`SELECT unitId FROM participants WHERE id='p1'`).get().unitId, 'U1'); old.close();
  // gravação
  const after = raw('participants', 'p1');
  assert.equal(after.dirty, 1); assert.ok(after.updatedAt > before.updatedAt); assert.equal(after.unitId, 'U2', 'coluna indexada acompanha o JSON');
  assert.deepEqual(JSON.parse(after.data), { name: 'João Silva', regionId: 'R1', unitId: 'U2', competitionCategory: 'DBV' });
  assert.equal(after.baseData, before.baseData, 'a base da nuvem foi preservada (merge de 3 vias continua possível)');
  assert.equal(after.createdAt, before.createdAt);
  assert.ok(store.revision() > rev);
  assert.deepEqual(store.list('participants', { filters: { unitId: 'U2' } }).map(p => p.id).sort(), ['p1', 'p2']);
  assert.deepEqual(store.list('participants', { filters: { unitId: 'U1' } }), []);
  assert.ok(store.listEvents().some(e => e.kind === 'dbtool' && e.docId === 'p1'), 'aparece no painel');
});

test('set: valores tipados (número, true/false, texto), --file, --json e remover campo', async () => {
  await run('set', 'requirements', 'RA', '--campo', 'points=12', '--campo', 'active=false', '--campo', 'name=Relatório final', '--yes');
  assert.deepEqual(store.get('requirements', 'RA'), { id: 'RA', name: 'Relatório final', points: 12, filledBy: 'regional', active: false });
  const f = path.join(dir, 'alt.json'); fs.writeFileSync(f, JSON.stringify({ description: 'via arquivo', points: 15 }));
  await run('set', 'requirements', 'RA', '--file', f, '--yes');
  assert.equal(store.get('requirements', 'RA').description, 'via arquivo'); assert.equal(store.get('requirements', 'RA').points, 15);
  await run('set', 'requirements', 'RA', '--json', '{"description":{"__delete":true}}', '--yes');
  assert.ok(!('description' in store.get('requirements', 'RA')));
  await run('set', 'requirements', 'RA', '--json', '{"deadline":{"__serverTimestamp":true}}', '--yes');
  assert.equal(typeof store.get('requirements', 'RA').deadline.seconds, 'number', 'sentinela de data resolvida pelo Store');
});

test('set --replace troca o registro inteiro e preserva createdAt', async () => {
  const c0 = raw('requirements', 'RA').createdAt;
  await run('set', 'requirements', 'RA', '--replace', '--json', '{"name":"Só isto","points":1,"filledBy":"regional"}', '--yes');
  assert.deepEqual(store.get('requirements', 'RA'), { id: 'RA', name: 'Só isto', points: 1, filledBy: 'regional' });
  assert.equal(raw('requirements', 'RA').createdAt, c0); assert.equal(raw('requirements', 'RA').dirty, 1);
});

test('VALIDAÇÃO: JSON inválido, id, campo indexado não-simples, vazio, id inexistente, apagado — nada grava e nenhum backup é feito', async () => {
  const p1Before = JSON.stringify(raw('participants', 'p1')); const rev0 = store.revision();
  const bad = [
    [['set', 'participants', 'p1', '--json', '{quebrado'], /--json inválido/],
    [['set', 'participants', 'p1', '--json', '[1,2]'], /precisa ser um objeto/],
    [['set', 'participants', 'p1', '--json', '"texto"'], /precisa ser um objeto/],
    [['set', 'participants', 'p1', '--json', '{"id":"outro"}'], /"id"/],
    [['set', 'participants', 'p1', '--json', '{"unitId":["a"]}'], /indexado/],
    [['set', 'participants', 'p1', '--json', '{"unitId":{"x":1}}'], /indexado/],
    [['set', 'participants', 'p1', '--campo', 'semigual'], /nome=valor/],
    [['set', 'participants', 'p1'], /Nada para alterar/],
    [['set', 'participants', 'nao-existe', '--campo', 'a=1', '--yes'], /não encontrado/],
    [['set', 'participants', 'p1', '--file', path.join(dir, 'nao.json')], /Arquivo não encontrado/],
    [['set', 'participants', 'p1', '--json', JSON.stringify({ lixo: 'x'.repeat(1_100_000) }), '--yes'], /grande demais/],
  ];
  for (const [argv, re] of bad) { errs = []; assert.equal(await run(...argv), 1, argv.join(' ')); assert.match(errs.join('\n'), re, argv.join(' ')); }
  fs.writeFileSync(path.join(dir, 'ruim.json'), '{nao é json'); errs = [];
  assert.equal(await run('set', 'participants', 'p1', '--file', path.join(dir, 'ruim.json')), 1); assert.match(errs.join(), /Arquivo JSON inválido/);
  assert.equal(JSON.stringify(raw('participants', 'p1')), p1Before, 'p1 intacto'); assert.equal(store.revision(), rev0, 'a versão do banco não mudou');
  store.remove('participants', 'p2'); errs = [];
  assert.equal(await run('set', 'participants', 'p2', '--campo', 'a=1', '--yes'), 1); assert.match(errs.join(), /apagado/);
  assert.deepEqual(backups(), [], 'nenhuma validação reprovada gera backup nem grava');
});

test('--dry-run e confirmação negada não gravam nem fazem backup; confirmação aceita grava', async () => {
  const s0 = JSON.stringify(raw('requirements', 'RA'));
  assert.equal(await run('set', 'requirements', 'RA', '--campo', 'points=99', '--dry-run'), 0); assert.match(text(), /dry-run/);
  answer = false; out = [];
  assert.equal(await run('set', 'requirements', 'RA', '--campo', 'points=99'), 1);
  assert.match(text(), /Digite SIM/);
  assert.equal(JSON.stringify(raw('requirements', 'RA')), s0); assert.deepEqual(backups(), []);
  answer = true; assert.equal(await run('set', 'requirements', 'RA', '--campo', 'points=99'), 0);
  assert.equal(store.get('requirements', 'RA').points, 99); assert.equal(backups().length, 1);
});

test('se o BACKUP falhar, NADA é gravado', async () => {
  fs.writeFileSync(path.join(dir, 'arquivo'), 'x'); config.backupDir = path.join(dir, 'arquivo');   // "pasta" é um arquivo → backup impossível
  const s0 = JSON.stringify(raw('requirements', 'RA'));
  assert.equal(await run('set', 'requirements', 'RA', '--campo', 'points=99', '--yes'), 1);
  assert.equal(JSON.stringify(raw('requirements', 'RA')), s0); assert.equal(raw('requirements', 'RA').dirty, 0);
});

test('delete: tombstone com dirty=1 (a exclusão sobe à nuvem), some das listas, backup antes, confirma antes', async () => {
  answer = false; assert.equal(await run('delete', 'participants', 'p2'), 1); assert.ok(store.get('participants', 'p2')); assert.deepEqual(backups(), []);
  answer = true; out = [];
  assert.equal(await run('delete', 'participants', 'p2'), 0);
  const r = raw('participants', 'p2'); assert.deepEqual([r.deleted, r.dirty], [1, 1]);
  assert.equal(store.get('participants', 'p2'), null); assert.equal(backups().length, 1);
  const old = new DatabaseSync(path.join(config.backupDir, 'dbtool', backups()[0])); assert.equal(old.prepare(`SELECT deleted FROM participants WHERE id='p2'`).get().deleted, 0, 'o backup tem o registro vivo'); old.close();
  errs = []; assert.equal(await run('delete', 'participants', 'p2', '--yes'), 1); assert.match(errs.join(), /já está apagado/);
  out = []; await run('list', 'participants', '--deleted'); assert.match(text(), /p2.*DEL/);
});

test('check: acha coluna indexada fora do JSON e JSON inválido; --fix corrige as colunas (com backup) sem virar pendência', async () => {
  assert.equal(await run('check'), 0); assert.match(text(), /Tudo coerente/);
  store.db.prepare(`UPDATE participants SET unitId = 'ERRADA' WHERE id = 'p1'`).run();
  out = []; assert.equal(await run('check'), 1); assert.match(text(), /participants\/p1: coluna unitId=ERRADA mas o JSON diz U1/);
  out = []; assert.equal(await run('check', '--fix'), 0);
  assert.equal(raw('participants', 'p1').unitId, 'U1'); assert.equal(raw('participants', 'p1').dirty, 0, 'só a coluna foi corrigida'); assert.equal(backups().length, 1);
  store.db.prepare(`UPDATE units SET data = '{quebrado' WHERE id = 'U1'`).run();
  out = []; assert.equal(await run('check', '--fix'), 1); assert.match(text(), /JSON inválido/);
});

test('backup manual; comando desconhecido; funciona com o servidor "ligado" (2ª conexão no mesmo arquivo)', async () => {
  assert.equal(await run('backup'), 0); assert.equal(backups().length, 1);
  assert.equal(await run('voar'), 2);
  const server = new Store(config.dbPath);                                       // "servidor" com o banco aberto
  assert.equal(await run('set', 'participants', 'p1', '--campo', 'name=Mudou', '--yes'), 0);
  assert.equal(server.get('participants', 'p1').name, 'Mudou', 'o servidor já enxerga a alteração');
  server.update('participants', 'p2', { name: 'Servidor mexeu' });               // e o servidor continua gravando
  assert.equal(store.get('participants', 'p2').name, 'Servidor mexeu'); server.close();
});

test('integração com a sincronização: o que o dbtool altera SOBE para a nuvem (merge de 3 vias) e a exclusão também', async () => {
  const env = makeEnv(); config = { backupDir: path.join(dir, 'backups'), dbPath: ':memory:' }; store = env.store;
  env.store.insert('participants', { name: 'Sync', unitId: 'U1', regionId: 'R1' }, 'ps'); await env.engine.syncNow();
  assert.equal(env.store.dirtyCounts().total, 0);
  await run('set', 'requirements', 'RA', '--campo', 'points=33', '--yes');
  await run('delete', 'participants', 'ps', '--yes');
  assert.equal(env.store.dirtyCounts().total, 2);
  const r = await env.engine.syncNow();
  assert.equal(r.ok, true);
  assert.equal(env.fake.get('requirements', 'RA').points, 33); assert.equal(env.fake.get('participants', 'ps'), null);
  assert.equal(env.store.dirtyCounts().total, 0);
});

test('CLI de verdade: processo separado, ajuda, list, set com --yes, e SEM --yes e sem terminal ele cancela (não trava)', () => {
  const base = { ...process.env, DATA_DIR: dir, ALLOW_DEV_SECRETS: '1', PATH: process.env.PATH };
  store.close();   // o CLI usa data/campori-local.db dentro de DATA_DIR
  const seed = new Store(path.join(dir, 'campori-local.db'));
  seed.replaceCollection('requirements', [{ id: 'RA', name: 'Relatório', points: 10 }]); seed.close();
  const cli = (...a) => spawnSync(process.execPath, [path.resolve(import.meta.dirname, '..', 'scripts', 'dbtool.js'), ...a], { env: base, encoding: 'utf8', input: '', timeout: 30_000 });
  let r = cli(); assert.equal(r.status, 0); assert.match(r.stdout, /requirements\s+1 · 0/);
  r = cli('list', 'requirements'); assert.equal(r.status, 0); assert.match(r.stdout, /Relatório/);
  r = cli('set', 'requirements', 'RA', '--campo', 'points=5');            // stdin vazio → "não confirmou"
  assert.equal(r.status, 1); assert.match(r.stdout, /Digite SIM/);
  r = cli('set', 'requirements', 'RA', '--campo', 'points=5', '--yes'); assert.equal(r.status, 0); assert.match(r.stdout, /Backup:.*dbtool/);
  r = cli('show', 'requirements', 'RA'); assert.match(r.stdout, /"points": 5/); assert.match(r.stdout, /PENDENTE/);
  r = cli('delete', 'requirements', 'XX', '--yes'); assert.equal(r.status, 1); assert.match(r.stderr, /não encontrado/);
  store = new Store(':memory:');   // para o afterEach fechar
});
