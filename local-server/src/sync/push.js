// Envio de UMA linha local (dirty) para o Firestore, aplicando a regra de verdade do tipo de dado
// (ver OFFLINE.md → "Quem vence"). Cada função devolve o que o engine deve gravar localmente:
//   { outcome, doc?, hardDelete?, remotes?: [{col,id,doc}], conflicts?, events?: [...] }
import { createRequire } from 'node:module';
import { tsSeconds } from '../../../shared/scoring.js';
import { fromCloud, toCloud, deepEqual, mergeDocs } from './convert.js';

// Adaptador Firestore da decisão de scans (o MESMO que o backend da nuvem usa em /sync/scans).
// Fica fora do bundle do servidor local: o projeto inteiro é copiado para o PC do evento.
let _syncStore;
function syncStore() {
  if (!_syncStore) {
    try { _syncStore = createRequire(import.meta.url)('../../../server/services/syncStore.js'); }
    catch (e) { throw new Error(`Pasta "server" do projeto não encontrada ao lado de local-server (${e.message}). Copie o projeto INTEIRO para o PC do evento.`); }
  }
  return _syncStore;
}

const nowTs = ms => ({ seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1e6 });

// Scan de QR aprovado, criado pelo caminho de QR (id = scan_<clientId>) e ainda sem revisão manual
export const isFreshScan = row => !row.deleted && row.doc.source === 'qr' && row.doc.status === 'approved' &&
  row.doc.reviewedBy === 'qr' && typeof row.doc.clientId === 'string' && row.id === `scan_${row.doc.clientId}`;

// Scan que perdeu localmente para um mais antigo da mesma unidade (nunca vira registro novo na nuvem)
export const isLocalLoser = row => !row.deleted && row.doc.source === 'qr' && row.doc.qrConflict === 'superseded' && row.doc.reviewedBy === 'qr-sync';

export async function pushRow(ctx, col, row) {
  if (col === 'submissions' && isFreshScan(row)) return pushScan(ctx, row);
  if (col === 'submissions' && isLocalLoser(row)) return pushLoser(ctx, row);
  return pushGeneric(ctx, col, row);
}

// ── Scan: trava (unidade + prova) e "vence o scanTimestamp mais antigo", contra TUDO que já está na nuvem ──
async function pushScan({ cloud, nowMs, store }, row) {
  const d = row.doc;
  const user = { id: null, unitId: d.unitId, regionId: d.regionId, username: d.submittedBy, name: d.submittedByName };
  const item = {
    id: d.clientId, unitId: d.unitId, requisitoId: d.requirementId, varianteId: d.qrVariantId, pontos: d.requirementPoints,
    hash: 'verificado-no-servidor-local',                       // o hash JÁ foi conferido ao receber o scan
    scanTimestamp: typeof d.scanTimestamp === 'number' ? d.scanTimestamp : tsSeconds(d.submittedAt) * 1000,
  };
  const { results } = await syncStore().processScans({ db: cloud.db, admin: cloud.admin, user, items: [item], verifyQr: () => true, nowMs: nowMs() });
  const r = results[0];
  const label = `Unidade "${store?.get('units', d.unitId)?.name || d.unitId}" · prova "${d.requirementName}"`;

  if (r.status === 'aceito') {
    const superseded = r.code === 'ACCEPTED_SUPERSEDED';
    return {
      outcome: superseded ? 'superseded-cloud' : r.alreadySynced ? 'already-synced' : 'accepted', doc: d,
      events: superseded ? [{ kind: 'superseded-cloud', level: 'warn', alert: true, collection: 'submissions', docId: row.id,
        message: `${label}: o scan deste PC era mais antigo e substituiu um registro da nuvem (a pontuação ficou com o scan mais antigo).` }] : [],
    };
  }

  if (r.status === 'duplicado') {
    // a nuvem já tinha pontuação desta unidade nesta prova: traz para cá o registro vencedor
    const remotes = [];
    const own = await readCloudDoc(cloud, 'submissions', r.submissionId);
    if (own) remotes.push({ col: 'submissions', id: r.submissionId, doc: own });
    const winnerId = own?.supersededBy;                         // replay de um scan que a nuvem já havia substituído
    if (winnerId) { const w = await readCloudDoc(cloud, 'submissions', winnerId); if (w) remotes.push({ col: 'submissions', id: winnerId, doc: w }); }
    const keepId = winnerId || r.submissionId;
    const loser = row.id === r.submissionId ? null : {
      ...d, status: 'rejected', qrConflict: 'superseded', supersededBy: keepId, reviewedAt: nowTs(nowMs()), reviewedBy: 'qr-sync', reviewedByName: 'Sincronização QR',
      rejectionReason: 'Esta unidade já tinha pontuação nesta prova na nuvem (scan mais antigo ou aprovação manual) — este registro não conta.',
    };
    return {
      outcome: 'duplicate', doc: loser || remotes.find(x => x.id === row.id)?.doc || d, localOnly: !!loser, remotes,
      events: [{ kind: 'duplicate', level: 'warn', alert: true, collection: 'submissions', docId: row.id,
        message: `${label}: já existia pontuação cadastrada na nuvem — o registro deste PC não conta (vale o scan mais antigo ou a aprovação manual).` }],
    };
  }

  // rejeitado pela nuvem (prova removida, pontos da variante mudaram, unidade diferente...)
  return {
    outcome: 'rejected', localOnly: true,
    doc: { ...d, status: 'rejected', qrConflict: 'rejected-by-cloud', reviewedAt: nowTs(nowMs()), reviewedBy: 'qr-sync', reviewedByName: 'Sincronização QR', rejectionReason: `Recusado pela nuvem: ${r.message}` },
    events: [{ kind: 'rejected', level: 'error', alert: true, collection: 'submissions', docId: row.id, data: { code: r.code },
      message: `${label}: a nuvem recusou o scan — ${r.message}` }],
  };
}

