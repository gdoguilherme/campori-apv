import express from 'express';
import bcrypt from 'bcryptjs';
import { wrap, ADMIN_ROLES } from '../auth.js';
import { httpError } from '../db.js';

// Mesmo contrato de server/routes/users.js (nuvem) — o frontend usa as mesmas chamadas.
// (slugify/genPassword/geração de login são cópias deliberadas: é CRUD de usuário, não
// regra de pontuação, e o backend da nuvem não foi tocado a 6 dias do evento.)
const slugify = s => (s || '').normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
const genPassword = (len = 8) => { const c = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; return Array.from({ length: len }, () => c[Math.floor(Math.random() * c.length)]).join(''); };
const sanitize = u => { const { password, passwordHash, ...rest } = u; return rest; };

export function usersRouter({ store, auth }) {
  const r = express.Router();
  const { requireAuth, signToken } = auth;

  const taken = username => store.list('users', { filters: { username } }).length > 0;
  function genUsername(fullName) {
    const words = slugify(fullName).split('-').filter(Boolean);
    if (!words.length) words.push('usuario');
    const first = words[0], last = words[words.length - 1];
    const cands = words.length > 1 ? [`${first}.${last}`, `${first}.${last[0]}`] : [first];
    for (const c of cands) if (!taken(c)) return c;
    let i = 2; while (taken(`${cands[0]}${i}`)) i++;
    return `${cands[0]}${i}`;
  }

  // Senha antiga em texto puro → valida e migra para bcrypt na hora
  async function verifyAndMigrate(user, plain) {
    if (user.passwordHash) return bcrypt.compare(plain, user.passwordHash);
    if (user.password != null) {
      if (user.password !== plain) return false;
      store.update('users', user.id, { passwordHash: await bcrypt.hash(plain, 10), password: { __delete: true } });
      return true;
    }
    return false;
  }

  r.post('/login', wrap(async (req, res) => {
    const { username, password } = req.body || {};
    if (!username || !password) throw httpError(400, 'Usuário e senha são obrigatórios');
    const [user] = store.list('users', { filters: { username: String(username).toLowerCase().trim() } });
    if (!user) throw httpError(401, 'Usuário não encontrado');
    if (!(await verifyAndMigrate(user, password))) throw httpError(401, 'Senha incorreta');
    if (user.active === false) throw httpError(401, 'Usuário inativo');
    const clean = sanitize(user);
    res.json({ user: clean, token: signToken(clean) });
  }));

  r.post('/ensure-initial-admin', wrap(async (_req, res) => {
    if (store.count('users') > 0) return res.json({ created: false });
    const pwd = genPassword();
    store.insert('users', {
      name: 'Super Admin', phone: '', username: 'admin', passwordHash: await bcrypt.hash(pwd, 10),
      role: 'superadmin', active: true, createdAt: { __serverTimestamp: true }
    }, 'initial-admin');
    res.json({ created: true, password: pwd });
  }));

  r.get('/', requireAuth(ADMIN_ROLES), (_req, res) => res.json(store.list('users').map(sanitize)));

  r.post('/', requireAuth(ADMIN_ROLES), wrap(async (req, res) => {
    const { password, usernameSeed, name, ...data } = req.body || {};
    if (!name) throw httpError(400, 'Nome é obrigatório');
    const username = genUsername(usernameSeed || name);
    const plain = password || genPassword();
    const doc = store.insert('users', {
      ...data, name, username, passwordHash: await bcrypt.hash(plain, 10), active: true,
      createdAt: { __serverTimestamp: true }, createdBy: req.user.id
    });
    res.json({ id: doc.id, username, password: plain });
  }));

  r.patch('/:id', requireAuth(ADMIN_ROLES), (req, res) => {
    const { password, passwordHash, username, ...data } = req.body || {};
    store.update('users', req.params.id, data);
    res.json({ ok: true });
  });

  r.patch('/:id/active', requireAuth(ADMIN_ROLES), (req, res) => {
    store.update('users', req.params.id, { active: !!(req.body || {}).active });
    res.json({ ok: true });
  });

  r.post('/:id/password', requireAuth(), wrap(async (req, res) => {
    const { currentPassword, newPassword } = req.body || {};
    if (!newPassword || newPassword.length < 4) throw httpError(400, 'Nova senha deve ter ao menos 4 caracteres');
    const target = store.get('users', req.params.id);
    if (!target) throw httpError(404, 'Usuário não encontrado');
    const isSelf = req.user.id === req.params.id;
    if (isSelf) {
      if (!currentPassword) throw httpError(400, 'Senha atual é obrigatória');
      if (!(await verifyAndMigrate(target, currentPassword))) throw httpError(401, 'Senha atual incorreta');
    } else if (!ADMIN_ROLES.includes(req.user.role)) throw httpError(403, 'Sem permissão');
    store.update('users', req.params.id, { passwordHash: await bcrypt.hash(newPassword, 10), password: { __delete: true } });
    res.json({ ok: true });
  }));

  r.delete('/:id', requireAuth(['superadmin']), (req, res) => { store.remove('users', req.params.id); res.json({ ok: true }); });
  return r;
}
