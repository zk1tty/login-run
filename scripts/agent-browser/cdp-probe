#!/usr/bin/env node
require('dotenv').config({ quiet: true });

const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const {
  getBrowserlessTargetRuntimeInfo,
  getCdpEndpoint,
} = require('../lib/helpers');

const DEFAULT_URL = 'https://example.com';
const DEFAULT_SESSION = 'loginrun-agent-browser-cdp-probe';
const DEFAULT_OUT_ROOT = './.log/agent-browser-cdp-probe';
const DEFAULT_SCREENSHOT_COUNT = 3;
const DEFAULT_SCREENSHOT_INTERVAL_MS = 3000;
const AGENT_BROWSER_BIN = process.env.AGENT_BROWSER_BIN || 'agent-browser';

function usage() {
  return `Usage: node scripts/agent-browser/cdp-probe [options]

Resolve a Browserless CDP endpoint with the same LoginRun target config used by
current Puppeteer probes, then verify agent-browser can connect and operate.

Options:
  --url <url>              URL to open after connecting (default: ${DEFAULT_URL})
  --session <name>         agent-browser session name (default: ${DEFAULT_SESSION})
  --out <dir>              Output directory (default: ${DEFAULT_OUT_ROOT}/session-turnstile-YYYYMMDDTHHMMSS)
  --mode <direct|session>  Endpoint mode (default: direct)
  --solve <auto|manual|none>
                           CAPTCHA solve mode for endpoint params (default: auto for direct, manual for session)
  --timeout <ms>           Browserless connect timeout override
  --screenshot-count <n>   Number of screenshots after open/snapshot (default: ${DEFAULT_SCREENSHOT_COUNT})
  --screenshot-interval-ms <n>
                           Delay between repeated screenshots (default: ${DEFAULT_SCREENSHOT_INTERVAL_MS})
  --no-open                Connect only; skip open/snapshot/screenshot
  --no-close               In session mode, create a Browserless checkpoint without attaching
                           agent-browser. In direct mode, leave agent-browser open at the end.
  --reconnect [path|dir]   Reconnect agent-browser using checkpoint.private.json (default: latest)
  --checkpoint <path|dir>  Checkpoint file or run directory for --reconnect
  --help                   Show this help

Environment:
  BL_PROXY                 Selects config/browserless-targets.json profile
  BROWSERLESS_TOKEN        Browserless token
  AGENT_BROWSER_BIN        agent-browser executable or wrapper (default: agent-browser)
  LOGINRUN_AGENT_BROWSER_CHECKPOINT
                           Default checkpoint for --reconnect
  BROWSERLESS_*            Browserless target settings applied by scripts/lib/helpers.js
  SESSION_API_*            Session API settings for --mode session
`;
}

