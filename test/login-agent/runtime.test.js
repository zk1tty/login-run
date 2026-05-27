const assert = require('node:assert/strict');
const test = require('node:test');

const {
  classifyRuntimeStage,
  inspectRuntimeInventory,
} = require('../../src/core/workflow/runtime-inventory');
const { planRuntimeAction } = require('../../src/core/workflow/action-planner');

function createElement(input = {}) {
  const attrs = input.attrs || {};
  return {
    tagName: input.tagName || 'INPUT',
    textContent: input.textContent || '',
    value: input.value || '',
    labels: input.labels || [],
    options: input.options || [],
    getAttribute(name) {
      return attrs[name] ?? null;
    },
    hasAttribute(name) {
      return Object.prototype.hasOwnProperty.call(attrs, name);
    },
    getBoundingClientRect() {
      return input.rect || { x: 10, y: 10, width: 220, height: 38 };
    },
    focus() {},
    closest() {
      return null;
    },
  };
}

test('runtime inventory extracts login inputs without activeElement initialization error', async () => {
  const username = createElement({
    attrs: {
      id: 'username',
      name: 'username',
      type: 'text',
      autocomplete: 'username',
    },
    labels: [{ textContent: 'Username' }],
  });
  const password = createElement({
    attrs: {
      id: 'password',
      name: 'password',
      type: 'password',
      autocomplete: 'current-password',
    },
    labels: [{ textContent: 'Password' }],
    rect: { x: 10, y: 60, width: 220, height: 38 },
  });
  const submit = createElement({
    tagName: 'BUTTON',
    textContent: 'Log in',
    attrs: {
      id: 'submit',
      type: 'submit',
    },
    rect: { x: 10, y: 110, width: 100, height: 38 },
  });
  const previousGlobals = {
    document: global.document,
    location: global.location,
    CSS: global.CSS,
    getComputedStyle: global.getComputedStyle,
  };

  global.document = {
    title: 'Login',
    body: { innerText: 'Username Password Log in' },
    activeElement: username,
    forms: [{}],
    querySelectorAll() {
      return [username, password, submit];
    },
    querySelector() {
      return null;
    },
  };
  global.location = {
    href: 'https://example.com/login',
  };
  global.CSS = {
    escape(value) {
      return String(value);
    },
  };
  global.getComputedStyle = () => ({
    display: 'block',
    visibility: 'visible',
    opacity: '1',
  });

  try {
    const inventory = await inspectRuntimeInventory({
      async evaluate(pageFunction) {
        return pageFunction();
      },
      locator() {},
    });

    assert.equal(inventory.error, undefined);
    assert.equal(inventory.candidates.length, 3);
    assert.equal(inventory.activeSelector, '#username');

    const stage = classifyRuntimeStage(inventory, { challengeVisible: false });
    assert.equal(stage.state, 'id+pw');
    assert.equal(stage.identifierSelector, '#username');
    assert.equal(stage.passwordSelector, '#password');
  } finally {
    global.document = previousGlobals.document;
    global.location = previousGlobals.location;
    global.CSS = previousGlobals.CSS;
    global.getComputedStyle = previousGlobals.getComputedStyle;
  }
});

test('runtime classifier treats username-first page as identifier, not otp', () => {
  const inventory = {
    candidates: [
      {
        index: 10,
        tag: 'input',
        selector: '#username',
        type: 'text',
        label: ['Username'],
        visible: true,
        disabled: false,
      },
      {
        index: 11,
        tag: 'a',
        selector: '#forgotPassword',
        id: 'linkForgotPassword1',
        text: 'password',
        label: [],
        visible: true,
        disabled: false,
      },
      {
        index: 12,
        tag: 'input',
        selector: '#continue',
        type: 'submit',
        text: 'Continue',
        visible: true,
        disabled: true,
      },
    ],
  };

  const stage = classifyRuntimeStage(inventory, { challengeVisible: false });
  assert.equal(stage.state, 'identifier');
  assert.equal(stage.selector, '#username');
});

test('runtime classifier tolerates missing challenge snapshot during navigation', () => {
  const inventory = {
    candidates: [
      {
        index: 10,
        tag: 'input',
        selector: '#username',
        type: 'text',
        label: ['Username'],
        visible: true,
        disabled: false,
        focusable: true,
        boundingBox: { x: 100, y: 100, width: 220, height: 32 },
      },
    ],
  };

  const stage = classifyRuntimeStage(inventory, null);
  assert.equal(stage.state, 'identifier');
  assert.equal(stage.selector, '#username');
});

