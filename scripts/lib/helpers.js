require('dotenv').config();
const {
  applyBrowserlessTargetConfig,
  getBrowserlessTargetRuntimeInfo,
} = require('./runtime-target-config');
applyBrowserlessTargetConfig();

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

function parseBoolean(value, fallback = false) {
  if (value == null || value === '') {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function getBrowserlessTimeoutParam() {
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

  // Pass through timeout values as-is so callers can match the exact
  // Browserless deployment semantics (cloud plans can differ).
  return String(Math.trunc(parsed));
}

function appendPathname(basePath, routePath) {
  const normalizedBase = basePath === '/' ? '' : basePath.replace(/\/$/, '');
  const normalizedRoute = routePath.startsWith('/') ? routePath : `/${routePath}`;
  return `${normalizedBase}${normalizedRoute}`;
}

function buildLaunchOptions() {
  const launch = {};
  const args = [];
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
        } catch (error) {
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

function withBrowserlessQueryParams(urlString) {
  const url = new URL(urlString);
  const token = process.env.BROWSERLESS_TOKEN;
  const timeout = getBrowserlessTimeoutParam();
  const launch = buildLaunchOptions();
  const proxy = String(process.env.BROWSERLESS_PROXY || '').trim();
  const proxyCountry = String(process.env.BROWSERLESS_PROXY_COUNTRY || '').trim();
  const proxyCity = String(process.env.BROWSERLESS_PROXY_CITY || '').trim();
  const proxyPreset = String(process.env.BROWSERLESS_PROXY_PRESET || '').trim();
  const externalProxyServer = String(process.env.BROWSERLESS_EXTERNAL_PROXY_SERVER || '').trim();
  const proxyStickyRaw = process.env.BROWSERLESS_PROXY_STICKY;
  const proxyLocaleMatchRaw = process.env.BROWSERLESS_PROXY_LOCALE_MATCH;

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
    url.searchParams.set(
      'proxySticky',
      String(parseBoolean(proxyStickyRaw, false))
    );
  }

  if (proxyLocaleMatchRaw != null && proxyLocaleMatchRaw !== '') {
    url.searchParams.set(
      'proxyLocaleMatch',
      String(parseBoolean(proxyLocaleMatchRaw, false))
    );
  }

  return url.toString();
}

function buildEndpoint(base, routePath) {
  if (!routePath || String(routePath).trim() === '' || String(routePath).trim() === '/') {
    return withBrowserlessQueryParams(base);
  }

  const url = new URL(base);
  url.pathname = appendPathname(url.pathname, routePath);
  return withBrowserlessQueryParams(url.toString());
}

function withBrowserlessHttpAuthParams(urlString) {
  const url = new URL(urlString);
  const token = process.env.BROWSERLESS_TOKEN;

  if (token) {
    url.searchParams.set('token', token);
  }

  return url.toString();
}

function getDefaultCdpRoute(base) {
  const host = new URL(base).hostname.toLowerCase();
  return host.endsWith('browserless.io') ? '' : '/chromium';
}

function getCdpEndpoint() {
  const base = process.env.BROWSERLESS_WS_BASE || 'ws://127.0.0.1:3000';
  const cdpPath = process.env.BROWSERLESS_CDP_PATH;
  const route = cdpPath == null ? getDefaultCdpRoute(base) : String(cdpPath).trim();
  return buildEndpoint(base, route);
}

function getPlaywrightEndpoint() {
  const base = process.env.BROWSERLESS_WS_BASE || 'ws://127.0.0.1:3000';
  return buildEndpoint(base, '/chromium/playwright');
}

function getHttpVersionEndpoint() {
  const base = process.env.BROWSERLESS_HTTP_BASE || 'http://127.0.0.1:3000';
  const url = new URL(base);
  url.pathname = appendPathname(url.pathname, '/json/version');
  return withBrowserlessHttpAuthParams(url.toString());
}

function getTestUrl() {
  return process.env.URL || 'https://example.com';
}

function getAuthBootstrapUrl() {
  return process.env.AUTH_BOOTSTRAP_URL || 'https://www.linkedin.com/feed/';
}

function getStorageStatePath() {
  return path.resolve(process.env.STORAGE_STATE_PATH || process.env.EXPORT_STATE_PATH || '.auth/storage-state.json');
}

function getCookiesPath() {
  return path.resolve(process.env.COOKIES_PATH || '.auth/cookies.json');
}

function normalizeCustomerId(customerId) {
  const value = String(customerId || '').trim();

  if (!value) {
    throw new Error('CUSTOMER_ID is required.');
  }

  if (!/^[A-Za-z0-9._-]+$/.test(value)) {
    throw new Error(
      'CUSTOMER_ID may only contain letters, numbers, ".", "_", and "-".'
    );
  }

  return value;
}

function getCustomerId() {
  return normalizeCustomerId(process.env.CUSTOMER_ID);
}

function getAuthArtifactsRoot() {
  return path.resolve(process.env.AUTH_ARTIFACTS_ROOT || '.auth');
}

function getBrowserProfileRoot() {
  return path.resolve(
    process.env.BROWSERLESS_REMOTE_PROFILE_ROOT ||
      process.env.LOCAL_PROFILE_ROOT ||
      './profiles'
  );
}

function getRawBrowserProfileRoot() {
  return (
    process.env.BROWSERLESS_REMOTE_PROFILE_ROOT ||
    process.env.LOCAL_PROFILE_ROOT ||
    './profiles'
  );
}

function getCustomerAuthDir(customerId = getCustomerId()) {
  return path.resolve(getAuthArtifactsRoot(), normalizeCustomerId(customerId));
}

function getCustomerStorageStatePath(customerId = getCustomerId()) {
  return path.resolve(getCustomerAuthDir(customerId), 'storage-state.json');
}

function getCustomerCookiesPath(customerId = getCustomerId()) {
  return path.resolve(getCustomerAuthDir(customerId), 'cookies.json');
}

function getCustomerRunSummaryPath(customerId = getCustomerId(), filename = 'run-summary.json') {
  return path.resolve(getCustomerAuthDir(customerId), filename);
}

function getCustomerBrowserProfileDir(customerId = getCustomerId()) {
  return path.resolve(getBrowserProfileRoot(), normalizeCustomerId(customerId));
}

function getCustomerPaths(customerId = getCustomerId()) {
  const normalizedCustomerId = normalizeCustomerId(customerId);

  return {
    customerId: normalizedCustomerId,
    authDir: getCustomerAuthDir(normalizedCustomerId),
    storageStatePath: getCustomerStorageStatePath(normalizedCustomerId),
    cookiesPath: getCustomerCookiesPath(normalizedCustomerId),
    browserProfileDir: getCustomerBrowserProfileDir(normalizedCustomerId),
    runSummaryPath: getCustomerRunSummaryPath(normalizedCustomerId),
  };
}

function isDockerBrowserlessRunning() {
  try {
    const output = execFileSync(
      'docker',
      ['ps', '--filter', 'name=^/browserless$', '--format', '{{.ID}}'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    ).trim();

    return output !== '';
  } catch (error) {
    return false;
  }
}

function getDockerBrowserlessMounts() {
  try {
    const output = execFileSync(
      'docker',
      ['inspect', 'browserless', '--format', '{{json .Mounts}}'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    ).trim();

    if (!output) {
      return [];
    }

    const mounts = JSON.parse(output);
    return Array.isArray(mounts) ? mounts : [];
  } catch (error) {
    return [];
  }
}

function resolveHostPathForBrowserlessPath(browserlessPath) {
  const normalizedPath = String(browserlessPath || '').trim();

  if (!normalizedPath) {
    return '';
  }

  const mounts = getDockerBrowserlessMounts();

  for (const mount of mounts) {
    const destination = String(mount?.Destination || '').trim();
    const source = String(mount?.Source || '').trim();

    if (!destination || !source) {
      continue;
    }

    if (normalizedPath === destination) {
      return source;
    }

    if (normalizedPath.startsWith(`${destination}/`)) {
      const relativeSuffix = normalizedPath.slice(destination.length + 1);
      return path.resolve(source, relativeSuffix);
    }
  }

  return normalizedPath;
}

function validateBrowserProfileRootForRuntime() {
  const rawProfileRoot = getRawBrowserProfileRoot();

  if (!rawProfileRoot || path.isAbsolute(rawProfileRoot)) {
    return;
  }

  if (!isDockerBrowserlessRunning()) {
    return;
  }

  throw new Error(
    [
      `BROWSERLESS_REMOTE_PROFILE_ROOT=${rawProfileRoot} is a relative path, but Browserless is running in Docker.`,
      'Use an absolute in-container path for the mounted profile volume, for example BROWSERLESS_REMOTE_PROFILE_ROOT=/profiles.',
    ].join(' ')
  );
}

function getLocalProfileDir() {
  return path.resolve(process.env.LOCAL_BROWSER_PROFILE_DIR || '.pw-user-data');
}

function getLocalPersistentLaunchOptions() {
  const options = {
    headless: parseBoolean(process.env.LOCAL_HEADLESS, false),
  };
  const executablePath = process.env.LOCAL_CHROMIUM_EXECUTABLE_PATH;
  const channel = process.env.LOCAL_CHROMIUM_CHANNEL || 'chrome';

  if (executablePath) {
    options.executablePath = executablePath;
  } else if (channel) {
    options.channel = channel;
  }

  return options;
}

function getBootstrapWaitMs() {
  const value = Number(process.env.AUTH_BOOTSTRAP_WAIT_MS || 0);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function shouldWaitForManualConfirmation() {
  if (process.env.AUTH_BOOTSTRAP_WAIT_FOR_ENTER == null || process.env.AUTH_BOOTSTRAP_WAIT_FOR_ENTER === '') {
    return true;
  }

  return parseBoolean(process.env.AUTH_BOOTSTRAP_WAIT_FOR_ENTER, true);
}

function getBootstrapReadySelector() {
  return process.env.AUTH_BOOTSTRAP_READY_SELECTOR || '';
}

function getBootstrapReadyTimeoutMs() {
  const value = Number(process.env.AUTH_BOOTSTRAP_READY_TIMEOUT_MS || 30000);
  return Number.isFinite(value) && value >= 0 ? value : 30000;
}

function getBootstrapRenderWaitMs() {
  const value = Number(process.env.AUTH_BOOTSTRAP_RENDER_WAIT_MS || 1500);
  return Number.isFinite(value) && value >= 0 ? value : 1500;
}

function getSessionKeepAliveMs() {
  const value = Number(process.env.SESSION_KEEP_ALIVE_MS || 0);
  return Number.isFinite(value) && value >= 0 ? value : 0;
}

function getSessionsViewerUrl() {
  const base = process.env.BROWSERLESS_HTTP_BASE || 'http://127.0.0.1:3000';
  const url = new URL(base);
  url.pathname = appendPathname(url.pathname, '/sessions');
  return withBrowserlessHttpAuthParams(url.toString());
}

function getSessionsApiUrl() {
  return getSessionsViewerUrl();
}

function getJsonListUrl() {
  const base = process.env.BROWSERLESS_HTTP_BASE || 'http://127.0.0.1:3000';
  const url = new URL(base);
  url.pathname = appendPathname(url.pathname, '/json/list');
  return withBrowserlessHttpAuthParams(url.toString());
}

function getUnblockApiUrl() {
  const base = process.env.BROWSERLESS_HTTP_BASE || 'http://127.0.0.1:3000';
  const routePath = process.env.BROWSERLESS_UNBLOCK_PATH || '/unblock';
  const url = new URL(base);
  const token = process.env.BROWSERLESS_TOKEN;
  const timeout = getBrowserlessTimeoutParam();
  const proxy = String(process.env.BROWSERLESS_UNBLOCK_PROXY || '').trim();
  const proxyCountry = String(process.env.BROWSERLESS_UNBLOCK_PROXY_COUNTRY || '').trim();
  const proxyStickyRaw = process.env.BROWSERLESS_UNBLOCK_PROXY_STICKY;

  url.pathname = appendPathname(url.pathname, routePath);

  if (token) {
    url.searchParams.set('token', token);
  }

  if (timeout) {
    url.searchParams.set('timeout', timeout);
  }

  if (proxy) {
    url.searchParams.set('proxy', proxy);
  }

  if (proxyCountry) {
    url.searchParams.set('proxyCountry', proxyCountry);
  }

  if (proxyStickyRaw != null && proxyStickyRaw !== '') {
    url.searchParams.set(
      'proxySticky',
      String(parseBoolean(proxyStickyRaw, false))
    );
  }

  return url.toString();
}

function getHttpBase() {
  return process.env.BROWSERLESS_HTTP_BASE || 'http://127.0.0.1:3000';
}

function getWsBase() {
  return process.env.BROWSERLESS_WS_BASE || 'ws://127.0.0.1:3000';
}

function getLiveUrlOptions() {
  const options = {};
  const timeout = process.env.LIVE_URL_TIMEOUT_MS;
  const quality = process.env.LIVE_URL_QUALITY;
  const type = process.env.LIVE_URL_TYPE;

  if (timeout) {
    options.timeout = Number(timeout);
  }

  if (quality) {
    options.quality = Number(quality);
  }

  if (type) {
    options.type = type;
  }

  if (process.env.LIVE_URL_INTERACTIVE != null && process.env.LIVE_URL_INTERACTIVE !== '') {
    options.interactive = parseBoolean(process.env.LIVE_URL_INTERACTIVE, true);
  }

  if (process.env.LIVE_URL_RESIZABLE != null && process.env.LIVE_URL_RESIZABLE !== '') {
    options.resizable = parseBoolean(process.env.LIVE_URL_RESIZABLE, true);
  }

  if (process.env.LIVE_URL_SHOW_BROWSER_INTERFACE != null && process.env.LIVE_URL_SHOW_BROWSER_INTERFACE !== '') {
    options.showBrowserInterface = parseBoolean(process.env.LIVE_URL_SHOW_BROWSER_INTERFACE, false);
  }

  if (process.env.LIVE_URL_COMPRESSED != null && process.env.LIVE_URL_COMPRESSED !== '') {
    options.compressed = parseBoolean(process.env.LIVE_URL_COMPRESSED, true);
  }

  if (process.env.LIVE_URL_EMULATE_COMPONENTS != null && process.env.LIVE_URL_EMULATE_COMPONENTS !== '') {
    options.emulateComponents = parseBoolean(process.env.LIVE_URL_EMULATE_COMPONENTS, true);
  }

  return options;
}

function getLiveUrlKeepAliveMs() {
  const value = Number(process.env.LIVE_URL_KEEP_ALIVE_MS || 0);
  return Number.isFinite(value) && value >= 0 ? Math.trunc(value) : 0;
}

function normalizeWsUrl(urlString) {
  const raw = String(urlString || '').trim();
  if (!raw) {
    return '';
  }

  try {
    const withScheme = /^[a-z]+:\/\//i.test(raw)
      ? raw
      : raw.startsWith('//')
        ? `ws:${raw}`
        : `ws://${raw}`;
    const url = new URL(withScheme);

    if (url.hostname === '0.0.0.0') {
      const wsBase = new URL(getWsBase());
      url.hostname = wsBase.hostname;
      if (!url.port && wsBase.port) {
        url.port = wsBase.port;
      }
    }

    return url.toString();
  } catch (error) {
    return '';
  }
}

function normalizeDevtoolsFrontendUrl(urlString) {
  const raw = String(urlString || '').trim();
  if (!raw) {
    return '';
  }

  try {
    const absolute = new URL(raw, getHttpBase());
    const wsValue = String(absolute.searchParams.get('ws') || '').trim();

    if (wsValue) {
      const normalizedWs = normalizeWsUrl(
        wsValue.startsWith('ws://') || wsValue.startsWith('wss://')
          ? wsValue
          : `ws://${wsValue}`
      );

      if (normalizedWs) {
        const wsUrl = new URL(normalizedWs);
        absolute.searchParams.set('ws', `${wsUrl.host}${wsUrl.pathname}${wsUrl.search}`);
      }
    }

    if (absolute.hostname === '0.0.0.0') {
      const httpBase = new URL(getHttpBase());
      absolute.protocol = httpBase.protocol;
      absolute.hostname = httpBase.hostname;
      if (httpBase.port) {
        absolute.port = httpBase.port;
      }
    }

    return absolute.toString();
  } catch (error) {
    return '';
  }
}

async function fetchJson(urlString, options = {}) {
  const response = await fetch(urlString, options);

  if (!response.ok) {
    throw new Error(`Request failed: HTTP ${response.status} (${urlString})`);
  }

  return response.json();
}

function getHostedDevtoolsFrontendUrl(debuggerVersion, pageWebSocketDebuggerUrl) {
  if (!debuggerVersion || !pageWebSocketDebuggerUrl) {
    return '';
  }

  const normalizedDebuggerVersion = String(debuggerVersion).replace(/^@+/, '');

  if (!normalizedDebuggerVersion) {
    return '';
  }

  const wsUrl = new URL(pageWebSocketDebuggerUrl);
  const wsTarget = `${wsUrl.host}${wsUrl.pathname}${wsUrl.search}`;
  const encodedWsTarget = encodeURIComponent(wsTarget);
  return `https://chrome-devtools-frontend.appspot.com/serve_rev/@${normalizedDebuggerVersion}/inspector.html?ws=${encodedWsTarget}`;
}

function stripSessionConnectPath(pathname) {
  const rawPath = String(pathname || '').trim();
  if (!rawPath) {
    return '/';
  }

  const matched = rawPath.match(/^(.*)\/session\/connect\/[^/]+\/?$/i);
  if (!matched) {
    return rawPath;
  }

  return matched[1] || '/';
}

function buildPageDebuggerWsUrl(targetId, browserWSEndpoint) {
  if (!targetId) {
    return '';
  }

  const preferredBase = String(browserWSEndpoint || '').trim();
  let wsBase = null;

  if (preferredBase) {
    try {
      wsBase = new URL(preferredBase);
      wsBase.pathname = stripSessionConnectPath(wsBase.pathname);
    } catch (error) {
      wsBase = null;
    }
  }

  if (!wsBase) {
    wsBase = new URL(getWsBase());
  }

  wsBase.pathname = appendPathname(wsBase.pathname, `/devtools/page/${targetId}`);
  wsBase.search = '';
  return wsBase.toString();
}

function readJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function hasDirectoryEntries(dirPath) {
  return fs.existsSync(dirPath) && fs.readdirSync(dirPath).length > 0;
}

function loadAuthStateFromPaths(
  storageStatePath = getStorageStatePath(),
  cookiesPath = getCookiesPath()
) {
  const storageState = readJsonIfExists(storageStatePath);

  if (storageState) {
    return {
      state: storageState,
      sourcePath: storageStatePath,
      sourceType: 'storageState',
    };
  }

  const cookies = readJsonIfExists(cookiesPath);

  if (cookies) {
    return {
      state: {
        cookies,
        origins: [],
      },
      sourcePath: cookiesPath,
      sourceType: 'cookies',
    };
  }

  return null;
}

function loadAuthState() {
  return loadAuthStateFromPaths(getStorageStatePath(), getCookiesPath());
}

async function primeContextFromAuthState(context, authState) {
  if (!authState) {
    return false;
  }

  if (Array.isArray(authState.cookies) && authState.cookies.length > 0) {
    await context.addCookies(authState.cookies);
  }

  if (Array.isArray(authState.origins) && authState.origins.length > 0) {
    await context.addInitScript(origins => {
      const currentOrigin = origins.find(entry => entry.origin === window.location.origin);
      if (!currentOrigin || !Array.isArray(currentOrigin.localStorage)) {
        return;
      }

      for (const item of currentOrigin.localStorage) {
        window.localStorage.setItem(item.name, item.value);
      }
    }, authState.origins);
  }

  return true;
}

async function writeAuthFiles(context, options = {}) {
  const storageStatePath = path.resolve(
    options.storageStatePath || getStorageStatePath()
  );
  const cookiesPath = path.resolve(options.cookiesPath || getCookiesPath());

  fs.mkdirSync(path.dirname(storageStatePath), { recursive: true });
  fs.mkdirSync(path.dirname(cookiesPath), { recursive: true });

  const storageState = await context.storageState({
    path: storageStatePath,
    indexedDB: true,
  });

  fs.writeFileSync(cookiesPath, JSON.stringify(storageState.cookies, null, 2));

  return {
    storageState,
    storageStatePath,
    cookiesPath,
  };
}

async function waitForPageReady(page, options = {}) {
  const timeout = options.timeout ?? getBootstrapReadyTimeoutMs();
  const selector = options.selector ?? getBootstrapReadySelector();
  const renderWaitMs = options.renderWaitMs ?? getBootstrapRenderWaitMs();

  await page.waitForLoadState('domcontentloaded', { timeout });
  await page.waitForLoadState('load', { timeout });

  try {
    await page.waitForLoadState('networkidle', { timeout: Math.min(timeout, 10000) });
  } catch (error) {
    // Modern apps often keep background requests open, so treat this as best effort.
  }

  if (selector) {
    await page.waitForSelector(selector, { state: 'visible', timeout });
  }

  await page.waitForFunction(() => document.readyState === 'complete', null, { timeout });

  await page.evaluate(async () => {
    if (document.fonts && document.fonts.ready) {
      await document.fonts.ready;
    }

    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  });

  if (renderWaitMs > 0) {
    await page.waitForTimeout(renderWaitMs);
  }
}

module.exports = {
  getBrowserlessTargetRuntimeInfo,
  getAuthBootstrapUrl,
  getAuthArtifactsRoot,
  getDockerBrowserlessMounts,
  getRawBrowserProfileRoot,
  getBootstrapReadySelector,
  getBootstrapReadyTimeoutMs,
  getBootstrapRenderWaitMs,
  getBootstrapWaitMs,
  shouldWaitForManualConfirmation,
  getCdpEndpoint,
  getCookiesPath,
  getCustomerAuthDir,
  getCustomerBrowserProfileDir,
  getCustomerCookiesPath,
  getCustomerId,
  getCustomerPaths,
  getCustomerRunSummaryPath,
  getCustomerStorageStatePath,
  fetchJson,
  buildPageDebuggerWsUrl,
  getBrowserProfileRoot,
  getHttpBase,
  getHttpVersionEndpoint,
  getHostedDevtoolsFrontendUrl,
  getJsonListUrl,
  getUnblockApiUrl,
  getLocalPersistentLaunchOptions,
  getLocalProfileDir,
  getLiveUrlKeepAliveMs,
  getLiveUrlOptions,
  getPlaywrightEndpoint,
  getSessionKeepAliveMs,
  getSessionsApiUrl,
  getSessionsViewerUrl,
  getStorageStatePath,
  getTestUrl,
  getWsBase,
  hasDirectoryEntries,
  isDockerBrowserlessRunning,
  loadAuthState,
  loadAuthStateFromPaths,
  normalizeDevtoolsFrontendUrl,
  normalizeWsUrl,
  primeContextFromAuthState,
  readJsonIfExists,
  resolveHostPathForBrowserlessPath,
  writeJsonFile,
  validateBrowserProfileRootForRuntime,
  waitForPageReady,
  writeAuthFiles,
};
