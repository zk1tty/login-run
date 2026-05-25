const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createCaptchaState,
  applyBrowserlessCaptchaFound,
  applyBrowserlessCaptchaAutoSolved,
  applyBrowserlessCaptchaManualSolve,
  applyDomChallengeObservation,
} = require('../../src/core/workflow/captcha-state');

function makeEvent(offsetMs) {
  return {
    at: `2026-05-12T00:00:${String(offsetMs).padStart(2, '0')}Z`,
    offsetMs,
  };
}

test('browserless failed auto-solve does not mark captcha resolved', () => {
  const state = createCaptchaState();

  applyBrowserlessCaptchaFound(
    state,
    { type: 'datadome', status: 'solving' },
    makeEvent(2)
  );
  applyBrowserlessCaptchaAutoSolved(
    state,
    {
      found: true,
      solved: false,
      error: 'datadome captcha requires proxy to solve',
    },
    makeEvent(3)
  );

  assert.equal(state.firstSeenOffsetMs, 2);
  assert.equal(state.resolvedOffsetMs, null);
  assert.equal(state.browserless.solved, false);
  assert.equal(state.browserless.solveFailed, true);
  assert.equal(state.browserless.error, 'datadome captcha requires proxy to solve');
});

test('browserless successful auto-solve marks captcha resolved', () => {
  const state = createCaptchaState();

  applyBrowserlessCaptchaFound(
    state,
    { type: 'turnstile', status: 'solving' },
    makeEvent(5)
  );
  applyBrowserlessCaptchaAutoSolved(
    state,
    { found: true, solved: true, token: 'abc' },
    makeEvent(7)
  );

  assert.equal(state.firstSeenOffsetMs, 5);
  assert.equal(state.resolvedOffsetMs, 7);
  assert.equal(state.resolutionSource, 'browserless');
});

test('browserless successful manual solve marks captcha resolved', () => {
  const state = createCaptchaState();

  applyBrowserlessCaptchaFound(
    state,
    { type: 'turnstile', status: 'solving' },
    makeEvent(6)
  );
  applyBrowserlessCaptchaManualSolve(
    state,
    { solved: true, token: '[redacted]' },
    makeEvent(9)
  );

  assert.equal(state.firstSeenOffsetMs, 6);
  assert.equal(state.resolvedOffsetMs, 9);
  assert.equal(state.resolutionSource, 'browserless_manual');
});

test('dom challenge disappearance resolves only after prior dom-visible challenge', () => {
  const state = createCaptchaState();

  applyDomChallengeObservation(
    state,
    { challengeVisible: false, hasSecurityCheckPassedText: false, tokenLength: 0 },
    makeEvent(1)
  );
  assert.equal(state.resolvedOffsetMs, null);

  applyDomChallengeObservation(
    state,
    { challengeVisible: true, hasSecurityCheckPassedText: false, tokenLength: 0 },
    makeEvent(2)
  );
  applyDomChallengeObservation(
    state,
    { challengeVisible: false, hasSecurityCheckPassedText: false, tokenLength: 0 },
    makeEvent(4)
  );

  assert.equal(state.firstSeenOffsetMs, 2);
  assert.equal(state.resolvedOffsetMs, 4);
  assert.equal(state.resolutionSource, 'dom');
});

test('dom success evidence resolves after prior captcha detection', () => {
  const state = createCaptchaState();

  applyBrowserlessCaptchaFound(
    state,
    { type: 'turnstile', status: 'solving' },
    makeEvent(2)
  );
  applyDomChallengeObservation(
    state,
    { challengeVisible: false, hasSecurityCheckPassedText: true, tokenLength: 0 },
    makeEvent(5)
  );

  assert.equal(state.resolvedOffsetMs, 5);
  assert.equal(state.resolutionSource, 'dom');
  assert.equal(state.resolutionEvidence, 'DOM contains security check passed text.');
});