function parseArgs(argv) {
  const options = {
    url: process.env.URL || DEFAULT_URL,
    session: process.env.AGENT_BROWSER_SESSION || DEFAULT_SESSION,
    out: '',
    mode: process.env.LOGINRUN_AGENT_BROWSER_CDP_MODE || 'direct',
    solve: process.env.LOGINRUN_AGENT_BROWSER_SOLVE_MODE || '',
    timeout: process.env.LOGINRUN_AGENT_BROWSER_CDP_TIMEOUT || '',
    screenshotCount: process.env.LOGINRUN_AGENT_BROWSER_SCREENSHOT_COUNT || DEFAULT_SCREENSHOT_COUNT,
    screenshotIntervalMs: process.env.LOGINRUN_AGENT_BROWSER_SCREENSHOT_INTERVAL_MS || DEFAULT_SCREENSHOT_INTERVAL_MS,
    reconnect: false,
    checkpoint: process.env.LOGINRUN_AGENT_BROWSER_CHECKPOINT || '',
    urlProvided: Boolean(process.env.URL),
    open: true,
    close: true,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      console.log(usage());
      process.exit(0);
    }
    if (arg === '--no-open') {
      options.open = false;
      continue;
    }
    if (arg === '--no-close') {
      options.close = false;
      continue;
    }
    if (arg === '--reconnect') {
      options.reconnect = true;
      const value = argv[i + 1];
      if (value && !value.startsWith('--')) {
        options.checkpoint = value;
        i += 1;
      }
      continue;
    }
    if (['--url', '--session', '--out', '--mode', '--solve', '--timeout', '--screenshot-count', '--screenshot-interval-ms', '--checkpoint'].includes(arg)) {
      const value = argv[i + 1];
      if (!value) {
        throw new Error(`${arg} requires a value.`);
      }
      const key = arg
        .slice(2)
        .replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
      options[key] = value;
      if (key === 'url') {
        options.urlProvided = true;
      }
      i += 1;
      continue;
    }
    throw new Error(`Unknown option: ${arg}`);
  }

  options.mode = String(options.mode || 'direct').trim().toLowerCase();
  if (!['direct', 'session'].includes(options.mode)) {
    throw new Error('--mode must be direct or session.');
  }

  if (!options.solve) {
    options.solve = options.mode === 'direct' ? 'auto' : 'manual';
  }
  options.solve = String(options.solve).trim().toLowerCase();
  if (!['auto', 'manual', 'none'].includes(options.solve)) {
    throw new Error('--solve must be auto, manual, or none.');
  }

  if (!options.out) {
    options.out = path.resolve(DEFAULT_OUT_ROOT, `session-turnstile-${timestampForPath()}`);
  } else {
    options.out = path.resolve(options.out);
  }

  options.screenshotCount = toInt(options.screenshotCount, DEFAULT_SCREENSHOT_COUNT, 0);
  options.screenshotIntervalMs = toInt(
    options.screenshotIntervalMs,
    DEFAULT_SCREENSHOT_INTERVAL_MS,
    0
  );

  return options;
}

function timestampForPath(date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    'T',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds()),
  ].join('');
}

