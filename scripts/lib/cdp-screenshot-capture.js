const fs = require('fs');
const path = require('path');

const DEFAULT_OPEN_TIMEOUT_MS = 5000;
const DEFAULT_COMMAND_TIMEOUT_MS = 8000;

function toSafeError(error) {
  return String(error?.message || error || 'unknown_error');
}

function sanitizeFileToken(value, fallback = 'capture') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function createNowLabel() {
  const now = new Date();
  const yyyy = String(now.getFullYear());
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const hh = String(now.getHours()).padStart(2, '0');
  const min = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  const ms = String(now.getMilliseconds()).padStart(3, '0');
  return `${yyyy}${mm}${dd}-${hh}${min}${ss}-${ms}`;
}

async function createCdpClient(input = {}) {
  const wsUrl = String(input.wsUrl || '').trim();
  const openTimeoutMs = Number.isFinite(Number(input.openTimeoutMs))
    ? Math.max(1000, Math.trunc(Number(input.openTimeoutMs)))
    : DEFAULT_OPEN_TIMEOUT_MS;
  const commandTimeoutMs = Number.isFinite(Number(input.commandTimeoutMs))
    ? Math.max(1000, Math.trunc(Number(input.commandTimeoutMs)))
    : DEFAULT_COMMAND_TIMEOUT_MS;

  if (!wsUrl) {
    throw new Error('missing_page_cdp_ws_url');
  }
  if (typeof WebSocket !== 'function') {
    throw new Error('WebSocket API is unavailable in this Node runtime.');
  }

  const ws = new WebSocket(wsUrl);
  let opened = false;
  let closed = false;
  let nextId = 1;
  const pending = new Map();

  const openPromise = new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`cdp_open_timeout_${openTimeoutMs}ms`));
    }, openTimeoutMs);

    ws.addEventListener('open', () => {
      opened = true;
      clearTimeout(timer);
      resolve();
    }, { once: true });

    ws.addEventListener('error', () => {
      if (opened) {
        return;
      }
      clearTimeout(timer);
      reject(new Error('cdp_open_error'));
    }, { once: true });

    ws.addEventListener('close', event => {
      closed = true;
      if (!opened) {
        clearTimeout(timer);
        reject(new Error(`cdp_closed_before_open_${event?.code ?? 'unknown'}`));
      }
    }, { once: true });
  });

  function clearPendingWithError(error) {
    for (const [id, entry] of pending.entries()) {
      clearTimeout(entry.timer);
      entry.reject(error);
      pending.delete(id);
    }
  }

  ws.addEventListener('message', event => {
    const text = typeof event?.data === 'string' ? event.data : '';
    if (!text) {
      return;
    }

    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      return;
    }

    const id = Number(parsed?.id);
    if (!Number.isFinite(id) || !pending.has(id)) {
      return;
    }

    const entry = pending.get(id);
    pending.delete(id);
    clearTimeout(entry.timer);

    if (parsed?.error) {
      entry.reject(new Error(String(parsed.error?.message || 'cdp_command_error')));
      return;
    }

    entry.resolve(parsed?.result || {});
  });

  ws.addEventListener('close', event => {
    closed = true;
    clearPendingWithError(new Error(`cdp_closed_${event?.code ?? 'unknown'}`));
  });

  ws.addEventListener('error', () => {
    clearPendingWithError(new Error('cdp_socket_error'));
  });

  await openPromise;

  async function send(method, params = {}) {
    if (closed) {
      throw new Error('cdp_socket_closed');
    }

    const id = nextId;
    nextId += 1;

    const payload = JSON.stringify({
      id,
      method,
      params,
    });

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        if (pending.has(id)) {
          pending.delete(id);
        }
        reject(new Error(`cdp_command_timeout_${method}_${commandTimeoutMs}ms`));
      }, commandTimeoutMs);

      pending.set(id, {
        resolve,
        reject,
        timer,
      });

      try {
        ws.send(payload);
      } catch (error) {
        clearTimeout(timer);
        pending.delete(id);
        reject(error);
      }
    });
  }

  async function close() {
    closed = true;
    clearPendingWithError(new Error('cdp_client_closed'));
    try {
      ws.close();
    } catch (error) {
      // Best effort only.
    }
  }

  return {
    send,
    close,
  };
}

