import { randomBytes, randomUUID } from 'node:crypto';

import { LoginRun } from '../../login/login-run';
import type {
  LoginEvent,
  LoginEventListener,
  LoginRunCheckpoint,
  LoginRunService,
  PublicLoginRun,
  SanitizedLoginError,
  SanitizedLoginResult,
  StartLoginRequest,
  SubmitOtpRequest,
} from '../../login/login-types';

type UnknownRecord = Record<string, unknown>;

type LoginRunServiceProbe = {
  run(input: UnknownRecord): Promise<UnknownRecord>;
};

const { PuppeteerKeepAliveProbe, buildProbeCheckpoint } = require('../puppeteer/keepalive-probe') as {
  PuppeteerKeepAliveProbe: new (input?: UnknownRecord) => LoginRunServiceProbe;
  buildProbeCheckpoint: (input: UnknownRecord) => LoginRunCheckpoint;
};

interface LoginRunServiceOptions {
  probe?: LoginRunServiceProbe;
  probeOptions?: UnknownRecord;
  now?: () => string;
  idFactory?: () => string;
  ttlMs?: string | number;
  processKeepAliveMs?: string | number;
  connectTimeoutMs?: string | number;
  waitMs?: string | number;
  maxActions?: string | number;
  actionWaitMs?: string | number;
}

interface ProbeInput {
  phase?: string;
  targetUrl?: string;
  checkpoint?: LoginRunCheckpoint | null;
  ttlMs?: string | number;
  processKeepAliveMs?: string | number;
  connectTimeoutMs?: string | number;
  waitMs?: string | number;
  workflowEnabled?: boolean;
  maxActions?: string | number;
  actionWaitMs?: string | number;
  payload?: UnknownRecord;
}

interface HttpError extends Error {
  statusCode: number;
}

interface LoginRunServiceResult {
  session?: {
    id?: unknown;
    ttlMs?: unknown;
    processKeepAliveMs?: unknown;
  };
  sessionCreated?: unknown;
  phase?: unknown;
  targetUrl?: unknown;
  currentUrl?: unknown;
  pageTitle?: unknown;
  detachedAt?: unknown;
  workflow?: UnknownRecord;
  capture?: UnknownRecord;
}

const CUSTOMER_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function toInt(value: unknown, fallback: number, minimum = 0): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(minimum, Math.trunc(parsed));
}

function toStringValue(value: unknown): string {
  return String((value as { toString?: () => string })?.toString?.() || value || '').trim();
}

function asRecord(value: unknown): UnknownRecord {
  if (value && typeof value === 'object') {
    return value as UnknownRecord;
  }
  return {};
}

function createHttpError(statusCode: number, message: string): HttpError {
  const error = new Error(message) as HttpError;
  error.statusCode = statusCode;
  return error;
}

function normalizeRequiredString(value: unknown, fieldName: string): string {
  const normalized = toStringValue(value);
  if (!normalized) {
    throw createHttpError(400, `${fieldName} is required.`);
  }
  return normalized;
}

function assertCustomerId(value: unknown): string {
  const customerId = normalizeRequiredString(value, 'customerId');
  if (!CUSTOMER_ID_PATTERN.test(customerId)) {
    throw createHttpError(400, 'Invalid customerId format.');
  }

  return customerId;
}

function createRunId(): string {
  if (typeof randomUUID === 'function') {
    return `login_${randomUUID().replace(/-/g, '')}`;
  }

  return `login_${randomBytes(16).toString('hex')}`;
}

function stageState(result: LoginRunServiceResult): string {
  const workflow = asRecord(result.workflow);
  const capture = asRecord(result.capture);
  return toStringValue(
    asRecord(workflow.finalStage).state ||
      asRecord(workflow.postActionStage).state ||
      asRecord(capture.stage).state
  );
}

function isAuthedResult(result: LoginRunServiceResult): boolean {
  const workflow = asRecord(result.workflow);
  return toStringValue(workflow.terminalOutcome) === 'authed' || stageState(result) === 'authed';
}

function isNeedOtpResult(result: LoginRunServiceResult): boolean {
  const workflow = asRecord(result.workflow);
  const terminalOutcome = toStringValue(workflow.terminalOutcome);
  const state = stageState(result);
  return terminalOutcome === 'need_otp' || state === 'otp_code';
}

function sanitizeStage(stage: unknown): SanitizedLoginResult['stage'] {
  if (!stage || typeof stage !== 'object') {
    return null;
  }

  const target = asRecord(stage);
  const sanitized: NonNullable<SanitizedLoginResult['stage']> = {
    state: toStringValue(target.state),
    phase: toStringValue(target.phase),
    reason: toStringValue(target.reason),
  };

  if (Object.prototype.hasOwnProperty.call(target, 'selector')) {
    sanitized.selector = toStringValue(target.selector);
  }

  return sanitized;
}

