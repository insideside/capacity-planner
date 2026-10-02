// Стартовые данные («Релиз 2026») и автоматическая проверка контрольных чисел (ТЗ, раздел 5).
const fs = require('fs');
const path = require('path');
const Calc = require('../shared/calc');

const SEED_FILE = path.join(__dirname, '..', 'seed', 'release-2026.json');

// Сид необязателен: в репозитории его нет (проект распространяется без данных).
// Локально его можно сгенерировать из исходного HTML: npm run extract-seed.
function hasSeed() {
  return fs.existsSync(SEED_FILE);
}
function loadSeed() {
  return hasSeed() ? JSON.parse(fs.readFileSync(SEED_FILE, 'utf8')) : null;
}

const EXPECT = {
  rows: 203,
  leaves: 187,
  rels: ['322', '323', 'off'],
  off: { n: 'Добавление в ЦМ фильтров по группам', h: 40, r: 'core' },
  periods: {
    '3.2.2': {
      n: 112, h: 5612,
      used: { core: 1800, test: 1780, iface: 1000, c1: 568, front: 464 },
      dates: { devStart: '2026-06-01', devEnd: '2026-11-06', tstStart: '2026-07-01', tstEnd: '2026-12-20' },
    },
    '3.2.3': {
      n: 74, h: 3003,
      used: { core: 1408, test: 1287, iface: 120, c1: 0, front: 180, none: 8 },
      dates: { devStart: '2026-06-01', devEnd: '2026-11-15', tstStart: '2026-06-01', tstEnd: '2026-12-20' },
    },
  },
  res: {
    core: { label: 'Разработчики ядра', n: 3, pct: 200, period: 'dev' },
    test: { label: 'Тестировщики', n: 4, pct: 200, period: 'tst' },
    iface: { label: 'Blazor', n: 2, pct: 130, period: 'dev' },
    c1: { label: '1С RUST', n: 1, pct: 65, period: 'dev' },
    front: { label: 'Angular', n: 1, pct: 65, period: 'dev' },
  },
};

// Возвращает список проверок [{name, expected, actual, ok}].
function verifySeed(project) {
  const checks = [];
  const check = (name, expected, actual) => {
    const ok = JSON.stringify(expected) === JSON.stringify(actual);
    checks.push({ name, expected, actual, ok });
  };
  const periods = project.periods || [];
  check('Количество версий', 2, periods.length);
  for (const [name, exp] of Object.entries(EXPECT.periods)) {
    const p = periods.find((x) => x.name === name);
    if (!p) {
      check(`Версия ${name} существует`, true, false);
      continue;
    }
    const leaves = p.tasks.filter((t) => !t.s);
    check(`${name}: строк всего`, EXPECT.rows, p.tasks.length);
    check(`${name}: задач-листов`, EXPECT.leaves, leaves.length);
    check(`${name}: rel ∈ {322,323,off}`, true, leaves.every((t) => EXPECT.rels.includes(t.rel)));
    const off = leaves.filter((t) => t.rel === 'off');
    check(`${name}: ровно одна off-задача`, 1, off.length);
    if (off[0]) {
      check(`${name}: off-задача`, EXPECT.off, { n: off[0].n, h: off[0].h, r: off[0].r });
      check(`${name}: off-задача снята`, false, !!p.chk[off[0].w]);
    }
    const tt = Calc.totals(p);
    check(`${name}: отмечено листов`, exp.n, tt.n);
    check(`${name}: часов`, exp.h, tt.h);
    const used = Calc.liveUsed(p);
    for (const [k, v] of Object.entries(exp.used)) check(`${name}: загрузка ${k}`, v, used[k] || 0);
    check(`${name}: даты`, exp.dates, { devStart: p.devStart, devEnd: p.devEnd, tstStart: p.tstStart, tstEnd: p.tstEnd });
    for (const [k, r] of Object.entries(EXPECT.res)) {
      const pr = p.res[k] || {};
      check(`${name}: ресурс ${k}`, r, { label: pr.label, n: pr.n, pct: pr.pct, period: pr.period });
    }
  }
  const a = periods.find((x) => x.name === '3.2.2');
  const b = periods.find((x) => x.name === '3.2.3');
  if (a && b) {
    check('3.2.2 ↔ 3.2.3 связаны', true, a.linkedTo === b.id && b.linkedTo === a.id);
    check('Общий мастер-список (одинаковые задачи)', true, JSON.stringify(a.tasks) === JSON.stringify(b.tasks));
  }
  return checks;
}

module.exports = { loadSeed, hasSeed, verifySeed, SEED_FILE };
