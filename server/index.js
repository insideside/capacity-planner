// Планировщик ёмкости — сервер (Node.js + Express).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const bcrypt = require('bcryptjs');

const { loadConfig } = require('./config');
const { Store } = require('./store');
const { loadSeed, hasSeed, verifySeed } = require('./seed');
const Validate = require('../shared/validate');
const Ops = require('../shared/ops');
const Diff = require('../shared/diff');
const Update = require('./update');
const { spawn } = require('child_process');

const cfg = loadConfig();
const store = new Store(cfg.dataDir);
const SECRET = cfg.sessionSecret || store.loadOrCreateSecret();
const PID_FILE = path.join(cfg.root, 'capacity-planner.pid');
const COOKIE = 'cp_sid';

// ══ Первичная инициализация ══════════════════════════════════════
function initUsers() {
  if (store.users && Array.isArray(store.users.users) && store.users.users.length) return;
  let pwd = cfg.adminInitialPassword;
  let generated = false;
  if (!pwd) {
    pwd = crypto.randomBytes(9).toString('base64url');
    generated = true;
  }
  store.users = {
    users: [{
      id: crypto.randomUUID(), login: 'admin', hash: bcrypt.hashSync(pwd, 12), role: 'admin',
      mustChangePassword: true, perms: {}, createdAt: new Date().toISOString(),
    }],
  };
  store.saveUsers();
  console.log('──────────────────────────────────────────────');
  console.log(' Создан администратор: логин "admin"');
  if (generated) console.log(` Временный пароль: ${pwd}   (ADMIN_INITIAL_PASSWORD не задан)`);
  else console.log(' Пароль: из ADMIN_INITIAL_PASSWORD');
  console.log(' При первом входе потребуется сменить пароль.');
  console.log('──────────────────────────────────────────────');
}
function initProjects() {
  const seed = loadSeed();
  if (!seed) {
    if (store.projects.size === 0) console.log('[seed] стартовые данные не найдены — проект создаёт администратор («+ Проект» или «Загрузить конфигурацию»).');
    return;
  }
  const checks = verifySeed(seed);
  const bad = checks.filter((c) => !c.ok);
  if (bad.length) {
    console.error('[seed] КОНТРОЛЬНЫЕ ЧИСЛА СИДА НЕ СХОДЯТСЯ:');
    bad.forEach((c) => console.error(`  ✘ ${c.name}: ожидалось ${JSON.stringify(c.expected)}, получено ${JSON.stringify(c.actual)}`));
  } else {
    console.log(`[seed] автопроверка сида: OK (${checks.length} проверок)`);
  }
  if (store.projects.size === 0) {
    if (bad.length) {
      console.error('[seed] сид-проект не создан, т.к. данные повреждены.');
      return;
    }
    const p = store.createProject(seed.name, seed.periods, 'system');
    console.log(`[seed] создан проект «${p.name}» (${p.projectId})`);
  }
}
initUsers();
initProjects();

// ══ Пользователи и права ═════════════════════════════════════════
const users = () => store.users.users;
const findUser = (id) => users().find((u) => u.id === id) || null;
const publicUser = (u) => ({ id: u.id, login: u.login, role: u.role, mustChangePassword: !!u.mustChangePassword, perms: u.perms || {}, createdAt: u.createdAt });
function access(user, projectId) {
  if (!user) return null;
  if (user.role === 'admin') return 'edit';
  const a = (user.perms || {})[projectId];
  return a === 'edit' || a === 'read' ? a : null;
}

