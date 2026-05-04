const test = require('node:test');
const assert = require('node:assert/strict');

const { createMicroExecutor } = require('../src/core/workflow/micro-executor');
const { validateStepActionResult } = require('../src/core/workflow/micro-config');

function createNoopPage() {
  return {
    async focus() {},
    async click() {},
    async type() {},
    keyboard: {
      async press() {},
    },
  };
}

test('micro-executor validates assert_actionable handler result', async () => {
  const page = createNoopPage();
  const executor = createMicroExecutor({
    inspectAuthDocument: async () => ({
      phaseHint: 'initial',
      actions: {
        username: {
          found: true,
          action: 'type_and_press_enter',
          selector: '#username',
        },
      },
    }),
    validateStepActionResult,
    now: () => 1710000000000,
  });

  const result = await executor.executeStep({
    page,
    macro: 'cred',
    stepId: 'cred.username.appear',
    stepDef: {
      handler: 'assert_actionable',
      selectorRef: 'username',
    },
    payload: {},
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.result.actionable, true);
  assert.equal(result.telemetry.actionBefore.found, true);
});

test('micro-executor validates failed result for missing payload in type_from_payload', async () => {
  const page = createNoopPage();
  const executor = createMicroExecutor({
    inspectAuthDocument: async () => ({
      phaseHint: 'initial',
      actions: {
        username: {
          found: true,
          action: 'type_and_press_enter',
          selector: '#username',
        },
      },
    }),
    validateStepActionResult,
  });

  const result = await executor.executeStep({
    page,
    macro: 'cred',
    stepId: 'cred.username.type',
    stepDef: {
      handler: 'type_from_payload',
      selectorRef: 'username',
      payloadKey: 'email',
    },
    payload: {},
  });

  assert.equal(result.status, 'failed');
  assert.equal(result.result.errorCode, 'missing_payload_value');
});

test('micro-executor treats transient post-step inspect navigation as non-fatal', async () => {
  const page = createNoopPage();
  let inspectCallCount = 0;
  const executor = createMicroExecutor({
    inspectAuthDocument: async () => {
      inspectCallCount += 1;
      if (inspectCallCount === 1) {
        return {
          phaseHint: 'initial',
          actions: {
            username: {
              found: true,
              action: 'type_and_press_enter',
              selector: '#username',
            },
          },
        };
      }

      throw new Error('Execution context was destroyed, most likely because of a navigation.');
    },
    validateStepActionResult,
  });

  const result = await executor.executeStep({
    page,
    macro: 'cred',
    stepId: 'cred.username.appear',
    stepDef: {
      handler: 'assert_actionable',
      selectorRef: 'username',
    },
    payload: {},
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.telemetry.phaseHintAfter, 'transient_navigation');
  assert.equal(result.telemetry.postInspect.state, 'transient_navigation');
  assert.equal(result.telemetry.postInspect.errorCode, 'execution_context_destroyed');
});
