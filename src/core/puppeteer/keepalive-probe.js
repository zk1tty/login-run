const fs = require('fs');
const path = require('path');

const { toTimestampTag } = require('../utils/time');
const {
  inspectRuntimeInventory,
  classifyRuntimeStage,
} = require('../workflow/runtime-inventory');
const { planRuntimeAction } = require('../workflow/action-planner');
const { executeRuntimeAction } = require('../workflow/action-executor');
const {
  BrowserlessSession,
  normalizeSessionPayload,
  redactUrlSecretParams,
} = require('../browserless/browserless-session');
const { PuppeteerSessionRuntime } = require('./session-runtime');
const { adaptPuppeteerPage } = require('./page-adapter');

function toInt(value, fallback, minimum = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(minimum, Math.trunc(parsed));
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function appendJsonLine(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
}

async function waitForOtpCode(input = {}) {
  const filePath = String(input.filePath || '').trim();
  const waitMs = toInt(input.waitMs, 0, 0);
  const pollMs = toInt(input.pollMs, 1000, 250);
  const minMtimeMs = toInt(input.minMtimeMs, 0, 0);
  const previousCodes = new Set(
    Array.isArray(input.previousCodes)
      ? input.previousCodes.map(value => String(value || '').trim()).filter(Boolean)
      : []
  );
  const startedAtMs = Date.now();

  if (!filePath || waitMs <= 0) {
    return {
      status: 'skipped',
      reason: !filePath ? 'missing_OTP_CODE_FILE' : 'otp_wait_disabled',
      code: '',
      durationMs: 0,
      fileMtimeMs: 0,
    };
  }

  const resolvedPath = path.resolve(filePath);
  while (Date.now() - startedAtMs < waitMs) {
    if (fs.existsSync(resolvedPath)) {
      const stat = fs.statSync(resolvedPath);
      const raw = fs.readFileSync(resolvedPath, 'utf8');
      const match = raw.match(/\b(\d{6})\b/);
      if (match && stat.mtimeMs >= minMtimeMs && !previousCodes.has(match[1])) {
        return {
          status: 'ok',
          reason: '',
          code: match[1],
          durationMs: Math.max(0, Date.now() - startedAtMs),
          fileMtimeMs: stat.mtimeMs,
        };
      }
    }
    await sleep(pollMs);
  }

  return {
    status: 'timeout',
    reason: 'otp_code_not_received',
    code: '',
    durationMs: Math.max(0, Date.now() - startedAtMs),
    fileMtimeMs: 0,
  };
}

function shouldWaitForOtpFromFile(input = {}) {
  return (
    String(input.stage?.state || '').trim() === 'otp_code' &&
    !String(input.otpCode || '').trim() &&
    toInt(input.otpWaitMs, 0, 0) > 0
  );
}

function readCheckpoint(filePath) {
  const raw = String(filePath || '').trim();
  if (!raw) {
    return null;
  }
  const resolved = path.resolve(raw);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) {
    throw new Error(`Checkpoint not found: ${resolved}`);
  }
  return JSON.parse(fs.readFileSync(resolved, 'utf8'));
}

function parseProbePhase(value, checkpoint = null) {
  const raw = String(value || '').trim().toLowerCase();
  if (!raw) {
    return checkpoint ? 'reconnect' : 'bootstrap';
  }
  if (raw === 'bootstrap' || raw === 'reconnect') {
    return raw;
  }
  throw new Error('KEEPALIVE_PROBE_PHASE must be "bootstrap" or "reconnect".');
}

function toWebsiteRunPrefix(urlString) {
  try {
    return new URL(String(urlString || '')).hostname.replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  } catch {
    return 'unknown';
  }
}

function buildProbeCheckpoint(input = {}) {
  return {
    version: 1,
    createdAt: new Date().toISOString(),
    mode: input.mode || 'puppeteer_keepalive_probe',
    phase: input.phase || 'bootstrap',
    targetUrl: input.targetUrl || '',
    currentUrl: input.currentUrl || '',
    pageTitle: input.pageTitle || '',
    detachedAt: input.detachedAt || '',
    observed: input.observed || null,
    stage: input.stage || null,
    session: {
      id: input.session?.id || '',
      connect: input.session?.connect || '',
      stop: input.session?.stop || '',
      ttlMs: input.session?.ttlMs || 0,
      processKeepAliveMs: input.session?.processKeepAliveMs || 0,
      createdAt: input.session?.createdAt || '',
      expiresAt: input.session?.expiresAt || '',
    },
    runDir: input.runDir || '',
  };
}

