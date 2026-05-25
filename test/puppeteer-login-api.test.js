const assert = require('node:assert/strict');
const test = require('node:test');

const { buildApp } = require('../src/app');
const { createLoginRunService } = require('../src/core/login-agent/login-run-service');

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
    createProbeResult({
      state: 'otp_code',
      terminalOutcome: 'need_otp',
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
    idFactory: () => 'login_otpsuccess',
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
  assert.equal(probe.calls[1].payload.OTP_CODE, '123456');
  assert.equal(probe.calls[1].checkpoint.session.id, 'session-1');

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
