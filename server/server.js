const express     = require('express');
const cors        = require('cors');
const uploadRoute = require('./routes/upload');

const app  = express();
const PORT = process.env.PORT || 8080;

// ── CORS ──────────────────────────────────────────────────────
const allowedOrigins = process.env.ALLOWED_ORIGINS
  ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
  : [];

app.use(cors({
  origin(origin, cb) {
    // permite requests sem origin (ex: Postman, mobile apps)
    if (!origin) return cb(null, true);
    if (
      allowedOrigins.includes(origin) ||
      /\.vercel\.app$/.test(origin) ||
      /^http:\/\/localhost(:\d+)?$/.test(origin)
    ) {
      return cb(null, true);
    }
    cb(new Error(`CORS bloqueado para: ${origin}`));
  },
}));

// ── ROTAS ─────────────────────────────────────────────────────
app.use('/upload', uploadRoute);

app.get('/health', (_req, res) => {
  res.json({ ok: true, uptime: Math.round(process.uptime()) });
});

// ── ERRO GLOBAL ───────────────────────────────────────────────
app.use((err, _req, res, _next) => {
  console.error('[error]', err.message);
  res.status(err.status || 400).json({ error: err.message });
});

// ── START ─────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n✅ Campori Upload Server — porta ${PORT}`);
  console.log(`   Drive root folder: ${process.env.DRIVE_ROOT_FOLDER_ID || '(não configurado)'}`);
  console.log(`   Shared Drive:      ${process.env.DRIVE_SHARED_DRIVE_ID || '(My Drive)'}\n`);
});
