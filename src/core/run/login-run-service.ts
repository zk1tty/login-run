import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

import { LoginRun } from '../../login/login-run';
import type {
  LoginEvent,
  LoginEventListener,
  LoginRunCheckpoint,
  LoginRunLifecycleEventType,
  LoginRunListResponse,
  LoginRunService,
  LoginScreenshotEvent,
  LoginScreenshotArtifactFile,
  LoginScreenshotArtifactList,
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
const { redactUrlSecretParams } = require('../browserless/browserless-session') as {
  redactUrlSecretParams: (urlString: string | null | undefined) => string;
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
  reconnectWaitMs?: string | number;
  maxActions?: string | number;
  actionWaitMs?: string | number;
  logsRoot?: string;
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
  observed?: unknown;
  measurement?: unknown;
  runtime?: unknown;
  endpointForLogs?: unknown;
}

interface RunArtifactPaths {
  runDir: string;
  summaryPath: string;
  checkpointPath: string;
  eventsPath: string;
  screenshotsDir: string;
  inventoriesDir: string;
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

function sanitizeErrorMessage(value: unknown): string {
  const message = toStringValue((value as { message?: unknown })?.message || value);
  return message.replace(
    /\b(?:wss?|https?):\/\/[^\s"'<>]+/gi,
    match => redactUrlSecretParams(match)
  );
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
  const timestamp = new Date().toISOString().replace(/[-:.]/g, '');
  return `login_${timestamp}_${randomBytes(4).toString('hex')}`;
}

function safePathSegment(value: string, fallback: string): string {
  const normalized = value.trim().replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function isSafeArtifactFileName(value: unknown): value is string {
  const fileName = String(value || '').trim();
  return /^[A-Za-z0-9._-]+\.png$/.test(fileName) && !fileName.includes('..');
}

function labelFromScreenshotFile(fileName: string): string {
  return fileName
    .replace(/^\d+-/, '')
    .replace(/\.png$/i, '')
    .replace(/[-_]+/g, ' ')
    .trim() || fileName;
}

function sequenceFromScreenshotFile(fileName: string): number {
  const match = fileName.match(/^(\d+)-/);
  return match ? toInt(match[1], 0, 0) : 0;
}

function toTimestampMs(value: unknown): number {
  const parsed = Date.parse(toStringValue(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function appendJsonLine(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
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
  const artifacts = new Map<string, RunArtifactPaths>();

  const connectTimeoutMs = options.connectTimeoutMs || process.env.SESSION_API_CONNECT_TIMEOUT_MS;
  const waitMs = options.waitMs || process.env.PUPPETEER_KEEPALIVE_WAIT_MS || 5000;
  const reconnectWaitMs = options.reconnectWaitMs || process.env.LOGIN_RECONNECT_WAIT_MS || 1000;
  const maxActions = options.maxActions || process.env.LOGIN_WORKFLOW_MAX_ACTIONS || 8;
  const actionWaitMs = options.actionWaitMs || process.env.LOGIN_WORKFLOW_ACTION_WAIT_MS || 5000;
  const ttlMs = options.ttlMs || process.env.SESSION_API_TTL_MS;
  const processKeepAliveMs =
    options.processKeepAliveMs || process.env.SESSION_API_PROCESS_KEEP_ALIVE_MS;
  const logsRoot = path.resolve(options.logsRoot || process.env.RUN_LOGS_ROOT || '.log');

  function createRunArtifacts(run: LoginRun): RunArtifactPaths {
    const customerSegment = safePathSegment(run.customerId, 'unknown-customer');
    const runSegment = safePathSegment(run.runId, 'unknown-run');
    const runDir = path.join(logsRoot, customerSegment, 'api-login-runs', runSegment);
    const paths = {
      runDir,
      summaryPath: path.join(runDir, 'summary.json'),
      checkpointPath: path.join(runDir, 'checkpoint.json'),
      eventsPath: path.join(runDir, 'events.jsonl'),
      screenshotsDir: path.join(runDir, 'screenshots'),
      inventoriesDir: path.join(runDir, 'inventories'),
    };

    fs.mkdirSync(paths.screenshotsDir, { recursive: true });
    fs.mkdirSync(paths.inventoriesDir, { recursive: true });
    artifacts.set(run.runId, paths);

    return paths;
  }

  function getRunOrThrow(runId: unknown): LoginRun {
    const key = toStringValue(runId);
    const run = runs.get(key);
    if (!run) {
      throw createHttpError(404, 'Login run not found.');
    }

    return run;
  }

  function notifySubscribers(run: LoginRun, event: LoginEvent): void {
    const listeners = subscribers.get(run.runId);
    if (!listeners) {
      return;
    }

    for (const listener of listeners) {
      listener(event);
    }
  }

  function emit(run: LoginRun, type: LoginRunLifecycleEventType): void {
    const event: LoginEvent = {
      type,
      data: publicRun(run),
    };

    recordServiceEvent(run, type, {
      status: event.data.status,
      state: event.data.state,
      nextActions: event.data.nextActions,
    });
    writeRunSummary(run);
    notifySubscribers(run, event);
  }

  function buildScreenshotEvent(
    run: LoginRun,
    phase: string,
    at: string,
    detail: UnknownRecord
  ): LoginScreenshotEvent | null {
    const screenshotPath = toStringValue(detail.screenshotPath);
    if (!screenshotPath) {
      return null;
    }

    const fileName = path.basename(screenshotPath);
    if (!isSafeArtifactFileName(fileName)) {
      return null;
    }

    return {
      type: 'login.screenshot',
      data: {
        runId: run.runId,
        phase,
        fileName,
        label: toStringValue(detail.label) || labelFromScreenshotFile(fileName),
        createdAt: at,
        sequence: sequenceFromScreenshotFile(fileName),
        url: `/v1/logins/${encodeURIComponent(run.runId)}/artifacts/screenshots/${encodeURIComponent(fileName)}`,
      },
    };
  }

  function recordServiceEvent(run: LoginRun, name: string, detail: UnknownRecord = {}): void {
    const paths = artifacts.get(run.runId);
    if (!paths) {
      return;
    }

    appendJsonLine(paths.eventsPath, {
      at: now(),
      name,
      detail,
    });
  }

  function recordProbeEvent(run: LoginRun, phase: string, name: string, detail: UnknownRecord = {}): void {
    const paths = artifacts.get(run.runId);
    if (!paths) {
      return;
    }

    const at = now();
    appendJsonLine(paths.eventsPath, {
      at,
      name,
      phase,
      detail,
    });

    if (name === 'screenshot') {
      const event = buildScreenshotEvent(run, phase, at, detail);
      if (event) {
        notifySubscribers(run, event);
      }
    }
  }

  function writeRunSummary(run: LoginRun, extra: UnknownRecord = {}): void {
    const paths = artifacts.get(run.runId);
    if (!paths) {
      return;
    }

    const checkpoint = run.getCheckpoint();
    const payload = {
      checkedAt: now(),
      run: publicRun(run),
      artifacts: {
        runDir: paths.runDir,
        eventsPath: paths.eventsPath,
        summaryPath: paths.summaryPath,
        checkpointPath: paths.checkpointPath,
        screenshotsDir: paths.screenshotsDir,
        inventoriesDir: paths.inventoriesDir,
      },
      ...extra,
    };

    fs.writeFileSync(paths.summaryPath, JSON.stringify(payload, null, 2));
    if (checkpoint) {
      fs.writeFileSync(paths.checkpointPath, JSON.stringify(checkpoint, null, 2));
    }
  }

  function nextScreenshotSequence(paths: RunArtifactPaths | undefined): number {
    if (!paths || !fs.existsSync(paths.screenshotsDir)) {
      return 1;
    }

    return fs.readdirSync(paths.screenshotsDir).filter(isSafeArtifactFileName).length + 1;
  }

  function readScreenshotEventTimes(paths: RunArtifactPaths): Map<string, string> {
    const timestamps = new Map<string, string>();
    if (!fs.existsSync(paths.eventsPath)) {
      return timestamps;
    }

    const lines = fs.readFileSync(paths.eventsPath, 'utf8').split('\n').filter(Boolean);
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as UnknownRecord;
        if (event.name !== 'screenshot') {
          continue;
        }
        const detail = asRecord(event.detail);
        const screenshotPath = toStringValue(detail.screenshotPath);
        if (!screenshotPath) {
          continue;
        }
        timestamps.set(path.basename(screenshotPath), toStringValue(event.at));
      } catch {
        // Ignore partial or malformed JSONL lines; file mtime remains the fallback.
      }
    }

    return timestamps;
  }

  function listScreenshots(runId: string): LoginScreenshotArtifactList {
    const run = getRunOrThrow(runId);
    const paths = artifacts.get(run.runId);
    if (!paths) {
      return {
        runId: run.runId,
        screenshots: [],
      };
    }

    const eventTimes = readScreenshotEventTimes(paths);
    const screenshots = fs.existsSync(paths.screenshotsDir)
      ? fs.readdirSync(paths.screenshotsDir)
          .filter(isSafeArtifactFileName)
          .map(fileName => {
            const filePath = path.join(paths.screenshotsDir, fileName);
            const stat = fs.statSync(filePath);
            const createdAt = eventTimes.get(fileName) || stat.mtime.toISOString();
            return {
              fileName,
              label: labelFromScreenshotFile(fileName),
              createdAt,
              url: `/v1/logins/${encodeURIComponent(run.runId)}/artifacts/screenshots/${encodeURIComponent(fileName)}`,
            };
          })
          .sort((left, right) => {
            const timestampDelta = toTimestampMs(left.createdAt) - toTimestampMs(right.createdAt);
            if (timestampDelta !== 0) {
              return timestampDelta;
            }
            return left.fileName.localeCompare(right.fileName);
          })
      : [];

    return {
      runId: run.runId,
      screenshots,
    };
  }

  function getScreenshot(runId: string, fileName: string): LoginScreenshotArtifactFile {
    const run = getRunOrThrow(runId);
    if (!isSafeArtifactFileName(fileName)) {
      throw createHttpError(400, 'Invalid screenshot filename.');
    }

    const paths = artifacts.get(run.runId);
    if (!paths) {
      throw createHttpError(404, 'Screenshot not found.');
    }

    const filePath = path.join(paths.screenshotsDir, fileName);
    const resolvedPath = path.resolve(filePath);
    const resolvedRoot = path.resolve(paths.screenshotsDir);
    if (!resolvedPath.startsWith(`${resolvedRoot}${path.sep}`) || !fs.existsSync(resolvedPath)) {
      throw createHttpError(404, 'Screenshot not found.');
    }

    return {
      fileName,
      contentType: 'image/png',
      buffer: fs.readFileSync(resolvedPath),
    };
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
      const paths = artifacts.get(run.runId);
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
        screenshotsDir: paths?.screenshotsDir,
        inventoriesDir: paths?.inventoriesDir,
        artifactSequenceStart: nextScreenshotSequence(paths),
        recordEvent: (name: string, detail: UnknownRecord = {}) => recordProbeEvent(run, 'bootstrap', name, detail),
      }) as LoginRunServiceResult;
      finishFromResult(run, result);
    } catch (error: unknown) {
      run.markFailed(
        now(),
        {
          message: sanitizeErrorMessage(error),
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
      const paths = artifacts.get(run.runId);
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
        screenshotsDir: paths?.screenshotsDir,
        inventoriesDir: paths?.inventoriesDir,
        artifactSequenceStart: nextScreenshotSequence(paths),
        recordEvent: (name: string, detail: UnknownRecord = {}) => recordProbeEvent(run, 'reconnect', name, detail),
      }) as LoginRunServiceResult;
      finishFromResult(run, result);
    } catch (error: unknown) {
      run.markFailed(
        now(),
        {
          message: sanitizeErrorMessage(error),
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

  async function runReconnect(run: LoginRun): Promise<void> {
    try {
      const paths = artifacts.get(run.runId);
      const result = await probe.run({
        phase: 'reconnect',
        checkpoint: run.getCheckpoint(),
        ttlMs,
        processKeepAliveMs,
        connectTimeoutMs,
        waitMs: reconnectWaitMs,
        workflowEnabled: false,
        maxActions: 0,
        actionWaitMs: 0,
        payload: {
          LOGIN_USERNAME: '',
          LOGIN_PASSWORD: '',
          OTP_DELIVERY_SELECTION: 'email',
          OTP_CODE: '',
        },
        screenshotsDir: paths?.screenshotsDir,
        inventoriesDir: paths?.inventoriesDir,
        artifactSequenceStart: nextScreenshotSequence(paths),
        recordEvent: (name: string, detail: UnknownRecord = {}) => recordProbeEvent(run, 'reconnect', name, detail),
      }) as LoginRunServiceResult;
      finishFromResult(run, result);
    } catch (error: unknown) {
      run.markFailed(
        now(),
        {
          message: sanitizeErrorMessage(error),
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
    const paths = createRunArtifacts(run);
    writeRunSummary(run, {
      artifactCreatedAt: timestamp,
    });
    recordServiceEvent(run, 'login.run_created', {
      runDir: paths.runDir,
    });
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

  function reconnect(runId: string): PublicLoginRun {
    const run = getRunOrThrow(runId);

    if (run.getStatus() === 'running') {
      throw createHttpError(409, 'Login run is already running.');
    }
    if (!run.getCheckpoint()?.session?.connect) {
      throw createHttpError(409, 'Login run is missing a resumable session checkpoint.');
    }

    run.markRunning(now(), {
      error: null,
    });
    emit(run, 'login.updated');
    run.setActiveTask(runReconnect(run));

    return publicRun(run);
  }

  function listRuns(): LoginRunListResponse {
    const sortedRuns = Array.from(runs.values())
      .map(publicRun)
      .sort((left, right) => toTimestampMs(right.createdAt) - toTimestampMs(left.createdAt));

    return {
      runs: sortedRuns,
    };
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
    for (const screenshot of listScreenshots(run.runId).screenshots) {
      listener({
        type: 'login.screenshot',
        data: {
          runId: run.runId,
          phase: 'replay',
          fileName: screenshot.fileName,
          label: screenshot.label,
          createdAt: screenshot.createdAt,
          sequence: sequenceFromScreenshotFile(screenshot.fileName),
          url: screenshot.url,
        },
      });
    }

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
    reconnect,
    listRuns,
    getRun,
    listScreenshots,
    getScreenshot,
    subscribe,
    whenSettled,
    close,
  };
}
