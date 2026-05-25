const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  parseWorkflowPhase,
  resolveConnection,
  buildCheckpoint,
  normalizeSessionPayload,
  waitForOtpCode,
  deriveExpectedPostAuthPath,
  pathMatchesExpected,
  isPostAuthSuccessReason,
  resolveResumeTargetUrl,
  shouldResumeAfterObserve,
  shouldWaitForOtpFromFile,
} = require('../../src/core/login-agent/login-workflow-runner');

test('parseWorkflowPhase accepts only short phase names', () => {
  assert.equal(parseWorkflowPhase('1'), '1');
  assert.equal(parseWorkflowPhase('2'), '2');
  assert.equal(parseWorkflowPhase(''), '1');
  assert.throws(() => parseWorkflowPhase('phase1'), /LOGIN_PHASE/);
  assert.throws(() => parseWorkflowPhase('phase2'), /LOGIN_PHASE/);
});

test('buildCheckpoint omits credentials and OTP code', () => {
  const checkpoint = buildCheckpoint({
    customerId: 'danny',
    outcome: 'need_otp',
    targetUrl: 'https://example.com/login',
    currentUrl: 'https://example.com/otp',
    pageTitle: 'Verify',
    session: {
      id: 'session-1',
      connect: 'wss://example.com/session/connect/session-1',
      stop: 'https://example.com/session/session-1',
      ttlMs: 1000,
      processKeepAliveMs: 500,
      createdAt: '2026-05-15T00:00:00.000Z',
      expiresAt: '2026-05-15T00:01:00.000Z',
    },
    runDir: '.log/danny/run',
    email: 'user@example.com',
    password: 'secret',
    otpCode: '123456',
  });

  const serialized = JSON.stringify(checkpoint);
  assert.equal(checkpoint.outcome, 'need_otp');
  assert.equal(checkpoint.session.id, 'session-1');
  assert.equal(serialized.includes('user@example.com'), false);
  assert.equal(serialized.includes('secret'), false);
  assert.equal(serialized.includes('123456'), false);
});

test('buildCheckpoint can store post-auth checkpoint metadata', () => {
  const checkpoint = buildCheckpoint({
    customerId: 'danny',
    outcome: 'authed',
    targetUrl: 'https://example.com/login',
    currentUrl: 'https://example.com/member/home',
    pageTitle: 'Member Home',
    session: {
      id: 'session-1',
      connect: 'wss://example.com/session/connect/session-1',
      stop: 'https://example.com/session/session-1',
    },
    authenticated: {
      url: 'https://example.com/member/home',
      title: 'Member Home',
    },
  });

  assert.equal(checkpoint.outcome, 'authed');
  assert.equal(checkpoint.currentUrl, 'https://example.com/member/home');
  assert.equal(checkpoint.authenticated.url, 'https://example.com/member/home');
  assert.equal(checkpoint.session.connect, 'wss://example.com/session/connect/session-1');
});

test('resolveResumeTargetUrl uses authenticated URL for authed checkpoints only', () => {
  assert.equal(resolveResumeTargetUrl({
    outcome: 'authed',
    authenticated: {
      url: 'https://example.com/member/home',
    },
    currentUrl: 'https://example.com/fallback',
  }), 'https://example.com/member/home');

  assert.equal(resolveResumeTargetUrl({
    outcome: 'need_otp',
    authenticated: {
      url: 'https://example.com/member/home',
    },
    currentUrl: 'https://example.com/fallback',
  }), '');
});

test('shouldResumeAfterObserve resumes only deterministic non-terminal stages', () => {
  assert.equal(shouldResumeAfterObserve({
    terminalOutcome: '',
    stage: { state: 'identifier' },
  }), true);
  assert.equal(shouldResumeAfterObserve({
    terminalOutcome: '',
    stage: { state: 'id+pw' },
  }), true);
  assert.equal(shouldResumeAfterObserve({
    terminalOutcome: '',
    stage: { state: 'otp_delivery_selection' },
  }), true);
  assert.equal(shouldResumeAfterObserve({
    terminalOutcome: '',
    stage: { state: 'otp_code' },
  }), true);
  assert.equal(shouldResumeAfterObserve({
    terminalOutcome: 'authed',
    stage: { state: 'identifier' },
  }), false);
  assert.equal(shouldResumeAfterObserve({
    terminalOutcome: '',
    stage: { state: 'captcha' },
  }), false);
});

