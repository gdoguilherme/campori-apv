import fs from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import crypto from 'node:crypto';

// ── Certificado ───────────────────────────────────────────────
// Lê e valida cert+key (a chave tem que casar com o certificado). Nunca lança: devolve { error }.
export function loadTls(config) {
  const { httpsCertPath: certPath, httpsKeyPath: keyPath } = config;
  if (!certPath && !keyPath) return { error: 'not-configured' };
  if (!certPath || !keyPath) return { error: 'incomplete', message: 'Defina HTTPS_CERT_PATH E HTTPS_KEY_PATH no .env (só um deles está preenchido).' };
  for (const [nome, f] of [['HTTPS_CERT_PATH', certPath], ['HTTPS_KEY_PATH', keyPath]]) {
    if (!fs.existsSync(f)) return { error: 'missing-file', message: `Arquivo não encontrado: ${f} (${nome})` };
  }
  try {
    const cert = fs.readFileSync(certPath), key = fs.readFileSync(keyPath);
    const x509 = new crypto.X509Certificate(cert);
    if (!x509.checkPrivateKey(crypto.createPrivateKey(key))) {
      return { error: 'key-mismatch', message: 'A chave privada não corresponde ao certificado (arquivos de emissões diferentes?).' };
    }
    const validTo = new Date(x509.validTo);
    return {
      cert, key,
      info: {
        subject: x509.subject.replace(/\n/g, ', '), altNames: x509.subjectAltName || '',
        validTo: validTo.toISOString(), daysLeft: Math.floor((validTo - Date.now()) / 86400_000),
        fingerprint: x509.fingerprint256,
      },
    };
  } catch (e) {
    return { error: 'invalid', message: `Certificado/chave inválidos: ${e.message}` };
  }
}

const NOT_CONFIGURED_MSG =
  'HTTPS DESLIGADO — HTTPS_CERT_PATH/HTTPS_KEY_PATH não estão no .env. O servidor roda só em HTTP: ' +
  'o app instalado (PWA, vindo de https://campori.gdtmidia.com.br) NÃO consegue falar com ele. ' +
  'Siga a seção "HTTPS" do GUIA-WINDOWS.md.';

// Sobe HTTP (sempre — porta de testes/health/supervisor) e HTTPS (se o certificado existir).
// Falha de HTTPS NUNCA derruba o servidor: registra o motivo e segue em HTTP.
// Retorna { http, https|null, tls() , close() } — tls() é o status que o /health mostra.
export async function startServers({ app, config, log }) {
  const status = { enabled: false, port: config.httpsPort, error: null, validTo: null, daysLeft: null, subject: null };

  const httpServer = http.createServer(app);
  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(config.port, '0.0.0.0', resolve);
  });

  let httpsServer = null;
  const timers = [];
  const loaded = loadTls(config);

  if (loaded.error === 'not-configured') {
    status.error = 'not-configured';
    log.warn(NOT_CONFIGURED_MSG);
  } else if (loaded.error) {
    status.error = loaded.error;
    log.error(`HTTPS DESLIGADO — ${loaded.message} Rodando só em HTTP.`);
  } else {
    const applyInfo = info => {
      Object.assign(status, { validTo: info.validTo, daysLeft: info.daysLeft, subject: info.subject });
      if (info.daysLeft < 0) log.error(`CERTIFICADO VENCIDO há ${-info.daysLeft} dia(s) (${info.validTo}) — os celulares vão recusar a conexão. Renove com o win-acme.`);
      else if (info.daysLeft < 15) log.warn(`Certificado vence em ${info.daysLeft} dia(s) (${info.validTo}). Confirme a renovação automática do win-acme.`);
    };
    try {
      // createServer também pode lançar (cert/chave que o OpenSSL recusa) — por isso está DENTRO do try
      httpsServer = https.createServer({ cert: loaded.cert, key: loaded.key, minVersion: 'TLSv1.2' }, app);
      await new Promise((resolve, reject) => {
        httpsServer.once('error', reject);
        httpsServer.listen(config.httpsPort, '0.0.0.0', resolve);
      });
      status.enabled = true;
      applyInfo(loaded.info);
      log.info(`HTTPS ativo na porta ${config.httpsPort} — ${loaded.info.subject} — válido até ${loaded.info.validTo} (${loaded.info.daysLeft} dias)`);

      // Renovação: o win-acme grava os arquivos novos; recarregamos SEM reiniciar o servidor.
      let lastFp = loaded.info.fingerprint;
      const reload = () => {
        const next = loadTls(config);
        if (next.error) return; // arquivo no meio da gravação, ou inválido: tenta no próximo ciclo
        if (next.info.fingerprint === lastFp) return;
        httpsServer.setSecureContext({ cert: next.cert, key: next.key });
        lastFp = next.info.fingerprint;
        applyInfo(next.info);
        log.info(`Certificado HTTPS recarregado (renovação) — válido até ${next.info.validTo}`);
      };
      for (const f of [config.httpsCertPath, config.httpsKeyPath]) fs.watchFile(f, { interval: config.certWatchMs ?? 30_000 }, reload);
      timers.push(() => { for (const f of [config.httpsCertPath, config.httpsKeyPath]) fs.unwatchFile(f, reload); });
      const daily = setInterval(() => applyInfo({ ...status, daysLeft: Math.floor((new Date(status.validTo) - Date.now()) / 86400_000) }), 12 * 3600_000);
      daily.unref(); timers.push(() => clearInterval(daily));
    } catch (e) {
      status.error = e.code || 'listen-failed';
      const dica = e.code === 'EADDRINUSE' ? `A porta ${config.httpsPort} já está em uso (outro programa — IIS, Skype, outro servidor?). Veja: netstat -ano | findstr :${config.httpsPort}`
        : e.code === 'EACCES' ? `Sem permissão para abrir a porta ${config.httpsPort} (portas <1024 exigem administrador no Linux/macOS).`
        : e.message;
      log.error(`HTTPS DESLIGADO — não foi possível abrir a porta ${config.httpsPort}: ${dica} Rodando só em HTTP.`);
      httpsServer = null;
    }
  }

  const closeOne = s => new Promise(res => (s ? s.close(() => res()) : res()));
  return {
    http: httpServer, https: httpsServer,
    tls: () => ({ ...status }),
    close: async () => { timers.forEach(t => t()); httpServer.closeAllConnections?.(); httpsServer?.closeAllConnections?.(); await Promise.all([closeOne(httpServer), closeOne(httpsServer)]); },
  };
}
