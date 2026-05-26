// @ts-nocheck
// @ts-nocheck
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const { toTimestampTag } = require('../utils/time');
const {
  inspectRuntimeInventory,
  classifyRuntimeStage,
  hasAuthenticatedUrlTitleSignal,
} = require('./runtime-inventory');
const {
  createCaptchaState,
  applyBrowserlessCaptchaFound,
  applyBrowserlessCaptchaAutoSolved,
  applyBrowserlessCaptchaManualSolve,
  applyDomChallengeObservation,
} = require('./captcha-state');
const { planRuntimeAction } = require('./action-planner');
const { executeRuntimeAction } = require('./action-executor');
const {
  DEFAULT_ROUTE: DEFAULT_CONNECTION_ROUTE,
  resolveLoginConnection,
} = require('../browserless/login-connection');
const {
  normalizeSessionPayload,
  redactUrlSecretParams,
} = require('../browserless/browserless-session');
const { BrowserlessSessionClient } = require('../browserless/browserless-session-client');
const { ManualCaptchaSolver } = require('./manual-captcha-solver');

const DEFAULT_WAIT_MS = 45000;
const DEFAULT_OBSERVE_MS = 5000;
const DEFAULT_SAMPLE_INTERVAL_MS = 1000;
const DEFAULT_ACTION_WAIT_MS = 5000;
const DEFAULT_MAX_ACTIONS = 8;
const DEFAULT_POST_AUTH_WAIT_MS = 90000;
const DEFAULT_POST_AUTH_POLL_MS = 1000;

function toSafeError(error) {
  const message = String(error?.message || error || 'unknown_error');
  const cause = error?.cause;
  const causeParts = [
    cause?.code,
    cause?.address && cause?.port ? `${cause.address}:${cause.port}` : '',
    cause?.message,
  ].filter(Boolean);
  return causeParts.length ? `${message} (${causeParts.join(' ')})` : message;
}

function resolveSessionClient(connection = {}) {
  if (connection.resource && typeof connection.resource === 'object') {
    return BrowserlessSessionClient.fromBrowserlessSession(connection.resource);
  }

  if (connection.session && typeof connection.session === 'object') {
    return BrowserlessSessionClient.fromCheckpoint(connection.session);
  }

  return null;
}

function toInt(value, fallback, minimum = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(minimum, Math.trunc(parsed));
}

function parseWorkflowPhase(value) {
  const phase = String(value || '1').trim();
  if (phase !== '1' && phase !== '2') {
    throw new Error('LOGIN_PHASE must be "1" or "2".');
  }
  return phase;
}

function getBootstrapReadyTimeoutMs() {
  const value = Number(process.env.AUTH_BOOTSTRAP_READY_TIMEOUT_MS || 30000);
  return Number.isFinite(value) && value >= 0 ? value : 30000;
}

function getBootstrapReadySelector() {
  return process.env.AUTH_BOOTSTRAP_READY_SELECTOR || '';
}

function getBootstrapRenderWaitMs() {
  const value = Number(process.env.AUTH_BOOTSTRAP_RENDER_WAIT_MS || 1500);
  return Number.isFinite(value) && value >= 0 ? value : 1500;
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

function appendJsonLine(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function readCheckpoint(filePath) {
  const raw = String(filePath || '').trim();
  if (!raw) {
    throw new Error('CHECKPOINT_PATH is required for LOGIN_PHASE=2.');
  }
  const resolved = path.resolve(raw);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`Checkpoint not found: ${resolved}`);
  }
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

/**
 * Same-session OTP code wait
 * Wait for OTP code to be delivered by polling a file for changes and extracting a 6-digit code.
 * @param {Object} input
 **/
async function waitForOtpCode(input = {}) {
  const filePath = String(input.filePath || '').trim();
  const waitMs = toInt(input.waitMs, 0, 0);
  const pollMs = toInt(input.pollMs, 1000, 250);
  const minMtimeMs = toInt(input.minMtimeMs, 0, 0);
  const previousCodes = new Set(
    Array.isArray(input.previousCodes)
      ? input.previousCodes.map(value => String(value || '').trim()).filter(Boolean)
      : []
  );
  const startedAtMs = Date.now();

  if (!filePath || waitMs <= 0) {
    return {
      status: 'skipped',
      reason: !filePath ? 'missing_OTP_CODE_FILE' : 'otp_wait_disabled',
      code: '',
      durationMs: 0,
    };
  }

  const resolvedPath = path.resolve(filePath);
  while (Date.now() - startedAtMs < waitMs) {
    if (fs.existsSync(resolvedPath)) {
      const stat = fs.statSync(resolvedPath);
      const raw = fs.readFileSync(resolvedPath, 'utf8');
      const match = raw.match(/\b(\d{6})\b/);
      if (match && stat.mtimeMs >= minMtimeMs && !previousCodes.has(match[1])) {
        return {
          status: 'ok',
          reason: '',
          code: match[1],
          durationMs: elapsedMs(startedAtMs),
          fileMtimeMs: stat.mtimeMs,
        };
      }
    }
    await new Promise(resolve => setTimeout(resolve, pollMs));
  }

  return {
    status: 'timeout',
    reason: 'otp_code_not_received',
    code: '',
    durationMs: elapsedMs(startedAtMs),
    fileMtimeMs: 0,
  };
}

function buildCheckpoint(input = {}) {
  const outcome = String(input.outcome || 'need_otp').trim() || 'need_otp';
  return {
    version: 1,
    customerId: input.customerId || '',
    phase: '1',
    outcome,
    createdAt: new Date().toISOString(),
    targetUrl: input.targetUrl || '',
    currentUrl: input.currentUrl || '',
    pageTitle: input.pageTitle || '',
    session: {
      id: input.session?.id || '',
      connect: input.session?.connect || '',
      stop: input.session?.stop || '',
      ttlMs: input.session?.ttlMs || 0,
      processKeepAliveMs: input.session?.processKeepAliveMs || 0,
      createdAt: input.session?.createdAt || '',
      expiresAt: input.session?.expiresAt || '',
    },
    runDir: input.runDir || '',
    authenticated: {
      url: input.authenticated?.url || '',
      title: input.authenticated?.title || '',
    },
  };
}

function resolveResumeTargetUrl(checkpoint = null) {
  if (!checkpoint || typeof checkpoint !== 'object') {
    return '';
  }
  if (String(checkpoint.outcome || '') !== 'authed') {
    return '';
  }
  return String(
    checkpoint.authenticated?.url ||
      checkpoint.currentUrl ||
      checkpoint.targetUrl ||
      ''
  ).trim();
}

function shouldResumeAfterObserve(input = {}) {
  if (input.terminalOutcome) {
    return false;
  }
  const state = String(input.stage?.state || '').trim();
  return (
    state === 'identifier' ||
    state === 'id+pw' ||
    state === 'otp_delivery_selection' ||
    state === 'otp_code'
  );
}

function shouldWaitForOtpFromFile(input = {}) {
  return (
    String(input.finalStage?.state || '').trim() === 'otp_code' &&
    !String(input.otpCode || '').trim() &&
    toInt(input.otpWaitMs, 0, 0) > 0
  );
}

function elapsedMs(startedAtMs) {
  return Math.max(0, Date.now() - startedAtMs);
}

function deriveExpectedPostAuthPath(urlString) {
  try {
    const url = new URL(String(urlString || ''));
    const hash = String(url.hash || '');
    const hashQuery = hash.includes('?') ? hash.slice(hash.indexOf('?') + 1) : '';
    const params = new URLSearchParams(hashQuery);
    const targetUrl = params.get('targetUrl') || params.get('returnUrl') || '';
    if (targetUrl) {
      return new URL(targetUrl, url.origin).pathname;
    }
  } catch {
    return '';
  }
  return '';
}

function pathMatchesExpected(urlString, expectedPath) {
  const expected = String(expectedPath || '').trim();
  if (!expected) {
    return false;
  }
  try {
    return new URL(String(urlString || '')).pathname.toLowerCase() === expected.toLowerCase();
  } catch {
    return false;
  }
}

function isMfaUrl(urlString) {
  return String(urlString || '').toLowerCase().includes('/services/mfachallenge');
}

function isPostAuthSuccessReason(reason) {
  return [
    'classified_authed',
    'classified_authed_url_title',
    'expected_url_reached',
  ].includes(String(reason || ''));
}

function toWebsiteRunPrefix(targetUrl) {
  try {
    const hostname = new URL(targetUrl).hostname;
    const withoutWww = hostname.replace(/^www\./i, '');
    const normalized = withoutWww
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '');
    return normalized || 'unknown-website';
  } catch {
    return 'unknown-website';
  }
}

