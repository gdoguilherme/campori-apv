// Local → nuvem: envio idempotente, regras de quem vence, internet caindo, PC reiniciando.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeEnv, localScan, cloudScan, cloudApproved, localApproved, T0, plainTs, REF } from './sync-env.js';
import { FakeTimestamp } from './fake-firestore.js';
import { computeUnitScores } from '../../shared/scoring.js';

const scansInCloud = env => env.fake.all('submissions').filter(s => s.source === 'qr');

test('scan local é enviado à nuvem: Timestamps reais, idempotente, linha local fica sincronizada', async () => {
  const env = makeEnv();
  const { clientId } = localScan(env, { ago: 3_600_000 });
  assert.equal(env.store.dirtyCounts().byCollection.submissions, 1);
  const r = await env.engine.syncNow();
  assert.equal(r.ok, true); assert.equal(r.counts.accepted, 1);
  const doc = env.fake.get('submissions', `scan_${clientId}`);
  assert.ok(doc.submittedAt instanceof FakeTimestamp && doc.syncedAt instanceof FakeTimestamp, 'datas viram Timestamp do Firestore');
  assert.equal(doc.submittedAt.toMillis(), T0 - 3_600_000, 'submittedAt = momento do scan');
  assert.deepEqual([doc.status, doc.source, doc.unitId, doc.requirementPoints], ['approved', 'qr', 'U1', 5]);
  assert.equal(env.store.dirtyCounts().total, 0);
  // repetir não muda nada
  const again = await env.engine.syncNow();
  assert.equal(again.pushed, 0); assert.equal(scansInCloud(env).length, 1);
  assert.equal(env.engine.status().push.lastSuccessAt, T0);
});

test('sem internet: nada trava, tudo fica na fila; volta a internet → envia (com backoff e detecção automática)', async () => {
  const env = makeEnv();
  localScan(env); localScan(env, { unit: 'U2', user: 'c2', req: 'RQ2', variant: 'f1', ago: 30_000 });
  env.fake.online = false;
  const r = await env.engine.syncNow();
  assert.equal(r.offline, true); assert.match(r.message, /continuam seguros/);
  assert.equal(env.store.dirtyCounts().total, 2);
  assert.equal(env.engine.status().cloud.state, 'offline');
  assert.equal(env.engine.status().push.attempts, 1);
  // o laço em segundo plano respeita o backoff...
  env.fake.online = true;
  const opsBefore = env.fake.ops; await env.engine.tick();
  assert.equal(env.fake.ops, opsBefore, 'em backoff: não tenta de novo antes da hora');
  // ...e percebe a volta da internet sozinho
  env.advance(11_000); await env.engine.tick();
  assert.equal(env.engine.status().cloud.state, 'online');
  assert.equal(env.store.dirtyCounts().total, 0); assert.equal(scansInCloud(env).length, 2);
  assert.equal(env.engine.status().push.attempts, 0);
  assert.ok(env.store.listEvents().some(e => e.kind === 'cloud-up'), 'registrou que a nuvem voltou');
});

