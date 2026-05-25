const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  buildGmailQuery,
  collectPayloadText,
  decodeBase64Url,
  extractSixDigitCode,
  findLatestOtp,
  inspectRecentOtpMessages,
  normalizeOAuthClientConfig,
  pollGmailOtpToFile,
} = require('../../src/core/otp/gmail-otp-reader');

function encodeBase64Url(value) {
  return Buffer.from(String(value || ''), 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function createFakeGmail(messages = []) {
  return {
    users: {
      messages: {
        async list() {
          return {
            data: {
              messages: messages.map(message => ({ id: message.id })),
            },
          };
        },
        async get(input) {
          const found = messages.find(message => message.id === input.id);
          return {
            data: found || {},
          };
        },
      },
    },
  };
}

test('extractSixDigitCode prefers confirmation-code context', () => {
  assert.equal(extractSixDigitCode('Your confirmation code is 654321.'), '654321');
  assert.equal(extractSixDigitCode('Use 123456 to continue.'), '123456');
});

test('decodeBase64Url and collectPayloadText read text and html MIME parts', () => {
  const plain = 'Your code is 654321';
  const html = '<html><body><p>Backup code 111111</p></body></html>';
  const payload = {
    mimeType: 'multipart/alternative',
    parts: [
      {
        mimeType: 'text/plain',
        body: { data: encodeBase64Url(plain) },
      },
      {
        mimeType: 'text/html',
        body: { data: encodeBase64Url(html) },
      },
    ],
  };

  assert.equal(decodeBase64Url(encodeBase64Url('abc')), 'abc');
  const text = collectPayloadText(payload);
  assert.match(text, /654321/);
  assert.match(text, /Backup code 111111/);
});

test('findLatestOtp returns newest matching fake Gmail message without logging body', async () => {
  const gmail = createFakeGmail([
    {
      id: 'm1',
      internalDate: String(Date.now()),
      payload: {
        headers: [
          { name: 'From', value: 'HealthEquity <no-reply@example.com>' },
          { name: 'Subject', value: 'Your HealthEquity confirmation code' },
        ],
        mimeType: 'text/plain',
        body: {
          data: encodeBase64Url('Your confirmation code is 654321.'),
        },
      },
    },
  ]);

  const result = await findLatestOtp(gmail, {
    query: 'from:healthequity newer_than:10m',
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.code, '654321');
  assert.equal(result.message.from.includes('HealthEquity'), true);
});

test('findLatestOtp ignores messages before minInternalDateMs', async () => {
  const now = Date.now();
  const gmail = createFakeGmail([
    {
      id: 'old',
      internalDate: String(now - 10000),
      payload: {
        headers: [
          { name: 'From', value: 'updates@healthequity.com' },
          { name: 'Subject', value: 'HealthEquity Confirmation Code' },
        ],
        mimeType: 'text/plain',
        body: {
          data: encodeBase64Url('Your confirmation code is 111111.'),
        },
      },
    },
    {
      id: 'new',
      internalDate: String(now),
      payload: {
        headers: [
          { name: 'From', value: 'updates@healthequity.com' },
          { name: 'Subject', value: 'HealthEquity Confirmation Code' },
        ],
        mimeType: 'text/plain',
        body: {
          data: encodeBase64Url('Your confirmation code is 222222.'),
        },
      },
    },
  ]);

  const result = await findLatestOtp(gmail, {
    minInternalDateMs: now - 5000,
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.code, '222222');
  assert.equal(result.message.id, 'new');
});

test('findLatestOtp returns not_found when only older messages match', async () => {
  const now = Date.now();
  const gmail = createFakeGmail([
    {
      id: 'old',
      internalDate: String(now - 10000),
      payload: {
        headers: [
          { name: 'From', value: 'updates@healthequity.com' },
          { name: 'Subject', value: 'HealthEquity Confirmation Code' },
        ],
        mimeType: 'text/plain',
        body: {
          data: encodeBase64Url('Your confirmation code is 111111.'),
        },
      },
    },
  ]);

  const result = await findLatestOtp(gmail, {
    minInternalDateMs: now - 5000,
  });

  assert.equal(result.status, 'not_found');
  assert.equal(result.code, '');
});

test('inspectRecentOtpMessages reports safe message diagnostics without code value', async () => {
  const now = Date.now();
  const gmail = createFakeGmail([
    {
      id: 'm1',
      internalDate: String(now),
      payload: {
        headers: [
          { name: 'From', value: 'updates@healthequity.com' },
          { name: 'Subject', value: 'HealthEquity Confirmation Code' },
        ],
        mimeType: 'text/plain',
        body: {
          data: encodeBase64Url('Your confirmation code is 333333.'),
        },
      },
    },
  ]);

  const messages = await inspectRecentOtpMessages(gmail, {
    minInternalDateMs: now - 5000,
  });

  assert.equal(messages.length, 1);
  assert.equal(messages[0].hasSixDigitCode, true);
  assert.equal(messages[0].codeLength, 6);
  assert.equal(Object.hasOwn(messages[0], 'code'), false);
});

test('pollGmailOtpToFile writes the existing OTP_CODE_FILE contract', async () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'gmail-otp-reader-'));
  const outputFile = path.join(tmpDir, 'he-otp.txt');
  const gmail = createFakeGmail([
    {
      id: 'm1',
      internalDate: String(Date.now()),
      payload: {
        headers: [
          { name: 'From', value: 'HealthEquity <no-reply@example.com>' },
          { name: 'Subject', value: 'Verification' },
        ],
        mimeType: 'text/plain',
        body: {
          data: encodeBase64Url('Code: 123456'),
        },
      },
    },
  ]);

  const result = await pollGmailOtpToFile({
    gmail,
    outputFile,
    waitMs: 0,
    pollMs: 250,
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.wroteFile, true);
  assert.equal(fs.readFileSync(outputFile, 'utf8'), '123456\n');
});

test('normalizeOAuthClientConfig supports Google installed app JSON shape', () => {
  const config = normalizeOAuthClientConfig({
    installed: {
      client_id: 'client-id',
      client_secret: 'client-secret',
      redirect_uris: ['http://localhost'],
    },
  });

  assert.equal(config.clientId, 'client-id');
  assert.equal(config.clientSecret, 'client-secret');
  assert.equal(config.redirectUri, 'http://localhost');
});

test('buildGmailQuery uses configured query or default', () => {
  assert.equal(buildGmailQuery({ query: 'from:test newer_than:1m' }), 'from:test newer_than:1m');
  assert.match(buildGmailQuery(), /newer_than:10m/);
});
