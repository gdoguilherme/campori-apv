// js/config.js: para onde o app aponta o servidor local em cada ambiente.
import { test } from 'node:test';
import assert from 'node:assert/strict';

let n = 0;
async function loadConfig({ hostname, port = '', origin, store = {} }) {
  globalThis.location = { hostname, port, origin: origin || `https://${hostname}` };
  globalThis.localStorage = { getItem: k => store[k] ?? null };
  return import(`../../js/config.js?case=${++n}`); // query = instância nova do módulo
}

test('produção (campori.gdtmidia.com.br) → LOCAL_SERVER_URL = https://local.gdtmidia.com.br, sem porta', async () => {
  const c = await loadConfig({ hostname: 'campori.gdtmidia.com.br' });
  assert.equal(c.LOCAL_SERVER_URL, 'https://local.gdtmidia.com.br');
  assert.equal(c.CLOUD_URL, 'https://campori-apv-upload.fly.dev');
});

test('qualquer outro domínio de produção (preview do Vercel) também usa o servidor local oficial', async () => {
  assert.equal((await loadConfig({ hostname: 'campori-abc.vercel.app' })).LOCAL_SERVER_URL, 'https://local.gdtmidia.com.br');
});

test('desenvolvimento (localhost / 127.0.0.1) → http://localhost:8787', async () => {
  assert.equal((await loadConfig({ hostname: 'localhost', port: '5500', origin: 'http://localhost:5500' })).LOCAL_SERVER_URL, 'http://localhost:8787');
  assert.equal((await loadConfig({ hostname: '127.0.0.1', port: '5500', origin: 'http://127.0.0.1:5500' })).LOCAL_SERVER_URL, 'http://localhost:8787');
});

test('página aberta pelo próprio servidor local (porta 8787) → mesma origem', async () => {
  assert.equal((await loadConfig({ hostname: '192.168.0.10', port: '8787', origin: 'http://192.168.0.10:8787' })).LOCAL_SERVER_URL, 'http://192.168.0.10:8787');
});

test('override por localStorage (troca sem deploy), com barra final removida', async () => {
  const c = await loadConfig({ hostname: 'campori.gdtmidia.com.br', store: { campori_local_url: 'https://outro.exemplo/', campori_cloud_url: 'https://nuvem.exemplo/' } });
  assert.equal(c.LOCAL_SERVER_URL, 'https://outro.exemplo');
  assert.equal(c.CLOUD_URL, 'https://nuvem.exemplo');
});
