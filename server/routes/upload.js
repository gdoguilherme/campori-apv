const express = require('express');
const multer  = require('multer');
const { uploadFile } = require('../services/gdrive');

const router = express.Router();

const ALLOWED_TYPES = ['image/jpeg','image/png','image/webp','image/gif','application/pdf'];

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB
  fileFilter: (_req, file, cb) => {
    if (ALLOWED_TYPES.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Tipo de arquivo não permitido. Use JPG, PNG, WEBP, GIF ou PDF.'));
  },
});

router.post('/', upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });

    const reqCode  = (req.body.reqCode  || 'geral').replace(/[^a-zA-Z0-9_-]/g, '-').slice(0, 80);
    const regionId = (req.body.regionId || 'geral').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 40);

    const result = await uploadFile(
      req.file.buffer,
      req.file.mimetype,
      req.file.originalname,
      reqCode,
      regionId,
    );

    console.log(`[upload] ${regionId}/${reqCode} → ${result.fileId}`);
    res.json(result); // { url, fileId, mimeType }
  } catch (err) {
    next(err);
  }
});

module.exports = router;