// Perdedor local: só atualiza a nuvem se ela já tiver este documento
async function pushLoser(ctx, row) {
  const existing = await readCloudDoc(ctx.cloud, 'submissions', row.id);
  if (!existing) return { outcome: 'loser-local-only', doc: row.doc, localOnly: true };
  return pushGeneric(ctx, 'submissions', row);
}

// ── Genérico: merge de 3 vias (nuvem vence conflito de campo; revisão mais recente vence a revisão) ──
async function pushGeneric({ cloud }, col, row) {
  const ref = cloud.col(col).doc(row.id);
  const T = cloud.Timestamp;
  return cloud.db.runTransaction(async tx => {
    const snap = await tx.get(ref);
    const cloudDoc = snap.exists ? fromCloud(snap.data()) : null;
    const local = row.doc;

    if (row.deleted) {
      if (!cloudDoc) return { outcome: 'deleted', hardDelete: true };
      const unchanged = row.base && deepEqual(cloudDoc, row.base);
      // disciplina e auditoria: exclusão vence sempre; demais: só se a nuvem não mudou desde que este PC viu
      if (col === 'disciplinaryActions' || col === 'auditLog' || unchanged) { tx.delete(ref); return { outcome: 'deleted', hardDelete: true }; }
      return { outcome: 'delete-lost', doc: cloudDoc, events: [{ kind: 'conflict', level: 'warn', collection: col, docId: row.id,
        message: `${col}/${row.id}: apagado neste PC, mas alterado na nuvem depois — vale a nuvem (o registro foi mantido).` }] };
    }

    if (!cloudDoc) {
      if (row.base) return { outcome: 'cloud-deleted', hardDelete: true, events: [{ kind: 'conflict', level: 'warn', collection: col, docId: row.id,
        message: `${col}/${row.id}: foi apagado na nuvem — vale a nuvem (removido deste PC, inclusive a alteração local).` }] };
      tx.set(ref, toCloud(local, T));
      return { outcome: 'created', doc: local };
    }

    const { merged, conflicts, reviewWinner } = mergeDocs({ base: row.base, local, cloud: cloudDoc, collection: col });
    const same = deepEqual(merged, cloudDoc);
    if (!same) tx.set(ref, toCloud(merged, T));
    const events = [];
    if (conflicts.length) {
      const isReview = col === 'submissions' && reviewWinner;
      events.push({ kind: 'conflict', level: 'warn', alert: !!isReview, collection: col, docId: row.id, data: { conflicts: conflicts.map(c => c.field) },
        message: isReview
          ? `Aprovação/rejeição de ${local.requirementName || row.id} alterada nos dois lados — valeu a revisão mais recente (${reviewWinner === 'local' ? 'deste PC' : 'da nuvem'}).`
          : `Conflito em ${col}/${row.id} (campos: ${conflicts.map(c => c.field).join(', ')}) — valeu a versão da nuvem.` });
    }
    return { outcome: conflicts.length ? 'conflict' : same ? 'unchanged' : 'updated', doc: merged, conflicts, events };
  });
}

// ── auxiliares ──
export async function readCloudDoc(cloud, col, id) {
  const snap = await cloud.col(col).doc(id).get();
  return snap.exists ? { ...fromCloud(snap.data()) } : null;
}
