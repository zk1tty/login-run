import type {
  BrowserlessConnectOptions,
  BrowserlessCreateInput,
  BrowserlessPayload,
  BrowserlessSessionPayload,
  BrowserlessSessionRecord,
  BrowserlessSessionShape,
  BrowserlessStopOptions,
} from './types';

type BuildSessionPayloadInput = Pick<
  BrowserlessCreateInput,
  | 'ttlMs'
  | 'processKeepAliveMs'
  | 'stealth'
  | 'browser'
  | 'proxyOverride'
  | 'rawPayload'
  | 'ttl'
  | 'stealthMode'
>;

type BuildInput = Pick<
  BrowserlessCreateInput,
  'httpBase' | 'token'
> & Pick<
  BrowserlessConnectOptions,
  'solveMode' | 'timeout' | 'replay'
>;

const { getHttpBase } = require('../config/browserless-runtime-config');
const fetchImpl = (globalThis as any).fetch as ((url: string, init?: any) => Promise<any>) | undefined;
const UrlCtor = (globalThis as any).URL as {
  new (value: string): {
    toString(): string;
    pathname: string;
    searchParams: {
      set: (key: string, value: string) => void;
      has: (key: string) => boolean;
    };
  };
};
const delay = (globalThis as any).setTimeout as ((cb: (...args: any[]) => void, timeout?: number) => void) | undefined;

function getBrowserlessEnv(key: string): string {
  return String(((((globalThis as any).process && (globalThis as any).process.env) || {})[key] || '')).trim();
}

const DEFAULT_SESSION_TTL_MS = 180000;