test('runtime planner creates identifier fill and submit plan', () => {
  const inventory = {
    candidates: [
      {
        index: 10,
        tag: 'input',
        selector: '#username',
        type: 'text',
        label: ['Username'],
        visible: true,
        disabled: false,
        focusable: true,
      },
      {
        index: 12,
        tag: 'input',
        selector: '#continue',
        type: 'submit',
        text: 'Continue',
        visible: true,
        disabled: true,
        focusable: false,
      },
    ],
  };

  const plan = planRuntimeAction({
    stage: { state: 'identifier', selector: '#username' },
    inventory,
    payload: { LOGIN_USERNAME: 'user@example.com' },
  });

  assert.equal(plan.type, 'fill_input_and_submit');
  assert.equal(plan.inputSelector, '#username');
  assert.equal(plan.submitSelector, '#continue');
  assert.equal(plan.payloadKey, 'LOGIN_USERNAME');
  assert.equal(plan.typedLength, 'user@example.com'.length);
  assert.equal(plan.shouldSubmit, true);
});

test('runtime classifier treats combined username and password form as id+pw stage', () => {
  const inventory = {
    candidates: [
      {
        index: 10,
        tag: 'input',
        selector: '#username',
        type: 'text',
        label: [],
        id: 'username',
        name: 'username',
        visible: true,
        disabled: false,
        valueLength: 0,
      },
      {
        index: 11,
        tag: 'input',
        selector: '#password',
        type: 'password',
        label: [],
        id: 'password',
        name: 'password',
        visible: true,
        disabled: false,
        valueLength: 0,
      },
      {
        index: 12,
        tag: 'button',
        selector: '#submit',
        type: 'submit',
        text: 'Sign in',
        visible: true,
        disabled: false,
      },
    ],
  };

  const stage = classifyRuntimeStage(inventory, { challengeVisible: false });
  assert.equal(stage.state, 'id+pw');
  assert.equal(stage.phase, 'credential');
  assert.equal(stage.identifierSelector, '#username');
  assert.equal(stage.passwordSelector, '#password');
});

// Case:
// NC Benefit Plus used tiny non-focusable anti-autocomplete decoy inputs before the real username/password fields. 
test('runtime classifier ignores tiny non-focusable credential decoys', () => {
  const inventory = {
    candidates: [
      {
        index: 0,
        tag: 'input',
        selector: 'input[type="text"]',
        type: 'text',
        label: [],
        visible: true,
        disabled: false,
        focusable: false,
        valueLength: 0,
        boundingBox: { x: 0, y: 0, width: 4, height: 2 },
      },
      {
        index: 1,
        tag: 'input',
        selector: 'input[type="password"]',
        type: 'password',
        label: [],
        visible: true,
        disabled: false,
        focusable: false,
        valueLength: 0,
        boundingBox: { x: 0, y: 2, width: 4, height: 2 },
      },
      {
        index: 15,
        tag: 'input',
        selector: '#real-username',
        type: 'text',
        label: [],
        ariaLabel: 'Username',
        visible: true,
        disabled: false,
        focusable: true,
        active: true,
        valueLength: 0,
        boundingBox: { x: 168, y: 491, width: 175, height: 29 },
      },
      {
        index: 18,
        tag: 'div',
        selector: '#next',
        role: 'button',
        text: 'Next',
        visible: true,
        disabled: false,
        focusable: true,
        boundingBox: { x: 168, y: 614, width: 54, height: 41 },
      },
    ],
  };

  const stage = classifyRuntimeStage(inventory, { challengeVisible: false });
  assert.equal(stage.state, 'identifier');
  assert.equal(stage.selector, '#real-username');
});

