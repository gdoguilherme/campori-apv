// Ranking lido do servidor LOCAL quando o aparelho está nele (celulares na rede do evento) e da NUVEM caso
// contrário, sempre devolvendo a hora da última atualização. Sem nenhuma rede, mostra a última cópia guardada.
//   anônimo   (login, portais)  → loadAnonRanking     → rows: [{ total }]
//   identificado (admin)        → loadIdentifiedRanking → rows: [{ id, name, regionId, total, count, stars }]
import { resolveServer, fetchJson, withTimeout } from './net.js';

const CACHE_KEY = 'campori_ranking_cache_v1';
const readCache = k => { try { return JSON.parse(localStorage.getItem(CACHE_KEY))?.[k] || null; } catch { return null; } };
const writeCache = (k, v) => { try { const all = JSON.parse(localStorage.getItem(CACHE_KEY)) || {}; all[k] = v; localStorage.setItem(CACHE_KEY, JSON.stringify(all)); } catch { /* sem armazenamento */ } };

// fallback(): função que calcula/lê o ranking pela nuvem (Firestore) — passada por quem chama
async function load(key, { localPath, headers, pick, fallback, timeoutMs = 12000 }) {
  const srv = await resolveServer();
  if (srv.kind === 'local') {
    try {
      const { ok, data } = await fetchJson(`${srv.base}${localPath}`, { headers, cache: 'no-store' }, 6000);
      const rows = ok ? pick(data) : null;
      if (rows) { const info = { rows, source: 'local', updatedAt: data.updatedAt || Date.now(), cloudSyncedAt: data.cloudSyncedAt || null }; writeCache(key, info); return info; }
    } catch { /* cai para a nuvem */ }
  }
  if (srv.kind !== 'none') {
    try {
      const rows = await withTimeout(Promise.resolve().then(fallback), timeoutMs, 'Tempo esgotado ao carregar o ranking');
      const info = { rows, source: 'cloud', updatedAt: Date.now(), cloudSyncedAt: null };
      writeCache(key, info); return info;
    } catch (e) { const c = readCache(key); if (c) return { ...c, source: 'cache', stale: true }; throw e; }
  }
  const cached = readCache(key);                                // sem rede nenhuma: última cópia guardada
  if (cached) return { ...cached, source: 'cache', stale: true };
  throw new Error('Sem conexão e sem ranking guardado neste aparelho');
}

export const loadAnonRanking = ({ fallback, timeoutMs }) => load('anon', {
  timeoutMs,
  localPath: '/ranking?meta=1', pick: d => (Array.isArray(d.ranking) ? d.ranking.map(r => ({ total: r.total })) : null), fallback,
});

export const loadIdentifiedRanking = ({ token, fallback, timeoutMs }) => load('identified', {
  timeoutMs,
  localPath: '/scores/units?meta=1', headers: token ? { Authorization: `Bearer ${token}` } : {}, pick: d => (Array.isArray(d.scores) ? d.scores : null), fallback,
});

// "Atualizado às 14:32 · servidor local (nuvem sincronizada às 14:30)"
const hhmm = ms => new Date(ms).toLocaleTimeString('pt-BR', { hour: '2-digit', minute: '2-digit' });
export function rankingStampText(info) {
  if (!info) return '';
  const when = `Atualizado às ${hhmm(info.updatedAt)}`;
  if (info.source === 'local') return `${when} · servidor local${info.cloudSyncedAt ? ` (nuvem sincronizada às ${hhmm(info.cloudSyncedAt)})` : ' (ainda não sincronizado com a nuvem)'}`;
  if (info.source === 'cache') return `${when} · sem conexão — último ranking guardado neste aparelho`;
  return `${when} · nuvem`;
}
export const rankingStampHtml = info => (info ? `<div class="rank-stamp" style="font-size:.7rem;color:#94a3b8;text-align:center;margin-top:.5rem;">${rankingStampText(info)}</div>` : '');
