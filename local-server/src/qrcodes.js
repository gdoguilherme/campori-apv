// Gera TODOS os QR Codes das provas direto do banco local: um PNG por QR + TODOS-OS-QRCODES.pdf (6 por A4) + manifest.json.
// O hash é o MESMO que o servidor valida no /qr/redeem (signQr de src/auth.js, com o QR_SECRET atual do .env).
// Só JavaScript puro (qrcode + zlib do Node): nada de compilação nativa no Windows.
//
// ATENÇÃO: o QR depende de (requisito, variante, PONTOS) e do QR_SECRET — trocar qualquer um deles depois de imprimir invalida o QR impresso.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { collectQrJobs, qrFileNames, qrFingerprint, qrPayloadString } from '../../shared/qrsheet.js';
import { buildQrPdf } from '../../shared/pdf.js';
import { createAuth } from './auth.js';

export const MANIFEST = 'manifest.json';
export const PDF_NAME = 'TODOS-OS-QRCODES.pdf';
export const defaultQrDir = config => config.qrDir || path.join(config.dbPath ? path.dirname(config.dbPath) : path.resolve('data'), 'qrcodes');
export const secretId = secret => crypto.createHash('sha256').update(String(secret || '')).digest('hex').slice(0, 8);

// QR → raster em tons de cinza (1 byte/pixel), com margem (quiet zone) de 4 módulos e ≥ minPx de lado
export async function qrRaster(text, minPx = 340) {
  let QRCode;
  try { QRCode = (await import('qrcode')).default; }   // import preguiçoso: sem 'npm install' o servidor continua subindo; só a geração avisa
  catch { throw new Error('Pacote "qrcode" não instalado — rode "npm install" na pasta local-server.'); }
  const qr = QRCode.create(text, { errorCorrectionLevel: 'M' });
  const n = qr.modules.size, quiet = 4;
  const scale = Math.max(1, Math.ceil(minPx / (n + 2 * quiet)));
  const dim = (n + 2 * quiet) * scale;
  const data = new Uint8Array(dim * dim).fill(255);
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) {
    if (!qr.modules.get(r, c)) continue;
    for (let y = 0; y < scale; y++) data.fill(0, ((r + quiet) * scale + y) * dim + (c + quiet) * scale, ((r + quiet) * scale + y) * dim + (c + quiet) * scale + scale);
  }
  return { width: dim, height: dim, data };
}

// PNG em tons de cinza 8 bits (encoder mínimo: IHDR + IDAT zlib + IEND)
export function pngGray({ width, height, data }) {
  const chunk = (type, body) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(body.length);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([Buffer.from(type), body])) >>> 0);
    return Buffer.concat([len, Buffer.from(type), body, crc]);
  };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 0;
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) { raw[y * (width + 1)] = 0; Buffer.from(data.buffer, data.byteOffset + y * width, width).copy(raw, y * (width + 1) + 1); }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

export async function generateQrFiles({ store, config, destDir = defaultQrDir(config), allowDevSecret = false, now = Date.now() }) {
  const jobs = collectQrJobs(store.list('requirements'));
  if (!jobs.length) return { ok: false, empty: true, message: 'Nenhuma prova ativa com variantes de QR Code cadastrada. Cadastre os requisitos reais (Requisitos → Variantes de QR Code) e rode de novo.' };
  if (config.qrSecretIsDev && !allowDevSecret) {
    return { ok: false, devSecret: true, message: 'QR_SECRET não está definido no .env (o servidor usaria um segredo de desenvolvimento). QR Codes gerados assim NÃO valem na nuvem — defina QR_SECRET (o mesmo do Fly) e rode de novo.' };
  }
  const { signQr } = createAuth({ store, config });
  fs.mkdirSync(destDir, { recursive: true });

  // remove SÓ o que a geração anterior criou (nunca mexe em outros arquivos da pasta)
  try {
    const prev = JSON.parse(fs.readFileSync(path.join(destDir, MANIFEST), 'utf8'));
    for (const f of [...(prev.files || []).map(x => x.file), prev.pdf]) if (f && /^[\w.,-]+$/.test(f)) fs.rmSync(path.join(destDir, f), { force: true });
  } catch { /* primeira geração */ }

  const names = qrFileNames(jobs), files = [], cards = [];
  for (const [i, j] of jobs.entries()) {
    const payload = { requisitoId: j.requirementId, varianteId: j.variantId, pontos: j.points, hash: signQr(j.requirementId, j.variantId, j.points) };
    const raster = await qrRaster(qrPayloadString(payload));
    fs.writeFileSync(path.join(destDir, names[i]), pngGray(raster));
    files.push({ file: names[i], requirementId: j.requirementId, requirement: j.requirementName, variantId: j.variantId, variant: j.variantLabel, points: j.points, payload });
    cards.push({ title: j.requirementName, subtitle: j.variantLabel, points: j.points, image: raster });
  }
  const pdf = await buildQrPdf({ cards, deflate: async b => zlib.deflateSync(b) });
  fs.writeFileSync(path.join(destDir, PDF_NAME), pdf);

  const info = { generatedAt: now, count: jobs.length, fingerprint: qrFingerprint(jobs), secretId: secretId(config.qrSecret), pdf: PDF_NAME, files };
  fs.writeFileSync(path.join(destDir, MANIFEST), JSON.stringify(info, null, 2));
  store.setMeta('qrcodes.last', JSON.stringify({ dir: destDir, count: info.count, generatedAt: now, fingerprint: info.fingerprint, secretId: info.secretId }));
  return { ok: true, dir: destDir, pdf: path.join(destDir, PDF_NAME), count: jobs.length, generatedAt: now, fingerprint: info.fingerprint, files };
}

// Situação para o painel /status: quantos QR foram gerados, quando, e se algo mudou desde então (reimprimir!)
export function qrStatus({ store, config }) {
  let last = null;
  try { last = JSON.parse(store.getMeta('qrcodes.last') || 'null'); } catch { /* sem registro */ }
  const current = collectQrJobs(store.list('requirements'));
  const out = { generated: !!last, count: last?.count ?? 0, generatedAt: last?.generatedAt ?? null, dir: last?.dir ?? defaultQrDir(config), currentCount: current.length };
  out.requirementsChanged = !!last && last.fingerprint !== qrFingerprint(current);
  out.secretChanged = !!last && !!last.secretId && last.secretId !== secretId(config.qrSecret);
  out.warning = 'Imprima só depois de cadastrar os requisitos reais: trocar requisito, variante ou pontos invalida o QR já impresso.';
  return out;
}