test('internet cai NO MEIO do envio: o que foi enviado fica salvo, o resto espera; ao voltar, nada perdido nem duplicado', async () => {
  const env = makeEnv();
  const ids = Array.from({ length: 6 }, (_, i) => localScan(env, { unit: 'U1', req: 'RQ', variant: 'v1', ago: 600_000 - i * 1000, clientId: `mid-${i}-aaaaaaaa` }).clientId);
  // mesma unidade e prova: 1 aprovado + 5 duplicados locais? não — use unidades/provas diferentes para 6 aprovados:
  env.store.replaceCollection('submissions', []);
  const docs = [['U1', 'c1', 'RQ', 'v1', 5], ['U1', 'c1', 'RQ2', 'f1', 5], ['U2', 'c2', 'RQ', 'v2', 8], ['U2', 'c2', 'RQ2', 'f1', 5]]
    .map(([unit, user, req, variant, pts], i) => localScan(env, { unit, user, req, variant, pts, ago: 500_000 - i * 1000, clientId: `drop-${i}-bbbbbbbb` }).clientId);
  env.fake.failAfter = 7;                                   // ~2 itens passam e a rede cai
  const r1 = await env.engine.syncNow();
  assert.equal(r1.offline, true);
  const sent = scansInCloud(env).length;
  assert.ok(sent >= 1 && sent < 4, `envio parcial (${sent}/4)`);
  assert.equal(env.store.dirtyCounts().total, 4 - sent, 'só o que subiu foi marcado como enviado');
  env.fake.online = true; env.fake.failAfter = null; env.advance(70_000);
  const r2 = await env.engine.syncNow();
  assert.equal(r2.ok, true);
  assert.equal(scansInCloud(env).length, 4, 'nada perdido');
  assert.deepEqual(new Set(scansInCloud(env).map(s => s.clientId)), new Set(docs), 'nada duplicado');
  assert.equal(env.store.dirtyCounts().total, 0);
});

test('nuvem pendurada (nunca responde): o ciclo desiste por prazo e o servidor local segue respondendo', async () => {
  const env = makeEnv();
  localScan(env);
  env.fake.hang = true;
  const t0 = Date.now();
  const r = await env.engine.syncNow();
  assert.equal(r.offline, true); assert.ok(Date.now() - t0 < 2000, `desistiu em ${Date.now() - t0}ms`);
  assert.equal(env.store.dirtyCounts().total, 1);
  // durante um envio pendurado o banco local continua utilizável (nada de lock)
  env.fake.hang = false; env.fake.online = true; env.advance(70_000);
  const ok = env.engine.syncNow();
  env.fake.hang = true;                                      // trava depois do teste de conexão
  const t1 = Date.now(); localScan(env, { unit: 'U2', user: 'c2', req: 'RQ2', variant: 'f1' }); env.store.list('submissions'); env.store.dirtyCounts();
  assert.ok(Date.now() - t1 < 100, 'escrever/ler no SQLite não espera a nuvem');
  await ok; env.fake.hang = false;
});

test('PC reiniciado no meio do envio: a nuvem gravou mas o PC não soube → reenvio não duplica', async () => {
  const env = makeEnv();
  const a = localScan(env).clientId;
  const b = localScan(env, { unit: 'U2', user: 'c2', req: 'RQ2', variant: 'f1' }).clientId;
  env.fake.crashAfterCommits = 0;                            // 1º commit entra na nuvem e a resposta se perde (PC "morreu")
  const r1 = await env.engine.syncNow();
  assert.equal(r1.offline, true);
  assert.equal(env.fake.all('submissions').filter(s => s.clientId).length, 1, 'a nuvem recebeu 1');
  assert.equal(env.store.dirtyCounts().byCollection.submissions, 2, 'o PC ainda acha que os 2 estão pendentes');
  // "reinício": engine novo sobre o MESMO banco local; internet normal
  env.fake.crashAfterCommits = null; env.engine.stop();
  const engine2 = env.mkEngine();
  const r2 = await engine2.syncNow();
  assert.equal(r2.ok, true);
  assert.equal(scansInCloud(env).length, 2); assert.deepEqual(new Set(scansInCloud(env).map(s => s.clientId)), new Set([a, b]));
  assert.equal(env.store.dirtyCounts().total, 0);
  assert.equal(r2.counts['already-synced'], 1, 'o já gravado foi reconhecido (idempotência), não regravado');
});

