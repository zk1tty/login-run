#!/usr/bin/env node
require('dotenv').config({ quiet: true });

const {
  createOAuthClient,
  inspectRecentOtpMessages,
  pollGmailOtpToFile,
} = require('../../src/core/otp/gmail-otp-reader');

function toInt(value, fallback, minimum = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(minimum, Math.trunc(parsed));
}

async function main() {
  const startedAtMs = Date.now();
  const minInternalDateMs = toInt(
    process.env.GMAIL_OTP_MIN_INTERNAL_DATE_MS,
    startedAtMs - 5000,
    0
  );
  console.error(JSON.stringify({
    status: 'polling',
    query: process.env.GMAIL_OTP_QUERY || 'from:updates@healthequity.com newer_than:10m',
    outputFile:
      process.env.GMAIL_OTP_OUTPUT_FILE ||
      process.env.OTP_CODE_FILE ||
      '/tmp/he-otp.txt',
    waitMs: toInt(process.env.GMAIL_OTP_WAIT_MS || process.env.OTP_WAIT_MS, 300000, 0),
    pollMs: toInt(process.env.GMAIL_OTP_POLL_MS, 5000, 250),
    minInternalDateMs,
  }, null, 2));
  const auth = createOAuthClient({
    clientPath: process.env.GMAIL_OAUTH_CLIENT_PATH || '.auth/gmail-oauth-client.json',
    tokenPath: process.env.GMAIL_OAUTH_TOKEN_PATH || '.auth/gmail-oauth-token.json',
  });
  const query = process.env.GMAIL_OTP_QUERY;
  const maxResults = process.env.GMAIL_OTP_MAX_RESULTS || 10;
  if (String(process.env.GMAIL_OTP_INSPECT || '').trim().toLowerCase() === 'true') {
    const { google } = require('googleapis');
    const gmail = google.gmail({ version: 'v1', auth });
    const messages = await inspectRecentOtpMessages(gmail, {
      query,
      maxResults,
      minInternalDateMs,
    });
    console.log(JSON.stringify({
      status: 'inspected',
      query: query || 'from:updates@healthequity.com newer_than:10m',
      minInternalDateMs,
      messageCount: messages.length,
      messages,
    }, null, 2));
    return;
  }
  const result = await pollGmailOtpToFile({
    auth,
    query,
    outputFile:
      process.env.GMAIL_OTP_OUTPUT_FILE ||
      process.env.OTP_CODE_FILE ||
      '/tmp/he-otp.txt',
    waitMs: process.env.GMAIL_OTP_WAIT_MS || process.env.OTP_WAIT_MS || 300000,
    pollMs: process.env.GMAIL_OTP_POLL_MS || 5000,
    maxResults,
    minInternalDateMs,
  });

  console.log(JSON.stringify({
    status: result.status,
    wroteFile: result.wroteFile,
    outputFile: result.outputFile,
    minInternalDateMs,
    durationMs: result.durationMs || 0,
    codeLength: result.code ? String(result.code).length : 0,
    messageId: result.message?.id || '',
    internalDateMs: result.message?.internalDateMs || 0,
  }, null, 2));
}

if (require.main === module) {
  main().catch(error => {
    const message = String(error?.message || error || 'unknown_error');
    console.error(JSON.stringify({ status: 'error', message }, null, 2));
    process.exit(1);
  });
}

module.exports = {
  main,
};
