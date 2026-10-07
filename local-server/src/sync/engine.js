// Sincronização em segundo plano: servidor local ⇄ Firebase.
// Princípios: (1) NADA no servidor local espera pela nuvem — tudo aqui roda fora das rotas, com prazo em
// toda chamada; (2) todo envio é idempotente (pode ser repetido/interrompido a qualquer momento);
// (3) a volta da internet é detectada por um teste de conexão periódico, com backoff enquanto estiver fora.
import { COLLECTIONS } from '../db.js';
import { classifyError, withTimeout } from './errors.js';
import { pushRow, readCloudDoc } from './push.js';

// ordem de envio: dados de referência → submissões (scans por scanTimestamp) → disciplina → auditoria
const PUSH_ORDER = ['requirements', 'regions', 'units', 'participants', 'users', 'submissions', 'disciplinaryActions', 'auditLog'];
const ROW_TIMEOUT_MS = 20_000;
const MAX_ROW_ATTEMPTS = 3, ROW_COOLDOWN_MS = 5 * 60_000;      // item que falha por motivo próprio não trava os outros
const BACKOFF_MS = [10_000, 20_000, 40_000, 60_000];           // teto de 60s: a volta da Starlink é percebida em ≤1 min
const PROBE_EVERY_MS = 60_000;

export const ENGINE_STATES = { DISABLED: 'disabled', DEMO: 'demo', UNCONFIGURED: 'unconfigured', ONLINE: 'online', OFFLINE: 'offline', ERROR: 'error', UNKNOWN: 'unknown' };

