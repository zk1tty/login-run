const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  createOwnerRuntimeService: createOwnerRuntimeV2,
} = require('../src/core/owner-runtime/owner-runtime');

function unwrapStatus(value) {
  if (value && typeof value === 'object' && value.status && typeof value.status === 'object') {
    return value.status;
  }
  return value;
}

function createJsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      'content-type': 'application/json',
    },
  });
}

function createFetchMock() {
  const calls = [];
  let sessionCreateCount = 0;

  const fetchMock = async (url, options = {}) => {
    const href = String(url || '');
    const method = String(options.method || 'GET').toUpperCase();
    calls.push({
      href,
      method,
      body: options.body,
    });

    if (href.includes('/json/version')) {
      return createJsonResponse({
        'Debugger-Version': 'mock-rev',
      });
    }

    if (href.includes('/session') && method === 'POST') {
      sessionCreateCount += 1;
      const sessionId = `session-${sessionCreateCount}`;
      return createJsonResponse({
        id: sessionId,
        connect: `ws://connect.test/e/fake-session-scope/session/connect/${sessionId}?token=fake-token`,
        stop: `http://stop.test/e/fake-session-scope/session/${sessionId}?token=fake-token`,
        ttl: 60000,
        processKeepAlive: 0,
      });
    }

    if (href.startsWith('http://stop.test/')) {
      return new Response('', { status: 200 });
    }

    throw new Error(`Unexpected fetch call: ${method} ${href}`);
  };

  return {
    fetchMock,
    calls,
    getSessionCreateCount: () => sessionCreateCount,
  };
}

function createFakePage(targetId) {
  let currentUrl = 'about:blank';
  const gotoCalls = [];

  return {
    gotoCalls,
    url() {
      return currentUrl;
    },
    async goto(nextUrl) {
      currentUrl = String(nextUrl || '');
      gotoCalls.push(currentUrl);
    },
    async title() {
      return '';
    },
    async evaluate() {
      return {
        state: 'need_cred',
        reason: 'Mock probe',
        url: currentUrl,
        title: '',
        hasPasswordInput: true,
        hasOtpInput: false,
        hasTurnstile: false,
        hasTurnstileCheckbox: false,
        turnstilePageType: '',
      };
    },
    target() {
      return {
        _targetId: targetId,
        async createCDPSession() {
          return {
            async send(method) {
              if (method !== 'Browserless.liveURL') {
                throw new Error(`Unexpected CDP method: ${method}`);
              }
              return {
                liveURL: `https://live.test/${targetId}`,
                liveURLId: `live-${targetId}`,
              };
            },
          };
        },
      };
    },
  };
}

function createFakeBrowser(page) {
  const disconnectedListeners = [];

  return {
    disconnectCallCount: 0,
    async pages() {
      return [page];
    },
    async newPage() {
      return page;
    },
    on(event, handler) {
      if (event === 'disconnected') {
        disconnectedListeners.push(handler);
      }
    },
    disconnect() {
      this.disconnectCallCount += 1;
      for (const listener of disconnectedListeners) {
        listener();
      }
    },
    async close() {
      this.disconnect();
    },
  };
}

function createFakePuppeteer() {
  const connectCalls = [];
  let targetIndex = 0;

  return {
    connectCalls,
    async connect({ browserWSEndpoint }) {
      targetIndex += 1;
      const page = createFakePage(`target-${targetIndex}`);
      const browser = createFakeBrowser(page);
      connectCalls.push({
        browserWSEndpoint: String(browserWSEndpoint || ''),
        page,
        browser,
      });
      return browser;
    },
  };
}

