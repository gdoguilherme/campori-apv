import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Schema espelha as coleções do Firestore: UMA TABELA POR COLEÇÃO, com o documento
// inteiro em `data` (JSON) + colunas indexadas só pros campos usados em filtros.
// Guardar o doc como veio do Firestore garante fidelidade na sincronização (Fase 3).
// Colunas de controle de sync: updatedAt (ms), deleted (tombstone), dirty (alterado localmente e ainda
// NÃO enviado à nuvem). Para o merge com a nuvem: baseData = última versão da nuvem que este PC viu
// (base do merge de 3 vias); syncError/syncAttempts/syncTriedAt = falhas de envio; syncedAt = último envio ok.
export const INDEXED = {
  regions: [],
  units: ['regionId'],
  participants: ['regionId', 'unitId'],
  requirements: [],
  submissions: ['regionId', 'unitId', 'requirementId', 'status'],
  disciplinaryActions: ['targetType', 'targetId'],
  auditLog: ['submissionId'],
  users: ['username', 'role', 'regionId', 'unitId'], // hash de senha só trafega via /users/login
};
export const COLLECTIONS = Object.keys(INDEXED);

// JSON canônico (chaves ordenadas): compara documentos sem depender da ordem dos campos
export const canon = v => JSON.stringify(v, (_k, x) => (x && typeof x === 'object' && !Array.isArray(x) ? Object.fromEntries(Object.keys(x).sort().map(k => [k, x[k]])) : x));

export const nowTs = () => { const ms = Date.now(); return { seconds: Math.floor(ms / 1000), nanoseconds: (ms % 1000) * 1e6 }; };

// Sentinelas que o client pode mandar no corpo: serverTimestamp e remoção de campo
export function resolveSentinels(v) {
  if (Array.isArray(v)) return v.map(resolveSentinels);
  if (v && typeof v === 'object') {
    if (v.__serverTimestamp) return nowTs();
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = resolveSentinels(val);
    return out;
  }
  return v;
}

const ID_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
export const newId = () => Array.from(crypto.randomBytes(20), b => ID_CHARS[b % ID_CHARS.length]).join('');

export class Store {
  constructor(dbPath) {
    this.dbPath = dbPath;
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new DatabaseSync(dbPath);
    this.db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; PRAGMA busy_timeout = 5000;');
    this.db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
    for (const [col, idx] of Object.entries(INDEXED)) {
      const extra = idx.map(c => `"${c}" TEXT,`).join(' ');
      this.db.exec(`CREATE TABLE IF NOT EXISTS "${col}" (
        id TEXT PRIMARY KEY, ${extra}
        data TEXT NOT NULL,
        createdAt INTEGER NOT NULL, updatedAt INTEGER NOT NULL,
        deleted INTEGER NOT NULL DEFAULT 0, dirty INTEGER NOT NULL DEFAULT 1
      )`);
      for (const c of idx) this.db.exec(`CREATE INDEX IF NOT EXISTS "ix_${col}_${c}" ON "${col}"("${c}")`);
      this.db.exec(`CREATE INDEX IF NOT EXISTS "ix_${col}_upd" ON "${col}"(updatedAt)`);
    }
    // Migração (bancos criados nas Fases 1–3 não têm as colunas de sincronização)
    for (const col of Object.keys(INDEXED)) {
      const have = new Set(this.db.prepare(`PRAGMA table_info("${col}")`).all().map(c => c.name));
      for (const [name, ddl] of [['baseData', 'TEXT'], ['syncError', 'TEXT'], ['syncAttempts', 'INTEGER NOT NULL DEFAULT 0'], ['syncTriedAt', 'INTEGER'], ['syncedAt', 'INTEGER']]) {
        if (!have.has(name)) this.db.exec(`ALTER TABLE "${col}" ADD COLUMN ${name} ${ddl}`);
      }
      this.db.exec(`CREATE INDEX IF NOT EXISTS "ix_${col}_dirty" ON "${col}"(dirty)`);
    }
    // Registro de eventos da sincronização (alertas do painel de status, erros, conflitos)
    this.db.exec(`CREATE TABLE IF NOT EXISTS sync_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, level TEXT NOT NULL,
      collection TEXT, docId TEXT, message TEXT NOT NULL, data TEXT, alert INTEGER NOT NULL DEFAULT 0, ack INTEGER NOT NULL DEFAULT 0
    )`);
    this.db.exec(`INSERT OR IGNORE INTO meta(key,value) VALUES ('revision','0')`);
  }

