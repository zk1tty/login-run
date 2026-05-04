const { wrap, configure } = require('agentql');
const { chromium } = require('playwright-core');
const readline = require('readline/promises');
const {
  buildPageDebuggerWsUrl,
  fetchJson,
  getAuthBootstrapUrl,
  getCdpEndpoint,
  getHostedDevtoolsFrontendUrl,
  getHttpVersionEndpoint,
  getJsonListUrl,
  getPlaywrightEndpoint,
  getSessionKeepAliveMs,
  getSessionsViewerUrl,
  normalizeDevtoolsFrontendUrl,
  normalizeWsUrl,
  waitForPageReady,
} = require('../../../lib/helpers');

function requireEnv(name) {
  const value = process.env[name];

  if (value == null || value === '') {
    throw new Error(`${name} is required.`);
  }

  return value;
}

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

function toArray(values) {
  if (Array.isArray(values)) {
    return values;
  }

  if (values == null || values === '') {
    return [];
  }

  return [values];
}

function unique(values) {
  return [...new Set(toArray(values).filter(Boolean))];
}

function buildPromptCandidates(primaryPrompt, fallbacks) {
  return unique([primaryPrompt, ...fallbacks]);
}

function normalizeText(value) {
  return String(value || '').trim();
}

function normalizeComparableText(value) {
  return normalizeText(value).toLowerCase();
}

function textIncludes(haystack, needle) {
  if (!needle) {
    return false;
  }

  return normalizeComparableText(haystack).includes(normalizeComparableText(needle));
}

function getLoginConfig() {
  return {
    apiKey: requireEnv('AGENTQL_API_KEY'),
    url: process.env.LOGIN_URL || getAuthBootstrapUrl(),
    bootstrapUrl: process.env.AUTH_BOOTSTRAP_URL || getAuthBootstrapUrl(),
    username: requireEnv('LOGIN_USERNAME'),
    password: requireEnv('LOGIN_PASSWORD'),
    usernamePrompts: buildPromptCandidates(
      process.env.LOGIN_USERNAME_PROMPT || 'the username input field',
      [
        'the username field',
        'the username textbox',
        'the email or username input field',
        'the member username field',
      ]
    ),
    passwordPrompts: buildPromptCandidates(
      process.env.LOGIN_PASSWORD_PROMPT || 'the password input field',
      [
        'the password field',
        'the password textbox',
        'the account password input field',
      ]
    ),
    continuePrompts: buildPromptCandidates(
      process.env.LOGIN_CONTINUE_PROMPT || 'the continue button for the login form',
      [
        'the continue button',
        'the next button',
        'the submit button for the username step',
      ]
    ),
    submitPrompts: buildPromptCandidates(
      process.env.LOGIN_SUBMIT_PROMPT ||
        process.env.LOGIN_CONTINUE_PROMPT ||
        'the continue button for the password step',
      [
        'the continue button',
        'the sign in button',
        'the log in button',
        'the submit button for the password step',
      ]
    ),
    authenticatedSelector: process.env.LOGIN_AUTHENTICATED_SELECTOR || '',
    authenticatedUrlMatch: process.env.LOGIN_AUTHENTICATED_URL_MATCH || '',
    authenticatedTitleMatch: process.env.LOGIN_AUTHENTICATED_TITLE_MATCH || '',
    connectMode: (process.env.BROWSERLESS_LOGIN_CONNECT_MODE || 'cdp').toLowerCase(),
    afterUsernameWaitMs: getNumberEnv('LOGIN_AFTER_USERNAME_WAIT_MS', 1500),
    afterSubmitWaitMs: getNumberEnv('LOGIN_AFTER_SUBMIT_WAIT_MS', 5000),
    elementTimeoutMs: getNumberEnv('LOGIN_ELEMENT_TIMEOUT_MS', 20000),
    authCheckTimeoutMs: getNumberEnv('LOGIN_AUTH_CHECK_TIMEOUT_MS', 3000),
    devtoolsResolveAttempts: getNumberEnv('LOGIN_DEVTOOLS_RESOLVE_ATTEMPTS', 20),
    devtoolsResolveDelayMs: getNumberEnv('LOGIN_DEVTOOLS_RESOLVE_DELAY_MS', 500),
    handoffWaitMs: getNumberEnv('LOGIN_HANDOFF_WAIT_MS', 0),
    handoffWaitForEnter: parseBoolean(process.env.LOGIN_HANDOFF_WAIT_FOR_ENTER, true),
  };
}

