// Firestore falso em memória para testar a sincronização SEM tocar na produção.
// Simula: transações serializadas, queries de igualdade, Timestamps, listeners (onSnapshot),
// internet caindo (online=false / failAfter=N), conexão pendurada (hang) e "crash" logo após um commit.
export class FakeTimestamp {
  constructor(ms) { this.seconds = Math.floor(ms / 1000); this.nanoseconds = (ms % 1000) * 1e6; }
  static fromMillis(ms) { return new FakeTimestamp(ms); }
  toMillis() { return this.seconds * 1000 + this.nanoseconds / 1e6; }
}
export const unavailable = () => Object.assign(new Error('14 UNAVAILABLE: No connection established'), { code: 14 });

export class FakeFirestore {
  constructor() {
    this.cols = {}; this._q = Promise.resolve(); this.listeners = [];
    this.online = true; this.hang = false; this.failAfter = null; this.ops = 0;
    this.crashAfterCommits = null; this.beforeCommit = null; this.denyDocs = new Set();
  }
  _gate() {
    this.ops++;
    if (this.hang) return new Promise(() => {});
    if (!this.online) throw unavailable();
    if (this.failAfter !== null) { if (this.failAfter <= 0) { this.online = false; throw unavailable(); } this.failAfter--; }
  }
  _col(n) { return (this.cols[n] ||= new Map()); }
  seed(col, id, data) { this._col(col).set(id, { ...data }); }
  all(col) { return [...this._col(col)].map(([id, d]) => ({ id, ...d })); }
  get(col, id) { const d = this._col(col).get(id); return d ? { id, ...d } : null; }
  _emit(col, type, id) { for (const l of this.listeners.filter(x => x.col === col)) l.cb({ docChanges: () => [{ type, doc: this._snap(col, id) }], docs: this.all(col).map(d => this._snap(col, d.id)) }); }
  _snap(col, id) { const d = this._col(col).get(id); return { id, exists: !!d, data: () => ({ ...d }) }; }
  _apply(col, id, op, data) {
    const m = this._col(col); const had = m.has(id);
    if (op === 'delete') { m.delete(id); if (had) this._emit(col, 'removed', id); }
    else { m.set(id, op === 'update' ? { ...m.get(id), ...data } : { ...data }); this._emit(col, had ? 'modified' : 'added', id); }
  }

  collection(name) {
    const db = this;
    const snapOf = (id, o) => ({ id, exists: !!o, data: () => ({ ...o }) });
    const mkQuery = filters => ({
      where: (f, _op, v) => mkQuery([...filters, [f, v]]),
      __get: async () => ({ docs: [...db._col(name)].filter(([, o]) => filters.every(([f, v]) => o[f] === v)).map(([id, o]) => snapOf(id, o)) }),
      async get() { await db._gate(); return this.__get(); },
    });
    return {
      ...mkQuery([]),
      onSnapshot(cb, errCb) {
        const l = { col: name, cb, errCb }; db.listeners.push(l);
        queueMicrotask(() => cb({ docChanges: () => db.all(name).map(d => ({ type: 'added', doc: db._snap(name, d.id) })), docs: db.all(name).map(d => db._snap(name, d.id)) }));
        return () => { db.listeners = db.listeners.filter(x => x !== l); };
      },
      doc: id => ({
        id,
        __get: async () => snapOf(id, db._col(name).get(id)),
        async get() { await db._gate(); return this.__get(); },
        async set(d) { await db._gate(); db._apply(name, id, 'set', d); },
        async update(p) { await db._gate(); if (!db._col(name).has(id)) throw Object.assign(new Error('5 NOT_FOUND'), { code: 5 }); db._apply(name, id, 'update', p); },
        async delete() { await db._gate(); db._apply(name, id, 'delete'); },
        __col: name,
      }),
    };
  }

  // transações serializadas (o Firestore real faz retry em contenção; o efeito é o mesmo)
  runTransaction(fn) {
    const run = async () => {
      await this._gate();
      const writes = [];
      const tx = {
        get: async x => { await this._gate(); if (x.id && this.denyDocs.has(x.id)) throw Object.assign(new Error('7 PERMISSION_DENIED'), { code: 7 }); return x.__get(); },
        set: (ref, d) => writes.push(() => ref.__col && this._apply(ref.__col, ref.id, 'set', d)),
        update: (ref, p) => writes.push(() => this._apply(ref.__col, ref.id, 'update', p)),
        delete: ref => writes.push(() => this._apply(ref.__col, ref.id, 'delete')),
      };
      const r = await fn(tx);
      if (this.beforeCommit) await this.beforeCommit();
      writes.forEach(w => w());
      if (this.crashAfterCommits !== null && --this.crashAfterCommits < 0) throw unavailable(); // a internet cai logo DEPOIS do commit (resposta perdida)
      return r;
    };
    const p = this._q.then(run); this._q = p.catch(() => {}); return p;
  }
}
export const fakeAdmin = { firestore: { Timestamp: FakeTimestamp } };
