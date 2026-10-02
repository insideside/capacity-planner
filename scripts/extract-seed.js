#!/usr/bin/env node
// Извлекает стартовые данные из исходного capacity_planner.html и пишет сид-проект.
// Использование: node scripts/extract-seed.js <capacity_planner.html> <out.json>
// Если в HTML вшит снимок (window.CP_SAVED_STATE), берётся он; иначе — мастер-список IMPORTED_* (как buildDefaultPeriods()).
// Разбор общий с приложением — shared/legacy.js.
const fs = require('fs');
const path = require('path');
const { SCHEMA, validatePeriods, normalizePeriod } = require('../shared/validate');
const { verifySeed } = require('../server/seed');
const { parseLegacyHtml } = require('../shared/legacy');

const [src, out] = process.argv.slice(2);
if (!src || !out) {
  console.error('Использование: node scripts/extract-seed.js <capacity_planner.html> <out.json>');
  process.exit(2);
}
const html = fs.readFileSync(src, 'utf8');
// Тот же разбор, что и при загрузке HTML в приложении (shared/legacy.js): код файла не выполняется.
const { periods, source } = parseLegacyHtml(html);
console.log(`Источник данных в HTML: ${source}`);
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
