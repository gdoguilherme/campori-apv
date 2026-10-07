// Nuvem → local: carga inicial, atualização incremental (listeners), reconciliação, e a regra de ouro:
// NUNCA sobrescrever o que o local alterou e ainda não enviou.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import bcrypt from 'bcryptjs';
import { makeEnv, localScan, cloudScan, T0, plainTs, REF } from './sync-env.js';
import { FakeTimestamp, unavailable } from './fake-firestore.js';
import { computeUnitScores } from '../../shared/scoring.js';
import { createApp } from '../src/app.js';

const scores = env => Object.fromEntries(computeUnitScores(env.store.list('submissions'), env.store.list('units'), env.store.list('disciplinaryActions')).map(s => [s.id, s.total]));
const seedCloudExtras = env => {
  env.fake.seed('participants', 'p1', { name: 'João', club: 'Clube A', regionId: 'R1', unitId: 'U1', competitionCategory: 'DBV' });
  env.fake.seed('participants', 'p2', { name: 'Maria', club: 'Clube B', regionId: 'R1', unitId: 'U2', competitionCategory: 'DBV' });
  env.fake.seed('submissions', 'm1', { unitId: 'U3', regionId: 'R2', requirementId: 'RQ', requirementName: 'Prova de Nós', requirementPoints: 8, status: 'approved', source: 'region', submittedAt: new FakeTimestamp(T0 - 9e5), reviewedAt: new FakeTimestamp(T0 - 8e5) });
  env.fake.seed('disciplinaryActions', 'd1', { targetType: 'unit', targetId: 'U2', targetName: 'Leões', reason: 'Atraso', points: 5, createdAt: new FakeTimestamp(T0 - 1e5) });
};

test('CARGA INICIAL: banco vazio → traz tudo da nuvem (com base, sem pendências), marca a origem e os pontos batem', async () => {
  const env = makeEnv({ seedLocal: false }); seedCloudExtras(env);
  assert.equal(env.store.count('units'), 0);
  const r = await env.engine.syncNow();
  assert.equal(r.ok, true); assert.equal(r.pushed, 0);
  for (const [col, n] of [['regions', 2], ['units', 3], ['requirements', 3], ['users', 2], ['participants', 2], ['submissions', 1], ['disciplinaryActions', 1]]) assert.equal(env.store.count(col), n, col);
  assert.equal(r.pulled.created, 2 + 3 + 3 + 2 + 2 + 1 + 1);
  assert.equal(env.store.dirtyCounts().total, 0, 'nada vira pendência só por ter vindo da nuvem');
  assert.equal(env.store.getMeta('dataset'), 'cloud');
  assert.deepEqual(env.store.get('submissions', 'm1').submittedAt, { seconds: Math.floor((T0 - 9e5) / 1000), nanoseconds: 0 }, 'Timestamp → {seconds,nanoseconds}');
  assert.deepEqual(env.store.get('requirements', 'RQ').qrVariants.map(v => v.id), ['v1', 'v2'], 'requisitos vêm com as variantes de QR');
  assert.deepEqual(scores(env), { U1: 0, U2: 0, U3: 8 }, 'pontuação local = a da nuvem (U3 pelo aprovado; disciplina de U2 não passa de 0)');
  assert.equal(env.engine.status().pull.listening, true);
  assert.equal((await env.engine.syncNow()).pulled.created, 0, 'repetir não muda nada');
});

