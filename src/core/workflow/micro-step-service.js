const { createMicroStepConfigService } = require('./micro-config');
const { createMicroExecutor } = require('./micro-executor');
const { inspectAuthDocument } = require('../detection/document-query');

function createMicroStepService(options = {}) {
  const now = options.now || (() => Date.now());
  const microStepConfigSite = String(
    options.microStepConfigSite ||
      process.env.MICRO_STEP_CONFIG_SITE ||
      'healthequity'
  ).trim();
  const microStepConfigWorkflow = String(
    options.microStepConfigWorkflow ||
      process.env.MICRO_STEP_CONFIG_WORKFLOW ||
      'login_extract_v1'
  ).trim();
  const microStepConfigService = createMicroStepConfigService({
    configRoot: options.microStepConfigRoot,
    defaultSite: microStepConfigSite,
    defaultWorkflow: microStepConfigWorkflow,
  });
  let microStepConfig = null;
  let microStepConfigError = '';

  const microExecutor = createMicroExecutor({
    inspectAuthDocument,
    validateStepActionResult: microStepConfigService.validateStepActionResult,
    now,
  });

  const assertCustomerId = options.assertCustomerId;
  const getEntry = options.getEntry;
  const reconcileEntry = options.reconcileEntry;
  const attachOwner = options.attachOwner;
  const toIso = options.toIso;
  const toPublicStatus = options.toPublicStatus;

  function getMicroStepConfigSummary() {
    if (microStepConfig) {
      return {
        site: microStepConfig.site,
        workflow: microStepConfig.workflow,
        version: microStepConfig.version,
        hash: microStepConfig.hash,
        path: microStepConfig.path,
        loadedAt: microStepConfig.loadedAt,
        error: null,
      };
    }

    if (microStepConfigError) {
      return {
        site: microStepConfigSite,
        workflow: microStepConfigWorkflow,
        version: '',
        hash: '',
        path: '',
        loadedAt: null,
        error: microStepConfigError,
      };
    }

    return {
      site: microStepConfigSite,
      workflow: microStepConfigWorkflow,
      version: '',
      hash: '',
      path: '',
      loadedAt: null,
      error: null,
    };
  }

  function ensureMicroStepConfig() {
    if (microStepConfig) {
      return microStepConfig;
    }

    try {
      microStepConfig = microStepConfigService.load({
        site: microStepConfigSite,
        workflow: microStepConfigWorkflow,
      });
      microStepConfigError = '';
      return microStepConfig;
    } catch (error) {
      microStepConfigError = String(error?.message || error);
      const wrapped = new Error(
        `Failed to load micro-step config: ${microStepConfigError}`
      );
      wrapped.statusCode = 500;
      throw wrapped;
    }
  }

  async function executeMicroStep(input = {}) {
    const customerId = assertCustomerId(input.customerId);
    const macro = String(input.macro || '').trim();
    if (!macro) {
      const error = new Error('macro is required.');
      error.statusCode = 400;
      throw error;
    }

    const entry = getEntry(customerId);
    reconcileEntry(entry);

    if (!entry.ownerConnected || !entry.page) {
      await attachOwner({
        customerId,
        allowCreate: input.allowCreate !== false,
        forceAttach: true,
      });
    }

    const config = ensureMicroStepConfig();
    const macroDef = config.macros?.[macro];
    if (!macroDef) {
      const error = new Error(`Unknown macro: ${macro}`);
      error.statusCode = 400;
      throw error;
    }

    const sequence = Array.isArray(macroDef.steps) ? macroDef.steps : [];
    if (!sequence.length) {
      const error = new Error(`Macro has no steps: ${macro}`);
      error.statusCode = 409;
      throw error;
    }

    const currentProgress = entry.actionProgress;
    const shouldReset =
      !currentProgress ||
      currentProgress.macro !== macro ||
      currentProgress.done === true ||
      Number(currentProgress.totalSteps || 0) !== sequence.length;
    let cursor = shouldReset ? 0 : Number(currentProgress.cursor || 0);
    if (!Number.isInteger(cursor) || cursor < 0 || cursor >= sequence.length) {
      cursor = 0;
    }

    const stepId = sequence[cursor];
    const stepDef = config.steps?.[stepId];
    if (!stepDef) {
      const error = new Error(`Step config missing for: ${stepId}`);
      error.statusCode = 500;
      throw error;
    }

    const execution = await microExecutor.executeStep({
      page: entry.page,
      macro,
      stepId,
      stepDef,
      payload: input.payload || {},
    });

    const nextCursor = execution.status === 'ok' ? cursor + 1 : cursor;
    const done = nextCursor >= sequence.length;
    const nextStepId = done ? '' : sequence[nextCursor];
    const nowIso = toIso(now());

    const executionPayload = {
      macro,
      orderIndex: cursor,
      stepId,
      handler: execution.handler,
      status: execution.status,
      result: execution.result,
      nextStepId,
      done,
      startedAt: execution.startedAt || nowIso,
      finishedAt: execution.finishedAt || nowIso,
      telemetry: execution.telemetry || {},
    };

    entry.actionProgress = {
      macro,
      cursor: nextCursor,
      totalSteps: sequence.length,
      nextStepId,
      done,
      configVersion: config.version,
      configHash: config.hash,
      updatedAt: nowIso,
    };
    entry.lastAction = executionPayload;
    entry.actionCheckpoints = [
      ...entry.actionCheckpoints,
      {
        at: nowIso,
        macro,
        cursorBefore: cursor,
        cursorAfter: nextCursor,
        totalSteps: sequence.length,
        stepId,
        status: execution.status,
        result: execution.result,
        nextStepId,
        done,
      },
    ].slice(-50);
    entry.lastError =
      execution.status === 'failed'
        ? String(
            execution.result?.errorCode ||
              execution.result?.message ||
              'step_execution_failed'
          )
        : '';
    entry.status = entry.liveURL ? 'ready' : 'owner_attached';
    entry.updatedAtMs = now();

    return {
      execution: executionPayload,
      status: toPublicStatus(entry),
    };
  }

  async function resetMicroStepProgress(input = {}) {
    const customerId = assertCustomerId(input.customerId);
    const macro = String(input.macro || '').trim();
    if (!macro) {
      const error = new Error('macro is required.');
      error.statusCode = 400;
      throw error;
    }

    const config = ensureMicroStepConfig();
    const macroDef = config.macros?.[macro];
    if (!macroDef) {
      const error = new Error(`Unknown macro: ${macro}`);
      error.statusCode = 400;
      throw error;
    }

    const sequence = Array.isArray(macroDef.steps) ? macroDef.steps : [];
    if (!sequence.length) {
      const error = new Error(`Macro has no steps: ${macro}`);
      error.statusCode = 409;
      throw error;
    }

    const entry = getEntry(customerId);
    reconcileEntry(entry);

    entry.actionProgress = {
      macro,
      cursor: 0,
      totalSteps: sequence.length,
      nextStepId: sequence[0] || '',
      done: false,
      configVersion: config.version,
      configHash: config.hash,
      updatedAt: toIso(now()),
    };
    entry.lastAction = null;
    entry.actionCheckpoints = [];
    entry.lastError = '';
    entry.updatedAtMs = now();

    return {
      reset: {
        macro,
        cursor: 0,
        totalSteps: sequence.length,
        nextStepId: sequence[0],
        cleared: {
          lastAction: true,
          actionCheckpoints: true,
        },
      },
      status: toPublicStatus(entry),
    };
  }

  return {
    getMicroStepConfigSummary,
    executeMicroStep,
    resetMicroStepProgress,
  };
}

module.exports = {
  createMicroStepService,
};