async function connectBrowser(connectMode) {
  if (connectMode === 'cdp') {
    return {
      browser: await chromium.connectOverCDP(getCdpEndpoint()),
      endpoint: getCdpEndpoint(),
      modeLabel: 'CDP',
    };
  }

  return {
    browser: await chromium.connect(getPlaywrightEndpoint()),
    endpoint: getPlaywrightEndpoint(),
    modeLabel: 'Playwright',
  };
}

async function createContext(browser) {
  const existingContext = browser.contexts()[0];
  if (existingContext) {
    return existingContext;
  }

  return browser.newContext();
}

async function createWrappedPage(context) {
  return wrap(await context.newPage());
}

function configureAgentQl(apiKey) {
  configure({ apiKey });
}

async function waitForManualHandoff() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    return false;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    await rl.question(
      'Two-step authentication is ready for manual handoff. Finish the email code flow in the browser, then press Enter here to continue. '
    );
    return true;
  } finally {
    rl.close();
  }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function getWsFromDevtoolsFrontendUrl(devtoolsFrontendUrl) {
  if (!devtoolsFrontendUrl) {
    return '';
  }

  const url = new URL(devtoolsFrontendUrl);
  const ws = url.searchParams.get('ws');

  if (!ws) {
    return '';
  }

  return ws.startsWith('ws://') || ws.startsWith('wss://') ? ws : `ws://${ws}`;
}

function isUsablePageTarget(target) {
  return (
    target &&
    target.type === 'page' &&
    normalizeText(target.url) !== '' &&
    normalizeText(target.url) !== 'about:blank'
  );
}

function findPageById(list, id) {
  if (!id) {
    return null;
  }

  return list.find(item => isUsablePageTarget(item) && item.id === id) || null;
}

function findPageByUrlOrTitle(list, pageUrl, pageTitle) {
  const normalizedPageUrl = normalizeText(pageUrl);
  const normalizedPageTitle = normalizeText(pageTitle);

  return (
    list.find(item => {
      if (!isUsablePageTarget(item)) {
        return false;
      }

      const itemUrl = normalizeText(item.url);
      const itemTitle = normalizeText(item.title);

      return (
        (normalizedPageUrl && itemUrl === normalizedPageUrl) ||
        (normalizedPageTitle && itemTitle === normalizedPageTitle)
      );
    }) || null
  );
}

