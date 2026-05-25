const { getHttpBase } = require('../../../scripts/lib/helpers');

const DEFAULT_SESSION_TTL_MS = 180000;

function toBool(value, fallback = false) {
  if (value == null || value === '') {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function toInt(value, fallback, minimum = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(minimum, Math.trunc(parsed));
}

function appendPathname(basePath, routePath) {
  const normalizedBase = basePath === '/' ? '' : String(basePath || '').replace(/\/$/, '');
  const normalizedRoute = String(routePath || '').startsWith('/')
    ? String(routePath)
    : `/${routePath}`;
  return `${normalizedBase}${normalizedRoute}`;
}

function redactUrlSecretParams(urlString) {
  try {
    const url = new URL(String(urlString || ''));
    for (const key of ['token', 'apiKey', 'apikey', 'key']) {
      if (url.searchParams.has(key)) {
        url.searchParams.set(key, '[redacted]');
      }
    }
    return url.toString()
      .replace(/\/e\/[^/]+/i, '/e/[redacted]')
      .replace(/\/session\/connect\/[^/?#]+/i, '/session/connect/[redacted]');
  } catch {
    return String(urlString || '')
      .replace(/([?&](?:token|apiKey|apikey|key)=)[^&]+/gi, '$1[redacted]')
      .replace(/\/e\/[^/]+/i, '/e/[redacted]')
      .replace(/\/session\/connect\/[^/?#]+/i, '/session/connect/[redacted]');
  }
}

function appendConnectionParams(connectUrl, params = {}) {
  const url = new URL(String(connectUrl || ''));
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === '') {
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function normalizeSolveMode(value) {
  const mode = String(value || 'manual').trim().toLowerCase();
  if (mode === 'manual' || mode === 'auto' || mode === 'none') {
    return mode;
  }
  throw new Error('solveMode must be manual, auto, or none.');
}

function buildConnectEndpoint(connectUrl, input = {}) {
  const solveMode = normalizeSolveMode(input.solveMode);
  const params = {
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

function buildSessionApiUrl(input = {}) {
  const base = String(input.httpBase || getHttpBase()).trim();
  const token = String(input.token || process.env.BROWSERLESS_TOKEN || '').trim();
  const url = new URL(base);
  url.pathname = appendPathname(url.pathname, '/session');
  if (token) {
    url.searchParams.set('token', token);
  }
  return url.toString();
}

function proxyValueFromEnv() {
  const proxy = String(process.env.BROWSERLESS_PROXY || '').trim();
  if (!proxy) {
    return null;
  }

  const proxyValue = {
    type: proxy,
  };
  const country = String(process.env.BROWSERLESS_PROXY_COUNTRY || '').trim();
  const city = String(process.env.BROWSERLESS_PROXY_CITY || '').trim();
  const preset = String(process.env.BROWSERLESS_PROXY_PRESET || '').trim();
  if (country) {
    proxyValue.country = country;
  }
  if (city) {
    proxyValue.city = city;
  }
  if (preset) {
    proxyValue.preset = preset;
  }
  if (process.env.BROWSERLESS_PROXY_STICKY != null && process.env.BROWSERLESS_PROXY_STICKY !== '') {
    proxyValue.sticky = toBool(process.env.BROWSERLESS_PROXY_STICKY, false);
  }
  return proxyValue;
}

function buildSessionPayload(input = {}) {
  const rawOverride = String(input.rawPayload || process.env.SESSION_API_PAYLOAD_JSON || '').trim();
  if (rawOverride) {
    return JSON.parse(rawOverride);
  }

  const payload = {
    ttl: toInt(
      input.ttlMs || process.env.SESSION_API_TTL_MS,
      DEFAULT_SESSION_TTL_MS,
      1000
    ),
    stealth: toBool(
      input.stealth ?? process.env.SESSION_API_STEALTH,
      true
    ),
  };

  const processKeepAlive = toInt(
    input.processKeepAliveMs ?? process.env.SESSION_API_PROCESS_KEEP_ALIVE_MS,
    0,
    0
  );
  if (processKeepAlive > 0) {
    payload.processKeepAlive = processKeepAlive;
  }

  const browser = String(input.browser || process.env.SESSION_API_BROWSER || '').trim();
  if (browser) {
    payload.browser = browser;
  }

  const proxy = input.proxyOverride || proxyValueFromEnv();
  if (proxy) {
    payload.proxy = proxy;
  }

  return payload;
}

function normalizeSessionPayload(payload = {}, defaults = {}) {
  const raw = payload && typeof payload.session === 'object' ? payload.session : payload;
  return {
    id: String(raw.id || raw.sessionId || '').trim(),
    connect: String(
      raw.connect ||
        raw.connectUrl ||
        raw.connectURL ||
        raw.wsEndpoint ||
        raw.browserWSEndpoint ||
        ''
    ).trim(),
    stop: String(raw.stop || raw.stopUrl || raw.stopURL || raw.killURL || '').trim(),
    ttlMs: toInt(raw.ttl || raw.ttlMs || defaults.ttlMs, defaults.ttlMs || 0, 0),
    processKeepAliveMs: toInt(
      raw.processKeepAlive || raw.processKeepAliveMs || defaults.processKeepAliveMs,
      defaults.processKeepAliveMs || 0,
      0
    ),
  };
}

async function stopBrowserlessSession(stopUrl, input = {}) {
  const maxAttempts = toInt(input.maxAttempts, 5, 1);
  const delayMs = toInt(input.delayMs, 1000, 0);
  const url = appendConnectionParams(stopUrl, { force: 'true' });
  let lastError = '';
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const response = await fetch(url, { method: 'DELETE' });
    if (response.ok) {
      return;
    }
    const raw = await response.text().catch(() => '');
    lastError = `Session stop failed: HTTP ${response.status} ${raw}`;
    if (!/ENOTEMPTY|directory not empty/i.test(raw) || attempt === maxAttempts) {
      break;
    }
    await new Promise(resolve => setTimeout(resolve, delayMs * attempt));
  }
  throw new Error(lastError || 'Session stop failed with unknown error.');
}

class BrowserlessSession {
  constructor(input = {}) {
    this.sessionApiUrl = String(input.sessionApiUrl || '');
    this.payload = input.payload || {};
    this.session = normalizeSessionPayload(input.session || {}, {
      ttlMs: toInt(this.payload.ttl, 0, 0),
      processKeepAliveMs: toInt(this.payload.processKeepAlive, 0, 0),
    });
    this.rawResponse = input.rawResponse || null;
  }

  static async create(input = {}) {
    const sessionApiUrl = buildSessionApiUrl(input);
    const payload = buildSessionPayload(input);
    const response = await fetch(sessionApiUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });
    const raw = await response.text();
    let parsed;
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

  buildConnectEndpoint(input = {}) {
    return buildConnectEndpoint(this.session.connect, input);
  }

  async stop(input = {}) {
    if (!this.session.stop) {
      return;
    }
    await stopBrowserlessSession(this.session.stop, input);
  }

  toRecord() {
    return {
      sessionApiUrl: this.sessionApiUrl,
      payload: this.payload,
      session: this.session,
      rawResponse: this.rawResponse,
    };
  }
}

async function createBrowserlessSession(input = {}) {
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
};
