// URLs dos servidores e timeouts. Nenhuma chamada de rede do app fica sem timeout.
// Overrides (testes / troca de servidor sem novo deploy), no console do navegador:
//   localStorage.campori_local_url = 'https://outro.exemplo.com'   (ou removeItem para voltar ao padrão)
//   localStorage.campori_cloud_url = '...'
const ls = k => { try { return localStorage.getItem(k) || null; } catch { return null; } };
const host = location.hostname;
const isDevHost = host === 'localhost' || host === '127.0.0.1' || host === '[::1]';

// Servidor local do evento (PC na rede do roteador). Em desenvolvimento: http://localhost:8787.
// Se a própria página foi aberta pelo servidor local (porta 8787), ele é a mesma origem.
// Página servida pelo servidor local com o "modo local total" (o servidor injeta a flag): backend = a própria origem.
export const LOCAL_APP = globalThis.__CAMPORI_LOCAL_APP === 1;

export const LOCAL_SERVER_URL = (ls('campori_local_url') ||
  (LOCAL_APP ? location.origin : location.port === '8787' ? location.origin : isDevHost ? 'http://localhost:8787' : 'https://local.gdtmidia.com.br')
).replace(/\/$/, '');

// Backend na nuvem (Fly.io)
export const CLOUD_URL = (ls('campori_cloud_url') || 'https://campori-apv-upload.fly.dev').replace(/\/$/, '');

export const TIMEOUTS = {
  probeLocal: 3000,   // servidor local: responde rápido ou não está lá
  probeCloud: 8000,   // nuvem: a máquina do Fly pode estar "dormindo" (cold start)
  api: 15000,         // chamadas JSON comuns
  sync: 20000,        // envio de lote da fila
  bootstrap: 12000,   // snapshot da unidade
  upload: 60000,      // envio de foto/PDF
  immediateScan: 4000 // quanto esperar a sincronização imediata de um scan antes de dizer "guardado, aguardando conexão"
};