async function detectChallengeSnapshot(page) {
  return page.evaluate(() => {
    /* global document, location */
    const title = document.title || '';
    const url = location.href || '';
    const corpus = (document.body?.innerText || '').toLowerCase();
    const hasChallengeText =
      corpus.includes('just a moment') ||
      corpus.includes('performing security verification') ||
      corpus.includes('verify you are human');
    const hasVerifyingText = corpus.includes('verifying...');
    const hasSecurityCheckPassedText = corpus.includes('security check passed');
    const iframeCount = Array.from(document.querySelectorAll('iframe')).filter(frame => {
      const src = String(frame.getAttribute('src') || '');
      const titleAttr = String(frame.getAttribute('title') || '');
      const aria = String(frame.getAttribute('aria-label') || '');
      const all = `${src} ${titleAttr} ${aria}`.toLowerCase();
      return all.includes('turnstile') || all.includes('challenges.cloudflare.com');
    }).length;
    const tokenLength = (() => {
      const input = document.querySelector('input[name="cf-turnstile-response"]');
      return input && typeof input.value === 'string' ? input.value.trim().length : 0;
    })();

    return {
      title,
      url,
      iframeCount,
      tokenLength,
      hasChallengeText,
      hasVerifyingText,
      hasSecurityCheckPassedText,
      challengeVisible:
        hasChallengeText ||
        hasVerifyingText ||
        iframeCount > 0 ||
        /just a moment/i.test(title),
    };
  });
}

