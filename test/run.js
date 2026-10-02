#!/usr/bin/env node
// Автотесты: контрольные числа сида, отвязка версий, дифф/слияние, закрытие вех, API (права, 409, конфликты).
// Запуск: npm test
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const { spawn } = require('child_process');

const { loadSeed, verifySeed } = require('../server/seed');
const fixture = require('./fixture');
// Настоящий сид есть только в локальной установке (в репозитории данных нет) — иначе синтетический проект.
const REAL_SEED = loadSeed();
const SEED = REAL_SEED || fixture();
const leavesOn = (p) => p.tasks.filter((t) => !t.s && p.chk[t.w]);
const sumH = (list) => list.reduce((s, t) => s + t.h, 0);
const Ops = require('../shared/ops');
const Diff = require('../shared/diff');
const Calc = require('../shared/calc');
const Validate = require('../shared/validate');

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✔ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✘ ${name}\n      ${e.stack.split('\n').slice(0, 3).join('\n      ')}`);
  }
}
const clone = (x) => JSON.parse(JSON.stringify(x));

async function unit() {
  console.log('Сид и расчёт');
  const seed = SEED;
  if (REAL_SEED) {
    await test('контрольные числа сида (раздел 5 ТЗ)', () => {
      const bad = verifySeed(seed).filter((c) => !c.ok);
      assert.deepStrictEqual(bad, []);
    });
  } else console.log('  – сид не установлен: контрольные числа не проверяются, тесты идут на синтетическом проекте');
  await test('сид проходит валидацию схемы', () => assert.deepStrictEqual(Validate.validatePeriods(seed.periods), []));
  await test('рабочие дни не зависят от часового пояса', () => {
    assert.strictEqual(Calc.wdays('2026-06-01', '2026-06-07'), 5);
    assert.strictEqual(Calc.wdays('2026-06-08', '2026-06-14'), 4); // 12.06 — праздник
  });

  console.log('Статусы и выполнение релиза');
  await test('прогресс: по задачам и по часам, только отмеченные листья', () => {
    const p = clone(seed.periods[0]);
    const on = p.tasks.filter((t) => !t.s && p.chk[t.w]);
    on[0].st = 'done'; on[1].st = 'done'; on[2].st = 'wip';
    const off = p.tasks.find((t) => !t.s && !p.chk[t.w]);
    off.st = 'done'; // снятая задача не влияет
    const pr = Calc.progress(p);
    const N = leavesOn(p).length;
    assert.strictEqual(pr.all.total.n, N);
    assert.strictEqual(pr.all.done.n, 2);
    assert.strictEqual(pr.all.wip.n, 1);
    assert.strictEqual(pr.all.done.h, on[0].h + on[1].h);
    assert.strictEqual(pr.all.pctN, Math.round(2 / N * 1000) / 10);
    assert.strictEqual(pr.blocks.reduce((s, b) => s + b.agg.total.n, 0), N);
    assert.strictEqual(Object.values(pr.byRes).reduce((s, r) => s + r.done.h, 0), pr.all.done.h);
  });
  await test('готовность по фазам: разработка + тестирование + без ресурса = всё', () => {
    const p = clone(seed.periods[1]);
    p.tasks.filter((t) => !t.s && p.chk[t.w]).forEach((t, i) => { if (i % 3 === 0) t.st = 'done'; });
    const all = Calc.progress(p).all, dev = Calc.progress(p, 'dev').all, tst = Calc.progress(p, 'tst').all;
    const none = p.tasks.filter((t) => !t.s && p.chk[t.w] && !p.res[t.r]).length;
    assert.strictEqual(dev.total.n + tst.total.n + none, all.total.n);
    assert.strictEqual(tst.total.h, sumH(leavesOn(p).filter((t) => p.res[t.r] && p.res[t.r].period === 'tst'))); // только ресурсы окна тестирования
    assert.ok(dev.done.n + tst.done.n <= all.done.n);
  });
  await test('по дням: план, факт по датам, отставание и прогноз', () => {
    const p = clone(seed.periods[1]);
    const on = p.tasks.filter((t) => !t.s && p.chk[t.w]);
    on.slice(0, 4).forEach((t) => { t.st = 'done'; t.dn = '2026-09-29'; });
    on[4].st = 'done'; // без даты
    const d = Calc.daily(p, 'all', '2026-10-02');
    assert.strictEqual(d.window.start, '2026-06-01');
    assert.strictEqual(d.planDays, Calc.wdays('2026-06-01', '2026-12-20'));
    const day = d.days.find((x) => x.date === '2026-09-29');
    assert.strictEqual(day.doneN, 4);
    assert.strictEqual(day.doneH, on.slice(0, 4).reduce((s, t) => s + t.h, 0));
    assert.strictEqual(d.undated.n, 1);
    assert.strictEqual(d.doneH, d.days[d.days.length - 1].cumH);
    assert.strictEqual(d.days[d.days.length - 1].planH, d.totalH); // план доходит до объёма к концу окна
    assert.ok(d.lagDays < 0); // сделано мало — отставание
    assert.strictEqual(d.elapsed + d.remaining, d.planDays);
    assert.ok(d.forecast); // есть темп — есть прогноз
    assert.strictEqual(d.late, d.forecast > d.window.end);
    if (REAL_SEED) assert.ok(d.late); // на реальном объёме 4 задачи за 10 дней — не успеть
    const t = Calc.daily(p, 'tst', '2026-10-02');
    assert.strictEqual(t.window.start, p.tstStart);
    const bad = clone(seed.periods);
    bad[0].tasks[1].dn = '29.09.2026';
    assert.ok(Validate.validatePeriods(bad).length);
  });
  await test('статус: валидация и дифф', () => {
    const ps = clone(seed.periods);
    ps[0].tasks[1].st = 'done';
    assert.deepStrictEqual(Validate.validatePeriods(ps), []);
    const bad = clone(ps);
    bad[0].tasks[1].st = 'finished';
    assert.ok(Validate.validatePeriods(bad).length);
    const items = Diff.diffPeriods(seed.periods, ps);
    assert.strictEqual(items.length, 1);
    assert.deepStrictEqual(items[0].fields, ['st']);
  });

  console.log('Отвязка версий (4.7)');
  await test('отвязка 3.2.3 от 3.2.2 по точному правилу', () => {
    const ps = clone(seed.periods);
    const [a, b] = ps;
    const activeA = leavesOn(seed.periods[0]).length;
    const offN = b.tasks.filter((t) => !t.s && t.rel === 'off').length;
    const totB = Calc.totals(b);
    const plan = Ops.applyDetach(ps, b.id, a.id);
    assert.strictEqual(plan.remove.length, activeA); // сняты в B и активны в A
    assert.strictEqual(plan.keptInactive.length, offN); // off-задачи остаются
    assert.strictEqual(b.tasks.filter((t) => !t.s).length, totB.n + offN);
    assert.deepStrictEqual(Calc.totals(b), totB);
    assert.strictEqual(a.linkedTo, null);
    assert.strictEqual(b.linkedTo, null);
    // ни одной строки-итога без листьев, если до отвязки они были
    const hadLeaves = (tasks, w) => tasks.some((c) => !c.s && c.w.startsWith(w + '.'));
    b.tasks.filter((t) => t.s && hadLeaves(seed.periods[1].tasks, t.w)).forEach((s) => assert.ok(hadLeaves(b.tasks, s.w), `пустой итог ${s.w}`));
    assert.ok(plan.removeSummaries.length > 0);
    // версия A не тронута
    assert.strictEqual(JSON.stringify(a.tasks), JSON.stringify(seed.periods[0].tasks));
  });
  await test('опция: удалять также неактивные в исходной', () => {
    const ps = clone(seed.periods);
    const unchecked = ps[1].tasks.filter((t) => !t.s && !ps[1].chk[t.w]).length;
    const plan = Ops.applyDetach(ps, ps[1].id, ps[0].id, { removeInactiveInSource: true });
    assert.strictEqual(plan.remove.length, unchecked);
  });

  console.log('Закрытие вех (4.8)');
  await test('снимок замораживает ёмкость', () => {
    const ps = clone(seed.periods);
    const before = Calc.cap(ps[0], 'core');
    const usedCore = Calc.liveUsed(ps[0]).core;
    Ops.closePeriod(ps, ps[0].id, 'tester');
    ps[0].res.core.pct = 999; // даже если бы ресурсы изменились
    assert.strictEqual(Calc.cap(ps[0], 'core'), before);
    assert.strictEqual(Calc.usedP(ps[0]).core, usedCore);
  });
  await test('изменение закрытой вехи отклоняется, вид — разрешён', () => {
    const old = clone(seed.periods);
    Ops.closePeriod(old, old[0].id);
    const changed = clone(old);
    changed[0].tasks[1].h += 1;
    assert.ok(Ops.checkClosedUntouched(old, changed));
    const view = clone(old);
    view[0].folded = true;
    view[0].collapsed = { 1: true };
    assert.strictEqual(Ops.checkClosedUntouched(old, view), null);
    const reopened = clone(old);
    Ops.reopenPeriod(reopened, reopened[0].id);
    assert.strictEqual(Ops.checkClosedUntouched(old, reopened), null);
    assert.deepStrictEqual(Ops.reopenedIds(old, reopened), [old[0].id]);
  });

  console.log('Дифф и слияние (4.3)');
  await test('дифф: добавлено / удалено / изменено по WBS и ключам', () => {
    const cur = clone(seed.periods);
    const file = clone(seed.periods);
    file[0].tasks[1].h = 123; // изменено
    file[0].chk[file[0].tasks[2].w] = !file[0].chk[file[0].tasks[2].w];
    file[0].tasks.splice(5, 1); // удалено
    file[0].tasks.push({ w: '99.1', n: 'Новая', h: 8, r: 'core', s: false, d: 1 }); // добавлено
    file[0].chk['99.1'] = true;
    file[0].res.core.pct = 150;
    file[1].devEnd = '2026-12-01';
    const items = Diff.diffPeriods(cur, Diff.remapFile(cur, file));
    const keys = items.map((i) => `${i.status}:${i.key}`).sort();
    assert.ok(keys.includes(`changed:T:p1:${cur[0].tasks[1].w}`));
    assert.ok(keys.includes(`changed:T:p1:${cur[0].tasks[2].w}`));
    assert.ok(keys.includes(`removed:T:p1:${cur[0].tasks[5].w}`));
    assert.ok(keys.includes('added:T:p1:99.1'));
    assert.ok(keys.includes('changed:R:p1:core'));
    assert.ok(keys.includes('changed:F:p2:devEnd'));
    const t = items.find((i) => i.key === `T:p1:${cur[0].tasks[1].w}`);
    assert.deepStrictEqual(t.fields, ['h']);
  });
  await test('слияние: «всё из файла» = файл, «всё текущее» = текущее', () => {
    const cur = clone(seed.periods);
    const file = clone(seed.periods);
    file[0].tasks[1].h = 1;
    file[0].tasks.splice(3, 0, { w: '1.77', n: 'Вставка', h: 5, r: 'test', s: false, d: 1 });
    file[0].chk['1.77'] = true;
    file[1].tasks.splice(10, 1);
    file.push({ ...clone(file[1]), id: 'p9', name: 'Новая', linkedTo: null });
    const f = Diff.remapFile(cur, file);
    const items = Diff.diffPeriods(cur, f);
    const all = (v) => Object.fromEntries(items.map((i) => [i.key, v]));
    assert.strictEqual(JSON.stringify(Diff.applyChoices(cur, f, items, all('file'))), JSON.stringify(f));
    assert.strictEqual(JSON.stringify(Diff.applyChoices(cur, f, items, all('cur'))), JSON.stringify(cur));
  });
  await test('слияние: выборочно, вставка на своё место', () => {
    const cur = clone(seed.periods);
    const file = clone(seed.periods);
    file[0].tasks.splice(3, 0, { w: '1.77', n: 'Вставка', h: 5, r: 'test', s: false, d: 1 });
    file[0].chk['1.77'] = true;
    file[0].tasks[1].h = 1;
    const f = Diff.remapFile(cur, file);
    const items = Diff.diffPeriods(cur, f);
    const res = Diff.applyChoices(cur, f, items, { 'T:p1:1.77': 'file' });
    assert.strictEqual(res[0].tasks[3].w, '1.77');
    assert.strictEqual(res[0].tasks[1].h, cur[0].tasks[1].h);
    assert.strictEqual(res[0].chk['1.77'], true);
  });
  await test('сопоставление версий по имени, если id другой', () => {
    const cur = clone(seed.periods);
    const file = clone(seed.periods).map((p, i) => ({ ...p, id: 'x' + i, linkedTo: 'x' + (1 - i) }));
    const f = Diff.remapFile(cur, file);
    assert.deepStrictEqual(Diff.diffPeriods(cur, f), []);
  });
  await test('трёхстороннее слияние: непересекающиеся правки объединяются, пересекающиеся — конфликт', () => {
    const base = clone(seed.periods);
    const local = clone(base);
    const remote = clone(base);
    local[0].tasks[1].h = 11;
    remote[0].tasks[2].h = 22;
    let tw = Diff.threeWay(base, local, remote);
    assert.strictEqual(tw.conflicts.length, 0);
    const merged = Diff.applyChoices(remote, local, tw.items, tw.choices);
    assert.strictEqual(merged[0].tasks[1].h, 11);
    assert.strictEqual(merged[0].tasks[2].h, 22);
    remote[0].tasks[1].h = 33;
    tw = Diff.threeWay(base, local, remote);
    assert.strictEqual(tw.conflicts.length, 1);
  });
}

// ── API ─────────────────────────────────────────────────────────
function startServer(dataDir, port) {
  return new Promise((resolve, reject) => {
    const proc = spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
      env: { ...process.env, PORT: String(port), DATA_DIR: dataDir, ADMIN_INITIAL_PASSWORD: 'admin-init-1', SESSION_SECRET: 'test-secret', CONFIG_FILE: 'config.json', HOST: '127.0.0.1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    proc.stdout.on('data', (d) => {
      out += d;
      if (out.includes('запущен')) resolve(proc);
    });
    proc.stderr.on('data', (d) => { out += d; });
    proc.on('exit', (c) => reject(new Error('сервер завершился: ' + c + '\n' + out)));
    setTimeout(() => reject(new Error('таймаут запуска\n' + out)), 15000);
  });
}
class Client {
  constructor(base) { this.base = base; this.cookie = ''; this.csrf = ''; }
  async req(method, url, body) {
    const headers = {};
    if (this.cookie) headers.cookie = this.cookie;
    if (body !== undefined) headers['content-type'] = 'application/json';
    if (this.csrf && method !== 'GET') headers['x-csrf-token'] = this.csrf;
    const r = await fetch(this.base + url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const sc = r.headers.get('set-cookie');
    if (sc) this.cookie = sc.split(';')[0];
    const text = await r.text();
    let data = null;
    try { data = JSON.parse(text); } catch (e) { data = text; }
    return { status: r.status, data };
  }
  async login(login, password) {
    const r = await this.req('POST', '/api/auth/login', { login, password });
    if (r.status === 200) this.csrf = r.data.csrf;
    return r;
  }
}

async function apiTests() {
  console.log('API');
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp-test-'));
  const port = 39000 + Math.floor(Math.random() * 1000);
  const proc = await startServer(dataDir, port);
  const base = `http://127.0.0.1:${port}`;
  try {
    const admin = new Client(base);
    await test('без входа — 401', async () => assert.strictEqual((await admin.req('GET', '/api/projects')).status, 401));
    await test('неверный пароль — 401', async () => assert.strictEqual((await new Client(base).login('admin', 'nope')).status, 401));
    await test('вход админа, требуется смена пароля', async () => {
      const r = await admin.login('admin', 'admin-init-1');
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.data.user.mustChangePassword, true);
      assert.strictEqual((await admin.req('GET', '/api/projects')).status, 403);
    });
    await test('без CSRF-токена — 403', async () => {
      const c = new Client(base);
      c.cookie = admin.cookie;
      assert.strictEqual((await c.req('POST', '/api/auth/password', { oldPassword: 'admin-init-1', newPassword: 'x'.repeat(10) })).status, 403);
    });
    await test('смена пароля', async () => {
      const r = await admin.req('POST', '/api/auth/password', { oldPassword: 'admin-init-1', newPassword: 'admin-pass-2' });
      assert.strictEqual(r.status, 200);
    });
    let pid;
    let rev;
    await test('проект на сервере (сид при первом запуске или загрузка файла)', async () => {
      let r = await admin.req('GET', '/api/projects');
      if (REAL_SEED) assert.strictEqual(r.data.projects.length, 1);
      else {
        // без сида проект не создаётся автоматически — создаём из файла
        assert.strictEqual(r.data.projects.length, 0);
        assert.strictEqual((await admin.req('POST', '/api/projects', { project: SEED })).status, 200);
        r = await admin.req('GET', '/api/projects');
      }
      pid = r.data.projects[0].projectId;
      const p = await admin.req('GET', `/api/projects/${pid}`);
      rev = p.data.project.revision;
      if (REAL_SEED) assert.deepStrictEqual(verifySeed(p.data.project).filter((c) => !c.ok), []);
      assert.ok(fs.existsSync(path.join(dataDir, 'projects', `${pid}.json`)));
    });
    const user = new Client(base);
    let uid;
    await test('админ создаёт пользователя; без прав проект не виден', async () => {
      const r = await admin.req('POST', '/api/users', { login: 'ivan', password: 'ivan-pass-1' });
      assert.strictEqual(r.status, 200);
      uid = r.data.user.id;
      await user.login('ivan', 'ivan-pass-1');
      await user.req('POST', '/api/auth/password', { oldPassword: 'ivan-pass-1', newPassword: 'ivan-pass-2' });
      assert.strictEqual((await user.req('GET', '/api/projects')).data.projects.length, 0);
      assert.strictEqual((await user.req('GET', `/api/projects/${pid}`)).status, 404);
      assert.strictEqual((await user.req('GET', '/api/users')).status, 403);
    });
    await test('право «чтение»: читать можно, писать нельзя', async () => {
      await admin.req('PUT', `/api/users/${uid}`, { perms: { [pid]: 'read' } });
      const p = await user.req('GET', `/api/projects/${pid}`);
      assert.strictEqual(p.status, 200);
      assert.strictEqual(p.data.access, 'read');
      const w = await user.req('PUT', `/api/projects/${pid}`, { baseRevision: rev, periods: p.data.project.periods });
      assert.strictEqual(w.status, 403);
    });
    await test('право «редактирование» + конфликт ревизий 409', async () => {
      await admin.req('PUT', `/api/users/${uid}`, { perms: { [pid]: 'edit' } });
      const p = (await user.req('GET', `/api/projects/${pid}`)).data.project;
      p.periods[0].tasks[1].h = 81;
      const w = await user.req('PUT', `/api/projects/${pid}`, { baseRevision: p.revision, periods: p.periods });
      assert.strictEqual(w.status, 200);
      assert.strictEqual(w.data.project.revision, p.revision + 1);
      const stale = await admin.req('PUT', `/api/projects/${pid}`, { baseRevision: p.revision, periods: p.periods });
      assert.strictEqual(stale.status, 409);
      assert.strictEqual(stale.data.current.revision, p.revision + 1);
    });
    await test('невалидные данные отклоняются (XSS-ключ, дубликат WBS)', async () => {
      const p = (await admin.req('GET', `/api/projects/${pid}`)).data.project;
      const bad = clone(p.periods);
      bad[0].tasks[2].w = bad[0].tasks[1].w;
      assert.strictEqual((await admin.req('PUT', `/api/projects/${pid}`, { baseRevision: p.revision, periods: bad })).status, 400);
      const bad2 = clone(p.periods);
      bad2[0].res['<img src=x>'] = { label: 'x', n: 1, pct: 1, period: 'dev', color: '#000' };
      assert.strictEqual((await admin.req('PUT', `/api/projects/${pid}`, { baseRevision: p.revision, periods: bad2 })).status, 400);
    });
    await test('закрытие вехи: изменения запрещены, переоткрытие возвращает', async () => {
      let p = (await admin.req('GET', `/api/projects/${pid}`)).data.project;
      const c = await admin.req('POST', `/api/projects/${pid}/periods/${p.periods[0].id}/close`, { baseRevision: p.revision });
      assert.strictEqual(c.status, 200);
      p = c.data.project;
      assert.strictEqual(p.periods[0].closed, true);
      assert.ok(p.periods[0].frozenSnapshot.cap.core > 0);
      const ch = clone(p.periods);
      ch[0].tasks[1].h = 1;
      assert.strictEqual((await admin.req('PUT', `/api/projects/${pid}`, { baseRevision: p.revision, periods: ch })).status, 422);
      const view = clone(p.periods);
      view[0].folded = true;
      const v = await admin.req('PUT', `/api/projects/${pid}`, { baseRevision: p.revision, periods: view });
      assert.strictEqual(v.status, 200);
      const ro = await admin.req('POST', `/api/projects/${pid}/periods/${p.periods[0].id}/reopen`, { baseRevision: v.data.project.revision });
      assert.strictEqual(ro.status, 200);
      assert.strictEqual(ro.data.project.periods[0].closed, false);
    });
    await test('отвязка через API', async () => {
      const p = (await admin.req('GET', `/api/projects/${pid}`)).data.project;
      const r = await admin.req('POST', `/api/projects/${pid}/periods/${p.periods[1].id}/detach`, { baseRevision: p.revision, fromId: p.periods[0].id });
      assert.strictEqual(r.status, 200);
      assert.strictEqual(r.data.result.removed, leavesOn(p.periods[0]).length);
      assert.strictEqual(r.data.project.periods[1].linkedTo, null);
    });
    await test('скачивание и загрузка поверх: дифф и выборочный мёрдж', async () => {
      const dl = await admin.req('GET', `/api/projects/${pid}/download`);
      assert.strictEqual(dl.status, 200);
      const file = dl.data;
      assert.strictEqual(file.schema, 'capacity-planner/v1');
      file.periods[0].tasks[1].h = 500;
      file.periods[0].tasks[2].h = 600;
      const up = await admin.req('POST', `/api/projects/${pid}/upload`, { file });
      assert.strictEqual(up.status, 200);
      assert.strictEqual(up.data.items.length, 2);
      const k1 = up.data.items.find((i) => i.w === file.periods[0].tasks[1].w).key;
      const m = await admin.req('POST', `/api/projects/${pid}/merge`, { uploadId: up.data.uploadId, baseRevision: up.data.baseRevision, choices: { [k1]: 'file' } });
      assert.strictEqual(m.status, 200);
      assert.strictEqual(m.data.project.periods[0].tasks[1].h, 500);
      assert.notStrictEqual(m.data.project.periods[0].tasks[2].h, 600);
    });
    await test('загрузка как новый проект + права только на него', async () => {
      const r = await admin.req('POST', '/api/projects', { project: SEED, name: 'Второй' });
      assert.strictEqual(r.status, 200);
      const list = (await user.req('GET', '/api/projects')).data.projects;
      assert.strictEqual(list.length, 1);
      assert.strictEqual(list[0].projectId, pid);
      assert.strictEqual((await user.req('DELETE', `/api/projects/${r.data.project.projectId}`)).status, 403);
    });
    await test('обновление из git: только администратор', async () => {
      assert.strictEqual((await user.req('GET', '/api/admin/update')).status, 403);
      assert.strictEqual((await user.req('POST', '/api/admin/update')).status, 403);
      const st = await admin.req('GET', '/api/admin/update');
      assert.strictEqual(st.status, 200);
      assert.ok(st.data.version);
    });
    await test('rate-limit логина', async () => {
      const c = new Client(base);
      let last;
      for (let i = 0; i < 12; i++) last = await c.login('ghost', 'bad');
      assert.strictEqual(last.status, 429);
    });
  } finally {
    proc.kill('SIGTERM');
    await new Promise((r) => setTimeout(r, 300));
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
}

(async () => {
  await unit();
  await apiTests();
  console.log(`\n${failed ? 'ПРОВАЛ' : 'OK'}: пройдено ${passed}, провалено ${failed}`);
  process.exit(failed ? 1 : 0);
})();