function redactUrl(value) {
  try {
    const url = new URL(String(value || ''));
    for (const key of ['token', 'apiKey', 'apikey', 'key']) {
      if (url.searchParams.has(key)) {
        url.searchParams.set(key, '[redacted]');
      }
    }
    return url
      .toString()
      .replace(/\/session\/connect\/[^/?#]+/i, '/session/connect/[redacted]')
      .replace(/\/e\/[^/]+/i, '/e/[redacted]');
  } catch {
    return String(value || '')
      .replace(/([?&](?:token|apiKey|apikey|key)=)[^&]+/gi, '$1[redacted]')
      .replace(/\/session\/connect\/[^/?#]+/i, '/session/connect/[redacted]')
      .replace(/\/e\/[^/]+/i, '/e/[redacted]');
  }
}

function appendEndpointParams(endpoint, params) {
  const url = new URL(endpoint);
  for (const [key, value] of Object.entries(params)) {
    if (value == null || value === '') {
      continue;
    }
    url.searchParams.set(key, String(value));
  }
  return url.toString();
}

function toBool(value, fallback = false) {
  if (value == null || value === '') {
    return fallback;
  }
  return ['1', 'true', 'yes', 'on'].includes(String(value).trim().toLowerCase());
}

function toInt(value, fallback, minimum = 0) {
  if (value == null || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(minimum, Math.trunc(parsed));
}

function getBrowserlessTimeoutParam() {
  const timeoutSecondsRaw = process.env.BROWSERLESS_TIMEOUT_SECONDS;
  const timeoutMsRaw = process.env.BROWSERLESS_TIMEOUT_MS;
  if (timeoutSecondsRaw != null && timeoutSecondsRaw !== '') {
    const parsed = Math.trunc(Number(timeoutSecondsRaw));
    return Number.isFinite(parsed) && parsed > 0 ? String(parsed) : '';
  }
  if (timeoutMsRaw == null || timeoutMsRaw === '') {
    return '';
  }
  const parsed = Number(timeoutMsRaw);
  return Number.isFinite(parsed) && parsed > 0 ? String(Math.trunc(parsed)) : '';
}

function buildSessionApiUrl() {
  const base = process.env.BROWSERLESS_HTTP_BASE || 'http://127.0.0.1:3000';
  const token = String(process.env.BROWSERLESS_TOKEN || '').trim();
  const url = new URL(base);
  url.pathname = `${url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '')}/session`;
  if (token) {
    url.searchParams.set('token', token);
  }
  return url.toString();
}

function buildSessionPayload() {
  const rawPayload = String(process.env.SESSION_API_PAYLOAD_JSON || '').trim();
  if (rawPayload) {
    return JSON.parse(rawPayload);
  }

  const payload = {
    ttl: toInt(process.env.SESSION_API_TTL_MS, 180000, 1000),
    stealth: toBool(process.env.SESSION_API_STEALTH, true),
  };

  const processKeepAlive = toInt(process.env.SESSION_API_PROCESS_KEEP_ALIVE_MS, 0, 0);
  if (processKeepAlive > 0) {
    payload.processKeepAlive = processKeepAlive;
  }

  const browser = String(process.env.SESSION_API_BROWSER || '').trim();
  if (browser) {
    payload.browser = browser;
  }

  const proxy = String(process.env.BROWSERLESS_PROXY || '').trim();
  if (proxy) {
    payload.proxy = { type: proxy };
    const country = String(process.env.BROWSERLESS_PROXY_COUNTRY || '').trim();
    const city = String(process.env.BROWSERLESS_PROXY_CITY || '').trim();
    const preset = String(process.env.BROWSERLESS_PROXY_PRESET || '').trim();
    const sticky = process.env.BROWSERLESS_PROXY_STICKY;
    if (country) payload.proxy.country = country;
    if (city) payload.proxy.city = city;
    if (preset) payload.proxy.preset = preset;
    if (sticky != null && sticky !== '') payload.proxy.sticky = toBool(sticky, false);
  }

  return payload;
}

async function resolveSessionEndpoint(options) {
  const sessionApiUrl = buildSessionApiUrl();
  const payload = buildSessionPayload();
  const response = await fetch(sessionApiUrl, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });
  const raw = await response.text();
  let parsed = null;
  try {
    parsed = raw ? JSON.parse(raw) : null;
  } catch {
    parsed = null;
  }
  if (!response.ok) {
    throw new Error(`Session API create failed: HTTP ${response.status} ${raw}`);
  }

  const session = parsed && typeof parsed === 'object' && parsed.session
    ? parsed.session
    : parsed;
  const connect = String(
    session?.connect ||
    session?.connectUrl ||
    session?.connectURL ||
    session?.browserWSEndpoint ||
    session?.wsEndpoint ||
    ''
  ).trim();
  const stop = String(session?.stop || session?.stopUrl || session?.stopURL || session?.killURL || '').trim();
  if (!connect) {
    throw new Error(`Session API response did not include a connect URL: ${raw}`);
  }

  const timeout = options.timeout || getBrowserlessTimeoutParam();
  const endpoint = appendEndpointParams(connect, {
    timeout,
    solveCaptchas: options.solve === 'auto' ? 'true' : '',
  });

  return {
    endpoint,
    sessionApiUrl,
    sessionPayload: payload,
    session: {
      id: String(session?.id || session?.sessionId || '').trim(),
      connect,
      stop,
      ttlMs: toInt(session?.ttl || session?.ttlMs, payload.ttl || 0, 0),
      processKeepAliveMs: toInt(session?.processKeepAlive || session?.processKeepAliveMs, payload.processKeepAlive || 0, 0),
    },
    rawResponse: parsed,
  };
}

async function resolveDirectEndpoint(options) {
  const endpoint = getCdpEndpoint();
  const params = {};
  if (options.timeout) {
    params.timeout = options.timeout;
  }
  if (options.solve === 'auto') {
    params.solveCaptchas = 'true';
  } else if (options.solve === 'none') {
    params.solveCaptchas = 'false';
  }
  return {
    endpoint: appendEndpointParams(endpoint, params),
  };
}

function writeJson(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`);
}

function writePrivateJson(filePath, value) {
  writeJson(filePath, value);
  fs.chmodSync(filePath, 0o600);
}

function sleep(ms) {
  if (ms <= 0) {
    return Promise.resolve();
  }
  return new Promise(resolve => setTimeout(resolve, ms));
}

function redactCommandArg(value) {
  const raw = String(value || '');
  if (/^(wss?|https?):\/\//i.test(raw)) {
    return redactUrl(raw);
  }
  return raw;
}

function runAgentBrowser(outDir, label, args, options = {}) {
  const startedAt = Date.now();
  const result = spawnSync(AGENT_BROWSER_BIN, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const endedAt = Date.now();
  const record = {
    label,
    command: [AGENT_BROWSER_BIN, ...args.map(redactCommandArg)],
    status: result.status,
    signal: result.signal || '',
    durationMs: endedAt - startedAt,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
  };

  fs.appendFileSync(path.join(outDir, 'commands.jsonl'), `${JSON.stringify(record)}\n`);

  if (options.stdoutPath) {
    fs.writeFileSync(options.stdoutPath, record.stdout);
  }
  if (options.stderrPath) {
    fs.writeFileSync(options.stderrPath, record.stderr);
  }

  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${label} failed with status ${result.status}: ${record.stderr || record.stdout}`);
  }
  return record;
}

async function captureScreenshots(outDir, options) {
  const captures = [];
  const count = options.screenshotCount;
  if (count <= 0) {
    return captures;
  }

  const screenshotsDir = path.join(outDir, 'screenshots');
  fs.mkdirSync(screenshotsDir, { recursive: true });

  for (let index = 0; index < count; index += 1) {
    if (index > 0) {
      await sleep(options.screenshotIntervalMs);
    }

    const filename = `screenshot-${String(index + 1).padStart(2, '0')}.png`;
    const screenshotPath = path.join(screenshotsDir, filename);
    const record = runAgentBrowser(outDir, `screenshot page ${index + 1}`, [
      '--session', options.session,
      'screenshot',
      screenshotPath,
    ]);
    captures.push({
      index: index + 1,
      path: screenshotPath,
      durationMs: record.durationMs,
    });
  }

  fs.copyFileSync(captures[captures.length - 1].path, path.join(outDir, 'screenshot.png'));
  writeJson(path.join(outDir, 'screenshots.json'), captures);
  return captures;
}

async function stopSession(stopUrl) {
  if (!stopUrl) {
    return null;
  }
  const url = appendEndpointParams(stopUrl, { force: 'true' });
  const response = await fetch(url, { method: 'DELETE' });
  const text = await response.text().catch(() => '');
  return {
    status: response.status,
    ok: response.ok,
    body: text,
  };
}

function resolveCheckpointPath(checkpoint) {
  const requested = String(checkpoint || '').trim();
  if (!requested || requested === 'latest') {
    return findLatestCheckpointPath();
  }

  const candidate = path.resolve(requested);
  if (fs.existsSync(candidate) && fs.statSync(candidate).isDirectory()) {
    return path.join(candidate, 'checkpoint.private.json');
  }
  return candidate;
}

function findLatestCheckpointPath() {
  const root = path.resolve(DEFAULT_OUT_ROOT);
  if (!fs.existsSync(root)) {
    throw new Error(`No checkpoint root found at ${root}`);
  }

  const candidates = fs.readdirSync(root, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => path.join(root, entry.name, 'checkpoint.private.json'))
    .filter(file => fs.existsSync(file))
    .map(file => ({ file, mtimeMs: fs.statSync(file).mtimeMs }))
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  if (candidates.length === 0) {
    throw new Error(`No checkpoint.private.json files found under ${root}`);
  }
  return candidates[0].file;
}

function readCheckpoint(checkpointPath) {
  if (!fs.existsSync(checkpointPath)) {
    throw new Error(`Checkpoint not found: ${checkpointPath}`);
  }
  return JSON.parse(fs.readFileSync(checkpointPath, 'utf8'));
}

async function reconnectFromCheckpoint(options) {
  fs.mkdirSync(options.out, { recursive: true });

  const checkpointPath = resolveCheckpointPath(options.checkpoint);
  const checkpoint = readCheckpoint(checkpointPath);
  const endpoint = String(
    checkpoint?.browserless?.endpoint ||
    checkpoint?.browserless?.session?.connect ||
    ''
  ).trim();
  if (!endpoint) {
    throw new Error(`Checkpoint does not include browserless.endpoint: ${checkpointPath}`);
  }

  const url = options.urlProvided
    ? options.url
    : String(checkpoint?.agentBrowser?.url || options.url);

  const summary = {
    checkedAt: new Date().toISOString(),
    mode: 'reconnect',
    solveMode: checkpoint.solveMode || '',
    sourceCheckpoint: checkpointPath,
    target: checkpoint.target || {},
    agentBrowser: {
      session: options.session,
      url,
    },
    browserless: {
      endpoint: redactUrl(endpoint),
      session: checkpoint?.browserless?.session ? {
        ...checkpoint.browserless.session,
        connect: redactUrl(checkpoint.browserless.session.connect),
        stop: redactUrl(checkpoint.browserless.session.stop),
      } : null,
    },
    artifacts: {
      outDir: options.out,
      commands: path.join(options.out, 'commands.jsonl'),
      snapshot: path.join(options.out, 'snapshot.txt'),
      screenshot: path.join(options.out, 'screenshot.png'),
      screenshots: path.join(options.out, 'screenshots'),
      privateCheckpoint: checkpointPath,
    },
    execution: {
      reconnect: true,
      checkpointOnly: false,
    },
  };

  writeJson(path.join(options.out, 'probe-summary.json'), summary);
  console.log(JSON.stringify(summary, null, 2));

  try {
    runAgentBrowser(options.out, 'close previous agent-browser session', ['--session', options.session, 'close']);
  } catch (error) {
    fs.appendFileSync(
      path.join(options.out, 'commands.jsonl'),
      `${JSON.stringify({ label: 'close previous agent-browser session ignored', error: String(error?.message || error) })}\n`
    );
  }

  runAgentBrowser(options.out, 'connect checkpoint Browserless CDP endpoint', [
    '--session', options.session,
    'connect',
    endpoint,
  ]);

  if (options.open) {
    runAgentBrowser(options.out, 'open target URL', [
      '--session', options.session,
      'open',
      url,
    ]);
    runAgentBrowser(options.out, 'snapshot interactive elements', [
      '--session', options.session,
      'snapshot',
      '-i',
    ], {
      stdoutPath: path.join(options.out, 'snapshot.txt'),
    });
    await captureScreenshots(options.out, options);
  }

  if (options.close) {
    runAgentBrowser(options.out, 'close agent-browser session', ['--session', options.session, 'close']);
  }
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.reconnect) {
    await reconnectFromCheckpoint(options);
    return;
  }
  fs.mkdirSync(options.out, { recursive: true });

  const targetInfo = getBrowserlessTargetRuntimeInfo();
  const resolved = options.mode === 'session'
    ? await resolveSessionEndpoint(options)
    : await resolveDirectEndpoint(options);

  const summary = {
    checkedAt: new Date().toISOString(),
    mode: options.mode,
    solveMode: options.solve,
    target: {
      selected: targetInfo.selectedTarget || targetInfo.selectedProxy || '',
      applied: targetInfo.applied,
      sourcePath: targetInfo.sourcePath,
      appliedValues: targetInfo.appliedValues || {},
    },
    agentBrowser: {
      session: options.session,
      url: options.url,
    },
    browserless: {
      endpoint: redactUrl(resolved.endpoint),
      sessionApiUrl: resolved.sessionApiUrl ? redactUrl(resolved.sessionApiUrl) : '',
      session: resolved.session ? {
        ...resolved.session,
        connect: redactUrl(resolved.session.connect),
        stop: redactUrl(resolved.session.stop),
      } : null,
      sessionPayload: resolved.sessionPayload || null,
    },
    artifacts: {
      outDir: options.out,
      commands: path.join(options.out, 'commands.jsonl'),
      snapshot: path.join(options.out, 'snapshot.txt'),
      screenshot: path.join(options.out, 'screenshot.png'),
      screenshots: path.join(options.out, 'screenshots'),
      privateCheckpoint: resolved.session ? path.join(options.out, 'checkpoint.private.json') : '',
    },
    execution: {
      checkpointOnly: options.mode === 'session' && !options.close,
    },
  };

  if (resolved.session) {
    writePrivateJson(path.join(options.out, 'checkpoint.private.json'), {
      checkedAt: summary.checkedAt,
      mode: options.mode,
      solveMode: options.solve,
      target: summary.target,
      agentBrowser: summary.agentBrowser,
      browserless: {
        endpoint: resolved.endpoint,
        sessionApiUrl: resolved.sessionApiUrl || '',
        session: resolved.session,
        sessionPayload: resolved.sessionPayload || null,
      },
      reconnect: {
        command: [
          'agent-browser',
          '--session',
          '<session-name>',
          'connect',
          '<browserless.session.connect>',
        ],
        note: 'Use browserless.endpoint for the exact endpoint used by this probe, or browserless.session.connect if you want the raw Browserless connect URL without the probe-added timeout parameter.',
      },
    });
  }

  writeJson(path.join(options.out, 'probe-summary.json'), summary);
  console.log(JSON.stringify(summary, null, 2));

  if (summary.execution.checkpointOnly) {
    fs.appendFileSync(
      path.join(options.out, 'commands.jsonl'),
      `${JSON.stringify({
        label: 'checkpoint only',
        command: [],
        status: 0,
        durationMs: 0,
        stdout: 'Created Browserless session checkpoint without attaching agent-browser.',
        stderr: '',
      })}\n`
    );
    return;
  }

  try {
    runAgentBrowser(options.out, 'close previous agent-browser session', ['--session', options.session, 'close']);
  } catch (error) {
    fs.appendFileSync(
      path.join(options.out, 'commands.jsonl'),
      `${JSON.stringify({ label: 'close previous agent-browser session ignored', error: String(error?.message || error) })}\n`
    );
  }

  runAgentBrowser(options.out, 'connect resolved Browserless CDP endpoint', [
    '--session', options.session,
    'connect',
    resolved.endpoint,
  ]);

  if (options.open) {
    runAgentBrowser(options.out, 'open target URL', [
      '--session', options.session,
      'open',
      options.url,
    ]);
    runAgentBrowser(options.out, 'snapshot interactive elements', [
      '--session', options.session,
      'snapshot',
      '-i',
    ], {
      stdoutPath: path.join(options.out, 'snapshot.txt'),
    });
    await captureScreenshots(options.out, options);
  }

  if (options.close) {
    runAgentBrowser(options.out, 'close agent-browser session', ['--session', options.session, 'close']);
    if (resolved.session?.stop) {
      const stopped = await stopSession(resolved.session.stop).catch(error => ({
        ok: false,
        error: String(error?.message || error),
      }));
      writeJson(path.join(options.out, 'session-stop.json'), stopped);
    }
  }
}

if (require.main === module) {
  main().catch(error => {
    const message = String(error?.message || error || 'unknown_error');
    console.error(JSON.stringify({ status: 'error', message }, null, 2));
    process.exit(1);
  });
}
