const crypto = require('crypto');

const {
  PuppeteerKeepAliveProbe,
  buildProbeCheckpoint,
} = require('../puppeteer/keepalive-probe');
const { LoginRun } = require('../../login/login-run');

const CUSTOMER_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function toInt(value, fallback, minimum = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(minimum, Math.trunc(parsed));
}

function createHttpError(statusCode, message) {
  const error = new Error(message);
  error.statusCode = statusCode;
  return error;
}

function normalizeRequiredString(value, fieldName) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw createHttpError(400, `${fieldName} is required.`);
  }
  return normalized;
}

function assertCustomerId(value) {
  const customerId = normalizeRequiredString(value, 'customerId');
  if (!CUSTOMER_ID_PATTERN.test(customerId)) {
    throw createHttpError(400, 'Invalid customerId format.');
  }
  return customerId;
}

function createRunId() {
  if (typeof crypto.randomUUID === 'function') {
    return `login_${crypto.randomUUID().replace(/-/g, '')}`;
  }
  return `login_${crypto.randomBytes(16).toString('hex')}`;
}

function stageState(result = {}) {
  return String(
    result.workflow?.finalStage?.state ||
      result.workflow?.postActionStage?.state ||
      result.capture?.stage?.state ||
      ''
  ).trim();
}

function isAuthedResult(result = {}) {
  return (
    String(result.workflow?.terminalOutcome || '') === 'authed' ||
    stageState(result) === 'authed'
  );
}

function isNeedOtpResult(result = {}) {
  const terminalOutcome = String(result.workflow?.terminalOutcome || '');
  const state = stageState(result);
  return terminalOutcome === 'need_otp' || state === 'otp_code';
}

function sanitizeStage(stage) {
  if (!stage || typeof stage !== 'object') {
    return null;
  }
  const sanitized = {
    state: String(stage.state || ''),
    phase: String(stage.phase || ''),
    reason: String(stage.reason || ''),
  };
  if (stage.selector) {
    sanitized.selector = String(stage.selector);
  }
  return sanitized;
}

function sanitizeProbeResult(result = {}) {
  return {
    phase: String(result.phase || ''),
    targetUrl: String(result.targetUrl || ''),
    currentUrl: String(result.currentUrl || ''),
    pageTitle: String(result.pageTitle || ''),
    terminalOutcome: String(result.workflow?.terminalOutcome || ''),
    stage: sanitizeStage(
      result.workflow?.finalStage ||
        result.workflow?.postActionStage ||
        result.capture?.stage
    ),
    session: {
      id: String(result.session?.id || ''),
      ttlMs: toInt(result.session?.ttlMs, 0, 0),
      processKeepAliveMs: toInt(result.session?.processKeepAliveMs, 0, 0),
      created: result.sessionCreated === true,
    },
  };
}

function buildCheckpointFromResult(result = {}) {
  return buildProbeCheckpoint({
    phase: result.phase,
    targetUrl: result.targetUrl,
    currentUrl: result.currentUrl,
    pageTitle: result.pageTitle,
    detachedAt: result.detachedAt,
    observed: result.observed,
    stage: result.capture?.stage || null,
    session: result.session,
    runDir: '',
  });
}

function publicRun(run) {
  return run.toPublicJson();
}