  // ── meta (chave/valor): origem do banco, cursores e estado da sincronização ──
  getMeta(key) { return this.db.prepare(`SELECT value FROM meta WHERE key=?`).get(key)?.value ?? null; }
  setMeta(key, value) { this.db.prepare(`INSERT INTO meta(key,value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`).run(key, String(value)); }

  _check(col) { if (!COLLECTIONS.includes(col)) throw httpError(404, `Coleção desconhecida: ${col}`); }
  _row(col, r) { return r ? { id: r.id, ...JSON.parse(r.data) } : null; }

  revision() { return Number(this.db.prepare(`SELECT value FROM meta WHERE key='revision'`).get().value); }
  _bump() { this.db.exec(`UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key='revision'`); }

  // Reentrante: insert()/update() dentro de um tx() maior participam da mesma transação
  tx(fn) {
    if (this._inTx) return fn();
    this.db.exec('BEGIN IMMEDIATE');
    this._inTx = true;
    try { const r = fn(); this.db.exec('COMMIT'); return r; }
    catch (e) { this.db.exec('ROLLBACK'); throw e; }
    finally { this._inTx = false; }
  }

  // filters: { campoIndexado: valor | null }, since: ms (inclui tombstones se includeDeleted)
  list(col, { filters = {}, since = 0, includeDeleted = false } = {}) {
    this._check(col);
    const where = [], params = [];
    if (!includeDeleted) where.push('deleted = 0');
    if (since) { where.push('updatedAt > ?'); params.push(since); }
    for (const [k, v] of Object.entries(filters)) {
      if (!INDEXED[col].includes(k)) throw httpError(400, `Filtro não suportado em ${col}: ${k}`);
      if (v === null) where.push(`"${k}" IS NULL`); else { where.push(`"${k}" = ?`); params.push(String(v)); }
    }
    const sql = `SELECT id, data FROM "${col}"${where.length ? ' WHERE ' + where.join(' AND ') : ''}`;
    return this.db.prepare(sql).all(...params).map(r => this._row(col, r));
  }

  get(col, id) {
    this._check(col);
    return this._row(col, this.db.prepare(`SELECT id, data FROM "${col}" WHERE id = ? AND deleted = 0`).get(String(id)));
  }

  count(col) {
    this._check(col);
    return this.db.prepare(`SELECT COUNT(*) n FROM "${col}" WHERE deleted = 0`).get().n;
  }

  // Upsert: ao regravar um documento NÃO apaga baseData/syncError (INSERT OR REPLACE apagaria).
  // opts.dirty: 1 (padrão — alteração local) ou 0 (veio da nuvem / já enviado);  opts.base: doc da nuvem a guardar como base.
  _write(col, id, data, createdAt, { dirty = 1, base } = {}) {
    const idx = INDEXED[col];
    const vals = idx.map(c => (data[c] === undefined || data[c] === null) ? null : String(data[c]));
    const cols = ['id', ...idx.map(c => `"${c}"`), 'data', 'createdAt', 'updatedAt', 'deleted', 'dirty'];
    // updatedAt estritamente crescente por linha: é a "versão" usada para detectar edição local durante um envio
    // (duas gravações no mesmo milissegundo não podem ficar com a mesma versão)
    const upd = cols.filter(c => c !== 'id' && c !== 'createdAt')
      .map(c => (c === 'updatedAt' ? `updatedAt = MAX(excluded.updatedAt, "${col}".updatedAt + 1)` : `${c} = excluded.${c}`)).join(', ');
    const sql = `INSERT INTO "${col}" (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')}) ON CONFLICT(id) DO UPDATE SET ${upd}`;
    this.db.prepare(sql).run(id, ...vals, JSON.stringify(data), createdAt, Date.now(), 0, dirty);
    if (base !== undefined) this.db.prepare(`UPDATE "${col}" SET baseData = ? WHERE id = ?`).run(base === null ? null : JSON.stringify(base), id);
  }

  insert(col, data, id = newId(), opts) {
    this._check(col);
    const { id: _ignored, ...doc } = resolveSentinels(data);
    return this.tx(() => {
      this._write(col, id, doc, Date.now(), opts);
      this._bump();
      return { id, ...doc };
    });
  }

