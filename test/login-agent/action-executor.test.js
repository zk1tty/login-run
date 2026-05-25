const assert = require('node:assert/strict');
const test = require('node:test');

const { executeRuntimeAction } = require('../../src/core/workflow/action-executor');

class FakeElement {
  constructor(input = {}) {
    this.id = input.id || '';
    this.checked = input.checked === true;
    this.disabled = input.disabled === true;
    this.ariaDisabled = input.ariaDisabled || '';
    this.value = input.value || '';
  }

  hasAttribute(name) {
    return name === 'disabled' ? this.disabled : false;
  }

  getAttribute(name) {
    if (name === 'aria-disabled') {
      return this.ariaDisabled;
    }
    return null;
  }
}

class FakeLocator {
  constructor(input = {}) {
    this.node = input.node || new FakeElement();
    this.onCheck = input.onCheck || null;
    this.onClick = input.onClick || null;
    this.waitVisible = input.waitVisible !== false;
    this.clickCount = 0;
  }

  first() {
    return this;
  }

  async waitFor(input = {}) {
    if (input.state === 'visible' && !this.waitVisible) {
      throw new Error('not visible');
    }
  }

  async check() {
    if (this.onCheck) {
      await this.onCheck();
      return;
    }
    this.node.checked = true;
  }

  async click() {
    this.clickCount += 1;
    if (this.onClick) {
      await this.onClick();
    }
  }

  async evaluate(fn, ...args) {
    return fn(this.node, ...args);
  }

  async fill(value) {
    this.node.value = String(value);
  }

  async press() {}
}

function createFakePage(input = {}) {
  const stabilitySnapshots = input.stabilitySnapshots || [
    {
      url: 'https://example.test/mfa',
      readyState: 'complete',
      mutationCount: 0,
      targets: [
        { selector: '#emailOption', exists: true },
        { selector: '#sendOtp', exists: true },
      ],
    },
    {
      url: 'https://example.test/mfa',
      readyState: 'complete',
      mutationCount: 0,
      targets: [
        { selector: '#emailOption', exists: true },
        { selector: '#sendOtp', exists: true },
      ],
    },
  ];
  let stabilityIndex = 0;
  const option = new FakeLocator({
    node: new FakeElement({ id: 'emailOption' }),
    onCheck: input.nativeCheckFails === false
      ? null
      : async () => {
          throw new Error('clicking did not change state');
        },
  });
  const submit = new FakeLocator({
    node: new FakeElement({ id: 'sendOtp', disabled: true }),
  });
  const label = new FakeLocator({
    node: new FakeElement(),
    waitVisible: input.labelVisible !== false,
    onClick: async () => {
      if (input.labelSelects !== false) {
        option.node.checked = true;
        submit.node.disabled = false;
      }
    },
  });
  const selectors = {
    '#emailOption': option,
    '#sendOtp': submit,
    'label[for="emailOption"]': label,
  };

  return {
    option,
    submit,
    label,
    page: {
      locator(selector) {
        return selectors[selector] || new FakeLocator({ waitVisible: false });
      },
      async evaluate() {
        const snapshot =
          stabilitySnapshots[Math.min(stabilityIndex, stabilitySnapshots.length - 1)];
        stabilityIndex += 1;
        return snapshot;
      },
      async waitForTimeout() {},
      mouse: {
        async click() {
          if (input.centerSelects === true) {
            option.node.checked = true;
            submit.node.disabled = false;
          }
        },
      },
    },
  };
}

function deliveryPlan() {
  return {
    type: 'select_delivery_and_submit',
    stage: 'otp_delivery_selection',
    optionSelector: '#emailOption',
    optionCandidate: {
      boundingBox: {
        x: 209,
        y: 468,
        width: 13,
        height: 13,
      },
    },
    submitSelector: '#sendOtp',
    terminalOutcome: 'need_otp',
  };
}

function fillPlan(input = {}) {
  return {
    type: 'fill_input_and_submit',
    stage: input.stage || 'otp_code_entry',
    inputSelector: input.inputSelector || '#otpCode',
    submitSelector: input.submitSelector || '#verifyOtp',
    payloadKey: input.payloadKey || 'OTP_CODE',
    shouldSubmit: input.shouldSubmit,
  };
}

