// Ferramenta de ÚLTIMO CASO para mexer direto no banco local (SQLite): listar, ver, alterar e apagar registros.
// Regras de segurança (sempre):
//   • BACKUP do banco inteiro antes de qualquer gravação (backups/dbtool/) — se o backup falhar, nada é gravado;
//   • mostra o que vai mudar (diff) e pede confirmação (ou --yes);
//   • valida o JSON (objeto, sem trocar o id, colunas indexadas só com valores simples);
//   • gravação pelo próprio Store: dirty=1 (será enviado à nuvem), updatedAt estritamente crescente, colunas
//     indexadas recalculadas a partir do JSON, versão (revision) incrementada;
//   • depois de gravar, RELÊ o registro e confere se as colunas indexadas batem com o JSON;
//   • segredos (passwordHash) aparecem mascarados.
import fs from 'node:fs';
import path from 'node:path';
import { COLLECTIONS, INDEXED, canon } from './db.js';

const MAX_DOC_BYTES = 1_000_000;
const SECRET_KEYS = new Set(['passwordHash', 'password']);

// ── linhas cruas (com colunas de controle) ────────────────────────────────────
const rawRow = (store, col, id) => store.db.prepare(`SELECT * FROM "${col}" WHERE id = ?`).get(String(id)) || null;
const mask = o => (o && typeof o === 'object' && !Array.isArray(o)
  ? Object.fromEntries(Object.entries(o).map(([k, v]) => [k, SECRET_KEYS.has(k) ? '***' : mask(v)])) : o);

const iso = ms => (ms ? new Date(ms).toISOString().replace('T', ' ').slice(0, 19) : '—');
const pad = (s, n) => String(s ?? '').slice(0, n).padEnd(n);

// colunas indexadas esperadas a partir do JSON (mesma regra do Store._write)
const expectedIndex = (col, doc) => Object.fromEntries(INDEXED[col].map(c => [c, doc[c] === undefined || doc[c] === null ? null : String(doc[c])]));

// ── validação ────────────────────────────────────────────────────────────────
export function validateDoc(col, doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) throw new Error('O conteúdo precisa ser um objeto JSON (ex.: {"campo": "valor"}).');
  if ('id' in doc) throw new Error('Não é permitido alterar o "id" do registro.');
  for (const c of INDEXED[col]) {
    const v = doc[c];
    if (v !== undefined && v !== null && !['string', 'number', 'boolean'].includes(typeof v)) {
      throw new Error(`O campo "${c}" é indexado e precisa ser texto, número, true/false ou null (recebi ${Array.isArray(v) ? 'lista' : typeof v}).`);
    }
  }
  const text = JSON.stringify(doc);
  if (text === undefined || Buffer.byteLength(text) > MAX_DOC_BYTES) throw new Error('JSON inválido ou grande demais (limite de 1 MB).');
  JSON.parse(text);                                                        // ida e volta
  return true;
}

function parseValue(txt) { try { return JSON.parse(txt); } catch { return txt; } }   // "12" → 12, "true" → true, "abc" → "abc"

// Monta o patch a partir de --json / --file / --campo nome=valor
export function readPatch(opts) {
  let patch = {};
  if (opts.json) { try { patch = JSON.parse(opts.json); } catch (e) { throw new Error(`--json inválido: ${e.message}`); } }
  if (opts.file) {
    if (!fs.existsSync(opts.file)) throw new Error(`Arquivo não encontrado: ${opts.file}`);
    try { patch = { ...patch, ...JSON.parse(fs.readFileSync(opts.file, 'utf8')) }; } catch (e) { throw new Error(`Arquivo JSON inválido: ${e.message}`); }
  }
  for (const kv of opts.campo || []) {
    const i = kv.indexOf('=');
    if (i < 1) throw new Error(`--campo precisa ser nome=valor (recebi "${kv}").`);
    patch[kv.slice(0, i)] = parseValue(kv.slice(i + 1));
  }
  return patch;
}

// ── parser de argumentos ─────────────────────────────────────────────────────
export function parseArgs(argv) {
  const pos = [], opts = { campo: [] };
  const flags = new Set(['dirty', 'deleted', 'replace', 'dry-run', 'yes', 'fix', 'raw', 'show-secrets', 'help']);
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { pos.push(a); continue; }
    const k = a.slice(2);
    if (flags.has(k)) opts[k] = true;
    else if (k === 'campo') opts.campo.push(argv[++i] ?? '');
    else opts[k] = argv[++i];
  }
  return { cmd: pos[0], args: pos.slice(1), opts };
}

