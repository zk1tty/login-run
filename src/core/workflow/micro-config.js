const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const STEP_ID_PATTERN = /^[a-z0-9]+(?:\.[a-z0-9_]+){2,}$/;
const ALLOWED_HANDLERS = new Set([
  'focus_field',
  'type_from_payload',
  'press_enter',
  'click_field',
  'assert_actionable',
  'toggle_if_present',
  'select_option',
]);
const ACTION_RESULT_STATUSES = new Set(['ok', 'blocked', 'failed']);

function assertPlainObject(value, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  return value;
}

function assertString(value, label) {
  const normalized = String(value || '').trim();
  if (!normalized) {
    throw new Error(`${label} is required.`);
  }
  return normalized;
}

function assertBoolean(value, label) {
  if (typeof value !== 'boolean') {
    throw new Error(`${label} must be boolean.`);
  }
  return value;
}

function assertNonNegativeInteger(value, label) {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0) {
    throw new Error(`${label} must be a non-negative integer.`);
  }
  return parsed;
}

function assertKnownHandler(value, label) {
  const handler = assertString(value, label);
  if (!ALLOWED_HANDLERS.has(handler)) {
    throw new Error(`Unsupported handler "${handler}".`);
  }
  return handler;
}

function validateStepDefinition(stepId, definition) {
  if (!STEP_ID_PATTERN.test(stepId)) {
    throw new Error(`Invalid step_id format: ${stepId}`);
  }
  const step = assertPlainObject(definition, `steps.${stepId}`);
  const handler = assertKnownHandler(step.handler, `${stepId}.handler`);
  return {
    ...step,
    handler,
  };
}

// Minimal config sanity check.
// Detailed validation should happen at action result level via validateStepActionResult.
function validateMicroStepConfig(config) {
  const parsed = assertPlainObject(config, 'Micro-step config');
  const version = assertString(parsed.version, 'version');
  const site = assertString(parsed.site, 'site');
  const workflow = assertString(parsed.workflow, 'workflow');
  const bootstrapUrl = parsed.bootstrapUrl == null
    ? ''
    : assertString(parsed.bootstrapUrl, 'bootstrapUrl');
  const macros = assertPlainObject(parsed.macros, 'macros');
  const stepsRaw = assertPlainObject(parsed.steps, 'steps');

  const steps = {};
  const stepIds = Object.keys(stepsRaw);
  if (!stepIds.length) {
    throw new Error('steps must not be empty.');
  }
  for (const stepId of stepIds) {
    steps[stepId] = validateStepDefinition(stepId, stepsRaw[stepId]);
  }

  for (const [macroName, macroDef] of Object.entries(macros)) {
    assertString(macroName, 'macro name');
    const macro = assertPlainObject(macroDef, `macro ${macroName}`);
    const sequence = Array.isArray(macro.steps) ? macro.steps : [];
    if (!sequence.length) {
      throw new Error(`Macro must define non-empty steps: ${macroName}`);
    }
    const seen = new Set();
    for (const rawStepId of sequence) {
      const stepId = assertString(rawStepId, `${macroName}.steps[]`);
      if (!steps[stepId]) {
        throw new Error(`Macro ${macroName} references unknown step: ${stepId}`);
      }
      if (seen.has(stepId)) {
        throw new Error(`Macro ${macroName} contains duplicate step: ${stepId}`);
      }
      seen.add(stepId);
    }
  }

  return {
    version,
    site,
    workflow,
    bootstrapUrl,
    macros,
    steps,
  };
}

function validateActionResultCommon(input = {}) {
  const payload = assertPlainObject(input, 'Action result payload');
  const stepId = assertString(payload.stepId, 'stepId');
  if (!STEP_ID_PATTERN.test(stepId)) {
    throw new Error(`Invalid stepId format: ${stepId}`);
  }
  const handler = assertKnownHandler(payload.handler, 'handler');
  const result = assertPlainObject(payload.result, 'result');
  const status = assertString(result.status, 'result.status');
  if (!ACTION_RESULT_STATUSES.has(status)) {
    throw new Error(`Unsupported result.status "${status}".`);
  }

  if (status === 'blocked') {
    assertString(result.blockedCode, 'result.blockedCode');
  }
  if (status === 'failed') {
    assertString(result.errorCode, 'result.errorCode');
  }

  return {
    stepId,
    handler,
    result,
    status,
  };
}