function createLoginRunService(options = {}) {
  const probe = options.probe || new PuppeteerKeepAliveProbe(options.probeOptions || {});
  const now = options.now || (() => new Date().toISOString());
  const idFactory = options.idFactory || createRunId;
  const runs = new Map();
  const subscribers = new Map();
  const connectTimeoutMs = options.connectTimeoutMs || process.env.SESSION_API_CONNECT_TIMEOUT_MS;
  const waitMs = options.waitMs || process.env.PUPPETEER_KEEPALIVE_WAIT_MS || 5000;
  const maxActions = options.maxActions || process.env.LOGIN_WORKFLOW_MAX_ACTIONS || 8;
  const actionWaitMs = options.actionWaitMs || process.env.LOGIN_WORKFLOW_ACTION_WAIT_MS || 5000;
  const ttlMs = options.ttlMs || process.env.SESSION_API_TTL_MS;
  const processKeepAliveMs =
    options.processKeepAliveMs || process.env.SESSION_API_PROCESS_KEEP_ALIVE_MS;

  function getRunOrThrow(runId) {
    const run = runs.get(String(runId || '').trim());
    if (!run) {
      throw createHttpError(404, 'Login run not found.');
    }
    return run;
  }

  function emit(run, type) {
    const event = {
      type,
      data: publicRun(run),
    };
    const listeners = subscribers.get(run.runId);
    if (!listeners) {
      return;
    }
    for (const listener of listeners) {
      listener(event);
    }
  }

  function finishFromResult(run, result) {
    const checkpoint = buildCheckpointFromResult(result);
    const sanitizedResult = sanitizeProbeResult(result);

    if (isAuthedResult(result)) {
      run.markSucceeded(now(), sanitizedResult, checkpoint);
      emit(run, 'login.completed');
      return;
    }

    if (isNeedOtpResult(result)) {
      run.markWaitingForOtp(now(), sanitizedResult, checkpoint);
      emit(run, 'login.waiting_input');
      return;
    }

    run.markFailed(
      now(),
      {
        message: 'Login automation did not reach an authenticated or OTP state.',
        stage: sanitizedResult.stage,
      },
      {
        result: sanitizedResult,
        checkpoint,
      }
    );
    emit(run, 'login.failed');
  }

  async function runPhase1(run, input) {
    try {
      const result = await probe.run({
        phase: 'bootstrap',
        targetUrl: input.targetUrl,
        ttlMs,
        processKeepAliveMs,
        connectTimeoutMs,
        waitMs,
        workflowEnabled: true,
        maxActions,
        actionWaitMs,
        payload: {
          LOGIN_USERNAME: input.username,
          LOGIN_PASSWORD: input.password,
          OTP_DELIVERY_SELECTION: input.otpDeliverySelection || 'email',
          OTP_CODE: '',
        },
      });
      finishFromResult(run, result);
    } catch (error) {
      run.markFailed(
        now(),
        {
          message: String(error?.message || error || 'unknown_error'),
        },
        {
          result: null,
        }
      );
      emit(run, 'login.failed');
    } finally {
      run.setActiveTask(null);
    }
  }

  async function runPhase2(run, code) {
    try {
      const result = await probe.run({
        phase: 'reconnect',
        checkpoint: run.getCheckpoint(),
        ttlMs,
        processKeepAliveMs,
        connectTimeoutMs,
        waitMs,
        workflowEnabled: true,
        maxActions,
        actionWaitMs,
        payload: {
          LOGIN_USERNAME: '',
          LOGIN_PASSWORD: '',
          OTP_DELIVERY_SELECTION: 'email',
          OTP_CODE: code,
        },
      });
      finishFromResult(run, result);
    } catch (error) {
      run.markFailed(
        now(),
        {
          message: String(error?.message || error || 'unknown_error'),
        },
        {
          result: null,
        }
      );
      emit(run, 'login.failed');
    } finally {
      run.setActiveTask(null);
    }
  }

  function startLogin(input = {}) {
    const customerId = assertCustomerId(input.customerId);
    const targetUrl = normalizeRequiredString(input.targetUrl, 'targetUrl');
    const username = normalizeRequiredString(input.username, 'username');
    const password = normalizeRequiredString(input.password, 'password');
    const runId = idFactory();
    const timestamp = now();
    const run = new LoginRun({
      runId,
      customerId,
      targetUrl,
      now: timestamp,
    });

    runs.set(runId, run);
    run.setActiveTask(
      runPhase1(run, {
        targetUrl,
        username,
        password,
        otpDeliverySelection: String(input.otpDeliverySelection || 'email').trim() || 'email',
      })
    );
    emit(run, 'login.updated');

    return publicRun(run);
  }

  function submitOtp(runId, input = {}) {
    const run = getRunOrThrow(runId);
    const code = normalizeRequiredString(input.code, 'code');

    if (run.getStatus() === 'running') {
      throw createHttpError(409, 'Login run is already running.');
    }
    if (run.getStatus() !== 'waiting_input' || run.getState() !== 'need_otp') {
      throw createHttpError(409, 'Login run is not waiting for OTP.');
    }
    if (!run.getCheckpoint()?.session?.connect) {
      throw createHttpError(409, 'Login run is missing a resumable session checkpoint.');
    }

    run.markRunning(now(), {
      error: null,
    });
    emit(run, 'login.updated');
    run.setActiveTask(runPhase2(run, code));

    return publicRun(run);
  }

  function getRun(runId) {
    return publicRun(getRunOrThrow(runId));
  }

  function subscribe(runId, listener) {
    const run = getRunOrThrow(runId);
    const listeners = subscribers.get(run.runId) || new Set();
    listeners.add(listener);
    subscribers.set(run.runId, listeners);
    listener({
      type: 'login.updated',
      data: publicRun(run),
    });

    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) {
        subscribers.delete(run.runId);
      }
    };
  }

  async function whenSettled(runId) {
    const run = getRunOrThrow(runId);
    const task = run.getActiveTask();
    if (task) {
      await task;
    }
    return publicRun(run);
  }

  async function close() {
    await Promise.allSettled(
      Array.from(runs.values())
        .map(run => run.getActiveTask())
        .filter(Boolean)
    );
    subscribers.clear();
  }

  return {
    startLogin,
    submitOtp,
    getRun,
    subscribe,
    whenSettled,
    close,
  };
}

module.exports = {
  createLoginRunService,
  publicRun,
};
