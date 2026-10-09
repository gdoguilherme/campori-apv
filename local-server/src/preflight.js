// Verificação pré-evento em UM comando (npm run preflight): imprime ✅/❌/⚠️ e termina com código ≠ 0 se algo bloqueante falhar.
// ❌ = precisa corrigir antes do evento · ⚠️ = informativo/atenção (não bloqueia).
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import dns from 'node:dns';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { DatabaseSync } from 'node:sqlite';
import { loadTls } from './https.js';
import { lastBackup, fmtBytes, diskFree } from './ops.js';
import { ROOT, REPO_ROOT } from './config.js';

export const EVENT_HOST = 'local.gdtmidia.com.br';
export const CLOUD_HEALTH = 'https://campori-apv-upload.fly.dev/health';
const MIN_NODE = [22, 13];

// ── dependências "do mundo" (substituíveis nos testes) ──────────────────────────────────────
export const realDeps = {
  nodeVersion: () => process.versions.node,
  portFree: port => new Promise(res => { const s = net.createServer(); s.once('error', () => res(false)); s.once('listening', () => s.close(() => res(true))); s.listen(port, '0.0.0.0'); }),
  // o servidor do Campori já está rodando nessa porta? (então "porta ocupada" é esperado)
  isOurServer: (port, useTls) => new Promise(res => {
    const lib = useTls ? https : http;
    const req = lib.get({ host: '127.0.0.1', port, path: '/health', timeout: 2500, rejectUnauthorized: false }, r => {
      let b = ''; r.on('data', d => { b += d; }); r.on('end', () => { try { res(JSON.parse(b)?.mode === 'local'); } catch { res(false); } });
    });
    req.on('error', () => res(false)); req.on('timeout', () => { req.destroy(); res(false); });
  }),
  resolveHost: host => dns.promises.resolve4(host),
  localIps: () => Object.values(os.networkInterfaces()).flat().filter(i => i && i.family === 'IPv4' && !i.internal).map(i => i.address),
  cloudProbe: () => new Promise(res => {
    const req = https.get(CLOUD_HEALTH, { timeout: 5000 }, r => { r.resume(); res(r.statusCode === 200); });
    req.on('error', () => res(false)); req.on('timeout', () => { req.destroy(); res(false); });
  }),
  envFileExists: () => fs.existsSync(path.join(ROOT, '.env')),
  credentialsFile: env => env.FIREBASE_CREDENTIALS_FILE || path.join(REPO_ROOT, 'server', 'campori-apv-firebase-adminsdk.json'),
};

const ok = (id, title, detail = '') => ({ id, level: 'ok', title, detail });
const fail = (id, title, detail = '') => ({ id, level: 'fail', title, detail });
const warn = (id, title, detail = '') => ({ id, level: 'warn', title, detail });