function buildReconnectMeasurement(checkpoint = null, observed = null) {
  const bootstrapCreatedAt = String(checkpoint?.createdAt || '').trim();
  const beforeUrl = String(observed?.beforeUrl || '').trim();
  const beforeTitle = String(observed?.beforeTitle || '').trim();
  const checkpointUrl = String(checkpoint?.currentUrl || '').trim();
  const checkpointTitle = String(checkpoint?.pageTitle || '').trim();
  const createdAtMs = bootstrapCreatedAt ? Date.parse(bootstrapCreatedAt) : NaN;
  const nowMs = Date.now();

  return {
    bootstrapCreatedAt,
    elapsedSinceBootstrapMs: Number.isFinite(createdAtMs) ? Math.max(0, nowMs - createdAtMs) : null,
    sameUrlBeforeNavigate: Boolean(beforeUrl && checkpointUrl && beforeUrl === checkpointUrl),
    sameTitleBeforeNavigate: Boolean(
      beforeTitle && checkpointTitle && beforeTitle === checkpointTitle
    ),
  };
}

async function detectChallengeSnapshot(page) {
  return page.evaluate(() => {
    /* global document, location */
    const title = document.title || '';
    const url = location.href || '';
    const corpus = (document.body?.innerText || '').toLowerCase();
    const hasChallengeText =
      corpus.includes('just a moment') ||
      corpus.includes('performing security verification') ||
      corpus.includes('verify you are human');
    const hasVerifyingText = corpus.includes('verifying...');
    const hasSecurityCheckPassedText = corpus.includes('security check passed');
    const iframeCount = Array.from(document.querySelectorAll('iframe')).filter(frame => {
      const src = String(frame.getAttribute('src') || '');
      const titleAttr = String(frame.getAttribute('title') || '');
      const aria = String(frame.getAttribute('aria-label') || '');
      const all = `${src} ${titleAttr} ${aria}`.toLowerCase();
      return all.includes('turnstile') || all.includes('challenges.cloudflare.com');
    }).length;
    const tokenLength = (() => {
      const input = document.querySelector('input[name="cf-turnstile-response"]');
      return input && typeof input.value === 'string' ? input.value.trim().length : 0;
    })();

    return {
      title,
      url,
      iframeCount,
      tokenLength,
      hasChallengeText,
      hasVerifyingText,
      hasSecurityCheckPassedText,
      challengeVisible:
        hasChallengeText ||
        hasVerifyingText ||
        iframeCount > 0 ||
        /just a moment/i.test(title),
    };
  });
}

function summarizeInventory(inventory = {}) {
  const candidates = Array.isArray(inventory.candidates) ? inventory.candidates : [];
  const visible = candidates.filter(item => item.visible === true);
  const visibleEnabled = visible.filter(item => item.disabled !== true);
  const inputs = candidates.filter(item => ['input', 'textarea', 'select'].includes(item.tag));
  const buttonLike = candidates.filter(item =>
    item.tag === 'button' ||
    item.tag === 'a' ||
    item.role === 'button' ||
    (item.tag === 'input' && ['button', 'submit', 'radio'].includes(item.type))
  );
  return {
    candidateCount: candidates.length,
    visibleCandidateCount: visible.length,
    visibleEnabledCandidateCount: visibleEnabled.length,
    inputCount: inputs.length,
    visibleEnabledInputCount: inputs.filter(
      item => item.visible === true && item.disabled !== true
    ).length,
    buttonLikeCount: buttonLike.length,
    visibleEnabledButtonLikeCount: buttonLike.filter(
      item => item.visible === true && item.disabled !== true
    ).length,
  };
}