test('INCREMENTAL: o que é criado, aprovado, alterado ou apagado na nuvem chega sozinho (sem clicar em nada)', async () => {
  const env = makeEnv(); seedCloudExtras(env); await env.engine.syncNow();
  const rev = env.store.revision();
  // 1) na nuvem um admin aprova uma comprovação nova da região
  env.fake._apply('submissions', 'm2', 'set', { unitId: null, regionId: 'R1', requirementId: 'RA', requirementName: 'Relatório', requirementPoints: 10, status: 'approved', source: 'region', submittedAt: new FakeTimestamp(T0 - 5e4), reviewedAt: new FakeTimestamp(T0 - 4e4) });
  assert.equal(env.store.get('submissions', 'm2').status, 'approved');
  assert.deepEqual(scores(env), { U1: 10, U2: 5, U3: 8 }, 'aprovação regional já pontua as unidades da região (U2 tem -5 de disciplina)');
  // 2) requisito ganhou uma variante de QR
  env.fake._apply('requirements', 'RQ2', 'update', { qrVariants: [{ id: 'f1', label: 'Única', points: 5 }, { id: 'f2', label: 'Extra', points: 2 }] });
  assert.deepEqual(env.store.get('requirements', 'RQ2').qrVariants.map(v => v.id), ['f1', 'f2']);
  // 3) participante realocado, outro apagado, região nova, disciplina nova
  env.fake._apply('participants', 'p1', 'update', { unitId: 'U2' });
  env.fake._apply('participants', 'p2', 'delete');
  env.fake._apply('regions', 'R3', 'set', { name: 'Região 3', active: true });
  env.fake._apply('disciplinaryActions', 'd2', 'set', { targetType: 'region', targetId: 'R2', reason: 'Barulho', points: 5, createdAt: new FakeTimestamp(T0) });
  assert.equal(env.store.get('participants', 'p1').unitId, 'U2'); assert.equal(env.store.get('participants', 'p2'), null);
  assert.equal(env.store.get('regions', 'R3').name, 'Região 3'); assert.equal(env.store.get('disciplinaryActions', 'd2').reason, 'Barulho');
  assert.equal(scores(env).U3, 3, 'disciplina de -5 na região R2 aplicada localmente (8 - 5)');
  assert.equal(env.store.dirtyCounts().total, 0);
  assert.ok(env.store.revision() > rev);
  // 4) eco sem mudança não mexe em nada
  const r2 = env.store.revision(); env.fake._apply('participants', 'p1', 'update', { unitId: 'U2' });
  assert.equal(env.store.revision(), r2, 'mesma versão → sem escrita');
});

test('REGRA DE OURO: alteração local ainda NÃO enviada nunca é sobrescrita pela nuvem — o envio resolve depois', async () => {
  const env = makeEnv(); seedCloudExtras(env); await env.engine.syncNow();
  env.fake.online = false;                                          // sem internet: o local edita
  env.store.update('participants', 'p1', { club: 'Clube Local' });
  env.store.insert('participants', { name: 'Só local', unitId: 'U1', regionId: 'R1' }, 'p-local');
  env.fake.online = true;
  // a nuvem muda o MESMO participante (campo diferente + o mesmo campo) enquanto o local está pendente
  env.fake._apply('participants', 'p1', 'update', { club: 'Clube Nuvem', name: 'João da Nuvem' });
  assert.equal(env.store.get('participants', 'p1').club, 'Clube Local', 'o local pendente NÃO foi pisado');
  assert.equal(env.store.get('participants', 'p1').name, 'João', 'nem o campo que só a nuvem mudou foi aplicado ainda');
  assert.equal(env.store.dirtyCounts().byCollection.participants, 2);
  const r = await env.engine.syncNow();
  assert.equal(r.conflicts, 1);
  const merged = env.store.get('participants', 'p1');
  assert.equal(merged.name, 'João da Nuvem', 'campo só da nuvem entrou no merge');
  assert.equal(merged.club, 'Clube Nuvem', 'mesmo campo nos dois lados → nuvem vence (regra documentada)');
  assert.equal(env.fake.get('participants', 'p-local').name, 'Só local', 'criação local subiu');
  assert.equal(env.store.dirtyCounts().total, 0);
});

test('EXCLUSÃO feita na nuvem enquanto o PC estava desligado é aplicada na carga; linhas só-locais e pendentes são preservadas', async () => {
  const env = makeEnv(); seedCloudExtras(env); await env.engine.syncNow();
  env.engine.stop();                                                // "PC desligado"
  env.fake.listeners = []; env.fake._col('participants').delete('p2');   // apagado na nuvem sem ninguém ouvir
  env.store.insert('participants', { name: 'Pendente', unitId: 'U1', regionId: 'R1' }, 'p-pend');             // pendente local
  const loser = localScan(env, { unit: 'U1', variant: 'v2', pts: 8, ago: 5000 });                              // scan local pendente
  const e2 = env.mkEngine(); env.fake.listeners = [];
  await e2.syncNow({ manual: true });
  assert.equal(env.store.get('participants', 'p2'), null, 'exclusão da nuvem aplicada');
  assert.equal(env.fake.get('participants', 'p-pend').name, 'Pendente');
  assert.ok(env.fake.get('submissions', `scan_${loser.clientId}`));
  assert.equal(env.store.dirtyCounts().total, 0);
});