// ══ Сессии ═══════════════════════════════════════════════════════
const sign = (sid) => crypto.createHmac('sha256', SECRET).update(sid).digest('base64url');
function parseCookies(req) {
  const out = {};
  (req.headers.cookie || '').split(';').forEach((c) => {
    const i = c.indexOf('=');
    if (i > 0) out[c.slice(0, i).trim()] = decodeURIComponent(c.slice(i + 1).trim());
  });
  return out;
}
function setCookie(res, value, maxAgeSec) {
  const parts = [`${COOKIE}=${encodeURIComponent(value)}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAgeSec}`];
  if (cfg.secureCookies) parts.push('Secure');
  res.setHeader('Set-Cookie', parts.join('; '));
}
function createSession(res, user) {
  const sid = crypto.randomBytes(32).toString('base64url');
  const ttl = cfg.sessionTtlHours * 3600 * 1000;
  store.sessions[sid] = { userId: user.id, csrf: crypto.randomBytes(24).toString('base64url'), expires: Date.now() + ttl, createdAt: Date.now() };
  store.saveSessions();
  setCookie(res, `${sid}.${sign(sid)}`, Math.floor(ttl / 1000));
  return store.sessions[sid];
}
function getSession(req) {
  const raw = parseCookies(req)[COOKIE];
  if (!raw) return null;
  const i = raw.lastIndexOf('.');
  if (i < 0) return null;
  const sid = raw.slice(0, i);
  const sig = raw.slice(i + 1);
  const exp = sign(sid);
  if (sig.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) return null;
  const s = store.sessions[sid];
  if (!s) return null;
  if (s.expires < Date.now()) {
    delete store.sessions[sid];
    store.saveSessions();
    return null;
  }
  // скользящее продление (не чаще, чем раз в половину срока)
  const ttl = cfg.sessionTtlHours * 3600 * 1000;
  if (s.expires - Date.now() < ttl / 2) {
    s.expires = Date.now() + ttl;
    store.saveSessions();
  }
  return { sid, ...s };
}
function dropUserSessions(userId, exceptSid) {
  let changed = false;
  for (const [sid, s] of Object.entries(store.sessions)) {
    if (s.userId === userId && sid !== exceptSid) {
      delete store.sessions[sid];
      changed = true;
    }
  }
  if (changed) store.saveSessions();
}
setInterval(() => {
  let changed = false;
  for (const [sid, s] of Object.entries(store.sessions)) if (s.expires < Date.now()) { delete store.sessions[sid]; changed = true; }
  if (changed) store.saveSessions();
}, 3600 * 1000).unref();

// ══ Rate-limit логина ════════════════════════════════════════════
const attempts = new Map();
// хеш-пустышка: сравнение для несуществующего логина занимает то же время
const DUMMY_HASH = bcrypt.hashSync(crypto.randomBytes(8).toString('hex'), 12);
function rateKeyBlocked(key) {
  const now = Date.now();
  const win = cfg.login.windowMinutes * 60 * 1000;
  const a = attempts.get(key);
  if (!a || now - a.first > win) return false;
  return a.count >= cfg.login.maxAttempts;
}
function rateFail(key) {
  const now = Date.now();
  const win = cfg.login.windowMinutes * 60 * 1000;
  const a = attempts.get(key);
  if (!a || now - a.first > win) attempts.set(key, { first: now, count: 1 });
  else a.count++;
}

// ══ Приложение ═══════════════════════════════════════════════════
const app = express();
app.disable('x-powered-by');
if (cfg.trustProxy) app.set('trust proxy', cfg.trustProxy);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'");
  next();
});
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  next();
});
app.use('/api', express.json({ limit: `${cfg.maxUploadMb}mb` }));

