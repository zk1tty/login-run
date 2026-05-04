#!/usr/bin/env node
require('dotenv').config({ quiet: true });

const path = require('path');
const {
  DEFAULT_WS_CHECK_LIVE_URL_TIMEOUT_MS,
  DEFAULT_WS_MAX_MESSAGES,
  DEFAULT_WS_SCREENSHOT_INTERVAL_MS,
  DEFAULT_WS_SCREENSHOT_MAX,
  DEFAULT_WS_TRACE_MS,
  runWsTrace,
} = require('../../../lib/ws-trace-runner');

function toSafeError(error) {
  return String(error?.message || error || 'unknown_error');
}

function parseBoolean(value, fallback) {
  if (value == null || value === '') {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function parseNumber(value, fallback, minimum = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(minimum, Math.trunc(parsed));
}

async function main() {
  const base = String(process.env.BASE || process.env.OWNER_API_BASE || 'http://127.0.0.1:8787').trim();
  const customerId = String(process.env.CID || process.env.CUSTOMER_ID || 'danny').trim();
  const targetUrl = String(process.env.URL || '').trim();
  const logsRoot = path.resolve(process.env.RUN_LOGS_ROOT || '.log');
  const forceNewSession = parseBoolean(process.env.FORCE_NEW_SESSION, false);
  const refreshLiveUrl = parseBoolean(process.env.REFRESH_LIVE_URL, true);
  const requestedLiveTimeoutMs = parseNumber(
    process.env.WS_CHECK_LIVE_URL_TIMEOUT_MS,
    DEFAULT_WS_CHECK_LIVE_URL_TIMEOUT_MS,
    1000
  );
  const traceDurationMs = parseNumber(process.env.WS_TRACE_MS, DEFAULT_WS_TRACE_MS, 500);
  const maxMessages = parseNumber(process.env.WS_MAX_MESSAGES, DEFAULT_WS_MAX_MESSAGES, 20);
  const screenshotEnabled = parseBoolean(process.env.WS_SCREENSHOT_ENABLED, true);
  const screenshotIntervalMs = parseNumber(
    process.env.WS_SCREENSHOT_INTERVAL_MS,
    DEFAULT_WS_SCREENSHOT_INTERVAL_MS,
    250
  );
  const screenshotMax = parseNumber(process.env.WS_SCREENSHOT_MAX, DEFAULT_WS_SCREENSHOT_MAX, 1);
  const adminApiKey = String(process.env.ADMIN_API_KEY || '').trim();

  const result = await runWsTrace({
    base,
    customerId,
    logsRoot,
    targetUrl,
    forceNewSession,
    refreshLiveUrl,
    attachMode: 'auto',
    requestedLiveTimeoutMs,
    traceDurationMs,
    maxMessages,
    screenshotEnabled,
    screenshotIntervalMs,
    screenshotMax,
    adminApiKey,
  });

  console.log(`Refreshed LiveURL: ${result.refresh?.liveURL || result.after?.liveURL || ''}`);
  console.log(`Open Before (Approx): ${result.output.liveUrlExpiresAt || 'unknown'}`);
  console.log(
    `Live Page State: ${result.pageStateFromLive?.state || 'unknown'} ` +
    `(${result.pageStateFromLive?.source || 'n/a'})`
  );
  if (result.pageStateFromLive?.transitionMetrics) {
    console.log(
      `Transitions: waiting->checkbox=${result.pageStateFromLive.transitionMetrics.waitingToCheckboxMs ?? 'n/a'}ms ` +
      `waiting->login=${result.pageStateFromLive.transitionMetrics.waitingToLoginMs ?? 'n/a'}ms`
    );
  }
  console.log(`Screenshots: ${result.output.screenshotCount || 0}`);
  console.log(`Message Log File: ${result.output.messageFile}`);
  console.log(`Screenshot Index: ${result.output.screenshotIndexFile}`);

  console.log(JSON.stringify(result, null, 2));
}

main().catch(error => {
  console.error(
    JSON.stringify(
      {
        status: 'error',
        message: toSafeError(error),
      },
      null,
      2
    )
  );
  process.exit(1);
});