function buildDevtoolsInfo(targetId, pageUrl, pageTitle, sessions, jsonList, debuggerVersion) {
  const pageSessions = sessions.filter(item => item.type === 'page');
  const exactSession = findPageById(pageSessions, targetId);
  const fallbackSession = findPageByUrlOrTitle(pageSessions, pageUrl, pageTitle);
  const resolvedSession = exactSession || fallbackSession;

  const pageTargets = jsonList.filter(item => item.type === 'page');
  const exactTarget = findPageById(pageTargets, targetId);
  const fallbackTarget = findPageByUrlOrTitle(pageTargets, pageUrl, pageTitle);
  const resolvedTarget = exactTarget || fallbackTarget;

  const primaryPageWebSocketDebuggerUrl = normalizeWsUrl(buildPageDebuggerWsUrl(targetId));
  const fallbackPageWebSocketDebuggerUrl = normalizeWsUrl(
    (resolvedSession && resolvedSession.webSocketDebuggerUrl) ||
      (resolvedTarget && resolvedTarget.webSocketDebuggerUrl) ||
      ''
  );
  const pageWebSocketDebuggerUrl =
    primaryPageWebSocketDebuggerUrl || fallbackPageWebSocketDebuggerUrl;

  const hostedDevtoolsUrl = getHostedDevtoolsFrontendUrl(
    debuggerVersion,
    pageWebSocketDebuggerUrl
  );
  const normalizedPageUrl = normalizeText(pageUrl);
  const normalizedResolvedTargetUrl = normalizeText(
    resolvedTarget ? resolvedTarget.url : ''
  );
  const pageTargetMatchesLoginPage =
    !normalizedPageUrl ||
    !normalizedResolvedTargetUrl ||
    normalizedResolvedTargetUrl === normalizedPageUrl;

  return {
    targetId,
    resolvedSessionId: resolvedSession ? resolvedSession.id : '',
    resolvedSessionUrl: resolvedSession ? resolvedSession.url || '' : '',
    resolvedTargetId: resolvedTarget ? resolvedTarget.id || '' : '',
    resolvedTargetUrl: resolvedTarget ? resolvedTarget.url || '' : '',
    pageTargetMatchesLoginPage,
    hostedDevtoolsUrl,
    pageCdpUrl: getWsFromDevtoolsFrontendUrl(hostedDevtoolsUrl) || pageWebSocketDebuggerUrl,
    browserlessAdvertisedDevtoolsUrl: resolvedTarget
      ? resolvedTarget.devtoolsFrontendUrl || ''
      : '',
    localDevtoolsFrontendUrl: normalizeDevtoolsFrontendUrl(
      (resolvedSession && resolvedSession.devtoolsFrontendUrl) || ''
    ),
  };
}

async function resolveDevtoolsUrl(context, page, options = {}) {
  try {
    const cdp = await context.newCDPSession(page);
    const targetInfoResult = await cdp.send('Target.getTargetInfo', {});
    const targetId = targetInfoResult?.targetInfo?.targetId || '';
    const pageUrl = targetInfoResult?.targetInfo?.url || page.url() || '';
    const pageTitle = targetInfoResult?.targetInfo?.title || '';
    const maxAttempts = options.maxAttempts || 12;
    const delayMs = options.delayMs || 400;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      const [sessions, jsonList, version] = await Promise.all([
        fetchJson(getSessionsViewerUrl()),
        fetchJson(getJsonListUrl()),
        fetchJson(getHttpVersionEndpoint()),
      ]);
      const debuggerVersion = version?.['Debugger-Version'] || '';
      const devtoolsInfo = buildDevtoolsInfo(
        targetId,
        pageUrl,
        pageTitle,
        sessions,
        jsonList,
        debuggerVersion
      );

      if (
        devtoolsInfo.hostedDevtoolsUrl ||
        devtoolsInfo.browserlessAdvertisedDevtoolsUrl ||
        devtoolsInfo.localDevtoolsFrontendUrl ||
        devtoolsInfo.pageCdpUrl
      ) {
        return devtoolsInfo;
      }

      await sleep(delayMs);
    }

    return {
      targetId,
      hostedDevtoolsUrl: '',
      pageCdpUrl: '',
      browserlessAdvertisedDevtoolsUrl: '',
      localDevtoolsFrontendUrl: '',
    };
  } catch (error) {
    return {
      targetId: '',
      pageCdpUrl: '',
      hostedDevtoolsUrl: '',
      browserlessAdvertisedDevtoolsUrl: '',
      localDevtoolsFrontendUrl: '',
      error,
    };
  }
}

function hasAnyDevtoolsUrl(devtools) {
  return Boolean(
    devtools &&
      (devtools.hostedDevtoolsUrl ||
        devtools.browserlessAdvertisedDevtoolsUrl ||
        devtools.localDevtoolsFrontendUrl ||
        devtools.pageCdpUrl)
  );
}

