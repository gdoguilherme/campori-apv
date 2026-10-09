// Resumo do estado da sincronização para o painel /status (e para o /health): semáforos, pendências,
// erros recentes e o estado por unidade e por requisito.
import { COLLECTIONS } from '../db.js';
import { cachedDirStats, fmtBytes } from '../ops.js';

const CLOUD_LABEL = {
  online: ['green', 'Nuvem disponível'], offline: ['red', 'Nuvem fora do ar (sem internet?)'], error: ['red', 'Nuvem recusou o acesso'],
  disabled: ['gray', 'Sincronização desligada'], demo: ['gray', 'Banco de demonstração'], unconfigured: ['gray', 'Nuvem não configurada'], unknown: ['gray', 'Verificando a nuvem…'],
};

export function buildSummary({ store, config, engine, startedAt, now = engine?.now?.() ?? Date.now() }) {
  const st = engine ? engine.status() : { enabled: false, cloud: { state: 'disabled', message: 'Sincronização desligada (CLOUD_SYNC=1 no .env liga).' }, push: { pending: store.dirtyCounts(), lastSuccessAt: null } };
  const pendingTotal = st.push.pending.total;

  // ── pendências por unidade e por requisito ──────────────────────────────────────────────
  const units = store.list('units');
  const regions = Object.fromEntries(store.list('regions').map(r => [r.id, r.name]));
  const unitInfo = Object.fromEntries(units.map(u => [u.id, { id: u.id, name: u.name, region: regions[u.regionId] || '', pending: 0, errors: 0 }]));
  const reqInfo = Object.fromEntries(store.list('requirements').map(r => [r.id, { id: r.id, name: r.name, category: r.category || '', pending: 0, errors: 0 }]));
  const unitsOfRegion = rid => units.filter(u => u.regionId === rid);
  const touchUnits = (ids, row) => ids.forEach(id => { const u = unitInfo[id]; if (u) { u.pending++; if (row.error) u.errors++; } });
  let other = 0;
  for (const row of store.listDirty('submissions', { limit: 20000 })) {
    const d = row.doc;
    touchUnits(d.unitId ? [d.unitId] : unitsOfRegion(d.regionId).map(u => u.id), row);
    const r = reqInfo[d.requirementId]; if (r) { r.pending++; if (row.error) r.errors++; }
  }
  for (const row of store.listDirty('disciplinaryActions', { limit: 5000 })) {
    const d = row.doc;
    touchUnits(d.targetType === 'unit' ? [d.targetId] : unitsOfRegion(d.targetId).map(u => u.id), row);
  }
  for (const col of COLLECTIONS) if (!['submissions', 'disciplinaryActions'].includes(col)) other += st.push.pending.byCollection[col] || 0;
  const withState = o => ({ ...o, state: o.errors ? 'erro' : o.pending ? 'pendente' : 'sincronizado' });

  // ── erros recentes: itens que falharam + eventos de erro ─────────────────────────────────
  const failing = [];
  for (const col of COLLECTIONS) for (const row of store.listDirty(col, { limit: 200 })) if (row.error) failing.push({ collection: col, id: row.id, message: row.error, attempts: row.attempts });
  const errorEvents = store.listEvents({ levels: ['error'], limit: 10 });

  // ── semáforos ────────────────────────────────────────────────────────────────────────────
  const [cloudColor, cloudText] = CLOUD_LABEL[st.cloud.state] || CLOUD_LABEL.unknown;
  const errorCount = failing.length;
  const dataLight = errorCount ? ['red', `${errorCount} item(ns) com erro de envio`]
    : pendingTotal ? ['yellow', `${pendingTotal} item(ns) aguardando envio`]
    : ['green', 'Tudo sincronizado'];

  let overall;
  if (['disabled', 'demo', 'unconfigured'].includes(st.cloud.state)) overall = { color: 'gray', title: 'Funcionando só neste PC', detail: st.cloud.message || 'A sincronização com a nuvem está desligada. Tudo que for registrado fica guardado aqui.' };
  else if (errorCount || st.cloud.state === 'error') overall = { color: 'red', title: 'Atenção: há erros', detail: st.cloud.state === 'error' ? st.cloud.message : `${errorCount} item(ns) não puderam ser enviados à nuvem — veja a lista de erros abaixo.` };
  else if (st.cloud.state === 'offline') overall = { color: 'yellow', title: pendingTotal ? `Sem internet — ${pendingTotal} item(ns) aguardando envio` : 'Sem internet — funcionando só neste PC', detail: 'Está tudo seguro neste PC. Os registros serão enviados sozinhos quando a internet voltar.' };
  else if (pendingTotal) overall = { color: 'yellow', title: `${pendingTotal} item(ns) aguardando envio`, detail: 'A nuvem está disponível; o envio acontece sozinho em instantes (ou clique em "Sincronizar agora").' };
  else if (st.cloud.state === 'unknown') overall = { color: 'gray', title: 'Verificando a nuvem…', detail: 'Aguarde alguns segundos.' };
  else overall = { color: 'green', title: 'Tudo certo', detail: 'Servidor rodando, nuvem disponível e tudo sincronizado.' };

  return {
    serverTime: now, startedAt, uptimeSec: Math.round((now - startedAt) / 1000), version: config.version, dataset: st.dataset ?? store.getMeta('dataset'),
    lights: {
      server: { color: 'green', text: 'Servidor rodando' },
      cloud: { color: cloudColor, text: cloudText, state: st.cloud.state, message: st.cloud.message, lastOkAt: st.cloud.lastOkAt, lastProbeAt: st.cloud.lastProbeAt },
      data: { color: dataLight[0], text: dataLight[1] },
    },
    overall,
    pull: st.pull ? { listening: st.pull.listening, lastPullAt: st.pull.lastPullAt, lastFullAt: st.pull.lastFullAt, error: st.pull.error ? st.pull.error.message : null,
      ready: Object.values(st.pull.collections || {}).filter(c => c.ready).length } : null,
    sync: {
      enabled: st.enabled, running: !!st.push.running, pending: pendingTotal, pendingOther: other, byCollection: st.push.pending.byCollection,
      lastSuccessAt: st.push.lastSuccessAt, lastAttemptAt: st.push.lastAttemptAt, nextAttemptAt: st.push.nextAttemptAt, lastResult: st.push.lastResult,
    },
    uploads: (() => {
      const u = cachedDirStats(config.uploadDir);
      return { count: u.count, bytes: u.bytes, size: fmtBytes(u.bytes), dir: config.uploadDir, warning: 'As fotos ficam só neste PC — copie ao fim do dia (npm run backup-uploads).' };
    })(),
    errors: { failing: failing.slice(0, 20), events: errorEvents.map(e => ({ ts: e.ts, message: e.message })) },
    alerts: store.listEvents({ alertsOnly: true, unackedOnly: true, limit: 30 }).map(e => ({ id: e.id, ts: e.ts, kind: e.kind, level: e.level, message: e.message })),
    units: Object.values(unitInfo).map(withState).sort((a, b) => a.name.localeCompare(b.name, 'pt')),
    requirements: Object.values(reqInfo).map(withState).sort((a, b) => a.name.localeCompare(b.name, 'pt')),
  };
}