test('shouldWaitForOtpFromFile applies to any phase when otp page is reached and wait is enabled', () => {
  assert.equal(shouldWaitForOtpFromFile({
    finalStage: { state: 'otp_code' },
    otpCode: '',
    otpWaitMs: 300000,
  }), true);
  assert.equal(shouldWaitForOtpFromFile({
    finalStage: { state: 'otp_code' },
    otpCode: '123456',
    otpWaitMs: 300000,
  }), false);
  assert.equal(shouldWaitForOtpFromFile({
    finalStage: { state: 'identifier' },
    otpCode: '',
    otpWaitMs: 300000,
  }), false);
  assert.equal(shouldWaitForOtpFromFile({
    finalStage: { state: 'otp_code' },
    otpCode: '',
    otpWaitMs: 0,
  }), false);
});

test('normalizeSessionPayload accepts common Browserless session shapes', () => {
  const session = normalizeSessionPayload(
    {
      session: {
        sessionId: 'abc',
        browserWSEndpoint: 'wss://example.com/session/connect/abc',
        killURL: 'https://example.com/session/abc',
        ttl: 2000,
        processKeepAlive: 1000,
      },
    },
    {
      ttlMs: 1,
      processKeepAliveMs: 0,
    }
  );

  assert.equal(session.id, 'abc');
  assert.equal(session.connect, 'wss://example.com/session/connect/abc');
  assert.equal(session.stop, 'https://example.com/session/abc');
  assert.equal(session.ttlMs, 2000);
  assert.equal(session.processKeepAliveMs, 1000);
});

test('normalizeSessionPayload preserves normalized ttlMs fields', () => {
  const session = normalizeSessionPayload({
    id: 'abc',
    connect: 'wss://example.com/session/connect/abc',
    stop: 'https://example.com/session/abc',
    ttlMs: 180000,
    processKeepAliveMs: 60000,
  });

  assert.equal(session.ttlMs, 180000);
  assert.equal(session.processKeepAliveMs, 60000);
});

