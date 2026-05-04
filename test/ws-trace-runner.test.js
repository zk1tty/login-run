const test = require('node:test');
const assert = require('node:assert/strict');

const {
  derivePageStateFromMessages,
} = require('../scripts/lib/ws-trace-runner');

function recv(at, payload) {
  return {
    direction: 'recv',
    at,
    type: 'text',
    command: String(payload.command || ''),
    text: JSON.stringify(payload),
  };
}

test('derivePageStateFromMessages: waiting only', () => {
  const result = derivePageStateFromMessages([
    recv('10:00:00.000', {
      command: 'tabsUpdate',
      data: {
        tabs: [
          {
            id: 'target-1',
            isActive: true,
            title: 'Just a moment...',
            url: 'https://gitlab.com/users/sign_in',
          },
        ],
      },
    }),
    recv('10:00:00.100', {
      command: 'pageMeta',
      data: {
        title: 'Just a moment...',
        url: 'https://gitlab.com/users/sign_in',
      },
    }),
  ]);

  assert.equal(result.pageStateFromLive.state, 'challenge');
  assert.equal(result.pageStateFromLive.turnstilePageType, 'waiting');
});

test('derivePageStateFromMessages: waiting to checkbox via iframe bounds', () => {
  const result = derivePageStateFromMessages([
    recv('10:00:00.000', {
      command: 'pageMeta',
      data: {
        title: 'Just a moment...',
        url: 'https://example.com/login',
      },
    }),
    recv('10:00:02.000', {
      command: 'iframeBoundsUpdate',
      data: {
        frames: [
          {
            src: '',
            bounds: {
              x: 1,
              y: 1,
              width: 300,
              height: 90,
            },
          },
        ],
      },
    }),
  ]);

  const hasCheckbox = result.pageStateFromLive.transitions.some(
    item => item.state === 'challenge' && item.turnstilePageType === 'checkbox'
  );
  assert.equal(hasCheckbox, true);
  assert.equal(result.pageStateFromLive.transitionMetrics.waitingToCheckboxMs, 2000);
});

test('derivePageStateFromMessages: waiting to login', () => {
  const result = derivePageStateFromMessages([
    recv('10:00:00.000', {
      command: 'pageMeta',
      data: {
        title: 'Just a moment...',
        url: 'https://my.healthequity.com/ClientLogin.aspx',
      },
    }),
    recv('10:00:03.000', {
      command: 'pageMeta',
      data: {
        title: 'HealthEquity Login',
        url: 'https://my.healthequity.com/ClientLogin.aspx',
      },
    }),
  ]);

  assert.equal(result.pageStateFromLive.state, 'need_cred');
  assert.equal(result.pageStateFromLive.transitionMetrics.waitingToLoginMs, 3000);
});
