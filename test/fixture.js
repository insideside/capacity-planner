// Синтетический тестовый проект той же структуры, что и сид (две связанные версии с общим мастер-списком).
// Используется в тестах, когда настоящего сида (seed/release-2026.json) нет — в репозитории данных нет.
module.exports = function fixture() {
  const res = {
    core: { label: 'Ядро', n: 3, pct: 200, period: 'dev', color: '#2255e2' },
    test: { label: 'Тестирование', n: 4, pct: 200, period: 'tst', color: '#15803d' },
    iface: { label: 'Интерфейс', n: 2, pct: 130, period: 'dev', color: '#7c3aed' },
  };
  const tasks = [];
  const rk = ['core', 'test', 'iface'];
  let k = 0;
  for (let b = 1; b <= 6; b++) {
    tasks.push({ w: String(b), n: `Блок ${b}`, h: 0, r: 'none', s: true, d: 0, rel: null });
    for (let i = 1; i <= 6; i++) {
      k++;
      const w = `${b}.${i}`;
      if (i === 3) {
        tasks.push({ w, n: `Подблок ${w}`, h: 0, r: 'none', s: true, d: 1, rel: null });
        for (let j = 1; j <= 2; j++) {
          k++;
          tasks.push({ w: `${w}.${j}`, n: `Задача ${w}.${j}`, h: 8 * ((k % 5) + 1), r: rk[k % 3], s: false, d: 2, rel: b === 6 ? '322' : k % 2 ? '322' : '323' });
        }
      } else {
        // в блоке 6 все задачи — первой версии: при отвязке второй версии блок станет пустым
        const rel = b === 6 ? '322' : k === 7 ? 'off' : k % 2 ? '322' : '323';
        tasks.push({ w, n: i === 6 ? 'т. документация' : `Задача ${w}`, h: 8 * ((k % 5) + 1), r: rk[k % 3], s: false, d: 1, rel });
      }
    }
  }
  tasks.push({ w: '7', n: 'Пустой блок', h: 0, r: 'none', s: true, d: 0, rel: null });
  const chk = (rel) => Object.fromEntries(tasks.map((t) => [t.w, !t.s && t.rel === rel]));
  const per = (id, name, rel, link, dates) => ({
    id, name, ...dates, res: JSON.parse(JSON.stringify(res)), tasks: JSON.parse(JSON.stringify(tasks)), chk: chk(rel),
    collapsed: {}, filter: null, filterActive: null, folded: false, linkedTo: link, colWidths: { cb: 32, h: 46, r: 98, name: 0, del: 18 }, closed: false,
  });
  return {
    schema: 'capacity-planner/v1', projectId: 'fixture', name: 'Тестовый проект', revision: 1, updatedAt: new Date().toISOString(),
    periods: [
      per('p1', 'A', '322', 'p2', { devStart: '2026-06-01', devEnd: '2026-11-06', tstStart: '2026-07-01', tstEnd: '2026-12-20' }),
      per('p2', 'B', '323', 'p1', { devStart: '2026-06-01', devEnd: '2026-11-15', tstStart: '2026-06-01', tstEnd: '2026-12-20' }),
    ],
  };
};
