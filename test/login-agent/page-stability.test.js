const assert = require('node:assert/strict');
const test = require('node:test');

const {
  actionSelectors,
  waitForPageActionStability,
} = require('../../src/core/workflow/page-stability');

function createFakePage(snapshots) {
  let index = 0;
  return {
    async evaluate() {
      const snapshot = snapshots[Math.min(index, snapshots.length - 1)];
      index += 1;
      return snapshot;
    },
    async waitForTimeout() {},
  };
}

function stableSnapshot(input = {}) {
  return {
    url: input.url || 'https://example.test/mfa',
    readyState: input.readyState || 'complete',
    mutationCount: input.mutationCount || 0,
    targets: input.targets || [
      { selector: '#emailOption', exists: true },
      { selector: '#sendOtp', exists: true },
    ],
  };
}

test('actionSelectors extracts unique planned action selectors', () => {
  const selectors = actionSelectors({
    optionSelector: '#emailOption',
    submitSelector: '#sendOtp',
    optionCandidate: { selector: '#emailOption' },
  });

  assert.deepEqual(selectors, ['#emailOption', '#sendOtp']);
});

test('waitForPageActionStability returns stable after quiet ready targets', async () => {
  const page = createFakePage([
    stableSnapshot({ mutationCount: 1 }),
    stableSnapshot({ mutationCount: 1 }),
  ]);

  const result = await waitForPageActionStability(
    page,
    {
      optionSelector: '#emailOption',
      submitSelector: '#sendOtp',
    },
    {
      timeoutMs: 100,
      pollMs: 1,
      quietMs: 0,
      minStablePolls: 1,
    }
  );

  assert.equal(result.status, 'stable');
  assert.equal(result.reason, 'ready_targets_quiet');
  assert.equal(result.snapshot.readyState, 'complete');
});

test('waitForPageActionStability times out when target selectors are missing', async () => {
  const page = createFakePage([
    stableSnapshot({
      targets: [
        { selector: '#emailOption', exists: false },
        { selector: '#sendOtp', exists: true },
      ],
    }),
  ]);

  const result = await waitForPageActionStability(
    page,
    {
      optionSelector: '#emailOption',
      submitSelector: '#sendOtp',
    },
    {
      timeoutMs: 5,
      pollMs: 1,
      quietMs: 0,
      minStablePolls: 1,
    }
  );

  assert.equal(result.status, 'timeout');
  assert.equal(result.snapshot.targets[0].exists, false);
});

test('waitForPageActionStability times out while DOM keeps mutating', async () => {
  let count = 0;
  const page = {
    async evaluate() {
      count += 1;
      return stableSnapshot({ mutationCount: count });
    },
    async waitForTimeout() {},
  };

  const result = await waitForPageActionStability(
    page,
    {
      optionSelector: '#emailOption',
      submitSelector: '#sendOtp',
    },
    {
      timeoutMs: 5,
      pollMs: 1,
      quietMs: 0,
      minStablePolls: 1,
    }
  );

  assert.equal(result.status, 'timeout');
  assert.equal(result.snapshot.targets.every(target => target.exists), true);
});