// ── comandos ─────────────────────────────────────────────────────────────────
function summary(col, d) {
  switch (col) {
    case 'users': return `${d.username ?? ''} (${d.role ?? ''})${d.active === false ? ' [inativo]' : ''}`;
    case 'submissions': return `${d.requirementName ?? d.requirementId ?? ''} · ${d.status ?? ''} · ${d.requirementPoints ?? ''}pts · ${d.unitId ? 'un:' + d.unitId : 'região:' + d.regionId}`;
    case 'disciplinaryActions': return `${d.targetType}:${d.targetName ?? d.targetId} · ${d.reason ?? ''}`;
    case 'auditLog': return `${d.action ?? ''} · ${d.byName ?? ''}`;
    default: return d.name ?? '';
  }
}

const needCol = (store, col) => { if (!COLLECTIONS.includes(col)) throw new Error(`Coleção desconhecida: "${col}". Use: ${COLLECTIONS.join(', ')}.`); };

function cmdHelp({ store, io }) {
  io.out('\nFerramenta de ÚLTIMO CASO — banco local do Campori\n');
  io.out('  npm run dbtool -- list <coleção> [--where campo=valor] [--dirty] [--deleted] [--limit 50] [--raw]');
  io.out('  npm run dbtool -- show <coleção> <id>');
  io.out('  npm run dbtool -- set <coleção> <id> --campo nome=valor [--campo ...]   (altera só esses campos)');
  io.out('  npm run dbtool -- set <coleção> <id> --file alteracao.json              (idem, a partir de um arquivo JSON)');
  io.out('  npm run dbtool -- set <coleção> <id> --json "{...}" [--replace]          (--replace troca o registro INTEIRO)');
  io.out('  npm run dbtool -- delete <coleção> <id>');
  io.out('  npm run dbtool -- check [--fix]      confere/corrige colunas indexadas e JSON de todos os registros');
  io.out('  npm run dbtool -- backup             cópia do banco agora');
  io.out('  Opções de gravação: --dry-run (só mostra)  --yes (não pergunta)');
  io.out('\nToda gravação faz BACKUP antes, marca o registro como pendente de envio à nuvem (dirty=1) e fica registrada no painel.');
  io.out('\nColeções (registros · pendentes de envio):');
  const dirty = store.dirtyCounts().byCollection;
  for (const c of COLLECTIONS) io.out(`  ${pad(c, 22)} ${String(store.count(c)).padStart(5)} · ${dirty[c] || 0}`);
  io.out('');
  return 0;
}

function cmdList({ store, io, args, opts }) {
  const [col] = args; needCol(store, col);
  const where = [], params = [];
  if (!opts.deleted) where.push('deleted = 0');
  if (opts.dirty) where.push('dirty = 1');
  if (opts.where) {
    const i = opts.where.indexOf('=');
    const k = opts.where.slice(0, i), v = opts.where.slice(i + 1);
    if (i < 1 || !INDEXED[col].includes(k)) throw new Error(`--where só aceita campos indexados de ${col}: ${INDEXED[col].join(', ') || '(nenhum)'}.`);
    where.push(`"${k}" = ?`); params.push(v);
  }
  const limit = Math.min(Number(opts.limit) || 50, 1000);
  const rows = store.db.prepare(`SELECT id, data, dirty, deleted, updatedAt FROM "${col}" ${where.length ? 'WHERE ' + where.join(' AND ') : ''} ORDER BY updatedAt DESC LIMIT ?`).all(...params, limit);
  if (opts.raw) { io.out(JSON.stringify(rows.map(r => ({ id: r.id, ...mask(JSON.parse(r.data)) })), null, 2)); return 0; }
  io.out(`\n${col}: ${rows.length} registro(s)${rows.length === limit ? ` (limite ${limit}; use --limit)` : ''}\n`);
  io.out(`${pad('ID', 22)} ${pad('ENV', 4)} ${pad('ATUALIZADO', 19)}  RESUMO`);
  for (const r of rows) io.out(`${pad(r.id, 22)} ${pad(r.deleted ? 'DEL' : r.dirty ? 'pend' : 'ok', 4)} ${pad(iso(r.updatedAt), 19)}  ${summary(col, JSON.parse(r.data))}`);
  io.out('\nENV: ok = já enviado à nuvem · pend = aguardando envio · DEL = apagado (aguardando envio).');
  return 0;
}

