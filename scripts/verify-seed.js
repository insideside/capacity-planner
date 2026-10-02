#!/usr/bin/env node
// Проверяет контрольные числа сида (или любого файла проекта): node scripts/verify-seed.js [project.json]
const fs = require('fs');
const { verifySeed, SEED_FILE } = require('../server/seed');

const file = process.argv[2] || SEED_FILE;
const project = JSON.parse(fs.readFileSync(file, 'utf8'));
const checks = verifySeed(project);
for (const c of checks) console.log(`${c.ok ? '✔' : '✘'} ${c.name}${c.ok ? '' : `: ожидалось ${JSON.stringify(c.expected)}, получено ${JSON.stringify(c.actual)}`}`);
const bad = checks.filter((c) => !c.ok).length;
console.log(bad ? `\nПРОВАЛ: ${bad} из ${checks.length}` : `\nOK: все ${checks.length} проверок пройдены`);
process.exit(bad ? 1 : 0);
