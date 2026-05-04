#!/usr/bin/env node

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const { runWsTrace } = require('../../../lib/ws-trace-runner');

const CONDITIONS = ['fresh', 'persistent'];
const DEFAULT_MANUAL_STEPS =
  '1) POST /admin/owners/:customerId/live-url/refresh 2) open LiveURL 3) solve challenge 4) rerun --manual-solve-complete';

function sanitizeTag(value, fallback = 'default') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function resolveUrlTag(targetUrl) {
  const value = String(targetUrl || '').trim();
  if (!value) {
    return 'any-url';
  }

  try {
    const parsed = new URL(value);
    const host = sanitizeTag(parsed.hostname, 'url');
    const pathname = sanitizeTag(parsed.pathname.replace(/\//g, '-'), '');
    const combined = [host, pathname].filter(Boolean).join('_');
    return combined || host;
  } catch (error) {
    return sanitizeTag(value, 'any-url');
  }
}

function resolveDefaultStudyRoot(customerId, proxyMode, targetUrl) {
  return path.resolve(
    path.join(
      '.log',
      customerId,
      'challenge-study',
      sanitizeTag(proxyMode || 'no-proxy', 'no-proxy'),
      resolveUrlTag(targetUrl)
    )
  );
}

function parseNumber(value, fallback, minimum = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(minimum, Math.trunc(parsed));
}

function parseBoolean(value, fallback) {
  if (value == null || value === '') {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function normalizeTurnstilePageType(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'waiting' || normalized === 'checkbox' || normalized === 'unknown') {
    return normalized;
  }
  return '';
}

function inferTurnstilePageTypeFromText(value) {
  const text = String(value || '').toLowerCase();
  if (!text) {
    return '';
  }
  if (text.includes('verify you are human') || text.includes('checkbox')) {
    return 'checkbox';
  }
  if (text.includes('just a moment') || text.includes('checking your browser')) {
    return 'waiting';
  }
  return '';
}

function extractTurnstileSnapshot(probe, fallbackPage = {}) {
  const probeState = String(probe?.state || '').trim().toLowerCase();
  const explicitHasTurnstile = probe?.hasTurnstile === true;
  const inferredHasTurnstile = probeState === 'challenge';
  const hasTurnstile = explicitHasTurnstile || inferredHasTurnstile;

  let pageType = normalizeTurnstilePageType(probe?.turnstilePageType);
  if (!pageType && hasTurnstile) {
    pageType =
      inferTurnstilePageTypeFromText(probe?.reason) ||
      inferTurnstilePageTypeFromText(probe?.title) ||
      inferTurnstilePageTypeFromText(fallbackPage?.title) ||
      inferTurnstilePageTypeFromText(probe?.url) ||
      inferTurnstilePageTypeFromText(fallbackPage?.url);
  }

  if (pageType === 'unknown' && !hasTurnstile) {
    pageType = '';
  }

  const hasTurnstileCheckbox =
    probe?.hasTurnstileCheckbox === true || pageType === 'checkbox';

  return {
    hasTurnstile,
    pageType,
    hasTurnstileCheckbox,
  };
}

function toIsoNow() {
  return new Date().toISOString();
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function buildUrl(baseUrl, routePath) {
  const base = new URL(String(baseUrl || '').trim() || 'http://127.0.0.1:8787');
  base.pathname = `${base.pathname.replace(/\/$/, '')}/${routePath.replace(/^\//, '')}`;
  return base.toString();
}

function loadJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }

  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function appendJsonLine(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function appendTurnstileTimelineEntries(filePath, events = []) {
  for (const event of events) {
    const pageStatus = String(event?.turnstilePageType || '').trim().toLowerCase();
    if (!['waiting', 'checkbox'].includes(pageStatus)) {
      continue;
    }

    const line = {
      timestamp: String(event.timestamp || ''),
      condition: String(event.condition || ''),
      pageStatus,
      source: String(event.phase || 'probe'),
      sessionId: String(event.sessionId || ''),
      pageUrl: String(event.pageUrl || ''),
      pageTitle: String(event.pageTitle || ''),
    };

    appendJsonLine(filePath, line);

    const wsTransitions = Array.isArray(event.wsTransitions) ? event.wsTransitions : [];
    for (const transition of wsTransitions) {
      const transitionStatus = String(transition?.turnstilePageType || '').trim().toLowerCase();
      const transitionState = String(transition?.state || '').trim().toLowerCase();
      if (transitionState !== 'challenge' || !['waiting', 'checkbox'].includes(transitionStatus)) {
        continue;
      }
      appendJsonLine(filePath, {
        timestamp: String(event.timestamp || ''),
        condition: String(event.condition || ''),
        pageStatus: transitionStatus,
        source: 'ws_transition',
        sessionId: String(event.sessionId || ''),
        pageUrl: String(transition.url || event.pageUrl || ''),
        pageTitle: String(transition.title || event.pageTitle || ''),
      });
    }
  }
}

function parseArgs(argv) {
  const args = {
    once: false,
    reset: false,
    condition: '',
    manualSolveStarted: false,
    manualSolveCompleted: false,
    manualSteps: '',
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const token = String(argv[i] || '').trim();
    if (token === '--once') {
      args.once = true;
      continue;
    }
    if (token === '--reset') {
      args.reset = true;
      continue;
    }
    if (token === '--manual-solve-start') {
      args.manualSolveStarted = true;
      continue;
    }
    if (token === '--manual-solve-complete') {
      args.manualSolveCompleted = true;
      continue;
    }
    if (token === '--help' || token === '-h') {
      args.help = true;
      continue;
    }
    if (token === '--condition') {
      args.condition = String(argv[i + 1] || '').trim().toLowerCase();
      i += 1;
      continue;
    }
    if (token === '--manual-steps') {
      args.manualSteps = String(argv[i + 1] || '').trim();
      i += 1;
      continue;
    }
  }

  return args;
}

function printHelp() {
  console.log(
    [
      'Challenge persistence study runner (URL-agnostic)',
      '',
      'Usage:',
      '  node scripts/run/session-api/any-url/challenge-study.js [--once] [--condition fresh|persistent]',
      '  node scripts/run/session-api/any-url/challenge-study.js --manual-solve-start [--manual-steps "..."]',
      '  node scripts/run/session-api/any-url/challenge-study.js --manual-solve-complete [--manual-steps "..."]',
      '  node scripts/run/session-api/any-url/challenge-study.js --reset',
      '  node scripts/run/session-api/any-url/challenge-study.js --reset --once',
      '',
      'Env:',
      '  BASE (default: http://127.0.0.1:8787)',
      '  CID (default: CUSTOMER_ID or danny)',
      '  BL_PROXY (required for proxy-mode study matrix)',
      '  URL (optional, preferred over CHALLENGE_STUDY_BOOTSTRAP_URL)',
      '  CHALLENGE_STUDY_INTERVAL_MINUTES (default: 10)',
      '  CHALLENGE_STUDY_MAX_HOURS (default: 24)',
      '  CHALLENGE_STUDY_WAITING_TO_CHECKBOX_TIMEOUT_MS (default: 20000)',
      '  CHALLENGE_STUDY_WAITING_TO_CHECKBOX_POLL_MS (default: 500)',
      '  CHALLENGE_STUDY_DIR (optional override; default includes proxy+url tags)',
      '  CHALLENGE_STUDY_BOOTSTRAP_URL (optional, attach bootstrap URL override)',
      '  WS_TRACE_ENABLED (default: true)',
      '  WS_TRACE_MS (default: 12000)',
      '  WS_MAX_MESSAGES (default: 300)',
      '  WS_CHECK_LIVE_URL_TIMEOUT_MS (default: 90000)',
      '  WS_SCREENSHOT_ENABLED (default: true)',
      '  WS_SCREENSHOT_INTERVAL_MS (default: 2000)',
      '  WS_SCREENSHOT_MAX (default: 120)',
      '  ADMIN_API_KEY (optional, sends x-admin-api-key header)',
    ].join('\n')
  );
}

function createConditionState(name) {
  return {
    name,
    startedAt: '',
    completedAt: '',
    stopReason: '',
    probeCount: 0,
    challengeProbeCount: 0,
    firstChallengeAt: '',
    firstChallengeSessionId: '',
    firstTurnstileAt: '',
    firstWaitingAt: '',
    firstCheckboxAt: '',
    firstNeedCredAt: '',
    waitingToCheckboxMs: 0,
    waitingToLoginMs: 0,
    waitingPhaseCount: 0,
    checkboxPhaseCount: 0,
    manualSolveStartedAt: '',
    manualSolveCompletedAt: '',
    manualSolveWaitMs: 0,
    reChallengeAt: '',
    sessionIds: [],
  };
}

function buildDefaultState(config) {
  return {
    version: 2,
    status: 'running',
    createdAt: toIsoNow(),
    updatedAt: toIsoNow(),
    customerId: config.customerId,
    target: config.proxyMode,
    proxyMode: config.proxyMode,
    targetUrl: config.targetUrl,
    baseUrl: config.baseUrl,
    intervalMinutes: config.intervalMinutes,
    maxHours: config.maxHours,
    sequence: CONDITIONS.slice(),
    conditions: {
      fresh: createConditionState('fresh'),
      persistent: createConditionState('persistent'),
    },
    currentCondition: 'fresh',
    completedAt: '',
  };
}

function normalizeState(existing, config) {
  const base = buildDefaultState(config);
  const merged = {
    ...base,
    ...(existing || {}),
    conditions: {
      fresh: {
        ...base.conditions.fresh,
        ...(existing?.conditions?.fresh || {}),
      },
      persistent: {
        ...base.conditions.persistent,
        ...(existing?.conditions?.persistent || {}),
      },
    },
  };
  merged.customerId = config.customerId;
  merged.target = config.proxyMode;
  merged.proxyMode = config.proxyMode;
  merged.targetUrl = config.targetUrl;
  merged.baseUrl = config.baseUrl;
  merged.intervalMinutes = config.intervalMinutes;
  merged.maxHours = config.maxHours;
  merged.sequence = CONDITIONS.slice();
  if (!CONDITIONS.includes(merged.currentCondition)) {
    merged.currentCondition = 'fresh';
  }
  return merged;
}

function activeConditionName(state, explicitCondition = '') {
  if (explicitCondition) {
    return explicitCondition;
  }

  for (const condition of CONDITIONS) {
    if (!state.conditions?.[condition]?.completedAt) {
      return condition;
    }
  }

  return '';
}

function markStudyCompleted(state, reason) {
  state.status = 'completed';
  state.completedAt = state.completedAt || toIsoNow();
  state.currentCondition = '';
  state.updatedAt = toIsoNow();
  if (reason) {
    return {
      phase: 'study_completed',
      reason,
    };
  }
  return null;
}

function markConditionCompleted(state, conditionName, reason) {
  const condition = state.conditions[conditionName];
  if (!condition.completedAt) {
    condition.completedAt = toIsoNow();
  }
  condition.stopReason = condition.stopReason || String(reason || '');

  const next = CONDITIONS.find(name => !state.conditions[name].completedAt);
  state.currentCondition = next || '';

  if (!next) {
    markStudyCompleted(state, 'all_conditions_completed');
  }
}

function pushUniqueSessionId(condition, sessionId) {
  const value = String(sessionId || '').trim();
  if (!value) {
    return;
  }

  if (!Array.isArray(condition.sessionIds)) {
    condition.sessionIds = [];
  }
  if (!condition.sessionIds.includes(value)) {
    condition.sessionIds.push(value);
  }
}

function buildBaseEvent(config, state, conditionName) {
  return {
    timestamp: toIsoNow(),
    phase: '',
    condition: conditionName || '',
    customerId: config.customerId,
    target: config.proxyMode,
    proxyMode: config.proxyMode,
    targetUrl: config.targetUrl,
    sessionId: '',
    challengeDetected: false,
    hasTurnstile: false,
    turnstilePageType: '',
    hasTurnstileCheckbox: false,
    waitingToCheckboxMs: 0,
    waitingToCheckboxObserved: false,
    probeState: '',
    probeReason: '',
    pageUrl: '',
    pageTitle: '',
    egressIp: '',
    attachDurationMs: 0,
    stateDurationMs: 0,
    refreshDurationMs: 0,
    baselineResetDurationMs: 0,
    baselineResetAttempted: false,
    attachForceNewSession: conditionName === 'fresh',
    manual_solve_wait_ms: 0,
    manual_steps: '',
    note: '',
    sequenceStatus: state.status,
    wsTracePath: '',
    wsState: '',
    wsTransitions: [],
    wsTransitionMetrics: null,
    wsScreenshotCount: 0,
    wsLiveOk: null,
    wsLiveError: '',
  };
}

async function callJson(config, method, routePath, body) {
  const url = buildUrl(config.baseUrl, routePath);
  const startedAt = Date.now();
  const headers = {
    'content-type': 'application/json',
  };
  if (config.adminApiKey) {
    headers['x-admin-api-key'] = config.adminApiKey;
  }
  const response = await fetch(url, {
    method,
    headers,
    body: body == null ? undefined : JSON.stringify(body),
  });
  const durationMs = Math.max(0, Date.now() - startedAt);
  const text = await response.text();
  let json;
  try {
    json = text ? JSON.parse(text) : {};
  } catch (error) {
    json = {
      status: 'error',
      message: `Invalid JSON response: ${text.slice(0, 400)}`,
    };
  }
  return {
    ok: response.ok,
    statusCode: response.status,
    json,
    durationMs,
    url,
  };
}

function assertConditionName(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!CONDITIONS.includes(normalized)) {
    throw new Error(`Invalid condition: ${value}`);
  }
  return normalized;
}

function updateConditionTurnstileState(condition, event) {
  if (!event.hasTurnstile) {
    return;
  }

  if (!condition.firstTurnstileAt) {
    condition.firstTurnstileAt = event.timestamp;
  }

  if (event.turnstilePageType === 'waiting') {
    condition.waitingPhaseCount += 1;
    if (!condition.firstWaitingAt) {
      condition.firstWaitingAt = event.timestamp;
    }
  }

  if (event.turnstilePageType === 'checkbox') {
    condition.checkboxPhaseCount += 1;
    if (!condition.firstCheckboxAt) {
      condition.firstCheckboxAt = event.timestamp;
    }
  }
}

function mergeWsTraceIntoEventAndCondition(condition, event, wsTraceResult) {
  if (!wsTraceResult || typeof wsTraceResult !== 'object') {
    return;
  }

  const wsState = wsTraceResult.pageStateFromLive || {};
  const wsMetrics = wsState.transitionMetrics || {};
  const wsTransitions = Array.isArray(wsState.transitions) ? wsState.transitions : [];

  event.wsTracePath = String(wsTraceResult.output?.messageFile || '').trim();
  event.wsState = String(wsState.state || '').trim();
  event.wsTransitions = wsTransitions;
  event.wsTransitionMetrics = wsMetrics && typeof wsMetrics === 'object' ? wsMetrics : null;
  event.wsScreenshotCount = Number(wsTraceResult.output?.screenshotCount || 0);
  event.wsLiveOk = wsTraceResult?.checks?.live?.ok === true;
  event.wsLiveError = String(wsTraceResult?.checks?.live?.error || '').trim();

  if (event.wsLiveOk === false && event.wsLiveError) {
    event.note = event.note
      ? `${event.note}; ws_live_failed:${event.wsLiveError}`
      : `ws_live_failed:${event.wsLiveError}`;
  }

  if (event.wsState === 'challenge') {
    event.challengeDetected = true;
    event.hasTurnstile = true;
    if (!event.turnstilePageType) {
      event.turnstilePageType = String(wsState.turnstilePageType || '').trim();
    }
    if (event.turnstilePageType === 'checkbox') {
      event.hasTurnstileCheckbox = true;
    }
  }

  if (!condition.firstWaitingAt && wsMetrics.firstWaitingAt) {
    condition.firstWaitingAt = event.timestamp;
  }
  if (!condition.firstCheckboxAt && wsMetrics.firstCheckboxAt) {
    condition.firstCheckboxAt = event.timestamp;
  }
  if (!condition.firstNeedCredAt && wsMetrics.firstNeedCredAt) {
    condition.firstNeedCredAt = event.timestamp;
  }

  if (event.wsState === 'need_cred' && !condition.firstNeedCredAt) {
    condition.firstNeedCredAt = event.timestamp;
  }

  if (
    Number.isFinite(Number(wsMetrics.waitingToCheckboxMs)) &&
    Number(wsMetrics.waitingToCheckboxMs) > 0
  ) {
    const value = Math.trunc(Number(wsMetrics.waitingToCheckboxMs));
    event.waitingToCheckboxMs = value;
    event.waitingToCheckboxObserved = true;
    if (!condition.waitingToCheckboxMs) {
      condition.waitingToCheckboxMs = value;
    }
  }

  if (
    Number.isFinite(Number(wsMetrics.waitingToLoginMs)) &&
    Number(wsMetrics.waitingToLoginMs) > 0 &&
    !condition.waitingToLoginMs
  ) {
    condition.waitingToLoginMs = Math.trunc(Number(wsMetrics.waitingToLoginMs));
  }
}

async function waitForCheckboxTransition(config, state, conditionName, waitingStartedAtMs) {
  const timeoutMs = parseNumber(
    process.env.CHALLENGE_STUDY_WAITING_TO_CHECKBOX_TIMEOUT_MS,
    20000,
    0
  );
  const pollMs = parseNumber(
    process.env.CHALLENGE_STUDY_WAITING_TO_CHECKBOX_POLL_MS,
    500,
    100
  );

  if (timeoutMs <= 0) {
    return {
      found: false,
      waitedMs: 0,
      event: null,
    };
  }

  const startedAtMs = Date.now();
  while (Date.now() - startedAtMs < timeoutMs) {
    const stateResult = await callJson(
      config,
      'GET',
      `/admin/owners/${encodeURIComponent(config.customerId)}/state`
    );
    const probe = stateResult.json?.probe || {};
    const status = stateResult.json?.status || {};
    const snapshot = extractTurnstileSnapshot(probe, {
      title: status.pageTitle || '',
      url: status.pageUrl || '',
    });

    if (snapshot.pageType === 'checkbox') {
      const nowMs = Date.now();
      const transitionMs = Math.max(0, nowMs - waitingStartedAtMs);
      const event = buildBaseEvent(config, state, conditionName);
      event.phase = 'turnstile_transition';
      event.challengeDetected = true;
      event.hasTurnstile = true;
      event.turnstilePageType = 'checkbox';
      event.hasTurnstileCheckbox = true;
      event.waitingToCheckboxMs = transitionMs;
      event.waitingToCheckboxObserved = true;
      event.probeState = String(probe.state || '').trim();
      event.probeReason = String(probe.reason || '').trim();
      event.pageUrl = String(probe.url || status.pageUrl || '').trim();
      event.pageTitle = String(probe.title || status.pageTitle || '').trim();
      event.sessionId = String(status.sessionId || '').trim();
      event.stateDurationMs = stateResult.durationMs;
      event.note = 'waiting_to_checkbox_transition_observed';
      return {
        found: true,
        waitedMs: transitionMs,
        event,
      };
    }

    await sleep(pollMs);
  }

  return {
    found: false,
    waitedMs: Math.max(0, Date.now() - waitingStartedAtMs),
    event: null,
  };
}

async function runProbe(config, state, conditionName) {
  const condition = state.conditions[conditionName];
  if (!condition.startedAt) {
    condition.startedAt = toIsoNow();
  }

  const baselineResetAttempted = condition.probeCount === 0;
  let baselineResetDurationMs = 0;
  if (baselineResetAttempted) {
    const baselineResetResult = await callJson(
      config,
      'DELETE',
      `/admin/owners/${encodeURIComponent(config.customerId)}/session`
    ).catch(() => null);
    baselineResetDurationMs = baselineResetResult?.durationMs || 0;
  }

  const attachForceNew = conditionName === 'fresh';
  const attachBody = {
    forceNewSession: attachForceNew,
  };
  if (config.bootstrapUrl) {
    attachBody.bootstrapUrl = config.bootstrapUrl;
  }

  const attachResult = await callJson(
    config,
    'POST',
    `/admin/owners/${encodeURIComponent(config.customerId)}/attach`,
    attachBody
  );
  const attachStatus = attachResult.json?.status || {};
  const sessionId = String(attachStatus.sessionId || '').trim();

  const stateResult = await callJson(
    config,
    'GET',
    `/admin/owners/${encodeURIComponent(config.customerId)}/state`
  );
  const probe = stateResult.json?.probe || {};
  const status = stateResult.json?.status || {};
  const probeState = String(probe.state || '').trim();
  const turnstileSnapshot = extractTurnstileSnapshot(probe, {
    title: status.pageTitle || '',
    url: status.pageUrl || '',
  });
  const challengeDetected = turnstileSnapshot.hasTurnstile;
  const egressIp = String(probe.egressIp || '').trim();
  const event = buildBaseEvent(config, state, conditionName);
  event.phase = 'probe';
  event.sessionId = sessionId || String(status.sessionId || '').trim();
  event.challengeDetected = challengeDetected;
  event.hasTurnstile = turnstileSnapshot.hasTurnstile;
  event.turnstilePageType = turnstileSnapshot.pageType;
  event.hasTurnstileCheckbox = turnstileSnapshot.hasTurnstileCheckbox;
  event.probeState = probeState;
  event.probeReason = String(probe.reason || '').trim();
  event.pageUrl = String(probe.url || status.pageUrl || '').trim();
  event.pageTitle = String(probe.title || status.pageTitle || '').trim();
  event.egressIp = egressIp;
  event.attachDurationMs = attachResult.durationMs;
  event.stateDurationMs = stateResult.durationMs;
  event.baselineResetAttempted = baselineResetAttempted;
  event.baselineResetDurationMs = baselineResetDurationMs;
  event.attachForceNewSession = attachForceNew;
  event.note = attachResult.ok && stateResult.ok
    ? ''
    : `attachOk=${attachResult.ok} stateOk=${stateResult.ok}`;
  if (probeState === 'need_cred' && !condition.firstNeedCredAt) {
    condition.firstNeedCredAt = event.timestamp;
  }

  condition.probeCount += 1;
  updateConditionTurnstileState(condition, event);
  if (challengeDetected) {
    condition.challengeProbeCount += 1;
  }
  pushUniqueSessionId(condition, event.sessionId);

  let derivedEvents = [];
  if (config.wsTraceEnabled) {
    try {
      const wsTraceResult = await runWsTrace({
        base: config.baseUrl,
        customerId: config.customerId,
        targetUrl: config.targetUrl,
        attachMode: 'none',
        refreshLiveUrl: true,
        requestedLiveTimeoutMs: config.wsRequestedLiveTimeoutMs,
        traceDurationMs: config.wsTraceMs,
        maxMessages: config.wsMaxMessages,
        screenshotEnabled: config.wsScreenshotEnabled,
        screenshotIntervalMs: config.wsScreenshotIntervalMs,
        screenshotMax: config.wsScreenshotMax,
        adminApiKey: config.adminApiKey,
        outputRootDir: path.resolve(config.studyRoot, 'ws'),
      });
      mergeWsTraceIntoEventAndCondition(condition, event, wsTraceResult);
    } catch (error) {
      event.note = event.note
        ? `${event.note}; ws_trace_failed:${String(error?.message || error)}`
        : `ws_trace_failed:${String(error?.message || error)}`;
    }
  }

  if (event.hasTurnstile && event.turnstilePageType === 'waiting') {
    if (!event.waitingToCheckboxObserved) {
      const waitingStartedAtMs = Date.parse(event.timestamp);
      const transition = await waitForCheckboxTransition(
        config,
        state,
        conditionName,
        Number.isFinite(waitingStartedAtMs) ? waitingStartedAtMs : Date.now()
      );
      if (transition.found && transition.event) {
        event.waitingToCheckboxMs = transition.waitedMs;
        event.waitingToCheckboxObserved = true;
        if (!condition.waitingToCheckboxMs) {
          condition.waitingToCheckboxMs = transition.waitedMs;
        }
        if (!condition.firstCheckboxAt) {
          condition.firstCheckboxAt = transition.event.timestamp;
        }
        condition.checkboxPhaseCount += 1;
        derivedEvents.push(transition.event);
      } else {
        event.note = event.note
          ? `${event.note}; waiting_to_checkbox_not_observed_within_window`
          : 'waiting_to_checkbox_not_observed_within_window';
      }
    }
  }

  if (challengeDetected && !condition.firstChallengeAt) {
    condition.firstChallengeAt = event.timestamp;
    condition.firstChallengeSessionId = event.sessionId;
    const actionEvent = buildBaseEvent(config, state, conditionName);
    actionEvent.phase = 'action_required';
    actionEvent.sessionId = event.sessionId;
    actionEvent.challengeDetected = true;
    actionEvent.probeState = probeState;
    actionEvent.probeReason = event.probeReason;
    actionEvent.pageUrl = event.pageUrl;
    actionEvent.pageTitle = event.pageTitle;
    actionEvent.egressIp = egressIp;
    actionEvent.note = 'Challenge detected. Resolve manually, then run --manual-solve-start / --manual-solve-complete.';
    actionEvent.manual_steps = DEFAULT_MANUAL_STEPS;
    derivedEvents.push(actionEvent);
  }

  if (
    challengeDetected &&
    condition.manualSolveCompletedAt &&
    !condition.reChallengeAt &&
    Date.parse(event.timestamp) >= Date.parse(condition.manualSolveCompletedAt)
  ) {
    condition.reChallengeAt = event.timestamp;
    condition.completedAt = event.timestamp;
    condition.stopReason = 'first_rechallenge_after_manual_solve';
    const completionEvent = buildBaseEvent(config, state, conditionName);
    completionEvent.phase = 'condition_completed';
    completionEvent.sessionId = event.sessionId;
    completionEvent.challengeDetected = true;
    completionEvent.probeState = probeState;
    completionEvent.probeReason = event.probeReason;
    completionEvent.pageUrl = event.pageUrl;
    completionEvent.pageTitle = event.pageTitle;
    completionEvent.egressIp = egressIp;
    completionEvent.note = condition.stopReason;
    derivedEvents.push(completionEvent);
    markConditionCompleted(state, conditionName, condition.stopReason);
  }

  const maxWindowMs = config.maxHours * 60 * 60 * 1000;
  if (!condition.completedAt && condition.startedAt) {
    const elapsedMs = Math.max(0, Date.now() - Date.parse(condition.startedAt));
    if (elapsedMs >= maxWindowMs) {
      condition.completedAt = toIsoNow();
      condition.stopReason = 'max_window_reached';
      const timeoutEvent = buildBaseEvent(config, state, conditionName);
      timeoutEvent.phase = 'condition_completed';
      timeoutEvent.sessionId = event.sessionId;
      timeoutEvent.challengeDetected = challengeDetected;
      timeoutEvent.probeState = probeState;
      timeoutEvent.probeReason = event.probeReason;
      timeoutEvent.pageUrl = event.pageUrl;
      timeoutEvent.pageTitle = event.pageTitle;
      timeoutEvent.egressIp = egressIp;
      timeoutEvent.note = condition.stopReason;
      derivedEvents.push(timeoutEvent);
      markConditionCompleted(state, conditionName, condition.stopReason);
    }
  }

  if (conditionName === 'fresh') {
    await callJson(
      config,
      'DELETE',
      `/admin/owners/${encodeURIComponent(config.customerId)}/session`
    ).catch(() => {});
  }

  return {
    event,
    derivedEvents,
  };
}

async function markManualSolve(config, state, conditionName, mode, manualSteps) {
  const condition = state.conditions[conditionName];
  if (!condition.startedAt) {
    condition.startedAt = toIsoNow();
  }

  const event = buildBaseEvent(config, state, conditionName);
  event.phase = mode === 'start' ? 'manual_solve_started' : 'manual_solve_completed';
  event.manual_steps = manualSteps || DEFAULT_MANUAL_STEPS;

  if (mode === 'start') {
    condition.manualSolveStartedAt = toIsoNow();
    const refreshBody = {
      liveUrlOptions: {
        interactive: true,
        showBrowserInterface: true,
        timeout: 900000,
      },
    };
    const refreshResult = await callJson(
      config,
      'POST',
      `/admin/owners/${encodeURIComponent(config.customerId)}/live-url/refresh`,
      refreshBody
    );
    event.refreshDurationMs = refreshResult.durationMs;
    event.sessionId = String(refreshResult.json?.status?.sessionId || '').trim();
    event.pageUrl = String(refreshResult.json?.status?.pageUrl || '').trim();
    event.pageTitle = String(refreshResult.json?.status?.pageTitle || '').trim();
    event.note = refreshResult.ok
      ? `LiveURL refreshed: ${String(refreshResult.json?.status?.liveURL || '').trim()}`
      : `live-url refresh failed (HTTP ${refreshResult.statusCode})`;
    return event;
  }

  condition.manualSolveCompletedAt = toIsoNow();
  const waitStartAt =
    condition.manualSolveStartedAt || condition.firstChallengeAt || condition.startedAt || condition.manualSolveCompletedAt;
  const waitMs = Math.max(0, Date.parse(condition.manualSolveCompletedAt) - Date.parse(waitStartAt));
  condition.manualSolveWaitMs = waitMs;
  event.manual_solve_wait_ms = waitMs;
  event.note = 'Manual solve completed.';
  return event;
}

function finalizeStudyIfDone(config, state) {
  const next = CONDITIONS.find(name => !state.conditions[name].completedAt);
  if (next) {
    state.currentCondition = next;
    return null;
  }
  state.currentCondition = '';
  if (!state.completedAt) {
    state.completedAt = toIsoNow();
  }
  state.status = 'completed';
  const event = buildBaseEvent(config, state, '');
  event.phase = 'study_completed';
  event.note = 'All conditions completed.';
  return event;
}

function saveState(config, state) {
  state.updatedAt = toIsoNow();
  writeJson(config.statePath, state);
}

function printSnapshot(state, conditionName) {
  const condition = conditionName ? state.conditions[conditionName] : null;
  if (!condition) {
    console.log(`Study status: ${state.status}`);
    return;
  }

  console.log(
    JSON.stringify(
      {
        status: state.status,
        condition: conditionName,
        probeCount: condition.probeCount,
        challengeProbeCount: condition.challengeProbeCount,
        waitingPhaseCount: condition.waitingPhaseCount,
        checkboxPhaseCount: condition.checkboxPhaseCount,
        firstChallengeAt: condition.firstChallengeAt || null,
        firstWaitingAt: condition.firstWaitingAt || null,
        firstCheckboxAt: condition.firstCheckboxAt || null,
        firstNeedCredAt: condition.firstNeedCredAt || null,
        waitingToCheckboxMs: condition.waitingToCheckboxMs || 0,
        waitingToLoginMs: condition.waitingToLoginMs || 0,
        manualSolveStartedAt: condition.manualSolveStartedAt || null,
        manualSolveCompletedAt: condition.manualSolveCompletedAt || null,
        reChallengeAt: condition.reChallengeAt || null,
        stopReason: condition.stopReason || null,
      },
      null,
      2
    )
  );
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    printHelp();
    return;
  }

  if (args.condition) {
    assertConditionName(args.condition);
  }

  const customerId = String(process.env.CID || process.env.CUSTOMER_ID || 'danny').trim();
  const targetUrl = String(
    process.env.URL || process.env.CHALLENGE_STUDY_BOOTSTRAP_URL || ''
  ).trim();
  const proxyMode = String(process.env.BL_PROXY || '').trim();
  const studyRoot = path.resolve(
    process.env.CHALLENGE_STUDY_DIR || resolveDefaultStudyRoot(customerId, proxyMode, targetUrl)
  );
  const config = {
    baseUrl: String(process.env.BASE || 'http://127.0.0.1:8787').trim(),
    customerId,
    proxyMode,
    targetUrl,
    intervalMinutes: parseNumber(process.env.CHALLENGE_STUDY_INTERVAL_MINUTES, 10, 1),
    maxHours: parseNumber(process.env.CHALLENGE_STUDY_MAX_HOURS, 24, 1),
    wsTraceEnabled: parseBoolean(process.env.WS_TRACE_ENABLED, true),
    wsTraceMs: parseNumber(process.env.WS_TRACE_MS, 12000, 500),
    wsMaxMessages: parseNumber(process.env.WS_MAX_MESSAGES, 300, 20),
    wsRequestedLiveTimeoutMs: parseNumber(process.env.WS_CHECK_LIVE_URL_TIMEOUT_MS, 90000, 1000),
    wsScreenshotEnabled: parseBoolean(process.env.WS_SCREENSHOT_ENABLED, true),
    wsScreenshotIntervalMs: parseNumber(process.env.WS_SCREENSHOT_INTERVAL_MS, 2000, 250),
    wsScreenshotMax: parseNumber(process.env.WS_SCREENSHOT_MAX, 120, 1),
    bootstrapUrl: targetUrl,
    adminApiKey: String(process.env.ADMIN_API_KEY || '').trim(),
    studyRoot,
    eventsPath: path.resolve(studyRoot, 'events.jsonl'),
    turnstileTimelinePath: path.resolve(studyRoot, 'turnstile-timeline.jsonl'),
    statePath: path.resolve(studyRoot, 'state.json'),
  };

  if (args.reset) {
    fs.rmSync(config.statePath, { force: true });
    fs.rmSync(config.eventsPath, { force: true });
    fs.rmSync(config.turnstileTimelinePath, { force: true });
    console.log('Reset challenge study state/events/timeline.');
    const shouldContinueAfterReset =
      args.once || Boolean(args.condition) || args.manualSolveStarted || args.manualSolveCompleted;
    if (!shouldContinueAfterReset) {
      return;
    }
    console.log('Continuing study run after reset...');
  }

  const loadedState = loadJsonIfExists(config.statePath);
  const state = normalizeState(loadedState, config);

  const selectedCondition = activeConditionName(state, args.condition);
  if (!selectedCondition && state.status === 'completed') {
    console.log('Study already completed.');
    printSnapshot(state, '');
    return;
  }
  const conditionName = assertConditionName(selectedCondition || 'fresh');

  if (args.manualSolveStarted || args.manualSolveCompleted) {
    const mode = args.manualSolveStarted ? 'start' : 'complete';
    const manualEvent = await markManualSolve(
      config,
      state,
      conditionName,
      mode,
      args.manualSteps
    );
    appendJsonLine(config.eventsPath, manualEvent);
    appendTurnstileTimelineEntries(config.turnstileTimelinePath, [manualEvent]);
    saveState(config, state);
    console.log(`Recorded ${manualEvent.phase} for condition=${conditionName}`);
    printSnapshot(state, conditionName);
    return;
  }

  const runOnce = args.once === true;
  while (true) {
    if (state.status === 'completed') {
      console.log('Study completed.');
      break;
    }

    const runCondition = activeConditionName(state, args.condition);
    if (!runCondition) {
      finalizeStudyIfDone(config, state);
      saveState(config, state);
      console.log('Study completed.');
      break;
    }

    console.log(`Starting probe for condition=${runCondition}...`);
    const { event, derivedEvents } = await runProbe(config, state, runCondition);
    appendJsonLine(config.eventsPath, event);
    for (const derived of derivedEvents) {
      appendJsonLine(config.eventsPath, derived);
    }
    appendTurnstileTimelineEntries(config.turnstileTimelinePath, [event, ...derivedEvents]);

    const studyCompletionEvent = finalizeStudyIfDone(config, state);
    if (studyCompletionEvent) {
      appendJsonLine(config.eventsPath, studyCompletionEvent);
    }

    saveState(config, state);
    console.log(`Probe recorded for condition=${runCondition} challenge=${event.challengeDetected}`);
    printSnapshot(state, runCondition);

    if (runOnce || args.condition) {
      break;
    }
    if (state.status === 'completed') {
      break;
    }

    await sleep(config.intervalMinutes * 60 * 1000);
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
