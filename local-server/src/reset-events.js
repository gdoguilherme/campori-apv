// Limpa os registros de ENSAIO do banco local: submissões, disciplinas e log de auditoria.
// MANTÉM regiões, unidades, participantes, requisitos e usuários. Dupla confirmação + backup automático ANTES.
// Padrão: exclusão com "tombstone" (dirty) → a limpeza também vai para a nuvem no próximo sync (exclusão vence).
// --so-local: apaga só neste PC (a nuvem pode trazê-los de volta no próximo "pull"). --dry-run: só mostra o que faria.
import fs from 'node:fs';
import path from 'node:path';
import { stamp } from './ops.js';

export const RESET_COLLECTIONS = ['submissions', 'disciplinaryActions', 'auditLog'];
export const KEEP_COLLECTIONS = ['regions', 'units', 'participants', 'requirements', 'users'];

export async function runReset({ store, config, io, now = new Date(), flags = {} }) {
  const counts = Object.fromEntries([...RESET_COLLECTIONS, ...KEEP_COLLECTIONS].map(c => [c, store.count(c)]));
  const toRemove = RESET_COLLECTIONS.reduce((a, c) => a + counts[c], 0);
  io.out(`Banco: ${config.dbPath}`);
  io.out(`Serão REMOVIDOS: ${counts.submissions} submissão(ões), ${counts.disciplinaryActions} disciplina(s), ${counts.auditLog} registro(s) de auditoria.`);
  io.out(`Serão MANTIDOS:  ${counts.regions} regiões, ${counts.units} unidades, ${counts.participants} participantes, ${counts.requirements} requisitos, ${counts.users} usuários.`);
  io.out(flags.soLocal ? 'Modo --so-local: apaga SÓ neste PC (a nuvem pode trazer de volta).' : 'A limpeza também será enviada à nuvem no próximo sync (se a sincronização estiver ligada).');
  if (toRemove === 0) { io.out('Nada a limpar.'); return 0; }
  if (flags.dryRun) { io.out('(simulação — nada foi alterado)'); return 0; }

  const a1 = String(await io.ask('\n1/2 — Isto apaga TODAS as pontuações lançadas até agora. Digite SIM para continuar: ')).trim();
  if (a1.toUpperCase() !== 'SIM') { io.out('Cancelado. Nada foi alterado.'); return 1; }
  const a2 = String(await io.ask(`2/2 — Confirma que o evento AINDA NÃO começou e que são só dados de teste? Digite APAGAR ${toRemove} para confirmar: `)).trim();
  if (a2.toUpperCase() !== `APAGAR ${toRemove}`) { io.out('Cancelado. Nada foi alterado.'); return 1; }

  // backup ANTES (se falhar, aborta: nunca apaga sem rede de segurança)
  let backup;
  try {
    fs.mkdirSync(config.backupDir, { recursive: true });
    backup = path.join(config.backupDir, `campori-pre-reset-${stamp(now)}.db`);
    store.backupTo(backup);
    if (!fs.existsSync(backup) || fs.statSync(backup).size === 0) throw new Error('arquivo de backup vazio');
  } catch (e) { io.err(`❌ Não foi possível fazer o backup (${e.message}). NADA foi apagado.`); return 2; }
  io.out(`💾 Backup feito: ${backup}`);

  store.tx(() => {
    for (const col of RESET_COLLECTIONS) {
      if (flags.soLocal) store.db.prepare(`DELETE FROM "${col}"`).run();
      else for (const doc of store.list(col)) store.remove(col, doc.id);
    }
    store._bump?.();
  });

  const after = Object.fromEntries([...RESET_COLLECTIONS, ...KEEP_COLLECTIONS].map(c => [c, store.count(c)]));
  const bad = RESET_COLLECTIONS.filter(c => after[c] !== 0).concat(KEEP_COLLECTIONS.filter(c => after[c] !== counts[c]));
  if (bad.length) { io.err(`❌ Conferência falhou em: ${bad.join(', ')}. Restaure o backup ${backup}.`); return 3; }
  store.logEvent?.({ kind: 'reset-test-events', level: 'warn', message: `Limpeza de ensaio: ${counts.submissions} submissões, ${counts.disciplinaryActions} disciplinas, ${counts.auditLog} auditorias removidas${flags.soLocal ? ' (só local)' : ''}. Backup: ${path.basename(backup)}` });
  io.out(`✅ Limpo. Removidos: ${toRemove} registro(s). Mantidos: regiões, unidades, participantes, requisitos e usuários.`);
  io.out('ℹ️  As fotos em data/uploads NÃO foram apagadas (apague a pasta à mão se quiser).');
  return 0;
}
