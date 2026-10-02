# Установка «Планировщика ёмкости» из git (Windows). Приложение ставится без данных.
#
#   Вариант 1 (из клона):  git clone https://github.com/insideside/capacity-planner.git
#                          cd capacity-planner;  .\install.ps1      (или install.bat)
#   Вариант 2:             .\install.ps1 [каталог]   — скрипт сам клонирует репозиторий
#
# Переменные: CP_REPO_URL, CP_BRANCH (по умолчанию main), ADMIN_INITIAL_PASSWORD.
param([string]$Dir = 'capacity-planner')
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$repoUrl = if ($env:CP_REPO_URL) { $env:CP_REPO_URL } else { 'https://github.com/insideside/capacity-planner.git' }
$branch  = if ($env:CP_BRANCH) { $env:CP_BRANCH } else { 'main' }

function Die($m) { Write-Host "Ошибка: $m"; exit 1 }
if (-not (Get-Command git -ErrorAction SilentlyContinue))  { Die 'git не найден. Установите Git for Windows и повторите.' }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { Die 'Node.js не найден. Установите Node.js 18+ (https://nodejs.org).' }
& node -e "process.exit(+process.versions.node.split('.')[0]>=18?0:1)"
if ($LASTEXITCODE -ne 0) { Die "нужен Node.js 18 или новее (сейчас $(node -v))." }

$here = $PSScriptRoot
# Без аргумента и при запуске из клона — установка на месте; с аргументом — клон в указанный каталог.
$inClone = -not $PSBoundParameters.ContainsKey('Dir') -and $here -and (Test-Path (Join-Path $here 'package.json')) -and (Test-Path (Join-Path $here '.git')) -and `
  ((Get-Content (Join-Path $here 'package.json') -Raw) -match '"name": "capacity-planner"')
if ($inClone) {
  $target = $here
  Write-Host "Установка в существующий клон: $target"
} else {
  if (Test-Path (Join-Path $Dir '.git')) {
    Write-Host "Каталог $Dir уже содержит клон — обновляю код…"
    & git -C $Dir pull --ff-only; if ($LASTEXITCODE -ne 0) { exit 1 }
  } else {
    Write-Host "Клонирую $repoUrl ($branch) в $Dir…"
    & git clone --branch $branch $repoUrl $Dir; if ($LASTEXITCODE -ne 0) { exit 1 }
  }
  $target = (Resolve-Path $Dir).Path
}
Set-Location $target

Write-Host 'Устанавливаю зависимости…'
if (Test-Path 'package-lock.json') { & npm ci --omit=dev --no-audit --no-fund } else { & npm install --omit=dev --no-audit --no-fund }
if ($LASTEXITCODE -ne 0) { Die 'npm install завершился с ошибкой' }

if (-not (Test-Path 'config.json')) {
  Copy-Item 'config.example.json' 'config.json'
  Write-Host 'Создан config.json (порт по умолчанию 3000 — измените при необходимости).'
}

$adminPwd = $null
if (-not (Test-Path '.env')) {
  $secret = (& node -e "console.log(require('crypto').randomBytes(48).toString('hex'))").Trim()
  $adminPwd = if ($env:ADMIN_INITIAL_PASSWORD) { $env:ADMIN_INITIAL_PASSWORD } else { (& node -e "console.log(require('crypto').randomBytes(9).toString('base64url'))").Trim() }
  $lines = @("# Создано install.ps1 $(Get-Date -Format 'yyyy-MM-dd HH:mm'). Не храните этот файл в git.", "SESSION_SECRET=$secret", "ADMIN_INITIAL_PASSWORD=$adminPwd")
  [System.IO.File]::WriteAllLines((Join-Path $target '.env'), $lines, (New-Object System.Text.UTF8Encoding($false)))
  Write-Host 'Создан .env (SESSION_SECRET и пароль первичного администратора).'
}

$port = (& node -e "console.log(require('./server/config').loadConfig().port)").Trim()
Write-Host ''
Write-Host '────────────────────────────────────────────'
Write-Host " Установлено: $target"
Write-Host ' Запуск:      start.bat (или .\start.ps1)    Остановка: stop.bat'
Write-Host " Адрес:       http://localhost:$port"
if ($adminPwd) { Write-Host " Вход:        admin / $adminPwd   (смените при первом входе)" }
Write-Host ' Данных нет: создайте проект («+ Проект») или загрузите конфигурацию.'
Write-Host '────────────────────────────────────────────'
