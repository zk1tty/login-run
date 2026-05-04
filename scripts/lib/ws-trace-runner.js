const fs = require('fs');
const path = require('path');

const {
  createLiveSignals,
  derivePageStateFromLiveSignals,
  recordLiveSignalFromWsText,
} = require('../../src/core/detection/live-ws-state-classifier');
const {
  createCdpScreenshotCaptureSession,
  createScreenshotScheduler,
} = require('./cdp-screenshot-capture');

const DEFAULT_WS_OPEN_TIMEOUT_MS = 90000;
const DEFAULT_WS_TRACE_MS = 12000;
const DEFAULT_WS_CHECK_LIVE_URL_TIMEOUT_MS = 90000;
const DEFAULT_WS_MAX_MESSAGES = 300;
const DEFAULT_WS_SCREENSHOT_INTERVAL_MS = 2000;
const DEFAULT_WS_SCREENSHOT_MAX = 120;

function toSafeError(error) {
  return String(error?.message || error || 'unknown_error');
}

function toTimestampTag(date = new Date()) {
  const yyyy = String(date.getFullYear());
  const mm = String(date.getMonth() + 1).padStart(2, '0');
  const dd = String(date.getDate()).padStart(2, '0');
  const hh = String(date.getHours()).padStart(2, '0');
  const min = String(date.getMinutes()).padStart(2, '0');
  const ss = String(date.getSeconds()).padStart(2, '0');
  const ms = String(date.getMilliseconds()).padStart(3, '0');
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}-${ms}`;
}

function writeJsonFile(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(value, null, 2));
}

function appendJsonLine(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
}

async function requestJson(base, routePath, options = {}) {
  const url = new URL(routePath, base);
  const headers = {
    'content-type': 'application/json',
    ...(options.headers || {}),
  };
  const response = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body,
  });
  const rawBody = await response.text();
  let parsedBody = null;

  try {
    parsedBody = rawBody ? JSON.parse(rawBody) : null;
  } catch (error) {
    parsedBody = null;
  }

  if (!response.ok) {
    const message = parsedBody?.message || rawBody || `HTTP ${response.status}`;
    throw new Error(`${options.method || 'GET'} ${url.pathname} failed: ${message}`);
  }

  return parsedBody;
}

function parseLiveUrlTimeoutMs(liveUrl) {
  const raw = String(liveUrl || '').trim();
  if (!raw) {
    return 0;
  }

  try {
    const url = new URL(raw);
    const timeoutMs = Number(url.searchParams.get('t') || 0);
    return Number.isFinite(timeoutMs) && timeoutMs > 0 ? Math.trunc(timeoutMs) : 0;
  } catch (error) {
    return 0;
  }
}

function parseLiveUrlIssuedInfo(liveUrl, checkedAtIso) {
  const timeoutMs = parseLiveUrlTimeoutMs(liveUrl);
  const checkedAtMs = Date.parse(String(checkedAtIso || ''));
  const expiresAtMs =
    timeoutMs > 0 && Number.isFinite(checkedAtMs) ? checkedAtMs + timeoutMs : 0;

  return {
    timeoutMs,
    expiresAt: expiresAtMs > 0 ? new Date(expiresAtMs).toISOString() : null,
  };
}

function toLiveWebSocketUrl(liveUrl) {
  const raw = String(liveUrl || '').trim();
  if (!raw) {
    return '';
  }

  const url = new URL(raw);
  const liveId = String(url.searchParams.get('i') || '').trim();
  const timeout = String(url.searchParams.get('t') || '').trim();

  if (!liveId) {
    return '';
  }

  url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:';
  url.search = '';
  url.pathname = url.pathname.replace(/index\.html$/i, '') + liveId;

  if (timeout) {
    url.searchParams.set('timeout', timeout);
  }

  return url.toString();
}

function isBlankPageUrl(urlString) {
  const value = String(urlString || '').trim().toLowerCase();
  return !value || value === 'about:blank' || value.startsWith('about:blank?');
}

function formatNowTimeLabel() {
  const now = new Date();
  const time = now.toTimeString().slice(0, 8);
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `${time}.${ms}`;
}

function summarizeWsPayload(rawPayload) {
  const summary = {
    type: 'unknown',
    bytes: 0,
    text: '',
    command: '',
  };

  if (typeof rawPayload === 'string') {
    summary.type = 'text';
    summary.bytes = Buffer.byteLength(rawPayload, 'utf8');
    summary.text = rawPayload.slice(0, 280);

    try {
      const parsed = JSON.parse(rawPayload);
      if (parsed && typeof parsed === 'object') {
        summary.command = String(parsed.command || parsed.method || '').trim();
      }
    } catch (error) {
      // Ignore non-JSON payloads.
    }

    return summary;
  }

  if (rawPayload instanceof ArrayBuffer) {
    summary.type = 'binary';
    summary.bytes = rawPayload.byteLength;
    return summary;
  }

  if (ArrayBuffer.isView(rawPayload)) {
    summary.type = 'binary';
    summary.bytes = rawPayload.byteLength;
    return summary;
  }

  if (rawPayload && typeof rawPayload.size === 'number') {
    summary.type = 'binary';
    summary.bytes = rawPayload.size;
    return summary;
  }

  summary.type = typeof rawPayload;
  summary.text = String(rawPayload || '').slice(0, 120);
  summary.bytes = Buffer.byteLength(summary.text, 'utf8');
  return summary;
}

function resolveTransitionContext(pageStateFromLive = {}) {
  const transitions = Array.isArray(pageStateFromLive.transitions)
    ? pageStateFromLive.transitions
    : [];
  const latest = transitions[transitions.length - 1] || null;

  return {
    transitionKey: latest
      ? `${latest.state || ''}:${latest.turnstilePageType || ''}`
      : `${pageStateFromLive.state || ''}:${pageStateFromLive.turnstilePageType || ''}`,
    state: String(latest?.state || pageStateFromLive.state || ''),
    turnstilePageType: String(
      latest?.turnstilePageType || pageStateFromLive.turnstilePageType || ''
    ),
    title: String(latest?.title || pageStateFromLive.title || ''),
    url: String(latest?.url || pageStateFromLive.url || ''),
    at: formatNowTimeLabel(),
  };
}

function parseWsMessageCommandText(entry = {}) {
  if (entry?.type !== 'text') {
    return '';
  }
  return String(entry?.text || '');
}

function collectLiveSignalsFromMessages(messages = [], preferredTargetId = '') {
  const liveSignals = createLiveSignals();
  let activeTab = null;

  for (const entry of messages) {
    if (entry?.direction !== 'recv') {
      continue;
    }
    const text = parseWsMessageCommandText(entry);
    if (!text) {
      continue;
    }

    const signal = recordLiveSignalFromWsText(liveSignals, {
      text,
      at: String(entry?.at || ''),
      preferredTargetId,
    });

    if (signal.activeTab) {
      activeTab = {
        id: signal.activeTab.id,
        title: signal.activeTab.title,
        url: signal.activeTab.url,
        isBlank: isBlankPageUrl(signal.activeTab.url),
      };
    }
  }

  return {
    liveSignals,
    activeTab,
  };
}

function derivePageStateFromMessages(messages = [], input = {}) {
  const preferredTargetId = String(input.preferredTargetId || '').trim();
  const fallbackProbe = input.fallbackProbe && typeof input.fallbackProbe === 'object'
    ? input.fallbackProbe
    : null;
  const collected = collectLiveSignalsFromMessages(messages, preferredTargetId);
  const pageStateFromLive = derivePageStateFromLiveSignals({
    liveSignals: collected.liveSignals,
    fallbackProbe,
  });

  return {
    ...collected,
    pageStateFromLive,
  };
}

async function probeWebSocket(input = {}) {
  const wsUrl = String(input.wsUrl || '').trim();
  const mode = String(input.mode || 'trace').trim();
  const preferredTargetId = String(input.preferredTargetId || '').trim();
  const rawOpenTimeout = Number(input.openTimeoutMs);
  const openTimeoutMs = Number.isFinite(rawOpenTimeout)
    ? Math.max(1000, Math.trunc(rawOpenTimeout))
    : DEFAULT_WS_OPEN_TIMEOUT_MS;
  const rawTraceDuration = Number(input.traceDurationMs);
  const traceDurationMs = Number.isFinite(rawTraceDuration)
    ? Math.max(100, Math.trunc(rawTraceDuration))
    : DEFAULT_WS_TRACE_MS;
  const rawMaxMessages = Number(input.maxMessages);
  const maxMessages = Number.isFinite(rawMaxMessages)
    ? Math.max(1, Math.trunc(rawMaxMessages))
    : DEFAULT_WS_MAX_MESSAGES;

  if (!wsUrl) {
    return {
      ok: false,
      mode,
      requestUrl: '',
      error: 'missing_ws_url',
      messages: [],
      droppedMessages: 0,
      liveSignals: createLiveSignals(),
      screenshots: {
        enabled: false,
        records: [],
        droppedCount: 0,
        error: '',
      },
    };
  }

  if (typeof WebSocket !== 'function') {
    return {
      ok: false,
      mode,
      requestUrl: wsUrl,
      error: 'WebSocket API is unavailable in this Node runtime.',
      messages: [],
      droppedMessages: 0,
      liveSignals: createLiveSignals(),
      screenshots: {
        enabled: false,
        records: [],
        droppedCount: 0,
        error: '',
      },
    };
  }

  const screenshotEnabled =
    mode === 'trace' &&
    input.screenshot?.enabled !== false &&
    Boolean(String(input.pageCdpUrl || '').trim()) &&
    Boolean(String(input.screenshot?.outputDir || '').trim());

  const screenshotCapture = await createCdpScreenshotCaptureSession({
    enabled: screenshotEnabled,
    pageCdpUrl: input.pageCdpUrl,
    outputDir: input.screenshot?.outputDir,
    openTimeoutMs: input.screenshot?.openTimeoutMs,
    commandTimeoutMs: input.screenshot?.commandTimeoutMs,
  });

  let latestTransitionContext = {
    transitionKey: '',
    state: '',
    turnstilePageType: '',
    title: '',
    url: '',
    at: formatNowTimeLabel(),
  };

  const screenshotScheduler = createScreenshotScheduler({
    enabled: screenshotEnabled,
    intervalMs: input.screenshot?.intervalMs,
    maxShots: input.screenshot?.maxScreenshots,
    contextProvider: () => ({
      ...latestTransitionContext,
      at: formatNowTimeLabel(),
    }),
    captureFn: async context => screenshotCapture.capture(context),
  });

  return new Promise(resolve => {
    const startedAt = Date.now();
    if (mode === 'trace') {
      screenshotScheduler.start();
    }
    const ws = new WebSocket(wsUrl);

    let settled = false;
    let openedAtMs = 0;
    let closeCode = null;
    let closeReason = '';
    let droppedMessages = 0;
    let activeTab = null;
    let startedWithTargetId = preferredTargetId || '';
    const liveSignals = createLiveSignals();
    const messages = [];

    const pushMessage = entry => {
      if (messages.length < maxMessages) {
        messages.push(entry);
        return;
      }
      droppedMessages += 1;
    };

    let openTimer = setTimeout(() => {
      settle({
        ok: false,
        error: `open_timeout_${openTimeoutMs}ms`,
      });
    }, openTimeoutMs);

    let traceTimer = null;

    const settle = value => {
      if (settled) {
        return;
      }
      settled = true;

      if (openTimer) {
        clearTimeout(openTimer);
        openTimer = null;
      }
      if (traceTimer) {
        clearTimeout(traceTimer);
        traceTimer = null;
      }

      (async () => {
        try {
          if (mode === 'trace' && value?.ok === false) {
            await screenshotCapture.capture({
              ...latestTransitionContext,
              at: formatNowTimeLabel(),
              reason: openedAtMs > 0 ? 'ws_trace_failed' : 'ws_open_failed',
            });
          }
        } catch (error) {
          // Best effort only.
        }

        try {
          await screenshotScheduler.stop();
        } catch (error) {
          // Best effort only.
        }

        try {
          await screenshotCapture.close();
        } catch (error) {
          // Best effort only.
        }

        try {
          ws.close();
        } catch (error) {
          // Best effort only.
        }

        resolve({
          ok: false,
          mode,
          requestUrl: wsUrl,
          durationMs: Math.max(0, Date.now() - startedAt),
          openedAtMs: openedAtMs > 0 ? openedAtMs : null,
          closeCode,
          closeReason,
          activeTab,
          startedWithTargetId,
          liveSignals,
          messages,
          droppedMessages,
          screenshots: {
            enabled: screenshotEnabled,
            records: Array.isArray(screenshotCapture.records)
              ? screenshotCapture.records
              : [],
            droppedCount: Number(screenshotCapture.droppedCount || 0),
            error: String(screenshotCapture.error || ''),
            scheduler: screenshotScheduler.getSummary(),
          },
          ...value,
        });
      })();
    };

    ws.addEventListener('open', () => {
      openedAtMs = Math.max(0, Date.now() - startedAt);

      if (mode === 'cdp_ping') {
        const payload = JSON.stringify({ id: 1, method: 'Browser.getVersion' });
        ws.send(payload);
        pushMessage({
          direction: 'sent',
          at: formatNowTimeLabel(),
          ...summarizeWsPayload(payload),
        });
        return;
      }

      const startPayload = JSON.stringify({
        command: 'start',
        data: {
          width: 1280,
          height: 720,
          targetId: preferredTargetId || undefined,
        },
      });
      ws.send(startPayload);
      pushMessage({
        direction: 'sent',
        at: formatNowTimeLabel(),
        ...summarizeWsPayload(startPayload),
      });

      traceTimer = setTimeout(() => {
        settle({ ok: true, traceDurationMs });
      }, traceDurationMs);
    });

    ws.addEventListener('message', event => {
      const atLabel = formatNowTimeLabel();
      const payloadSummary = summarizeWsPayload(event?.data);
      pushMessage({
        direction: 'recv',
        at: atLabel,
        ...payloadSummary,
      });

      if (mode !== 'cdp_ping' && payloadSummary.type === 'text') {
        const signal = recordLiveSignalFromWsText(liveSignals, {
          text: event?.data,
          at: atLabel,
          preferredTargetId,
        });

        if (signal.shouldSwitchToPreferred) {
          const switchPayload = JSON.stringify({
            command: 'switchTab',
            data: { id: preferredTargetId },
          });
          ws.send(switchPayload);
          pushMessage({
            direction: 'sent',
            at: formatNowTimeLabel(),
            ...summarizeWsPayload(switchPayload),
          });
        }

        if (signal.activeTab) {
          activeTab = {
            id: signal.activeTab.id,
            title: signal.activeTab.title,
            url: signal.activeTab.url,
            isBlank: isBlankPageUrl(signal.activeTab.url),
          };
        }

        const snapshot = derivePageStateFromLiveSignals({
          liveSignals,
          fallbackProbe: input.fallbackProbe || null,
        });
        latestTransitionContext = resolveTransitionContext(snapshot);
        screenshotScheduler.notifyTransition(latestTransitionContext);
      }

      if (mode === 'cdp_ping') {
        settle({ ok: true });
      }
    });

    ws.addEventListener('close', event => {
      closeCode = Number.isInteger(event?.code) ? event.code : null;
      closeReason = String(event?.reason || '');

      if (!settled) {
        const opened = openedAtMs > 0;
        settle({
          ok: false,
          error: opened
            ? `closed_before_trace_complete_${closeCode ?? 'unknown'}`
            : closeReason || `closed_${closeCode ?? 'unknown'}`,
        });
      }
    });

    ws.addEventListener('error', error => {
      if (!settled) {
        settle({
          ok: false,
          error: toSafeError(error),
        });
      }
    });
  });
}

async function traceLiveSession(input = {}) {
  const pageCdpUrl = String(input.pageCdpUrl || '').trim();
  const liveWsUrl = String(input.liveWsUrl || '').trim();
  const pageTargetId = String(input.pageTargetId || '').trim();
  const fallbackProbe = input.fallbackProbe && typeof input.fallbackProbe === 'object'
    ? input.fallbackProbe
    : null;

  const checks = {
    cdp: await probeWebSocket({
      wsUrl: pageCdpUrl,
      mode: 'cdp_ping',
      openTimeoutMs: input.openTimeoutMs,
      maxMessages: input.maxMessages,
    }),
    live: await probeWebSocket({
      wsUrl: liveWsUrl,
      mode: 'trace',
      preferredTargetId: pageTargetId,
      traceDurationMs: input.traceDurationMs,
      openTimeoutMs: input.openTimeoutMs,
      maxMessages: input.maxMessages,
      fallbackProbe,
      pageCdpUrl,
      screenshot: {
        enabled: input.screenshotEnabled !== false,
        outputDir: input.screenshotDir,
        intervalMs: input.screenshotIntervalMs,
        maxScreenshots: input.screenshotMax,
      },
    }),
  };

  const pageStateFromLive = derivePageStateFromLiveSignals({
    liveSignals: checks.live?.liveSignals || null,
    fallbackProbe,
  });

  return {
    checks,
    pageStateFromLive,
  };
}

async function runWsTrace(input = {}) {
  const base = String(input.base || input.ownerApiBase || 'http://127.0.0.1:8787').trim();
  const customerId = String(input.customerId || 'danny').trim();
  const logsRoot = path.resolve(input.logsRoot || '.log');
  const outputRootDir = input.outputRootDir
    ? path.resolve(input.outputRootDir)
    : path.resolve(logsRoot, customerId, 'ws-health');
  const runTag = String(input.runTag || toTimestampTag(new Date())).trim();
  const traceDir = path.resolve(outputRootDir, runTag);
  const screenshotsDir = path.resolve(traceDir, 'screenshots');
  const messageFile = path.resolve(traceDir, 'messages.json');
  const screenshotIndexFile = path.resolve(traceDir, 'screenshots.jsonl');

  const attachMode = String(input.attachMode || 'auto').trim().toLowerCase();
  const shouldAttach = attachMode !== 'none';
  const targetUrl = String(input.targetUrl || '').trim();
  const forceNewSession = input.forceNewSession === true;
  const refreshLiveUrl = input.refreshLiveUrl !== false;

  const traceDurationMs = Number.isFinite(Number(input.traceDurationMs))
    ? Math.max(500, Math.trunc(Number(input.traceDurationMs)))
    : DEFAULT_WS_TRACE_MS;
  const maxMessages = Number.isFinite(Number(input.maxMessages))
    ? Math.max(20, Math.trunc(Number(input.maxMessages)))
    : DEFAULT_WS_MAX_MESSAGES;
  const requestedLiveTimeoutMs = Number.isFinite(Number(input.requestedLiveTimeoutMs))
    ? Math.max(1000, Math.trunc(Number(input.requestedLiveTimeoutMs)))
    : DEFAULT_WS_CHECK_LIVE_URL_TIMEOUT_MS;
  const screenshotEnabled = input.screenshotEnabled !== false;
  const screenshotIntervalMs = Number.isFinite(Number(input.screenshotIntervalMs))
    ? Math.max(250, Math.trunc(Number(input.screenshotIntervalMs)))
    : DEFAULT_WS_SCREENSHOT_INTERVAL_MS;
  const screenshotMax = Number.isFinite(Number(input.screenshotMax))
    ? Math.max(1, Math.trunc(Number(input.screenshotMax)))
    : DEFAULT_WS_SCREENSHOT_MAX;

  const adminApiKey = String(input.adminApiKey || '').trim();
  const requestHeaders = adminApiKey
    ? { 'x-admin-api-key': adminApiKey }
    : {};

  const result = {
    customerId,
    base,
    checkedAt: new Date().toISOString(),
    targetUrl,
    forceNewSession,
    refreshLiveUrl,
    attachMode,
    before: null,
    attach: null,
    refresh: null,
    after: null,
    wsConfig: {
      defaultWsCheckLiveUrlTimeoutMs: DEFAULT_WS_CHECK_LIVE_URL_TIMEOUT_MS,
      requestedLiveTimeoutMs,
      traceDurationMs,
      maxMessages,
      screenshotEnabled,
      screenshotIntervalMs,
      screenshotMax,
    },
    output: {
      traceDir,
      messageFile,
      screenshotIndexFile,
      liveUrlExpiresAt: null,
      screenshotCount: 0,
    },
    checks: {
      cdp: null,
      live: null,
    },
    recovery: {
      attempted: false,
      reason: '',
      applied: false,
    },
    summary: {
      cdpOk: false,
      liveOk: false,
      warnings: [],
    },
    pageStateFromLive: null,
  };

  if (shouldAttach && targetUrl) {
    const attached = await requestJson(
      base,
      `/admin/owners/${encodeURIComponent(customerId)}/attach`,
      {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify({
          forceNewSession,
          bootstrapUrl: targetUrl,
        }),
      }
    );

    result.attach = {
      customerId,
      pageUrl: attached?.status?.pageUrl || '',
      pageTitle: attached?.status?.pageTitle || '',
      pageTargetId: attached?.status?.pageTargetId || '',
      ownerConnected: attached?.status?.ownerConnected === true,
    };
  }

  const before = await requestJson(
    base,
    `/admin/owners/${encodeURIComponent(customerId)}/state`,
    {
      headers: requestHeaders,
    }
  );
  result.before = {
    ownerConnected: before?.status?.ownerConnected === true,
    pageUrl: before?.status?.pageUrl || '',
    pageTargetId: before?.status?.pageTargetId || '',
    liveURL: before?.status?.liveURL || '',
    pageCdpUrl: before?.status?.pageCdpUrl || '',
    probe: before?.probe || null,
  };

  result.wsConfig.beforeLiveTimeoutMs = parseLiveUrlTimeoutMs(result.before.liveURL);

  if (refreshLiveUrl) {
    const refreshed = await requestJson(
      base,
      `/admin/owners/${encodeURIComponent(customerId)}/live-url/refresh`,
      {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify({
          liveUrlOptions: {
            interactive: true,
            showBrowserInterface: true,
            timeout: requestedLiveTimeoutMs,
          },
        }),
      }
    );

    result.refresh = {
      ownerConnected: refreshed?.status?.ownerConnected === true,
      pageUrl: refreshed?.status?.pageUrl || '',
      pageTargetId: refreshed?.status?.pageTargetId || '',
      liveURL: refreshed?.status?.liveURL || '',
      pageCdpUrl: refreshed?.status?.pageCdpUrl || '',
    };
  }

  const after = await requestJson(
    base,
    `/admin/owners/${encodeURIComponent(customerId)}/state`,
    {
      headers: requestHeaders,
    }
  );
  const pageCdpUrl = String(after?.status?.pageCdpUrl || '').trim();
  const liveUrl = String(after?.status?.liveURL || '').trim();
  const liveWsUrl = toLiveWebSocketUrl(liveUrl);

  result.after = {
    ownerConnected: after?.status?.ownerConnected === true,
    pageUrl: after?.status?.pageUrl || '',
    pageTargetId: after?.status?.pageTargetId || '',
    liveURL: liveUrl,
    pageCdpUrl,
    liveWsUrl,
    probe: after?.probe || null,
  };

  if (shouldAttach && targetUrl && isBlankPageUrl(result.after.pageUrl)) {
    result.recovery.attempted = true;
    result.recovery.reason = 'state_page_url_about_blank';

    await requestJson(
      base,
      `/admin/owners/${encodeURIComponent(customerId)}/attach`,
      {
        method: 'POST',
        headers: requestHeaders,
        body: JSON.stringify({
          forceNewSession: true,
          bootstrapUrl: targetUrl,
        }),
      }
    );

    if (refreshLiveUrl) {
      await requestJson(
        base,
        `/admin/owners/${encodeURIComponent(customerId)}/live-url/refresh`,
        {
          method: 'POST',
          headers: requestHeaders,
          body: JSON.stringify({
            liveUrlOptions: {
              interactive: true,
              showBrowserInterface: true,
              timeout: requestedLiveTimeoutMs,
            },
          }),
        }
      );
    }

    const recovered = await requestJson(
      base,
      `/admin/owners/${encodeURIComponent(customerId)}/state`,
      {
        headers: requestHeaders,
      }
    );
    result.after = {
      ownerConnected: recovered?.status?.ownerConnected === true,
      pageUrl: recovered?.status?.pageUrl || '',
      pageTargetId: recovered?.status?.pageTargetId || '',
      liveURL: recovered?.status?.liveURL || '',
      pageCdpUrl: recovered?.status?.pageCdpUrl || '',
      liveWsUrl: toLiveWebSocketUrl(recovered?.status?.liveURL || ''),
      probe: recovered?.probe || null,
    };
    result.recovery.applied = true;
  }

  result.wsConfig.afterLiveTimeoutMs = parseLiveUrlTimeoutMs(result.after.liveURL);

  const traceResult = await traceLiveSession({
    pageCdpUrl: String(result.after.pageCdpUrl || '').trim(),
    liveWsUrl: String(result.after.liveWsUrl || '').trim(),
    pageTargetId: String(result.after.pageTargetId || '').trim(),
    fallbackProbe: result.after.probe || null,
    traceDurationMs,
    maxMessages,
    screenshotEnabled,
    screenshotDir: screenshotsDir,
    screenshotIntervalMs,
    screenshotMax,
  });

  result.checks.cdp = traceResult.checks.cdp;
  result.checks.live = traceResult.checks.live;
  result.pageStateFromLive = traceResult.pageStateFromLive;

  result.summary.cdpOk = result.checks.cdp?.ok === true;
  result.summary.liveOk = result.checks.live?.ok === true;

  if (!targetUrl && shouldAttach) {
    result.summary.warnings.push('No URL was provided. Check used current attached page only.');
  }

  if (isBlankPageUrl(result.after.pageUrl)) {
    result.summary.warnings.push('State pageUrl is about:blank after refresh.');
  }

  if (result.checks.live?.activeTab?.isBlank === true) {
    result.summary.warnings.push('Live active tab is about:blank. Tab selection likely wrong or target is blank.');
  }

  if (result.wsConfig.afterLiveTimeoutMs > 0 && result.wsConfig.afterLiveTimeoutMs < 3000) {
    result.summary.warnings.push(
      `Live URL timeout is short (${result.wsConfig.afterLiveTimeoutMs}ms) and can cause blinking.`
    );
  }

  if (!result.summary.liveOk) {
    result.summary.warnings.push('Live websocket trace failed. Inspect checks.live.error and output.messageFile.');
  }

  if (
    result.pageStateFromLive?.comparedWithProbe === true &&
    result.pageStateFromLive?.matchesProbe === false
  ) {
    result.summary.warnings.push(
      `Probe state mismatch. probe=${result.pageStateFromLive.probeState} live=${result.pageStateFromLive.state}`
    );
  }

  const refreshedLiveUrlInfo = parseLiveUrlIssuedInfo(
    result.refresh?.liveURL || result.after?.liveURL || '',
    result.checkedAt
  );
  result.output.liveUrlExpiresAt = refreshedLiveUrlInfo.expiresAt;

  const screenshotRecords = Array.isArray(result.checks?.live?.screenshots?.records)
    ? result.checks.live.screenshots.records
    : [];
  result.output.screenshotCount = screenshotRecords.filter(item => !item.error).length;

  writeJsonFile(messageFile, {
    checkedAt: result.checkedAt,
    customerId,
    refreshedLiveURL: result.refresh?.liveURL || result.after?.liveURL || '',
    refreshedLiveURLInfo: parseLiveUrlIssuedInfo(
      result.refresh?.liveURL || result.after?.liveURL || '',
      result.checkedAt
    ),
    liveRequestUrl: result.checks?.live?.requestUrl || '',
    cdpRequestUrl: result.checks?.cdp?.requestUrl || '',
    checks: {
      cdp: {
        ok: result.checks?.cdp?.ok === true,
        error: String(result.checks?.cdp?.error || ''),
        closeCode: result.checks?.cdp?.closeCode ?? null,
        closeReason: String(result.checks?.cdp?.closeReason || ''),
        messages: Array.isArray(result.checks?.cdp?.messages)
          ? result.checks.cdp.messages
          : [],
        droppedMessages: result.checks?.cdp?.droppedMessages || 0,
      },
      live: {
        ok: result.checks?.live?.ok === true,
        error: String(result.checks?.live?.error || ''),
        closeCode: result.checks?.live?.closeCode ?? null,
        closeReason: String(result.checks?.live?.closeReason || ''),
        messages: Array.isArray(result.checks?.live?.messages)
          ? result.checks.live.messages
          : [],
        droppedMessages: result.checks?.live?.droppedMessages || 0,
        liveSignals: result.checks?.live?.liveSignals || null,
        screenshots: result.checks?.live?.screenshots || null,
      },
    },
    pageStateFromLive: result.pageStateFromLive,
    summary: result.summary,
  });

  if (fs.existsSync(screenshotIndexFile)) {
    fs.rmSync(screenshotIndexFile, { force: true });
  }
  for (const record of screenshotRecords) {
    appendJsonLine(screenshotIndexFile, record);
  }

  if (result.checks?.cdp && Array.isArray(result.checks.cdp.messages)) {
    result.checks.cdp.messageCount = result.checks.cdp.messages.length;
    delete result.checks.cdp.messages;
  }
  if (result.checks?.live && Array.isArray(result.checks.live.messages)) {
    result.checks.live.messageCount = result.checks.live.messages.length;
    delete result.checks.live.messages;
  }

  result.summary.warnings = result.summary.warnings.filter(Boolean);

  return result;
}

module.exports = {
  DEFAULT_WS_OPEN_TIMEOUT_MS,
  DEFAULT_WS_TRACE_MS,
  DEFAULT_WS_CHECK_LIVE_URL_TIMEOUT_MS,
  DEFAULT_WS_MAX_MESSAGES,
  DEFAULT_WS_SCREENSHOT_INTERVAL_MS,
  DEFAULT_WS_SCREENSHOT_MAX,
  toTimestampTag,
  parseLiveUrlTimeoutMs,
  parseLiveUrlIssuedInfo,
  toLiveWebSocketUrl,
  derivePageStateFromMessages,
  collectLiveSignalsFromMessages,
  probeWebSocket,
  traceLiveSession,
  runWsTrace,
};
