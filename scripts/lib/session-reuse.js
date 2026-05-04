const fs = require('fs');
const path = require('path');

const {
  fetchJson,
  getSessionsViewerUrl,
  getWsBase,
  normalizeWsUrl,
  writeJsonFile,
} = require('./helpers');

const STRATEGY_ORDER = Object.freeze([
  'attach_existing_live_browser',
  'launch_new_browser_with_profile',
  'inject_auth_snapshot',
  'credential_login',
]);

const DECISION_CASES = Object.freeze({
  LIVE_BROWSER_AUTHENTICATED: 'reuse_live_browser_authenticated',
  LIVE_BROWSER_CREDENTIAL_LOGIN: 'reuse_live_browser_credential_login',
  NEW_BROWSER_PROFILE_AUTHENTICATED: 'new_browser_profile_authenticated',
  NEW_BROWSER_AUTH_SNAPSHOT_AUTHENTICATED:
    'new_browser_auth_snapshot_authenticated',
  NEW_BROWSER_CREDENTIAL_LOGIN: 'new_browser_credential_login',
  LIVE_BROWSER_LOGGED_OUT: 'reuse_live_browser_logged_out',
  NEW_BROWSER_PROFILE_LOGGED_OUT: 'new_browser_profile_logged_out',
  UNDETERMINED: 'undetermined',
});

