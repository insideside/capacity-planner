# Запуск «Планировщика ёмкости» (Windows PowerShell 5+ / PowerShell 7).
#   .\start.ps1      — в фоне (скрытое окно), лог в logs\server.log
#   .\start.ps1 -f   — на переднем плане (Ctrl+C — остановка)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location $PSScriptRoot

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host 'Node.js не найден. Установите Node.js 18+ (https://nodejs.org) и повторите.'
  exit 1
}
if (-not (Test-Path 'node_modules')) {
  Write-Host 'Первый запуск: устанавливаю зависимости…'
  if (Test-Path 'package-lock.json') { & npm ci --omit=dev --no-audit --no-fund } else { & npm install --omit=dev --no-audit --no-fund }
  if ($LASTEXITCODE -ne 0) { exit 1 }
}

$pidFile = Join-Path $PSScriptRoot 'capacity-planner.pid'
if (Test-Path $pidFile) {
  $old = (Get-Content $pidFile -Raw).Trim()
  if ($old -and (Get-Process -Id $old -ErrorAction SilentlyContinue)) {
    Write-Host "Сервер уже запущен (PID $old)."
    exit 0
  }
  Remove-Item $pidFile -Force
}

$port = (& node -e "console.log(require('./server/config').loadConfig().port)").Trim()

if ($args -contains '-f') {
  & node server/index.js
  exit $LASTEXITCODE
}

New-Item -ItemType Directory -Force -Path 'logs' | Out-Null
$proc = Start-Process -FilePath 'node' -ArgumentList 'server/index.js' -WorkingDirectory $PSScriptRoot `
  -WindowStyle Hidden -RedirectStandardOutput 'logs\server.log' -RedirectStandardError 'logs\server.err.log' -PassThru
for ($i = 0; $i -lt 50; $i++) {
  if (Test-Path $pidFile) { break }
  if ($proc.HasExited) {
    Write-Host 'Сервер не запустился. См. logs\server.log и logs\server.err.log:'
    if (Test-Path 'logs\server.err.log') { Get-Content 'logs\server.err.log' -Tail 20 }
    exit 1
  }
  Start-Sleep -Milliseconds 200
}
Write-Host "Планировщик ёмкости запущен: http://localhost:$port  (PID $($proc.Id))"
Write-Host 'Лог: logs\server.log · Остановка: stop.bat или .\stop.ps1'