class LoginWorkflowRunner {
  async run() {
  const customerId = String(process.env.CID || process.env.CUSTOMER_ID || 'danny').trim();
  const workflowPhase = parseWorkflowPhase(
    process.env.LOGIN_PHASE || process.env.LOGIN_WORKFLOW_PHASE
  );
  const checkpointPath = String(process.env.CHECKPOINT_PATH || '').trim();
  const checkpoint = workflowPhase === '2' ? readCheckpoint(checkpointPath) : null;
  const resumeTargetUrl = workflowPhase === '2'
    ? resolveResumeTargetUrl(checkpoint)
    : '';
  if (workflowPhase === '2') {
    if (!['need_otp', 'authed'].includes(String(checkpoint.outcome || ''))) {
      throw new Error('Checkpoint outcome must be need_otp or authed for LOGIN_PHASE=2.');
    }
    if (!checkpoint.session?.connect) {
      throw new Error('Checkpoint is missing session.connect; rerun LOGIN_PHASE=1.');
    }
  }
  const targetUrl = String(
    process.env.URL || process.env.LOGIN_URL || checkpoint?.targetUrl || ''
  ).trim();
  if (!targetUrl) {
    throw new Error('URL or LOGIN_URL is required.');
  }

  const route = String(process.env.CAPTCHA_TEST_ROUTE || DEFAULT_CONNECTION_ROUTE).trim();
  const requestedConnectionMode = String(
    process.env.LOGIN_CONNECTION_MODE || 'direct_auto'
  ).trim();
  const waitMs = toInt(process.env.LOGIN_WORKFLOW_WAIT_MS, DEFAULT_WAIT_MS, 1000);
  const observeMs = toInt(
    process.env.LOGIN_WORKFLOW_OBSERVE_MS || process.env.LOGIN_WORKFLOW_POST_LOGIN_WAIT_MS,
    DEFAULT_OBSERVE_MS,
    0
  );
  const sampleIntervalMs = toInt(
    process.env.LOGIN_WORKFLOW_SAMPLE_INTERVAL_MS,
    DEFAULT_SAMPLE_INTERVAL_MS,
    250
  );
  const actionWaitMs = toInt(
    process.env.LOGIN_WORKFLOW_ACTION_WAIT_MS,
    DEFAULT_ACTION_WAIT_MS,
    0
  );
  const maxActions = toInt(
    process.env.LOGIN_WORKFLOW_MAX_ACTIONS,
    DEFAULT_MAX_ACTIONS,
    0
  );
  const postAuthWaitMs = toInt(
    process.env.POST_AUTH_WAIT_MS || process.env.LOGIN_POST_AUTH_WAIT_MS,
    DEFAULT_POST_AUTH_WAIT_MS,
    0
  );
  const postAuthPollMs = toInt(
    process.env.POST_AUTH_POLL_MS || process.env.LOGIN_POST_AUTH_POLL_MS,
    DEFAULT_POST_AUTH_POLL_MS,
    250
  );
  const sessionKeepAliveMs = toInt(process.env.SESSION_KEEP_ALIVE_MS, 0, 0);
  const payload = {
    LOGIN_USERNAME: String(process.env.LOGIN_USERNAME || '').trim(),
    LOGIN_PASSWORD: String(process.env.LOGIN_PASSWORD || '').trim(),
    OTP_DELIVERY_SELECTION: String(
      process.env.OTP_DELIVERY_SELECTION || process.env.OTP_SELECTION || ''
    ).trim(),
    OTP_CODE: String(process.env.OTP_CODE || '').trim(),
  };
  const otpCodeFile = String(process.env.OTP_CODE_FILE || '').trim();
  const otpWaitMs = toInt(
    process.env.OTP_WAIT_MS || process.env.LOGIN_OTP_WAIT_MS,
    0,
    0
  );
  const otpPollMs = toInt(
    process.env.OTP_POLL_MS || process.env.LOGIN_OTP_POLL_MS,
    1000,
    250
  );
  const otpMaxAttempts = toInt(
    process.env.OTP_MAX_ATTEMPTS || process.env.LOGIN_OTP_MAX_ATTEMPTS,
    3,
    1
  );
  const logsRoot = path.resolve(process.env.RUN_LOGS_ROOT || '.log');
  const runTag = `${toWebsiteRunPrefix(targetUrl)}-${toTimestampTag(new Date())}`;
  const outputDir = path.resolve(logsRoot, customerId, 'direct-login-captcha-resolver', runTag);
  const screenshotsDir = path.resolve(outputDir, 'screenshots');
  const inventoriesDir = path.resolve(outputDir, 'inventories');
  const eventsPath = path.resolve(outputDir, 'events.jsonl');
  const summaryPath = path.resolve(outputDir, 'summary.json');
  const outputCheckpointPath = path.resolve(outputDir, 'checkpoint.json');
  fs.mkdirSync(screenshotsDir, { recursive: true });
  fs.mkdirSync(inventoriesDir, { recursive: true });

  const connection = await resolveLoginConnection({
    phase: workflowPhase,
    connectionMode: requestedConnectionMode,
    route,
    checkpoint,
  });
  const sessionClient = resolveSessionClient(connection);
  const normalizedSession = sessionClient
    ? sessionClient.toSessionPayload()
    : normalizeSessionPayload(connection.session || {});
  const session = (normalizedSession.connect || normalizedSession.id)
    ? normalizedSession
    : null;
  const connectionMode = connection.connectionMode;
  const cdpConnectionKind = connection.cdpConnectionKind || '';
  const solveCaptchas = connection.solveCaptchas === true;
  const captchaSolveMode = connection.captchaSolveMode || '';
  const endpoint = connection.endpoint;
  const endpointForLogs = sessionClient?.toRuntimeRedactedLogUrl()
    ? sessionClient.toRuntimeRedactedLogUrl()
    : redactUrlSecretParams(endpoint);

  const startedAtMs = Date.now();
  const events = [];
  const captchaState = createCaptchaState();
  const milestones = {
    initialPageLoadedAt: '',
    initialPageLoadedOffsetMs: null,
    captchaFirstSeenAt: '',
    captchaFirstSeenOffsetMs: null,
    captchaResolvedAt: '',
    captchaResolvedOffsetMs: null,
    observeStartedAt: '',
    observeStartedOffsetMs: null,
    observeFinishedAt: '',
    observeFinishedOffsetMs: null,
  };

  function recordEvent(name, detail = {}) {
    const entry = {
      at: new Date().toISOString(),
      offsetMs: elapsedMs(startedAtMs),
      name,
      detail,
    };
    events.push(entry);
    appendJsonLine(eventsPath, entry);
    return entry;
  }

  function writeInventory(label, payload) {
    const filePath = path.resolve(
      inventoriesDir,
      `${String(events.length + 1).padStart(4, '0')}-${label}.json`
    );
    fs.writeFileSync(filePath, JSON.stringify(payload, null, 2));
    return filePath;
  }

  function summarizeInventory(inventory = {}) {
    const candidates = Array.isArray(inventory.candidates) ? inventory.candidates : [];
    const visible = candidates.filter(item => item.visible === true);
    const visibleEnabled = visible.filter(item => item.disabled !== true);
    const inputs = candidates.filter(item => item.tag === 'input' || item.tag === 'textarea');
    const buttonLike = candidates.filter(item =>
      item.tag === 'button' ||
      item.role === 'button' ||
      (item.tag === 'input' && ['button', 'submit'].includes(String(item.type || '').toLowerCase()))
    );

    return {
      candidateCount: candidates.length,
      visibleCandidateCount: visible.length,
      visibleEnabledCandidateCount: visibleEnabled.length,
      inputCount: inputs.length,
      visibleEnabledInputCount: inputs.filter(
        item => item.visible === true && item.disabled !== true
      ).length,
      buttonLikeCount: buttonLike.length,
      visibleEnabledButtonLikeCount: buttonLike.filter(
        item => item.visible === true && item.disabled !== true
      ).length,
    };
  }

  async function collectRuntimeInventory(page, label, challengeSnapshot) {
    const startedAtOffsetMs = elapsedMs(startedAtMs);
    const startedAtMsLocal = Date.now();
    const inventory = await inspectRuntimeInventory(page);
    const durationMs = Math.max(0, Date.now() - startedAtMsLocal);
    const finishedAtOffsetMs = elapsedMs(startedAtMs);
    const stage = classifyRuntimeStage(inventory, challengeSnapshot);
    const metrics = {
      label,
      startedAtOffsetMs,
      finishedAtOffsetMs,
      durationMs,
      ...summarizeInventory(inventory),
      stage,
    };
    const inventoryPath = writeInventory(`${label}-runtime`, {
      inventory,
      stage,
      metrics,
      challengeSnapshot,
    });

    recordEvent('runtime_inventory', {
      label,
      inventoryPath,
      metrics,
    });

    return {
      inventory,
      stage,
      metrics,
      inventoryPath,
    };
  }

  async function capture(page, label) {
    const screenshotPath = path.resolve(
      screenshotsDir,
      `${String(events.length + 1).padStart(4, '0')}-${label}.png`
    );
    let snapshot = null;
    let error = '';
    try {
      snapshot = await detectChallengeSnapshot(page);
      await page.screenshot({ path: screenshotPath, fullPage: true });
    } catch (captureError) {
      error = toSafeError(captureError);
    }
    recordEvent('screenshot', {
      label,
      screenshotPath: error ? '' : screenshotPath,
      snapshot,
      error,
    });
    return { screenshotPath: error ? '' : screenshotPath, snapshot, error };
  }

  async function waitForPostAuthState(page, input = {}) {
    const timeoutMs = toInt(input.timeoutMs, DEFAULT_POST_AUTH_WAIT_MS, 0);
    const pollMs = toInt(input.pollMs, DEFAULT_POST_AUTH_POLL_MS, 250);
    const expectedPath = String(input.expectedPath || '').trim();
    const startedAtMsLocal = Date.now();
    let attempt = 0;
    let lastCapture = null;
    let lastRuntime = null;
    let reason = 'post_auth_wait_timeout';

    recordEvent('post_auth_wait_start', {
      timeoutMs,
      pollMs,
      expectedPath,
      startUrl: page.url(),
    });

    while (Date.now() - startedAtMsLocal <= timeoutMs) {
      await page.waitForLoadState('domcontentloaded', { timeout: Math.min(pollMs, 1000) })
        .catch(() => {});
      await page.waitForTimeout(pollMs);
      await page.waitForLoadState('networkidle', { timeout: Math.min(pollMs, 2000) })
        .catch(() => {});

      attempt += 1;
      const label = `post-auth-${attempt}`;
      lastCapture = await capture(page, label);
      if (lastCapture.snapshot) {
        const event = recordEvent('captcha_post_auth_observation', lastCapture.snapshot);
        applyDomChallengeObservation(captchaState, lastCapture.snapshot, event);
        await maybeRunManualCaptchaSolve('post_auth_poll', lastCapture.snapshot);
        milestones.captchaFirstSeenAt = captchaState.firstSeenAt;
        milestones.captchaFirstSeenOffsetMs = captchaState.firstSeenOffsetMs;
        milestones.captchaResolvedAt = captchaState.resolvedAt;
        milestones.captchaResolvedOffsetMs = captchaState.resolvedOffsetMs;
      }
      lastRuntime = await collectRuntimeInventory(page, label, lastCapture.snapshot);

      const currentUrl =
        lastRuntime.inventory?.url ||
        lastCapture.snapshot?.url ||
        page.url();
      const currentTitle =
        lastRuntime.inventory?.title ||
        lastCapture.snapshot?.title ||
        await page.title().catch(() => '');
      const state = lastRuntime.stage?.state || 'unknown';
      const leftMfa = !isMfaUrl(currentUrl);
      const reachedExpectedPath = pathMatchesExpected(currentUrl, expectedPath);
      const urlTitleAuthenticated = leftMfa && hasAuthenticatedUrlTitleSignal({
        url: currentUrl,
        title: currentTitle,
        text: lastRuntime.inventory?.text || '',
      });
      const inventoryHasContent =
        String(lastRuntime.inventory?.text || '').trim().length > 0 ||
        (
          Array.isArray(lastRuntime.inventory?.candidates) &&
          lastRuntime.inventory.candidates.length > 0
        );
      const pageReadyForTerminal =
        (!lastCapture.error && Boolean(lastCapture.snapshot)) || inventoryHasContent;

      if (state === 'authed') {
        reason = 'classified_authed';
        break;
      }
      if (state === 'otp_error') {
        reason = 'otp_error';
        break;
      }
      if (urlTitleAuthenticated) {
        if (!pageReadyForTerminal) {
          recordEvent('post_auth_wait_progress', {
            reason: 'url_title_authenticated_waiting_for_stable_page',
            attempt,
            url: currentUrl,
            title: currentTitle,
            captureError: lastCapture.error || '',
          });
          continue;
        }
        lastRuntime.stage = {
          state: 'authed',
          phase: 'authenticated',
          reason: 'Authenticated URL/title signals detected after MFA.',
        };
        if (lastRuntime.metrics) {
          lastRuntime.metrics.stage = lastRuntime.stage;
        }
        reason = 'classified_authed_url_title';
        break;
      }
      if (reachedExpectedPath && leftMfa) {
        if (!pageReadyForTerminal) {
          recordEvent('post_auth_wait_progress', {
            reason: 'expected_url_reached_waiting_for_stable_page',
            attempt,
            url: currentUrl,
            title: currentTitle,
            captureError: lastCapture.error || '',
          });
          continue;
        }
        reason = 'expected_url_reached';
        break;
      }
      if (leftMfa && state !== 'otp_code' && state !== 'otp_delivery_selection') {
        recordEvent('post_auth_wait_progress', {
          reason: 'left_mfa_waiting_for_auth_signal',
          attempt,
          url: currentUrl,
          title: currentTitle,
          state,
        });
      }
    }

    const result = {
      status: reason === 'post_auth_wait_timeout' ? 'timeout' : 'done',
      reason,
      durationMs: Math.max(0, Date.now() - startedAtMsLocal),
      attempts: attempt,
      expectedPath,
      url: lastCapture?.snapshot?.url || page.url(),
      title: lastCapture?.snapshot?.title || await page.title().catch(() => ''),
      stage: lastRuntime?.stage || null,
      runtime: lastRuntime,
      capture: lastCapture,
    };
    recordEvent('post_auth_wait_result', {
      status: result.status,
      reason: result.reason,
      durationMs: result.durationMs,
      attempts: result.attempts,
      expectedPath: result.expectedPath,
      url: result.url,
      title: result.title,
      stage: result.stage,
    });
    return result;
  }

  let browser;
  let page;
  let cdp;
  let manualCaptchaSolver;
  let sampler;
  let samplerStopped = false;
  let samplerInFlight = false;
  let landingStage;
  let finalStage;
  let landingInventoryMetrics;
  let postActionStage;
  let postActionInventoryMetrics;
  let actionPlan;
  let actionResult;
  const actions = [];
  let finalInventoryMetrics;
  let terminalOutcome = '';
  let checkpointWrittenPath = '';

  recordEvent('run_start', {
    workflowPhase,
    targetUrl,
    route,
    connectionMode,
    cdpConnectionKind,
    solveCaptchas,
    waitMs,
    observeMs,
    sampleIntervalMs,
    actionWaitMs,
    maxActions,
    postAuthWaitMs,
    postAuthPollMs,
    sessionKeepAliveMs,
    otpWait: {
      enabled: otpWaitMs > 0,
      filePath: otpCodeFile ? path.resolve(otpCodeFile) : '',
      waitMs: otpWaitMs,
      pollMs: otpPollMs,
      maxAttempts: otpMaxAttempts,
    },
    payload: {
      hasLoginUsername: Boolean(payload.LOGIN_USERNAME),
      loginUsernameLength: payload.LOGIN_USERNAME.length,
      hasLoginPassword: Boolean(payload.LOGIN_PASSWORD),
      loginPasswordLength: payload.LOGIN_PASSWORD.length,
      hasOtpDeliverySelection: Boolean(payload.OTP_DELIVERY_SELECTION),
      otpDeliverySelectionLength: payload.OTP_DELIVERY_SELECTION.length,
      hasOtpCode: Boolean(payload.OTP_CODE),
      otpCodeLength: payload.OTP_CODE.length,
    },
    checkpointPath: checkpointPath || '',
    session: session
      ? {
          id: session.id || '',
          hasConnect: Boolean(session.connect),
          hasStop: Boolean(session.stop),
          ttlMs: session.ttlMs || 0,
          processKeepAliveMs: session.processKeepAliveMs || 0,
          expiresAt: session.expiresAt || '',
        }
      : null,
    endpoint: endpointForLogs,
    requestedConnectionMode,
    captchaSolveMode,
    sessionCreated: connection.sessionCreated === true,
    sessionApiUrl: sessionClient?.sessionApiUrl
      ? redactUrlSecretParams(sessionClient.sessionApiUrl)
      : redactUrlSecretParams(connection.sessionApiUrl || ''),
    sessionPayload: connection.sessionPayload || null,
  });

  async function maybeRunManualCaptchaSolve(reason, snapshot = null) {
    if (!manualCaptchaSolver) {
      return;
    }
    if (captchaState.resolvedAt) {
      return;
    }
    if (!snapshot || snapshot.challengeVisible !== true) {
      return;
    }
    const result = await manualCaptchaSolver.solve(reason);
    if (!result) {
      return;
    }
    const event = recordEvent('Browserless.solveCaptcha', {
      reason,
      result,
    });
    applyBrowserlessCaptchaManualSolve(captchaState, result, event);
    milestones.captchaResolvedAt = captchaState.resolvedAt;
    milestones.captchaResolvedOffsetMs = captchaState.resolvedOffsetMs;
  }

  try {
    try {
      browser = await chromium.connectOverCDP(endpoint);
    } catch (error) {
      const errorMessage = toSafeError(error);
      if (
        connectionMode === 'session_resume' &&
        /Session ID .* wasn't found|404 Not Found/i.test(errorMessage)
      ) {
        throw new Error(
          `Session resume failed: Browserless session was not found. ` +
          `The persisted session likely expired or was deleted. ` +
          `Increase SESSION_API_TTL_MS before the bootstrap run and retry phase 1.`,
          { cause: error }
        );
      }
      const wrapped = new Error(
        `connectOverCDP failed for ${endpointForLogs}: ${errorMessage}`
      );
      throw wrapped;
    }
    const context = browser.contexts()[0] || await browser.newContext();
    page = context.pages()[0] || await context.newPage();
    cdp = await context.newCDPSession(page);
    if (captchaSolveMode === 'manual') {
      manualCaptchaSolver = new ManualCaptchaSolver({
        cdp,
        recordEvent,
        timeoutMs: process.env.CAPTCHA_SOLVE_COMMAND_TIMEOUT_MS,
      });
    }

    cdp.on('Browserless.captchaFound', params => {
      const event = recordEvent('Browserless.captchaFound', params || {});
      applyBrowserlessCaptchaFound(captchaState, params || {}, event);
      milestones.captchaFirstSeenAt = captchaState.firstSeenAt;
      milestones.captchaFirstSeenOffsetMs = captchaState.firstSeenOffsetMs;
      if (manualCaptchaSolver) {
        const solverSnapshot = {
          challengeVisible: true,
        };
        maybeRunManualCaptchaSolve('browserless_captcha_found_event', solverSnapshot)
          .catch(error => {
            recordEvent('captcha_manual_solve_trigger_error', {
              reason: 'browserless_captcha_found_event',
              error: toSafeError(error),
            });
          });
      }
    });
    cdp.on('Browserless.captchaAutoSolved', params => {
      const event = recordEvent('Browserless.captchaAutoSolved', params || {});
      applyBrowserlessCaptchaAutoSolved(captchaState, params || {}, event);
      milestones.captchaResolvedAt = captchaState.resolvedAt;
      milestones.captchaResolvedOffsetMs = captchaState.resolvedOffsetMs;
    });

    let loaded = null;
    if (workflowPhase === '1') {
      recordEvent('goto_start', { targetUrl });
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: waitMs });
      await waitForPageReady(page, { timeout: Math.min(waitMs, 15000), renderWaitMs: 1000 })
        .catch(() => {});
      loaded = recordEvent('goto_complete', {
        url: page.url(),
        title: await page.title(),
      });
    } else {
      await waitForPageReady(page, { timeout: Math.min(waitMs, 15000), renderWaitMs: 1000 })
        .catch(() => {});
      loaded = recordEvent('reconnect_complete', {
        url: page.url(),
        title: await page.title(),
      });
      if (resumeTargetUrl && page.url() !== resumeTargetUrl) {
        recordEvent('reconnect_navigate_start', {
          fromUrl: page.url(),
          toUrl: resumeTargetUrl,
          checkpointOutcome: checkpoint?.outcome || '',
        });
        await page.goto(resumeTargetUrl, {
          waitUntil: 'domcontentloaded',
          timeout: waitMs,
        });
        await waitForPageReady(page, {
          timeout: Math.min(waitMs, 15000),
          renderWaitMs: 1000,
        }).catch(() => {});
        loaded = recordEvent('reconnect_navigate_complete', {
          url: page.url(),
          title: await page.title(),
        });
      }
    }
    milestones.initialPageLoadedAt = loaded.at;
    milestones.initialPageLoadedOffsetMs = loaded.offsetMs;