function getNumberEnv(name, fallback) {
  const value = Number(process.env[name] || fallback);
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

function parseBoolean(value, fallback = false) {
  if (value == null || value === '') {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function appendJsonLine(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function resetFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, '');
}

function nowIso() {
  return new Date().toISOString();
}

function createRunId() {
  return nowIso().replace(/[:.]/g, '-');
}

function getLogsRoot() {
  return path.resolve(process.env.RUN_LOGS_ROOT || '.log');
}

function sanitizeSession(session) {
  if (!session) {
    return null;
  }

  return {
    id: session.id || '',
    browserId: session.browserId || '',
    running: session.running === true,
    type: session.type || '',
    userDataDir: session.userDataDir || '',
    url: session.url || '',
    title: session.title || '',
    browserWSEndpoint: session.browserWSEndpoint || '',
    webSocketDebuggerUrl: session.webSocketDebuggerUrl || '',
    killURL: session.killURL || '',
  };
}

function pickMostRecentSession(sessions) {
  if (!Array.isArray(sessions) || sessions.length === 0) {
    return null;
  }

  return sessions[sessions.length - 1];
}

async function findLiveBrowserSessionByUserDataDir(userDataDir) {
  if (!userDataDir) {
    return null;
  }

  let sessions;
  try {
    sessions = await fetchJson(getSessionsViewerUrl());
  } catch (error) {
    // Browserless cloud may not expose /sessions. Attaching is optional,
    // so fall back to launching a fresh browser with the persisted profile.
    const message = String(error?.message || error);
    if (message.includes('HTTP 404') || message.includes('HTTP 401')) {
      return null;
    }

    throw error;
  }
  const matches = sessions.filter(session => {
    return (
      session &&
      session.type === 'browser' &&
      session.running === true &&
      session.userDataDir === userDataDir
    );
  });

  return pickMostRecentSession(matches);
}

function getAttachableBrowserWSEndpoint(session) {
  const direct = normalizeWsUrl(
    session?.browserWSEndpoint ||
      session?.webSocketDebuggerUrl ||
      session?.wsEndpoint ||
      ''
  );

  if (direct) {
    return direct;
  }

  const browserId = String(
    session?.browserId || session?.id || ''
  ).trim();

  if (!browserId) {
    return '';
  }

  const base = new URL(getWsBase());
  base.pathname = `/devtools/browser/${browserId}`;
  base.search = '';
  return base.toString();
}

function getReuseLiveSessionConfig() {
  return {
    measureDurationMs: getNumberEnv('REUSE_SESSION_MEASURE_DURATION_MS', 0),
    measureIntervalMs: getNumberEnv('REUSE_SESSION_PROBE_INTERVAL_MS', 60000),
    holdOpenMs: getNumberEnv('REUSE_SESSION_HOLD_OPEN_MS', 0),
    holdOpen: parseBoolean(process.env.REUSE_SESSION_HOLD_OPEN, false),
    holdOpenForEnter: parseBoolean(
      process.env.REUSE_SESSION_HOLD_OPEN_FOR_ENTER,
      false
    ),
  };
}

function getReuseLiveSessionLogPaths(customerId) {
  const customerLogDir = path.resolve(getLogsRoot(), customerId);
  const runId = createRunId();
  const runsDir = path.resolve(customerLogDir, 'runs', 'reuse-live-session');

  return {
    runId,
    summaryPath: path.resolve(runsDir, `${runId}-summary.json`),
    eventsPath: path.resolve(runsDir, `${runId}-events.jsonl`),
    latestSummaryPath: path.resolve(customerLogDir, 'run-summary-reuse-live-session.json'),
    latestEventsPath: path.resolve(customerLogDir, 'run-events-reuse-live-session.jsonl'),
  };
}

function createReuseLiveSessionLogger(options) {
  const {
    customerId,
    summaryPath,
    eventsPath,
    latestSummaryPath = '',
    latestEventsPath = '',
    strategyOrder = STRATEGY_ORDER,
  } = options;
  const useLatestSummary =
    Boolean(latestSummaryPath) && latestSummaryPath !== summaryPath;
  const useLatestEvents =
    Boolean(latestEventsPath) && latestEventsPath !== eventsPath;
  const summary = {
    script: 'legacy/agentql/login-agentql-reuse-live-session.js',
    flow: 'reuse-live-session',
    customerId,
    strategyOrder,
    decisionCase: DECISION_CASES.UNDETERMINED,
    startedAt: nowIso(),
    updatedAt: nowIso(),
    eventCount: 0,
    measurement: {
      probes: [],
    },
    paths: {
      summaryPath,
      eventsPath,
      latestSummaryPath: useLatestSummary ? latestSummaryPath : '',
      latestEventsPath: useLatestEvents ? latestEventsPath : '',
    },
  };

  if (useLatestEvents) {
    resetFile(latestEventsPath);
  }

  function persist() {
    summary.updatedAt = nowIso();
    writeJsonFile(summaryPath, summary);
    if (useLatestSummary) {
      writeJsonFile(latestSummaryPath, summary);
    }
  }

  function event(stage, details = {}) {
    summary.eventCount += 1;
    const payload = {
      at: nowIso(),
      stage,
      ...details,
    };

    appendJsonLine(eventsPath, payload);
    if (useLatestEvents) {
      appendJsonLine(latestEventsPath, payload);
    }

    persist();
  }

  function set(fields) {
    Object.assign(summary, fields);
    persist();
  }

  function setMeasurement(fields) {
    summary.measurement = {
      ...summary.measurement,
      ...fields,
    };
    persist();
  }

  function addProbe(probe) {
    summary.measurement.probes.push(probe);
    persist();
  }

  function decide(decisionCase, extra = {}) {
    summary.decisionCase = decisionCase;
    Object.assign(summary, extra);
    persist();
    event('decision', {
      decisionCase,
    });
  }

  function finish(extra = {}) {
    Object.assign(summary, extra, {
      completedAt: nowIso(),
    });
    persist();
  }

  persist();

  return {
    summary,
    event,
    set,
    setMeasurement,
    addProbe,
    decide,
    finish,
  };
}

function buildAuthCheckpoint(label, authResult, page) {
  return {
    label,
    at: nowIso(),
    state: authResult?.state || 'unknown',
    reason: authResult?.reason || 'unknown',
    url: authResult?.url || page?.url?.() || '',
    title: authResult?.title || '',
  };
}

module.exports = {
  DECISION_CASES,
  STRATEGY_ORDER,
  buildAuthCheckpoint,
  createReuseLiveSessionLogger,
  findLiveBrowserSessionByUserDataDir,
  getAttachableBrowserWSEndpoint,
  getReuseLiveSessionConfig,
  getReuseLiveSessionLogPaths,
  sanitizeSession,
};
