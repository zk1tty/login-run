const { chromium } = require('playwright-core');

const {
  configureAgentQl,
  connectBrowser,
  createContext,
  createWrappedPage,
  detectAuthenticationState,
  getLoginConfig,
  hasAnyDevtoolsUrl,
  performCredentialLogin,
  printDevtoolsInfo,
  resolveDevtoolsUrl,
  waitForPageReady,
} = require('./login-agentql-common');
const {
  getCustomerPaths,
  getCustomerId,
  hasDirectoryEntries,
  getLiveUrlOptions,
  loadAuthStateFromPaths,
  primeContextFromAuthState,
  resolveHostPathForBrowserlessPath,
  validateBrowserProfileRootForRuntime,
  writeAuthFiles,
} = require('../../../lib/helpers');
const {
  DECISION_CASES,
  buildAuthCheckpoint,
  createReuseLiveSessionLogger,
  findLiveBrowserSessionByUserDataDir,
  getAttachableBrowserWSEndpoint,
  getReuseLiveSessionConfig,
  getReuseLiveSessionLogPaths,
  sanitizeSession,
} = require('../../../lib/session-reuse');

function parseBoolean(value, fallback = true) {
  if (value == null || value === '') {
    return fallback;
  }

  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function shouldSkipAgentQlInjection() {
  return parseBoolean(process.env.REUSE_SESSION_SKIP_AGENTQL, true);
}

function shouldKeepBrowserOnError() {
  return parseBoolean(process.env.REUSE_SESSION_KEEP_BROWSER_ON_ERROR, true);
}

async function createPage(context, skipAgentQlInjection) {
  return skipAgentQlInjection ? context.newPage() : createWrappedPage(context);
}

async function refreshLiveUrlInfo(context, page, logger) {
  try {
    const cdp = await context.newCDPSession(page);
    const result = await cdp.send('Browserless.liveURL', getLiveUrlOptions());
    const liveURL = String(result?.liveURL || '').trim();
    const liveURLId = String(result?.liveURLId || '').trim();

    logger.event('live-url', {
      liveURL,
      liveURLId,
      emitted: Boolean(liveURL),
    });

    return {
      liveURL,
      liveURLId,
    };
  } catch (error) {
    logger.event('live-url-error', {
      message: String(error?.message || error),
    });
    return {
      liveURL: '',
      liveURLId: '',
    };
  }
}

function buildRunResult(summary = {}, options = {}) {
  const liveUrlInfo = summary.liveUrlInfo || {};
  const devtools = summary.devtools || {};

  return {
    ok: options.ok !== false,
    customerId: summary.customerId || '',
    liveURL: liveUrlInfo.liveURL || '',
    liveURLId: liveUrlInfo.liveURLId || '',
    devtoolsURL: devtools.hostedDevtoolsUrl || '',
    pageCdpUrl: devtools.pageCdpUrl || '',
    pageTargetId: devtools.targetId || '',
    sessionReuseResult: summary.sessionReuseResult || '',
    decisionCase: summary.decisionCase || '',
    finalUrl: summary.finalUrl || '',
    startedAt: summary.startedAt || '',
    completedAt: summary.completedAt || '',
    error: options.error || '',
  };
}

async function runReuseLiveSession(runOptions = {}) {
  validateBrowserProfileRootForRuntime();

  const config = getLoginConfig();
  const reuseConfig = {
    ...getReuseLiveSessionConfig(),
  };
  const skipAgentQlInjection =
    runOptions.skipAgentQlInjection == null
      ? shouldSkipAgentQlInjection()
      : parseBoolean(runOptions.skipAgentQlInjection, true);

  const customerId = String(runOptions.customerId || '').trim() || getCustomerId();
  const customerPaths = getCustomerPaths(customerId);
  const hostBrowserProfileDir = resolveHostPathForBrowserlessPath(
    customerPaths.browserProfileDir
  );
  const hostProfileDirExists = hasDirectoryEntries(hostBrowserProfileDir);
  const authState = loadAuthStateFromPaths(
    customerPaths.storageStatePath,
    customerPaths.cookiesPath
  );
  const logPaths = getReuseLiveSessionLogPaths(customerPaths.customerId);
  const logger = createReuseLiveSessionLogger({
    customerId: customerPaths.customerId,
    ...logPaths,
  });

  logger.set({
    customerId: customerPaths.customerId,
    browserProfileDir: customerPaths.browserProfileDir,
    browserlessUserDataDir: customerPaths.browserProfileDir,
    hostBrowserProfileDir,
    hostProfileDirExists,
    storageStatePath: customerPaths.storageStatePath,
    cookiesPath: customerPaths.cookiesPath,
    authSnapshotAvailable: Boolean(authState),
    skipAgentQlInjection,
    reuseConfig,
  });

  const liveBrowserSession = await findLiveBrowserSessionByUserDataDir(
    customerPaths.browserProfileDir
  );
  logger.event('live-browser-check', {
    found: Boolean(liveBrowserSession),
    session: sanitizeSession(liveBrowserSession),
  });

  if (!liveBrowserSession && !hostProfileDirExists && !authState) {
    logger.finish({
      error:
        'No live Browserless session, customer profile, or auth snapshot found. Run the initial login first.',
    });
    throw new Error(
      'No live Browserless session, customer profile, or auth snapshot found. Run the initial login first.'
    );
  }

  if (!skipAgentQlInjection) {
    configureAgentQl(config.apiKey);
  }

  const startedAt = new Date().toISOString();
  let browser;
  let context;
  let page;
  let devtools = {};
  let authResult = null;
  let liveUrlInfo = {};
  let decisionCase = DECISION_CASES.UNDETERMINED;
  let sessionReuseResult = 'fresh_browser';

  try {
    if (liveBrowserSession) {
      const endpoint = getAttachableBrowserWSEndpoint(liveBrowserSession);
      if (endpoint) {
        browser = await chromium.connectOverCDP(endpoint);
        context = await createContext(browser);
        page = await createPage(context, skipAgentQlInjection);
        sessionReuseResult = 'attached_live_browser';
      }
    }

    if (!browser) {
      process.env.BROWSERLESS_REMOTE_USER_DATA_DIR = customerPaths.browserProfileDir;
      ({ browser } = await connectBrowser(config.connectMode));
      context = await createContext(browser);
      page = await createPage(context, skipAgentQlInjection);
    }

    if (authState?.state) {
      await primeContextFromAuthState(context, authState.state);
      logger.event('auth-state-primed', {
        sourceType: authState.sourceType,
        sourcePath: authState.sourcePath,
      });
    }

    await page.goto(config.bootstrapUrl || config.url, { waitUntil: 'load' });
    try {
      await waitForPageReady(page);
    } catch (error) {
      // Best effort only.
    }

    authResult = await detectAuthenticationState(page, config);
    logger.addProbe(buildAuthCheckpoint('initial_detection', authResult, page));

    if (authResult.state !== 'authenticated') {
      await performCredentialLogin(page, config);
      authResult = await detectAuthenticationState(page, config);
      logger.addProbe(buildAuthCheckpoint('post_credential_login', authResult, page));
    }

    if (authResult.state === 'authenticated') {
      decisionCase = liveBrowserSession
        ? DECISION_CASES.LIVE_BROWSER_AUTHENTICATED
        : DECISION_CASES.NEW_BROWSER_AUTH_SNAPSHOT_AUTHENTICATED;
    } else if (authResult.state === 'logged_out') {
      decisionCase = liveBrowserSession
        ? DECISION_CASES.LIVE_BROWSER_LOGGED_OUT
        : DECISION_CASES.NEW_BROWSER_PROFILE_LOGGED_OUT;
    }

    devtools = await resolveDevtoolsUrl(context, page, {
      maxAttempts: config.devtoolsResolveAttempts,
      delayMs: config.devtoolsResolveDelayMs,
    });
    if (hasAnyDevtoolsUrl(devtools)) {
      printDevtoolsInfo(devtools);
    }

    liveUrlInfo = await refreshLiveUrlInfo(context, page, logger);
    await writeAuthFiles(context, {
      storageStatePath: customerPaths.storageStatePath,
      cookiesPath: customerPaths.cookiesPath,
    });

    const completedAt = new Date().toISOString();
    logger.decide(decisionCase, {
      customerId: customerPaths.customerId,
      sessionReuseResult,
      finalUrl: page.url(),
      devtools,
      liveUrlInfo,
      startedAt,
      completedAt,
    });
    logger.finish({
      customerId: customerPaths.customerId,
      sessionReuseResult,
      decisionCase,
      finalUrl: page.url(),
      devtools,
      liveUrlInfo,
      startedAt,
      completedAt,
    });

    return buildRunResult(
      {
        customerId: customerPaths.customerId,
        sessionReuseResult,
        decisionCase,
        finalUrl: page.url(),
        devtools,
        liveUrlInfo,
        startedAt,
        completedAt,
      },
      { ok: true }
    );
  } catch (error) {
    logger.finish({
      error: String(error?.message || error),
      decisionCase,
    });

    if (shouldKeepBrowserOnError() && page && !page.isClosed?.()) {
      console.error(
        'Error occurred. Keeping browser open for inspection because REUSE_SESSION_KEEP_BROWSER_ON_ERROR=true.'
      );
      console.error(String(error?.message || error));
      return buildRunResult(
        {
          customerId: customerPaths.customerId,
          decisionCase,
          sessionReuseResult,
          devtools,
          liveUrlInfo,
        },
        { ok: false, error: String(error?.message || error) }
      );
    }

    throw error;
  } finally {
    if (browser && !(shouldKeepBrowserOnError() && page && !page.isClosed?.())) {
      try {
        await browser.close();
      } catch (error) {
        // Best effort only.
      }
    }
  }
}

module.exports = {
  buildRunResult,
  runReuseLiveSession,
};