    const landingCapture = await capture(page, 'landing');
    const landingRuntime = await collectRuntimeInventory(
      page,
      'landing',
      landingCapture.snapshot
    );
    landingStage = landingRuntime.stage;
    landingInventoryMetrics = landingRuntime.metrics;

    let currentStage = landingStage;
    let currentInventory = landingRuntime.inventory;
    let nextActionIndex = 0;
    let landingSnapshotObserved = false;
    let finalRuntime = landingRuntime;

    async function runDeterministicActions(startStage, startInventory, startActionIndex) {
      let stage = startStage;
      let inventory = startInventory;
      let actionIndex = startActionIndex;

      while (actionIndex < maxActions) {
        const currentActionIndex = actionIndex;
        actionIndex += 1;

        actionPlan = planRuntimeAction({
          stage,
          inventory,
          payload,
        });
        recordEvent('runtime_action_plan', {
          actionIndex: currentActionIndex,
          plan: actionPlan,
        });

        if (actionPlan.type === 'none') {
          actionResult = {
            status: 'skipped',
            reason: actionPlan.reason,
            detail: actionPlan.detail || {},
          };
          recordEvent('runtime_action_skipped', {
            actionIndex: currentActionIndex,
            ...actionResult,
          });
          if (
            actionPlan.reason === 'unsupported_stage' &&
            actionPlan.detail?.stage === 'blocked_or_unknown'
          ) {
            await page.waitForLoadState('domcontentloaded', { timeout: Math.min(waitMs, 10000) })
              .catch(() => {});
            await page.waitForTimeout(Math.min(actionWaitMs || 1000, 5000));

            const retryLabel = `post-wait-${currentActionIndex + 1}`;
            const retryCapture = await capture(page, retryLabel);
            const retryRuntime = await collectRuntimeInventory(
              page,
              retryLabel,
              retryCapture.snapshot
            );
            postActionStage = retryRuntime.stage;
            postActionInventoryMetrics = retryRuntime.metrics;
            stage = retryRuntime.stage;
            inventory = retryRuntime.inventory;
            recordEvent('runtime_action_retry_after_blocked', {
              actionIndex: currentActionIndex,
              nextStage: stage,
            });

            if (stage.state !== 'blocked_or_unknown') {
              continue;
            }
          }
          break;
        }

        if (actionPlan.type === 'pause') {
          terminalOutcome = actionPlan.terminalOutcome || 'need_otp';
          actionResult = {
            status: 'paused',
            terminalOutcome,
            reason: actionPlan.reason,
            detail: actionPlan.detail || {},
          };
          recordEvent('runtime_action_paused', {
            actionIndex: currentActionIndex,
            ...actionResult,
          });
          break;
        }

        actionResult = await executeRuntimeAction(page, actionPlan, payload, {
          waitMs: actionWaitMs,
        });
        if (actionResult.terminalOutcome) {
          terminalOutcome = actionResult.terminalOutcome;
        }
        actions.push({
          actionIndex: currentActionIndex,
          plan: actionPlan,
          result: actionResult,
        });
        recordEvent('runtime_action_result', {
          actionIndex: currentActionIndex,
          result: actionResult,
        });

        await page.waitForLoadState('domcontentloaded', { timeout: Math.min(waitMs, 10000) })
          .catch(() => {});
        await page.waitForTimeout(500);

        const postActionLabel = `post-action-${currentActionIndex + 1}`;
        const postActionCapture = await capture(page, postActionLabel);
        const postActionRuntime = await collectRuntimeInventory(
          page,
          postActionLabel,
          postActionCapture.snapshot
        );
        postActionStage = postActionRuntime.stage;
        postActionInventoryMetrics = postActionRuntime.metrics;
        stage = postActionRuntime.stage;
        inventory = postActionRuntime.inventory;

        if (postActionCapture.snapshot) {
          const eventName = postActionCapture.snapshot.challengeVisible
            ? 'captcha_detected_by_dom'
            : 'captcha_dom_observation';
          const event = recordEvent(eventName, postActionCapture.snapshot);
          applyDomChallengeObservation(captchaState, postActionCapture.snapshot, event);
          await maybeRunManualCaptchaSolve('post_action_snapshot', postActionCapture.snapshot);
          milestones.captchaFirstSeenAt = captchaState.firstSeenAt;
          milestones.captchaFirstSeenOffsetMs = captchaState.firstSeenOffsetMs;
          milestones.captchaResolvedAt = captchaState.resolvedAt;
          milestones.captchaResolvedOffsetMs = captchaState.resolvedOffsetMs;
        }

        if (
          actionResult.status !== 'ok' ||
          postActionCapture.snapshot?.challengeVisible ||
          actionResult.terminalOutcome
        ) {
          break;
        }
      }

      return {
        nextActionIndex: actionIndex,
        stage,
        inventory,
      };
    }