  // set = substitui o documento; update = merge raso (como updateDoc do Firestore)
  update(col, id, patch, opts) {
    this._check(col);
    return this.tx(() => {
      const row = this.db.prepare(`SELECT data, createdAt FROM "${col}" WHERE id = ? AND deleted = 0`).get(String(id));
      if (!row) throw httpError(404, 'Documento não encontrado');
      const doc = JSON.parse(row.data);
      for (const [k, v] of Object.entries(resolveSentinels(patch))) {
        if (k === 'id') continue;
        if (v && typeof v === 'object' && v.__delete) delete doc[k]; else doc[k] = v;
      }
      this._write(col, String(id), doc, row.createdAt, opts);
      this._bump();
      return { id: String(id), ...doc };
    });
  }

  remove(col, id) {
    this._check(col);
    return this.tx(() => {
      const r = this.db.prepare(`UPDATE "${col}" SET deleted = 1, dirty = 1, updatedAt = ? WHERE id = ? AND deleted = 0`).run(Date.now(), String(id));
      if (r.changes === 0) throw httpError(404, 'Documento não encontrado');
      this._bump();
    });
  }

  // Substitui uma coleção inteira (usado só pelo "pull" da nuvem, com dirty=0)
  replaceCollection(col, docs) {
    this._check(col);
    this.tx(() => {
      this.db.exec(`DELETE FROM "${col}"`);
      for (const { id, ...doc } of docs) this._write(col, id, doc, Date.now(), { dirty: 0, base: doc });
      this._bump();
    });
  }

  // ── fila de envio à nuvem (linhas dirty=1, incluindo exclusões/tombstones) ─────────────────
  listDirty(col, { limit = 500 } = {}) {
    this._check(col);
    return this.db.prepare(`SELECT id, data, deleted, createdAt, updatedAt, baseData, syncAttempts, syncTriedAt, syncError FROM "${col}" WHERE dirty = 1 ORDER BY updatedAt LIMIT ?`).all(limit).map(r => ({
      id: r.id, doc: JSON.parse(r.data), deleted: !!r.deleted, createdAt: r.createdAt, updatedAt: r.updatedAt,
      base: r.baseData ? JSON.parse(r.baseData) : null, attempts: r.syncAttempts, triedAt: r.syncTriedAt, error: r.syncError,
    }));
  }

  dirtyCounts() {
    const byCollection = {}; let total = 0;
    for (const col of COLLECTIONS) {
      const n = this.db.prepare(`SELECT COUNT(*) n FROM "${col}" WHERE dirty = 1`).get().n;
      if (n) byCollection[col] = n;
      total += n;
    }
    return { total, byCollection };
  }

  // Marca como enviado. `expectUpdatedAt` protege contra uma edição local feita DURANTE o envio:
  // se a linha mudou, ela continua dirty (será reenviada) e só a base é atualizada.
  markPushed(col, id, { expectUpdatedAt, doc, hardDelete = false, baseNull = false }) {
    this._check(col);
    return this.tx(() => {
      const row = this.db.prepare(`SELECT updatedAt, createdAt FROM "${col}" WHERE id = ?`).get(String(id));
      if (!row) return 'gone';
      const unchanged = row.updatedAt === expectUpdatedAt;
      if (hardDelete) {
        if (!unchanged) return 'changed-meanwhile';
        this.db.prepare(`DELETE FROM "${col}" WHERE id = ?`).run(String(id));
        this._bump();
        return 'removed';
      }
      if (!unchanged) {
        this.db.prepare(`UPDATE "${col}" SET baseData = ? WHERE id = ?`).run(JSON.stringify(doc), String(id));
        return 'changed-meanwhile';
      }
      const { id: _i, ...clean } = doc;
      const before = this.db.prepare(`SELECT data FROM "${col}" WHERE id = ?`).get(String(id)).data;
      this._write(col, String(id), clean, row.createdAt, { dirty: 0, base: baseNull ? null : clean });
      this.db.prepare(`UPDATE "${col}" SET syncError = NULL, syncAttempts = 0, syncedAt = ? WHERE id = ?`).run(Date.now(), String(id));
      if (before !== JSON.stringify(clean)) this._bump();
      return 'synced';
    });
  }

