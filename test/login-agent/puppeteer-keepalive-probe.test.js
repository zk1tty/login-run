const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  PuppeteerKeepAliveProbe,
  buildProbeCheckpoint,
  buildReconnectMeasurement,
  parseProbePhase,
  runPuppeteerKeepAliveProbeCli,
  shouldWaitForOtpFromFile,
  waitForOtpCode,
} = require('../../src/core/puppeteer/keepalive-probe');

function createEvaluatePageStub(input = {}) {
  const store = {
    url: input.url || 'https://example.com/member',
    title: input.title || 'Member',
    selectorState: {
      '#username': {
        value: '',
        checked: false,
        exists: true,
        visible: true,
      },
      '#submit': {
        value: '',
        checked: false,
        exists: true,
        visible: true,
      },
      '#password': {
        value: '',
        checked: false,
        exists: true,
        visible: true,
      },
      '#otpCode': {
        value: '',
        checked: false,
        exists: true,
        visible: true,
      },
      '#verifyOtp': {
        value: '',
        checked: false,
        exists: true,
        visible: true,
      },
    },
    inventoryCalls: 0,
    challengeCalls: 0,
  };
  return {
    _lastGoto: null,
    keyboard: {
      async press() {},
    },
    mouse: {
      async click() {},
    },
    async goto(url, options) {
      this._lastGoto = { url, options };
    },
    url() {
      return store.url;
    },
    async title() {
      return store.title;
    },
    async setViewport(viewport) {
      store.viewport = viewport;
    },
    async screenshot(options) {
      const screenshotPath = options.path;
      if (input.failFullPageScreenshotWithZeroWidth === true && options.fullPage === true) {
        throw new Error('Protocol error (Page.captureScreenshot): Cannot take screenshot with 0 width.');
      }
      fs.writeFileSync(screenshotPath, 'fake-image');
    },
    async click(selector) {
      const entry = store.selectorState[selector];
      if (entry) {
        entry.clicked = true;
      }
    },
    async focus() {},
    async $eval(selector, fn, ...args) {
      const entry = store.selectorState[selector];
      if (!entry) {
        throw new Error(`missing selector ${selector}`);
      }
      const source = String(fn || '');
      if (source.includes('fill_target_not_text_input')) {
        entry.value = String(args[0] || '');
        return;
      }
      if (source.includes('check_target_not_input')) {
        entry.checked = true;
        return;
      }
      if (source.includes('select_target_not_select')) {
        entry.value = String(args[0]?.label || args[0]?.value || '');
        return;
      }
      if (source.includes('typeof node?.value')) {
        return {
          expectedLength: String(args[0] || '').length,
          actualLength: entry.value.length,
          lengthMatches: entry.value.length === String(args[0] || '').length,
          valueMatches: entry.value === String(args[0] || ''),
        };
      }
      const node = {
        value: entry.value,
        checked: entry.checked,
        focus() {},
        dispatchEvent() {},
        hasAttribute(name) {
          return name === 'disabled' ? false : false;
        },
        getAttribute() {
          return '';
        },
      };
      const result = fn(node, ...args);
      entry.value = node.value;
      entry.checked = node.checked;
      return result;
    },
    async evaluate(fn) {
      const source = String(fn || '');
      if (
        source.includes('challengeVisible') &&
        source.includes('hasChallengeText') &&
        source.includes('hasVerifyingText') &&
        source.includes('tokenLength')
      ) {
        store.challengeCalls += 1;
        if (Array.isArray(input.challengeSnapshotsByCall)) {
          return input.challengeSnapshotsByCall[
            Math.min(store.challengeCalls - 1, input.challengeSnapshotsByCall.length - 1)
          ];
        }
        return {
          title: store.title,
          url: store.url,
          iframeCount: 0,
          tokenLength: 0,
          hasChallengeText: false,
          hasVerifyingText: false,
          hasSecurityCheckPassedText: false,
          challengeVisible: false,
        };
      }
      if (source.includes('document.readyState')) {
        return 'complete';
      }
      if (source.includes('document.querySelector(selector)')) {
        return {
          exists: true,
          visible: true,
        };
      }
      return {
        title: store.title,
        url: store.url,
        text: input.text || 'Sign Out Account Balance',
        activeSelector: '',
        formCount: 0,
        candidates: (() => {
          store.inventoryCalls += 1;
          if (Array.isArray(input.candidatesByCall)) {
            const current = input.candidatesByCall[
              Math.min(store.inventoryCalls - 1, input.candidatesByCall.length - 1)
            ];
            return current || [];
          }
          return input.candidates || [
            {
              tag: 'a',
              role: '',
              type: '',
              text: 'Sign Out',
              label: [],
              ariaLabel: '',
              id: '',
              name: '',
              placeholder: '',
              autocomplete: '',
              inputMode: '',
              options: [],
              visible: true,
              disabled: false,
              focusable: true,
            },
          ];
        })(),
      };
    },
  };
}