    while (true) {
      const actionCycleResult = await runDeterministicActions(
        currentStage,
        currentInventory,
        nextActionIndex
      );
      nextActionIndex = actionCycleResult.nextActionIndex;
      currentStage = actionCycleResult.stage;
      currentInventory = actionCycleResult.inventory;

      if (!landingSnapshotObserved && landingCapture.snapshot) {
        const eventName = landingCapture.snapshot.challengeVisible
          ? 'captcha_detected_by_dom'
          : 'captcha_dom_observation';
        const event = recordEvent(eventName, landingCapture.snapshot);
        applyDomChallengeObservation(captchaState, landingCapture.snapshot, event);
        await maybeRunManualCaptchaSolve('landing_snapshot', landingCapture.snapshot);
        milestones.captchaFirstSeenAt = captchaState.firstSeenAt;
        milestones.captchaFirstSeenOffsetMs = captchaState.firstSeenOffsetMs;
        milestones.captchaResolvedAt = captchaState.resolvedAt;
        milestones.captchaResolvedOffsetMs = captchaState.resolvedOffsetMs;
        landingSnapshotObserved = true;
      }

      const observeStart = recordEvent('observe_start', {});
      if (milestones.observeStartedAt == null) {
        milestones.observeStartedAt = observeStart.at;
        milestones.observeStartedOffsetMs = observeStart.offsetMs;
      }

      sampler = setInterval(async () => {
        if (samplerStopped || samplerInFlight) {
          return;
        }
        samplerInFlight = true;
        try {
          const snapshot = await detectChallengeSnapshot(page);
          if (snapshot) {
            const eventName = snapshot.challengeVisible
              ? 'captcha_detected_by_sampler'
              : 'captcha_sampler_observation';
            const event = recordEvent(eventName, snapshot);
            applyDomChallengeObservation(captchaState, snapshot, event);
            await maybeRunManualCaptchaSolve('sampler_snapshot', snapshot);
            milestones.captchaFirstSeenAt = captchaState.firstSeenAt;
            milestones.captchaFirstSeenOffsetMs = captchaState.firstSeenOffsetMs;
            milestones.captchaResolvedAt = captchaState.resolvedAt;
            milestones.captchaResolvedOffsetMs = captchaState.resolvedOffsetMs;
          }
        } catch (error) {
          recordEvent('sampler_error', { error: toSafeError(error) });
        } finally {
          samplerInFlight = false;
        }
      }, sampleIntervalMs);

      if (observeMs > 0) {
        await page.waitForTimeout(observeMs);
      }

      samplerStopped = true;
      clearInterval(sampler);
      sampler = null;

      const finalCaptureLabel = shouldWaitForOtpFromFile({
        finalStage,
        otpCode: payload.OTP_CODE,
        otpWaitMs,
      }) ? 'pre-otp' : 'final';
      const finalCapture = await capture(page, finalCaptureLabel);
      if (finalCapture.snapshot) {
        const event = recordEvent('captcha_final_observation', finalCapture.snapshot);
        applyDomChallengeObservation(captchaState, finalCapture.snapshot, event);
        await maybeRunManualCaptchaSolve('final_snapshot', finalCapture.snapshot);
        milestones.captchaFirstSeenAt = captchaState.firstSeenAt;
        milestones.captchaFirstSeenOffsetMs = captchaState.firstSeenOffsetMs;
        milestones.captchaResolvedAt = captchaState.resolvedAt;
        milestones.captchaResolvedOffsetMs = captchaState.resolvedOffsetMs;
      }
      finalRuntime = await collectRuntimeInventory(
        page,
        finalCaptureLabel,
        finalCapture.snapshot
      );
      finalStage = finalRuntime.stage;
      finalInventoryMetrics = finalRuntime.metrics;
      if (!terminalOutcome) {
        if (finalStage?.state === 'otp_code' && workflowPhase === '1') {
          terminalOutcome = 'need_otp';
        } else if (finalStage?.state === 'authed') {
          terminalOutcome = 'authed';
        } else if (actionResult?.status === 'failed') {
          terminalOutcome = 'blocked_or_unknown';
        }
      }

      const observeEnd = recordEvent('observe_complete', {
        url: page.url(),
        title: await page.title(),
      });
      milestones.observeFinishedAt = observeEnd.at;
      milestones.observeFinishedOffsetMs = observeEnd.offsetMs;

      if (
        shouldResumeAfterObserve({
          terminalOutcome,
          stage: finalRuntime.stage,
        }) &&
        nextActionIndex < maxActions
      ) {
        currentStage = finalRuntime.stage;
        currentInventory = finalRuntime.inventory;
        postActionStage = finalRuntime.stage;
        postActionInventoryMetrics = finalRuntime.metrics;
        samplerStopped = false;
        samplerInFlight = false;
        recordEvent('runtime_action_resume_after_observe', {
          nextActionIndex,
          stage: currentStage,
        });
        continue;
      }

      break;
    }

