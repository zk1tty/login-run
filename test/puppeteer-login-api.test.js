const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { buildApp } = require('../src/api/app');
const { createLoginRunService } = require('../src/core/run/login-run-service');

function createProbeResult(input = {}) {
  const state = input.state || 'authed';
  const terminalOutcome = input.terminalOutcome || (state === 'authed' ? 'authed' : '');
  return {
    phase: input.phase || 'bootstrap',
    targetUrl: input.targetUrl || 'https://example.com/login',
    currentUrl: input.currentUrl || 'https://example.com/member',
    pageTitle: input.pageTitle || 'Member',
    detachedAt: '2026-05-25T12:00:00.000Z',
    observed: {
      beforeUrl: '',
      beforeTitle: '',
      afterUrl: input.currentUrl || 'https://example.com/member',
      afterTitle: input.pageTitle || 'Member',
      pageCount: 1,
    },
    capture: {
      stage: {
        state,
        phase: state === 'authed' ? 'authenticated' : 'credential',
        reason: `${state} fixture`,
      },
    },
    workflow: {
      terminalOutcome,
      finalStage: {
        state,
        phase: state === 'authed' ? 'authenticated' : 'credential',
        reason: `${state} fixture`,
      },
    },
    session: {
      id: input.sessionId || 'session-1',
      connect: 'wss://example.com/session/connect/session-1?token=secret',
      stop: 'https://example.com/session/session-1?token=secret',
      ttlMs: 604800000,
      processKeepAliveMs: 300000,
    },
    sessionCreated: input.sessionCreated !== false,
    runtime: {
      runtime: 'puppeteer',
      endpoint: 'wss://example.com/session/connect/session-1?token=secret',
      hasBrowser: true,
      hasPage: true,
      hasCdp: true,
    },
  };
}

function createFakeProbe(results) {
  const calls = [];
  const queue = Array.isArray(results) ? [...results] : [results];
  return {
    calls,
    async run(input) {
      calls.push(input);
      const next = queue.shift();
      if (next instanceof Error) {
        throw next;
      }
      if (typeof next === 'function') {
        return next(input);
      }
      return next || createProbeResult();
    },
  };
}

function createTempLogRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'stayauthed-api-logs-'));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function readJsonLines(filePath) {
  return fs.readFileSync(filePath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

test('GET /health returns Puppeteer API health', async () => {
  const app = buildApp({
    logger: false,
    probe: createFakeProbe(createProbeResult()),
  });

  const response = await app.inject({ method: 'GET', url: '/health' });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.status, 'ok');
  assert.equal(body.service, 'puppeteer-login-api');

  await app.close();
});

test('GET / redirects to the same-origin login lifecycle demo', async () => {
  const app = buildApp({
    logger: false,
    probe: createFakeProbe(createProbeResult()),
  });

  const response = await app.inject({ method: 'GET', url: '/' });

  assert.equal(response.statusCode, 302);
  assert.equal(response.headers.location, '/demo');

  await app.close();
});

test('GET /demo serves the login lifecycle demo page', async () => {
  const app = buildApp({
    logger: false,
    probe: createFakeProbe(createProbeResult()),
  });

  const response = await app.inject({ method: 'GET', url: '/demo' });

  assert.equal(response.statusCode, 200);
  assert.match(String(response.headers['content-type']), /text\/html/);
  assert.match(response.body, /Login Lifecycle Demo/);
  assert.match(response.body, /\/demo\/app\.js/);

  await app.close();
});

test('GET /demo/app.js and /demo/style.css serve demo assets', async () => {
  const app = buildApp({
    logger: false,
    probe: createFakeProbe(createProbeResult()),
  });

  const js = await app.inject({ method: 'GET', url: '/demo/app.js' });
  const css = await app.inject({ method: 'GET', url: '/demo/style.css' });

  assert.equal(js.statusCode, 200);
  assert.match(String(js.headers['content-type']), /application\/javascript/);
  assert.match(js.body, /new EventSource/);
  assert.equal(css.statusCode, 200);
  assert.match(String(css.headers['content-type']), /text\/css/);
  assert.match(css.body, /status-pill/);

  await app.close();
});

test('POST /v1/logins starts phase 1 and returns run URLs', async () => {
  const probe = createFakeProbe(createProbeResult());
  const app = buildApp({
    logger: false,
    probe,
    idFactory: () => 'login_testphase1',
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/logins',
    payload: {
      customerId: 'danny',
      targetUrl: 'https://example.com/login',
      username: 'user@example.com',
      password: 'secret',
      otpDeliverySelection: 'email',
    },
  });

  assert.equal(response.statusCode, 202);
  const body = response.json();
  assert.equal(body.runId, 'login_testphase1');
  assert.equal(body.status, 'running');
  assert.equal(body.state, 'authing');
  assert.equal(body.statusUrl, '/v1/logins/login_testphase1');
  assert.equal(body.eventsUrl, '/v1/logins/login_testphase1/events');

  await app.loginRunService.whenSettled(body.runId);
  assert.equal(probe.calls[0].phase, 'bootstrap');
  assert.equal(probe.calls[0].payload.LOGIN_USERNAME, 'user@example.com');
  assert.equal(probe.calls[0].payload.LOGIN_PASSWORD, 'secret');

  await app.close();
});

test('POST /v1/logins generates timestamp-prefixed run IDs by default', async () => {
  const app = buildApp({
    logger: false,
    probe: createFakeProbe(createProbeResult()),
  });

  const response = await app.inject({
    method: 'POST',
    url: '/v1/logins',
    payload: {
      customerId: 'danny',
      targetUrl: 'https://example.com/login',
      username: 'user@example.com',
      password: 'secret',
    },
  });

  assert.equal(response.statusCode, 202);
  const body = response.json();
  assert.match(body.runId, /^login_\d{8}T\d{9}Z_[a-f0-9]{8}$/);
  await app.loginRunService.whenSettled(body.runId);

  await app.close();
});

test('API login run writes summary and event artifacts immediately', async () => {
  const logsRoot = createTempLogRoot();
  const probe = createFakeProbe(input => {
    input.recordEvent('fake_probe_event', { marker: 'before_result' });
    return createProbeResult();
  });
  const service = createLoginRunService({
    probe,
    idFactory: () => 'login_artifacts',
    now: () => '2026-05-25T12:00:00.000Z',
    logsRoot,
  });

  const run = service.startLogin({
    customerId: 'danny',
    targetUrl: 'https://example.com/login',
    username: 'user@example.com',
    password: 'secret',
  });

  const runDir = path.join(logsRoot, 'danny', 'api-login-runs', 'login_artifacts');
  const summaryPath = path.join(runDir, 'summary.json');
  const eventsPath = path.join(runDir, 'events.jsonl');

  assert.equal(run.runId, 'login_artifacts');
  assert.equal(fs.existsSync(summaryPath), true);
  assert.equal(fs.existsSync(eventsPath), true);

  await service.whenSettled('login_artifacts');

  const summary = readJson(summaryPath);
  const events = readJsonLines(eventsPath);

  assert.equal(summary.run.runId, 'login_artifacts');
  assert.equal(summary.run.status, 'succeeded');
  assert.equal(summary.artifacts.runDir, runDir);
  assert.equal(events.some(event => event.name === 'login.run_created'), true);
  assert.equal(events.some(event => event.name === 'login.updated'), true);
  assert.equal(events.some(event => event.name === 'fake_probe_event'), true);
  assert.equal(events.some(event => event.name === 'login.completed'), true);

  await service.close();
});

test('API login run exposes screenshot artifact metadata and image content', async () => {
  const onePixelPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
    'base64'
  );
  const probe = createFakeProbe(input => {
    fs.writeFileSync(path.join(input.screenshotsDir, '0002-post-action-1.png'), onePixelPng);
    input.recordEvent('screenshot', {
      label: 'post-action-1',
      screenshotPath: path.join(input.screenshotsDir, '0002-post-action-1.png'),
    });
    fs.writeFileSync(path.join(input.screenshotsDir, '0001-bootstrap.png'), onePixelPng);
    input.recordEvent('screenshot', {
      label: 'bootstrap',
      screenshotPath: path.join(input.screenshotsDir, '0001-bootstrap.png'),
    });
    return createProbeResult();
  });
  let nowTick = 0;
  const app = buildApp({
    logger: false,
    probe,
    idFactory: () => 'login_screenshot',
    now: () => new Date(Date.UTC(2026, 4, 25, 12, 0, nowTick++)).toISOString(),
    logsRoot: createTempLogRoot(),
  });

  await app.inject({
    method: 'POST',
    url: '/v1/logins',
    payload: {
      customerId: 'danny',
      targetUrl: 'https://example.com/login',
      username: 'user@example.com',
      password: 'secret',
    },
  });
  await app.loginRunService.whenSettled('login_screenshot');

  const listResponse = await app.inject({
    method: 'GET',
    url: '/v1/logins/login_screenshot/artifacts/screenshots',
  });
  assert.equal(listResponse.statusCode, 200);
  const list = listResponse.json();
  assert.equal(list.runId, 'login_screenshot');
  assert.equal(list.screenshots.length, 2);
  assert.equal(list.screenshots[0].fileName, '0002-post-action-1.png');
  assert.equal(list.screenshots[0].label, 'post action 1');
  assert.equal(list.screenshots[1].fileName, '0001-bootstrap.png');
  assert.equal(list.screenshots[1].label, 'bootstrap');

  const imageResponse = await app.inject({
    method: 'GET',
    url: '/v1/logins/login_screenshot/artifacts/screenshots/0001-bootstrap.png',
  });
  assert.equal(imageResponse.statusCode, 200);
  assert.match(String(imageResponse.headers['content-type']), /image\/png/);
  assert.equal(Buffer.compare(imageResponse.rawPayload, onePixelPng), 0);

  await app.close();
});