async function capturePageArtifacts(page, input = {}) {
  const label = String(input.label || 'landing');
  const screenshotsDir = String(input.screenshotsDir || '');
  const inventoriesDir = String(input.inventoriesDir || '');
  const sequence = toInt(input.sequence, 1, 1);
  const prefix = String(sequence).padStart(4, '0');
  const screenshotPath = screenshotsDir
    ? path.resolve(screenshotsDir, `${prefix}-${label}.png`)
    : '';
  const inventoryPath = inventoriesDir
    ? path.resolve(inventoriesDir, `${prefix}-${label}-runtime.json`)
    : '';

  let snapshot = null;
  let screenshotError = '';
  try {
    snapshot = await detectChallengeSnapshot(page);
    if (screenshotPath && typeof page.screenshot === 'function') {
      await page.screenshot({ path: screenshotPath, fullPage: true });
    }
  } catch (error) {
    screenshotError = String(error?.message || error || 'unknown_error');
  }

  const inventory = await inspectRuntimeInventory(page);
  const stage = classifyRuntimeStage(inventory, snapshot);
  const metrics = {
    label,
    ...summarizeInventory(inventory),
    stage,
  };
  if (typeof input.recordEvent === 'function') {
    input.recordEvent('screenshot', {
      label,
      screenshotPath: screenshotError ? '' : screenshotPath,
      snapshot,
      error: screenshotError,
    });
  }

  if (inventoryPath) {
    fs.writeFileSync(
      inventoryPath,
      JSON.stringify(
        {
          inventory,
          stage,
          metrics,
          challengeSnapshot: snapshot,
        },
        null,
        2
      )
    );
  }
  if (typeof input.recordEvent === 'function') {
    input.recordEvent('runtime_inventory', {
      label,
      inventoryPath,
      metrics,
    });
  }

  return {
    label,
    screenshotPath: screenshotError ? '' : screenshotPath,
    inventoryPath,
    screenshotError,
    snapshot,
    inventory,
    stage,
    metrics,
  };
}

class PuppeteerKeepAliveProbe {
  constructor(input = {}) {
    this.createSession = input.createSession || (async options => BrowserlessSession.create(options));
    this.connectRuntime = input.connectRuntime || (async options => PuppeteerSessionRuntime.connect(options));
    this.readCheckpoint = input.readCheckpoint || readCheckpoint;
  }

