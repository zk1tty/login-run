const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createChallengeStateMachine,
} = require('../src/core/challenge/challenge-state-machine');

function createClock() {
  let currentMs = 0;

  return {
    now() {
      return currentMs;
    },
    async sleep(ms) {
      currentMs += Number(ms) || 0;
    },
    advance(ms) {
      currentMs += Number(ms) || 0;
    },
  };
}

test('state machine waits pending, clicks iframe center, and reports solved', async () => {
  const clock = createClock();
  const snapshots = [
    {
      hasChallengeSurface: true,
      pending: true,
      solved: false,
      hasToken: false,
      hasInteractiveFrame: false,
      target: null,
    },
    {
      hasChallengeSurface: true,
      pending: true,
      solved: false,
      hasToken: false,
      hasInteractiveFrame: false,
      target: null,
    },
    {
      hasChallengeSurface: true,
      pending: false,
      solved: false,
      hasToken: false,
      hasInteractiveFrame: true,
      target: {
        source: 'iframe_center',
        x: 320,
        y: 220,
      },
    },
    {
      hasChallengeSurface: true,
      pending: false,
      solved: true,
      hasToken: true,
      hasInteractiveFrame: false,
      target: null,
    },
  ];
  let probeIndex = 0;
  const clicks = [];

  const machine = createChallengeStateMachine({
    now: () => clock.now(),
    sleep: ms => clock.sleep(ms),
    probeSurface: async () => {
      const snapshot = snapshots[Math.min(probeIndex, snapshots.length - 1)];
      probeIndex += 1;
      return snapshot;
    },
    clickTarget: async (_page, target) => {
      clicks.push(target);
      return { ok: true };
    },
    pollIntervalMs: 50,
    postClickWaitMs: 10,
    clickCooldownMs: 0,
    maxClicks: 2,
    maxWaitMs: 1000,
  });

  const result = await machine.run({ page: {} });

  assert.equal(result.status, 'solved');
  assert.equal(result.reason, 'turnstile_token_present');
  assert.equal(result.pendingObserved, true);
  assert.equal(result.interactiveObserved, true);
  assert.equal(result.clickAttempts.length, 1);
  assert.equal(result.clickAttempts[0].ok, true);
  assert.equal(result.clickAttempts[0].source, 'iframe_center');
  assert.equal(clicks.length, 1);
});

test('state machine returns timeout when challenge remains pending with no interactive target', async () => {
  const clock = createClock();

  const machine = createChallengeStateMachine({
    now: () => clock.now(),
    sleep: ms => clock.sleep(ms),
    probeSurface: async () => ({
      hasChallengeSurface: true,
      pending: true,
      solved: false,
      hasToken: false,
      hasInteractiveFrame: false,
      target: null,
    }),
    clickTarget: async () => ({ ok: true }),
    pollIntervalMs: 25,
    maxWaitMs: 120,
  });

  const result = await machine.run({ page: {} });

  assert.equal(result.status, 'timeout');
  assert.equal(result.reason, 'challenge_still_pending');
  assert.equal(result.pendingObserved, true);
  assert.equal(result.interactiveObserved, false);
  assert.equal(result.clickAttempts.length, 0);
});

test('state machine reports not_challenge when challenge surface is absent', async () => {
  const machine = createChallengeStateMachine({
    probeSurface: async () => ({
      hasChallengeSurface: false,
      pending: false,
      solved: false,
      hasToken: false,
      hasInteractiveFrame: false,
      target: null,
    }),
  });

  const result = await machine.run({ page: {} });

  assert.equal(result.status, 'not_challenge');
  assert.equal(result.reason, 'challenge_surface_missing');
});