function printDevtoolsInfo(devtools) {
  if (devtools.hostedDevtoolsUrl) {
    console.log('DevTools URL:', devtools.hostedDevtoolsUrl);
  }
  if (devtools.browserlessAdvertisedDevtoolsUrl) {
    console.log('Advertised DevTools URL:', devtools.browserlessAdvertisedDevtoolsUrl);
  }
  if (devtools.localDevtoolsFrontendUrl) {
    console.log('Local DevTools URL:', devtools.localDevtoolsFrontendUrl);
  }
  if (devtools.pageCdpUrl) {
    console.log('Page CDP URL:', devtools.pageCdpUrl);
  }
  if (devtools.resolvedTargetId) {
    console.log('Resolved target ID:', devtools.resolvedTargetId);
  }
  if (devtools.resolvedTargetUrl) {
    console.log('Resolved target URL:', devtools.resolvedTargetUrl);
  }
  if (devtools.pageTargetMatchesLoginPage === false) {
    console.log(
      'Target URL check: mismatch between Page target ID and resolved login page URL'
    );
  }
  if (devtools.resolvedSessionId) {
    console.log('Resolved session ID:', devtools.resolvedSessionId);
  }
  if (devtools.resolvedSessionUrl) {
    console.log('Resolved session URL:', devtools.resolvedSessionUrl);
  }
  if (devtools.targetId) {
    console.log('Page target ID:', devtools.targetId);
  }
  if (devtools.error) {
    console.log(`DevTools URL: unavailable (${devtools.error.message})`);
  }
}

async function findElementByPrompts(page, prompts, timeoutMs) {
  const candidates = unique(prompts);

  if (candidates.length === 0) {
    return null;
  }

  const perPromptTimeout = Math.max(
    500,
    Math.min(1500, Math.floor(timeoutMs / candidates.length))
  );

  for (const prompt of candidates) {
    try {
      const element = await page.getByPrompt(prompt);

      if (!element) {
        continue;
      }

      if (typeof element.waitFor === 'function') {
        await element.waitFor({ state: 'visible', timeout: perPromptTimeout });
      }

      return { element, prompt };
    } catch (error) {
      // Try the next candidate prompt.
    }
  }

  return null;
}

async function waitAfterAction(page, timeoutMs, renderWaitMs) {
  try {
    await waitForPageReady(page, {
      timeout: timeoutMs,
      renderWaitMs,
    });
  } catch (error) {
    await page.waitForTimeout(renderWaitMs);
  }
}

async function fillFieldIfFound(page, label, prompts, value, timeoutMs) {
  const match = await findElementByPrompts(page, prompts, timeoutMs);

  if (match && match.element && typeof match.element.fill === 'function') {
    try {
      await match.element.fill(value);
      console.log(`${label}: filled using prompt "${match.prompt}"`);
      return true;
    } catch (error) {
      console.log(
        `${label}: found with prompt "${match.prompt}" but fill failed: ${error.message}`
      );
    }
  }

  console.log(`${label}: not found`);
  return false;
}

async function clickButtonIfFound(page, label, prompts, timeoutMs) {
  const match = await findElementByPrompts(page, prompts, timeoutMs);

  if (match && match.element && typeof match.element.click === 'function') {
    try {
      await match.element.click();
      console.log(`${label}: clicked using prompt "${match.prompt}"`);
      return true;
    } catch (error) {
      console.log(
        `${label}: found with prompt "${match.prompt}" but click failed: ${error.message}`
      );
    }
  }

  console.log(`${label}: not found`);
  return false;
}