function validateActionResultByHandler(common) {
  const { handler, status, result } = common;
  if (status !== 'ok') {
    return;
  }

  switch (handler) {
    case 'focus_field':
      assertBoolean(result.focused, 'result.focused');
      if (result.focused !== true) {
        throw new Error('focus_field result.focused must be true for ok status.');
      }
      return;
    case 'type_from_payload':
      assertBoolean(result.typed, 'result.typed');
      if (result.typed !== true) {
        throw new Error('type_from_payload result.typed must be true for ok status.');
      }
      assertNonNegativeInteger(result.typedLength, 'result.typedLength');
      return;
    case 'press_enter':
      if (String(result.key || '') !== 'Enter') {
        throw new Error('press_enter result.key must be "Enter" for ok status.');
      }
      return;
    case 'click_field':
      assertBoolean(result.clicked, 'result.clicked');
      if (result.clicked !== true) {
        throw new Error('click_field result.clicked must be true for ok status.');
      }
      return;
    case 'assert_actionable':
      assertBoolean(result.actionable, 'result.actionable');
      if (result.actionable !== true) {
        throw new Error('assert_actionable result.actionable must be true for ok status.');
      }
      return;
    case 'toggle_if_present':
      assertBoolean(result.present, 'result.present');
      if (result.present) {
        assertBoolean(result.toggled, 'result.toggled');
      }
      return;
    case 'select_option':
      assertBoolean(result.selected, 'result.selected');
      if (result.selected !== true) {
        throw new Error('select_option result.selected must be true for ok status.');
      }
      assertString(result.selectedValue, 'result.selectedValue');
      return;
    default:
      throw new Error(`No action result validator for handler "${handler}".`);
  }
}

function validateStepActionResult(input = {}) {
  const common = validateActionResultCommon(input);
  validateActionResultByHandler(common);
  return {
    stepId: common.stepId,
    handler: common.handler,
    status: common.status,
    result: common.result,
  };
}

function resolveConfigPath(input = {}) {
  if (input.configPath) {
    return path.resolve(String(input.configPath));
  }

  const site = assertString(input.site, 'site');
  const workflow = assertString(input.workflow, 'workflow');
  const configRoot = path.resolve(
    input.configRoot ||
      process.env.MICRO_STEP_CONFIG_ROOT ||
      path.resolve(process.cwd(), 'config', 'micro-steps')
  );

  return path.resolve(configRoot, `${site}.${workflow}.json`);
}

function createMicroStepConfigService(options = {}) {
  const cache = new Map();
  const configRoot = path.resolve(
    options.configRoot ||
      process.env.MICRO_STEP_CONFIG_ROOT ||
      path.resolve(process.cwd(), 'config', 'micro-steps')
  );

  function load(input = {}) {
    const site = assertString(input.site || options.defaultSite, 'site');
    const workflow = assertString(
      input.workflow || options.defaultWorkflow,
      'workflow'
    );
    const configPath = resolveConfigPath({
      configPath: input.configPath,
      site,
      workflow,
      configRoot,
    });
    const cacheKey = `${site}:${workflow}:${configPath}`;

    if (input.forceReload !== true && cache.has(cacheKey)) {
      return cache.get(cacheKey);
    }

    if (!fs.existsSync(configPath)) {
      throw new Error(`Micro-step config not found: ${configPath}`);
    }

    const raw = fs.readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw);
    const validated = validateMicroStepConfig(parsed);
    const hash = crypto.createHash('sha256').update(raw).digest('hex');

    const loaded = {
      version: validated.version,
      site: validated.site,
      workflow: validated.workflow,
      bootstrapUrl: validated.bootstrapUrl || '',
      hash,
      path: configPath,
      macros: validated.macros,
      steps: validated.steps,
      loadedAt: new Date().toISOString(),
    };

    cache.set(cacheKey, loaded);
    return loaded;
  }

  return {
    load,
    validateStepActionResult,
  };
}

module.exports = {
  ALLOWED_HANDLERS,
  ACTION_RESULT_STATUSES,
  createMicroStepConfigService,
  validateMicroStepConfig,
  validateStepActionResult,
};