test('runtime classifier selects real id+pw fields when decoys appear first', () => {
  const inventory = {
    candidates: [
      {
        index: 0,
        tag: 'input',
        selector: 'input[type="text"]',
        type: 'text',
        visible: true,
        disabled: false,
        focusable: false,
        valueLength: 0,
        boundingBox: { x: 0, y: 0, width: 4, height: 2 },
      },
      {
        index: 1,
        tag: 'input',
        selector: 'input[type="password"]',
        type: 'password',
        visible: true,
        disabled: false,
        focusable: false,
        valueLength: 0,
        boundingBox: { x: 0, y: 2, width: 4, height: 2 },
      },
      {
        index: 10,
        tag: 'input',
        selector: '#username',
        type: 'text',
        label: ['Username'],
        visible: true,
        disabled: false,
        focusable: true,
        valueLength: 0,
        boundingBox: { x: 100, y: 100, width: 220, height: 32 },
      },
      {
        index: 11,
        tag: 'input',
        selector: '#password',
        type: 'password',
        label: ['Password'],
        visible: true,
        disabled: false,
        focusable: true,
        valueLength: 0,
        boundingBox: { x: 100, y: 140, width: 220, height: 32 },
      },
    ],
  };

  const stage = classifyRuntimeStage(inventory, { challengeVisible: false });
  assert.equal(stage.state, 'id+pw');
  assert.equal(stage.identifierSelector, '#username');
  assert.equal(stage.passwordSelector, '#password');
});

test('runtime planner fills identifier without submitting on id+pw stage', () => {
  const inventory = {
    candidates: [
      {
        index: 10,
        tag: 'input',
        selector: '#username',
        type: 'text',
        label: [],
        visible: true,
        disabled: false,
        focusable: true,
        valueLength: 0,
      },
      {
        index: 11,
        tag: 'input',
        selector: '#password',
        type: 'password',
        visible: true,
        disabled: false,
        focusable: true,
        valueLength: 0,
      },
      {
        index: 12,
        tag: 'button',
        selector: '#submit',
        type: 'submit',
        text: 'Sign in',
        visible: true,
        disabled: false,
      },
    ],
  };

  const plan = planRuntimeAction({
    stage: {
      state: 'id+pw',
      phase: 'credential',
      identifierSelector: '#username',
      passwordSelector: '#password',
    },
    inventory,
    payload: { LOGIN_USERNAME: 'user@example.com' },
  });

  assert.equal(plan.type, 'fill_input_and_submit');
  assert.equal(plan.stage, 'id+pw');
  assert.equal(plan.inputSelector, '#username');
  assert.equal(plan.submitSelector, '#submit');
  assert.equal(plan.payloadKey, 'LOGIN_USERNAME');
  assert.equal(plan.shouldSubmit, false);
});

test('runtime planner fills password and submits on id+pw stage after identifier is filled', () => {
  const inventory = {
    candidates: [
      {
        index: 10,
        tag: 'input',
        selector: '#username',
        type: 'text',
        visible: true,
        disabled: false,
        focusable: true,
        valueLength: 16,
      },
      {
        index: 11,
        tag: 'input',
        selector: '#password',
        type: 'password',
        visible: true,
        disabled: false,
        focusable: true,
        valueLength: 0,
      },
      {
        index: 12,
        tag: 'button',
        selector: '#submit',
        type: 'submit',
        text: 'Sign in',
        visible: true,
        disabled: false,
      },
    ],
  };

  const plan = planRuntimeAction({
    stage: {
      state: 'id+pw',
      phase: 'credential',
      identifierSelector: '#username',
      passwordSelector: '#password',
    },
    inventory,
    payload: {
      LOGIN_USERNAME: 'user@example.com',
      LOGIN_PASSWORD: 'password-value',
    },
  });

  assert.equal(plan.type, 'fill_input_and_submit');
  assert.equal(plan.stage, 'id+pw');
  assert.equal(plan.inputSelector, '#password');
  assert.equal(plan.submitSelector, '#submit');
  assert.equal(plan.payloadKey, 'LOGIN_PASSWORD');
  assert.equal(plan.shouldSubmit, true);
});