test('RECONCILIAÇÃO (botão): acha o que o listener perdeu, inclusive exclusões', async () => {
  const env = makeEnv(); seedCloudExtras(env); await env.engine.syncNow();
  env.fake.listeners = [];                                          // simula listener mudo/perdido
  env.fake._col('requirements').set('RA', { ...REF.requirements[2][1], points: 99 });   // mudança sem aviso
  env.fake._col('units').delete('U3');                              // exclusão sem aviso
  assert.equal(env.store.get('requirements', 'RA').points, 10);
  const r = await env.engine.pullNow();
  assert.equal(r.ok, true); assert.equal(env.store.get('requirements', 'RA').points, 99); assert.equal(env.store.get('units', 'U3'), null);
  assert.match(r.message, /atualizado\(s\)/); assert.equal(r.pulled.removed, 1);
  assert.equal(env.fake.ops > 0 && r.pushed, 0, 'pullNow não envia nada');
});

test('SEM INTERNET: atualizar falha com explicação, o local segue intacto; ao voltar, o listener é refeito e tudo chega', async () => {
  const env = makeEnv(); seedCloudExtras(env); await env.engine.syncNow();
  env.fake.online = false;
  const r = await env.engine.pullNow();
  assert.equal(r.offline, true); assert.equal(env.store.get('requirements', 'RA').points, 10);
  // o listener cai com erro enquanto isso
  env.fake.online = true; env.fake.listeners[0]?.errCb?.(unavailable());
  assert.equal(env.engine.status().pull.listening, false, 'listener parado após o erro');
  env.fake._col('requirements').set('RA', { ...REF.requirements[2][1], points: 42 });     // mudou enquanto estava surdo
  env.advance(70_000); await env.engine.tick();
  assert.equal(env.engine.status().pull.listening, true, 'listener recriado no próximo ciclo');
  assert.equal(env.store.get('requirements', 'RA').points, 42, 'a carga do novo listener trouxe a mudança');
});

test('nuvem PENDURADA ao atualizar: desiste por prazo (sem travar) e nada local muda', async () => {
  const env = makeEnv(); seedCloudExtras(env); await env.engine.syncNow();
  env.fake.listeners = []; env.engine.stop();
  const e2 = env.mkEngine(); env.advance(70_000);
  const ok = e2.pullNow();
  env.fake.hang = true; env.fake.online = true;                     // trava logo depois do teste de conexão
  const t0 = Date.now(); const r = await ok;
  env.fake.hang = false;
  assert.ok(Date.now() - t0 < 60_000, `terminou em ${Date.now() - t0}ms`);
  assert.ok(r.ok || r.offline);
  assert.equal(env.store.count('units'), 3);
});

test('scan local enviado e depois SUBSTITUÍDO na nuvem por um mais antigo: o local converge sozinho (e a pontuação não some)', async () => {
  const env = makeEnv(); await env.engine.syncNow();
  const mine = localScan(env, { variant: 'v2', pts: 8, ago: 10_000 }).clientId;
  await env.engine.syncNow();
  assert.deepEqual(scores(env), { U1: 8, U2: 0, U3: 0 });
  const older = (await cloudScan(env, { variant: 'v1', pts: 5, ago: 900_000 })).clientId;   // outro caminho: scan MAIS ANTIGO na nuvem
  assert.equal(env.store.get('submissions', `scan_${mine}`).status, 'rejected', 'o listener trouxe a substituição');
  assert.equal(env.store.get('submissions', `scan_${older}`).status, 'approved');
  assert.deepEqual(scores(env), { U1: 5, U2: 0, U3: 0 }, 'pontuação local = a da nuvem');
  assert.equal(env.store.dirtyCounts().total, 0);
});

