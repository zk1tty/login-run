const assert = require('node:assert/strict');
const test = require('node:test');

const {
  PuppeteerSessionRuntime,
  pickActivePage,
} = require('../../src/core/login-agent/puppeteer-session-runtime');

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
