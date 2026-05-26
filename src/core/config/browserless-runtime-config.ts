import fs from 'node:fs';
import path from 'node:path';

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
] as const);

type BrowserlessTargetEnvKey = (typeof PROFILE_ENV_KEYS)[number];
type BrowserlessTargetConfig = Record<string, string | number | boolean | null>;

type RuntimeTargetState = {
  selectedProxy: string;
  applied: boolean;
  sourcePath: string;
  appliedValues: Partial<Record<BrowserlessTargetEnvKey, string>>;
  error: string;
};

type BrowserlessTargetRuntimeInfo = RuntimeTargetState & {
  selectedTarget: string;
};

let runtimeTargetInfo: RuntimeTargetState = {
  selectedProxy: '',
  applied: false,
  sourcePath: '',
  appliedValues: {},
  error: '',
};

function readTargetsConfig(configPath: string): Record<string, BrowserlessTargetConfig> {
  const raw = fs.readFileSync(configPath, 'utf8');
  const parsed = JSON.parse(raw);

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('Invalid browserless target config: expected a JSON object');
  }

  return parsed as Record<string, BrowserlessTargetConfig>;
}

function getTargetsConfigPath(): string {
  const configuredPath = String(process.env.BL_PROXY_CONFIG || '').trim();
  if (configuredPath) {
    return path.resolve(configuredPath);
  }

  return path.resolve(__dirname, '..', '..', '..', 'config', 'browserless-targets.json');
}

export function applyBrowserlessTargetConfig(): RuntimeTargetState {
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
      throw new Error(`Proxy profile "${selectedProxy}" not found in ${sourcePath}`);
    }

    const appliedValues: Partial<Record<BrowserlessTargetEnvKey, string>> = {};

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
    runtimeTargetInfo.error = error instanceof Error ? error.message : String(error);
    throw error;
  }
}

export function getBrowserlessTargetRuntimeInfo(): BrowserlessTargetRuntimeInfo {
  return {
    ...runtimeTargetInfo,
    selectedTarget: runtimeTargetInfo.selectedProxy,
    appliedValues: { ...runtimeTargetInfo.appliedValues },
  };
}