function cmdShow({ store, io, args, opts }) {
  const [col, id] = args; needCol(store, col);
  if (!id) throw new Error('Informe o id: show <coleção> <id>');
  const r = rawRow(store, col, id);
  if (!r) throw new Error(`Registro não encontrado: ${col}/${id}`);
  const doc = JSON.parse(r.data);
  io.out(JSON.stringify({ id: r.id, ...(opts['show-secrets'] ? doc : mask(doc)) }, null, 2));
  io.out(`\n— situação: ${r.deleted ? 'APAGADO (aguardando envio da exclusão)' : r.dirty ? 'PENDENTE de envio à nuvem' : 'sincronizado'} · atualizado ${iso(r.updatedAt)} · criado ${iso(r.createdAt)}`);
  if (r.syncError) io.out(`— último erro de envio (${r.syncAttempts} tentativa(s)): ${r.syncError}`);
  io.out(`— versão da nuvem conhecida: ${r.baseData ? 'sim' : 'não (só local)'}`);
  const bad = indexMismatch(col, r, doc);
  if (bad.length) io.out(`⚠️  colunas indexadas fora do JSON: ${bad.map(b => `${b.col} (coluna=${b.have} json=${b.want})`).join(', ')} — rode: check --fix`);
  return 0;
}

function indexMismatch(col, row, doc) {
  const want = expectedIndex(col, doc);
  return INDEXED[col].filter(c => (row[c] ?? null) !== want[c]).map(c => ({ col: c, have: row[c] ?? null, want: want[c] }));
}

// diff legível (segredos mascarados)
function diffLines(before, after) {
  const keys = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const lines = [];
  for (const k of keys) {
    if (canon(before[k]) === canon(after[k])) continue;
    const show = v => (SECRET_KEYS.has(k) ? '***' : v === undefined ? '(não existia)' : JSON.stringify(v));
    lines.push(`  ${k}: ${show(before[k])}  →  ${after[k] === undefined ? '(removido)' : show(after[k])}`);
  }
  return lines;
}

function makeBackup({ store, config, now, label }) {
  const stamp = new Date(now()).toISOString().replace(/[:T]/g, '-').slice(0, 19);
  const file = path.join(config.backupDir, 'dbtool', `dbtool-${stamp}-${label}.db`.replace(/[^\w.\-]/g, '_'));
  store.backupTo(file);
  if (!fs.existsSync(file) || fs.statSync(file).size === 0) throw new Error('Backup falhou — nada foi gravado.');
  return file;
}

async function confirmWrite({ io, opts }, text) {
  if (opts['dry-run']) { io.out('\n(--dry-run: nada foi gravado)'); return false; }
  if (opts.yes) return true;
  return io.confirm(`\n${text} Digite SIM para confirmar: `);
}

async function cmdSet(ctx) {
  const { store, io, config, now, args, opts } = ctx;
  const [col, id] = args; needCol(store, col);
  if (!id) throw new Error('Informe o id: set <coleção> <id> --campo nome=valor');
  const patch = readPatch(opts);
  if (!Object.keys(patch).length) throw new Error('Nada para alterar: use --campo nome=valor, --file ou --json.');
  validateDoc(col, patch);
  const row = rawRow(store, col, id);
  if (!row || row.deleted) throw new Error(`Registro não encontrado: ${col}/${id}${row?.deleted ? ' (está apagado)' : ''}`);
  const before = JSON.parse(row.data);
  const after = opts.replace ? { ...patch } : { ...before, ...patch };
  for (const [k, v] of Object.entries(after)) if (v && typeof v === 'object' && v.__delete) delete after[k];
  const resolved = Object.fromEntries(Object.entries(after).map(([k, v]) => [k, v])); // sentinelas (__serverTimestamp) são resolvidas pelo Store
  validateDoc(col, resolved);

  const lines = diffLines(before, after);
  if (!lines.length) { io.out('Nada mudou (os valores já eram esses).'); return 0; }
  io.out(`\n${opts.replace ? 'SUBSTITUIR o registro inteiro' : 'Alterar'} ${col}/${id}:\n${lines.join('\n')}`);
  if (!(await confirmWrite(ctx, 'O registro será marcado para envio à nuvem.'))) return opts['dry-run'] ? 0 : 1;

  const bk = makeBackup({ store, config, now, label: `set-${col}-${id}` });
  io.out(`\nBackup: ${bk}`);
  if (opts.replace) store.insert(col, after, String(id)); else store.update(col, String(id), patch);

  const check = rawRow(store, col, id);
  const bad = indexMismatch(col, check, JSON.parse(check.data));
  if (bad.length || check.dirty !== 1) throw new Error(`Verificação pós-gravação falhou (${bad.length ? 'colunas indexadas' : 'dirty'}). Restaure o backup: ${bk}`);
  store.logEvent({ kind: 'dbtool', level: 'warn', collection: col, docId: String(id), message: `Registro ${col}/${id} alterado manualmente pelo dbtool (${Object.keys(patch).join(', ')}).` });
  io.out(`✅ Gravado. ${col}/${id} está pendente de envio à nuvem (dirty=1), atualizado ${iso(check.updatedAt)}.`);
  return 0;
}