test('API login run streams screenshot events when artifacts are written', async () => {
  const onePixelPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
    'base64'
  );
  const service = createLoginRunService({
    probe: createFakeProbe(async input => {
      await new Promise(resolve => setTimeout(resolve, 10));
      const screenshotPath = path.join(input.screenshotsDir, '0001-bootstrap.png');
      fs.writeFileSync(screenshotPath, onePixelPng);
      input.recordEvent('screenshot', {
        label: 'bootstrap',
        screenshotPath,
      });
      return createProbeResult();
    }),
    idFactory: () => 'login_screenshot_event',
    now: () => '2026-05-25T12:00:00.000Z',
    logsRoot: createTempLogRoot(),
  });
  const events = [];

  service.startLogin({
    customerId: 'danny',
    targetUrl: 'https://example.com/login',
    username: 'user@example.com',
    password: 'secret',
  });
  const unsubscribe = service.subscribe('login_screenshot_event', event => {
    events.push(event);
  });
  await service.whenSettled('login_screenshot_event');
  unsubscribe();

  const screenshotEvent = events.find(event => event.type === 'login.screenshot');
  assert.ok(screenshotEvent);
  assert.equal(screenshotEvent.data.runId, 'login_screenshot_event');
  assert.equal(screenshotEvent.data.phase, 'bootstrap');
  assert.equal(screenshotEvent.data.fileName, '0001-bootstrap.png');
  assert.equal(screenshotEvent.data.label, 'bootstrap');
  assert.equal(screenshotEvent.data.sequence, 1);
  assert.equal(
    screenshotEvent.data.url,
    '/v1/logins/login_screenshot_event/artifacts/screenshots/0001-bootstrap.png'
  );

  await service.close();
});

test('API login run replays existing screenshot events to new SSE subscribers', async () => {
  const onePixelPng = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
    'base64'
  );
  const service = createLoginRunService({
    probe: createFakeProbe(input => {
      const screenshotPath = path.join(input.screenshotsDir, '0001-bootstrap.png');
      fs.writeFileSync(screenshotPath, onePixelPng);
      input.recordEvent('screenshot', {
        label: 'bootstrap',
        screenshotPath,
      });
      return createProbeResult();
    }),
    idFactory: () => 'login_screenshot_replay',
    now: () => '2026-05-25T12:00:00.000Z',
    logsRoot: createTempLogRoot(),
  });
  const events = [];

  service.startLogin({
    customerId: 'danny',
    targetUrl: 'https://example.com/login',
    username: 'user@example.com',
    password: 'secret',
  });
  await service.whenSettled('login_screenshot_replay');
  const unsubscribe = service.subscribe('login_screenshot_replay', event => {
    events.push(event);
  });
  unsubscribe();

  const screenshotEvent = events.find(event => event.type === 'login.screenshot');
  assert.ok(screenshotEvent);
  assert.equal(screenshotEvent.data.runId, 'login_screenshot_replay');
  assert.equal(screenshotEvent.data.phase, 'replay');
  assert.equal(screenshotEvent.data.fileName, '0001-bootstrap.png');

  await service.close();
});

