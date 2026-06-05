const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  main,
  parseArgs,
} = require('../../packages/codegen/src/cli');

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'loginrun-codegen-'));
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

test('parseArgs defaults demo output and site', () => {
  assert.deepEqual(parseArgs(['demo']), {
    command: 'demo',
    site: 'healthequity',
    out: './loginrun',
    help: false,
  });
});

test('demo command writes HealthEquity mock artifacts to ./loginrun by default', async () => {
  const cwd = tmpDir();
  const output = [];
  const result = await main(['demo'], {
    cwd,
    stdout: line => output.push(line),
  });

  const siteDir = path.join(cwd, 'loginrun', 'healthequity');
  assert.equal(result.status, 'ready');
  assert.equal(result.outputDir, siteDir);
  assert.equal(fs.existsSync(path.join(siteDir, 'login-site.json')), true);
  assert.equal(fs.existsSync(path.join(siteDir, 'report.md')), true);
  assert.equal(fs.existsSync(path.join(siteDir, 'README.md')), true);
  assert.equal(fs.existsSync(path.join(siteDir, 'fixtures', 'landing-runtime-inventory.json')), true);
  assert.equal(fs.existsSync(path.join(siteDir, 'fixtures', 'landing-candidate-scores.json')), true);
  assert.equal(fs.existsSync(path.join(siteDir, 'tests', 'healthequity.discovery.test.ts')), true);

  const profile = readJson(path.join(siteDir, 'login-site.json'));
  const scores = readJson(path.join(siteDir, 'fixtures', 'landing-candidate-scores.json'));
  assert.equal(profile.siteId, 'healthequity');
  assert.equal(profile.credentials.passwordSecretKey, 'LOGIN_PASSWORD');
  assert.equal(scores.discovery.status, 'ready');
  assert.match(output.join('\n'), /LoginRun Codegen demo complete/);
  assert.match(output.join('\n'), /\.\/loginrun\/healthequity\/login-site\.json/);
});

test('demo command supports custom output directory', async () => {
  const cwd = tmpDir();
  const output = [];
  await main(['demo', '--out', './out'], {
    cwd,
    stdout: line => output.push(line),
  });

  const siteDir = path.join(cwd, 'out', 'healthequity');
  assert.equal(fs.existsSync(path.join(siteDir, 'login-site.json')), true);
  assert.match(output.join('\n'), /\.\/out\/healthequity\/report\.md/);
});

test('demo command rejects unsupported sites', async () => {
  const cwd = tmpDir();
  await assert.rejects(
    () => main(['demo', '--site', 'example-bank'], {
      cwd,
      stdout: () => {},
    }),
    /Unsupported site: example-bank/
  );
});
