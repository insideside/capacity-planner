#!/usr/bin/env bash
# Запуск «Планировщика ёмкости» (Linux / macOS).
#   ./start.sh      — в фоне, лог в logs/server.log
#   ./start.sh -f   — на переднем плане (Ctrl+C — остановка)
set -euo pipefail
cd "$(dirname "$0")"

if ! command -v node >/dev/null 2>&1; then
  echo "Node.js не найден. Установите Node.js 18+ (https://nodejs.org) и повторите." >&2
  exit 1
fi
if [ ! -d node_modules ]; then
  echo "Первый запуск: устанавливаю зависимости…"
  if [ -f package-lock.json ]; then npm ci --omit=dev --no-audit --no-fund; else npm install --omit=dev --no-audit --no-fund; fi
fi

PID_FILE="capacity-planner.pid"
if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
  echo "Сервер уже запущен (PID $(cat "$PID_FILE"))."
  exit 0
fi
rm -f "$PID_FILE"

PORT_SHOWN="$(node -e "console.log(require('./server/config').loadConfig().port)")"

if [ "${1:-}" = "-f" ]; then
  exec node server/index.js
fi

mkdir -p logs
nohup node server/index.js >> logs/server.log 2>&1 &
NODE_PID=$!
for _ in $(seq 1 50); do
  [ -f "$PID_FILE" ] && break
  if ! kill -0 "$NODE_PID" 2>/dev/null; then
    echo "Сервер не запустился. Последние строки logs/server.log:" >&2
    tail -n 20 logs/server.log >&2
    exit 1
  fi
  sleep 0.2
done
echo "Планировщик ёмкости запущен: http://localhost:${PORT_SHOWN}  (PID ${NODE_PID})"
echo "Лог: logs/server.log · Остановка: ./stop.sh"
