const express  = require('express');
const multer   = require('multer');
const cors     = require('cors');
const path     = require('path');
const fs       = require('fs');

const app  = express();
const PORT = 3001;

// ── PASTA DE UPLOADS ──────────────────────────────────────────
// Se o Google Drive Desktop estiver instalado, aponte para dentro da pasta Drive:
// Ex: 'C:\\Users\\Guilherme Diogo\\Google Drive\\Campori APV\\uploads'
// Por enquanto usa pasta local:
const UPLOADS_DIR = path.join(__dirname, 'uploads');
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ── CORS ──────────────────────────────────────────────────────
app.use(cors({
  origin: [
    'https://campori.gdtmidia.com.br',
    'http://localhost:3000',
    'http://localhost:5500',
    /\.vercel\.app$/,
  ],
}));

// ── MULTER (memoryStorage para ter req.body disponível) ───────
// Usando memoryStorage para que req.body (reqCode, regionId) já esteja
// disponível quando salvamos o arquivo — o diskStorage não garante isso.
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['image/jpeg','image/png','image/webp','image/gif','application/pdf'];
    if (allowed.includes(file.mimetype)) cb(null, true);
    else cb(new Error('Tipo de arquivo não permitido'));
  },
});

// ── ROTA DE UPLOAD ────────────────────────────────────────────
app.post('/upload', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Nenhum arquivo enviado' });

  // Agora req.body está completo
  const reqCode  = (req.body.reqCode  || 'geral').replace(/[^a-zA-Z0-9_-]/g, '-');
  const regionId = (req.body.regionId || 'geral').replace(/[^a-zA-Z0-9_-]/g, '_');

  // Cria a pasta se não existir
  const dir = path.join(UPLOADS_DIR, reqCode, regionId);
  fs.mkdirSync(dir, { recursive: true });

  // Nome único com extensão original
  const ext      = path.extname(req.file.originalname).toLowerCase() || '';
  const filename = Date.now() + '_' + Math.random().toString(36).slice(2) + ext;
  const filePath = path.join(dir, filename);

  // Salva o arquivo do buffer para o disco
  fs.writeFileSync(filePath, req.file.buffer);

  const url = `${req.protocol}://${req.get('host')}/files/${reqCode}/${regionId}/${filename}`;
  console.log(`[upload] ${url}`);

  res.json({ url, filename, source: 'local' });
});

// ── SERVE ARQUIVOS ESTÁTICOS ──────────────────────────────────
app.use('/files', express.static(UPLOADS_DIR, {
  setHeaders(res, filePath) {
    if (filePath.endsWith('.pdf')) {
      res.setHeader('Content-Type', 'application/pdf');
      res.setHeader('Content-Disposition', 'inline');
    }
  },
}));

// ── HEALTH CHECK ──────────────────────────────────────────────
app.get('/health', (req, res) => res.json({ ok: true, uptime: process.uptime() }));

// ── ERROS ─────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error(err.message);
  res.status(400).json({ error: err.message });
});

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ Campori Upload Server — http://localhost:${PORT}`);
  console.log(`   Uploads : ${UPLOADS_DIR}\n`);
});
