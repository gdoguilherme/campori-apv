import express from 'express';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { httpError } from '../db.js';
import { wrap } from '../auth.js';

// Mesmo contrato do /upload da nuvem (POST multipart: file, reqCode, regionId → { url }),
// mas grava em disco local (data/uploads). O envio ao Google Drive fica pra Fase de sincronização.
const safe = s => String(s || 'geral').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);

export function uploadRouter({ config }) {
  const r = express.Router();
  // memória (não disco): o client manda `file` ANTES de regionId/reqCode no FormData, então
  // só depois do parse completo sabemos em qual pasta gravar
  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });

  r.post('/', upload.single('file'), wrap(async (req, res) => {
    if (!req.file) throw httpError(400, 'Nenhum arquivo enviado');
    const dir = path.join(config.uploadDir, safe(req.body?.regionId));
    await fs.promises.mkdir(dir, { recursive: true });
    const ext = path.extname(req.file.originalname || '').toLowerCase().replace(/[^.a-z0-9]/g, '').slice(0, 8);
    const name = `${safe(req.body?.reqCode)}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}${ext}`;
    await fs.promises.writeFile(path.join(dir, name), req.file.buffer);
    res.json({ url: `${req.protocol}://${req.get('host')}/files/${safe(req.body?.regionId)}/${name}`, name });
  }));
  return r;
}
