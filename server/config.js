// Загрузка настроек: значения по умолчанию ← config.json ← .env ← переменные окружения.
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

const DEFAULTS = {
  port: 3000,
  host: '0.0.0.0',
  dataDir: './data',
  sessionTtlHours: 12,
  secureCookies: false,
  maxUploadMb: 5,
  login: { maxAttempts: 10, windowMinutes: 15 },
  reopenRequiresAdmin: false,
  detachRemoveInactiveInSource: false,
  pollIntervalSec: 10,
  trustProxy: false,
  updateRestart: 'self',
};

// Минимальный парсер .env: KEY=VALUE, комментарии с #, кавычки по краям снимаются.
function loadDotEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const i = line.indexOf('=');
    if (i < 0) continue;
    const key = line.slice(0, i).trim();
    let val = line.slice(i + 1).trim();
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

function loadConfig() {
  loadDotEnv(path.join(ROOT, '.env'));
  const cfgFile = path.resolve(ROOT, process.env.CONFIG_FILE || 'config.json');
  // config.json не хранится в git: при первом запуске создаётся из config.example.json
  const example = path.join(ROOT, 'config.example.json');
  if (!process.env.CONFIG_FILE && !fs.existsSync(cfgFile) && fs.existsSync(example)) fs.copyFileSync(example, cfgFile);
  let fileCfg = {};
  if (fs.existsSync(cfgFile)) {
    try {
      fileCfg = JSON.parse(fs.readFileSync(cfgFile, 'utf8'));
    } catch (e) {
      throw new Error(`Не удалось прочитать ${cfgFile}: ${e.message}`);
    }
  }
  const cfg = { ...DEFAULTS, ...fileCfg, login: { ...DEFAULTS.login, ...(fileCfg.login || {}) } };
  if (process.env.PORT) cfg.port = Number(process.env.PORT);
  if (process.env.HOST) cfg.host = process.env.HOST;
  if (process.env.DATA_DIR) cfg.dataDir = process.env.DATA_DIR;
  if (process.env.TRUST_PROXY) cfg.trustProxy = process.env.TRUST_PROXY === 'true' ? 1 : process.env.TRUST_PROXY;
  if (process.env.SECURE_COOKIES) cfg.secureCookies = process.env.SECURE_COOKIES === 'true';
  if (!Number.isInteger(cfg.port) || cfg.port < 1 || cfg.port > 65535) throw new Error(`Некорректный порт: ${cfg.port}`);
  cfg.dataDir = path.resolve(ROOT, cfg.dataDir);
  cfg.configFile = cfgFile;
  cfg.sessionSecret = process.env.SESSION_SECRET || null;
  cfg.adminInitialPassword = process.env.ADMIN_INITIAL_PASSWORD || null;
  cfg.root = ROOT;
  return cfg;
}

module.exports = { loadConfig, ROOT };
