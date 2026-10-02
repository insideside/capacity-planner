// Обновление приложения из git (только для администратора).
// Код обновляется fast-forward'ом до upstream-ветки; данные (DATA_DIR), config.json и .env в git не хранятся
// и обновлением не затрагиваются.
const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

function run(cmd, args, cwd, timeoutMs) {
  return new Promise((resolve) => {
    // npm на Windows — это npm.cmd, его можно запустить только через shell (аргументы фиксированные)
    const shell = process.platform === 'win32' && cmd === 'npm';
    execFile(cmd, args, { cwd, timeout: timeoutMs || 60000, maxBuffer: 4 * 1024 * 1024, shell, windowsHide: true }, (err, stdout, stderr) => {
      resolve({ code: err ? (typeof err.code === 'number' ? err.code : 1) : 0, stdout: String(stdout || '').trim(), stderr: String(stderr || '').trim(), err });
    });
  });
}
const git = (root, args, t) => run('git', args, root, t);

function parseCommit(line) {
  const [hash, date, author, ...rest] = line.split('\t');
  return { hash, date, author, subject: rest.join('\t') };
}

async function status(root) {
  const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
  const base = { version: pkg.version, available: false };
  if (!fs.existsSync(path.join(root, '.git'))) return { ...base, reason: 'Приложение установлено не из git — обновление недоступно. См. раздел «Установка с GitHub» в DOC.md.' };
  const v = await git(root, ['--version']);
  if (v.code) return { ...base, reason: 'git не найден на сервере' };
  const head = await git(root, ['log', '-1', '--format=%h%x09%cI%x09%an%x09%s']);
  if (head.code) return { ...base, reason: `git: ${head.stderr}` };
  const branch = (await git(root, ['rev-parse', '--abbrev-ref', 'HEAD'])).stdout;
  const up = await git(root, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
  const current = parseCommit(head.stdout);
  if (up.code) return { ...base, current, branch, reason: `У ветки «${branch}» не настроен upstream (git branch --set-upstream-to=origin/${branch})` };
  const fetch = await git(root, ['fetch', '--quiet', '--prune'], 60000);
  if (fetch.code) return { ...base, current, branch, upstream: up.stdout, reason: `Не удалось получить обновления: ${fetch.stderr || 'нет связи с репозиторием'}` };
  const behind = Number((await git(root, ['rev-list', '--count', 'HEAD..@{u}'])).stdout) || 0;
  const ahead = Number((await git(root, ['rev-list', '--count', '@{u}..HEAD'])).stdout) || 0;
  const log = behind ? (await git(root, ['log', '--format=%h%x09%cI%x09%an%x09%s', '-n', '50', 'HEAD..@{u}'])).stdout : '';
  const dirty = (await git(root, ['status', '--porcelain', '--untracked-files=no'])).stdout;
  return {
    ...base,
    available: true,
    branch,
    upstream: up.stdout,
    current,
    behind,
    ahead,
    commits: log ? log.split('\n').map(parseCommit) : [],
    dirty: dirty ? dirty.split('\n') : [],
    checkedAt: new Date().toISOString(),
  };
}

let busy = false;
// Применяет обновление. Возвращает {from, to, npm} или бросает Error с понятным текстом.
async function apply(root) {
  if (busy) throw new Error('Обновление уже выполняется');
  busy = true;
  try {
    const st = await status(root);
    if (!st.available) throw new Error(st.reason);
    // package-lock.json — генерируемый файл: если изменён только он, восстанавливаем версию из git
    const lockOnly = st.dirty.length && st.dirty.every((l) => / package-lock\.json$/.test(l));
    if (lockOnly) {
      await git(root, ['checkout', '--', 'package-lock.json']);
      st.dirty = [];
    }
    if (st.dirty.length) throw new Error(`В рабочей копии есть локальные изменения файлов приложения — обновление остановлено:\n${st.dirty.join('\n')}`);
    if (st.ahead) throw new Error(`Локальная ветка опережает ${st.upstream} на ${st.ahead} коммит(ов) — нужна ручная синхронизация`);
    if (!st.behind) throw new Error('Установлена последняя версия');
    const from = (await git(root, ['rev-parse', 'HEAD'])).stdout;
    const changed = (await git(root, ['diff', '--name-only', 'HEAD', '@{u}'])).stdout.split('\n');
    const needNpm = changed.some((f) => f === 'package.json' || f === 'package-lock.json');
    const m = await git(root, ['merge', '--ff-only', '@{u}']);
    if (m.code) throw new Error(`git merge --ff-only: ${m.stderr || m.stdout}`);
    if (needNpm) {
      // npm ci ставит ровно то, что в package-lock.json, и не меняет его
      const hasLock = fs.existsSync(path.join(root, 'package-lock.json'));
      const npm = await run('npm', [hasLock ? 'ci' : 'install', '--omit=dev', '--no-audit', '--no-fund'], root, 10 * 60000);
      if (npm.code) {
        await git(root, ['reset', '--hard', from]); // откат кода — приложение остаётся в рабочем состоянии
        throw new Error(`npm install завершился с ошибкой, код откатан к прежней версии:\n${npm.stderr.slice(-2000)}`);
      }
    }
    const to = (await git(root, ['rev-parse', 'HEAD'])).stdout;
    return { from: from.slice(0, 7), to: to.slice(0, 7), npm: needNpm, commits: st.commits.length };
  } finally {
    busy = false;
  }
}

module.exports = { status, apply };