test('buildProbeCheckpoint stores session metadata without browser internals', () => {
  const checkpoint = buildProbeCheckpoint({
    phase: 'bootstrap',
    targetUrl: 'https://example.com/login',
    currentUrl: 'https://example.com/member',
    pageTitle: 'Member',
    stage: { state: 'authed' },
    session: {
      id: 'session-1',
      connect: 'wss://example.com/session/connect/session-1',
      stop: 'https://example.com/session/session-1',
      ttlMs: 1000,
      processKeepAliveMs: 500,
    },
  });

  assert.equal(checkpoint.targetUrl, 'https://example.com/login');
  assert.equal(checkpoint.phase, 'bootstrap');
  assert.equal(checkpoint.currentUrl, 'https://example.com/member');
  assert.equal(checkpoint.stage.state, 'authed');
  assert.equal(checkpoint.session.id, 'session-1');
  assert.equal(checkpoint.session.ttlMs, 1000);
});

test('parseProbePhase defaults to bootstrap without checkpoint and reconnect with checkpoint', () => {
  assert.equal(parseProbePhase('', null), 'bootstrap');
  assert.equal(parseProbePhase('', {}), 'reconnect');
  assert.equal(parseProbePhase('bootstrap', null), 'bootstrap');
  assert.equal(parseProbePhase('reconnect', null), 'reconnect');
  assert.throws(() => parseProbePhase('bad', null), /KEEPALIVE_PROBE_PHASE/);
});

test('buildReconnectMeasurement compares reconnect landing against bootstrap checkpoint', () => {
  const measurement = buildReconnectMeasurement(
    {
      createdAt: '2026-05-20T04:00:00.000Z',
      currentUrl: 'https://example.com/member',
      pageTitle: 'Member',
    },
    {
      beforeUrl: 'https://example.com/member',
      beforeTitle: 'Member',
    }
  );

  assert.equal(measurement.bootstrapCreatedAt, '2026-05-20T04:00:00.000Z');
  assert.equal(measurement.sameUrlBeforeNavigate, true);
  assert.equal(measurement.sameTitleBeforeNavigate, true);
  assert.equal(typeof measurement.elapsedSinceBootstrapMs, 'number');
});

test('waitForOtpCode reads a new 6-digit code from file', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keepalive-probe-otp-file-'));
  const otpFilePath = path.join(tmpDir, 'otp.txt');
  fs.writeFileSync(otpFilePath, '123456\n');

  const result = await waitForOtpCode({
    filePath: otpFilePath,
    waitMs: 50,
    pollMs: 10,
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.code, '123456');
});

test('shouldWaitForOtpFromFile only enables file wait for otp_code without inline OTP', () => {
  assert.equal(
    shouldWaitForOtpFromFile({
      stage: { state: 'otp_code' },
      otpCode: '',
      otpWaitMs: 1000,
    }),
    true
  );
  assert.equal(
    shouldWaitForOtpFromFile({
      stage: { state: 'otp_code' },
      otpCode: '123456',
      otpWaitMs: 1000,
    }),
    false
  );
  assert.equal(
    shouldWaitForOtpFromFile({
      stage: { state: 'identifier' },
      otpCode: '',
      otpWaitMs: 1000,
    }),
    false
  );
});

