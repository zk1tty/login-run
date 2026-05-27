const assert = require('node:assert/strict');
const test = require('node:test');

const {
  appendConnectionParams,
  buildConnectEndpoint,
  buildSessionApiUrl,
  buildSessionPayload,
  normalizeSolveMode,
  redactUrlSecretParams,
} = require('../../src/core/browserless/browserless-session');
const {
  sanitizeSolveResult,
} = require('../../src/core/workflow/manual-captcha-solver');

test('appendConnectionParams adds solveCaptchas and timeout to session connect URL', () => {
  const endpoint = appendConnectionParams(
    'wss://production-sfo.browserless.io/session/connect/abc?token=secret',
    {
      solveCaptchas: 'true',
      timeout: '300000',
    }
  );
  const url = new URL(endpoint);

  assert.equal(url.pathname, '/session/connect/abc');
  assert.equal(url.searchParams.get('token'), 'secret');
  assert.equal(url.searchParams.get('solveCaptchas'), 'true');
  assert.equal(url.searchParams.get('timeout'), '300000');
});

test('buildConnectEndpoint omits solveCaptchas in manual mode', () => {
  const endpoint = buildConnectEndpoint(
    'wss://production-sfo.browserless.io/session/connect/abc?token=secret',
    {
      solveMode: 'manual',
      timeout: '300000',
    }
  );
  const url = new URL(endpoint);

  assert.equal(url.searchParams.get('token'), 'secret');
  assert.equal(url.searchParams.get('timeout'), '300000');
  assert.equal(url.searchParams.has('solveCaptchas'), false);
});

test('buildConnectEndpoint adds solveCaptchas only in auto mode', () => {
  const endpoint = buildConnectEndpoint(
    'wss://production-sfo.browserless.io/session/connect/abc?token=secret',
    {
      solveMode: 'auto',
      timeout: '300000',
    }
  );
  const url = new URL(endpoint);

  assert.equal(url.searchParams.get('solveCaptchas'), 'true');
});

test('buildConnectEndpoint can enable Browserless session replay', () => {
  const endpoint = buildConnectEndpoint(
    'wss://production-sfo.browserless.io/session/connect/abc?token=secret',
    {
      solveMode: 'manual',
      timeout: '300000',
      replay: true,
    }
  );
  const url = new URL(endpoint);

  assert.equal(url.searchParams.get('replay'), 'true');
  assert.equal(url.searchParams.has('solveCaptchas'), false);
});

test('normalizeSolveMode validates supported modes', () => {
  assert.equal(normalizeSolveMode('manual'), 'manual');
  assert.equal(normalizeSolveMode('auto'), 'auto');
  assert.equal(normalizeSolveMode('none'), 'none');
  assert.throws(() => normalizeSolveMode('bad'), /solveMode must be manual, auto, or none/);
});

test('buildSessionApiUrl targets /session and appends token', () => {
  const url = new URL(buildSessionApiUrl({
    httpBase: 'https://production-sfo.browserless.io',
    token: 'token-value',
  }));

  assert.equal(url.origin, 'https://production-sfo.browserless.io');
  assert.equal(url.pathname, '/session');
  assert.equal(url.searchParams.get('token'), 'token-value');
});

test('buildSessionPayload uses stealth session with nested proxy object', () => {
  const previous = {
    BROWSERLESS_PROXY: process.env.BROWSERLESS_PROXY,
    BROWSERLESS_PROXY_COUNTRY: process.env.BROWSERLESS_PROXY_COUNTRY,
    BROWSERLESS_PROXY_STICKY: process.env.BROWSERLESS_PROXY_STICKY,
    SESSION_API_PAYLOAD_JSON: process.env.SESSION_API_PAYLOAD_JSON,
  };

  process.env.BROWSERLESS_PROXY = 'residential';
  process.env.BROWSERLESS_PROXY_COUNTRY = 'us';
  process.env.BROWSERLESS_PROXY_STICKY = 'true';
  delete process.env.SESSION_API_PAYLOAD_JSON;

  try {
    const payload = buildSessionPayload({
      ttlMs: 180000,
      stealth: true,
      processKeepAliveMs: 0,
    });

    assert.equal(payload.ttl, 180000);
    assert.equal(payload.stealth, true);
    assert.deepEqual(payload.proxy, {
      type: 'residential',
      country: 'us',
      sticky: true,
    });
    assert.equal('processKeepAlive' in payload, false);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('buildSessionPayload treats empty numeric env values as defaults', () => {
  const previous = {
    SESSION_API_TTL_MS: process.env.SESSION_API_TTL_MS,
    SESSION_API_PROCESS_KEEP_ALIVE_MS: process.env.SESSION_API_PROCESS_KEEP_ALIVE_MS,
    SESSION_API_PAYLOAD_JSON: process.env.SESSION_API_PAYLOAD_JSON,
  };

  process.env.SESSION_API_TTL_MS = '';
  process.env.SESSION_API_PROCESS_KEEP_ALIVE_MS = '';
  delete process.env.SESSION_API_PAYLOAD_JSON;

  try {
    const payload = buildSessionPayload();

    assert.equal(payload.ttl, 180000);
    assert.equal('processKeepAlive' in payload, false);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});

test('redactUrlSecretParams removes token and session id', () => {
  const redacted = redactUrlSecretParams(
    'wss://production-sfo.browserless.io/session/connect/abc?token=secret&solveCaptchas=true'
  );

  assert.equal(redacted.includes('secret'), false);
  assert.equal(redacted.includes('/session/connect/abc'), false);
  assert.equal(redacted.includes('solveCaptchas=true'), true);
});

test('sanitizeSolveResult redacts CAPTCHA token while preserving solve metadata', () => {
  const sanitized = sanitizeSolveResult({
    token: 'abc123',
    found: true,
    solved: true,
    time: 42,
  });

  assert.equal(sanitized.token, '[redacted]');
  assert.equal(sanitized.hasToken, true);
  assert.equal(sanitized.tokenLength, 6);
  assert.equal(sanitized.found, true);
  assert.equal(sanitized.solved, true);
});