  recordSyncFailure(col, id, message) {
    this._check(col);
    this.db.prepare(`UPDATE "${col}" SET syncError = ?, syncAttempts = syncAttempts + 1, syncTriedAt = ? WHERE id = ?`).run(String(message).slice(0, 500), Date.now(), String(id));
  }

  // Linha que a nuvem alterou/criou. NUNCA sobrescreve alteração local ainda não enviada (dirty) — o envio
  // resolve esse conflito pelas regras de OFFLINE.md. Devolve: created | updated | unchanged | skipped-dirty.
  applyRemote(col, id, doc) {
    this._check(col);
    return this.tx(() => {
      const row = this.db.prepare(`SELECT dirty, createdAt, data, baseData, deleted FROM "${col}" WHERE id = ?`).get(String(id));
      if (row?.dirty === 1) return 'skipped-dirty';
      const { id: _i, ...clean } = doc;
      const c = canon(clean);
      if (row && !row.deleted && row.baseData && canon(JSON.parse(row.data)) === c && canon(JSON.parse(row.baseData)) === c) return 'unchanged';  // eco da nossa própria gravação, etc.
      this._write(col, String(id), clean, row?.createdAt ?? Date.now(), { dirty: 0, base: clean });
      this._bump();
      return row ? 'updated' : 'created';
    });
  }

  // Após ler a coleção INTEIRA da nuvem: remove o que a nuvem não tem mais — só linhas que este PC conhecia da
  // nuvem (têm base) e não têm alteração pendente. Linhas só-locais (sem base) e pendentes nunca são removidas.
  sweepMissing(col, presentIds) {
    this._check(col);
    const present = new Set(presentIds.map(String));
    return this.tx(() => {
      const gone = this.db.prepare(`SELECT id FROM "${col}" WHERE dirty = 0 AND baseData IS NOT NULL`).all().map(r => r.id).filter(id => !present.has(id));
      for (const id of gone) this.db.prepare(`DELETE FROM "${col}" WHERE id = ?`).run(id);
      if (gone.length) this._bump();
      return gone.length;
    });
  }

  removeRemote(col, id) {
    this._check(col);
    return this.tx(() => {
      const row = this.db.prepare(`SELECT dirty FROM "${col}" WHERE id = ?`).get(String(id));
      if (!row) return 'absent';
      if (row.dirty === 1) return 'skipped-dirty';
      this.db.prepare(`DELETE FROM "${col}" WHERE id = ?`).run(String(id));
      this._bump();
      return 'removed';
    });
  }

  // ── eventos de sincronização (alertas, erros, conflitos) ───────────────────────────────────
  logEvent({ kind, level = 'info', collection = null, docId = null, message, data = null, alert = false }) {
    this.db.prepare(`INSERT INTO sync_events (ts, kind, level, collection, docId, message, data, alert) VALUES (?,?,?,?,?,?,?,?)`)
      .run(Date.now(), kind, level, collection, docId, String(message).slice(0, 1000), data ? JSON.stringify(data) : null, alert ? 1 : 0);
    // mantém só os últimos 500 já vistos/irrelevantes
    this.db.prepare(`DELETE FROM sync_events WHERE id NOT IN (SELECT id FROM sync_events ORDER BY id DESC LIMIT 500)`).run();
  }
  listEvents({ limit = 30, alertsOnly = false, unackedOnly = false, levels = null } = {}) {
    const where = []; const params = [];
    if (alertsOnly) where.push('alert = 1');
    if (unackedOnly) where.push('ack = 0');
    if (levels) { where.push(`level IN (${levels.map(() => '?').join(',')})`); params.push(...levels); }
    return this.db.prepare(`SELECT * FROM sync_events ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY id DESC LIMIT ?`).all(...params, limit)
      .map(e => ({ ...e, data: e.data ? JSON.parse(e.data) : null, alert: !!e.alert, ack: !!e.ack }));
  }
  ackAlerts() { return this.db.prepare(`UPDATE sync_events SET ack = 1 WHERE alert = 1 AND ack = 0`).run().changes; }

  backupTo(file) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.existsSync(file)) fs.unlinkSync(file);
    this.db.exec(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  }

  close() { this.db.close(); }
}

export function httpError(status, message, code) {
  const e = new Error(message); e.status = status; if (code) e.code = code; return e;
}