test('PuppeteerKeepAliveProbe creates session when checkpoint is absent and disconnects runtime', async () => {
  let createCalls = 0;
  let disconnectCalls = 0;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keepalive-probe-run-'));
  const runtime = {
    connectTimeoutMs: 45000,
    page: createEvaluatePageStub(),
    browser: {
      async pages() {
        return [1];
      },
    },
    toRecord() {
      return { runtime: 'puppeteer' };
    },
    async disconnect() {
      disconnectCalls += 1;
    },
  };
  const probe = new PuppeteerKeepAliveProbe({
    async createSession() {
      createCalls += 1;
      return {
        session: {
          id: 'session-1',
          connect: 'wss://example.com/session/connect/session-1',
          stop: 'https://example.com/session/session-1',
          ttlMs: 1000,
          processKeepAliveMs: 500,
        },
        toRecord() {
          return { session: this.session };
        },
      };
    },
    async connectRuntime(input) {
      assert.equal(input.endpoint, 'wss://example.com/session/connect/session-1');
      return runtime;
    },
    readCheckpoint() {
      return null;
    },
  });

  const result = await probe.run({
    targetUrl: 'https://example.com/login',
    waitMs: 0,
    screenshotsDir: tmpDir,
    inventoriesDir: tmpDir,
  });

  assert.equal(createCalls, 1);
  assert.equal(result.phase, 'bootstrap');
  assert.equal(result.sessionCreated, true);
  assert.equal(result.currentUrl, 'https://example.com/member');
  assert.equal(result.capture.stage.state, 'authed');
  assert.equal(fs.existsSync(result.capture.screenshotPath), true);
  assert.equal(fs.existsSync(result.capture.inventoryPath), true);
  assert.equal(disconnectCalls, 1);
});

test('PuppeteerKeepAliveProbe tolerates detached frame during initial navigation', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keepalive-probe-detached-frame-'));
  const page = createEvaluatePageStub();
  let gotoCalls = 0;
  page.goto = async function goto(url, options) {
    gotoCalls += 1;
    this._lastGoto = { url, options };
    throw new Error('Navigating frame was detached');
  };
  const probe = new PuppeteerKeepAliveProbe({
    async createSession() {
      return {
        session: {
          id: 'session-1',
          connect: 'wss://example.com/session/connect/session-1',
          stop: 'https://example.com/session/session-1',
          ttlMs: 1000,
          processKeepAliveMs: 500,
        },
        toRecord() {
          return { session: this.session };
        },
      };
    },
    async connectRuntime() {
      return {
        connectTimeoutMs: 60000,
        page,
        browser: {
          async pages() {
            return [page];
          },
        },
        toRecord() {
          return { runtime: 'puppeteer' };
        },
        async disconnect() {},
      };
    },
    readCheckpoint() {
      return null;
    },
  });

  const result = await probe.run({
    targetUrl: 'https://example.com/login',
    waitMs: 0,
    screenshotsDir: tmpDir,
    inventoriesDir: tmpDir,
  });

  assert.equal(gotoCalls, 1);
  assert.equal(result.status, undefined);
  assert.equal(result.capture.stage.state, 'authed');
  assert.equal(fs.existsSync(result.capture.screenshotPath), true);
});

test('PuppeteerKeepAliveProbe reuses checkpoint session without creating a new session', async () => {
  let createCalls = 0;
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keepalive-probe-reconnect-'));
  const probe = new PuppeteerKeepAliveProbe({
    async createSession() {
      createCalls += 1;
      throw new Error('createSession should not be called');
    },
    async connectRuntime(input) {
      assert.equal(input.endpoint, 'wss://example.com/session/connect/session-1');
      return {
        connectTimeoutMs: 60000,
        page: createEvaluatePageStub(),
        browser: {
          async pages() {
            return [1];
          },
        },
        toRecord() {
          return { runtime: 'puppeteer' };
        },
        async disconnect() {},
      };
    },
  });

  const result = await probe.run({
    checkpoint: {
      createdAt: '2026-05-20T04:00:00.000Z',
      currentUrl: 'https://example.com/member',
      pageTitle: 'Member',
      session: {
        id: 'session-1',
        connect: 'wss://example.com/session/connect/session-1',
        stop: 'https://example.com/session/session-1',
      },
      targetUrl: 'https://example.com/login',
    },
    waitMs: 0,
    screenshotsDir: tmpDir,
    inventoriesDir: tmpDir,
  });

  assert.equal(createCalls, 0);
  assert.equal(result.phase, 'reconnect');
  assert.equal(result.sessionCreated, false);
  assert.equal(result.session.id, 'session-1');
  assert.equal(result.measurement.sameUrlBeforeNavigate, true);
  assert.equal(result.capture.stage.state, 'authed');
});

