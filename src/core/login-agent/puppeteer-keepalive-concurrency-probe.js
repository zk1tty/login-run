const fs = require('fs');
const path = require('path');

const { toTimestampTag } = require('./time');
const {
  BrowserlessSession,
  normalizeSessionPayload,
  redactUrlSecretParams,
} = require('./browserless-session');
const { PuppeteerSessionRuntime } = require('./puppeteer-session-runtime');

const DEFAULT_TARGET_URL = 'https://example.com';
const DEFAULT_COUNT = 10;
const DEFAULT_PROCESS_KEEP_ALIVE_MS = 1800000;
const DEFAULT_TTL_MS = 86400000;

function toInt(value, fallback, minimum = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(minimum, Math.trunc(parsed));
}

function toBool(value, fallback = false) {
  if (value == null || value === '') {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function appendJsonLine(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function safeArtifactName(value) {
  return String(value || 'artifact').replace(/[^a-z0-9._-]+/gi, '-').toLowerCase();
}

function parseProbeMode(value) {
  const mode = String(value || 'detached_keepalive').trim().toLowerCase();
  if (mode === 'active_control' || mode === 'detached_keepalive') {
    return mode;
  }
  throw new Error(
    'KEEPALIVE_CONCURRENCY_MODE must be "active_control" or "detached_keepalive".'
  );
}

function toWebsiteRunPrefix(urlString) {
  try {
    return new URL(String(urlString || '')).hostname.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  } catch {
    return 'unknown';
  }
}

function buildSessionPayload(input = {}) {
  const payload = {
    ttl: toInt(input.ttlMs, DEFAULT_TTL_MS, 1000),
    stealth: toBool(input.stealth, true),
  };

  const processKeepAliveMs = toInt(input.processKeepAliveMs, 0, 0);
  if (processKeepAliveMs > 0) {
    payload.processKeepAlive = processKeepAliveMs;
  }

  const browser = String(input.browser || '').trim();
  if (browser) {
    payload.browser = browser;
  }

  if (input.proxy) {
    payload.proxy = input.proxy;
  }

  return payload;
}

function buildProxyPayload(input = {}) {
  const type = String(
    input.proxy || process.env.KEEPALIVE_CONCURRENCY_PROXY || process.env.BROWSERLESS_PROXY || ''
  ).trim();
  if (!type) {
    return null;
  }

  const proxy = { type };
  const country = String(
    input.proxyCountry ||
      process.env.KEEPALIVE_CONCURRENCY_PROXY_COUNTRY ||
      process.env.BROWSERLESS_PROXY_COUNTRY ||
      ''
  ).trim();
  const city = String(
    input.proxyCity ||
      process.env.KEEPALIVE_CONCURRENCY_PROXY_CITY ||
      process.env.BROWSERLESS_PROXY_CITY ||
      ''
  ).trim();
  const preset = String(
    input.proxyPreset ||
      process.env.KEEPALIVE_CONCURRENCY_PROXY_PRESET ||
      process.env.BROWSERLESS_PROXY_PRESET ||
      ''
  ).trim();
  if (country) {
    proxy.country = country;
  }
  if (city) {
    proxy.city = city;
  }
  if (preset) {
    proxy.preset = preset;
  }
  const sticky =
    input.proxySticky ??
    process.env.KEEPALIVE_CONCURRENCY_PROXY_STICKY ??
    process.env.BROWSERLESS_PROXY_STICKY;
  if (sticky != null && sticky !== '') {
    proxy.sticky = toBool(sticky, false);
  }
  return proxy;
}

async function safePageSnapshot(page) {
  if (!page) {
    return {
      url: '',
      title: '',
    };
  }

  const url = typeof page.url === 'function' ? page.url() : '';
  let title;
  try {
    title = typeof page.title === 'function' ? await page.title() : '';
  } catch {
    title = '';
  }
  return {
    url,
    title,
  };
}

async function capturePageArtifacts(page, input = {}) {
  const outputDir = String(input.outputDir || '').trim();
  const label = safeArtifactName(input.label || 'page');
  if (!page || !outputDir) {
    return {
      screenshotPath: '',
      htmlPath: '',
      screenshotError: '',
      htmlError: '',
    };
  }

  fs.mkdirSync(outputDir, { recursive: true });
  const screenshotPath = path.join(outputDir, `${label}.png`);
  const htmlPath = path.join(outputDir, `${label}.html`);
  const result = {
    screenshotPath,
    htmlPath,
    screenshotError: '',
    htmlError: '',
  };

  try {
    await page.screenshot({ path: screenshotPath, fullPage: true });
  } catch (error) {
    result.screenshotError = String(error?.message || error || 'screenshot_failed');
  }

  try {
    const html = typeof page.content === 'function' ? await page.content() : '';
    fs.writeFileSync(htmlPath, html);
  } catch (error) {
    result.htmlError = String(error?.message || error || 'html_capture_failed');
  }

  return result;
}

class PuppeteerKeepAliveConcurrencyProbe {
  constructor(input = {}) {
    this.mode = parseProbeMode(input.mode);
    this.targetUrl = String(input.targetUrl || DEFAULT_TARGET_URL).trim();
    this.count = toInt(input.count, DEFAULT_COUNT, 1);
    this.extraActiveCheck = input.extraActiveCheck !== false;
    this.verifyReconnect = input.verifyReconnect !== false;
    this.disconnectOnEach = this.mode === 'detached_keepalive';
    this.closeActiveOnComplete = input.closeActiveOnComplete !== false;
    this.stopSessionsOnComplete = toBool(input.stopSessionsOnComplete, false);
    this.captureArtifacts = input.captureArtifacts !== false;
    this.waitAfterNavigateMs = toInt(input.waitAfterNavigateMs, 500, 0);
    this.holdMs = toInt(input.holdMs, 0, 0);
    this.connectTimeoutMs = toInt(input.connectTimeoutMs, 60000, 1000);
    this.ttlMs = toInt(input.ttlMs, DEFAULT_TTL_MS, 1000);
    this.processKeepAliveMs =
      this.mode === 'detached_keepalive'
        ? toInt(input.processKeepAliveMs, DEFAULT_PROCESS_KEEP_ALIVE_MS, 1000)
        : 0;
    this.stealth = input.stealth ?? true;
    this.browser = input.browser || process.env.SESSION_API_BROWSER;
    this.proxy = buildProxyPayload(input);
    this.puppeteer = input.puppeteer;
    this.outputDir = input.outputDir;
    this.artifactsDir = input.artifactsDir || (this.outputDir ? path.join(this.outputDir, 'artifacts') : '');
    this.eventsPath = input.eventsPath;
    this.recordEvent = input.recordEvent || (() => {});
    this.activeRuntimes = [];
  }

  async createSession(index, input = {}) {
    const payload = buildSessionPayload({
      ttlMs: this.ttlMs,
      processKeepAliveMs: input.processKeepAliveMs,
      stealth: this.stealth,
      browser: this.browser,
      proxy: this.proxy,
    });
    const created = await BrowserlessSession.create({
      rawPayload: JSON.stringify(payload),
    });
    const session = normalizeSessionPayload(created.session, {
      ttlMs: this.ttlMs,
      processKeepAliveMs: payload.processKeepAlive || 0,
    });

    this.recordEvent('session_created', {
      index,
      sessionId: session.id,
      ttlMs: session.ttlMs,
      processKeepAliveMs: session.processKeepAliveMs,
    });

    return {
      created,
      session,
      payload,
    };
  }

  async runIteration(index, input = {}) {
    const startedAt = new Date().toISOString();
    const row = {
      index,
      label: input.label || `session-${String(index).padStart(2, '0')}`,
      mode: this.mode,
      startedAt,
      finishedAt: '',
      sessionId: '',
      created: false,
      connected: false,
      navigated: false,
      disconnected: false,
      closed: false,
      stopped: false,
      endpoint: '',
      currentUrl: '',
      pageTitle: '',
      error: '',
      checkpointPath: '',
      artifacts: null,
    };

    let created = null;
    let runtime = null;
    try {
      const processKeepAliveMs = input.processKeepAliveMs ?? this.processKeepAliveMs;
      const sessionResult = await this.createSession(index, { processKeepAliveMs });
      created = sessionResult.created;
      row.created = true;
      row.sessionId = sessionResult.session.id;
      row.endpoint = redactUrlSecretParams(created.buildConnectEndpoint({ solveMode: 'none' }));

      runtime = await PuppeteerSessionRuntime.connect({
        endpoint: created.buildConnectEndpoint({
          solveMode: 'none',
          timeout: this.connectTimeoutMs,
        }),
        connectTimeoutMs: this.connectTimeoutMs,
        puppeteer: this.puppeteer,
      });
      row.connected = true;
      this.recordEvent('runtime_connected', {
        index,
        sessionId: row.sessionId,
        endpoint: row.endpoint,
      });

      this.recordEvent('navigate_start', {
        index,
        targetUrl: this.targetUrl,
      });
      await runtime.page.goto(this.targetUrl, {
        waitUntil: 'domcontentloaded',
        timeout: this.connectTimeoutMs,
      });
      if (this.waitAfterNavigateMs > 0) {
        await sleep(this.waitAfterNavigateMs);
      }
      row.navigated = true;
      const snapshot = await safePageSnapshot(runtime.page);
      row.currentUrl = snapshot.url;
      row.pageTitle = snapshot.title;
      this.recordEvent('navigate_complete', {
        index,
        currentUrl: row.currentUrl,
        pageTitle: row.pageTitle,
      });
      if (this.captureArtifacts) {
        row.artifacts = await capturePageArtifacts(runtime.page, {
          outputDir: this.artifactsDir,
          label: `${row.label}-initial`,
        });
        this.recordEvent('page_artifacts_captured', {
          index,
          label: row.label,
          phase: 'initial',
          ...row.artifacts,
        });
      }

      if (this.disconnectOnEach || input.disconnect) {
        await runtime.disconnect();
        row.disconnected = true;
        runtime = null;
        this.recordEvent('runtime_disconnected', {
          index,
          sessionId: row.sessionId,
        });
      }

      if (created && this.outputDir) {
        const checkpointPath = path.join(
          this.outputDir,
          'checkpoints',
          `${row.label}.json`
        );
        fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
        fs.writeFileSync(
          checkpointPath,
          JSON.stringify(
            {
              version: 1,
              createdAt: new Date().toISOString(),
              mode: this.mode,
              targetUrl: this.targetUrl,
              currentUrl: row.currentUrl,
              pageTitle: row.pageTitle,
              session: sessionResultToCheckpoint(created, sessionResult.session),
            },
            null,
            2
          )
        );
        row.checkpointPath = checkpointPath;
      }
    } catch (error) {
      row.error = String(error?.message || error || 'unknown_error');
      this.recordEvent('iteration_error', {
        index,
        error: row.error,
      });
    } finally {
      if (runtime && this.closeActiveOnComplete && input.close !== false) {
        try {
          await runtime.close();
          row.closed = true;
          this.recordEvent('runtime_closed', {
            index,
            sessionId: row.sessionId,
          });
        } catch (error) {
          row.error = row.error || String(error?.message || error || 'close_failed');
        }
      }
      if (created && this.stopSessionsOnComplete) {
        try {
          await created.stop();
          row.stopped = true;
          this.recordEvent('session_stopped', {
            index,
            sessionId: row.sessionId,
          });
        } catch (error) {
          row.error = row.error || String(error?.message || error || 'stop_failed');
        }
      }
      if (runtime && input.close === false) {
        this.activeRuntimes.push({
          index,
          sessionId: row.sessionId,
          runtime,
        });
      }
      row.finishedAt = new Date().toISOString();
    }

    return row;
  }

  async closeRetainedActiveRuntimes() {
    const closed = [];
    while (this.activeRuntimes.length > 0) {
      const retained = this.activeRuntimes.pop();
      try {
        await retained.runtime.close();
        closed.push({
          index: retained.index,
          sessionId: retained.sessionId,
          closed: true,
          error: '',
        });
        this.recordEvent('retained_runtime_closed', {
          index: retained.index,
          sessionId: retained.sessionId,
        });
      } catch (error) {
        closed.push({
          index: retained.index,
          sessionId: retained.sessionId,
          closed: false,
          error: String(error?.message || error || 'close_failed'),
        });
      }
    }
    return closed;
  }

  async holdRetainedActiveRuntimes() {
    if (this.holdMs <= 0 || this.activeRuntimes.length === 0) {
      return {
        held: false,
        holdMs: 0,
        retainedCount: this.activeRuntimes.length,
      };
    }

    this.recordEvent('active_hold_start', {
      holdMs: this.holdMs,
      retainedCount: this.activeRuntimes.length,
    });
    const startedAtMs = Date.now();
    await sleep(this.holdMs);
    const durationMs = Math.max(0, Date.now() - startedAtMs);
    this.recordEvent('active_hold_complete', {
      holdMs: this.holdMs,
      durationMs,
      retainedCount: this.activeRuntimes.length,
    });
    return {
      held: true,
      holdMs: this.holdMs,
      durationMs,
      retainedCount: this.activeRuntimes.length,
    };
  }

  async verifyDetachedReconnect(rows) {
    if (this.mode !== 'detached_keepalive' || !this.verifyReconnect) {
      return [];
    }

    const reconnectRows = [];
    for (const row of rows.filter(item => item.disconnected && !item.error)) {
      const startedAt = new Date().toISOString();
      const reconnectRow = {
        index: row.index,
        sessionId: row.sessionId,
        startedAt,
        finishedAt: '',
        connected: false,
        currentUrl: '',
        pageTitle: '',
        disconnected: false,
        artifacts: null,
        error: '',
      };
      let runtime = null;
      try {
        const raw = JSON.parse(fs.readFileSync(row.checkpointPath, 'utf8'));
        const connect = String(raw?.session?.connect || '').trim();
        if (!connect) {
          throw new Error(`Missing connect URL in checkpoint: ${row.checkpointPath}`);
        }
        this.recordEvent('reconnect_start', {
          index: row.index,
          sessionId: row.sessionId,
        });
        runtime = await PuppeteerSessionRuntime.connect({
          endpoint: connect,
          connectTimeoutMs: this.connectTimeoutMs,
          puppeteer: this.puppeteer,
        });
        reconnectRow.connected = true;
        const snapshot = await safePageSnapshot(runtime.page);
        reconnectRow.currentUrl = snapshot.url;
        reconnectRow.pageTitle = snapshot.title;
        if (this.captureArtifacts) {
          reconnectRow.artifacts = await capturePageArtifacts(runtime.page, {
            outputDir: this.artifactsDir,
            label: `session-${String(row.index).padStart(2, '0')}-reconnect`,
          });
          this.recordEvent('page_artifacts_captured', {
            index: row.index,
            sessionId: row.sessionId,
            phase: 'reconnect',
            ...reconnectRow.artifacts,
          });
        }
        this.recordEvent('reconnect_complete', {
          index: row.index,
          sessionId: row.sessionId,
          currentUrl: reconnectRow.currentUrl,
          pageTitle: reconnectRow.pageTitle,
        });
      } catch (error) {
        reconnectRow.error = String(error?.message || error || 'unknown_error');
        this.recordEvent('reconnect_error', {
          index: row.index,
          sessionId: row.sessionId,
          error: reconnectRow.error,
        });
      } finally {
        if (runtime) {
          await runtime.disconnect();
          reconnectRow.disconnected = true;
          this.recordEvent('reconnect_disconnected', {
            index: row.index,
            sessionId: row.sessionId,
          });
        }
        reconnectRow.finishedAt = new Date().toISOString();
      }
      reconnectRows.push(reconnectRow);
    }

    return reconnectRows;
  }

  async run() {
    this.recordEvent('run_start', {
      mode: this.mode,
      count: this.count,
      targetUrl: this.targetUrl,
      processKeepAliveMs: this.processKeepAliveMs,
      holdMs: this.holdMs,
      proxy: this.proxy,
    });

    const rows = [];
    for (let index = 1; index <= this.count; index += 1) {
      const row = await this.runIteration(index, {
        close: this.mode !== 'active_control',
      });
      rows.push(row);
      if (row.error) {
        break;
      }
    }

    let extraActive = null;
    if (this.mode === 'detached_keepalive' && this.extraActiveCheck) {
      extraActive = await this.runIteration(this.count + 1, {
        label: 'extra-active-check',
        processKeepAliveMs: 0,
        disconnect: false,
        close: true,
      });
    }

    const reconnectChecks = await this.verifyDetachedReconnect(rows);
    const retainedHold =
      this.mode === 'active_control' ? await this.holdRetainedActiveRuntimes() : null;
    const retainedCleanup =
      this.mode === 'active_control' && this.closeActiveOnComplete
        ? await this.closeRetainedActiveRuntimes()
        : [];

    const summary = {
      status:
        rows.some(row => row.error) ||
        extraActive?.error ||
        reconnectChecks.some(row => row.error)
          ? 'error'
          : 'ok',
      mode: this.mode,
      targetUrl: this.targetUrl,
      requestedCount: this.count,
      succeededCount: rows.filter(row => row.created && row.connected && row.navigated).length,
      detachedCount: rows.filter(row => row.disconnected).length,
      proxy: this.proxy,
      firstFailure:
        rows.find(row => row.error) ||
        (extraActive?.error ? extraActive : null),
      extraActive,
      reconnectChecks,
      retainedHold,
      retainedCleanup,
      rows,
    };

    this.recordEvent('run_complete', {
      status: summary.status,
      succeededCount: summary.succeededCount,
      detachedCount: summary.detachedCount,
      reconnectSucceededCount: summary.reconnectChecks.filter(row => row.connected).length,
      firstFailureIndex: summary.firstFailure?.index || null,
      extraActiveStatus: extraActive
        ? extraActive.error
          ? 'error'
          : 'ok'
        : 'skipped',
    });
    return summary;
  }
}

function sessionResultToCheckpoint(created, session) {
  return {
    id: session.id,
    connect: session.connect,
    stop: session.stop,
    ttlMs: session.ttlMs || 0,
    processKeepAliveMs: session.processKeepAliveMs || 0,
    endpoint: redactUrlSecretParams(created.buildConnectEndpoint({ solveMode: 'none' })),
  };
}

async function runPuppeteerKeepAliveConcurrencyProbeCli(input = {}) {
  const customerId = String(input.customerId || process.env.CUSTOMER_ID || 'default').trim();
  const targetUrl = String(
    input.targetUrl || process.env.KEEPALIVE_CONCURRENCY_TARGET_URL || DEFAULT_TARGET_URL
  ).trim();
  const mode = parseProbeMode(input.mode || process.env.KEEPALIVE_CONCURRENCY_MODE);
  const runPrefix = toWebsiteRunPrefix(targetUrl);
  const runDir = path.resolve(
    input.outputDir ||
      path.join(
        process.env.RUN_LOGS_ROOT || '.log',
        customerId,
        'puppeteer-keepalive-concurrency',
        `${runPrefix}-${toTimestampTag(new Date())}`
      )
  );
  fs.mkdirSync(runDir, { recursive: true });
  const eventsPath = path.join(runDir, 'events.jsonl');
  const summaryPath = path.join(runDir, 'summary.json');
  const recordEvent = (event, fields = {}) => {
    appendJsonLine(eventsPath, {
      ts: new Date().toISOString(),
      event,
      ...fields,
    });
  };

  const probe = new PuppeteerKeepAliveConcurrencyProbe({
    mode,
    targetUrl,
    count: input.count || process.env.KEEPALIVE_CONCURRENCY_COUNT || DEFAULT_COUNT,
    ttlMs: input.ttlMs || process.env.SESSION_API_TTL_MS || DEFAULT_TTL_MS,
    processKeepAliveMs:
      input.processKeepAliveMs ||
      process.env.SESSION_API_PROCESS_KEEP_ALIVE_MS ||
      DEFAULT_PROCESS_KEEP_ALIVE_MS,
    connectTimeoutMs:
      input.connectTimeoutMs || process.env.SESSION_API_CONNECT_TIMEOUT_MS || 60000,
    waitAfterNavigateMs:
      input.waitAfterNavigateMs || process.env.KEEPALIVE_CONCURRENCY_WAIT_MS || 500,
    holdMs: input.holdMs || process.env.KEEPALIVE_CONCURRENCY_HOLD_MS || 0,
    extraActiveCheck:
      input.extraActiveCheck ??
      !toBool(process.env.KEEPALIVE_CONCURRENCY_SKIP_EXTRA_ACTIVE, false),
    verifyReconnect:
      input.verifyReconnect ??
      !toBool(process.env.KEEPALIVE_CONCURRENCY_SKIP_RECONNECT_VERIFY, false),
    stopSessionsOnComplete:
      input.stopSessionsOnComplete ??
      toBool(process.env.KEEPALIVE_CONCURRENCY_STOP_ON_COMPLETE, false),
    outputDir: runDir,
    artifactsDir: path.join(runDir, 'artifacts'),
    eventsPath,
    recordEvent,
    puppeteer: input.puppeteer,
  });

  const result = await probe.run();
  const summary = {
    checkedAt: new Date().toISOString(),
    customerId,
    runDir,
    eventsPath,
    summaryPath,
    ...result,
  };
  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  return summary;
}

module.exports = {
  DEFAULT_PROCESS_KEEP_ALIVE_MS,
  DEFAULT_TARGET_URL,
  PuppeteerKeepAliveConcurrencyProbe,
  parseProbeMode,
  runPuppeteerKeepAliveConcurrencyProbeCli,
};