function parseBoolean(value: unknown, fallback = false): boolean {
  if (value == null || value === '') {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

export function getBrowserlessTimeoutParam(): string {
  const timeoutSecondsRaw = process.env.BROWSERLESS_TIMEOUT_SECONDS;
  const timeoutMsRaw = process.env.BROWSERLESS_TIMEOUT_MS;

  if (timeoutSecondsRaw != null && timeoutSecondsRaw !== '') {
    const parsed = Math.trunc(Number(timeoutSecondsRaw));
    return Number.isFinite(parsed) && parsed > 0 ? String(parsed) : '';
  }

  if (timeoutMsRaw == null || timeoutMsRaw === '') {
    return '';
  }

  const parsed = Number(timeoutMsRaw);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return '';
  }

  return String(Math.trunc(parsed));
}

function appendPathname(basePath: string | undefined, routePath: string | undefined): string {
  const normalizedBase = basePath === '/' ? '' : String(basePath || '').replace(/\/$/, '');
  const normalizedRoute = String(routePath || '').startsWith('/') ? String(routePath || '') : `/${routePath || ''}`;
  return `${normalizedBase}${normalizedRoute}`;
}

function appendConnectionParams(urlString: string, params: Record<string, unknown> = {}): string {
  const url = new URL(urlString);
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === '') {
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function withBrowserlessQueryParams(urlString: string): string {
  const url = new URL(urlString);
  const token = process.env.BROWSERLESS_TOKEN;
  const timeout = getBrowserlessTimeoutParam();
  const proxy = String(process.env.BROWSERLESS_PROXY || '').trim();
  const proxyCountry = String(process.env.BROWSERLESS_PROXY_COUNTRY || '').trim();
  const proxyCity = String(process.env.BROWSERLESS_PROXY_CITY || '').trim();
  const proxyPreset = String(process.env.BROWSERLESS_PROXY_PRESET || '').trim();
  const externalProxyServer = String(process.env.BROWSERLESS_EXTERNAL_PROXY_SERVER || '').trim();
  const proxyStickyRaw = process.env.BROWSERLESS_PROXY_STICKY;
  const proxyLocaleMatchRaw = process.env.BROWSERLESS_PROXY_LOCALE_MATCH;
  const launch = buildLaunchOptions();

  if (token) {
    url.searchParams.set('token', token);
  }

  if (timeout) {
    url.searchParams.set('timeout', timeout);
  }

  if (launch) {
    url.searchParams.set('launch', JSON.stringify(launch));
  }

  if (proxy) {
    url.searchParams.set('proxy', proxy);
  }

  if (proxyCountry) {
    url.searchParams.set('proxyCountry', proxyCountry);
  }

  if (proxyCity) {
    url.searchParams.set('proxyCity', proxyCity);
  }

  if (proxyPreset) {
    url.searchParams.set('proxyPreset', proxyPreset);
  }

  if (externalProxyServer) {
    url.searchParams.set('externalProxyServer', externalProxyServer);
  }

  if (proxyStickyRaw != null && proxyStickyRaw !== '') {
    url.searchParams.set('proxySticky', String(parseBoolean(proxyStickyRaw, false)));
  }

  if (proxyLocaleMatchRaw != null && proxyLocaleMatchRaw !== '') {
    url.searchParams.set('proxyLocaleMatch', String(parseBoolean(proxyLocaleMatchRaw, false)));
  }

  return url.toString();
}

function buildEndpoint(base: string, routePath?: string): string {
  if (!routePath || String(routePath).trim() === '' || String(routePath).trim() === '/') {
    return withBrowserlessQueryParams(base);
  }

  const url = new URL(base);
  url.pathname = appendPathname(url.pathname, routePath);
  return withBrowserlessQueryParams(url.toString());
}

function getDefaultCdpRoute(base: string): string {
  const host = new URL(base).hostname.toLowerCase();
  return host.endsWith('browserless.io') ? '' : '/chromium';
}

function buildLaunchOptions(): Record<string, unknown> | null {
  const launch: Record<string, unknown> = {};
  const args: string[] = [];
  const remoteUserDataDir = process.env.BROWSERLESS_REMOTE_USER_DATA_DIR;
  const chromiumArgsRaw = process.env.BROWSERLESS_CHROMIUM_ARGS;

  if (remoteUserDataDir) {
    args.push(`--user-data-dir=${remoteUserDataDir}`);
  }

  if (chromiumArgsRaw) {
    const raw = String(chromiumArgsRaw).trim();
    if (raw) {
      if (raw.startsWith('[')) {
        try {
          const parsed = JSON.parse(raw);
          if (Array.isArray(parsed)) {
            for (const value of parsed) {
              const arg = String(value || '').trim();
              if (arg) {
                args.push(arg);
              }
            }
          }
        } catch {
          const fallbackArgs = raw.split(/[,\s]+/).filter(Boolean);
          args.push(...fallbackArgs);
        }
      } else {
        const fallbackArgs = raw.split(/[,\s]+/).filter(Boolean);
        args.push(...fallbackArgs);
      }
    }
  }

  if (process.env.BROWSERLESS_HEADLESS != null && process.env.BROWSERLESS_HEADLESS !== '') {
    launch.headless = parseBoolean(process.env.BROWSERLESS_HEADLESS, true);
  }

  if (process.env.BROWSERLESS_STEALTH != null && process.env.BROWSERLESS_STEALTH !== '') {
    launch.stealth = parseBoolean(process.env.BROWSERLESS_STEALTH, false);
  }

  if (args.length > 0) {
    launch.args = args;
  }

  return Object.keys(launch).length > 0 ? launch : null;
}

export function getCdpEndpoint(): string {
  const base = process.env.BROWSERLESS_WS_BASE || 'ws://127.0.0.1:3000';
  const cdpPath = process.env.BROWSERLESS_CDP_PATH;
  const route = cdpPath == null ? getDefaultCdpRoute(base) : String(cdpPath).trim();

  return buildEndpoint(base, route);
}

export function getHttpBase(): string {
  return process.env.BROWSERLESS_HTTP_BASE || 'http://127.0.0.1:3000';
}

export function buildBrowserlessConnectEndpoint(connectUrl: string, input: { solveMode?: string; timeout?: string | number | null; replay?: boolean } = {}): string {
  const solveMode = String(input.solveMode || 'manual').trim().toLowerCase();
  if (!['manual', 'auto', 'none'].includes(solveMode)) {
    throw new Error('solveMode must be manual, auto, or none.');
  }
  const params: Record<string, unknown> = {
    timeout: input.timeout,
  };
  if (solveMode === 'auto') {
    params.solveCaptchas = 'true';
  }
  if (input.replay === true) {
    params.replay = 'true';
  }
  return appendConnectionParams(connectUrl, params);
}

applyBrowserlessTargetConfig();

export default {
  applyBrowserlessTargetConfig,
  getBrowserlessTargetRuntimeInfo,
  getBrowserlessTimeoutParam,
  getCdpEndpoint,
  getHttpBase,
  buildBrowserlessConnectEndpoint,
};