test('PuppeteerKeepAliveProbe can run one deterministic workflow action on Puppeteer runtime', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keepalive-probe-workflow-'));
  const page = createEvaluatePageStub({
    url: 'https://example.com/login',
    title: 'Login',
    text: 'Username Continue',
    candidates: [
      {
        selector: '#username',
        index: 0,
        tag: 'input',
        type: 'text',
        role: '',
        text: '',
        label: ['Username'],
        ariaLabel: '',
        id: 'username',
        name: 'username',
        placeholder: '',
        autocomplete: '',
        inputMode: '',
        options: [],
        visible: true,
        disabled: false,
        focusable: true,
        valueLength: 0,
        boundingBox: { x: 0, y: 0, width: 100, height: 20 },
      },
      {
        selector: '#submit',
        index: 1,
        tag: 'button',
        type: 'submit',
        role: '',
        text: 'Continue',
        label: [],
        ariaLabel: '',
        id: 'submit',
        name: '',
        placeholder: '',
        autocomplete: '',
        inputMode: '',
        options: [],
        visible: true,
        disabled: false,
        focusable: true,
        valueLength: 0,
        boundingBox: { x: 0, y: 0, width: 100, height: 20 },
      },
    ],
  });
  const probe = new PuppeteerKeepAliveProbe({
    async createSession() {
      return {
        session: {
          id: 'session-1',
          connect: 'wss://example.com/session/connect/session-1',
          stop: 'https://example.com/session/session-1',
          ttlMs: 1000,
          processKeepAliveMs: 500,
        },
        toRecord() {
          return { session: this.session };
        },
      };
    },
    async connectRuntime() {
      return {
        connectTimeoutMs: 60000,
        page,
        browser: {
          async pages() {
            return [1];
          },
        },
        toRecord() {
          return { runtime: 'puppeteer' };
        },
        async disconnect() {},
      };
    },
    readCheckpoint() {
      return null;
    },
  });

  const result = await probe.run({
    targetUrl: 'https://example.com/login',
    waitMs: 0,
    workflowEnabled: true,
    maxActions: 1,
    actionWaitMs: 0,
    payload: {
      LOGIN_USERNAME: 'user@example.com',
    },
    screenshotsDir: tmpDir,
    inventoriesDir: tmpDir,
  });

  assert.equal(result.workflow.enabled, true);
  assert.equal(result.workflow.actions.length, 1);
  assert.equal(result.workflow.actions[0].result.status, 'ok');
});

