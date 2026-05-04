const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createScreenshotScheduler,
} = require('../scripts/lib/cdp-screenshot-capture');

test('createScreenshotScheduler captures periodic and transition events with cap', async () => {
  const captured = [];
  const timers = new Map();
  let nextTimerId = 1;

  const scheduler = createScreenshotScheduler({
    enabled: true,
    intervalMs: 2000,
    maxShots: 3,
    captureFn: async payload => {
      captured.push(payload);
      return payload;
    },
    contextProvider: () => ({
      state: 'challenge',
      turnstilePageType: 'waiting',
      transitionKey: 'challenge:waiting',
      at: '10:00:00.000',
    }),
    setIntervalFn: fn => {
      const id = nextTimerId;
      nextTimerId += 1;
      timers.set(id, fn);
      return id;
    },
    clearIntervalFn: id => {
      timers.delete(id);
    },
  });

  scheduler.start();
  assert.equal(timers.size, 1);

  for (const fn of timers.values()) {
    fn();
  }
  scheduler.notifyTransition({
    transitionKey: 'challenge:waiting',
    state: 'challenge',
    turnstilePageType: 'waiting',
    at: '10:00:01.000',
  });
  scheduler.notifyTransition({
    transitionKey: 'challenge:waiting',
    state: 'challenge',
    turnstilePageType: 'waiting',
    at: '10:00:01.100',
  });
  scheduler.notifyTransition({
    transitionKey: 'challenge:checkbox',
    state: 'challenge',
    turnstilePageType: 'checkbox',
    at: '10:00:02.000',
  });
  for (const fn of timers.values()) {
    fn();
  }

  await scheduler.stop();

  assert.equal(captured.length, 3);
  assert.equal(captured[0].reason, 'start');
  assert.equal(captured[1].reason, 'periodic');
  assert.equal(captured[2].reason, 'transition');

  const summary = scheduler.getSummary();
  assert.equal(summary.totalScheduled, 3);
  assert.equal(summary.droppedCount, 2);
});