test('mesmo scan por DOIS caminhos (nuvem direto + servidor local), nas duas ordens: 1 só registro', async () => {
  for (const order of ['nuvem-primeiro', 'local-primeiro']) {
    const env = makeEnv();
    const clientId = `dup-path-${order.length}-cccccccc`;
    const via = async () => {
      if (order === 'nuvem-primeiro') { await cloudScan(env, { clientId, ago: 120_000 }); localScan(env, { clientId, ago: 120_000 }); await env.engine.syncNow(); }
      else { localScan(env, { clientId, ago: 120_000 }); await env.engine.syncNow(); const r = await cloudScan(env, { clientId, ago: 120_000 }); assert.equal(r.result.code, 'ALREADY_SYNCED'); }
    };
    await via();
    assert.equal(scansInCloud(env).length, 1, order);
    assert.equal(cloudApproved(env).length, 1, order);
    assert.equal(env.store.dirtyCounts().total, 0, order);
    assert.equal(computeUnitScores(env.store.list('submissions'), env.store.list('units'))[0].total, 5, `pontos contados uma vez (${order})`);
  }
});

test('conflito unidade+prova: scan LOCAL mais ANTIGO que o da nuvem → vence o local (substitui o da nuvem) e avisa', async () => {
  const env = makeEnv();
  const cloudNewer = (await cloudScan(env, { variant: 'v2', pts: 8, ago: 10_000 })).clientId;
  const local = localScan(env, { variant: 'v1', pts: 5, ago: 900_000 }).clientId;
  const r = await env.engine.syncNow();
  assert.equal(r.counts['superseded-cloud'], 1);
  const win = cloudApproved(env);
  assert.deepEqual(win.map(s => s.clientId), [local], 'só o mais antigo pontua na nuvem');
  assert.equal(env.fake.get('submissions', `scan_${cloudNewer}`).qrConflict, 'superseded');
  assert.ok(r.alerts.some(a => a.kind === 'superseded-cloud'), 'alerta para o painel');
});

test('conflito: scan LOCAL mais NOVO que o da nuvem → local vira "substituído", o vencedor da nuvem é trazido e os pontos NÃO somem', async () => {
  const env = makeEnv();
  const winner = (await cloudScan(env, { variant: 'v1', pts: 5, ago: 900_000 })).clientId;
  const local = localScan(env, { variant: 'v2', pts: 8, ago: 10_000 }).clientId;
  assert.equal(computeUnitScores(env.store.list('submissions'), env.store.list('units'))[0].total, 8, 'antes: o local ainda contava o dele');
  const r = await env.engine.syncNow();
  assert.equal(r.counts.duplicate, 1);
  assert.deepEqual(cloudApproved(env).map(s => s.clientId), [winner], 'a nuvem não mudou');
  assert.equal(env.fake.get('submissions', `scan_${local}`), null, 'o perdedor não vira registro na nuvem');
  const mine = env.store.get('submissions', `scan_${local}`);
  assert.deepEqual([mine.status, mine.qrConflict, mine.supersededBy], ['rejected', 'superseded', `scan_${winner}`]);
  assert.deepEqual(localApproved(env).map(s => s.clientId), [winner], 'o vencedor da nuvem agora existe localmente');
  assert.equal(computeUnitScores(env.store.list('submissions'), env.store.list('units'))[0].total, 5, 'pontuação local = a da nuvem (nenhum ponto sumiu)');
  assert.equal(env.store.dirtyCounts().total, 0);
  assert.ok(r.alerts.some(a => a.kind === 'duplicate' && /já existia pontuação/.test(a.message)));
  assert.equal((await env.engine.syncNow()).pushed, 0, 'estável: nada mais a enviar');
});

test('aprovação manual do admin na nuvem vence o scan local, mesmo sendo mais NOVA', async () => {
  const env = makeEnv();
  env.fake.seed('submissions', 'manual1', { unitId: 'U1', regionId: 'R1', requirementId: 'RQ', requirementName: 'Prova de Nós', status: 'approved', source: 'region', requirementPoints: 8, submittedAt: new FakeTimestamp(T0 - 5000) });
  localScan(env, { ago: 3_600_000 });
  const r = await env.engine.syncNow();
  assert.equal(r.counts.duplicate, 1);
  assert.deepEqual(cloudApproved(env).map(s => s.id), ['manual1']);
});

