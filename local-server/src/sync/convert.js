import { tsSeconds } from '../../../shared/scoring.js';

// ── Timestamp do Firestore ⇄ {seconds, nanoseconds} (formato guardado no SQLite) ──────────────
const isTsShape = v => v && typeof v === 'object' && !Array.isArray(v) &&
  Object.keys(v).length === 2 && typeof v.seconds === 'number' && typeof v.nanoseconds === 'number';

export function fromCloud(v) {
  if (v === null || typeof v !== 'object') return v;
  if (typeof v.toMillis === 'function' && typeof v.seconds === 'number') return { seconds: v.seconds, nanoseconds: v.nanoseconds };
  if (Array.isArray(v)) return v.map(fromCloud);
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, fromCloud(x)]));
}

export function toCloud(v, Timestamp) {
  if (v === null || typeof v !== 'object') return v;
  if (isTsShape(v)) return Timestamp.fromMillis(v.seconds * 1000 + Math.round(v.nanoseconds / 1e6));
  if (Array.isArray(v)) return v.map(x => toCloud(x, Timestamp));
  return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, toCloud(x, Timestamp)]));
}

export function deepEqual(a, b) {
  if (a === b) return true;
  if (a === undefined || b === undefined || a === null || b === null) return false;
  if (typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const ka = Object.keys(a).filter(k => a[k] !== undefined), kb = Object.keys(b).filter(k => b[k] !== undefined);
  if (ka.length !== kb.length) return false;
  return ka.every(k => deepEqual(a[k], b[k]));
}

// ── Merge de 3 vias (base = última versão da nuvem que este PC viu) ─────────────────────────
// Por campo: só um lado mudou → vale o que mudou (nenhuma edição é perdida);
//            os dois mudaram para valores diferentes (CONFLITO) → vale a NUVEM.
// Exceção — revisão de submissão (status/motivo/quem revisou): o grupo inteiro vale pela revisão MAIS RECENTE
// (`reviewedAt`), como num "último a revisar decide"; empate → nuvem.
export const REVIEW_FIELDS = ['status', 'rejectionReason', 'reviewedAt', 'reviewedBy', 'reviewedByName'];

export function mergeDocs({ base, local, cloud, collection }) {
  const conflicts = [];
  const pick = k => {
    const l = local[k], c = cloud[k], b = base ? base[k] : undefined;
    if (deepEqual(l, c)) return l;
    if (base) {
      if (deepEqual(l, b)) return c;   // só a nuvem mudou
      if (deepEqual(c, b)) return l;   // só o local mudou
    }
    conflicts.push({ field: k, local: l, cloud: c });
    return c;                          // os dois mudaram → nuvem
  };

  let reviewWinner = null;
  if (collection === 'submissions') {
    const clash = REVIEW_FIELDS.some(k => !deepEqual(local[k], cloud[k]) && (!base || (!deepEqual(local[k], base[k]) && !deepEqual(cloud[k], base[k]))));
    if (clash) reviewWinner = tsSeconds(local.reviewedAt) > tsSeconds(cloud.reviewedAt) ? 'local' : 'cloud';
  }

  const merged = {};
  for (const k of new Set([...Object.keys(local), ...Object.keys(cloud), ...Object.keys(base || {})])) {
    let v;
    if (reviewWinner && REVIEW_FIELDS.includes(k)) {
      v = (reviewWinner === 'local' ? local : cloud)[k];
      if (!deepEqual(local[k], cloud[k])) conflicts.push({ field: k, local: local[k], cloud: cloud[k], winner: reviewWinner });
    } else v = pick(k);
    if (v !== undefined) merged[k] = v;
  }
  return { merged, conflicts, reviewWinner };
}
