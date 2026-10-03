import { DatabaseSync } from 'node:sqlite';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

// Schema espelha as coleções do Firestore: UMA TABELA POR COLEÇÃO, com o documento
// inteiro em `data` (JSON) + colunas indexadas só pros campos usados em filtros.
// Guardar o doc como veio do Firestore garante fidelidade na sincronização (Fase 3).
// Colunas de controle de sync: updatedAt (ms), deleted (tombstone), dirty (alterado localmente).
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
    this.db.exec(`INSERT OR IGNORE INTO meta(key,value) VALUES ('revision','0')`);
  }

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

  _write(col, id, data, createdAt, { dirty = 1 } = {}) {
    const idx = INDEXED[col];
    const vals = idx.map(c => (data[c] === undefined || data[c] === null) ? null : String(data[c]));
    const cols = ['id', ...idx.map(c => `"${c}"`), 'data', 'createdAt', 'updatedAt', 'deleted', 'dirty'];
    const sql = `INSERT OR REPLACE INTO "${col}" (${cols.join(',')}) VALUES (${cols.map(() => '?').join(',')})`;
    this.db.prepare(sql).run(id, ...vals, JSON.stringify(data), createdAt, Date.now(), 0, dirty);
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
      for (const { id, ...doc } of docs) this._write(col, id, doc, Date.now(), { dirty: 0 });
      this._bump();
    });
  }

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