test('PuppeteerKeepAliveProbe retries once after blocked_or_unknown and can continue', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keepalive-probe-retry-'));
  const page = createEvaluatePageStub({
    url: 'https://example.com/login',
    title: 'Login',
    text: 'Username Continue',
    candidatesByCall: [
      [
        {
          selector: '#username',
          index: 0,
          tag: 'input',
          type: 'text',
          role: '',
          text: '',
          label: ['Username'],
          ariaLabel: '',
          id: 'username',
          name: 'username',
          placeholder: '',
          autocomplete: '',
          inputMode: '',
          options: [],
          visible: true,
          disabled: false,
          focusable: true,
          valueLength: 0,
          boundingBox: { x: 0, y: 0, width: 100, height: 20 },
        },
        {
          selector: '#submit',
          index: 1,
          tag: 'button',
          type: 'submit',
          role: '',
          text: 'Continue',
          label: [],
          ariaLabel: '',
          id: 'submit',
          name: '',
          placeholder: '',
          autocomplete: '',
          inputMode: '',
          options: [],
          visible: true,
          disabled: false,
          focusable: true,
          valueLength: 0,
          boundingBox: { x: 0, y: 0, width: 100, height: 20 },
        },
      ],
      [],
      [
        {
          selector: '#password',
          index: 0,
          tag: 'input',
          type: 'password',
          role: '',
          text: '',
          label: ['Password'],
          ariaLabel: '',
          id: 'password',
          name: 'password',
          placeholder: '',
          autocomplete: '',
          inputMode: '',
          options: [],
          visible: true,
          disabled: false,
          focusable: true,
          valueLength: 0,
          boundingBox: { x: 0, y: 0, width: 100, height: 20 },
        },
        {
          selector: '#username',
          index: 1,
          tag: 'input',
          type: 'text',
          role: '',
          text: '',
          label: ['Username'],
          ariaLabel: '',
          id: 'username',
          name: 'username',
          placeholder: '',
          autocomplete: '',
          inputMode: '',
          options: [],
          visible: true,
          disabled: false,
          focusable: true,
          valueLength: 16,
          boundingBox: { x: 0, y: 0, width: 100, height: 20 },
        },
        {
          selector: '#submit',
          index: 2,
          tag: 'button',
          type: 'submit',
          role: '',
          text: 'Continue',
          label: [],
          ariaLabel: '',
          id: 'submit',
          name: '',
          placeholder: '',
          autocomplete: '',
          inputMode: '',
          options: [],
          visible: true,
          disabled: false,
          focusable: true,
          valueLength: 0,
          boundingBox: { x: 0, y: 0, width: 100, height: 20 },
        },
      ],
    ],
  });
  page._lastGoto = null;
  const probe = new PuppeteerKeepAliveProbe({
    async createSession() {
      return {
        session: {
          id: 'session-1',
          connect: 'wss://example.com/session/connect/session-1',
          stop: 'https://example.com/session/session-1',
          ttlMs: 1000,
          processKeepAliveMs: 500,
        },
        toRecord() {
          return { session: this.session };
        },
      };
    },
    async connectRuntime() {
      return {
        connectTimeoutMs: 60000,
        page,
        browser: {
          async pages() {
            return [1];
          },
        },
        toRecord() {
          return { runtime: 'puppeteer' };
        },
        async disconnect() {},
      };
    },
    readCheckpoint() {
      return null;
    },
  });

  const events = [];
  const result = await probe.run({
    targetUrl: 'https://example.com/login',
    waitMs: 0,
    workflowEnabled: true,
    maxActions: 2,
    actionWaitMs: 0,
    payload: {
      LOGIN_USERNAME: 'user@example.com',
      LOGIN_PASSWORD: 'secret',
    },
    screenshotsDir: tmpDir,
    inventoriesDir: tmpDir,
    recordEvent(name, detail) {
      events.push({ name, detail });
    },
  });

  assert.equal(result.workflow.actions.length, 2);
  assert.equal(events.some(event => event.name === 'runtime_action_retry_after_blocked'), true);
  assert.equal(result.workflow.finalStage.state, 'id+pw');
});

