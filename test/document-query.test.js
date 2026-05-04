const test = require('node:test');
const assert = require('node:assert/strict');

const {
  BLOCKED_CODES,
  detectAuthState,
  inspectAuthDocumentFromHtml,
} = require('../src/core/detection/document-query');

test('initial login snapshot is phase-aware and blocks non-actionable controls', () => {
  const html = `
    <html>
      <head>
        <title>HealthEquity Login</title>
        <script>const passwordRef = "password";</script>
      </head>
      <body>
        <form>
          <label for="username">Username</label>
          <input id="username" name="username" type="text" />
          <button id="continue" type="submit" disabled>Continue</button>
        </form>
      </body>
    </html>
  `;

  const signals = inspectAuthDocumentFromHtml({
    html,
    title: 'HealthEquity Login',
    url: 'https://my.healthequity.com/ClientLogin.aspx',
  });
  const actions = signals.actions;

  assert.equal(signals.phaseHint, 'initial');
  assert.equal(actions.username.found, true);
  assert.deepEqual(actions.username.value, {
    raw: '',
    length: 0,
    isEmpty: true,
  });
  assert.equal(actions.password.found, false);
  assert.equal(
    actions.password.blocked.code,
    BLOCKED_CODES.NOT_RENDERED
  );
  assert.equal(actions.continueButton.found, false);
  assert.equal(actions.continueButton.blocked.code, BLOCKED_CODES.DISABLED);

  assert.equal(actions.selection.found, false);
  assert.equal(actions.sendCodeButton.found, false);
  assert.equal(actions.sendCodeButton.blocked.code, BLOCKED_CODES.NOT_RENDERED);
  assert.equal(actions.confirmationCodeInput.found, false);
  assert.equal(actions.confirmationCodeInput.blocked.code, BLOCKED_CODES.NOT_RENDERED);
  assert.equal(actions.rememberDevice.found, false);

  const detection = detectAuthState(signals);
  assert.equal(detection.state, 'need_cred');
  assert.ok(!String(detection.reason || '').toLowerCase().includes('two-factor'));
});

test('two-factor snapshot exposes actionable OTP controls and blocks initial actions', () => {
  const html = `
    <html>
      <head>
        <title>Security Verification</title>
      </head>
      <body>
        <main>
          <h1>Verify your identity</h1>
          <div>
            <input type="radio" id="method_sms" name="method" value="sms" />
            <label for="method_sms">Text message</label>
          </div>
          <button type="submit">Send Confirmation Code</button>
          <div>
            <label for="otp">Confirmation code</label>
            <input id="otp" name="confirmationCode" autocomplete="one-time-code" />
          </div>
          <div>
            <input type="checkbox" id="remember_device" name="rememberDevice" />
            <label for="remember_device">Remember this device</label>
          </div>
        </main>
      </body>
    </html>
  `;

  const signals = inspectAuthDocumentFromHtml({
    html,
    title: 'Security Verification',
    url: 'https://my.healthequity.com/Member/SecurityCode.aspx',
  });
  const actions = signals.actions;

  assert.equal(signals.phaseHint, 'two_factor');
  assert.equal(actions.selection.found, true);
  assert.equal(actions.sendCodeButton.found, true);
  assert.equal(actions.confirmButton.found, false);
  assert.equal(actions.confirmButton.blocked.code, BLOCKED_CODES.NOT_RENDERED);
  assert.equal(actions.confirmationCodeInput.found, true);
  assert.equal(actions.rememberDevice.found, true);

  assert.equal(actions.username.found, false);
  assert.equal(actions.username.blocked.code, BLOCKED_CODES.NOT_RENDERED);
  assert.equal(actions.password.found, false);
  assert.equal(actions.password.blocked.code, BLOCKED_CODES.NOT_RENDERED);
  assert.equal(actions.continueButton.found, false);
  assert.equal(actions.continueButton.blocked.code, BLOCKED_CODES.NOT_RENDERED);

  const detection = detectAuthState(signals);
  assert.equal(detection.state, 'need_otp');
});

test('confirm button is detected as confirmButton action', () => {
  const html = `
    <html>
      <head>
        <title>Two-Step Verification</title>
      </head>
      <body>
        <main>
          <h1>Enter the confirmation code</h1>
          <label for="otp_code">Confirmation code</label>
          <input id="otp_code" name="otpCode" autocomplete="one-time-code" />
          <button id="confirm_otp" type="submit">Confirm</button>
        </main>
      </body>
    </html>
  `;

  const signals = inspectAuthDocumentFromHtml({
    html,
    title: 'Two-Step Verification',
    url: 'https://my.healthequity.com/Member/SecurityCode.aspx',
  });

  assert.equal(signals.actions.confirmButton.found, true);
  assert.equal(signals.actions.confirmButton.selector, '#confirm_otp');
});

test('hidden and disabled controls return blocked reasons instead of found=true', () => {
  const html = `
    <html>
      <head><title>HealthEquity Login</title></head>
      <body>
        <form>
          <label for="username_hidden">Username</label>
          <input id="username_hidden" name="username" style="display:none" />
          <button id="continue_btn" type="submit" disabled>Continue</button>
        </form>
      </body>
    </html>
  `;

  const signals = inspectAuthDocumentFromHtml({
    html,
    title: 'HealthEquity Login',
    url: 'https://my.healthequity.com/ClientLogin.aspx',
  });
  const actions = signals.actions;

  assert.equal(signals.phaseHint, 'initial');
  assert.equal(actions.username.found, false);
  assert.equal(actions.username.blocked.code, BLOCKED_CODES.HIDDEN);
  assert.equal(actions.continueButton.found, false);
  assert.equal(actions.continueButton.blocked.code, BLOCKED_CODES.DISABLED);
});

test('password references in scripts do not create false actionable password fields', () => {
  const html = `
    <html>
      <head>
        <title>HealthEquity Login</title>
        <script>
          window.passwordFieldName = "password";
        </script>
      </head>
      <body>
        <form>
          <input id="username" name="username" />
          <button type="submit">Continue</button>
        </form>
      </body>
    </html>
  `;

  const signals = inspectAuthDocumentFromHtml({
    html,
    title: 'HealthEquity Login',
    url: 'https://my.healthequity.com/ClientLogin.aspx',
  });

  assert.equal(signals.actions.password.found, false);
  assert.equal(
    signals.actions.password.blocked.code,
    BLOCKED_CODES.NOT_RENDERED
  );
});
