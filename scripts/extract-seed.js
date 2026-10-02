#!/usr/bin/env node
// Извлекает стартовые данные из исходного capacity_planner.html и пишет сид-проект.
// Использование: node scripts/extract-seed.js <capacity_planner.html> <out.json>
// Если в HTML вшит снимок (window.CP_SAVED_STATE), берётся он; иначе — мастер-список IMPORTED_* (как buildDefaultPeriods()).
const fs = require('fs');
const vm = require('vm');
const path = require('path');
const { SCHEMA, validatePeriods, normalizePeriod } = require('../shared/validate');
const { verifySeed } = require('../server/seed');

const [src, out] = process.argv.slice(2);
if (!src || !out) {
  console.error('Использование: node scripts/extract-seed.js <capacity_planner.html> <out.json>');
  process.exit(2);
}
const html = fs.readFileSync(src, 'utf8');
let periods;
const saved = /<script id="cpSavedState">window\.CP_SAVED_STATE=([\s\S]*?);<\/script>/.exec(html);
if (saved) {
  periods = JSON.parse(saved[1]);
  console.log('Найден вшитый снимок CP_SAVED_STATE');
} else {
  // Выполняем только блок данных исходного скрипта (до первой функции работы с DOM).
  const script = /<script>([\s\S]*?)<\/script>/.exec(html)[1];
  const dataPart = script.slice(0, script.indexOf('var HOL='));
  const ctx = {};
  vm.createContext(ctx);
  vm.runInContext(dataPart + '\n;this.__out={T:IMPORTED_TASKS,R:IMPORTED_RES,D322:IMPORTED_DATES_322,D323:IMPORTED_DATES_323};', ctx);
  const { T, R, D322, D323 } = ctx.__out;
  const chkFromRel = (tasks, rel) => {
    const c = {};
    tasks.forEach((t) => { c[t.w] = !t.s && t.rel === rel; });
    return c;
  };
  const mk = (id, name, dates, rel, linkedTo) => ({
    id, name, ...dates,
    res: JSON.parse(JSON.stringify(R)),
    tasks: JSON.parse(JSON.stringify(T)),
    chk: chkFromRel(T, rel),
    collapsed: {}, filter: null, filterActive: null, folded: false, linkedTo,
    colWidths: { cb: 32, h: 46, r: 98, name: 0, del: 18 },
    closed: false,
  });
  periods = [mk('p1', '3.2.2', D322, '322', 'p2'), mk('p2', '3.2.3', D323, '323', 'p1')];
}
periods.forEach(normalizePeriod);
const errs = validatePeriods(periods);
if (errs.length) {
  console.error('Ошибки валидации:\n' + errs.join('\n'));
  process.exit(1);
}
const project = { schema: SCHEMA, projectId: 'seed', name: 'Релиз 2026', revision: 1, updatedAt: new Date().toISOString(), periods };
const checks = verifySeed(project);
const bad = checks.filter((c) => !c.ok);
for (const c of checks) console.log(`${c.ok ? '✔' : '✘'} ${c.name}${c.ok ? '' : `: ожидалось ${JSON.stringify(c.expected)}, получено ${JSON.stringify(c.actual)}`}`);
if (bad.length) {
  console.error(`\nКонтрольные числа НЕ сходятся (${bad.length}) — данные повреждены, сид не записан.`);
  process.exit(1);
}
fs.mkdirSync(path.dirname(out), { recursive: true });
fs.writeFileSync(out, JSON.stringify(project, null, 1));
console.log(`\nСид записан: ${out}`);
