const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createLiveSignals,
  derivePageStateFromLiveSignals,
  recordLiveSignalFromWsText,
} = require('../src/core/detection/live-ws-state-classifier');

test('recordLiveSignalFromWsText tracks pageMeta and tabsUpdate signals', () => {
  const liveSignals = createLiveSignals();

  const pageMeta = JSON.stringify({
    command: 'pageMeta',
    data: {
      title: 'HealthEquity Login',
      url: 'https://my.healthequity.com/ClientLogin.aspx',
    },
  });
  const tabsUpdate = JSON.stringify({
    command: 'tabsUpdate',
    data: {
      tabs: [
        {
          id: 'target-1',
          title: 'HealthEquity Login',
          url: 'https://my.healthequity.com/ClientLogin.aspx',
          isActive: true,
        },
      ],
    },
  });

  const s1 = recordLiveSignalFromWsText(liveSignals, {
    text: pageMeta,
    at: '10:00:00.001',
    preferredTargetId: 'target-1',
  });
  const s2 = recordLiveSignalFromWsText(liveSignals, {
    text: tabsUpdate,
    at: '10:00:00.002',
    preferredTargetId: 'target-1',
  });

  assert.equal(s1.command, 'pageMeta');
  assert.equal(s2.command, 'tabsUpdate');
  assert.equal(liveSignals.commandCounts.pageMeta, 1);
  assert.equal(liveSignals.commandCounts.tabsUpdate, 1);
  assert.equal(liveSignals.pageMetaEvents.length, 1);
  assert.equal(liveSignals.tabsActiveEvents.length, 1);
  assert.equal(Array.isArray(liveSignals.iframeBoundsEvents), true);
  assert.equal(s2.shouldSwitchToPreferred, false);
  assert.equal(s2.activeTab?.id, 'target-1');
});

test('derivePageStateFromLiveSignals classifies from websocket events', () => {
  const liveSignals = createLiveSignals();
  recordLiveSignalFromWsText(liveSignals, {
    text: JSON.stringify({
      command: 'pageMeta',
      data: {
        title: 'Just a moment...',
        url: 'https://gitlab.com/users/sign_in',
      },
    }),
    at: '10:00:00.010',
  });

  const state = derivePageStateFromLiveSignals({
    liveSignals,
    fallbackProbe: {
      state: 'unknown',
      reason: 'No known auth/challenge markers detected on current page.',
    },
  });

  assert.equal(state.state, 'challenge');
  assert.equal(state.turnstilePageType, 'waiting');
  assert.equal(state.matchesProbe, false);
  assert.equal(Array.isArray(state.transitions), true);
  assert.equal(state.transitionMetrics.firstWaitingAt !== '', true);
});

test('derivePageStateFromLiveSignals infers checkbox transition from iframe bounds', () => {
  const liveSignals = createLiveSignals();
  recordLiveSignalFromWsText(liveSignals, {
    text: JSON.stringify({
      command: 'pageMeta',
      data: {
        title: 'Just a moment...',
        url: 'https://example.com/login',
      },
    }),
    at: '10:00:00.000',
  });
  recordLiveSignalFromWsText(liveSignals, {
    text: JSON.stringify({
      command: 'iframeBoundsUpdate',
      data: {
        frames: [
          { src: '', bounds: { x: 10, y: 20, width: 280, height: 80 } },
        ],
      },
    }),
    at: '10:00:02.000',
  });

  const state = derivePageStateFromLiveSignals({ liveSignals });
  assert.equal(state.transitions.length > 0, true);
  const hasCheckboxTransition = state.transitions.some(
    event => event.state === 'challenge' && event.turnstilePageType === 'checkbox'
  );
  assert.equal(hasCheckboxTransition, true);
  assert.equal(state.transitionMetrics.waitingToCheckboxMs, 2000);
});