async function performCredentialLogin(page, config) {
  const usernameFilled = await fillFieldIfFound(
    page,
    'Username field',
    config.usernamePrompts,
    config.username,
    config.elementTimeoutMs
  );
  let passwordFilled = await fillFieldIfFound(
    page,
    'Password field',
    config.passwordPrompts,
    config.password,
    Math.min(config.elementTimeoutMs, 4000)
  );
  let clickedUsernameContinue = false;

  if (!passwordFilled && usernameFilled) {
    clickedUsernameContinue = await clickButtonIfFound(
      page,
      'Username continue button',
      config.continuePrompts,
      config.elementTimeoutMs
    );

    if (clickedUsernameContinue) {
      await waitAfterAction(
        page,
        Math.min(config.elementTimeoutMs, 15000),
        config.afterUsernameWaitMs
      );
    }

    passwordFilled = await fillFieldIfFound(
      page,
      'Password field',
      config.passwordPrompts,
      config.password,
      config.elementTimeoutMs
    );
  }

  const clickedPasswordSubmit = passwordFilled
    ? await clickButtonIfFound(
        page,
        'Password submit button',
        config.submitPrompts,
        config.elementTimeoutMs
      )
    : false;

  if (!clickedPasswordSubmit && passwordFilled) {
    const passwordEnterFallback = await findElementByPrompts(
      page,
      config.passwordPrompts,
      Math.min(config.elementTimeoutMs, 4000)
    );

    if (passwordEnterFallback) {
      await passwordEnterFallback.element.press('Enter');
      console.log('Password submit button: not found, pressed Enter as fallback');
    }
  }

  if (clickedPasswordSubmit || passwordFilled) {
    await waitAfterAction(
      page,
      Math.min(config.elementTimeoutMs, 15000),
      config.afterSubmitWaitMs
    );
  }

  if (!usernameFilled && !passwordFilled && !clickedUsernameContinue && !clickedPasswordSubmit) {
    throw new Error(
      'AgentQL could not find any actionable login field or button. Update the LOGIN_*_PROMPT values in .env.'
    );
  }

  return {
    usernameFilled,
    passwordFilled,
    clickedUsernameContinue,
    clickedPasswordSubmit,
  };
}

async function detectAuthenticationState(page, config) {
  const currentUrl = page.url();
  const title = await page.title();

  if (config.authenticatedSelector) {
    try {
      await page.waitForSelector(config.authenticatedSelector, {
        state: 'visible',
        timeout: config.authCheckTimeoutMs,
      });
      return {
        state: 'authenticated',
        reason: `selector:${config.authenticatedSelector}`,
        url: currentUrl,
        title,
      };
    } catch (error) {
      // Continue with the other checks.
    }
  }

  if (textIncludes(currentUrl, config.authenticatedUrlMatch)) {
    return {
      state: 'authenticated',
      reason: `url:${config.authenticatedUrlMatch}`,
      url: currentUrl,
      title,
    };
  }

  if (textIncludes(title, config.authenticatedTitleMatch)) {
    return {
      state: 'authenticated',
      reason: `title:${config.authenticatedTitleMatch}`,
      url: currentUrl,
      title,
    };
  }

  const usernameField = await findElementByPrompts(
    page,
    config.usernamePrompts,
    config.authCheckTimeoutMs
  );
  if (usernameField) {
    return {
      state: 'logged_out',
      reason: `username_prompt:${usernameField.prompt}`,
      url: currentUrl,
      title,
    };
  }

  const passwordField = await findElementByPrompts(
    page,
    config.passwordPrompts,
    config.authCheckTimeoutMs
  );
  if (passwordField) {
    return {
      state: 'logged_out',
      reason: `password_prompt:${passwordField.prompt}`,
      url: currentUrl,
      title,
    };
  }

  if (textIncludes(currentUrl, config.url)) {
    return {
      state: 'logged_out',
      reason: 'login_url_match',
      url: currentUrl,
      title,
    };
  }

  return {
    state: 'unknown',
    reason: 'no_auth_signal',
    url: currentUrl,
    title,
  };
}

async function keepSessionAliveIfNeeded(page, config, waitedForEnter) {
  const keepAliveMs = waitedForEnter
    ? 0
    : Math.max(config.handoffWaitMs, getSessionKeepAliveMs());

  if (keepAliveMs > 0) {
    console.log(`Keeping session alive for ${keepAliveMs}ms`);
    await page.waitForTimeout(keepAliveMs);
  }
}

module.exports = {
  configureAgentQl,
  connectBrowser,
  createContext,
  createWrappedPage,
  detectAuthenticationState,
  getLoginConfig,
  getSessionsViewerUrl,
  hasAnyDevtoolsUrl,
  keepSessionAliveIfNeeded,
  performCredentialLogin,
  printDevtoolsInfo,
  resolveDevtoolsUrl,
  waitForManualHandoff,
  waitForPageReady,
};