    if (
      terminalOutcome === 'need_otp' &&
      shouldWaitForOtpFromFile({
        finalStage,
        otpCode: payload.OTP_CODE,
        otpWaitMs,
      })
    ) {
      const submittedOtpCodes = [];
      let currentOtpRuntime = finalRuntime;
      let nextOtpFileMtimeMs = startedAtMs;

      for (let otpAttempt = 1; otpAttempt <= otpMaxAttempts; otpAttempt += 1) {
        recordEvent('otp_wait_start', {
          attempt: otpAttempt,
          maxAttempts: otpMaxAttempts,
          filePath: otpCodeFile ? path.resolve(otpCodeFile) : '',
          waitMs: otpWaitMs,
          pollMs: otpPollMs,
          minMtimeMs: nextOtpFileMtimeMs,
          previousCodeCount: submittedOtpCodes.length,
        });
        if (otpAttempt > 1) {
          const message =
            `OTP attempt ${otpAttempt - 1} was rejected. ` +
            `Update ${otpCodeFile || 'OTP_CODE_FILE'} with a new 6-digit code.`;
          console.error(message);
          recordEvent('otp_retry_prompt', {
            attempt: otpAttempt,
            message,
          });
        }

        const otpWaitResult = await waitForOtpCode({
          filePath: otpCodeFile,
          waitMs: otpWaitMs,
          pollMs: otpPollMs,
          minMtimeMs: nextOtpFileMtimeMs,
          previousCodes: submittedOtpCodes,
        });
        recordEvent('otp_wait_result', {
          attempt: otpAttempt,
          status: otpWaitResult.status,
          reason: otpWaitResult.reason,
          durationMs: otpWaitResult.durationMs,
          hasCode: Boolean(otpWaitResult.code),
          codeLength: otpWaitResult.code.length,
          fileMtimeMs: otpWaitResult.fileMtimeMs || 0,
        });

        if (otpWaitResult.status !== 'ok' || !otpWaitResult.code) {
          terminalOutcome = otpWaitResult.status === 'timeout'
            ? 'need_otp'
            : terminalOutcome;
          break;
        }

        payload.OTP_CODE = otpWaitResult.code;
        submittedOtpCodes.push(otpWaitResult.code);
        nextOtpFileMtimeMs = Math.max(
          Date.now() + 1,
          Math.ceil(Number(otpWaitResult.fileMtimeMs || 0)) + 1
        );
        const otpActionIndex = actions.reduce(
          (max, item) => Math.max(max, Number(item.actionIndex || 0)),
          -1
        ) + 1;
        actionPlan = planRuntimeAction({
          stage: currentOtpRuntime.stage,
          inventory: currentOtpRuntime.inventory,
          payload,
        });
        recordEvent('runtime_action_plan', {
          actionIndex: otpActionIndex,
          attempt: otpAttempt,
          plan: actionPlan,
          source: 'otp_wait',
        });

        if (actionPlan.type === 'fill_input_and_submit') {
          actionResult = await executeRuntimeAction(page, actionPlan, payload, {
            waitMs: actionWaitMs,
          });
          actions.push({
            actionIndex: otpActionIndex,
            plan: actionPlan,
            result: actionResult,
          });
          recordEvent('runtime_action_result', {
            actionIndex: otpActionIndex,
            attempt: otpAttempt,
            result: actionResult,
            source: 'otp_wait',
          });

          const postAuthResult = await waitForPostAuthState(page, {
            timeoutMs: postAuthWaitMs,
            pollMs: postAuthPollMs,
            expectedPath:
              deriveExpectedPostAuthPath(page.url()) ||
              String(process.env.LOGIN_AUTHENTICATED_PATH || '').trim(),
          });
          const postOtpRuntime = postAuthResult.runtime;
          if (postOtpRuntime) {
            postActionStage = postOtpRuntime.stage;
            postActionInventoryMetrics = postOtpRuntime.metrics;
            finalStage = postOtpRuntime.stage;
            finalInventoryMetrics = postOtpRuntime.metrics;
            currentOtpRuntime = postOtpRuntime;
          }

          if (!postOtpRuntime) {
            terminalOutcome = 'blocked_or_unknown';
            break;
          } else if (postOtpRuntime.stage?.state === 'authed') {
            terminalOutcome = 'authed';
            break;
          } else if (postOtpRuntime.stage?.state === 'otp_error') {
            terminalOutcome = 'otp_failed';
            if (otpAttempt < otpMaxAttempts) {
              payload.OTP_CODE = '';
              continue;
            }
            break;
          } else if (isPostAuthSuccessReason(postAuthResult.reason)) {
            terminalOutcome = 'authed';
            break;
          } else if (postAuthResult.status === 'timeout') {
            terminalOutcome = 'post_auth_timeout';
            break;
          } else if (actionResult.terminalOutcome) {
            terminalOutcome = actionResult.terminalOutcome;
            break;
          } else if (postOtpRuntime.stage?.state === 'otp_code') {
            terminalOutcome = 'need_otp';
            if (otpAttempt < otpMaxAttempts) {
              payload.OTP_CODE = '';
              continue;
            }
            break;
          } else if (actionResult.status === 'failed') {
            terminalOutcome = 'blocked_or_unknown';
            break;
          } else if (postOtpRuntime.stage?.state === 'blocked_or_unknown') {
            terminalOutcome = 'blocked_or_unknown';
            break;
          } else {
            terminalOutcome = '';
            break;
          }
        } else {
          recordEvent('runtime_action_skipped', {
            actionIndex: otpActionIndex,
            attempt: otpAttempt,
            reason: actionPlan.reason || 'otp_wait_plan_not_submit_otp',
            detail: actionPlan.detail || {},
            source: 'otp_wait',
          });
          break;
        }
      }
    }