function sanitizeProbeResult(result: LoginRunServiceResult): SanitizedLoginResult {
  const workflow = asRecord(result.workflow);
  const capture = asRecord(result.capture);

  return {
    phase: toStringValue(result.phase),
    targetUrl: toStringValue(result.targetUrl),
    currentUrl: toStringValue(result.currentUrl),
    pageTitle: toStringValue(result.pageTitle),
    terminalOutcome: toStringValue(workflow.terminalOutcome),
    stage: sanitizeStage(
      asRecord(workflow.finalStage).state !== undefined
        ? workflow.finalStage
        : asRecord(workflow.postActionStage).state !== undefined
          ? workflow.postActionStage
          : capture.stage
    ),
    session: {
      id: toStringValue(asRecord(result.session).id),
      ttlMs: toInt(asRecord(result.session).ttlMs, 0, 0),
      processKeepAliveMs: toInt(asRecord(result.session).processKeepAliveMs, 0, 0),
      created: result.sessionCreated === true,
    },
  };
}

function buildCheckpointFromResult(result: LoginRunServiceResult) {
  return buildProbeCheckpoint({
    phase: result.phase,
    targetUrl: result.targetUrl,
    currentUrl: result.currentUrl,
    pageTitle: result.pageTitle,
    detachedAt: result.detachedAt,
    observed: asRecord((result as UnknownRecord).observed),
    stage: result.capture && asRecord(result.capture).stage,
    session: result.session,
    runDir: '',
  });
}

function publicRun(run: LoginRun): PublicLoginRun {
  return run.toPublicJson();
}

/**
 * Internal adapter used by tests and app composition.
 */
export function createLoginRunService(options: LoginRunServiceOptions = {}): LoginRunService {
  const probe: LoginRunServiceProbe = options.probe || new PuppeteerKeepAliveProbe(options.probeOptions || {});

  const now = options.now || (() => new Date().toISOString());
  const idFactory = options.idFactory || createRunId;

  const runs = new Map<string, LoginRun>();
  const subscribers = new Map<string, Set<LoginEventListener>>();

  const connectTimeoutMs = options.connectTimeoutMs || process.env.SESSION_API_CONNECT_TIMEOUT_MS;
  const waitMs = options.waitMs || process.env.PUPPETEER_KEEPALIVE_WAIT_MS || 5000;
  const maxActions = options.maxActions || process.env.LOGIN_WORKFLOW_MAX_ACTIONS || 8;
  const actionWaitMs = options.actionWaitMs || process.env.LOGIN_WORKFLOW_ACTION_WAIT_MS || 5000;
  const ttlMs = options.ttlMs || process.env.SESSION_API_TTL_MS;
  const processKeepAliveMs =
    options.processKeepAliveMs || process.env.SESSION_API_PROCESS_KEEP_ALIVE_MS;

  function getRunOrThrow(runId: unknown): LoginRun {
    const key = toStringValue(runId);
    const run = runs.get(key);
    if (!run) {
      throw createHttpError(404, 'Login run not found.');
    }

    return run;
  }

  function emit(run: LoginRun, type: LoginEvent['type']): void {
    const event: LoginEvent = {
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

  function finishFromResult(run: LoginRun, result: LoginRunServiceResult): void {
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

  async function runPhase1(run: LoginRun, input: {
    targetUrl: string;
    username: string;
    password: string;
    otpDeliverySelection: string;
  }): Promise<void> {
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
      }) as LoginRunServiceResult;
      finishFromResult(run, result);
    } catch (error: unknown) {
      run.markFailed(
        now(),
        {
          message: toStringValue((error as { message?: unknown })?.message || error),
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

  async function runPhase2(run: LoginRun, code: string): Promise<void> {
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
      }) as LoginRunServiceResult;
      finishFromResult(run, result);
    } catch (error: unknown) {
      run.markFailed(
        now(),
        {
          message: toStringValue((error as { message?: unknown })?.message || error),
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

  function startLogin(input: StartLoginRequest): PublicLoginRun {
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
        otpDeliverySelection: toStringValue(input.otpDeliverySelection || 'email') || 'email',
      })
    );
    emit(run, 'login.updated');

    return publicRun(run);
  }

  function submitOtp(runId: string, input: SubmitOtpRequest): PublicLoginRun {
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

  function getRun(runId: string): PublicLoginRun {
    return publicRun(getRunOrThrow(runId));
  }

  function subscribe(runId: string, listener: LoginEventListener): () => void {
    const run = getRunOrThrow(runId);
    const listeners = subscribers.get(run.runId) || new Set<LoginEventListener>();

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

  async function whenSettled(runId: string): Promise<PublicLoginRun> {
    const run = getRunOrThrow(runId);
    const task = run.getActiveTask();
    if (task) {
      await task;
    }
    return publicRun(run);
  }

  async function close(): Promise<void> {
    const tasks = Array.from(runs.values())
      .map(currentRun => currentRun.getActiveTask())
      .filter((task): task is Promise<void> => task !== null);

    await Promise.allSettled(tasks);
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