function createFillPage(input = {}) {
  const otpInput = new FakeLocator({
    node: new FakeElement({ id: 'otpCode' }),
  });
  if (input.fillSticks === false) {
    otpInput.fill = async () => {};
  }
  const submit = new FakeLocator({
    node: new FakeElement({ id: 'verifyOtp', disabled: input.submitDisabled === true }),
  });
  const selectors = {
    '#otpCode': otpInput,
    '#verifyOtp': submit,
  };

  return {
    input: otpInput,
    submit,
    page: {
      locator(selector) {
        return selectors[selector] || new FakeLocator({ waitVisible: false });
      },
      async waitForTimeout() {},
    },
  };
}

test('executor verifies OTP input value after fill before submitting', async t => {
  const previousHTMLElement = global.HTMLElement;
  global.HTMLElement = FakeElement;
  t.after(() => {
    global.HTMLElement = previousHTMLElement;
  });

  const fake = createFillPage();
  const result = await executeRuntimeAction(fake.page, fillPlan(), { OTP_CODE: '986624' }, {
    waitMs: 1000,
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.typedLength, 6);
  assert.deepEqual(result.fillVerification, {
    expectedLength: 6,
    actualLength: 6,
    lengthMatches: true,
    valueMatches: true,
    expectedFormat: 'six_digits',
    formatMatches: true,
    verified: true,
  });
  assert.equal(result.submitMethod, 'click');
  assert.equal(result.submitClicked, true);
  assert.equal(fake.submit.clickCount, 1);
});

test('executor fails before submit when filled input value does not stick', async t => {
  const previousHTMLElement = global.HTMLElement;
  global.HTMLElement = FakeElement;
  t.after(() => {
    global.HTMLElement = previousHTMLElement;
  });

  const fake = createFillPage({ fillSticks: false });
  const result = await executeRuntimeAction(fake.page, fillPlan(), { OTP_CODE: '986624' }, {
    waitMs: 1000,
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'input_value_verification_failed');
  assert.equal(result.fillVerification.actualLength, 0);
  assert.equal(result.fillVerification.formatMatches, false);
  assert.equal(fake.submit.clickCount, 0);
});

test('executor selects hidden OTP delivery radio by clicking its label fallback', async t => {
  const previousHTMLElement = global.HTMLElement;
  global.HTMLElement = FakeElement;
  t.after(() => {
    global.HTMLElement = previousHTMLElement;
  });

  const fake = createFakePage();
  const result = await executeRuntimeAction(fake.page, deliveryPlan(), {}, {
    waitMs: 1000,
    pageStability: {
      timeoutMs: 100,
      pollMs: 1,
      quietMs: 0,
      minStablePolls: 1,
    },
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.pageStability.status, 'stable');
  assert.equal(result.selectionMethod, 'label_click');
  assert.equal(fake.option.node.checked, true);
  assert.equal(fake.submit.clickCount, 1);
  assert.equal(result.submitClicked, true);
  assert.equal(result.terminalOutcome, 'need_otp');
});

test('executor can select OTP delivery radio by candidate center when label is unavailable', async t => {
  const previousHTMLElement = global.HTMLElement;
  global.HTMLElement = FakeElement;
  t.after(() => {
    global.HTMLElement = previousHTMLElement;
  });

  const fake = createFakePage({
    labelVisible: false,
    centerSelects: true,
  });
  const result = await executeRuntimeAction(fake.page, deliveryPlan(), {}, {
    waitMs: 1000,
    pageStability: {
      timeoutMs: 100,
      pollMs: 1,
      quietMs: 0,
      minStablePolls: 1,
    },
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.selectionMethod, 'candidate_center_click');
  assert.equal(fake.option.node.checked, true);
  assert.equal(fake.submit.clickCount, 1);
});

test('executor reports option_not_selected when all delivery selection attempts fail', async t => {
  const previousHTMLElement = global.HTMLElement;
  global.HTMLElement = FakeElement;
  t.after(() => {
    global.HTMLElement = previousHTMLElement;
  });

  const fake = createFakePage({
    labelSelects: false,
    centerSelects: false,
  });
  const result = await executeRuntimeAction(fake.page, deliveryPlan(), {}, {
    waitMs: 1000,
    pageStability: {
      timeoutMs: 100,
      pollMs: 1,
      quietMs: 0,
      minStablePolls: 1,
    },
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.error, 'option_not_selected');
  assert.equal(fake.option.node.checked, false);
});