// Аутентификация + CSRF для всех /api, кроме логина.
app.use('/api', (req, res, next) => {
  if (req.path === '/auth/login') return next();
  const s = getSession(req);
  const user = s && findUser(s.userId);
  if (!user) return res.status(401).json({ error: 'unauthorized', message: 'Требуется вход' });
  req.session = s;
  req.user = user;
  if (!['GET', 'HEAD'].includes(req.method)) {
    const t = req.get('x-csrf-token') || '';
    if (t.length !== s.csrf.length || !crypto.timingSafeEqual(Buffer.from(t), Buffer.from(s.csrf))) {
      return res.status(403).json({ error: 'csrf', message: 'Неверный CSRF-токен — обновите страницу' });
    }
  }
  if (user.mustChangePassword && !['/auth/me', '/auth/logout', '/auth/password'].includes(req.path)) {
    return res.status(403).json({ error: 'must_change_password', message: 'Необходимо сменить пароль' });
  }
  next();
});
const requireAdmin = (req, res, next) => (req.user.role === 'admin' ? next() : res.status(403).json({ error: 'forbidden', message: 'Только для администратора' }));
// Загружает проект и проверяет уровень доступа ('read' | 'edit').
const withProject = (level) => (req, res, next) => {
  const p = store.getProject(req.params.id);
  const a = p && access(req.user, p.projectId);
  if (!p || !a) return res.status(404).json({ error: 'not_found', message: 'Проект не найден или нет доступа' });
  if (level === 'edit' && a !== 'edit') return res.status(403).json({ error: 'forbidden', message: 'Только чтение' });
  req.project = p;
  req.access = a;
  next();
};
const bad = (res, message, extra) => res.status(400).json({ error: 'bad_request', message, ...extra });

// ── auth ──────────────────────────────────────────────
app.post('/api/auth/login', async (req, res) => {
  const login = String((req.body || {}).login || '').trim();
  const password = String((req.body || {}).password || '');
  const ipKey = `ip:${req.ip}`;
  const userKey = `u:${login.toLowerCase()}`;
  if (rateKeyBlocked(ipKey) || rateKeyBlocked(userKey)) {
    return res.status(429).json({ error: 'rate_limited', message: `Слишком много попыток. Попробуйте через ${cfg.login.windowMinutes} мин.` });
  }
  const user = users().find((u) => u.login.toLowerCase() === login.toLowerCase());
  const ok = user ? await bcrypt.compare(password, user.hash) : (await bcrypt.compare(password, DUMMY_HASH), false);
  if (!ok) {
    rateFail(ipKey);
    rateFail(userKey);
    return res.status(401).json({ error: 'bad_credentials', message: 'Неверный логин или пароль' });
  }
  attempts.delete(userKey);
  const s = createSession(res, user);
  res.json({ user: publicUser(user), csrf: s.csrf });
});
app.post('/api/auth/logout', (req, res) => {
  delete store.sessions[req.session.sid];
  store.saveSessions();
  setCookie(res, '', 0);
  res.json({ ok: true });
});
app.get('/api/auth/me', (req, res) => {
  res.json({
    user: publicUser(req.user),
    csrf: req.session.csrf,
    config: { pollIntervalSec: cfg.pollIntervalSec, maxUploadMb: cfg.maxUploadMb, reopenRequiresAdmin: !!cfg.reopenRequiresAdmin, detachRemoveInactiveInSource: !!cfg.detachRemoveInactiveInSource, hasSeed: hasSeed() },
  });
});
app.post('/api/auth/password', async (req, res) => {
  const { oldPassword, newPassword } = req.body || {};
  if (typeof newPassword !== 'string' || newPassword.length < 8) return bad(res, 'Новый пароль — не короче 8 символов');
  if (!(await bcrypt.compare(String(oldPassword || ''), req.user.hash))) return bad(res, 'Текущий пароль указан неверно');
  if (oldPassword === newPassword) return bad(res, 'Новый пароль должен отличаться от текущего');
  req.user.hash = await bcrypt.hash(newPassword, 12);
  req.user.mustChangePassword = false;
  store.saveUsers();
  dropUserSessions(req.user.id, req.session.sid);
  res.json({ user: publicUser(req.user) });
});