function toBool(value: unknown, fallback = false): boolean {
  if (value == null || value === '') {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function toInt(value: unknown, fallback: number, minimum = 0): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(minimum, Math.trunc(parsed));
}

function appendPathname(basePath: string | undefined, routePath: string | undefined): string {
  const normalizedBase = basePath === '/' ? '' : String(basePath || '').replace(/\/$/, '');
  const normalizedRoute = String(routePath || '').startsWith('/')
    ? String(routePath)
    : `/${routePath || ''}`;
  return `${normalizedBase}${normalizedRoute}`;
}

function redactUrlSecretParams(urlString: string | null | undefined): string {
  try {
    const url = new UrlCtor(String(urlString || ''));
    for (const key of ['token', 'apiKey', 'apikey', 'key']) {
      if (url.searchParams.has(key)) {
        url.searchParams.set(key, '[redacted]');
      }
    }
    return url
      .toString()
      .replace(/\/e\/[^/]+/i, '/e/[redacted]')
      .replace(/\/session\/connect\/[^/?#]+/i, '/session/connect/[redacted]');
  } catch {
    return String(urlString || '')
      .replace(/([?&](?:token|apiKey|apikey|key)=)[^&]+/gi, '$1[redacted]')
      .replace(/\/e\/[^/]+/i, '/e/[redacted]')
      .replace(/\/session\/connect\/[^/?#]+/i, '/session/connect/[redacted]');
  }
}

function appendConnectionParams(connectUrl: string, params: Record<string, unknown> = {}): string {
  const url = new UrlCtor(String(connectUrl || ''));
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === '') {
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function normalizeSolveMode(value: string | undefined | null = 'manual'): BrowserlessConnectOptions['solveMode'] {
  const mode = String(value || 'manual').trim().toLowerCase();
  if (mode === 'manual' || mode === 'auto' || mode === 'none') {
    return mode;
  }
  throw new Error('solveMode must be manual, auto, or none.');
}

function buildConnectEndpoint(connectUrl: string, input: BrowserlessConnectOptions = {}): string {
  const solveMode = normalizeSolveMode(input.solveMode);
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

function buildSessionApiUrl(input: BuildInput = {}): string {
  const base = String(input.httpBase || getHttpBase()).trim();
  const token = String(input.token || getBrowserlessEnv('BROWSERLESS_TOKEN')).trim();
  const url = new UrlCtor(base);
  url.pathname = appendPathname(url.pathname, '/session');
  if (token) {
    url.searchParams.set('token', token);
  }
  return url.toString();
}

function proxyValueFromEnv() {
  const proxy = String(getBrowserlessEnv('BROWSERLESS_PROXY') || '').trim();
  if (!proxy) {
    return null;
  }

  const proxyValue: {
    type: string;
    country?: string;
    city?: string;
    preset?: string;
    sticky?: boolean;
  } = { type: proxy };

  const country = String(getBrowserlessEnv('BROWSERLESS_PROXY_COUNTRY') || '').trim();
  const city = String(getBrowserlessEnv('BROWSERLESS_PROXY_CITY') || '').trim();
  const preset = String(getBrowserlessEnv('BROWSERLESS_PROXY_PRESET') || '').trim();
  if (country) proxyValue.country = country;
  if (city) proxyValue.city = city;
  if (preset) proxyValue.preset = preset;
  const proxySticky = getBrowserlessEnv('BROWSERLESS_PROXY_STICKY');
  if (proxySticky != null && proxySticky !== '') {
    proxyValue.sticky = toBool(proxySticky, false);
  }
  return proxyValue;
}

function buildSessionPayload(input: BuildSessionPayloadInput = {}): BrowserlessPayload {
  const rawOverride = String(input.rawPayload || getBrowserlessEnv('SESSION_API_PAYLOAD_JSON')).trim();
  if (rawOverride) {
    return JSON.parse(rawOverride);
  }

  const payload: BrowserlessPayload = {
    ttl: toInt(
      input.ttlMs || getBrowserlessEnv('SESSION_API_TTL_MS'),
      DEFAULT_SESSION_TTL_MS,
      1000,
    ),
    stealth: toBool(
      input.stealth ?? getBrowserlessEnv('SESSION_API_STEALTH'),
      true,
    ),
  };

  const processKeepAlive = toInt(
    input.processKeepAliveMs ?? getBrowserlessEnv('SESSION_API_PROCESS_KEEP_ALIVE_MS'),
    0,
    0,
  );
  if (processKeepAlive > 0) {
    payload.processKeepAlive = processKeepAlive;
  }

  const browser = String(input.browser || getBrowserlessEnv('SESSION_API_BROWSER')).trim();
  if (browser) payload.browser = browser;

  const proxy = input.proxyOverride || proxyValueFromEnv();
  if (proxy) payload.proxy = proxy;

  return payload;
}

function normalizeSessionPayload(
  payload: BrowserlessSessionShape | Record<string, unknown> = {},
  defaults: Pick<BrowserlessSessionPayload, 'ttlMs' | 'processKeepAliveMs'> = { ttlMs: 0, processKeepAliveMs: 0 },
): BrowserlessSessionPayload {
  const raw =
    payload && typeof payload === 'object' && 'session' in payload
      ? (payload as { session?: Record<string, unknown> }).session || payload
      : payload;

  const rawRecord = (raw && typeof raw === 'object') ? (raw as Record<string, unknown>) : {};

  return {
    id: String(rawRecord.id || rawRecord.sessionId || '').trim(),
    connect: String(
      rawRecord.connect ||
        rawRecord.connectUrl ||
        rawRecord.connectURL ||
        (rawRecord as { wsEndpoint?: unknown }).wsEndpoint ||
        (rawRecord as { browserWSEndpoint?: unknown }).browserWSEndpoint ||
        '',
    ).trim(),
    stop: String(
      rawRecord.stop ||
        (rawRecord as { stopUrl?: unknown }).stopUrl ||
        (rawRecord as { stopURL?: unknown }).stopURL ||
        (rawRecord as { killURL?: unknown }).killURL ||
        '',
    ).trim(),
    ttlMs: toInt(rawRecord.ttl || rawRecord.ttlMs, defaults.ttlMs, 0),
    processKeepAliveMs: toInt(
      rawRecord.processKeepAlive || rawRecord.processKeepAliveMs,
      defaults.processKeepAliveMs,
      0,
    ),
  };
}

async function stopBrowserlessSession(stopUrl: string, input: BrowserlessStopOptions = {}): Promise<void> {
  if (!fetchImpl) {
    throw new Error('Global fetch is not available in this runtime.');
  }
  const maxAttempts = toInt(input.maxAttempts, 5, 1);
  const delayMs = toInt(input.delayMs, 1000, 0);
  const url = appendConnectionParams(stopUrl, { force: 'true' });
  let lastError = '';

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetchImpl(url, { method: 'DELETE' });
    if (response?.ok) {
      return;
    }
    const raw = await response.text().catch(() => '');
    lastError = `Session stop failed: HTTP ${response.status} ${raw}`;
    if (!/ENOTEMPTY|directory not empty/i.test(raw) || attempt === maxAttempts) {
      break;
    }
    if (delay) {
      await new Promise(resolve => delay(resolve, delayMs * attempt));
    }
  }
  throw new Error(lastError || 'Session stop failed with unknown error.');
}

class BrowserlessSession {
  sessionApiUrl: string;
  payload: BrowserlessPayload;
  session: BrowserlessSessionPayload;
  rawResponse: unknown;

  constructor(input: BrowserlessSessionRecord | {
    sessionApiUrl?: string;
    payload?: BrowserlessPayload;
    session?: BrowserlessSessionShape | Record<string, unknown>;
    rawResponse?: unknown;
  } = {}) {
    const init = input || {};
    this.sessionApiUrl = String(init.sessionApiUrl || '');
    this.payload = init.payload || {};
    this.session = normalizeSessionPayload(init.session || {}, {
      ttlMs: toInt(this.payload.ttl, 0, 0),
      processKeepAliveMs: toInt(this.payload.processKeepAlive, 0, 0),
    });
    this.rawResponse = init.rawResponse || null;
  }

  static async create(input: BuildSessionPayloadInput & BuildInput = {}): Promise<BrowserlessSession> {
    const sessionApiUrl = buildSessionApiUrl(input);
    const payload = buildSessionPayload(input);
    if (!fetchImpl) {
      throw new Error('Global fetch is not available in this runtime.');
    }
    const response = await fetchImpl(sessionApiUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
    });

    const raw = await response.text();
    let parsed: unknown = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      parsed = null;
    }
    if (!response.ok) {
      throw new Error(`Session API create failed: HTTP ${response.status} ${raw}`);
    }
    return new BrowserlessSession({
      sessionApiUrl,
      payload,
      session: parsed || {},
      rawResponse: parsed,
    });
  }

  buildConnectEndpoint(input: BrowserlessConnectOptions = {}): string {
    return buildConnectEndpoint(this.session.connect, input);
  }

  async stop(input: BrowserlessStopOptions = {}): Promise<void> {
    if (!this.session.stop) {
      return;
    }
    await stopBrowserlessSession(this.session.stop, input);
  }

  toRecord(): BrowserlessSessionRecord {
    return {
      sessionApiUrl: this.sessionApiUrl,
      payload: this.payload,
      session: this.session,
      rawResponse: this.rawResponse,
    };
  }
}

async function createBrowserlessSession(input: BuildSessionPayloadInput & BuildInput = {}): Promise<BrowserlessSessionRecord> {
  const created = await BrowserlessSession.create(input);
  return created.toRecord();
}

module.exports = {
  BrowserlessSession,
  appendConnectionParams,
  buildConnectEndpoint,
  buildSessionApiUrl,
  buildSessionPayload,
  createBrowserlessSession,
  normalizeSessionPayload,
  normalizeSolveMode,
  redactUrlSecretParams,
  stopBrowserlessSession,
  toBool,
  toInt,
  appendPathname,
  proxyValueFromEnv,
  DEFAULT_SESSION_TTL_MS,
};