test('scan local perdedor de OUTRO scan local (mesma unidade, 2 aparelhos) não vira registro novo na nuvem', async () => {
  const env = makeEnv();
  const young = localScan(env, { variant: 'v2', pts: 8, ago: 10_000 }).clientId;
  const old = localScan(env, { variant: 'v1', pts: 5, ago: 800_000 }).clientId;    // o scan mais antigo chega depois e vence localmente
  assert.deepEqual(localApproved(env).map(s => s.clientId), [old]);
  const r = await env.engine.syncNow();
  assert.equal(r.ok, true);
  assert.deepEqual(scansInCloud(env).map(s => s.clientId), [old]);
  assert.equal(env.store.dirtyCounts().total, 0);
  assert.equal(env.store.get('submissions', `scan_${young}`).status, 'rejected');
});

test('reenvio de scan que a nuvem já tinha substituído: resultado estável e vencedor local atualizado', async () => {
  const env = makeEnv();
  const a = (await cloudScan(env, { variant: 'v2', pts: 8, ago: 10_000 })).clientId;
  const b = (await cloudScan(env, { variant: 'v1', pts: 5, ago: 800_000 })).clientId;       // substitui a
  localScan(env, { clientId: a, variant: 'v2', pts: 8, ago: 10_000 });                       // este PC tinha o scan "a" pendente
  const r = await env.engine.syncNow();
  assert.equal(r.counts.duplicate, 1);
  assert.deepEqual(localApproved(env).map(s => s.clientId), [b]);
  assert.equal(env.store.get('submissions', `scan_${a}`).status, 'rejected');
  assert.equal(env.store.dirtyCounts().total, 0);
});

test('QR recusado pela nuvem (variante/pontos mudaram lá): marca recusado, alerta com o motivo, não trava o resto', async () => {
  const env = makeEnv();
  localScan(env, { unit: 'U2', user: 'c2', req: 'RQ2', variant: 'f1', ago: 5000 });
  const bad = localScan(env, { variant: 'v1', pts: 5, ago: 9000 }).clientId;
  env.fake.seed('requirements', 'RQ', { ...REF.requirements[0][1], qrVariants: [{ id: 'v1', label: 'Básico', points: 6 }] });   // pontos mudaram na nuvem
  const r = await env.engine.syncNow();
  assert.equal(r.counts.rejected, 1); assert.equal(r.counts.accepted, 1);
  const row = env.store.get('submissions', `scan_${bad}`);
  assert.deepEqual([row.status, row.qrConflict], ['rejected', 'rejected-by-cloud']); assert.match(row.rejectionReason, /Recusado pela nuvem/);
  assert.ok(r.alerts.some(a => a.kind === 'rejected' && /Pontuação do QR Code não confere/.test(a.message)));
});

