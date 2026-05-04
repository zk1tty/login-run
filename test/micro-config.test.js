const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createMicroStepConfigService,
  validateMicroStepConfig,
  validateStepActionResult,
} = require('../src/core/workflow/micro-config');

test('validateMicroStepConfig accepts valid config and normalizes steps', () => {
  const config = {
    version: '1.0.0',
    site: 'healthequity',
    workflow: 'login_extract_v1',
    bootstrapUrl: 'https://my.healthequity.com/ClientLogin.aspx',
    macros: {
      cred: {
        steps: ['cred.username.focus', 'cred.username.type'],
      },
    },
    steps: {
      'cred.username.focus': {
        handler: 'focus_field',
      },
      'cred.username.type': {
        handler: 'type_from_payload',
        payloadKey: 'email',
      },
    },
  };

  const summary = validateMicroStepConfig(config);
  assert.equal(summary.version, '1.0.0');
  assert.equal(summary.site, 'healthequity');
  assert.equal(summary.workflow, 'login_extract_v1');
  assert.equal(summary.bootstrapUrl, 'https://my.healthequity.com/ClientLogin.aspx');
  assert.equal(summary.steps['cred.username.type'].handler, 'type_from_payload');
});

test('validateStepActionResult validates ok result shape by handler', () => {
  const validated = validateStepActionResult({
    stepId: 'cred.username.type',
    handler: 'type_from_payload',
    result: {
      status: 'ok',
      typed: true,
      typedLength: 13,
    },
  });

  assert.equal(validated.status, 'ok');
  assert.equal(validated.handler, 'type_from_payload');
});

test('validateStepActionResult rejects invalid handler-specific ok result', () => {
  assert.throws(
    () =>
      validateStepActionResult({
        stepId: 'cred.username.focus',
        handler: 'focus_field',
        result: {
          status: 'ok',
          focused: false,
        },
      }),
    /focused must be true/
  );
});

test('validateStepActionResult enforces blocked and failed result contracts', () => {
  const blocked = validateStepActionResult({
    stepId: 'cred.password.appear',
    handler: 'assert_actionable',
    result: {
      status: 'blocked',
      blockedCode: 'not_rendered',
    },
  });
  assert.equal(blocked.status, 'blocked');

  assert.throws(
    () =>
      validateStepActionResult({
        stepId: 'cred.password.type',
        handler: 'type_from_payload',
        result: {
          status: 'failed',
        },
      }),
    /result.errorCode/
  );
});

test('micro-step config service loads file by site/workflow and returns hash metadata', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'micro-steps-'));
  const configPath = path.resolve(tempDir, 'healthequity.login_extract_v1.json');
  const content = {
    version: '1.1.0',
    site: 'healthequity',
    workflow: 'login_extract_v1',
    bootstrapUrl: 'https://my.healthequity.com/ClientLogin.aspx',
    macros: {
      cred: {
        steps: ['cred.username.focus'],
      },
    },
    steps: {
      'cred.username.focus': {
        handler: 'focus_field',
      },
    },
  };
  fs.writeFileSync(configPath, JSON.stringify(content, null, 2));

  const service = createMicroStepConfigService({
    configRoot: tempDir,
    defaultSite: 'healthequity',
    defaultWorkflow: 'login_extract_v1',
  });

  const loaded = service.load();
  const validation = service.validateStepActionResult({
    stepId: 'cred.username.focus',
    handler: 'focus_field',
    result: {
      status: 'ok',
      focused: true,
    },
  });

  assert.equal(loaded.version, '1.1.0');
  assert.equal(loaded.site, 'healthequity');
  assert.equal(loaded.workflow, 'login_extract_v1');
  assert.equal(loaded.bootstrapUrl, 'https://my.healthequity.com/ClientLogin.aspx');
  assert.equal(loaded.path, configPath);
  assert.equal(typeof loaded.hash, 'string');
  assert.ok(loaded.hash.length > 10);
  assert.equal(validation.status, 'ok');
});
