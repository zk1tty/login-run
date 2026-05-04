const fs = require('fs');
const path = require('path');

const PROFILE_ENV_KEYS = Object.freeze([
  'BROWSERLESS_WS_BASE',
  'BROWSERLESS_HTTP_BASE',
  'BROWSERLESS_LOGIN_CONNECT_MODE',
  'BROWSERLESS_CDP_PATH',
  'BROWSERLESS_PROXY',
  'BROWSERLESS_PROXY_COUNTRY',
  'BROWSERLESS_PROXY_CITY',
  'BROWSERLESS_PROXY_STICKY',
  'BROWSERLESS_PROXY_LOCALE_MATCH',
  'BROWSERLESS_PROXY_PRESET',
  'BROWSERLESS_EXTERNAL_PROXY_SERVER',
  'SESSION_API_STEALTH',
  'SESSION_API_BROWSER',
  'BROWSERLESS_UNBLOCK_PATH',
  'BROWSERLESS_UNBLOCK_PROXY',
  'BROWSERLESS_UNBLOCK_PROXY_COUNTRY',
  'BROWSERLESS_UNBLOCK_PROXY_STICKY',
  'UNBLOCK_TTL_MS',
  'BROWSERLESS_REMOTE_PROFILE_ROOT',
  'BROWSERLESS_TIMEOUT_SECONDS',
  'BROWSERLESS_TIMEOUT_MS',
  'LOGIN_ENABLE_PROMPT_FALLBACKS',
  'LIVE_URL_TIMEOUT_MS',
]);

let runtimeTargetInfo = {
  selectedProxy: '',
  applied: false,
  sourcePath: '',
  appliedValues: {},
  error: '',
};

function readTargetsConfig(configPath) {
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw);

  if (!parsed || typeof parsed !== 'object') {
    throw new Error('Invalid browserless target config: expected a JSON object');
  }

  return parsed;
}

function getTargetsConfigPath() {
  const configuredPath = String(process.env.BL_PROXY_CONFIG || '').trim();

  if (configuredPath) {
    return path.resolve(configuredPath);
  }

  return path.resolve(__dirname, '..', '..', 'config', 'browserless-targets.json');
}

function applyBrowserlessTargetConfig() {
  const selectedProxy = String(process.env.BL_PROXY || '').trim();

  runtimeTargetInfo = {
    selectedProxy,
    applied: false,
    sourcePath: '',
    appliedValues: {},
    error: '',
  };

  if (!selectedProxy) {
    return runtimeTargetInfo;
  }

  const sourcePath = getTargetsConfigPath();
  runtimeTargetInfo.sourcePath = sourcePath;

  try {
    const config = readTargetsConfig(sourcePath);
    const targetConfig = config[selectedProxy];

    if (!targetConfig || typeof targetConfig !== 'object') {
      throw new Error(
        `Proxy profile "${selectedProxy}" not found in ${sourcePath}`
      );
    }

    const appliedValues = {};
    for (const key of PROFILE_ENV_KEYS) {
      if (!(key in targetConfig)) {
        continue;
      }

      const value = targetConfig[key];
      const normalizedValue = value == null ? '' : String(value);
      process.env[key] = normalizedValue;
      appliedValues[key] = normalizedValue;
    }

    runtimeTargetInfo.applied = true;
    runtimeTargetInfo.appliedValues = appliedValues;
    return runtimeTargetInfo;
  } catch (error) {
    runtimeTargetInfo.error = error.message;
    throw error;
  }
}

function getBrowserlessTargetRuntimeInfo() {
  return {
    ...runtimeTargetInfo,
    selectedTarget: runtimeTargetInfo.selectedProxy,
    appliedValues: { ...runtimeTargetInfo.appliedValues },
  };
}

module.exports = {
  applyBrowserlessTargetConfig,
  getBrowserlessTargetRuntimeInfo,
};
