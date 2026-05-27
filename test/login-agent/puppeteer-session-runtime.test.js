const assert = require('node:assert/strict');
const test = require('node:test');

const {
  PuppeteerSessionRuntime,
  pickActivePage,
} = require('../../src/core/puppeteer/session-runtime');

function createPageStub(input = {}) {
  return {
    id: input.id || '',
    url() {
      return input.url || 'about:blank';
    },
    async title() {
      return input.title || '';
    },
    target() {
      return {
        targetId() {
          return input.targetId || '';
        },
        async createCDPSession() {
          return { id: `cdp-${input.id || 'page'}` };
        },
      };
    },
    async evaluate(fn, ...args) {
      const selector = String(args[0] || '');
      if (selector && Array.isArray(input.selectors)) {
        return input.selectors.includes(selector);
      }
      return false;
    },
  };
}

test('pickActivePage returns existing page before creating a new one', async () => {
  const existingPage = { id: 'page-1' };
  const browser = {
    async pages() {
      return [existingPage];
    },
    async newPage() {
      throw new Error('newPage should not be called');
    },
  };

  const page = await pickActivePage(browser);
  assert.equal(page, existingPage);
});

test('pickActivePage prefers the checkpoint URL over the first blank page', async () => {
  const blankPage = createPageStub({ id: 'blank', url: 'about:blank' });
  const checkpointPage = createPageStub({
    id: 'checkpoint',
    url: 'https://example.com/Services/MfaChallenge#!/?targetUrl=%2FMember',
    title: 'Security Verification',
  });
  const browser = {
    async pages() {
      return [blankPage, checkpointPage];
    },
    async newPage() {
      throw new Error('newPage should not be called');
    },
  };

  const page = await pickActivePage(browser, {
    preferredUrl: 'https://example.com/Services/MfaChallenge#!/?targetUrl=%2FMember',
  });

  assert.equal(page, checkpointPage);
});

test('pickActivePage does not use expectedSelector as a selection rule', async () => {
  const wrongPage = createPageStub({
    id: 'wrong',
    url: 'https://example.com/Services/MfaChallenge#!/?targetUrl=%2FMember',
    title: 'Security Verification',
    selectors: [],
  });
  const otpPage = createPageStub({
    id: 'otp',
    url: 'https://example.com/Services/MfaChallenge#!/?targetUrl=%2FMember',
    title: 'Security Verification',
    selectors: ['#otpCode'],
  });
  const browser = {
    async pages() {
      return [wrongPage, otpPage];
    },
    async newPage() {
      throw new Error('newPage should not be called');
    },
  };

  const page = await pickActivePage(browser, {
    preferredUrl: 'https://example.com/Services/MfaChallenge#!/?targetUrl=%2FMember',
    expectedSelector: '#otpCode',
  });

  assert.equal(page, wrongPage);
});

test('pickActivePage reports page candidates for reconnect diagnostics', async () => {
  const blankPage = createPageStub({ id: 'blank', url: 'about:blank' });
  const checkpointPage = createPageStub({
    id: 'checkpoint',
    url: 'https://example.com/member',
    title: 'Member',
    targetId: 'target-2',
    selectors: ['#logout'],
  });
  const browser = {
    async pages() {
      return [blankPage, checkpointPage];
    },
  };
  let candidates = null;

  await pickActivePage(browser, {
    preferredUrl: 'https://example.com/member',
    expectedSelector: '#logout',
    onPageCandidates(nextCandidates) {
      candidates = nextCandidates;
    },
  });

  assert.equal(candidates.length, 2);
  assert.equal(candidates[1].url, 'https://example.com/member');
  assert.equal(candidates[1].expectedSelectorFound, true);
  assert.equal(candidates[1].exactUrlMatch, true);
  assert.equal(candidates[1].selected, true);
  assert.equal(candidates[1].selectedReason, 'exact_url_match');
});

test('pickActivePage fails when checkpoint hints cannot identify a page', async () => {
  const firstPage = createPageStub({
    id: 'first',
    url: 'https://example.com/one',
  });
  const secondPage = createPageStub({
    id: 'second',
    url: 'https://example.com/two',
  });
  const browser = {
    async pages() {
      return [firstPage, secondPage];
    },
  };
  let candidates = null;

  await assert.rejects(
    () => pickActivePage(browser, {
      preferredUrl: 'https://example.com/member',
      onPageCandidates(nextCandidates) {
        candidates = nextCandidates;
      },
    }),
    /Checkpoint page not found/
  );

  assert.equal(candidates.length, 2);
  assert.equal(candidates[0].selected, false);
  assert.equal(candidates[1].selected, false);
});

test('PuppeteerSessionRuntime.connect uses browser endpoint and creates a CDP session', async () => {
  let createCdpSessionCalls = 0;
  let disconnectCalls = 0;
  const fakePage = {
    target() {
      return {
        async createCDPSession() {
          createCdpSessionCalls += 1;
          return { id: 'cdp-1' };
        },
      };
    },
  };
  const fakeBrowser = {
    async pages() {
      return [fakePage];
    },
    disconnect() {
      disconnectCalls += 1;
    },
  };
  const fakePuppeteer = {
    connectCalls: [],
    async connect(input) {
      this.connectCalls.push(input);
      return fakeBrowser;
    },
  };

  const runtime = await PuppeteerSessionRuntime.connect({
    endpoint: 'wss://example.com/session/connect/abc',
    connectTimeoutMs: 45000,
    puppeteer: fakePuppeteer,
  });

  assert.equal(fakePuppeteer.connectCalls.length, 1);
  assert.deepEqual(fakePuppeteer.connectCalls[0], {
    browserWSEndpoint: 'wss://example.com/session/connect/abc',
    protocolTimeout: 45000,
    defaultViewport: null,
  });
  assert.equal(runtime.page, fakePage);
  assert.equal(runtime.cdp.id, 'cdp-1');
  assert.equal(createCdpSessionCalls, 1);

  await runtime.disconnect();
  assert.equal(disconnectCalls, 1);
});