test('revisão: vence a REVISÃO MAIS RECENTE (local x nuvem), e mudança sem conflito é preservada', async () => {
  const mk = (id, fields) => ({ unitId: 'U1', regionId: 'R1', requirementId: 'RA', requirementName: 'Relatório', status: 'pending', source: 'region', requirementPoints: 10, submittedAt: plainTs(T0 - 9e6), ...fields });
  for (const [localAt, cloudAt, expected] of [[T0 - 1000, T0 - 90_000, 'approved'], [T0 - 90_000, T0 - 1000, 'rejected']]) {
    const env = makeEnv();
    const base = mk('s1', {});
    env.store.replaceCollection('submissions', [{ id: 's1', ...base }]);
    env.fake.seed('submissions', 's1', { ...base, submittedAt: new FakeTimestamp(T0 - 9e6), status: 'rejected', reviewedAt: new FakeTimestamp(cloudAt), reviewedBy: 'adminNuvem', rejectionReason: 'foto ruim' });
    env.store.update('submissions', 's1', { status: 'approved', reviewedAt: plainTs(localAt), reviewedBy: 'adminLocal', rejectionReason: '' });
    const r = await env.engine.syncNow();
    assert.equal(env.fake.get('submissions', 's1').status, expected, `local=${localAt - T0} nuvem=${cloudAt - T0}`);
    assert.equal(env.store.get('submissions', 's1').status, expected, 'local converge para o mesmo valor');
    assert.equal(r.conflicts, 1); assert.ok(r.alerts.some(a => /mais recente/.test(a.message)));
  }
  // só o local revisou → sobe sem conflito
  const env = makeEnv(); const base = mk('s2', {});
  env.store.replaceCollection('submissions', [{ id: 's2', ...base }]); env.fake.seed('submissions', 's2', { ...base, submittedAt: new FakeTimestamp(T0 - 9e6) });
  env.store.update('submissions', 's2', { status: 'approved', reviewedAt: plainTs(T0 - 500), reviewedBy: 'adm' });
  const r = await env.engine.syncNow();
  assert.equal(r.conflicts, 0); assert.equal(env.fake.get('submissions', 's2').status, 'approved');
});

test('dados de referência: merge de 3 vias — campos diferentes se somam; mesmo campo → NUVEM vence (e registra o conflito)', async () => {
  const env = makeEnv();
  env.store.update('requirements', 'RA', { points: 12, description: 'editado no local' });            // local mexeu em points+description
  env.fake.seed('requirements', 'RA', { ...REF.requirements[2][1], name: 'Relatório (nuvem)', points: 15 });   // nuvem mexeu em name+points
  const r = await env.engine.syncNow();
  const merged = env.fake.get('requirements', 'RA');
  assert.equal(merged.name, 'Relatório (nuvem)', 'mudança só da nuvem preservada');
  assert.equal(merged.description, 'editado no local', 'mudança só do local preservada');
  assert.equal(merged.points, 15, 'mesmo campo nos dois lados → nuvem vence');
  assert.deepEqual(env.store.get('requirements', 'RA').points, 15);
  assert.equal(r.conflicts, 1);
  const ev = env.store.listEvents().find(e => e.kind === 'conflict');
  assert.match(ev.message, /points/); assert.match(ev.message, /nuvem/);
  assert.equal(env.store.dirtyCounts().total, 0);
});

test('criar/editar/apagar no local: participante novo sobe; apagado na nuvem vence; apagar no local só apaga se a nuvem não mudou', async () => {
  const env = makeEnv();
  env.store.insert('participants', { name: 'Novo', regionId: 'R1', unitId: 'U1', competitionCategory: 'DBV' }, 'p-new');
  env.store.replaceCollection('participants', [{ id: 'p-a', name: 'A', unitId: 'U1', regionId: 'R1' }, { id: 'p-b', name: 'B', unitId: 'U1', regionId: 'R1' }]);
  env.store.insert('participants', { name: 'Novo', regionId: 'R1', unitId: 'U1' }, 'p-new');
  env.fake.seed('participants', 'p-a', { name: 'A', unitId: 'U1', regionId: 'R1' }); env.fake.seed('participants', 'p-b', { name: 'B', unitId: 'U1', regionId: 'R1' });
  env.store.remove('participants', 'p-a');                                                      // apagado no local, nuvem igual → apaga
  env.store.remove('participants', 'p-b');                                                      // apagado no local...
  env.fake.seed('participants', 'p-b', { name: 'B (mudou na nuvem)', unitId: 'U1', regionId: 'R1' }); // ...mas editado na nuvem → nuvem vence
  const r = await env.engine.syncNow();
  assert.equal(env.fake.get('participants', 'p-new').name, 'Novo');
  assert.equal(env.fake.get('participants', 'p-a'), null);
  assert.equal(env.fake.get('participants', 'p-b').name, 'B (mudou na nuvem)');
  assert.equal(env.store.get('participants', 'p-b').name, 'B (mudou na nuvem)', 'restaurado no local');
  assert.equal(env.store.get('participants', 'p-a'), null);
  assert.equal(env.store.dirtyCounts().total, 0); assert.equal(r.ok, true);
});