    if (workflowPhase === '1' && terminalOutcome === 'need_otp' && session?.connect) {
      const checkpointPayload = buildCheckpoint({
        customerId,
        outcome: 'need_otp',
        targetUrl,
        currentUrl: page.url(),
        pageTitle: await page.title(),
        session,
        runDir: outputDir,
      });
      fs.writeFileSync(outputCheckpointPath, JSON.stringify(checkpointPayload, null, 2));
      checkpointWrittenPath = outputCheckpointPath;
      recordEvent('checkpoint_written', {
        checkpointPath: outputCheckpointPath,
        outcome: checkpointPayload.outcome,
        session: {
          id: checkpointPayload.session.id,
          hasConnect: Boolean(checkpointPayload.session.connect),
          hasStop: Boolean(checkpointPayload.session.stop),
        },
      });
    }

    if (terminalOutcome === 'authed') {
      await waitForPageReady(page, {
        timeout: Math.min(waitMs, 15000),
        renderWaitMs: 1000,
      }).catch(() => {});
      const authenticatedCapture = await capture(page, 'authenticated');
      const authenticatedRuntime = await collectRuntimeInventory(
        page,
        'authenticated',
        authenticatedCapture.snapshot
      );
      postActionStage = authenticatedRuntime.stage;
      postActionInventoryMetrics = authenticatedRuntime.metrics;
      finalStage = authenticatedRuntime.stage;
      finalInventoryMetrics = authenticatedRuntime.metrics;

      if (workflowPhase === '1' && session?.connect) {
        const currentUrl = page.url();
        const currentTitle = await page.title().catch(() => '');
        const checkpointPayload = buildCheckpoint({
          customerId,
          outcome: 'authed',
          targetUrl,
          currentUrl,
          pageTitle: currentTitle,
          session,
          runDir: outputDir,
          authenticated: {
            url: currentUrl,
            title: currentTitle,
          },
        });
        fs.writeFileSync(outputCheckpointPath, JSON.stringify(checkpointPayload, null, 2));
        checkpointWrittenPath = outputCheckpointPath;
        recordEvent('checkpoint_written', {
          checkpointPath: outputCheckpointPath,
          outcome: checkpointPayload.outcome,
          authenticated: checkpointPayload.authenticated,
          session: {
            id: checkpointPayload.session.id,
            hasConnect: Boolean(checkpointPayload.session.connect),
            hasStop: Boolean(checkpointPayload.session.stop),
          },
        });
      }
    }