  async run(input = {}) {
    const checkpoint = input.checkpoint || this.readCheckpoint(input.checkpointPath);
    const phase = parseProbePhase(input.phase, checkpoint);
    let session = normalizeSessionPayload(checkpoint?.session || {});
    let sessionCreated = false;
    let sessionRecord = null;

    if (!session.connect) {
      const created = await this.createSession({
        httpBase: input.httpBase,
        token: input.token,
        ttlMs: input.ttlMs,
        stealth: input.stealth,
        processKeepAliveMs: input.processKeepAliveMs,
        browser: input.browser,
        rawPayload: input.rawPayload,
        proxyOverride: input.proxyOverride,
      });
      sessionCreated = true;
      sessionRecord = created.toRecord();
      session = created.session;
    }

    if (!session.connect) {
      throw new Error('Puppeteer keep-alive probe requires session.connect.');
    }

    const runtime = await this.connectRuntime({
      endpoint: session.connect,
      connectTimeoutMs: input.connectTimeoutMs,
      puppeteer: input.puppeteer,
    });

    const targetUrl = String(
      input.targetUrl || checkpoint?.targetUrl || checkpoint?.currentUrl || ''
    ).trim();
    const waitMs = toInt(input.waitMs, 5000, 0);
    const reconnectNavigate = input.reconnectNavigate === true;
    const screenshotsDir = String(input.screenshotsDir || '');
    const inventoriesDir = String(input.inventoriesDir || '');
    const recordEvent = typeof input.recordEvent === 'function' ? input.recordEvent : null;
    const workflowEnabled = input.workflowEnabled !== false;
    const maxActions = toInt(input.maxActions, 8, 1);
    const actionWaitMs = toInt(input.actionWaitMs, 5000, 0);
    const payload = { ...(input.payload || {}) };
    const otpCodeFile = String(input.otpCodeFile || '').trim();
    const otpWaitMs = toInt(input.otpWaitMs, 0, 0);
    const otpPollMs = toInt(input.otpPollMs, 1000, 250);
    const otpMaxAttempts = toInt(input.otpMaxAttempts, 3, 1);
    const driverPage = adaptPuppeteerPage(runtime.page);

    try {
      if (recordEvent) {
        recordEvent(sessionCreated ? 'session_created' : 'session_reused', {
          session: {
            id: session.id,
            hasConnect: Boolean(session.connect),
            hasStop: Boolean(session.stop),
            ttlMs: session.ttlMs || 0,
            processKeepAliveMs: session.processKeepAliveMs || 0,
          },
          sessionCreated,
        });
      }
      if (recordEvent) {
        recordEvent('runtime_connected', {
          runtime: runtime.toRecord(),
        });
      }
      const beforeUrl = typeof runtime.page.url === 'function'
        ? runtime.page.url()
        : String(runtime.page.url || '');
      const beforeTitle = typeof runtime.page.title === 'function'
        ? await runtime.page.title()
        : '';

      if (targetUrl && (phase === 'bootstrap' || reconnectNavigate)) {
        if (recordEvent) {
          recordEvent('navigate_start', {
            phase,
            targetUrl,
            fromUrl: beforeUrl,
          });
        }
        await runtime.page.goto(targetUrl, {
          waitUntil: 'domcontentloaded',
          timeout: runtime.connectTimeoutMs,
        });
        if (recordEvent) {
          recordEvent('navigate_complete', {
            phase,
            targetUrl,
            url: typeof runtime.page.url === 'function'
              ? runtime.page.url()
              : String(runtime.page.url || ''),
            title: typeof runtime.page.title === 'function'
              ? await runtime.page.title()
              : '',
          });
        }
      }
      if (waitMs > 0) {
        await sleep(waitMs);
      }

      const currentUrl = typeof runtime.page.url === 'function'
        ? runtime.page.url()
        : String(runtime.page.url || '');
      const pageTitle = typeof runtime.page.title === 'function'
        ? await runtime.page.title()
        : '';
      const pages = runtime.browser && typeof runtime.browser.pages === 'function'
        ? await runtime.browser.pages().catch(() => [])
        : [];
      const observed = {
        beforeUrl,
        beforeTitle,
        afterUrl: currentUrl,
        afterTitle: pageTitle,
        pageCount: Array.isArray(pages) ? pages.length : 0,
      };
      const capture = await capturePageArtifacts(runtime.page, {
        label: phase,
        screenshotsDir,
        inventoriesDir,
        sequence: 1,
        recordEvent,
      });
      let workflow = {
        enabled: workflowEnabled,
        terminalOutcome: '',
        landingStage: capture.stage,
        postActionStage: null,
        finalStage: capture.stage,
        actionPlan: null,
        actionResult: null,
        actions: [],
      };

      if (workflowEnabled) {
        let currentStage = capture.stage;
        let currentInventory = capture.inventory;
        let otpWaitAttempts = 0;
        let otpFileMinMtimeMs = Date.now();
        const previousOtpCodes = [];

        for (let actionIndex = 0; actionIndex < maxActions; actionIndex += 1) {
          const actionPlan = planRuntimeAction({
            stage: currentStage,
            inventory: currentInventory,
            payload,
          });
          workflow.actionPlan = actionPlan;
          if (recordEvent) {
            recordEvent('runtime_action_plan', {
              actionIndex,
              plan: actionPlan,
            });
          }

          if (actionPlan.type === 'none') {
            workflow.actionResult = {
              status: 'skipped',
              reason: actionPlan.reason,
              detail: actionPlan.detail || {},
            };
            if (recordEvent) {
              recordEvent('runtime_action_skipped', {
                actionIndex,
                ...workflow.actionResult,
              });
            }
            if (
              actionPlan.reason === 'unsupported_stage' &&
              actionPlan.detail?.stage === 'blocked_or_unknown'
            ) {
              await driverPage.waitForLoadState('domcontentloaded', {
                timeout: Math.min(runtime.connectTimeoutMs, 10000),
              }).catch(() => {});
              await driverPage.waitForTimeout(Math.min(actionWaitMs || 1000, 5000));
              const retryCapture = await capturePageArtifacts(runtime.page, {
                label: `post-wait-${actionIndex + 1}`,
                screenshotsDir,
                inventoriesDir,
                sequence: actionIndex + 2,
                recordEvent,
              });
              workflow.postActionStage = retryCapture.stage;
              workflow.finalStage = retryCapture.stage;
              currentStage = retryCapture.stage;
              currentInventory = retryCapture.inventory;
              if (recordEvent) {
                recordEvent('runtime_action_retry_after_blocked', {
                  actionIndex,
                  nextStage: currentStage,
                });
              }
              if (currentStage?.state !== 'blocked_or_unknown') {
                actionIndex -= 1;
                continue;
              }
            }
            break;
          }

          if (actionPlan.type === 'pause') {
            if (
              actionPlan.reason === 'need_otp_code' &&
              shouldWaitForOtpFromFile({
                stage: currentStage,
                otpCode: payload.OTP_CODE,
                otpWaitMs,
              }) &&
              otpWaitAttempts < otpMaxAttempts
            ) {
              otpWaitAttempts += 1;
              if (recordEvent) {
                recordEvent('otp_wait_start', {
                  actionIndex,
                  attempt: otpWaitAttempts,
                  filePath: otpCodeFile,
                  waitMs: otpWaitMs,
                  pollMs: otpPollMs,
                  minMtimeMs: otpFileMinMtimeMs,
                  previousCodeCount: previousOtpCodes.length,
                });
              }
              const otpWaitResult = await waitForOtpCode({
                filePath: otpCodeFile,
                waitMs: otpWaitMs,
                pollMs: otpPollMs,
                minMtimeMs: otpFileMinMtimeMs,
                previousCodes: previousOtpCodes,
              });
              if (recordEvent) {
                recordEvent('otp_wait_result', {
                  actionIndex,
                  attempt: otpWaitAttempts,
                  status: otpWaitResult.status,
                  reason: otpWaitResult.reason || '',
                  durationMs: otpWaitResult.durationMs || 0,
                  codeLength: otpWaitResult.code ? String(otpWaitResult.code).length : 0,
                  fileMtimeMs: otpWaitResult.fileMtimeMs || 0,
                });
              }
              if (otpWaitResult.status === 'ok' && otpWaitResult.code) {
                payload.OTP_CODE = otpWaitResult.code;
                previousOtpCodes.push(otpWaitResult.code);
                otpFileMinMtimeMs = Math.max(
                  Date.now() + 1,
                  (otpWaitResult.fileMtimeMs || otpFileMinMtimeMs) + 1
                );
                actionIndex -= 1;
                continue;
              }
            }
            workflow.terminalOutcome = actionPlan.terminalOutcome || 'need_otp';
            workflow.actionResult = {
              status: 'paused',
              terminalOutcome: workflow.terminalOutcome,
              reason: actionPlan.reason,
              detail: actionPlan.detail || {},
            };
            if (recordEvent) {
              recordEvent('runtime_action_paused', {
                actionIndex,
                ...workflow.actionResult,
              });
            }
            break;
          }

          const actionResult = await executeRuntimeAction(driverPage, actionPlan, payload, {
            waitMs: actionWaitMs,
          });
          workflow.actionResult = actionResult;
          workflow.actions.push({
            actionIndex,
            plan: actionPlan,
            result: actionResult,
          });
          if (recordEvent) {
            recordEvent('runtime_action_result', {
              actionIndex,
              result: actionResult,
            });
          }

          await driverPage.waitForLoadState('domcontentloaded', {
            timeout: Math.min(runtime.connectTimeoutMs, 10000),
          }).catch(() => {});
          await driverPage.waitForTimeout(500);

          const postActionCapture = await capturePageArtifacts(runtime.page, {
            label: `post-action-${actionIndex + 1}`,
            screenshotsDir,
            inventoriesDir,
            sequence: actionIndex + 2,
            recordEvent,
          });
          workflow.postActionStage = postActionCapture.stage;
          workflow.finalStage = postActionCapture.stage;
          currentStage = postActionCapture.stage;
          currentInventory = postActionCapture.inventory;

          if (
            actionResult.status === 'ok' &&
            actionPlan.type === 'select_delivery_and_submit' &&
            currentStage?.state === 'blocked_or_unknown'
          ) {
            await driverPage.waitForLoadState('domcontentloaded', {
              timeout: Math.min(runtime.connectTimeoutMs, 10000),
            }).catch(() => {});
            await driverPage.waitForTimeout(Math.min(actionWaitMs || 1000, 5000));
            const transitionCapture = await capturePageArtifacts(runtime.page, {
              label: `post-delivery-wait-${actionIndex + 1}`,
              screenshotsDir,
              inventoriesDir,
              sequence: actionIndex + 3,
              recordEvent,
            });
            workflow.postActionStage = transitionCapture.stage;
            workflow.finalStage = transitionCapture.stage;
            currentStage = transitionCapture.stage;
            currentInventory = transitionCapture.inventory;
            if (recordEvent) {
              recordEvent('runtime_action_transition_after_delivery', {
                actionIndex,
                nextStage: currentStage,
              });
            }
          }

          if (!workflow.terminalOutcome) {
            if (currentStage?.state === 'authed') {
              workflow.terminalOutcome = 'authed';
            } else if (actionResult.status === 'failed') {
              workflow.terminalOutcome = 'blocked_or_unknown';
            }
          }

          if (
            actionResult.status !== 'ok' ||
            workflow.terminalOutcome === 'authed' ||
            workflow.terminalOutcome === 'need_otp'
          ) {
            break;
          }
        }
      }
      const measurement = phase === 'reconnect'
        ? buildReconnectMeasurement(checkpoint, observed)
        : null;
      const detachedAt = new Date().toISOString();

      return {
        phase,
        targetUrl,
        currentUrl,
        pageTitle,
        detachedAt,
        observed,
        capture,
        workflow,
        measurement,
        session,
        sessionCreated,
        sessionRecord,
        runtime: runtime.toRecord(),
        endpointForLogs: redactUrlSecretParams(session.connect),
      };
    } finally {
      if (input.disconnectOnComplete === false) {
        await runtime.close();
      } else {
        await runtime.disconnect();
        if (recordEvent) {
          recordEvent('probe_detached', {
            phase,
            mode: 'disconnect',
          });
        }
      }
    }
  }
}