test('disciplina: registros se somam e a EXCLUSÃO vence; submissão/fiscal criada no local sobe com o mesmo id', async () => {
  const env = makeEnv();
  const d1 = env.store.insert('disciplinaryActions', { targetType: 'unit', targetId: 'U1', targetName: 'Águias', reason: 'Atraso', points: 5, createdAt: plainTs(T0) });
  const d2 = env.store.insert('disciplinaryActions', { targetType: 'region', targetId: 'R1', targetName: 'Região 1', reason: 'Barulho', points: 5, createdAt: plainTs(T0) });
  env.fake.seed('disciplinaryActions', 'cloud-d', { targetType: 'unit', targetId: 'U2', reason: 'da nuvem', points: 5, createdAt: new FakeTimestamp(T0) });
  const fiscal = env.store.insert('submissions', { unitId: 'U2', regionId: 'R1', requirementId: 'RA', requirementName: 'Relatório', requirementPoints: 7, status: 'pending', source: 'judge', fiscalSuggestion: true, submittedAt: plainTs(T0 - 1000), submittedBy: 'fiscal' });
  await env.engine.syncNow();
  assert.deepEqual(env.fake.all('disciplinaryActions').map(d => d.id).sort(), [d1.id, d2.id, 'cloud-d'].sort(), 'união dos dois lados');
  assert.ok(env.fake.get('disciplinaryActions', d1.id).createdAt instanceof FakeTimestamp);
  assert.equal(env.fake.get('submissions', fiscal.id).fiscalSuggestion, true);
  env.store.remove('disciplinaryActions', d1.id);                                                // exclusão local → vence
  await env.engine.syncNow();
  assert.equal(env.fake.get('disciplinaryActions', d1.id), null);
  assert.equal(env.fake.get('disciplinaryActions', d2.id).reason, 'Barulho');
  assert.equal(env.store.dirtyCounts().total, 0);
});

test('item "envenenado" (erro próprio, ex: permissão) é registrado nele e NÃO trava os outros', async () => {
  const env = makeEnv();
  const bad = env.store.insert('participants', { name: 'Ruim', unitId: 'U1', regionId: 'R1' }, 'p-bad');
  env.store.insert('participants', { name: 'Bom', unitId: 'U1', regionId: 'R1' }, 'p-good');
  env.fake.denyDocs.add('p-bad');
  const r = await env.engine.syncNow();
  assert.equal(r.ok, false); assert.equal(r.errors.length, 1);
  assert.equal(env.fake.get('participants', 'p-good').name, 'Bom');
  const row = env.store.listDirty('participants');
  assert.deepEqual(row.map(x => x.id), ['p-bad']); assert.match(row[0].error, /PERMISSION_DENIED/); assert.equal(row[0].attempts, 1);
  assert.ok(env.store.listEvents().some(e => e.kind === 'push-error' && e.docId === 'p-bad'));
  // depois de 3 falhas o item entra em "descanso" (não é martelado a cada ciclo); o botão manual ignora o descanso
  for (let i = 0; i < 3; i++) await env.engine.syncNow({ manual: true });
  const ops = env.fake.ops; await env.engine.syncNow({ manual: false });
  assert.ok(env.fake.ops - ops < 6, 'item em descanso foi pulado no ciclo automático');
});