test('runtime planner fills password and submits on password stage', () => {
  const inventory = {
    candidates: [
      {
        index: 20,
        tag: 'input',
        selector: '#password',
        type: 'password',
        visible: true,
        disabled: false,
        focusable: true,
        valueLength: 0,
      },
      {
        index: 21,
        tag: 'button',
        selector: '#submit',
        type: 'submit',
        text: 'Sign in',
        visible: true,
        disabled: false,
      },
    ],
  };

  const plan = planRuntimeAction({
    stage: {
      state: 'password',
      phase: 'credential',
      selector: '#password',
    },
    inventory,
    payload: { LOGIN_PASSWORD: 'password-value' },
  });

  assert.equal(plan.type, 'fill_input_and_submit');
  assert.equal(plan.stage, 'password');
  assert.equal(plan.inputSelector, '#password');
  assert.equal(plan.submitSelector, '#submit');
  assert.equal(plan.payloadKey, 'LOGIN_PASSWORD');
  assert.equal(plan.shouldSubmit, true);
});

test('runtime planner skips password action when LOGIN_PASSWORD is missing', () => {
  const plan = planRuntimeAction({
    stage: {
      state: 'password',
      phase: 'credential',
      selector: '#password',
    },
    inventory: {
      candidates: [
        {
          index: 20,
          tag: 'input',
          selector: '#password',
          type: 'password',
          visible: true,
          disabled: false,
        },
      ],
    },
    payload: {},
  });

  assert.equal(plan.type, 'none');
  assert.equal(plan.reason, 'missing_LOGIN_PASSWORD');
});

test('runtime classifier detects OTP code input', () => {
  const inventory = {
    candidates: [
      {
        index: 1,
        tag: 'input',
        selector: '#otp',
        type: 'text',
        label: ['Verification code'],
        autocomplete: 'one-time-code',
        visible: true,
        disabled: false,
        focusable: true,
      },
      {
        index: 2,
        tag: 'button',
        selector: '#verify',
        text: 'Verify',
        visible: true,
        disabled: false,
      },
    ],
  };

  const stage = classifyRuntimeStage(inventory, { challengeVisible: false });
  assert.equal(stage.state, 'otp_code');
  assert.equal(stage.selector, '#otp');
});

test('runtime planner pauses at OTP code stage without OTP_CODE', () => {
  const plan = planRuntimeAction({
    stage: { state: 'otp_code', selector: '#otp' },
    inventory: {
      candidates: [
        {
          index: 1,
          tag: 'input',
          selector: '#otp',
          type: 'text',
          label: ['Verification code'],
          visible: true,
          disabled: false,
        },
      ],
    },
    payload: {},
  });

  assert.equal(plan.type, 'pause');
  assert.equal(plan.terminalOutcome, 'need_otp');
  assert.equal(plan.reason, 'need_otp_code');
});

test('runtime planner fills and submits OTP code when OTP_CODE exists', () => {
  const inventory = {
    candidates: [
      {
        index: 1,
        tag: 'input',
        selector: '#otp',
        type: 'text',
        label: ['Verification code'],
        visible: true,
        disabled: false,
        focusable: true,
      },
      {
        index: 2,
        tag: 'button',
        selector: '#verify',
        text: 'Verify',
        visible: true,
        disabled: false,
      },
    ],
  };

  const plan = planRuntimeAction({
    stage: { state: 'otp_code', selector: '#otp' },
    inventory,
    payload: { OTP_CODE: '123456' },
  });

  assert.equal(plan.type, 'fill_input_and_submit');
  assert.equal(plan.stage, 'otp_code');
  assert.equal(plan.inputSelector, '#otp');
  assert.equal(plan.submitSelector, '#verify');
  assert.equal(plan.payloadKey, 'OTP_CODE');
  assert.equal(plan.typedLength, 6);
});

test('runtime classifier detects OTP delivery select', () => {
  const inventory = {
    text: 'Choose how you want to receive your verification code. Email Text message',
    candidates: [
      {
        index: 1,
        tag: 'select',
        selector: '#delivery',
        label: ['Delivery method'],
        visible: true,
        disabled: false,
        focusable: true,
        options: [
          { value: 'email', text: 'Email' },
          { value: 'sms', text: 'Text message' },
        ],
      },
    ],
  };

  const stage = classifyRuntimeStage(inventory, { challengeVisible: false });
  assert.equal(stage.state, 'otp_delivery_selection');
  assert.equal(stage.selector, '#delivery');
});