function setRuntimeEnv(t) {
  const previous = {
    BROWSERLESS_HTTP_BASE: process.env.BROWSERLESS_HTTP_BASE,
    BROWSERLESS_WS_BASE: process.env.BROWSERLESS_WS_BASE,
    BROWSERLESS_TOKEN: process.env.BROWSERLESS_TOKEN,
    LIVE_ALIAS_AUTO_CREATE_SESSION: process.env.LIVE_ALIAS_AUTO_CREATE_SESSION,
    LIVE_ALIAS_AUTO_ATTACH_OWNER: process.env.LIVE_ALIAS_AUTO_ATTACH_OWNER,
  };

  process.env.BROWSERLESS_HTTP_BASE = 'http://browserless.test';
  process.env.BROWSERLESS_WS_BASE = 'ws://browserless.test';
  process.env.BROWSERLESS_TOKEN = '';
  process.env.LIVE_ALIAS_AUTO_CREATE_SESSION = 'true';
  process.env.LIVE_ALIAS_AUTO_ATTACH_OWNER = 'true';

  t.after(() => {
    for (const [key, value] of Object.entries(previous)) {
      if (value == null) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  });
}

test('owner-runtime: forceNew attach applies new bootstrapUrl and clears stale liveURL', async t => {
  setRuntimeEnv(t);
  const logsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-runtime-attach-'));
  t.after(() => {
    fs.rmSync(logsRoot, { recursive: true, force: true });
  });

  const fetchState = createFetchMock();
  const puppeteer = createFakePuppeteer();
  const originalFetch = global.fetch;
  global.fetch = fetchState.fetchMock;
  t.after(() => {
    global.fetch = originalFetch;
  });

  const runtime = createOwnerRuntimeV2({
    logsRoot,
    puppeteer,
  });
  t.after(async () => {
    await runtime.close();
  });

  const firstAttach = unwrapStatus(await runtime.attachOwner({
    customerId: 'danny',
    forceNewSession: true,
    bootstrapUrl: 'https://gitlab.com/users/sign_in',
  }));
  assert.equal(firstAttach.pageUrl, 'https://gitlab.com/users/sign_in');
  assert.equal(
    firstAttach.pageCdpUrl,
    'ws://connect.test/e/fake-session-scope/devtools/page/target-1'
  );
  assert.equal(firstAttach.liveURL, '');

  const refreshed = unwrapStatus(await runtime.refreshLiveUrl({
    customerId: 'danny',
  }));
  assert.equal(refreshed.status, 'ready');
  assert.match(refreshed.liveURL, /^https:\/\/live\.test\//);
  assert.match(refreshed.liveURLId, /^live-/);
  assert.equal(
    refreshed.pageCdpUrl,
    'ws://connect.test/e/fake-session-scope/devtools/page/target-1'
  );

  await runtime.probeState({ customerId: 'danny' });

  const secondAttach = unwrapStatus(await runtime.attachOwner({
    customerId: 'danny',
    forceNewSession: true,
    bootstrapUrl: 'https://my.healthequity.com/ClientLogin.aspx',
  }));

  assert.equal(
    secondAttach.pageUrl,
    'https://my.healthequity.com/ClientLogin.aspx'
  );
  assert.equal(secondAttach.liveURL, '');
  assert.equal(secondAttach.liveURLId, '');
  assert.equal(secondAttach.lastProbe, null);
  assert.equal(secondAttach.sessionId, 'session-2');
  assert.equal(fetchState.getSessionCreateCount(), 2);
  assert.equal(puppeteer.connectCalls.length, 2);
  assert.equal(puppeteer.connectCalls[0].browser.disconnectCallCount, 1);
});

test('owner-runtime: attached reuse still navigates bootstrapUrl without clearing liveURL', async t => {
  setRuntimeEnv(t);
  const logsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-runtime-attach-'));
  t.after(() => {
    fs.rmSync(logsRoot, { recursive: true, force: true });
  });

  const fetchState = createFetchMock();
  const puppeteer = createFakePuppeteer();
  const originalFetch = global.fetch;
  global.fetch = fetchState.fetchMock;
  t.after(() => {
    global.fetch = originalFetch;
  });

  const runtime = createOwnerRuntimeV2({
    logsRoot,
    puppeteer,
  });
  t.after(async () => {
    await runtime.close();
  });

  const firstAttach = unwrapStatus(await runtime.attachOwner({
    customerId: 'danny',
    forceNewSession: true,
    bootstrapUrl: 'https://gitlab.com/users/sign_in',
  }));
  assert.equal(firstAttach.sessionId, 'session-1');
  assert.equal(
    firstAttach.pageCdpUrl,
    'ws://connect.test/e/fake-session-scope/devtools/page/target-1'
  );

  const refreshed = unwrapStatus(await runtime.refreshLiveUrl({
    customerId: 'danny',
  }));
  const previousLiveUrl = refreshed.liveURL;
  const previousLiveUrlId = refreshed.liveURLId;
  assert.equal(
    refreshed.pageCdpUrl,
    'ws://connect.test/e/fake-session-scope/devtools/page/target-1'
  );

  const reusedAttach = unwrapStatus(await runtime.attachOwner({
    customerId: 'danny',
    forceNewSession: false,
    bootstrapUrl: 'https://my.healthequity.com/ClientLogin.aspx',
  }));

  assert.equal(
    reusedAttach.pageUrl,
    'https://my.healthequity.com/ClientLogin.aspx'
  );
  assert.equal(reusedAttach.liveURL, previousLiveUrl);
  assert.equal(reusedAttach.liveURLId, previousLiveUrlId);
  assert.equal(reusedAttach.sessionId, 'session-1');
  assert.equal(fetchState.getSessionCreateCount(), 1);
  assert.equal(puppeteer.connectCalls.length, 1);
});