test('PC REINICIADO no meio da carga: recomeçar é seguro (idempotente), sem duplicar nem perder', async () => {
  const env = makeEnv({ seedLocal: false }); seedCloudExtras(env);
  // 1ª tentativa: a internet cai depois de algumas coleções
  env.fake.failAfter = 6;
  const r1 = await env.engine.syncNow();
  assert.equal(r1.offline, true);
  const partial = ['regions', 'units', 'requirements', 'users', 'participants', 'disciplinaryActions', 'submissions'].reduce((n, c) => n + env.store.count(c), 0);
  env.engine.stop(); env.fake.listeners = []; env.fake.online = true; env.fake.failAfter = null;
  const e2 = env.mkEngine(); await e2.syncNow();                    // "PC ligou de novo"
  for (const [col, n] of [['regions', 2], ['units', 3], ['requirements', 3], ['users', 2], ['participants', 2], ['submissions', 1], ['disciplinaryActions', 1]]) assert.equal(env.store.count(col), n, col);
  assert.ok(partial > 0 && partial < 15, `carga parcial (${partial}/15 documentos)`); assert.equal(env.store.dirtyCounts().total, 0);
});

test('usuários que vêm da nuvem fazem login no servidor local — inclusive um criado na nuvem DURANTE o evento', async () => {
  const env = makeEnv({ seedLocal: false }); seedCloudExtras(env);
  env.fake.seed('users', 'c1', { ...REF.users[0][1], passwordHash: await bcrypt.hash('senha123', 4) });
  await env.engine.syncNow();
  const config = { port: 0, qrSecret: 's', jwtSecret: 'j', qrSecretIsDev: false, version: 't', uploadDir: '/tmp', frontendDir: null, corsOrigins: [] };
  const app = createApp({ store: env.store, config, log: env.log, engine: env.engine });
  const server = await new Promise(r => { const x = app.listen(0, '127.0.0.1', () => r(x)); }); const base = `http://127.0.0.1:${server.address().port}`;
  const login = (u, p) => fetch(`${base}/users/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: u, password: p }) }).then(async r => ({ status: r.status, body: await r.json() }));
  try {
    assert.equal((await login('cons1', 'senha123')).status, 200);
    assert.equal((await login('cons1', 'errada')).status, 401);
    assert.equal((await login('novato', 'abc12345')).status, 401, 'ainda não existe');
    env.fake._apply('users', 'u-novo', 'set', { name: 'Novato', username: 'novato', role: 'counselor', active: true, unitId: 'U2', regionId: 'R1', passwordHash: await bcrypt.hash('abc12345', 4) });
    const r = await login('novato', 'abc12345'); assert.equal(r.status, 200); assert.equal(r.body.user.unitId, 'U2');
    env.fake._apply('users', 'u-novo', 'update', { active: false });
    assert.equal((await login('novato', 'abc12345')).status, 401, 'desativado na nuvem → bloqueado aqui também');
  } finally { server.closeAllConnections?.(); server.close(); }
});

test('desempenho: carga inicial de ~6 mil documentos em poucos segundos', async () => {
  const env = makeEnv({ seedLocal: false });
  for (let i = 0; i < 2000; i++) env.fake.seed('participants', `pp${i}`, { name: `P ${i}`, regionId: 'R1', unitId: i % 2 ? 'U1' : 'U2', competitionCategory: 'DBV' });
  for (let i = 0; i < 4000; i++) env.fake.seed('submissions', `ss${i}`, { unitId: 'U1', regionId: 'R1', requirementId: `rq${i % 80}`, status: i % 3 ? 'approved' : 'pending', requirementPoints: 5, submittedAt: new FakeTimestamp(T0 - i * 1000) });
  const t0 = Date.now(); const r = await env.engine.syncNow(); const dt = Date.now() - t0;
  assert.equal(env.store.count('submissions'), 4000); assert.equal(env.store.count('participants'), 2000);
  assert.ok(dt < 60_000, `levou ${dt}ms`);
  const t1 = Date.now(); await env.engine.syncNow({ manual: true }); assert.ok(Date.now() - t1 < 60_000, 'reconciliação completa também termina');
});
