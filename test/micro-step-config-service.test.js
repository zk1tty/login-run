const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const {
  createMicroStepConfigService,
  validateMicroStepConfig,
} = require('../src/core/workflow/micro-config');

test('validateMicroStepConfig accepts valid config shape', () => {
  const config = {
    version: '1.0.0',
    site: 'healthequity',
    workflow: 'login_extract_v1',
    macros: {
      cred: {
        steps: ['cred.username.focus', 'cred.username.type'],
      },
    },
    steps: {
      'cred.username.focus': {
        handler: 'focus_field',
        kind: 'input',
        selectorRef: 'username',
        retryable: true,
        timeoutMs: 3000,
      },
      'cred.username.type': {
        handler: 'type_from_payload',
        kind: 'input',
        selectorRef: 'username',
        payloadKey: 'email',
        retryable: true,
        timeoutMs: 3000,
      },
    },
  };

  const summary = validateMicroStepConfig(config);
  assert.equal(summary.version, '1.0.0');
  assert.equal(summary.site, 'healthequity');
  assert.equal(summary.workflow, 'login_extract_v1');
});

test('validateMicroStepConfig rejects unknown handlers', () => {
  const invalid = {
    version: '1.0.0',
    site: 'healthequity',
    workflow: 'login_extract_v1',
    macros: {
      cred: { steps: ['cred.username.focus'] },
    },
    steps: {
      'cred.username.focus': {
        handler: 'focus_something_else',
        kind: 'input',
        selectorRef: 'username',
        timeoutMs: 3000,
      },
    },
  };

  assert.throws(
    () => validateMicroStepConfig(invalid),
    /Unsupported handler/
  );
});

test('micro-step config service loads file by site/workflow and returns hash metadata', () => {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'micro-steps-'));
  const configPath = path.resolve(tempDir, 'healthequity.login_extract_v1.json');
  const content = {
    version: '1.1.0',
    site: 'healthequity',
    workflow: 'login_extract_v1',
    macros: {
      cred: {
        steps: ['cred.username.focus'],
      },
    },
    steps: {
      'cred.username.focus': {
        handler: 'focus_field',
        kind: 'input',
        selectorRef: 'username',
        timeoutMs: 2000,
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

  assert.equal(loaded.version, '1.1.0');
  assert.equal(loaded.site, 'healthequity');
  assert.equal(loaded.workflow, 'login_extract_v1');
  assert.equal(loaded.path, configPath);
  assert.equal(typeof loaded.hash, 'string');
  assert.ok(loaded.hash.length > 10);
});