test('PuppeteerKeepAliveProbe waits for OTP file and submits the code', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keepalive-probe-otp-wait-'));
  const otpFilePath = path.join(tmpDir, 'otp.txt');
  const page = createEvaluatePageStub({
    url: 'https://my.healthequity.com/Member/MemberHome.aspx',
    title: 'Member Portal',
    text: 'Account Balance',
    text: 'Confirmation code Verify',
    candidatesByCall: [
      [
        {
          selector: '#otpCode',
          index: 0,
          tag: 'input',
          type: 'text',
          role: '',
          text: '',
          label: ['Confirmation code'],
          ariaLabel: '',
          id: 'otpCode',
          name: 'otpCode',
          placeholder: '',
          autocomplete: '',
          inputMode: '',
          options: [],
          visible: true,
          disabled: false,
          focusable: true,
          valueLength: 0,
          boundingBox: { x: 0, y: 0, width: 100, height: 20 },
        },
        {
          selector: '#verifyOtp',
          index: 1,
          tag: 'button',
          type: 'submit',
          role: '',
          text: 'Verify',
          label: [],
          ariaLabel: '',
          id: 'verifyOtp',
          name: '',
          placeholder: '',
          autocomplete: '',
          inputMode: '',
          options: [],
          visible: true,
          disabled: false,
          focusable: true,
          valueLength: 0,
          boundingBox: { x: 0, y: 0, width: 100, height: 20 },
        },
      ],
      [
        {
          selector: '#otpCode',
          index: 0,
          tag: 'input',
          type: 'text',
          role: '',
          text: '',
          label: ['Confirmation code'],
          ariaLabel: '',
          id: 'otpCode',
          name: 'otpCode',
          placeholder: '',
          autocomplete: '',
          inputMode: '',
          options: [],
          visible: true,
          disabled: false,
          focusable: true,
          valueLength: 0,
          boundingBox: { x: 0, y: 0, width: 100, height: 20 },
        },
        {
          selector: '#verifyOtp',
          index: 1,
          tag: 'button',
          type: 'submit',
          role: '',
          text: 'Verify',
          label: [],
          ariaLabel: '',
          id: 'verifyOtp',
          name: '',
          placeholder: '',
          autocomplete: '',
          inputMode: '',
          options: [],
          visible: true,
          disabled: false,
          focusable: true,
          valueLength: 0,
          boundingBox: { x: 0, y: 0, width: 100, height: 20 },
        },
      ],
    ],
  });
  const probe = new PuppeteerKeepAliveProbe({
    async createSession() {
      return {
        session: {
          id: 'session-1',
          connect: 'wss://example.com/session/connect/session-1',
          stop: 'https://example.com/session/session-1',
          ttlMs: 1000,
          processKeepAliveMs: 500,
        },
        toRecord() {
          return { session: this.session };
        },
      };
    },
    async connectRuntime() {
      return {
        connectTimeoutMs: 60000,
        page,
        browser: {
          async pages() {
            return [1];
          },
        },
        toRecord() {
          return { runtime: 'puppeteer' };
        },
        async disconnect() {},
      };
    },
    readCheckpoint() {
      return null;
    },
  });

  const events = [];
  const result = await probe.run({
    targetUrl: 'https://example.com/otp',
    waitMs: 0,
    workflowEnabled: true,
    maxActions: 1,
    actionWaitMs: 0,
    payload: {},
    otpCodeFile: otpFilePath,
    otpWaitMs: 250,
    otpPollMs: 10,
    screenshotsDir: tmpDir,
    inventoriesDir: tmpDir,
    recordEvent(name, detail) {
      events.push({ name, detail });
      if (name === 'otp_wait_start') {
        fs.writeFileSync(otpFilePath, '654321\n');
      }
    },
  });

  assert.equal(events.some(event => event.name === 'otp_wait_start'), true);
  assert.equal(events.some(event => event.name === 'otp_wait_result'), true);
  assert.equal(result.workflow.actions.length, 1);
  assert.equal(result.workflow.actions[0].plan.payloadKey, 'OTP_CODE');
  assert.equal(result.workflow.actions[0].result.status, 'ok');
});