export function createSyncEngine({ store, config, log, getCloud, now = () => Date.now() }) {
  const st = {
    cloud: ENGINE_STATES.UNKNOWN, cloudMessage: '', lastProbeAt: null, lastOkAt: null,
    running: false, lastAttemptAt: null, lastSuccessAt: Number(store.getMeta('sync.lastSuccessAt')) || null,
    attempts: 0, nextAttemptAt: 0, lastResult: null,
  };
  let cloud = null, inflight = null, timer = null, stopped = false;

  const dataset = () => store.getMeta('dataset');
  const enabled = () => !!config.cloudSync && dataset() !== 'demo';

  function setCloud(state, message = '') {
    if (st.cloud !== state) {
      // só registra TRANSIÇÕES (evita encher o log a cada tentativa)
      if (state === ENGINE_STATES.OFFLINE && st.cloud === ENGINE_STATES.ONLINE) store.logEvent({ kind: 'cloud-down', level: 'warn', message: `Nuvem fora do ar: ${message}` });
      if (state === ENGINE_STATES.ONLINE && st.cloud === ENGINE_STATES.OFFLINE) store.logEvent({ kind: 'cloud-up', level: 'info', message: 'Nuvem voltou — retomando o envio.' });
      log.info(`Nuvem: ${st.cloud} → ${state}${message ? ` (${message})` : ''}`);
    }
    st.cloud = state; st.cloudMessage = message;
  }
  const backoff = () => { st.attempts++; st.nextAttemptAt = now() + BACKOFF_MS[Math.min(st.attempts - 1, BACKOFF_MS.length - 1)]; };

  async function resolveCloud() {
    if (config.cloudSync === false || !config.cloudSync) { setCloud(ENGINE_STATES.DISABLED, 'Sincronização desligada (CLOUD_SYNC=1 no .env liga).'); return null; }
    if (dataset() === 'demo') { setCloud(ENGINE_STATES.DEMO, 'Banco de demonstração — a sincronização fica desligada para não gravar dados de teste na nuvem.'); return null; }
    if (cloud) return cloud;
    try { cloud = await getCloud(); }
    catch (e) { setCloud(ENGINE_STATES.UNCONFIGURED, e.message); return null; }
    if (!cloud) { setCloud(ENGINE_STATES.UNCONFIGURED, 'Credenciais do Firebase não configuradas.'); return null; }
    return cloud;
  }

  // ── envio: tudo que está dirty ────────────────────────────────────────────────────────────────
  async function pushAll(c, result, { manual }) {
    const ctx = { cloud: c, store, nowMs: now };
    for (const col of PUSH_ORDER) {
      for (let pass = 0; pass < 40; pass++) {            // lotes de 500 até esvaziar
        let rows = store.listDirty(col, { limit: 500 });
        rows = rows.filter(r => manual || r.attempts < MAX_ROW_ATTEMPTS || now() - (r.triedAt || 0) > ROW_COOLDOWN_MS);
        if (col === 'submissions') rows.sort((a, b) => (a.doc.scanTimestamp ?? a.updatedAt) - (b.doc.scanTimestamp ?? b.updatedAt)); // scans: do mais antigo ao mais novo
        const seen = (result._seen ||= new Set());
        rows = rows.filter(r => !seen.has(`${col}:${r.id}:${r.updatedAt}`));
        if (!rows.length) break;
        for (const row of rows) {
          seen.add(`${col}:${row.id}:${row.updatedAt}`);
          try {
            const out = await withTimeout(pushRow(ctx, col, row), config.syncRowTimeoutMs ?? ROW_TIMEOUT_MS, `enviando ${col}/${row.id}`);
            applyOutcome(col, row, out, result);
          } catch (e) {
            const kind = classifyError(e);
            if (kind === 'network' || kind === 'quota' || kind === 'auth') return { stopped: kind, message: e.message };   // para o ciclo; nada é marcado como erro do item
            store.recordSyncFailure(col, row.id, e.message);
            result.errors.push({ collection: col, id: row.id, message: e.message });
            store.logEvent({ kind: 'push-error', level: 'error', collection: col, docId: row.id, message: `Falha ao enviar ${col}/${row.id}: ${e.message}` });
          }
        }
      }
    }
    return { stopped: null };
  }

  function applyOutcome(col, row, out, result) {
    for (const rem of out.remotes || []) store.applyRemote(rem.col, rem.id, rem.doc);       // registro vencedor da nuvem
    if (out.hardDelete) store.markPushed(col, row.id, { expectUpdatedAt: row.updatedAt, hardDelete: true });
    else store.markPushed(col, row.id, { expectUpdatedAt: row.updatedAt, doc: out.doc || row.doc, baseNull: !!out.localOnly });
    for (const ev of out.events || []) { store.logEvent(ev); if (ev.alert) result.alerts.push(ev); }
    result.pushed++;
    const c = result.counts;
    c[out.outcome] = (c[out.outcome] || 0) + 1;
    if (out.outcome === 'conflict') result.conflicts++;
  }

  // ── ciclo completo: teste de conexão → envio ────────────────────────────────────────────────
  function cycle({ manual = false } = {}) {
    if (inflight) return inflight;
    inflight = (async () => {
      const t0 = now(); st.running = true; st.lastAttemptAt = t0;
      const result = { ok: false, offline: false, pushed: 0, counts: {}, conflicts: 0, errors: [], alerts: [], message: '', at: t0 };
      try {
        const c = await resolveCloud();
        if (!c) { result.message = st.cloudMessage; return result; }
        const probe = await c.probe();
        st.lastProbeAt = now();
        if (!probe.ok) {
          if (probe.kind === 'network') { setCloud(ENGINE_STATES.OFFLINE, probe.message); result.offline = true; result.message = 'Sem acesso à nuvem (sem internet?). Os dados continuam seguros neste PC e serão enviados quando a conexão voltar.'; }
          else { setCloud(ENGINE_STATES.ERROR, probe.message); result.message = `A nuvem recusou o acesso: ${probe.message}`; }
          backoff(); return result;
        }
        setCloud(ENGINE_STATES.ONLINE); st.lastOkAt = now();

        const push = await pushAll(c, result, { manual });
        if (push.stopped) {
          if (push.stopped === 'network') { setCloud(ENGINE_STATES.OFFLINE, push.message); result.offline = true; result.message = 'A conexão com a nuvem caiu durante o envio. O que já foi enviado está salvo; o resto continua na fila.'; }
          else { setCloud(ENGINE_STATES.ERROR, push.message); result.message = push.stopped === 'quota' ? 'A cota do Firebase foi excedida.' : `Credenciais recusadas: ${push.message}`; }
          backoff(); return result;
        }
        st.attempts = 0; st.nextAttemptAt = 0;
        result.ok = result.errors.length === 0;
        result.message = result.errors.length ? `${result.errors.length} item(ns) não puderam ser enviados — veja os erros abaixo.` : (result.pushed ? `${result.pushed} item(ns) enviado(s) à nuvem.` : 'Tudo já estava sincronizado.');
        if (result.ok) { st.lastSuccessAt = now(); store.setMeta('sync.lastSuccessAt', st.lastSuccessAt); }
        return result;
      } catch (e) {
        log.error(`Ciclo de sincronização falhou: ${e.stack || e.message}`);
        const kind = classifyError(e);
        if (kind === 'network') { setCloud(ENGINE_STATES.OFFLINE, e.message); result.offline = true; result.message = 'Sem acesso à nuvem.'; }
        else { result.errors.push({ message: e.message }); result.message = `Erro inesperado na sincronização: ${e.message}`; }
        backoff(); return result;
      } finally {
        st.running = false; delete result._seen;
        st.lastResult = { ok: result.ok, offline: result.offline, pushed: result.pushed, counts: result.counts, conflicts: result.conflicts, errors: result.errors.length, message: result.message, at: result.at };
      }
    })().finally(() => { inflight = null; });
    return inflight;
  }

  // ── laço em segundo plano ──────────────────────────────────────────────────────────────────
  async function tickOnce() {
    if (!enabled()) { await resolveCloud(); return; }
    const t = now();
    if (t < st.nextAttemptAt) return;                                  // em backoff
    const pending = store.dirtyCounts().total;
    const probeDue = !st.lastProbeAt || t - st.lastProbeAt >= PROBE_EVERY_MS;
    if (pending > 0 || probeDue || st.cloud !== ENGINE_STATES.ONLINE) await cycle();
  }
  function schedule() {
    if (stopped) return;
    timer = setTimeout(async () => { try { await tickOnce(); } catch (e) { log.error(`tick: ${e.message}`); } schedule(); }, config.syncTickMs ?? 10_000);
    timer.unref?.();
  }

  return {
    start() { stopped = false; resolveCloud().catch(() => {}); schedule(); },
    stop() { stopped = true; clearTimeout(timer); },
    syncNow: ({ manual = true } = {}) => cycle({ manual }),
    tick: tickOnce,                                                    // para testes
    enabled, now,
    status() {
      const dirty = store.dirtyCounts();
      return {
        enabled: enabled(), dataset: dataset(),
        cloud: { state: st.cloud, message: st.cloudMessage, lastProbeAt: st.lastProbeAt, lastOkAt: st.lastOkAt },
        push: { running: st.running, pending: dirty, lastAttemptAt: st.lastAttemptAt, lastSuccessAt: st.lastSuccessAt, nextAttemptAt: st.nextAttemptAt || null, attempts: st.attempts, lastResult: st.lastResult },
      };
    },
    _readCloudDoc: readCloudDoc,
  };
}