    if (terminalOutcome === 'authed' && sessionKeepAliveMs > 0) {
      recordEvent('keep_alive_start', {
        durationMs: sessionKeepAliveMs,
        reason: 'authed',
        url: page.url(),
        title: await page.title().catch(() => ''),
      });
      await page.waitForTimeout(sessionKeepAliveMs);
      recordEvent('keep_alive_complete', {
        durationMs: sessionKeepAliveMs,
        url: page.url(),
        title: await page.title().catch(() => ''),
      });
    }
  } finally {
    samplerStopped = true;
    if (sampler) {
      clearInterval(sampler);
    }
    if (cdp) {
      await cdp.detach().catch(() => {});
    }
    if (browser) {
      if (session?.connect && typeof browser.disconnect === 'function') {
        browser.disconnect();
      } else {
        await browser.close().catch(() => {});
      }
    }
  }

  const summary = {
    checkedAt: new Date().toISOString(),
    customerId,
    targetUrl,
    route,
    requestedConnectionMode,
    connectionMode,
    cdpConnectionKind,
    solveCaptchas,
    captchaSolveMode,
    endpoint: endpointForLogs,
    outputDir,
    eventsPath,
    screenshotsDir,
    inventoriesDir,
    durationMs: elapsedMs(startedAtMs),
    workflow: {
      phase: workflowPhase,
      terminalOutcome: terminalOutcome || 'unknown',
      landingStage,
      postActionStage,
      finalStage,
      durationMs: elapsedMs(startedAtMs),
      checkpointPath: checkpointWrittenPath || checkpointPath || '',
    },
    cloudflare: {
      triggered: Boolean(captchaState.firstSeenAt),
      triggerSource: captchaState.browserless.found
        ? 'browserless_event'
        : captchaState.dom.challengeSeen
          ? 'dom_snapshot'
          : '',
      firstSeenOffsetMs: captchaState.firstSeenOffsetMs,
      resolved: Boolean(captchaState.resolvedAt),
      resolvedOffsetMs: captchaState.resolvedOffsetMs,
      visibleToResolvedMs:
        captchaState.firstSeenOffsetMs != null &&
        captchaState.resolvedOffsetMs != null
          ? captchaState.resolvedOffsetMs - captchaState.firstSeenOffsetMs
          : null,
      browserlessSolveFailed: captchaState.browserless.solveFailed === true,
    },
    milestones,
    durations: {
      landingToObserveStartMs:
        milestones.initialPageLoadedOffsetMs != null &&
        milestones.observeStartedOffsetMs != null
          ? milestones.observeStartedOffsetMs - milestones.initialPageLoadedOffsetMs
          : null,
      actionMs:
        actionResult && Number.isFinite(Number(actionResult.durationMs))
          ? Number(actionResult.durationMs)
          : null,
      totalActionMs: actions.reduce(
        (total, item) => total + Number(item.result?.durationMs || 0),
        0
      ),
      observeMs:
        milestones.observeStartedOffsetMs != null &&
        milestones.observeFinishedOffsetMs != null
          ? milestones.observeFinishedOffsetMs - milestones.observeStartedOffsetMs
          : null,
      captchaVisibleToResolvedMs:
        milestones.captchaFirstSeenOffsetMs != null &&
        milestones.captchaResolvedOffsetMs != null
          ? milestones.captchaResolvedOffsetMs - milestones.captchaFirstSeenOffsetMs
          : null,
    },
    captcha: {
      seen: Boolean(captchaState.firstSeenAt),
      resolved: Boolean(captchaState.resolvedAt),
      resolutionSource: captchaState.resolutionSource || '',
      resolutionEvidence: captchaState.resolutionEvidence || '',
      browserless: captchaState.browserless,
      dom: captchaState.dom,
      manualSolver: manualCaptchaSolver ? manualCaptchaSolver.toSummary() : null,
    },
    login: {
      status: actionResult?.status || 'not_attempted',
      reason:
        actionResult?.reason ||
        actionResult?.error ||
        'Identifier action flow completed or was not applicable.',
      landingStage,
      postActionStage,
      finalStage,
      terminalOutcome: terminalOutcome || '',
      actionPlan,
      actionResult,
      actions,
    },
    runtimeInventory: {
      landing: landingInventoryMetrics,
      postAction: postActionInventoryMetrics,
      final: finalInventoryMetrics,
    },
    eventCount: events.length,
  };

    fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
    console.log(`Summary: ${summaryPath}`);
    console.log(
      JSON.stringify(
        {
          targetUrl,
          workflow: summary.workflow,
          cloudflare: summary.cloudflare,
          captcha: summary.captcha,
          landingStage,
          postActionStage,
          finalStage,
          actionResult,
          runtimeInventory: summary.runtimeInventory,
          inventoriesDir,
          screenshotsDir,
        },
        null,
        2
      )
    );
  }
}

async function main() {
  const runner = new LoginWorkflowRunner();
  return runner.run();
}

export {
  LoginWorkflowRunner,
  main,
  toSafeError,
  parseWorkflowPhase,
  resolveLoginConnection as resolveConnection,
  buildCheckpoint,
  normalizeSessionPayload,
  waitForOtpCode,
  deriveExpectedPostAuthPath,
  resolveResumeTargetUrl,
  shouldResumeAfterObserve,
  shouldWaitForOtpFromFile,
  pathMatchesExpected,
  isPostAuthSuccessReason,
};