test('PuppeteerKeepAliveProbe does not submit OTP twice while waiting for post-submit transition', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keepalive-probe-otp-transition-'));
  const otpCandidates = [
    {
      selector: '#otpCode',
      index: 0,
      tag: 'input',
      type: 'text',
      role: '',
      text: '',
      label: ['Confirmation code'],
      ariaLabel: '',
      id: 'otpCode',
      name: 'otpCode',
      placeholder: '',
      autocomplete: '',
      inputMode: '',
      options: [],
      visible: true,
      disabled: false,
      focusable: true,
      valueLength: 0,
      boundingBox: { x: 0, y: 0, width: 100, height: 20 },
    },
    {
      selector: '#verifyOtp',
      index: 1,
      tag: 'button',
      type: 'submit',
      role: '',
      text: 'Verify',
      label: [],
      ariaLabel: '',
      id: 'verifyOtp',
      name: '',
      placeholder: '',
      autocomplete: '',
      inputMode: '',
      options: [],
      visible: true,
      disabled: false,
      focusable: true,
      valueLength: 0,
      boundingBox: { x: 0, y: 0, width: 100, height: 20 },
    },
  ];
  const authedCandidates = [
    {
      selector: '#signOut',
      index: 0,
      tag: 'a',
      type: '',
      role: '',
      text: 'Sign Out',
      label: [],
      ariaLabel: '',
      id: 'signOut',
      name: '',
      placeholder: '',
      autocomplete: '',
      inputMode: '',
      options: [],
      visible: true,
      disabled: false,
      focusable: true,
      valueLength: 0,
      boundingBox: { x: 0, y: 0, width: 100, height: 20 },
    },
  ];
  const page = createEvaluatePageStub({
    url: 'https://example.com/otp',
    title: 'Verify',
    text: 'Account Balance',
    failFullPageScreenshotWithZeroWidth: true,
    candidatesByCall: [
      otpCandidates,
      otpCandidates.map(candidate =>
        candidate.selector === '#otpCode'
          ? { ...candidate, valueLength: 6 }
          : candidate
      ),
      authedCandidates,
    ],
  });
  const probe = new PuppeteerKeepAliveProbe({
    async createSession() {
      return {
        session: {
          id: 'session-1',
          connect: 'wss://example.com/session/connect/session-1',
          stop: 'https://example.com/session/session-1',
          ttlMs: 1000,
          processKeepAliveMs: 500,
        },
        toRecord() {
          return { session: this.session };
        },
      };
    },
    async connectRuntime() {
      return {
        connectTimeoutMs: 60000,
        page,
        browser: {
          async pages() {
            return [1];
          },
        },
        toRecord() {
          return { runtime: 'puppeteer' };
        },
        async disconnect() {},
      };
    },
    readCheckpoint() {
      return null;
    },
  });

  const events = [];
  const result = await probe.run({
    targetUrl: 'https://example.com/otp',
    waitMs: 0,
    workflowEnabled: true,
    maxActions: 3,
    actionWaitMs: 0,
    payload: {
      OTP_CODE: '654321',
    },
    screenshotsDir: tmpDir,
    inventoriesDir: tmpDir,
    recordEvent(name, detail) {
      events.push({ name, detail });
    },
  });

  assert.equal(result.workflow.actions.length, 1);
  assert.equal(result.workflow.actions[0].plan.payloadKey, 'OTP_CODE');
  assert.equal(result.workflow.actions[0].result.status, 'ok');
  assert.equal(result.workflow.terminalOutcome, 'authed');
  assert.equal(result.workflow.finalStage.state, 'authed');
  assert.equal(fs.existsSync(path.join(tmpDir, '0003-post-otp-wait-1.png')), true);
  assert.equal(
    events.some(event => event.name === 'runtime_action_transition_after_otp'),
    true
  );
});