// ── users (admin) ─────────────────────────────────────
const RE_LOGIN = /^[A-Za-z0-9._@-]{2,40}$/;
function cleanPerms(perms) {
  const out = {};
  for (const [pid, a] of Object.entries(perms || {})) if (store.getProject(pid) && (a === 'read' || a === 'edit')) out[pid] = a;
  return out;
}
const adminCount = () => users().filter((u) => u.role === 'admin').length;
app.get('/api/users', requireAdmin, (req, res) => res.json({ users: users().map(publicUser) }));
app.post('/api/users', requireAdmin, async (req, res) => {
  const { login, password, role, perms } = req.body || {};
  if (typeof login !== 'string' || !RE_LOGIN.test(login)) return bad(res, 'Логин: 2–40 символов (латиница, цифры, . _ @ -)');
  if (users().some((u) => u.login.toLowerCase() === login.toLowerCase())) return bad(res, 'Такой логин уже существует');
  if (typeof password !== 'string' || password.length < 8) return bad(res, 'Пароль — не короче 8 символов');
  const u = {
    id: crypto.randomUUID(), login, hash: await bcrypt.hash(password, 12), role: role === 'admin' ? 'admin' : 'user',
    mustChangePassword: true, perms: cleanPerms(perms), createdAt: new Date().toISOString(),
  };
  users().push(u);
  store.saveUsers();
  res.json({ user: publicUser(u) });
});
app.put('/api/users/:uid', requireAdmin, async (req, res) => {
  const u = findUser(req.params.uid);
  if (!u) return res.status(404).json({ error: 'not_found', message: 'Пользователь не найден' });
  const { role, password, perms, login } = req.body || {};
  if (login !== undefined && login !== u.login) {
    if (typeof login !== 'string' || !RE_LOGIN.test(login)) return bad(res, 'Некорректный логин');
    if (users().some((x) => x.id !== u.id && x.login.toLowerCase() === login.toLowerCase())) return bad(res, 'Такой логин уже существует');
    u.login = login;
  }
  if (role !== undefined) {
    const nr = role === 'admin' ? 'admin' : 'user';
    if (u.role === 'admin' && nr !== 'admin' && adminCount() <= 1) return bad(res, 'Нельзя снять роль с последнего администратора');
    u.role = nr;
  }
  if (perms !== undefined) u.perms = cleanPerms(perms);
  if (password !== undefined) {
    if (typeof password !== 'string' || password.length < 8) return bad(res, 'Пароль — не короче 8 символов');
    u.hash = await bcrypt.hash(password, 12);
    u.mustChangePassword = u.id !== req.user.id;
    dropUserSessions(u.id, req.session.sid);
  }
  store.saveUsers();
  res.json({ user: publicUser(u) });
});
app.delete('/api/users/:uid', requireAdmin, (req, res) => {
  const u = findUser(req.params.uid);
  if (!u) return res.status(404).json({ error: 'not_found', message: 'Пользователь не найден' });
  if (u.id === req.user.id) return bad(res, 'Нельзя удалить самого себя');
  if (u.role === 'admin' && adminCount() <= 1) return bad(res, 'Нельзя удалить последнего администратора');
  store.users.users = users().filter((x) => x.id !== u.id);
  store.saveUsers();
  dropUserSessions(u.id);
  res.json({ ok: true });
});

// ── projects ──────────────────────────────────────────
function validateOrFail(res, periods) {
  const errs = Validate.validatePeriods(periods);
  if (errs.length) {
    bad(res, 'Конфигурация не прошла проверку', { errors: errs });
    return false;
  }
  periods.forEach(Validate.normalizePeriod);
  return true;
}
const DEFAULT_RES = {
  core: { label: 'Разработчики ядра', n: 3, pct: 200, period: 'dev', color: '#2255e2' },
  test: { label: 'Тестировщики', n: 2, pct: 100, period: 'tst', color: '#15803d' },
};
function emptyPeriods() {
  const seed = loadSeed();
  const y = new Date().getFullYear();
  return [{
    id: 'p1', name: 'Период 1', devStart: `${y}-01-12`, devEnd: `${y}-06-30`, tstStart: `${y}-02-01`, tstEnd: `${y}-07-15`,
    res: JSON.parse(JSON.stringify(seed ? seed.periods[0].res : DEFAULT_RES)), tasks: [], chk: {}, collapsed: {}, filter: null, filterActive: null,
    folded: false, linkedTo: null, colWidths: { cb: 32, h: 46, r: 98, name: 0, del: 18 }, closed: false,
  }];
}
const cleanName = (n) => String(n || '').trim().slice(0, 300);
function saveOrConflict(req, res, periods, name, extra) {
  const r = store.saveProject(req.project.projectId, req.body.baseRevision, { periods, name }, req.user.login);
  if (r.conflict) return res.status(409).json({ error: 'conflict', message: 'Проект изменён другим пользователем', current: r.current });
  res.json({ project: r.project, ...extra });
}

