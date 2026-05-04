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
  const queries = signals.queries;

  assert.equal(signals.phase, 'initial');
  assert.equal(queries.initial.username.found, true);
  assert.equal(queries.initial.password.found, false);
  assert.equal(
    queries.initial.password.blocked.code,
    BLOCKED_CODES.NOT_RENDERED
  );
  assert.equal(queries.initial.continueButton.found, false);
  assert.equal(queries.initial.continueButton.blocked.code, BLOCKED_CODES.DISABLED);

  assert.equal(queries.twoFactor.selection.found, false);
  assert.equal(queries.twoFactor.selection.blocked.code, BLOCKED_CODES.OUT_OF_PHASE);
  assert.equal(queries.twoFactor.confirmationCodeInput.found, false);
  assert.equal(
    queries.twoFactor.confirmationCodeInput.blocked.code,
    BLOCKED_CODES.OUT_OF_PHASE
  );
  assert.equal(queries.twoFactor.rememberDevice.found, false);
  assert.equal(
    queries.twoFactor.rememberDevice.blocked.code,
    BLOCKED_CODES.OUT_OF_PHASE
  );

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
          <div>
            <label for="otp">Confirmation code</label>
            <input id="otp" name="confirmationCode" autocomplete="one-time-code" />
          </div>
          <div>
            <input type="checkbox" id="remember_device" name="rememberDevice" />
            <label for="remember_device">Remember this device</label>
          </div>
          <button type="submit">Continue</button>
        </main>
      </body>
    </html>
  `;

  const signals = inspectAuthDocumentFromHtml({
    html,
    title: 'Security Verification',
    url: 'https://my.healthequity.com/Member/SecurityCode.aspx',
  });
  const queries = signals.queries;

  assert.equal(signals.phase, 'two_factor');
  assert.equal(queries.twoFactor.selection.found, true);
  assert.equal(queries.twoFactor.confirmationCodeInput.found, true);
  assert.equal(queries.twoFactor.rememberDevice.found, true);

  assert.equal(queries.initial.username.found, false);
  assert.equal(queries.initial.username.blocked.code, BLOCKED_CODES.OUT_OF_PHASE);
  assert.equal(queries.initial.password.found, false);
  assert.equal(queries.initial.password.blocked.code, BLOCKED_CODES.OUT_OF_PHASE);
  assert.equal(queries.initial.continueButton.found, false);
  assert.equal(
    queries.initial.continueButton.blocked.code,
    BLOCKED_CODES.OUT_OF_PHASE
  );

  const detection = detectAuthState(signals);
  assert.equal(detection.state, 'need_otp');
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
  const queries = signals.queries;

  assert.equal(signals.phase, 'initial');
  assert.equal(queries.initial.username.found, false);
  assert.equal(queries.initial.username.blocked.code, BLOCKED_CODES.HIDDEN);
  assert.equal(queries.initial.continueButton.found, false);
  assert.equal(queries.initial.continueButton.blocked.code, BLOCKED_CODES.DISABLED);
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

  assert.equal(signals.queries.initial.password.found, false);
  assert.equal(
    signals.queries.initial.password.blocked.code,
    BLOCKED_CODES.NOT_RENDERED
  );
});