test('phase 1 ending at OTP maps to waiting_input need_otp', async () => {
  const app = buildApp({
    logger: false,
    probe: createFakeProbe(createProbeResult({
      state: 'otp_code',
      terminalOutcome: 'need_otp',
    })),
    idFactory: () => 'login_needotp',
  });

  await app.inject({
    method: 'POST',
    url: '/v1/logins',
    payload: {
      customerId: 'danny',
      targetUrl: 'https://example.com/login',
      username: 'user@example.com',
      password: 'secret',
    },
  });
  const run = await app.loginRunService.whenSettled('login_needotp');

  assert.equal(run.status, 'waiting_input');
  assert.equal(run.state, 'need_otp');
  assert.deepEqual(run.nextActions, ['otp']);
  assert.equal(run.result.session.id, 'session-1');
  assert.equal(run.result.session.connect, undefined);

  await app.close();
});

test('POST /v1/logins/:runId/otp resumes the stored checkpoint', async () => {
  const probe = createFakeProbe([
    input => {
      fs.mkdirSync(input.screenshotsDir, { recursive: true });
      fs.writeFileSync(path.join(input.screenshotsDir, '0001-bootstrap.png'), 'fake-image');
      return createProbeResult({
        state: 'otp_code',
        terminalOutcome: 'need_otp',
      });
    },
    input => createProbeResult({
      phase: input.phase,
      state: 'authed',
      terminalOutcome: 'authed',
      sessionCreated: false,
    }),
  ]);
  const app = buildApp({
    logger: false,
    probe,
    idFactory: () => 'login_otpsuccess',
    logsRoot: createTempLogRoot(),
  });

  await app.inject({
    method: 'POST',
    url: '/v1/logins',
    payload: {
      customerId: 'danny',
      targetUrl: 'https://example.com/login',
      username: 'user@example.com',
      password: 'secret',
    },
  });
  await app.loginRunService.whenSettled('login_otpsuccess');

  const otpResponse = await app.inject({
    method: 'POST',
    url: '/v1/logins/login_otpsuccess/otp',
    payload: {
      code: '123456',
    },
  });

  assert.equal(otpResponse.statusCode, 202);
  assert.equal(otpResponse.json().status, 'running');
  const run = await app.loginRunService.whenSettled('login_otpsuccess');

  assert.equal(run.status, 'succeeded');
  assert.equal(run.state, 'authed');
  assert.equal(probe.calls[1].phase, 'reconnect');
  assert.equal(probe.calls[0].artifactSequenceStart, 1);
  assert.equal(probe.calls[1].artifactSequenceStart, 2);
  assert.equal(probe.calls[1].payload.OTP_CODE, '123456');
  assert.equal(probe.calls[1].checkpoint.session.id, 'session-1');

  await app.close();
});

test('GET /v1/logins lists unique in-memory runs', async () => {
  const app = buildApp({
    logger: false,
    probe: createFakeProbe(createProbeResult()),
    idFactory: () => 'login_listed',
    logsRoot: createTempLogRoot(),
  });

  await app.inject({
    method: 'POST',
    url: '/v1/logins',
    payload: {
      customerId: 'danny',
      targetUrl: 'https://example.com/login',
      username: 'user@example.com',
      password: 'secret',
    },
  });
  await app.loginRunService.whenSettled('login_listed');

  const response = await app.inject({
    method: 'GET',
    url: '/v1/logins',
  });

  assert.equal(response.statusCode, 200);
  const body = response.json();
  assert.equal(body.runs.length, 1);
  assert.equal(body.runs[0].runId, 'login_listed');
  assert.equal(body.runs[0].status, 'succeeded');

  await app.close();
});

