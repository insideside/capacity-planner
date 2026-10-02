// Файловое хранилище: проекты (по JSON-файлу на проект), пользователи, сессии.
// Всё лежит в DATA_DIR; запись атомарная (временный файл + rename).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { SCHEMA } = require('../shared/validate');

const HISTORY_KEEP = 50;

function writeJsonAtomic(file, obj) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  const fd = fs.openSync(tmp, 'w');
  try {
    fs.writeSync(fd, JSON.stringify(obj, null, 1));
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}
function readJson(file, fallback) {
  if (!fs.existsSync(file)) return fallback;
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

class Store {
  constructor(dataDir) {
    this.dir = dataDir;
    this.projDir = path.join(dataDir, 'projects');
    this.histDir = path.join(dataDir, 'history');
    this.trashDir = path.join(dataDir, 'trash');
    for (const d of [this.dir, this.projDir, this.histDir, this.trashDir]) fs.mkdirSync(d, { recursive: true });
    this.usersFile = path.join(dataDir, 'users.json');
    this.sessionsFile = path.join(dataDir, 'sessions.json');
    this.projects = new Map();
    for (const f of fs.readdirSync(this.projDir)) {
      if (!f.endsWith('.json')) continue;
      try {
        const p = readJson(path.join(this.projDir, f));
        if (p && p.projectId) this.projects.set(p.projectId, p);
      } catch (e) {
        console.error(`[store] пропущен повреждённый файл ${f}: ${e.message}`);
      }
    }
    this.users = readJson(this.usersFile, null);
    this.sessions = readJson(this.sessionsFile, {});
  }

  // ── Проекты ──────────────────────────────────────────
  projectFile(id) {
    return path.join(this.projDir, `${id}.json`);
  }
  listProjects() {
    return [...this.projects.values()]
      .map((p) => ({ projectId: p.projectId, name: p.name, revision: p.revision, updatedAt: p.updatedAt, updatedBy: p.updatedBy || null }))
      .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
  }
  getProject(id) {
    return this.projects.get(id) || null;
  }
  createProject(name, periods, by) {
    const p = {
      schema: SCHEMA,
      projectId: crypto.randomUUID(),
      name,
      revision: 1,
      updatedAt: new Date().toISOString(),
      updatedBy: by || null,
      periods,
    };
    this._write(p);
    return p;
  }
  // Сохраняет новую ревизию. baseRevision должен совпадать с текущей (иначе — конфликт).
  saveProject(id, baseRevision, patch, by) {
    const cur = this.projects.get(id);
    if (!cur) return { error: 'not_found' };
    if (baseRevision !== cur.revision) return { conflict: true, current: cur };
    const next = {
      schema: SCHEMA,
      projectId: id,
      name: patch.name !== undefined ? patch.name : cur.name,
      revision: cur.revision + 1,
      updatedAt: new Date().toISOString(),
      updatedBy: by || null,
      periods: patch.periods !== undefined ? patch.periods : cur.periods,
    };
    this._write(next);
    return { project: next };
  }
  deleteProject(id) {
    const cur = this.projects.get(id);
    if (!cur) return false;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    fs.renameSync(this.projectFile(id), path.join(this.trashDir, `${id}.${stamp}.json`));
    this.projects.delete(id);
    return true;
  }
  _write(p) {
    writeJsonAtomic(this.projectFile(p.projectId), p);
    this.projects.set(p.projectId, p);
    // история ревизий — для ручного восстановления
    try {
      const hd = path.join(this.histDir, p.projectId);
      fs.mkdirSync(hd, { recursive: true });
      writeJsonAtomic(path.join(hd, `${String(p.revision).padStart(8, '0')}.json`), p);
      const files = fs.readdirSync(hd).filter((f) => f.endsWith('.json')).sort();
      for (const f of files.slice(0, Math.max(0, files.length - HISTORY_KEEP))) fs.unlinkSync(path.join(hd, f));
    } catch (e) {
      console.error(`[store] история ревизий: ${e.message}`);
    }
  }

  // ── Пользователи ─────────────────────────────────────
  saveUsers() {
    writeJsonAtomic(this.usersFile, this.users);
  }
  // ── Сессии ───────────────────────────────────────────
  saveSessions() {
    writeJsonAtomic(this.sessionsFile, this.sessions);
  }
  // ── Секрет сессий (если не задан в env) ──────────────
  loadOrCreateSecret() {
    const f = path.join(this.dir, 'session-secret.key');
    if (fs.existsSync(f)) return fs.readFileSync(f, 'utf8').trim();
    const s = crypto.randomBytes(48).toString('hex');
    fs.writeFileSync(f, s, { mode: 0o600 });
    return s;
  }
}

module.exports = { Store, writeJsonAtomic, readJson };
