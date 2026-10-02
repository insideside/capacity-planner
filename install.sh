#!/usr/bin/env bash
# Установка «Планировщика ёмкости» из git (Linux / macOS). Приложение ставится без данных.
#
#   Вариант 1 (из клона):   git clone https://github.com/insideside/capacity-planner.git
#                           cd capacity-planner && ./install.sh
#   Вариант 2 (одной командой): bash install.sh [каталог]   — скрипт сам клонирует репозиторий
#
# Переменные: CP_REPO_URL (адрес репозитория), CP_BRANCH (ветка, по умолчанию main),
#             ADMIN_INITIAL_PASSWORD (пароль первичного админа; иначе генерируется).
set -euo pipefail

REPO_URL="${CP_REPO_URL:-https://github.com/insideside/capacity-planner.git}"
BRANCH="${CP_BRANCH:-main}"

die() { echo "Ошибка: $*" >&2; exit 1; }
command -v git >/dev/null 2>&1 || die "git не найден. Установите git и повторите."
command -v node >/dev/null 2>&1 || die "Node.js не найден. Установите Node.js 18+ (https://nodejs.org)."
command -v npm >/dev/null 2>&1 || die "npm не найден (входит в Node.js)."
node -e "process.exit(+process.versions.node.split('.')[0]>=18?0:1)" || die "нужен Node.js 18 или новее (сейчас $(node -v))."

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" 2>/dev/null && pwd || pwd)"
# Без аргумента и при запуске из клона — установка на месте; с аргументом — клон в указанный каталог.
if [ -z "${1:-}" ] && [ -f "$SCRIPT_DIR/package.json" ] && [ -d "$SCRIPT_DIR/.git" ] && grep -q '"name": "capacity-planner"' "$SCRIPT_DIR/package.json"; then
  DIR="$SCRIPT_DIR"
  echo "Установка в существующий клон: ${DIR}"
else
  DIR="${1:-capacity-planner}"
  if [ -d "${DIR}/.git" ]; then
    echo "Каталог ${DIR} уже содержит клон — обновляю код…"
    git -C "${DIR}" pull --ff-only
  else
    echo "Клонирую ${REPO_URL} (${BRANCH}) в ${DIR}…"
    git clone --branch "${BRANCH}" "${REPO_URL}" "${DIR}"
  fi
  DIR="$(cd "${DIR}" && pwd)"
fi
cd "${DIR}"

echo "Устанавливаю зависимости…"
if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; else npm install --omit=dev --no-audit --no-fund; fi

if [ ! -f config.json ]; then
  cp config.example.json config.json
  echo "Создан config.json (порт по умолчанию 3000 — измените при необходимости)."
fi

ADMIN_PWD=""
if [ ! -f .env ]; then
  SECRET="$(node -e "console.log(require('crypto').randomBytes(48).toString('hex'))")"
  ADMIN_PWD="${ADMIN_INITIAL_PASSWORD:-$(node -e "console.log(require('crypto').randomBytes(9).toString('base64url'))")}"
  umask 077
  cat > .env <<ENV
# Создано install.sh $(date '+%Y-%m-%d %H:%M'). Не храните этот файл в git.
SESSION_SECRET=${SECRET}
ADMIN_INITIAL_PASSWORD=${ADMIN_PWD}
ENV
  echo "Создан .env (SESSION_SECRET и пароль первичного администратора)."
fi

chmod +x start.sh stop.sh install.sh 2>/dev/null || true
PORT="$(node -e "console.log(require('./server/config').loadConfig().port)")"

echo
echo "────────────────────────────────────────────"
echo " Установлено: ${DIR}"
echo " Запуск:      ./start.sh      Остановка: ./stop.sh"
echo " Адрес:       http://localhost:${PORT}"
if [ -n "${ADMIN_PWD}" ]; then
  echo " Вход:        admin / ${ADMIN_PWD}   (смените при первом входе)"
fi
echo " Данных нет: создайте проект («+ Проект») или загрузите конфигурацию."
echo "────────────────────────────────────────────"
