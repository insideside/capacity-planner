#!/usr/bin/env bash
# Остановка «Планировщика ёмкости» (Linux / macOS): по PID-файлу, иначе — по порту.
set -uo pipefail
cd "$(dirname "$0")"
PID_FILE="capacity-planner.pid"

stop_pid() {
  local pid="$1"
  kill "$pid" 2>/dev/null || return 1
  for _ in $(seq 1 25); do
    kill -0 "$pid" 2>/dev/null || return 0
    sleep 0.2
  done
  kill -9 "$pid" 2>/dev/null
  return 0
}

if [ -f "$PID_FILE" ]; then
  PID="$(cat "$PID_FILE")"
  if kill -0 "$PID" 2>/dev/null; then
    stop_pid "$PID" && echo "Сервер остановлен (PID $PID)."
    rm -f "$PID_FILE"
    exit 0
  fi
  rm -f "$PID_FILE"
fi

PORT="$(node -e "console.log(require('./server/config').loadConfig().port)" 2>/dev/null || echo 3000)"
if command -v lsof >/dev/null 2>&1; then
  PIDS="$(lsof -t -iTCP:"$PORT" -sTCP:LISTEN 2>/dev/null || true)"
  for P in $PIDS; do
    if ps -p "$P" -o command= | grep -q "server/index.js"; then
      stop_pid "$P" && echo "Сервер остановлен (PID $P, порт $PORT)."
      exit 0
    fi
  done
fi
echo "Сервер не запущен."