async function cmdDelete(ctx) {
  const { store, io, config, now, args, opts } = ctx;
  const [col, id] = args; needCol(store, col);
  if (!id) throw new Error('Informe o id: delete <coleção> <id>');
  const row = rawRow(store, col, id);
  if (!row || row.deleted) throw new Error(`Registro não encontrado: ${col}/${id}${row?.deleted ? ' (já está apagado)' : ''}`);
  io.out(`\nAPAGAR ${col}/${id}: ${summary(col, JSON.parse(row.data))}`);
  if (!(await confirmWrite(ctx, 'A exclusão também será enviada à nuvem.'))) return opts['dry-run'] ? 0 : 1;
  const bk = makeBackup({ store, config, now, label: `delete-${col}-${id}` });
  io.out(`\nBackup: ${bk}`);
  store.remove(col, String(id));
  const check = rawRow(store, col, id);
  if (!check || check.deleted !== 1 || check.dirty !== 1) throw new Error(`Verificação pós-exclusão falhou. Restaure o backup: ${bk}`);
  store.logEvent({ kind: 'dbtool', level: 'warn', collection: col, docId: String(id), message: `Registro ${col}/${id} apagado manualmente pelo dbtool.` });
  io.out(`✅ Apagado (marcado para exclusão na nuvem, dirty=1).`);
  return 0;
}

async function cmdCheck(ctx) {
  const { store, io, config, now, opts } = ctx;
  const problems = [];
  for (const col of COLLECTIONS) {
    for (const r of store.db.prepare(`SELECT * FROM "${col}"`).all()) {
      let doc; try { doc = JSON.parse(r.data); } catch { problems.push({ col, id: r.id, kind: 'json', text: 'JSON inválido em "data"' }); continue; }
      for (const b of indexMismatch(col, r, doc)) problems.push({ col, id: r.id, kind: 'index', fix: b, text: `coluna ${b.col}=${b.have} mas o JSON diz ${b.want}` });
    }
  }
  if (!problems.length) { io.out('✅ Tudo coerente: JSON válido e colunas indexadas batem em todos os registros.'); return 0; }
  io.out(`⚠️  ${problems.length} problema(s):`);
  for (const p of problems.slice(0, 50)) io.out(`  ${p.col}/${p.id}: ${p.text}`);
  if (!opts.fix) { io.out('\nUse "check --fix" para corrigir as colunas indexadas (registros com JSON inválido precisam de correção manual).'); return 1; }
  const bk = makeBackup({ store, config, now, label: 'check-fix' });
  io.out(`\nBackup: ${bk}`);
  let fixed = 0;
  store.tx(() => {
    for (const p of problems.filter(x => x.kind === 'index')) {
      store.db.prepare(`UPDATE "${p.col}" SET "${p.fix.col}" = ? WHERE id = ?`).run(p.fix.want, p.id); fixed++;     // só a coluna; o JSON não muda, então não vira pendência
    }
  });
  io.out(`✅ ${fixed} coluna(s) corrigida(s).${problems.some(p => p.kind === 'json') ? ' Ainda há registro(s) com JSON inválido (manual).' : ''}`);
  return problems.some(p => p.kind === 'json') ? 1 : 0;
}

function cmdBackup({ store, io, config, now }) {
  const bk = makeBackup({ store, config, now, label: 'manual' });
  io.out(`✅ Backup criado: ${bk}`);
  return 0;
}

const COMMANDS = { list: cmdList, show: cmdShow, set: cmdSet, delete: cmdDelete, check: cmdCheck, backup: cmdBackup, help: cmdHelp };

// Ponto de entrada (usado pelo CLI e pelos testes). Retorna o código de saída.
export async function runDbtool(argv, { store, config, io, now = Date.now }) {
  const { cmd, args, opts } = parseArgs(argv);
  const fn = COMMANDS[cmd] || (!cmd || opts.help ? cmdHelp : null);
  if (!fn) { io.err(`Comando desconhecido: "${cmd}". Rode sem argumentos para ver a ajuda.`); return 2; }
  try { return (await fn({ store, config, io, now, args, opts })) ?? 0; }
  catch (e) { io.err(`\n❌ ${e.message}`); return 1; }
}