async function createCdpScreenshotCaptureSession(input = {}) {
  const enabled = input.enabled !== false;
  const outputDir = path.resolve(String(input.outputDir || '.'));
  const pageCdpUrl = String(input.pageCdpUrl || '').trim();

  if (!enabled) {
    return {
      enabled: false,
      records: [],
      droppedCount: 0,
      error: '',
      async capture() {
        return null;
      },
      async close() {},
    };
  }

  fs.mkdirSync(outputDir, { recursive: true });

  let client = null;
  let initialized = false;
  let captureCount = 0;
  let droppedCount = 0;
  let sessionError = '';
  const records = [];

  try {
    client = await createCdpClient({
      wsUrl: pageCdpUrl,
      openTimeoutMs: input.openTimeoutMs,
      commandTimeoutMs: input.commandTimeoutMs,
    });
  } catch (error) {
    sessionError = toSafeError(error);
  }

  async function ensureInitialized() {
    if (!client) {
      throw new Error(sessionError || 'cdp_screenshot_client_unavailable');
    }
    if (initialized) {
      return;
    }
    await client.send('Page.enable');
    initialized = true;
  }

  async function capture(context = {}) {
    const at = String(context.at || createNowLabel());
    const reason = sanitizeFileToken(context.reason || 'periodic', 'periodic');
    const state = sanitizeFileToken(context.state || 'unknown', 'unknown');
    const pageType = sanitizeFileToken(context.turnstilePageType || 'none', 'none');

    if (!client) {
      droppedCount += 1;
      const droppedRecord = {
        at,
        reason,
        state,
        turnstilePageType: pageType,
        screenshotPath: '',
        error: sessionError || 'cdp_screenshot_client_unavailable',
      };
      records.push(droppedRecord);
      return droppedRecord;
    }

    const shotIndex = captureCount + 1;
    const fileName = `${String(shotIndex).padStart(4, '0')}-${sanitizeFileToken(at)}-${reason}-${state}-${pageType}.png`;
    const screenshotPath = path.resolve(outputDir, fileName);

    try {
      await ensureInitialized();
      const result = await client.send('Page.captureScreenshot', {
        format: 'png',
        fromSurface: true,
      });
      const buffer = Buffer.from(String(result?.data || ''), 'base64');
      fs.writeFileSync(screenshotPath, buffer);
      captureCount += 1;
      const record = {
        at,
        reason,
        state,
        turnstilePageType: pageType,
        screenshotPath,
        error: '',
      };
      records.push(record);
      return record;
    } catch (error) {
      droppedCount += 1;
      const record = {
        at,
        reason,
        state,
        turnstilePageType: pageType,
        screenshotPath: '',
        error: toSafeError(error),
      };
      records.push(record);
      return record;
    }
  }

  async function close() {
    if (!client) {
      return;
    }
    await client.close();
    client = null;
  }

  return {
    enabled: true,
    records,
    get droppedCount() {
      return droppedCount;
    },
    get error() {
      return sessionError;
    },
    capture,
    close,
  };
}

function createScreenshotScheduler(input = {}) {
  const enabled = input.enabled !== false;
  const intervalMs = Number.isFinite(Number(input.intervalMs))
    ? Math.max(250, Math.trunc(Number(input.intervalMs)))
    : 2000;
  const maxShots = Number.isFinite(Number(input.maxShots))
    ? Math.max(1, Math.trunc(Number(input.maxShots)))
    : 120;
  const setIntervalFn = typeof input.setIntervalFn === 'function' ? input.setIntervalFn : setInterval;
  const clearIntervalFn = typeof input.clearIntervalFn === 'function' ? input.clearIntervalFn : clearInterval;
  const captureFn = typeof input.captureFn === 'function'
    ? input.captureFn
    : async () => null;
  const contextProvider = typeof input.contextProvider === 'function'
    ? input.contextProvider
    : () => ({});

  let timer = null;
  let totalScheduled = 0;
  let droppedCount = 0;
  let stopped = false;
  let queue = Promise.resolve();
  let lastTransitionKey = '';

  function enqueueCapture(reason, context = {}) {
    if (!enabled || stopped) {
      return;
    }

    if (totalScheduled >= maxShots) {
      droppedCount += 1;
      return;
    }

    totalScheduled += 1;
    const payload = {
      ...context,
      reason,
    };

    queue = queue
      .then(() => captureFn(payload))
      .catch(() => null);
  }

  function start() {
    if (!enabled || timer) {
      return;
    }

    // Capture immediately so very short-lived traces still produce evidence.
    enqueueCapture('start', contextProvider());

    timer = setIntervalFn(() => {
      enqueueCapture('periodic', contextProvider());
    }, intervalMs);
  }

  function notifyTransition(context = {}) {
    if (!enabled || stopped) {
      return;
    }

    const key = String(
      context.transitionKey || `${context.state || ''}:${context.turnstilePageType || ''}`
    ).trim();

    if (!key || key === lastTransitionKey) {
      return;
    }

    lastTransitionKey = key;
    enqueueCapture('transition', context);
  }

  async function stop() {
    stopped = true;
    if (timer) {
      clearIntervalFn(timer);
      timer = null;
    }
    await queue;
  }

  function getSummary() {
    return {
      enabled,
      intervalMs,
      maxShots,
      totalScheduled,
      droppedCount,
    };
  }

  return {
    start,
    notifyTransition,
    stop,
    getSummary,
  };
}

module.exports = {
  createCdpScreenshotCaptureSession,
  createScreenshotScheduler,
};