test('resolveConnection uses direct CDP captcha endpoint for phase 1', async () => {
  const previous = {
    BROWSERLESS_WS_BASE: process.env.BROWSERLESS_WS_BASE,
    BROWSERLESS_CDP_PATH: process.env.BROWSERLESS_CDP_PATH,
    BROWSERLESS_TOKEN: process.env.BROWSERLESS_TOKEN,
    BROWSERLESS_TIMEOUT_MS: process.env.BROWSERLESS_TIMEOUT_MS,
    BROWSERLESS_PROXY: process.env.BROWSERLESS_PROXY,
    BROWSERLESS_PROXY_COUNTRY: process.env.BROWSERLESS_PROXY_COUNTRY,
  };

  process.env.BROWSERLESS_WS_BASE = 'wss://production-sfo.browserless.io';
  process.env.BROWSERLESS_CDP_PATH = '/stealth';
  process.env.BROWSERLESS_TOKEN = 'token-value';
  process.env.BROWSERLESS_TIMEOUT_MS = '300000';
  process.env.BROWSERLESS_PROXY = 'residential';
  process.env.BROWSERLESS_PROXY_COUNTRY = 'us';

  try {
    const connection = await resolveConnection({
      phase: '1',
      route: '/stealth',
      solveCaptchas: true,
    });
    const endpoint = new URL(connection.endpoint);

    assert.equal(connection.connectionMode, 'direct_auto');
    assert.equal(endpoint.origin, 'wss://production-sfo.browserless.io');
    assert.equal(endpoint.pathname, '/stealth');
    assert.equal(endpoint.searchParams.get('token'), 'token-value');
    assert.equal(endpoint.searchParams.get('proxy'), 'residential');
    assert.equal(endpoint.searchParams.get('proxyCountry'), 'us');
    assert.equal(endpoint.searchParams.get('solveCaptchas'), 'true');
    assert.equal(endpoint.searchParams.get('timeout'), '300000');
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

test('resolveConnection uses checkpoint session for phase 2', async () => {
  const connection = await resolveConnection({
    phase: '2',
    checkpoint: {
      session: {
        connect: 'wss://example.com/session/connect/abc',
      },
    },
  });

  assert.equal(connection.connectionMode, 'session_resume');
  assert.equal(connection.endpoint, 'wss://example.com/session/connect/abc');
  assert.equal(connection.captchaSolveMode, 'manual');
});

test('waitForOtpCode reads a 6 digit code from a file without requiring env', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'login-agent-otp-'));
  const otpPath = path.join(tmpDir, 'otp.txt');
  fs.writeFileSync(otpPath, 'code: 123456\n', 'utf8');

  const result = await waitForOtpCode({
    filePath: otpPath,
    waitMs: 1000,
    pollMs: 250,
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.code, '123456');
  assert.equal(result.reason, '');
  assert.equal(typeof result.durationMs, 'number');
});

test('waitForOtpCode can be disabled for phase 1 single-session fallback', async () => {
  const result = await waitForOtpCode({
    filePath: '',
    waitMs: 1000,
    pollMs: 250,
  });

  assert.equal(result.status, 'skipped');
  assert.equal(result.reason, 'missing_OTP_CODE_FILE');
  assert.equal(result.code, '');
});

test('waitForOtpCode ignores stale and previously submitted codes', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'login-agent-otp-'));
  const otpPath = path.join(tmpDir, 'otp.txt');
  fs.writeFileSync(otpPath, '111111\n', 'utf8');
  const staleTime = new Date(Date.now() - 60_000);
  fs.utimesSync(otpPath, staleTime, staleTime);
  const minMtimeMs = Date.now();

  setTimeout(() => {
    fs.writeFileSync(otpPath, '222222\n', 'utf8');
  }, 20);

  const result = await waitForOtpCode({
    filePath: otpPath,
    waitMs: 1000,
    pollMs: 10,
    minMtimeMs,
    previousCodes: ['111111'],
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.code, '222222');
  assert.equal(result.fileMtimeMs >= minMtimeMs, true);
});

test('waitForOtpCode times out when only previous code is present', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'login-agent-otp-'));
  const otpPath = path.join(tmpDir, 'otp.txt');
  fs.writeFileSync(otpPath, '111111\n', 'utf8');

  const result = await waitForOtpCode({
    filePath: otpPath,
    waitMs: 30,
    pollMs: 10,
    previousCodes: ['111111'],
  });

  assert.equal(result.status, 'timeout');
  assert.equal(result.code, '');
});

test('deriveExpectedPostAuthPath reads HealthEquity MFA target URL from hash', () => {
  const pathValue = deriveExpectedPostAuthPath(
    'https://my.healthequity.com/Services/MfaChallenge#!/?targetUrl=%2FMember%2FMemberHome.aspx'
  );

  assert.equal(pathValue, '/Member/MemberHome.aspx');
  assert.equal(
    pathMatchesExpected('https://my.healthequity.com/Member/MemberHome.aspx', pathValue),
    true
  );
  assert.equal(
    pathMatchesExpected('https://my.healthequity.com/Services/MfaChallenge#!/', pathValue),
    false
  );
});

test('post-auth success reasons map to authenticated terminal outcome', () => {
  assert.equal(isPostAuthSuccessReason('classified_authed'), true);
  assert.equal(isPostAuthSuccessReason('classified_authed_url_title'), true);
  assert.equal(isPostAuthSuccessReason('expected_url_reached'), true);
  assert.equal(isPostAuthSuccessReason('left_mfa'), false);
  assert.equal(isPostAuthSuccessReason('post_auth_wait_timeout'), false);
});
