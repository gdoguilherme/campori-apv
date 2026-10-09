const express = require('express');
const bcrypt  = require('bcryptjs');
const { firestore, admin } = require('../services/firebaseAdmin');
const { signToken }        = require('../services/authTokens');
const { requireAuth }      = require('../middleware/requireAuth');

const router = express.Router();

// ── HELPERS ───────────────────────────────────────────────────

function sanitize(id, data) {
  const { password, passwordHash, ...rest } = data;
  return { id, ...rest };
}

// Verifica a senha; se o doc ainda tiver a senha antiga em texto puro,
// valida contra ela e migra para hash bcrypt na hora (lazy migration).
async function verifyAndMigrate(userSnap, plain) {
  const data = userSnap.data();
  if (data.passwordHash) return bcrypt.compare(plain, data.passwordHash);
  if (data.password != null) {
    if (data.password !== plain) return false;
    const hash = await bcrypt.hash(plain, 10);
    await userSnap.ref.update({ passwordHash: hash, password: admin.firestore.FieldValue.delete() });
    return true;
  }
  return false;
}

function slugify(str) {
  return (str || '')
    .normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

async function usernameTaken(db, username) {
  const snap = await db.collection('users').where('username', '==', username).limit(1).get();
  return !snap.empty;
}

// Gera um login único a partir de um nome: nome.sobrenome, depois nome.inicial,
// e por fim um sufixo numérico se ainda houver colisão
async function generateUsernameFromName(db, fullName) {
  const words = slugify(fullName).split('-').filter(Boolean);
  if (words.length === 0) words.push('usuario');
  const first = words[0];
  const last  = words[words.length - 1];
  const candidates = words.length > 1 ? [`${first}.${last}`, `${first}.${last[0]}`] : [first];

  for (const candidate of candidates) {
    if (!(await usernameTaken(db, candidate))) return candidate;
  }
  const base = candidates[0];
  let i = 2;
  while (await usernameTaken(db, `${base}${i}`)) i++;
  return `${base}${i}`;
}

function genPassword(len = 8) {
  const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  return Array.from({ length: len }, () => c[Math.floor(Math.random() * c.length)]).join('');
}

// ── LOGIN ─────────────────────────────────────────────────────

router.post('/login', async (req, res, next) => {
  try {
    const { username, password } = req.body || {};
    if (!username || !password) return res.status(400).json({ error: 'Usuário e senha são obrigatórios' });

    const db = firestore();
    const snap = await db.collection('users')
      .where('username', '==', String(username).toLowerCase().trim())
      .limit(1).get();
    if (snap.empty) return res.status(401).json({ error: 'Usuário não encontrado' });

    const userSnap = snap.docs[0];
    const ok = await verifyAndMigrate(userSnap, password);
    if (!ok) return res.status(401).json({ error: 'Senha incorreta' });

    const data = userSnap.data();
    if (data.active === false) return res.status(401).json({ error: 'Usuário inativo' });

    const user  = sanitize(userSnap.id, data);
    const token = signToken(user);
    res.json({ user, token });
  } catch (err) { next(err); }
});

// Cria o admin inicial se a coleção estiver vazia (público, só age uma vez)
router.post('/ensure-initial-admin', async (req, res, next) => {
  try {
    const db = firestore();
    const snap = await db.collection('users').limit(1).get();
    if (!snap.empty) return res.json({ created: false });

    const pwd  = genPassword();
    const hash = await bcrypt.hash(pwd, 10);
    await db.collection('users').doc('initial-admin').set({
      name: 'Super Admin', phone: '', username: 'admin', passwordHash: hash,
      role: 'superadmin', active: true, createdAt: admin.firestore.FieldValue.serverTimestamp()
    });
    res.json({ created: true, password: pwd });
  } catch (err) { next(err); }
});

// ── LISTAGEM / CRUD (admin) ────────────────────────────────────

router.get('/', requireAuth(['superadmin', 'admin']), async (req, res, next) => {
  try {
    const db = firestore();
    const snap = await db.collection('users').get();
    res.json(snap.docs.map(d => sanitize(d.id, d.data())));
  } catch (err) { next(err); }
});

// Cria usuário (perfis admin/aprovador/fiscal) ou o login vinculado de uma região
router.post('/', requireAuth(['superadmin', 'admin']), async (req, res, next) => {
  try {
    const { password, usernameSeed, name, ...data } = req.body || {};
    if (!name) return res.status(400).json({ error: 'Nome é obrigatório' });

    const db       = firestore();
    const username = await generateUsernameFromName(db, usernameSeed || name);
    const plainPwd = password || genPassword();
    const hash     = await bcrypt.hash(plainPwd, 10);

    const ref = await db.collection('users').add({
      ...data, name, username, passwordHash: hash,
      active: true,
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      createdBy: req.authUser.id
    });
    res.json({ id: ref.id, username, password: plainPwd });
  } catch (err) { next(err); }
});

// Atualiza dados não sensíveis (nome, telefone, role, categorias, modalidade, status)
router.patch('/:id', requireAuth(['superadmin', 'admin']), async (req, res, next) => {
  try {
    const { password, passwordHash, username, ...data } = req.body || {};
    await firestore().collection('users').doc(req.params.id).update(data);
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.patch('/:id/active', requireAuth(['superadmin', 'admin']), async (req, res, next) => {
  try {
    const { active } = req.body || {};
    await firestore().collection('users').doc(req.params.id).update({ active: !!active });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

// Troca de senha — autoatendimento (com currentPassword) ou reset por admin
router.post('/:id/password', requireAuth(), async (req, res, next) => {
  try {
    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword || newPassword.length < 4)
      return res.status(400).json({ error: 'Nova senha deve ter ao menos 4 caracteres' });

    const db  = firestore();
    const ref = db.collection('users').doc(req.params.id);
    const snap = await ref.get();
    if (!snap.exists) return res.status(404).json({ error: 'Usuário não encontrado' });

    const isSelf  = req.authUser.id === req.params.id;
    const isAdmin = ['superadmin', 'admin'].includes(req.authUser.role);

    if (isSelf) {
      if (!currentPassword) return res.status(400).json({ error: 'Senha atual é obrigatória' });
      const ok = await verifyAndMigrate(snap, currentPassword);
      if (!ok) return res.status(401).json({ error: 'Senha atual incorreta' });
    } else if (!isAdmin) {
      return res.status(403).json({ error: 'Sem permissão' });
    }

    const hash = await bcrypt.hash(newPassword, 10);
    await ref.update({ passwordHash: hash, password: admin.firestore.FieldValue.delete() });
    res.json({ ok: true });
  } catch (err) { next(err); }
});

router.delete('/:id', requireAuth(['superadmin']), async (req, res, next) => {
  try {
    await firestore().collection('users').doc(req.params.id).delete();
    res.json({ ok: true });
  } catch (err) { next(err); }
});

module.exports = router;