test('PuppeteerKeepAliveProbe invokes Browserless captcha solver when OTP phase lands on captcha', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'keepalive-probe-otp-captcha-'));
  let solveCalls = 0;
  const captchaSnapshot = {
    title: 'Just a moment...',
    url: 'https://example.com/otp',
    iframeCount: 0,
    tokenLength: 0,
    hasChallengeText: true,
    hasVerifyingText: false,
    hasSecurityCheckPassedText: false,
    challengeVisible: true,
  };
  const clearSnapshot = {
    ...captchaSnapshot,
    title: 'Member',
    hasChallengeText: false,
    challengeVisible: false,
  };
  const page = createEvaluatePageStub({
    url: 'https://example.com/otp',
    title: 'Verify',
    text: 'Confirmation code Verify',
    challengeSnapshotsByCall: [
      captchaSnapshot,
      clearSnapshot,
    ],
    candidatesByCall: [
      [],
      [
        {
          selector: '#signOut',
          index: 0,
          tag: 'a',
          type: '',
          role: '',
          text: 'Sign Out',
          label: [],
          ariaLabel: '',
          id: 'signOut',
          name: '',
          placeholder: '',
          autocomplete: '',
          inputMode: '',
          options: [],
          visible: true,
          disabled: false,
          focusable: true,
          valueLength: 0,
          boundingBox: { x: 0, y: 0, width: 100, height: 20 },
        },
      ],
    ],
  });
  const probe = new PuppeteerKeepAliveProbe({
    async createSession() {
      return {
        session: {
          id: 'session-1',
          connect: 'wss://example.com/session/connect/session-1',
          stop: 'https://example.com/session/session-1',
          ttlMs: 1000,
          processKeepAliveMs: 500,
        },
        toRecord() {
          return { session: this.session };
        },
      };
    },
    async connectRuntime() {
      return {
        connectTimeoutMs: 60000,
        page,
        cdp: {
          async send(method) {
            assert.equal(method, 'Browserless.solveCaptcha');
            solveCalls += 1;
            return { solved: true };
          },
        },
        browser: {
          async pages() {
            return [page];
          },
        },
        toRecord() {
          return { runtime: 'puppeteer' };
        },
        async disconnect() {},
      };
    },
  });
  const events = [];

  const result = await probe.run({
    targetUrl: 'https://example.com/otp',
    waitMs: 0,
    workflowEnabled: true,
    maxActions: 3,
    actionWaitMs: 0,
    payload: {
      OTP_CODE: '654321',
    },
    screenshotsDir: tmpDir,
    inventoriesDir: tmpDir,
    recordEvent(name, detail) {
      events.push({ name, detail });
    },
  });

  assert.equal(solveCalls, 1);
  assert.equal(events.some(event => event.name === 'captcha_manual_solve_start'), true);
  assert.equal(events.some(event => event.name === 'captcha_manual_solve_done'), true);
  assert.equal(events.some(event => event.name === 'runtime_action_transition_after_captcha'), true);
});

test('runPuppeteerKeepAliveProbeCli writes summary and checkpoint artifacts', async () => {
  const logsRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'keepalive-probe-'));
  const summary = await runPuppeteerKeepAliveProbeCli({
    logsRoot,
    customerId: 'danny',
    targetUrl: 'https://example.com/login',
    probe: {
      async run() {
        return {
          phase: 'bootstrap',
          targetUrl: 'https://example.com/login',
          currentUrl: 'https://example.com/member',
          pageTitle: 'Member',
          detachedAt: '2026-05-20T04:00:00.000Z',
          observed: {
            beforeUrl: 'about:blank',
            beforeTitle: '',
            afterUrl: 'https://example.com/member',
            afterTitle: 'Member',
            pageCount: 1,
          },
          capture: {
            screenshotPath: '/tmp/fake.png',
            inventoryPath: '/tmp/fake.json',
            screenshotError: '',
            snapshot: { challengeVisible: false },
            stage: { state: 'authed' },
            metrics: { stage: { state: 'authed' } },
          },
          measurement: null,
          sessionCreated: true,
          endpointForLogs: 'wss://example.com/session/connect/[redacted]',
          runtime: { runtime: 'puppeteer' },
          session: {
            id: 'session-1',
            connect: 'wss://example.com/session/connect/session-1',
            stop: 'https://example.com/session/session-1',
            ttlMs: 1000,
            processKeepAliveMs: 500,
          },
        };
      },
    },
  });

  assert.equal(fs.existsSync(summary.summaryPath), true);
  assert.equal(fs.existsSync(summary.checkpointPath), true);
  assert.equal(fs.existsSync(summary.eventsPath), true);
  assert.equal(summary.phase, 'bootstrap');

  const checkpoint = JSON.parse(fs.readFileSync(summary.checkpointPath, 'utf8'));
  assert.equal(checkpoint.session.id, 'session-1');
  assert.equal(checkpoint.currentUrl, 'https://example.com/member');
  assert.equal(checkpoint.stage.state, 'authed');

  const events = fs.readFileSync(summary.eventsPath, 'utf8')
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => JSON.parse(line));
  assert.deepEqual(
    events.map(event => event.name),
    ['run_start', 'run_complete']
  );
});