app.get('/api/projects', (req, res) => {
  res.json({
    projects: store.listProjects().map((p) => ({ ...p, access: access(req.user, p.projectId) })).filter((p) => p.access),
  });
});
app.post('/api/projects', requireAdmin, (req, res) => {
  const { name, project, fromSeed } = req.body || {};
  let periods;
  let pname = cleanName(name);
  if (project) {
    const parsed = Validate.parseProjectFile(project);
    if (parsed.errors.length) return bad(res, 'Конфигурация не прошла проверку', { errors: parsed.errors });
    periods = parsed.project.periods;
    pname = pname || cleanName(parsed.project.name);
  } else if (fromSeed) {
    const seed = loadSeed();
    if (!seed) return bad(res, 'Стартовые данные не установлены');
    periods = seed.periods;
    pname = pname || seed.name;
  } else {
    periods = emptyPeriods();
  }
  if (!pname) return bad(res, 'Укажите название проекта');
  const p = store.createProject(pname, periods, req.user.login);
  res.json({ project: p });
});
app.get('/api/projects/:id', withProject('read'), (req, res) => res.json({ project: req.project, access: req.access }));
app.get('/api/projects/:id/revision', withProject('read'), (req, res) => {
  res.json({ revision: req.project.revision, updatedAt: req.project.updatedAt, updatedBy: req.project.updatedBy || null });
});
app.put('/api/projects/:id', withProject('edit'), (req, res) => {
  const { periods, name, baseRevision } = req.body || {};
  if (!Number.isInteger(baseRevision)) return bad(res, 'Не указана baseRevision');
  let pname;
  if (name !== undefined) {
    pname = cleanName(name);
    if (!pname) return bad(res, 'Название проекта не может быть пустым');
  }
  if (periods !== undefined) {
    if (!validateOrFail(res, periods)) return;
    if (baseRevision === req.project.revision) {
      const closedErr = Ops.checkClosedUntouched(req.project.periods, periods);
      if (closedErr) return res.status(422).json({ error: 'closed', message: closedErr });
      if (Ops.reopenedIds(req.project.periods, periods).length && cfg.reopenRequiresAdmin && req.user.role !== 'admin') {
        return res.status(403).json({ error: 'forbidden', message: 'Переоткрывать вехи может только администратор' });
      }
    }
  }
  saveOrConflict(req, res, periods, pname);
});
app.delete('/api/projects/:id', requireAdmin, withProject('edit'), (req, res) => {
  store.deleteProject(req.project.projectId);
  for (const u of users()) if (u.perms && u.perms[req.project.projectId]) delete u.perms[req.project.projectId];
  store.saveUsers();
  res.json({ ok: true });
});
app.get('/api/projects/:id/download', withProject('read'), (req, res) => {
  const p = req.project;
  const fname = `${p.name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, '_')}_rev${p.revision}.json`;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="project.json"; filename*=UTF-8''${encodeURIComponent(fname)}`);
  res.send(JSON.stringify(p, null, 1));
});

// Загрузка поверх проекта: проверяем файл, строим дифф. Сам файл держим на сервере до /merge.
const pendingUploads = new Map();
setInterval(() => {
  for (const [k, v] of pendingUploads) if (v.expires < Date.now()) pendingUploads.delete(k);
}, 60 * 1000).unref();
app.post('/api/projects/:id/upload', withProject('edit'), (req, res) => {
  const parsed = Validate.parseProjectFile((req.body || {}).file);
  if (parsed.errors.length) return bad(res, 'Файл не прошёл проверку', { errors: parsed.errors });
  const cur = req.project.periods;
  const file = Diff.remapFile(cur, parsed.project.periods);
  const fileErrs = Validate.validatePeriods(file);
  if (fileErrs.length) return bad(res, 'Файл не прошёл проверку', { errors: fileErrs });
  const items = Diff.diffPeriods(cur, file);
  const uploadId = crypto.randomUUID();
  pendingUploads.set(uploadId, { projectId: req.project.projectId, userId: req.user.id, file, baseRevision: req.project.revision, expires: Date.now() + 30 * 60 * 1000 });
  res.json({ uploadId, baseRevision: req.project.revision, items, fileName: parsed.project.name || null });
});
app.post('/api/projects/:id/merge', withProject('edit'), (req, res) => {
  const { uploadId, choices, baseRevision } = req.body || {};
  const up = pendingUploads.get(uploadId);
  if (!up || up.userId !== req.user.id || up.projectId !== req.project.projectId) return bad(res, 'Загрузка не найдена или устарела — загрузите файл заново');
  if (up.baseRevision !== req.project.revision || baseRevision !== req.project.revision) {
    pendingUploads.delete(uploadId);
    return res.status(409).json({ error: 'conflict', message: 'Проект изменился, пока вы разбирали конфликты — загрузите файл заново', current: req.project });
  }
  const cur = req.project.periods;
  const items = Diff.diffPeriods(cur, up.file);
  const merged = Diff.applyChoices(cur, up.file, items, choices || {});
  if (!validateOrFail(res, merged)) return;
  const closedErr = Ops.checkClosedUntouched(cur, merged);
  if (closedErr) return res.status(422).json({ error: 'closed', message: closedErr });
  if (Ops.reopenedIds(cur, merged).length && cfg.reopenRequiresAdmin && req.user.role !== 'admin') {
    return res.status(403).json({ error: 'forbidden', message: 'Переоткрывать вехи может только администратор' });
  }
  pendingUploads.delete(uploadId);
  saveOrConflict(req, res, merged, undefined, { applied: Object.values(choices || {}).filter((c) => c === 'file').length });
});

// Операции над версиями.
function periodOp(req, res, fn) {
  const { baseRevision } = req.body || {};
  if (baseRevision !== req.project.revision) {
    return res.status(409).json({ error: 'conflict', message: 'Проект изменён другим пользователем', current: req.project });
  }
  const periods = JSON.parse(JSON.stringify(req.project.periods));
  const r = fn(periods);
  if (r && r.error) return bad(res, r.error);
  if (!validateOrFail(res, periods)) return;
  saveOrConflict(req, res, periods, undefined, { result: r });
}
app.post('/api/projects/:id/periods/:pid/detach', withProject('edit'), (req, res) => {
  periodOp(req, res, (periods) => {
    const B = Ops.byId(periods, req.params.pid);
    const fromId = (req.body || {}).fromId || (B && B.linkedTo);
    if (!B) return { error: 'Версия не найдена' };
    const A = Ops.byId(periods, fromId);
    if (!A) return { error: 'Не указана версия, от которой отвязывать' };
    if (B.closed || A.closed) return { error: 'Нельзя отвязывать закрытую веху — сначала переоткройте её' };
    const rmInactive = (req.body || {}).removeInactiveInSource;
    const plan = Ops.applyDetach(periods, B.id, A.id, { removeInactiveInSource: rmInactive === undefined ? !!cfg.detachRemoveInactiveInSource : !!rmInactive });
    return { removed: plan.remove.length, removedSummaries: plan.removeSummaries.length, keptInactive: plan.keptInactive.length };
  });
});
app.post('/api/projects/:id/periods/:pid/close', withProject('edit'), (req, res) => {
  periodOp(req, res, (periods) => Ops.closePeriod(periods, req.params.pid, req.user.login));
});
app.post('/api/projects/:id/periods/:pid/reopen', withProject('edit'), (req, res) => {
  if (cfg.reopenRequiresAdmin && req.user.role !== 'admin') return res.status(403).json({ error: 'forbidden', message: 'Переоткрывать вехи может только администратор' });
  periodOp(req, res, (periods) => Ops.reopenPeriod(periods, req.params.pid));
});
app.get('/api/seed', (req, res) => {
  const seed = loadSeed();
  if (!seed) return res.status(404).json({ error: 'not_found', message: 'Стартовые данные не установлены' });
  res.json({ project: seed });
});

// ── обновление из git (админ) ─────────────────────────
app.get('/api/admin/update', requireAdmin, async (req, res) => {
  try {
    res.json(await Update.status(cfg.root));
  } catch (e) {
    res.status(500).json({ error: 'update', message: e.message });
  }
});
app.post('/api/admin/update', requireAdmin, async (req, res) => {
  try {
    const r = await Update.apply(cfg.root);
    console.log(`[update] ${req.user.login}: ${r.from} → ${r.to}${r.npm ? ' (npm install)' : ''}; перезапуск (${cfg.updateRestart})`);
    res.json({ ok: true, ...r, restart: cfg.updateRestart });
    setTimeout(restartServer, 300);
  } catch (e) {
    res.status(409).json({ error: 'update', message: e.message });
  }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'not_found', message: 'Нет такого метода API' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'too_large', message: `Файл больше ${cfg.maxUploadMb} МБ` });
  if (err.type === 'entity.parse.failed') return bad(res, 'Некорректный JSON');
  console.error(err);
  res.status(500).json({ error: 'internal', message: 'Внутренняя ошибка сервера' });
});

// ── статика ───────────────────────────────────────────
const staticOpts = { etag: true, setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache') };
app.use('/shared', express.static(path.join(cfg.root, 'shared'), staticOpts));
app.use(express.static(path.join(cfg.root, 'public'), staticOpts));

// ══ Запуск / остановка ═══════════════════════════════════════════
const server = app.listen(cfg.port, cfg.host, () => {
  fs.writeFileSync(PID_FILE, String(process.pid));
  const shown = cfg.host === '0.0.0.0' || cfg.host === '::' ? 'localhost' : cfg.host;
  console.log(`Планировщик ёмкости запущен: http://${shown}:${cfg.port}`);
  console.log(`Данные: ${cfg.dataDir}   Конфиг: ${cfg.configFile}`);
});
server.on('error', (e) => {
  console.error(e.code === 'EADDRINUSE' ? `Порт ${cfg.port} уже занят. Измените "port" в config.json или переменную PORT.` : e.message);
  process.exit(1);
});
function shutdown() {
  console.log('Остановка сервера…');
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}
// Перезапуск после обновления. 'self' — сервер сам запускает новый процесс (скрипты start/stop, ручной запуск);
// 'exit' — просто завершается, а перезапускает супервизор (systemd Restart=always, pm2, служба Windows).
function restartServer() {
  let restarted = false;
  const done = () => {
    if (restarted) return;
    restarted = true;
    if (cfg.updateRestart !== 'exit') {
      const logDir = path.join(cfg.root, 'logs');
      fs.mkdirSync(logDir, { recursive: true });
      const fd = fs.openSync(path.join(logDir, 'server.log'), 'a');
      const child = spawn(process.execPath, [path.join(cfg.root, 'server', 'index.js')], {
        cwd: cfg.root, env: process.env, detached: true, stdio: ['ignore', fd, fd], windowsHide: true,
      });
      child.unref();
      console.log(`[update] новый процесс сервера: PID ${child.pid}`);
    }
    process.exit(0);
  };
  server.close(done);
  if (server.closeAllConnections) server.closeAllConnections();
  setTimeout(done, 5000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
process.on('exit', () => {
  try {
    if (fs.existsSync(PID_FILE) && fs.readFileSync(PID_FILE, 'utf8').trim() === String(process.pid)) fs.unlinkSync(PID_FILE);
  } catch (e) { /* ignore */ }
});
