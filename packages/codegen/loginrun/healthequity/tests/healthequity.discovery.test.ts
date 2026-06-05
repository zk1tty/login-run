import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const profile = JSON.parse(fs.readFileSync(path.join(root, 'login-site.json'), 'utf8'));
const scores = JSON.parse(fs.readFileSync(path.join(root, 'fixtures', 'landing-candidate-scores.json'), 'utf8'));
const inventory = JSON.parse(fs.readFileSync(path.join(root, 'fixtures', 'landing-runtime-inventory.json'), 'utf8'));

test('HealthEquity mock discovery is ready', () => {
  assert.equal(profile.siteId, 'healthequity');
  assert.equal(profile.loginUrl, 'https://my.healthequity.com/ClientLogin.aspx');
  assert.equal(scores.discovery.status, 'ready');
  assert.equal(scores.discovery.selectedIdentifier.semanticRole, 'identifier');
  assert.ok(scores.discovery.selectedIdentifier.confidence >= 0.9);
  assert.equal(scores.discovery.selectedSubmit.semanticRole, 'primary_submit');
  assert.ok(scores.discovery.selectedSubmit.confidence >= 0.9);
});

test('mock fixtures do not contain credential values', () => {
  const serialized = JSON.stringify({ inventory, scores });
  assert.equal(serialized.includes('LOGIN_PASSWORD_VALUE'), false);
  assert.equal(serialized.includes('OTP_CODE_VALUE'), false);
});
