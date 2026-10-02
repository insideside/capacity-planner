# Остановка «Планировщика ёмкости» (Windows): по PID-файлу, иначе — по порту.
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
Set-Location $PSScriptRoot
$pidFile = Join-Path $PSScriptRoot 'capacity-planner.pid'

if (Test-Path $pidFile) {
  $p = (Get-Content $pidFile -Raw).Trim()
  Remove-Item $pidFile -Force
  if ($p -and (Get-Process -Id $p -ErrorAction SilentlyContinue)) {
    Stop-Process -Id $p -Force
    Write-Host "Сервер остановлен (PID $p)."
    exit 0
  }
}

$port = (& node -e "console.log(require('./server/config').loadConfig().port)").Trim()
if (-not $port) { $port = 3000 }
$conns = Get-NetTCPConnection -LocalPort $port -State Listen
foreach ($c in $conns) {
  $proc = Get-Process -Id $c.OwningProcess
  if ($proc -and $proc.ProcessName -eq 'node') {
    Stop-Process -Id $proc.Id -Force
    Write-Host "Сервер остановлен (PID $($proc.Id), порт $port)."
    exit 0
  }
}
Write-Host 'Сервер не запущен.'