test('POST /v1/logins/:runId/reconnect reuses successful login checkpoint', async () => {
  const probe = createFakeProbe([
    createProbeResult({
      state: 'authed',
      terminalOutcome: 'authed',
    }),
    input => createProbeResult({
      phase: input.phase,
      state: 'authed',
      terminalOutcome: 'authed',
      sessionCreated: false,
    }),
  ]);
  const app = buildApp({
    logger: false,
    probe,
    idFactory: () => 'login_reconnect',
    logsRoot: createTempLogRoot(),
    reconnectWaitMs: 250,
  });

  await app.inject({
    method: 'POST',
    url: '/v1/logins',
    payload: {
      customerId: 'danny',
      targetUrl: 'https://example.com/login',
      username: 'user@example.com',
      password: 'secret',
    },
  });
  await app.loginRunService.whenSettled('login_reconnect');

  const reconnectResponse = await app.inject({
    method: 'POST',
    url: '/v1/logins/login_reconnect/reconnect',
  });

  assert.equal(reconnectResponse.statusCode, 202);
  assert.equal(reconnectResponse.json().status, 'running');
  const run = await app.loginRunService.whenSettled('login_reconnect');

  assert.equal(run.status, 'succeeded');
  assert.equal(run.state, 'authed');
  assert.equal(probe.calls[1].phase, 'reconnect');
  assert.equal(probe.calls[1].checkpoint.session.id, 'session-1');
  assert.equal(probe.calls[1].workflowEnabled, false);
  assert.equal(probe.calls[1].waitMs, 250);
  assert.equal(probe.calls[1].maxActions, 0);
  assert.equal(probe.calls[1].actionWaitMs, 0);

  await app.close();
});

test('GET /v1/logins/:runId returns 404 for unknown runs', async () => {
  const app = buildApp({
    logger: false,
    probe: createFakeProbe(createProbeResult()),
  });

  const response = await app.inject({
    method: 'GET',
    url: '/v1/logins/login_missing',
  });

  assert.equal(response.statusCode, 404);
  assert.equal(response.json().status, 'error');

  await app.close();
});

test('GET /v1/logins/:runId/events returns 404 for unknown runs before SSE starts', async () => {
  const app = buildApp({
    logger: false,
    probe: createFakeProbe(createProbeResult()),
  });

  const response = await app.inject({
    method: 'GET',
    url: '/v1/logins/login_missing/events',
  });

  assert.equal(response.statusCode, 404);
  assert.equal(response.json().status, 'error');

  await app.close();
});

test('legacy live and admin routes are not registered', async () => {
  const app = buildApp({
    logger: false,
    probe: createFakeProbe(createProbeResult()),
  });

  const live = await app.inject({ method: 'GET', url: '/live/danny' });
  const admin = await app.inject({ method: 'GET', url: '/admin/owners/danny' });

  assert.equal(live.statusCode, 404);
  assert.equal(admin.statusCode, 404);

  await app.close();
});

test('failed probe maps to failed run status', async () => {
  const service = createLoginRunService({
    probe: createFakeProbe(new Error('probe failed')),
    idFactory: () => 'login_failed',
  });

  service.startLogin({
    customerId: 'danny',
    targetUrl: 'https://example.com/login',
    username: 'user@example.com',
    password: 'secret',
  });
  const run = await service.whenSettled('login_failed');

  assert.equal(run.status, 'failed');
  assert.equal(run.state, 'failed');
  assert.equal(run.error.message, 'probe failed');

  await service.close();
});

test('failed probe redacts Browserless URLs from public error payload', async () => {
  const service = createLoginRunService({
    probe: createFakeProbe(new Error(
      "WebSocket connection to 'wss://production-sfo.browserless.io/e/encrypted/session/connect/session-1?token=secret-token&proxy=residential' failed: Expected 101 status code"
    )),
    idFactory: () => 'login_failed_redacted',
  });

  service.startLogin({
    customerId: 'danny',
    targetUrl: 'https://example.com/login',
    username: 'user@example.com',
    password: 'secret',
  });
  const run = await service.whenSettled('login_failed_redacted');

  assert.equal(run.status, 'failed');
  assert.match(run.error.message, /Expected 101 status code/);
  assert.doesNotMatch(run.error.message, /secret-token/);
  assert.doesNotMatch(run.error.message, /\/e\/encrypted/);
  assert.match(run.error.message, /token=%5Bredacted%5D|token=\[redacted\]/);

  await service.close();
});