test('runtime planner selects configured OTP delivery option', () => {
  const inventory = {
    candidates: [
      {
        index: 1,
        tag: 'select',
        selector: '#delivery',
        label: ['Delivery method'],
        visible: true,
        disabled: false,
        focusable: true,
        options: [
          { value: 'email', text: 'Email' },
          { value: 'sms', text: 'Text message' },
        ],
      },
    ],
  };

  const plan = planRuntimeAction({
    stage: { state: 'otp_delivery_selection', selector: '#delivery' },
    inventory,
    payload: { OTP_DELIVERY_SELECTION: 'email' },
  });

  assert.equal(plan.type, 'select_option');
  assert.equal(plan.stage, 'otp_delivery_selection');
  assert.equal(plan.selector, '#delivery');
  assert.equal(plan.selection, 'email');
  assert.equal(plan.terminalOutcome, 'need_otp');
});

test('runtime classifier detects hidden styled OTP delivery radios', () => {
  const inventory = {
    text: 'Send the code: To my phone via text message or voice call To my email Address at n****@gmail.com Send Confirmation Code I do not recognize this email address or phone number(s)',
    candidates: [
      {
        index: 4,
        tag: 'input',
        selector: '#phoneOption',
        type: 'radio',
        id: 'phoneOption',
        name: 'phone',
        text: 'Phone',
        label: ['To my phone via text message or voice call'],
        visible: false,
        disabled: false,
        focusable: true,
      },
      {
        index: 7,
        tag: 'input',
        selector: '#emailOption',
        type: 'radio',
        id: 'emailOption',
        name: 'email',
        text: 'Email',
        label: ['To my email Address at n****@gmail.com'],
        visible: false,
        disabled: false,
        focusable: true,
      },
      {
        index: 9,
        tag: 'a',
        selector: '#ContactMemberServicesLink',
        text: 'I do not recognize this email address or phone number(s)',
        visible: true,
        disabled: false,
        focusable: true,
      },
    ],
  };

  const stage = classifyRuntimeStage(inventory, { challengeVisible: false });
  assert.equal(stage.state, 'otp_delivery_selection');
  assert.equal(stage.selector, '#phoneOption');
});

test('runtime planner checks configured OTP delivery radio and submits code request', () => {
  const inventory = {
    candidates: [
      {
        index: 4,
        tag: 'input',
        selector: '#phoneOption',
        type: 'radio',
        id: 'phoneOption',
        name: 'phone',
        text: 'Phone',
        label: ['To my phone via text message or voice call'],
        visible: false,
        disabled: false,
        focusable: true,
      },
      {
        index: 7,
        tag: 'input',
        selector: '#emailOption',
        type: 'radio',
        id: 'emailOption',
        name: 'email',
        text: 'Email',
        label: ['To my email Address at n****@gmail.com'],
        visible: false,
        disabled: false,
        focusable: true,
      },
      {
        index: 8,
        tag: 'button',
        selector: '#sendOtp',
        type: 'submit',
        id: 'sendOtp',
        text: 'Send Confirmation Code',
        visible: true,
        disabled: true,
        focusable: false,
      },
      {
        index: 9,
        tag: 'a',
        selector: '#ContactMemberServicesLink',
        text: 'I do not recognize this email address or phone number(s)',
        visible: true,
        disabled: false,
        focusable: true,
      },
    ],
  };

  const plan = planRuntimeAction({
    stage: { state: 'otp_delivery_selection', selector: '#phoneOption' },
    inventory,
    payload: { OTP_DELIVERY_SELECTION: 'email' },
  });

  assert.equal(plan.type, 'select_delivery_and_submit');
  assert.equal(plan.optionSelector, '#emailOption');
  assert.equal(plan.submitSelector, '#sendOtp');
  assert.equal(plan.terminalOutcome, 'need_otp');
});