export async function runPreflight({ config, env = process.env, now = Date.now(), deps = {} }) {
  const d = { ...realDeps, ...deps };
  const checks = [];
  const step = async (id, fn) => { try { checks.push(await fn()); } catch (e) { checks.push(fail(id, id, `erro inesperado: ${e.message}`)); } };

  await step('node', async () => {
    const v = d.nodeVersion(); const [maj, min] = v.split('.').map(Number);
    return maj > MIN_NODE[0] || (maj === MIN_NODE[0] && min >= MIN_NODE[1]) ? ok('node', `Node.js ${v}`, 'versão ≥ 22.13')
      : fail('node', `Node.js ${v} é antigo`, 'Instale o Node.js 22 LTS (https://nodejs.org) e abra um terminal novo.');
  });

  await step('env', async () => {
    if (!d.envFileExists()) return fail('env', 'Arquivo .env não encontrado', 'Copie .env.example para .env e preencha QR_SECRET (mesmo valor do Fly).');
    if (!env.QR_SECRET) return fail('env', '.env sem QR_SECRET', 'QR_SECRET precisa ser IGUAL ao do Fly, senão os QR Codes não validam.');
    if (String(env.QR_SECRET).length < 12) return warn('env', 'QR_SECRET muito curto', 'Confira se é o mesmo segredo do Fly.');
    return ok('env', '.env com QR_SECRET');
  });

  await step('cloud-sync', async () => {
    if (!config.cloudSync) return fail('cloud-sync', 'CLOUD_SYNC desligado', 'Ponha CLOUD_SYNC=1 no .env para sincronizar com a nuvem (sem isso, tudo fica só neste PC).');
    const cred = d.credentialsFile(env);
    return fs.existsSync(cred) ? ok('cloud-sync', 'CLOUD_SYNC=1 e credenciais do Firebase encontradas', cred)
      : fail('cloud-sync', 'CLOUD_SYNC=1, mas sem credenciais do Firebase', `Arquivo não encontrado: ${cred}`);
  });

  await step('cert', async () => {
    const t = loadTls(config);
    if (t.error === 'not-configured') return fail('cert', 'HTTPS não configurado', 'Defina HTTPS_CERT_PATH e HTTPS_KEY_PATH (GUIA-WINDOWS.md, seção HTTPS) — sem HTTPS o app instalado no celular não fala com o PC.');
    if (t.error) return fail('cert', 'Certificado/chave inválidos', t.message || t.error);
    const { daysLeft, validTo } = t.info;
    if (daysLeft < 0) return fail('cert', 'Certificado VENCIDO', `Venceu em ${validTo.slice(0, 10)}. Renove com o win-acme (wacs.exe → R).`);
    if (daysLeft < 15) return warn('cert', `Certificado vence em ${daysLeft} dia(s)`, 'Renove com o win-acme antes do evento.');
    return ok('cert', `Certificado e chave válidos (${daysLeft} dias restantes)`, `válido até ${validTo.slice(0, 10)}`);
  });

  for (const [id, port, useTls] of [['port-https', config.httpsPort, true], ['port-http', config.port, false]]) {
    await step(id, async () => {
      if (await d.portFree(port)) return ok(id, `Porta ${port} livre`);
      if (await d.isOurServer(port, useTls)) return ok(id, `Porta ${port} em uso pelo servidor do Campori`, 'o servidor já está rodando — tudo certo');
      return fail(id, `Porta ${port} ocupada por outro programa`, 'Feche o programa que a usa (ex.: IIS, Skype, outro servidor) ou mude a porta no .env.');
    });
  }

  await step('db', async () => {
    if (!fs.existsSync(config.dbPath)) return fail('db', 'Banco não encontrado', `Esperado em ${config.dbPath}. Rode "npm run pull-cloud" ou copie o banco do ensaio.`);
    const db = new DatabaseSync(config.dbPath, { readOnly: true });
    try {
      const n = t => db.prepare(`SELECT COUNT(*) n FROM "${t}" WHERE deleted = 0`).get().n;
      const c = { regiões: n('regions'), unidades: n('units'), participantes: n('participants'), requisitos: n('requirements'), usuários: n('users') };
      const txt = Object.entries(c).map(([k, v]) => `${v} ${k}`).join(' · ');
      const empty = ['regiões', 'unidades', 'requisitos', 'usuários'].filter(k => c[k] === 0);
      if (empty.length) return fail('db', `Banco vazio em: ${empty.join(', ')}`, `${txt}. Faça "npm run pull-cloud" para trazer os dados da nuvem.`);
      if (c.participantes === 0) return warn('db', 'Banco abre, mas sem participantes', txt);
      return ok('db', 'Banco abre e tem dados', txt);
    } finally { db.close(); }
  });

  await step('backup', async () => {
    if (config.backupEveryMin <= 0) return warn('backup', 'Backup automático desligado (BACKUP_EVERY_MIN=0)');
    const b = lastBackup(config.backupDir);
    if (!b) return fail('backup', 'Nenhum backup encontrado', `Deixe o servidor rodando alguns minutos (pasta ${config.backupDir}).`);
    const min = Math.round((now - b.at) / 60000);
    return min <= 15 ? ok('backup', `Último backup há ${min} min`, `${b.count} guardados`)
      : fail('backup', `Último backup há ${min} min (limite 15)`, 'O servidor está rodando? O backup automático acontece a cada 10 min.');
  });

  await step('disk', async () => {
    const f = diskFree(config.dbPath);
    if (!f) return warn('disk', 'Não consegui medir o espaço em disco');
    return f.freeBytes < 2 * 1024 ** 3 ? warn('disk', `Pouco espaço em disco: ${fmtBytes(f.freeBytes)} livres`, 'Fotos e backups precisam de espaço.') : ok('disk', `${fmtBytes(f.freeBytes)} livres em disco`);
  });

  await step('dns', async () => {
    let resolved;
    try { resolved = await d.resolveHost(EVENT_HOST); } catch (e) {
      return warn('dns', `Não consegui resolver ${EVENT_HOST}`, `${e.code || e.message} — sem internet/DNS local agora? Teste de outro aparelho: nslookup ${EVENT_HOST}`);
    }
    const mine = d.localIps();
    return resolved.some(ip => mine.includes(ip)) ? ok('dns', `${EVENT_HOST} → ${resolved.join(', ')} (é o IP deste PC)`)
      : fail('dns', `${EVENT_HOST} aponta para ${resolved.join(', ')}, mas este PC é ${mine.join(', ') || '?'}`, 'Ajuste o registro A no Cloudflare / o DNS local (Acrylic) para o IP deste PC.');
  });

  await step('cloud', async () => (await d.cloudProbe())
    ? ok('cloud', 'Nuvem (Fly) respondendo', 'informativo')
    : warn('cloud', 'Nuvem (Fly) não respondeu', 'informativo — sem internet o evento funciona só com o PC; a sincronização acontece quando voltar.'));

  return { checks, ok: !checks.some(c => c.level === 'fail'), failures: checks.filter(c => c.level === 'fail').length, warnings: checks.filter(c => c.level === 'warn').length };
}

export const ICON = { ok: '✅', fail: '❌', warn: '⚠️ ' };
export function formatPreflight(r) {
  const lines = r.checks.map(c => `${ICON[c.level]} ${c.title}${c.detail ? `\n     ${c.detail}` : ''}`);
  lines.push('', r.ok ? `✅ PRONTO${r.warnings ? ` (${r.warnings} aviso(s) acima)` : ''}` : `❌ ${r.failures} item(ns) para corrigir antes do evento`);
  return lines.join('\n');
}