test('edição local FEITA DURANTE o envio não é perdida: a linha segue pendente e a versão nova também sobe', async () => {
  const env = makeEnv();
  env.store.insert('participants', { name: 'João', unitId: 'U1', regionId: 'R1' }, 'p1');
  let cloudAtCommit = null;
  env.fake.beforeCommit = async () => { env.fake.beforeCommit = null; cloudAtCommit = env.fake.get('participants', 'p1'); env.store.update('participants', 'p1', { name: 'João Silva' }); };
  const r = await env.engine.syncNow();
  assert.equal(cloudAtCommit, null, 'no 1º commit a nuvem ainda não tinha o participante');
  assert.equal(r.pushed, 2, 'enviou a versão antiga e, vendo a linha ainda pendente, enviou a nova no mesmo ciclo');
  assert.equal(env.fake.get('participants', 'p1').name, 'João Silva');
  assert.equal(env.store.get('participants', 'p1').name, 'João Silva');
  assert.equal(env.store.dirtyCounts().total, 0);
});

test('segurança: sem CLOUD_SYNC ou em banco de demonstração a nuvem NÃO é tocada', async () => {
  for (const [config, dataset, state] of [[{ cloudSync: false }, null, 'disabled'], [{}, 'demo', 'demo']]) {
    const env = makeEnv({ config });
    if (dataset) env.store.setMeta('dataset', dataset);
    env.store.insert('participants', { name: 'X', unitId: 'U1', regionId: 'R1' }, 'px');
    const r = await env.engine.syncNow(); await env.engine.tick();
    assert.equal(env.fake.ops, 0, `${state}: zero chamadas à nuvem`);
    assert.equal(env.fake.get('participants', 'px'), null);
    assert.equal(env.engine.status().cloud.state, state); assert.equal(env.engine.status().enabled, false);
    assert.ok(r.message.length > 10);
  }
});

test('nuvem sem credenciais: estado "não configurado" com o motivo (não quebra o servidor)', async () => {
  const env = makeEnv();
  const eng = (await import('../src/sync/engine.js')).createSyncEngine({ store: env.store, log: env.log, now: env.now, config: { cloudSync: true },
    getCloud: async () => { throw new Error('Credenciais do Firebase não encontradas: C:\\x.json'); } });
  const r = await eng.syncNow();
  assert.equal(eng.status().cloud.state, 'unconfigured'); assert.match(r.message, /Credenciais/);
});

test('migração: banco criado nas Fases 1–3 (sem colunas de sync) é atualizado sem perder dados', async () => {
  const { DatabaseSync } = await import('node:sqlite');
  const os = await import('node:os'), path = await import('node:path'), fs = await import('node:fs');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'campori-mig-')); const file = path.join(dir, 'old.db');
  const old = new DatabaseSync(file);
  old.exec(`CREATE TABLE meta (key TEXT PRIMARY KEY, value TEXT); INSERT INTO meta VALUES ('revision','7');`);
  old.exec(`CREATE TABLE "participants" (id TEXT PRIMARY KEY, "regionId" TEXT, "unitId" TEXT, data TEXT NOT NULL, createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL, deleted INTEGER NOT NULL DEFAULT 0, dirty INTEGER NOT NULL DEFAULT 1)`);
  old.prepare(`INSERT INTO participants VALUES ('p1','R1','U1',?,1,1,0,1)`).run(JSON.stringify({ name: 'Antigo', regionId: 'R1', unitId: 'U1' }));
  old.close();
  const { Store } = await import('../src/db.js');
  const s = new Store(file);
  assert.equal(s.get('participants', 'p1').name, 'Antigo');
  assert.equal(s.dirtyCounts().byCollection.participants, 1);
  s.update('participants', 'p1', { name: 'Novo' }); s.markPushed('participants', 'p1', { expectUpdatedAt: s.listDirty('participants')[0].updatedAt, doc: { name: 'Novo', regionId: 'R1', unitId: 'U1' } });
  assert.equal(s.dirtyCounts().total, 0); assert.equal(s.revision() >= 7, true);
  s.close(); fs.rmSync(dir, { recursive: true, force: true });
});