test('runtime planner prefers login submit button over nearby password visibility toggle', () => {
  const inventory = {
    candidates: [
      {
        index: 3,
        tag: 'input',
        selector: '#dom-username-input',
        type: 'text',
        label: ['Username'],
        visible: true,
        disabled: false,
        focusable: true,
        valueLength: 16,
        boundingBox: { x: 312, y: 226, width: 382, height: 40 },
      },
      {
        index: 4,
        tag: 'input',
        selector: '#dom-pswd-input',
        type: 'password',
        label: ['Password'],
        visible: true,
        disabled: false,
        focusable: true,
        valueLength: 0,
        boundingBox: { x: 312, y: 303, width: 382, height: 40 },
      },
      {
        index: 5,
        tag: 'span',
        selector: 'span[aria-label="show password"]',
        role: 'button',
        ariaLabel: 'show password',
        text: '',
        visible: true,
        disabled: false,
        focusable: true,
        boundingBox: { x: 658, y: 313, width: 20, height: 20 },
      },
      {
        index: 7,
        tag: 'button',
        selector: '#dom-login-button',
        type: 'submit',
        text: 'Log in',
        visible: true,
        disabled: false,
        focusable: true,
        boundingBox: { x: 312, y: 407, width: 382, height: 40 },
      },
    ],
  };

  const plan = planRuntimeAction({
    stage: {
      state: 'id+pw',
      phase: 'credential',
      identifierSelector: '#dom-username-input',
      passwordSelector: '#dom-pswd-input',
    },
    inventory,
    payload: {
      LOGIN_USERNAME: 'user@example.com',
      LOGIN_PASSWORD: 'password-value',
    },
  });

  assert.equal(plan.type, 'fill_input_and_submit');
  assert.equal(plan.inputSelector, '#dom-pswd-input');
  assert.equal(plan.submitSelector, '#dom-login-button');
  assert.equal(plan.payloadKey, 'LOGIN_PASSWORD');
  assert.equal(plan.shouldSubmit, true);
});

test('runtime classifier detects authenticated member page after MFA redirect', () => {
  const inventory = {
    url: 'https://my.healthequity.com/Member/MemberHome.aspx',
    title: 'Member Home',
    text: 'Account Balance Available Balance Recent Activity',
    candidates: [
      {
        index: 0,
        tag: 'a',
        selector: '#SignOut',
        text: 'Sign Out',
        visible: true,
        disabled: false,
        focusable: true,
      },
      {
        index: 1,
        tag: 'a',
        selector: '#account',
        text: 'Account Balance',
        visible: true,
        disabled: false,
        focusable: true,
      },
    ],
  };

  const stage = classifyRuntimeStage(inventory, { challengeVisible: false });
  assert.equal(stage.state, 'authed');
  assert.equal(stage.phase, 'authenticated');
});

test('runtime classifier detects HealthEquity member portal URL/title after MFA redirect', () => {
  const inventory = {
    url: 'https://member.my.healthequity.com/',
    title: 'Member Portal',
    text: '',
    candidates: [],
  };

  const stage = classifyRuntimeStage(inventory, { challengeVisible: false });
  assert.equal(stage.state, 'authed');
  assert.equal(stage.phase, 'authenticated');
});

test('runtime classifier keeps MFA page as OTP when sign out is present', () => {
  const inventory = {
    url: 'https://my.healthequity.com/Services/MfaChallenge#!/?targetUrl=%2FMember%2FMemberHome.aspx',
    title: 'Login - Security Verification',
    text: 'Sign Out Enter your confirmation code Confirmation Code',
    candidates: [
      {
        index: 0,
        tag: 'a',
        selector: '#SignOut',
        text: 'Sign Out',
        visible: true,
        disabled: false,
        focusable: true,
      },
      {
        index: 1,
        tag: 'input',
        selector: '#otpCode',
        type: 'text',
        label: ['Confirmation Code'],
        visible: true,
        disabled: false,
        focusable: true,
        boundingBox: { x: 191, y: 351, width: 532, height: 34 },
      },
    ],
  };

  const stage = classifyRuntimeStage(inventory, { challengeVisible: false });
  assert.equal(stage.state, 'otp_code');
});

test('runtime classifier detects OTP error message', () => {
  const inventory = {
    url: 'https://my.healthequity.com/Services/MfaChallenge#!/?targetUrl=%2FMember%2FMemberHome.aspx',
    title: 'Login - Security Verification',
    text: 'The confirmation code is invalid. Please try again.',
    candidates: [
      {
        index: 1,
        tag: 'input',
        selector: '#otpCode',
        type: 'text',
        label: ['Confirmation Code'],
        visible: true,
        disabled: false,
        focusable: true,
        boundingBox: { x: 191, y: 351, width: 532, height: 34 },
      },
    ],
  };

  const stage = classifyRuntimeStage(inventory, { challengeVisible: false });
  assert.equal(stage.state, 'otp_error');
  assert.equal(stage.selector, '#otpCode');
});
