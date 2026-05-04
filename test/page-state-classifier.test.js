const test = require('node:test');
const assert = require('node:assert/strict');

const { classifyPageState } = require('../src/core/detection/page-state-classifier');

test('classifyPageState: detects turnstile waiting from page title/url corpus', () => {
  const result = classifyPageState({
    title: 'Just a moment...',
    url: 'https://gitlab.com/users/sign_in',
    text: 'Performing security verification',
  });

  assert.equal(result.state, 'challenge');
  assert.equal(result.turnstilePageType, 'waiting');
});

test('classifyPageState: detects login page from login path/title without password field', () => {
  const result = classifyPageState({
    title: 'HealthEquity Login',
    url: 'https://my.healthequity.com/ClientLogin.aspx',
    hasPasswordInput: false,
    hasLoginIdentifierInput: false,
  });

  assert.equal(result.state, 'need_cred');
  assert.equal(result.reason, 'Login form markers detected.');
});

test('classifyPageState: returns unknown when no strong signals exist', () => {
  const result = classifyPageState({
    title: 'Welcome',
    url: 'https://example.com/',
    text: 'hello world',
  });

  assert.equal(result.state, 'unknown');
});