async function runPuppeteerKeepAliveProbeCli(input = {}) {
  const logsRoot = path.resolve(input.logsRoot || process.env.RUN_LOGS_ROOT || '.log');
  const customerId = String(input.customerId || process.env.CUSTOMER_ID || 'danny').trim() || 'danny';
  const checkpointPath = String(input.checkpointPath || process.env.CHECKPOINT_PATH || '').trim();
  const checkpoint = checkpointPath ? readCheckpoint(checkpointPath) : null;
  const phase = parseProbePhase(
    input.phase || process.env.KEEPALIVE_PROBE_PHASE,
    checkpoint
  );
  const targetUrl = String(
    input.targetUrl ||
      process.env.LOGIN_URL ||
      process.env.URL ||
      checkpoint?.targetUrl ||
      checkpoint?.currentUrl ||
      ''
  ).trim();

  const runTag = `${toWebsiteRunPrefix(targetUrl)}-${toTimestampTag(new Date())}`;
  const outputDir = path.resolve(logsRoot, customerId, 'puppeteer-keepalive-probe', runTag);
  const summaryPath = path.resolve(outputDir, 'summary.json');
  const checkpointOutPath = path.resolve(outputDir, 'checkpoint.json');
  const eventsPath = path.resolve(outputDir, 'events.jsonl');
  const screenshotsDir = path.resolve(outputDir, 'screenshots');
  const inventoriesDir = path.resolve(outputDir, 'inventories');
  fs.mkdirSync(outputDir, { recursive: true });
  fs.mkdirSync(screenshotsDir, { recursive: true });
  fs.mkdirSync(inventoriesDir, { recursive: true });
  const startedAtMs = Date.now();
  const recordEvent = (name, detail = {}) => {
    const entry = {
      at: new Date().toISOString(),
      offsetMs: Math.max(0, Date.now() - startedAtMs),
      name,
      detail,
    };
    appendJsonLine(eventsPath, entry);
    return entry;
  };
  recordEvent('run_start', {
    phase,
    targetUrl,
    checkpointPath,
  });
  const workflowEnabled = input.workflowEnabled != null
    ? input.workflowEnabled
    : (
        process.env.PUPPETEER_KEEPALIVE_RUN_WORKFLOW == null ||
        process.env.PUPPETEER_KEEPALIVE_RUN_WORKFLOW === ''
      )
        ? true
        : String(process.env.PUPPETEER_KEEPALIVE_RUN_WORKFLOW).trim().toLowerCase() === 'true';

  const probe = input.probe || new PuppeteerKeepAliveProbe();
  const result = await probe.run({
    phase,
    checkpoint,
    checkpointPath,
    targetUrl,
    ttlMs: input.ttlMs || process.env.SESSION_API_TTL_MS,
    processKeepAliveMs:
      input.processKeepAliveMs || process.env.SESSION_API_PROCESS_KEEP_ALIVE_MS,
    connectTimeoutMs:
      input.connectTimeoutMs || process.env.SESSION_API_CONNECT_TIMEOUT_MS || 60000,
    waitMs: input.waitMs || process.env.PUPPETEER_KEEPALIVE_WAIT_MS || 5000,
    reconnectNavigate:
      input.reconnectNavigate ??
      String(process.env.PUPPETEER_KEEPALIVE_RENAVIGATE || '').trim().toLowerCase() === 'true',
    workflowEnabled,
    maxActions: input.maxActions || process.env.LOGIN_WORKFLOW_MAX_ACTIONS || 8,
    actionWaitMs: input.actionWaitMs || process.env.LOGIN_WORKFLOW_ACTION_WAIT_MS || 5000,
    payload: {
      LOGIN_USERNAME: String(process.env.LOGIN_USERNAME || '').trim(),
      LOGIN_PASSWORD: String(process.env.LOGIN_PASSWORD || '').trim(),
      OTP_DELIVERY_SELECTION: String(process.env.OTP_DELIVERY_SELECTION || 'email').trim(),
      OTP_CODE: String(process.env.OTP_CODE || '').trim(),
    },
    otpCodeFile: input.otpCodeFile || process.env.OTP_CODE_FILE,
    otpWaitMs: input.otpWaitMs || process.env.OTP_WAIT_MS || process.env.LOGIN_OTP_WAIT_MS,
    otpPollMs: input.otpPollMs || process.env.OTP_POLL_MS || process.env.LOGIN_OTP_POLL_MS,
    otpMaxAttempts:
      input.otpMaxAttempts || process.env.OTP_MAX_ATTEMPTS || process.env.LOGIN_OTP_MAX_ATTEMPTS,
    screenshotsDir,
    inventoriesDir,
    recordEvent,
    disconnectOnComplete: input.disconnectOnComplete !== false,
    puppeteer: input.puppeteer,
  });

  const checkpointPayload = buildProbeCheckpoint({
    phase: result.phase,
    targetUrl: result.targetUrl,
    currentUrl: result.currentUrl,
    pageTitle: result.pageTitle,
    detachedAt: result.detachedAt,
    observed: result.observed,
    stage: result.capture?.stage || null,
    session: result.session,
    runDir: outputDir,
  });

  const summary = {
    checkedAt: new Date().toISOString(),
    customerId,
    phase,
    targetUrl: result.targetUrl,
    currentUrl: result.currentUrl,
    pageTitle: result.pageTitle,
    detachedAt: result.detachedAt,
    observed: result.observed,
    capture: {
      screenshotPath: result.capture?.screenshotPath || '',
      inventoryPath: result.capture?.inventoryPath || '',
      screenshotError: result.capture?.screenshotError || '',
      snapshot: result.capture?.snapshot || null,
      stage: result.capture?.stage || null,
      metrics: result.capture?.metrics || null,
    },
    workflow: result.workflow || null,
    measurement: result.measurement,
    sessionCreated: result.sessionCreated,
    endpoint: result.endpointForLogs,
    runtime: result.runtime,
    session: {
      id: result.session.id,
      hasConnect: Boolean(result.session.connect),
      hasStop: Boolean(result.session.stop),
      ttlMs: result.session.ttlMs || 0,
      processKeepAliveMs: result.session.processKeepAliveMs || 0,
    },
    screenshotsDir,
    inventoriesDir,
    eventsPath,
    checkpointPath: checkpointOutPath,
    summaryPath,
  };

  fs.writeFileSync(summaryPath, JSON.stringify(summary, null, 2));
  fs.writeFileSync(checkpointOutPath, JSON.stringify(checkpointPayload, null, 2));
  recordEvent('run_complete', {
    phase,
    currentUrl: summary.currentUrl,
    pageTitle: summary.pageTitle,
    stage: summary.capture.stage,
    terminalOutcome: summary.workflow?.terminalOutcome || '',
    summaryPath,
    checkpointPath: checkpointOutPath,
  });
  return summary;
}

module.exports = {
  PuppeteerKeepAliveProbe,
  buildProbeCheckpoint,
  buildReconnectMeasurement,
  parseProbePhase,
  readCheckpoint,
  runPuppeteerKeepAliveProbeCli,
  shouldWaitForOtpFromFile,
  toWebsiteRunPrefix,
  waitForOtpCode,
};
