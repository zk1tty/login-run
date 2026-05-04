const fs = require('fs');
const path = require('path');

const {
  buildPageDebuggerWsUrl,
  fetchJson,
  getAuthBootstrapUrl,
  getHostedDevtoolsFrontendUrl,
  getHttpBase,
  getHttpVersionEndpoint,
  getLiveUrlOptions,
  writeJsonFile,
} = require('../../../scripts/lib/helpers');
const { createMicroStepService } = require('../workflow/micro-step-service');
const { resolveSitePack } = require('../../sites/registry');
const { classifyPageState } = require('../detection/page-state-classifier');

const CUSTOMER_ID_PATTERN = /^[A-Za-z0-9._-]+$/;

function parseBoolean(value, fallback) {
  if (value == null || value === '') {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function parseNumber(value, fallback, minimum = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(minimum, Math.trunc(parsed));
}

function appendPathname(basePath, routePath) {
  const normalizedBase = basePath === '/' ? '' : basePath.replace(/\/$/, '');
  const normalizedRoute = routePath.startsWith('/') ? routePath : `/${routePath}`;
  return `${normalizedBase}${normalizedRoute}`;
}

function withToken(urlString) {
  const url = new URL(urlString);
  const token = process.env.BROWSERLESS_TOKEN;

  if (token) {
    url.searchParams.set('token', token);
  }

  return url.toString();
}

function toIso(ms) {
  return Number.isFinite(ms) && ms > 0 ? new Date(ms).toISOString() : null;
}

function parseIsoMs(value) {
  if (!value) {
    return 0;
  }

  const parsed = Date.parse(String(value));
  return Number.isFinite(parsed) ? parsed : 0;
}

function parseTimeoutFromLiveUrl(liveURL) {
  if (!liveURL) {
    return 0;
  }

  try {
    const url = new URL(liveURL);
    const timeoutValue = Number(url.searchParams.get('t') || 0);
    return Number.isFinite(timeoutValue) && timeoutValue > 0
      ? Math.trunc(timeoutValue)
      : 0;
  } catch (error) {
    return 0;
  }
}

function normalizeSessionPayload(payload = {}, defaults = {}) {
  const raw = payload && typeof payload.session === 'object'
    ? payload.session
    : payload;
  const id = String(raw.id || raw.sessionId || '').trim();
  const connect = String(
    raw.connect ||
      raw.connectUrl ||
      raw.connectURL ||
      raw.wsEndpoint ||
      raw.browserWSEndpoint ||
      ''
  ).trim();
  const stop = String(
    raw.stop || raw.stopUrl || raw.stopURL || raw.killURL || ''
  ).trim();
  const browserQL = String(
    raw.browserQL ||
      raw.browserQl ||
      raw.browserQLEndpoint ||
      raw.browserql ||
      ''
  ).trim();
  const ttlMs = parseNumber(raw.ttl || defaults.ttlMs, defaults.ttlMs || 0);
  const processKeepAliveMs = parseNumber(
    raw.processKeepAlive || defaults.processKeepAliveMs,
    defaults.processKeepAliveMs || 0
  );

  return {
    id,
    connect,
    stop,
    browserQL,
    ttlMs,
    processKeepAliveMs,
  };
}

function resolveSessionApiUrl() {
  const url = new URL(getHttpBase());
  url.pathname = appendPathname(url.pathname, '/session');
  return withToken(url.toString());
}

function sanitizeSessionHandle(handle = {}) {
  return {
    id: handle.id || '',
    connect: handle.connect || '',
    stop: handle.stop || '',
    browserQL: handle.browserQL || '',
    ttlMs: parseNumber(handle.ttlMs, 0),
    processKeepAliveMs: parseNumber(handle.processKeepAliveMs, 0),
    createdAt: handle.createdAt || '',
    expiresAt: handle.expiresAt || '',
    sessionPath: handle.sessionPath || '',
  };
}

function createOwnerRuntimeService(options = {}) {
  const sitePack = options.sitePack || resolveSitePack(options.siteId);
  const now = options.now || (() => Date.now());
  const logsRoot = path.resolve(options.logsRoot || process.env.RUN_LOGS_ROOT || '.log');
  const defaultTtlMs = parseNumber(
    options.defaultTtlMs || process.env.SESSION_API_TTL_MS,
    604800000,
    1000
  );
  const defaultProcessKeepAliveMs = parseNumber(
    options.defaultProcessKeepAliveMs || process.env.SESSION_API_PROCESS_KEEP_ALIVE_MS,
    300000,
    0
  );
  const defaultConnectTimeoutMs = parseNumber(
    options.connectTimeoutMs || process.env.SESSION_API_CONNECT_TIMEOUT_MS,
    60000,
    1000
  );
  const autoCreateSession = parseBoolean(
    options.autoCreateSession || process.env.LIVE_ALIAS_AUTO_CREATE_SESSION,
    true
  );
  const autoAttachOwner = parseBoolean(
    options.autoAttachOwner || process.env.LIVE_ALIAS_AUTO_ATTACH_OWNER,
    true
  );
  const defaultBootstrapUrl = options.defaultBootstrapUrl || getAuthBootstrapUrl();
  const defaultLiveUrlOptions = {
    ...getLiveUrlOptions(),
    ...(options.defaultLiveUrlOptions || {}),
  };
  const entries = new Map();

  function clearLiveUrlState(entry) {
    entry.liveURL = '';
    entry.liveURLId = '';
    entry.liveURLExpiresAtMs = 0;
  }

  function clearPageMetadataState(entry) {
    entry.devtoolsURL = '';
    entry.pageCdpUrl = '';
    entry.pageTargetId = '';
    entry.pageUrl = '';
    entry.pageTitle = '';
    entry.lastProbe = null;
  }

  function clearForceNewAttachState(entry) {
    clearLiveUrlState(entry);
    clearPageMetadataState(entry);
  }

  function reconcileEntry(entry) {
    if (!entry || typeof entry !== 'object') {
      return;
    }
    if (!entry.actionProgress || typeof entry.actionProgress !== 'object') {
      entry.actionProgress = null;
    }
    if (!entry.lastAction || typeof entry.lastAction !== 'object') {
      entry.lastAction = null;
    }
    if (!Array.isArray(entry.actionCheckpoints)) {
      entry.actionCheckpoints = [];
    }
  }

  function assertCustomerId(customerId) {
    const value = String(customerId || '').trim();

    if (!CUSTOMER_ID_PATTERN.test(value)) {
      const error = new Error('Invalid customerId format.');
      error.statusCode = 400;
      throw error;
    }

    return value;
  }

  function getSessionPath(customerId) {
    return path.resolve(logsRoot, customerId, 'owner-session.json');
  }

  function getEntry(customerId) {
    if (entries.has(customerId)) {
      return entries.get(customerId);
    }

    const entry = {
      customerId,
      session: null,
      browser: null,
      page: null,
      ownerConnected: false,
      status: 'idle',
      liveURL: '',
      liveURLId: '',
      liveURLExpiresAtMs: 0,
      devtoolsURL: '',
      pageCdpUrl: '',
      pageTargetId: '',
      pageUrl: '',
      pageTitle: '',
      lastProbe: null,
      actionProgress: null,
      lastAction: null,
      actionCheckpoints: [],
      lastError: '',
      updatedAtMs: 0,
    };
    entries.set(customerId, entry);
    return entry;
  }

  function readPersistedSession(customerId) {
    const filePath = getSessionPath(customerId);

    if (!fs.existsSync(filePath)) {
      return null;
    }

    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      return sanitizeSessionHandle(parsed);
    } catch (error) {
      return null;
    }
  }

  function writeSession(customerId, session) {
    const sessionPath = getSessionPath(customerId);
    const payload = {
      ...sanitizeSessionHandle(session),
      sessionPath,
    };
    writeJsonFile(sessionPath, payload);
    return payload;
  }

  function clearSessionFile(customerId) {
    const sessionPath = getSessionPath(customerId);

    if (!fs.existsSync(sessionPath)) {
      return;
    }

    fs.unlinkSync(sessionPath);
  }

  async function createSessionRequest(input = {}) {
    const sessionApiUrl = resolveSessionApiUrl();
    const payload = {
      ttl: parseNumber(input.ttlMs, defaultTtlMs, 1000),
      processKeepAlive: parseNumber(
        input.processKeepAliveMs,
        defaultProcessKeepAliveMs,
        0
      ),
    };

    const response = await fetch(sessionApiUrl, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      throw new Error(`Session API create failed: HTTP ${response.status}`);
    }

    return {
      data: await response.json(),
      payload,
      sessionApiUrl,
    };
  }

  async function ensureSession(input = {}) {
    const customerId = assertCustomerId(input.customerId);
    const entry = getEntry(customerId);
    const forceNew = input.forceNew === true;
    const allowCreate = input.allowCreate !== false;

    if (!forceNew && entry.session && entry.session.connect && entry.session.stop) {
      return sanitizeSessionHandle(entry.session);
    }

    if (!forceNew) {
      const persisted = readPersistedSession(customerId);
      if (persisted && persisted.connect && persisted.stop) {
        entry.session = persisted;
        entry.status = entry.ownerConnected ? entry.status : 'session_ready';
        entry.updatedAtMs = now();
        return sanitizeSessionHandle(entry.session);
      }
    }

    if (!allowCreate || !autoCreateSession) {
      const error = new Error(
        'No persisted Browserless session found and auto-creation is disabled.'
      );
      error.statusCode = 409;
      throw error;
    }

    const createdAtMs = now();
    const requestResult = await createSessionRequest(input);
    const normalized = normalizeSessionPayload(requestResult.data, requestResult.payload);

    if (!normalized.id || !normalized.connect || !normalized.stop) {
      throw new Error('Session API response missing id/connect/stop.');
    }

    const session = writeSession(customerId, {
      ...normalized,
      createdAt: new Date(createdAtMs).toISOString(),
      expiresAt: toIso(createdAtMs + normalized.ttlMs),
    });

    entry.session = session;
    entry.status = entry.ownerConnected ? entry.status : 'session_ready';
    entry.lastError = '';
    entry.updatedAtMs = createdAtMs;
    return sanitizeSessionHandle(entry.session);
  }

  function loadPuppeteer() {
    if (options.puppeteer) {
      return options.puppeteer;
    }

    try {
      // Lazy load to keep startup resilient before dependency installation.
      return require('puppeteer-core');
    } catch (error) {
      const wrapped = new Error(
        'Missing dependency: puppeteer-core. Install it with `npm install puppeteer-core`.'
      );
      wrapped.statusCode = 500;
      throw wrapped;
    }
  }

  async function pickActivePage(browser, bootstrapUrl) {
    const pages = await browser.pages();
    const existing =
      pages.find(page => {
        const url = String(page.url() || '').trim();
        return url && url !== 'about:blank';
      }) ||
      pages[0] ||
      null;
    const page = existing || (await browser.newPage());
    const currentUrl = String(page.url() || '').trim();

    if (bootstrapUrl) {
      await page.goto(bootstrapUrl, {
        waitUntil: 'domcontentloaded',
        timeout: 60000,
      });
    }

    return page;
  }

  async function buildDevtoolsSnapshot(page, sessionConnectUrl = '') {
    const targetId = String(page?.target()?._targetId || '').trim();
    const pageCdpUrl = buildPageDebuggerWsUrl(targetId, sessionConnectUrl);
    let debuggerVersion = '';

    try {
      const version = await fetchJson(getHttpVersionEndpoint());
      debuggerVersion = String(version?.['Debugger-Version'] || '').trim();
    } catch (error) {
      // Best effort only.
    }

    const devtoolsURL = getHostedDevtoolsFrontendUrl(debuggerVersion, pageCdpUrl);

    return {
      targetId,
      pageCdpUrl,
      devtoolsURL,
      pageUrl: String(page?.url() || '').trim(),
      pageTitle: '',
    };
  }

  const microStepService = createMicroStepService({
    now,
    microStepConfigRoot: options.microStepConfigRoot,
    microStepConfigSite:
      options.microStepConfigSite || sitePack.microStepConfigSite,
    microStepConfigWorkflow:
      options.microStepConfigWorkflow || sitePack.defaultWorkflow,
    assertCustomerId,
    getEntry,
    reconcileEntry,
    attachOwner,
    toIso,
    toPublicStatus,
  });

  const hsaService = sitePack.createHsaService({
    now,
    assertCustomerId,
    getEntry,
    reconcileEntry,
  });

  function toPublicStatus(entry) {
    const nowMs = now();
    const liveUrlExpired =
      entry.liveURLExpiresAtMs > 0 && entry.liveURLExpiresAtMs <= nowMs;
    const sessionExpired =
      parseIsoMs(entry.session?.expiresAt) > 0 &&
      parseIsoMs(entry.session?.expiresAt) <= nowMs;

    return {
      customerId: entry.customerId,
      status: entry.status,
      ownerConnected: entry.ownerConnected === true,
      sessionId: entry.session?.id || '',
      sessionExpiresAt: entry.session?.expiresAt || null,
      sessionExpired,
      liveURL: entry.liveURL || '',
      liveURLId: entry.liveURLId || '',
      liveURLExpiresAt: toIso(entry.liveURLExpiresAtMs),
      liveURLExpired: liveUrlExpired,
      expiresAt: toIso(entry.liveURLExpiresAtMs),
      devtoolsURL: entry.devtoolsURL || '',
      pageCdpUrl: entry.pageCdpUrl || '',
      pageTargetId: entry.pageTargetId || '',
      pageUrl: entry.pageUrl || '',
      pageTitle: entry.pageTitle || '',
      lastProbe: entry.lastProbe || null,
      actionProgress: entry.actionProgress || null,
      lastAction: entry.lastAction || null,
      actionCheckpoints: Array.isArray(entry.actionCheckpoints)
        ? entry.actionCheckpoints.slice(-10)
        : [],
      lastError: entry.lastError || null,
      updatedAt: toIso(entry.updatedAtMs),
      sessionPath: entry.session?.sessionPath || getSessionPath(entry.customerId),
      microStepConfig: microStepService.getMicroStepConfigSummary(),
    };
  }

  async function attachOwner(input = {}) {
    const customerId = assertCustomerId(input.customerId);
    const entry = getEntry(customerId);
    reconcileEntry(entry);
    const forceNewSession = input.forceNewSession === true;
    const bootstrapUrl =
      input.bootstrapUrl == null ? defaultBootstrapUrl : input.bootstrapUrl;
    const session = await ensureSession({
      customerId,
      ttlMs: input.ttlMs,
      processKeepAliveMs: input.processKeepAliveMs,
      forceNew: forceNewSession,
      allowCreate: input.allowCreate !== false,
    });

    if (forceNewSession && entry.ownerConnected && entry.browser && entry.page) {
      await detachOwner({ customerId });
      clearForceNewAttachState(entry);
    }

    if (entry.ownerConnected && entry.browser && entry.page) {
      if (bootstrapUrl) {
        await entry.page.goto(bootstrapUrl, {
          waitUntil: 'domcontentloaded',
          timeout: 60000,
        });
      }
      const devtools = await buildDevtoolsSnapshot(entry.page, session?.connect || entry.session?.connect || '');
      entry.status = entry.liveURL ? 'ready' : 'owner_attached';
      entry.pageTargetId = devtools.targetId;
      entry.pageCdpUrl = devtools.pageCdpUrl;
      entry.devtoolsURL = devtools.devtoolsURL;
      entry.pageUrl = devtools.pageUrl;
      entry.pageTitle = devtools.pageTitle;
      entry.lastProbe = null;
      entry.lastError = '';
      entry.updatedAtMs = now();
      return toPublicStatus(entry);
    }

    if (!autoAttachOwner && input.forceAttach !== true) {
      const error = new Error('Owner auto-attach is disabled.');
      error.statusCode = 409;
      throw error;
    }

    const puppeteer = loadPuppeteer();
    const browser = await puppeteer.connect({
      browserWSEndpoint: session.connect,
      protocolTimeout: parseNumber(input.connectTimeoutMs, defaultConnectTimeoutMs, 1000),
      defaultViewport: null,
    });
    const page = await pickActivePage(browser, bootstrapUrl);
    const devtools = await buildDevtoolsSnapshot(page, session?.connect || '');

    browser.on('disconnected', () => {
      if (entry.browser !== browser) {
        return;
      }

      entry.ownerConnected = false;
      entry.browser = null;
      entry.page = null;
      entry.status = entry.session ? 'session_ready' : 'idle';
      entry.updatedAtMs = now();
    });

    entry.browser = browser;
    entry.page = page;
    if (forceNewSession) {
      clearForceNewAttachState(entry);
    }
    entry.ownerConnected = true;
    entry.status = 'owner_attached';
    entry.pageTargetId = devtools.targetId;
    entry.pageCdpUrl = devtools.pageCdpUrl;
    entry.devtoolsURL = devtools.devtoolsURL;
    entry.pageUrl = devtools.pageUrl;
    entry.pageTitle = devtools.pageTitle;
    entry.lastError = '';
    entry.updatedAtMs = now();

    return toPublicStatus(entry);
  }

  async function refreshLiveUrl(input = {}) {
    const customerId = assertCustomerId(input.customerId);
    const entry = getEntry(customerId);
    reconcileEntry(entry);

    if (!entry.ownerConnected || !entry.page) {
      await attachOwner({
        customerId,
        allowCreate: input.allowCreate !== false,
        forceAttach: true,
      });
    }

    const currentEntry = getEntry(customerId);
    const page = currentEntry.page;
    const cdp = await page.target().createCDPSession();
    const optionsLiveUrl = {
      ...defaultLiveUrlOptions,
      ...(input.liveUrlOptions || {}),
    };
    const result = await cdp.send('Browserless.liveURL', optionsLiveUrl);
    const liveURL = String(result?.liveURL || '').trim();
    const liveURLId = String(result?.liveURLId || '').trim();
    const liveUrlError = String(result?.error || '').trim();

    if (!liveURL) {
      throw new Error(
        liveUrlError || 'Browserless.liveURL returned no liveURL.'
      );
    }

    const devtools = await buildDevtoolsSnapshot(page, currentEntry.session?.connect || '');
    const refreshedAtMs = now();
    const timeoutMs = parseTimeoutFromLiveUrl(liveURL);

    currentEntry.liveURL = liveURL;
    currentEntry.liveURLId = liveURLId;
    currentEntry.liveURLExpiresAtMs = timeoutMs > 0 ? refreshedAtMs + timeoutMs : 0;
    currentEntry.devtoolsURL = devtools.devtoolsURL;
    currentEntry.pageCdpUrl = devtools.pageCdpUrl;
    currentEntry.pageTargetId = devtools.targetId;
    currentEntry.pageUrl = devtools.pageUrl;
    currentEntry.status = 'ready';
    currentEntry.lastError = '';
    currentEntry.updatedAtMs = refreshedAtMs;

    return toPublicStatus(currentEntry);
  }

  async function detachOwner(input = {}) {
    const customerId = assertCustomerId(input.customerId);
    const entry = getEntry(customerId);
    reconcileEntry(entry);

    if (entry.browser && entry.ownerConnected) {
      try {
        if (typeof entry.browser.disconnect === 'function') {
          entry.browser.disconnect();
        } else {
          await entry.browser.close();
        }
      } catch (error) {
        // Best effort only.
      }
    }

    entry.browser = null;
    entry.page = null;
    entry.ownerConnected = false;
    entry.status = entry.session ? 'session_ready' : 'idle';
    entry.updatedAtMs = now();

    return toPublicStatus(entry);
  }

  async function stopSession(input = {}) {
    const customerId = assertCustomerId(input.customerId);
    const entry = getEntry(customerId);
    reconcileEntry(entry);
    await detachOwner({ customerId });

    const session = entry.session || readPersistedSession(customerId);
    if (session && session.stop) {
      const methods = ['DELETE', 'POST', 'GET'];
      let lastError = null;

      for (const method of methods) {
        try {
          const response = await fetch(withToken(session.stop), { method });
          if (response.ok || response.status === 404) {
            lastError = null;
            break;
          }
          lastError = new Error(`Stop endpoint responded with HTTP ${response.status}.`);
        } catch (error) {
          lastError = error;
        }
      }

      if (lastError) {
        entry.lastError = String(lastError?.message || lastError);
        entry.updatedAtMs = now();
        throw lastError;
      }
    }

    clearSessionFile(customerId);
    entry.session = null;
    entry.liveURL = '';
    entry.liveURLId = '';
    entry.liveURLExpiresAtMs = 0;
    entry.devtoolsURL = '';
    entry.pageCdpUrl = '';
    entry.pageTargetId = '';
    entry.pageUrl = '';
    entry.pageTitle = '';
    entry.lastProbe = null;
    entry.actionProgress = null;
    entry.lastAction = null;
    entry.actionCheckpoints = [];
    entry.status = 'idle';
    entry.lastError = '';
    entry.updatedAtMs = now();

    return toPublicStatus(entry);
  }

  async function probeState(input = {}) {
    const customerId = assertCustomerId(input.customerId);
    const entry = getEntry(customerId);
    reconcileEntry(entry);

    if (!entry.ownerConnected || !entry.page) {
      const probe = {
        state: 'owner_disconnected',
        reason: 'Owner browser is not attached.',
        url: '',
        title: '',
      };
      entry.lastProbe = probe;
      entry.updatedAtMs = now();
      return probe;
    }

    const page = entry.page;
    const rawSignals = await page.evaluate(() => {
      const textRaw = String(document.body?.innerText || '').slice(0, 30000);
      const title = String(document.title || '');
      const url = String(window.location.href || '');

      const hasPasswordInput = Boolean(
        document.querySelector('input[type="password"]')
      );
      const hasLoginIdentifierInput = Boolean(
        document.querySelector(
          'input[type="email"], input[name*="email" i], input[id*="email" i], input[name*="user" i], input[id*="user" i], input[name*="login" i], input[id*="login" i], input[name*="member" i], input[id*="member" i], input[name*="account" i], input[id*="account" i]'
        )
      );
      const hasOtpInput = Boolean(
        document.querySelector(
          'input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], input[name*="code" i], input[id*="code" i]'
        )
      );

      const turnstileFrames = Array.from(document.querySelectorAll('iframe')).filter(frame => {
        const src = String(frame.getAttribute('src') || '').toLowerCase();
        const id = String(frame.getAttribute('id') || '').toLowerCase();
        const titleAttr = String(frame.getAttribute('title') || '').toLowerCase();
        const corpus = `${src} ${id} ${titleAttr}`;
        return (
          corpus.includes('challenges.cloudflare.com') ||
          corpus.includes('/cdn-cgi/challenge-platform/') ||
          corpus.includes('turnstile') ||
          corpus.includes('cloudflare')
        );
      });

      const hasVisibleTurnstileFrame = turnstileFrames.some(frame => {
        const style = window.getComputedStyle(frame);
        if (!style || style.display === 'none' || style.visibility === 'hidden') {
          return false;
        }
        const rect = frame.getBoundingClientRect();
        return rect.width > 1 && rect.height > 1;
      });

      return {
        text: textRaw,
        url,
        title,
        hasPasswordInput,
        hasLoginIdentifierInput,
        hasOtpInput,
        hasTurnstile: turnstileFrames.length > 0,
        hasTurnstileCheckbox: hasVisibleTurnstileFrame,
      };
    });
    const probe = classifyPageState(rawSignals);
    probe.hasPasswordInput = rawSignals.hasPasswordInput === true;
    probe.hasLoginIdentifierInput = rawSignals.hasLoginIdentifierInput === true;
    probe.hasOtpInput = rawSignals.hasOtpInput === true;
    if (probe.hasTurnstile !== true) {
      probe.hasTurnstile = rawSignals.hasTurnstile === true;
    }

    entry.lastProbe = probe;
    entry.pageUrl = probe.url || entry.pageUrl;
    entry.pageTitle = probe.title || entry.pageTitle;
    entry.updatedAtMs = now();
    return probe;
  }

  async function executeMicroStep(input = {}) {
    return microStepService.executeMicroStep(input);
  }

  async function resetMicroStepProgress(input = {}) {
    return microStepService.resetMicroStepProgress(input);
  }

  async function extractHsaData(input = {}) {
    return hsaService.extractHsaData(input);
  }

  function getStatus(customerId) {
    const normalizedCustomerId = assertCustomerId(customerId);
    const entry = getEntry(normalizedCustomerId);
    reconcileEntry(entry);

    if (!entry.session) {
      const persisted = readPersistedSession(normalizedCustomerId);
      if (persisted) {
        entry.session = persisted;
        entry.status = entry.ownerConnected ? entry.status : 'session_ready';
      }
    }

    return toPublicStatus(entry);
  }

  async function close() {
    for (const entry of entries.values()) {
      if (!entry.browser || !entry.ownerConnected) {
        continue;
      }

      try {
        if (typeof entry.browser.disconnect === 'function') {
          entry.browser.disconnect();
        } else {
          await entry.browser.close();
        }
      } catch (error) {
        // Best effort only.
      }
      entry.browser = null;
      entry.page = null;
      entry.ownerConnected = false;
      entry.status = entry.session ? 'session_ready' : 'idle';
      entry.updatedAtMs = now();
    }
  }

  return {
    ensureSession,
    attachOwner,
    refreshLiveUrl,
    detachOwner,
    stopSession,
    probeState,
    executeMicroStep,
    resetMicroStepProgress,
    extractHsaData,
    getStatus,
    close,
  };
}

module.exports = {
  createOwnerRuntimeService,
};
