const fs = require('fs');
const path = require('path');

const DEFAULT_LOG_PATH = '.log/turnstile/runs.jsonl';
const DEFAULT_TURNSTILE_WAIT_MS = 12000;
const DEFAULT_TURNSTILE_TECHNICAL_WAIT_MS = 300000;
const DEFAULT_TURNSTILE_POLL_MS = 500;
const MAX_LIVE_SECURITY_RESULT_LENGTH = 2000;

function parseNumber(value, fallback, minimum = 0) {
  if (value === undefined || value === null || String(value).trim() === '') {
    return fallback;
  }

  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(minimum, Math.trunc(parsed));
}

function normalizeSpace(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function truncate(value, maxLength = MAX_LIVE_SECURITY_RESULT_LENGTH) {
  const text = String(value || '');
  if (text.length <= maxLength) {
    return text;
  }
  return `${text.slice(0, maxLength)}...`;
}

function parseTurnstileDetailsFromText(rawText) {
  const text = String(rawText || '');
  const sessionIdMatch = text.match(/Session ID:\s*([A-Za-z0-9_-]+)/i);
  const ipMatch = text.match(/(?:Your\s+)?IP Address:\s*([^\n\r]+)/i);
  const statusLineMatch = text.match(/Turnstile Status:\s*([^\n\r]+)/i);
  const statusToken = statusLineMatch ? statusLineMatch[1].trim().match(/[A-Za-z]+/) : null;

  return {
    sessionId: sessionIdMatch ? sessionIdMatch[1].trim() : '',
    ipAddress: ipMatch ? ipMatch[1].trim() : '',
    status: statusToken ? statusToken[0].trim().toLowerCase() : '',
  };
}

function normalizeLiveSecurityStatus(value) {
  const text = normalizeSpace(value).toLowerCase();
  if (!text) {
    return '';
  }

  if (text.includes('verifying') || text.includes('checking') || text.includes('loading')) {
    return 'loading';
  }
  if (text.includes('success') || text.includes('passed') || text.includes('verified')) {
    return 'passed';
  }
  if (text.includes('fail') || text.includes('error') || text.includes('unsupported') || text.includes('timeout')) {
    return 'failed';
  }
  return '';
}

function isTerminalStatus(status) {
  return ['failed', 'passed', 'success'].includes(String(status || '').toLowerCase());
}

function isLiveSecurityTerminal(status) {
  return ['failed', 'passed', 'success'].includes(String(status || '').toLowerCase());
}

function isTurnstileDetailsComplete(details) {
  const value = details || {};
  return Boolean(value.technicalDetailsOpen && value.sessionId && value.ipAddress && value.status);
}

function isLiveSecurityComplete(details) {
  const value = details || {};
  return Boolean(
    isLiveSecurityTerminal(value.liveSecurityStatus) &&
    (value.liveSecurityResultTitle || value.liveSecurityResultBody || value.liveSecurityErrorCode)
  );
}

function isTurnstileSnapshotComplete(details) {
  return isTurnstileDetailsComplete(details) && isLiveSecurityComplete(details);
}

function shouldUseTurnstileWait(url) {
  try {
    const parsed = new URL(String(url || ''));
    return parsed.hostname.endsWith('turnstile.workers.dev');
  } catch (error) {
    return false;
  }
}

async function readPageText(page) {
  return page.evaluate(() => {
    if (!document || !document.body) {
      return '';
    }

    return String(document.body.innerText || '');
  });
}

async function readTurnstilePageSnapshot(page) {
  return page.evaluate(() => {
    const isVisible = element => {
      if (!element) {
        return false;
      }
      if (element.classList && element.classList.contains('hidden')) {
        return false;
      }

      const style = window.getComputedStyle(element);
      if (!style || style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
        return false;
      }

      const rect = element.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    };

    const getText = element => (element ? String(element.innerText || '').trim() : '');
    const detailsElement = document.getElementById('tech-details');
    const technicalDetailsElement = document.getElementById('technical-details');
    const issueAlert = document.getElementById('issue-alert');
    const successCard = document.getElementById('success-card');
    const issueTitle = document.getElementById('issue-title');
    const issueDescription = document.getElementById('issue-description');
    const issueSolution = document.getElementById('issue-solution');
    const successTitle = successCard ? successCard.querySelector('h3') : null;
    const successParagraphs = successCard ? Array.from(successCard.querySelectorAll('p')) : [];
    const turnstileStatus = document.getElementById('turnstile-status');

    return {
      bodyText: document?.body ? String(document.body.innerText || '') : '',
      technicalDetailsOpen: Boolean(detailsElement && detailsElement.hasAttribute('open')),
      technicalDetailsText: getText(technicalDetailsElement),
      liveSecurityStatusText: getText(turnstileStatus),
      issueAlertVisible: isVisible(issueAlert),
      successCardVisible: isVisible(successCard),
      issueTitleText: getText(issueTitle),
      issueDescriptionText: getText(issueDescription),
      issueSolutionText: getText(issueSolution),
      successTitleText: getText(successTitle),
      successDescriptionText: successParagraphs.map(getText).filter(Boolean).join('\n'),
    };
  });
}

function parseLiveSecurityErrorCode(rawText) {
  const text = String(rawText || '');
  const match = text.match(/Error:\s*([A-Za-z0-9_-]+)/i);
  return match ? match[1].trim() : '';
}

function extractLiveSecurityDetails(snapshot) {
  const statusText = normalizeSpace(snapshot.liveSecurityStatusText);
  const isFailed = snapshot.issueAlertVisible === true;
  const isPassed = snapshot.successCardVisible === true;

  const resultTitle = normalizeSpace(
    isFailed ? snapshot.issueTitleText : (isPassed ? snapshot.successTitleText : '')
  );
  const resultBodyRaw = isFailed
    ? [snapshot.issueDescriptionText, snapshot.issueSolutionText].filter(Boolean).join('\n')
    : (isPassed ? snapshot.successDescriptionText : '');
  const resultBody = truncate(normalizeSpace(resultBodyRaw));
  const errorCode = parseLiveSecurityErrorCode(
    [statusText, resultTitle, resultBody].filter(Boolean).join('\n')
  );

  let status = '';
  if (isFailed) {
    status = 'failed';
  } else if (isPassed) {
    status = 'passed';
  } else {
    status = normalizeLiveSecurityStatus(statusText);
  }

  return {
    liveSecurityStatus: status,
    liveSecurityStatusText: statusText,
    liveSecurityResultTitle: resultTitle,
    liveSecurityResultBody: resultBody,
    liveSecurityErrorCode: errorCode,
  };
}

function extractTurnstileDetailsFromSnapshot(snapshot) {
  if (!snapshot.technicalDetailsOpen) {
    return {
      technicalDetailsOpen: false,
      sessionId: '',
      ipAddress: '',
      status: '',
    };
  }

  const technicalText = String(snapshot.technicalDetailsText || '');
  const fallbackText = String(snapshot.bodyText || '');
  const parsed = parseTurnstileDetailsFromText([technicalText, fallbackText].join('\n'));

  return {
    technicalDetailsOpen: true,
    sessionId: parsed.sessionId,
    ipAddress: parsed.ipAddress,
    status: parsed.status,
  };
}

function resolveLogPath() {
  return path.resolve(process.env.TURNSTILE_LOG_PATH || DEFAULT_LOG_PATH);
}

function getTurnstileWaitMs(currentUrl, { untilComplete = false, waitMsOverride } = {}) {
  const defaultWaitMs = shouldUseTurnstileWait(currentUrl)
    ? (untilComplete ? DEFAULT_TURNSTILE_TECHNICAL_WAIT_MS : DEFAULT_TURNSTILE_WAIT_MS)
    : 0;
  const envValue = untilComplete
    ? process.env.TURNSTILE_LOG_TECHNICAL_WAIT_MS
    : process.env.TURNSTILE_LOG_WAIT_MS;
  const waitMs = parseNumber(
    waitMsOverride === undefined ? envValue : waitMsOverride,
    defaultWaitMs,
    0
  );
  return waitMs;
}

function getTurnstilePollMs(pollMsOverride) {
  return parseNumber(
    pollMsOverride === undefined ? process.env.TURNSTILE_LOG_POLL_MS : pollMsOverride,
    DEFAULT_TURNSTILE_POLL_MS,
    100
  );
}

async function pollTurnstileDetails(page, options = {}) {
  const currentUrl = page.url();
  const untilComplete = options.untilComplete === true;
  const waitMs = getTurnstileWaitMs(currentUrl, {
    untilComplete,
    waitMsOverride: options.waitMs,
  });
  const intervalMs = getTurnstilePollMs(options.pollMs);
  const startedAt = Date.now();
  let latest = {
    technicalDetailsOpen: false,
    sessionId: '',
    ipAddress: '',
    status: '',
    liveSecurityStatus: '',
    liveSecurityStatusText: '',
    liveSecurityResultTitle: '',
    liveSecurityResultBody: '',
    liveSecurityErrorCode: '',
  };

  while (true) {
    const snapshot = await readTurnstilePageSnapshot(page).catch(async () => {
      const text = await readPageText(page);
      return {
        bodyText: text,
        technicalDetailsOpen: false,
        technicalDetailsText: '',
        liveSecurityStatusText: '',
        issueAlertVisible: false,
        successCardVisible: false,
        issueTitleText: '',
        issueDescriptionText: '',
        issueSolutionText: '',
        successTitleText: '',
        successDescriptionText: '',
      };
    });
    const fallbackDetails = parseTurnstileDetailsFromText(snapshot.bodyText);
    const details = extractTurnstileDetailsFromSnapshot(snapshot);
    const liveSecurity = extractLiveSecurityDetails(snapshot);
    latest = {
      technicalDetailsOpen: details.technicalDetailsOpen || Boolean(
        fallbackDetails.sessionId || fallbackDetails.ipAddress || fallbackDetails.status
      ),
      sessionId: details.sessionId || fallbackDetails.sessionId,
      ipAddress: details.ipAddress || fallbackDetails.ipAddress,
      status: details.status || fallbackDetails.status,
      ...liveSecurity,
    };

    const elapsed = Date.now() - startedAt;
    const done = untilComplete
      ? isTurnstileSnapshotComplete(latest)
      : (isTerminalStatus(latest.status) || isLiveSecurityTerminal(latest.liveSecurityStatus));
    if (done || elapsed >= waitMs) {
      return {
        details: latest,
        elapsedMs: elapsed,
        waitMs,
      };
    }

    await page.waitForTimeout(intervalMs);
  }
}

function appendJsonLine(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.appendFileSync(filePath, `${JSON.stringify(value)}\n`);
}

function readSnapshotStatus(snapshot) {
  return String(snapshot?.turnstileStatus || snapshot?.status || '').trim().toLowerCase();
}

function readSnapshotLiveStatus(snapshot) {
  return String(snapshot?.liveSecurityStatus || '').trim().toLowerCase();
}

function areSnapshotsEquivalent(first, second) {
  return (
    Boolean(first?.technicalDetailsOpen) === Boolean(second?.technicalDetailsOpen) &&
    String(first?.sessionId || '').trim() === String(second?.sessionId || '').trim() &&
    String(first?.ipAddress || '').trim() === String(second?.ipAddress || '').trim() &&
    readSnapshotStatus(first) === readSnapshotStatus(second) &&
    readSnapshotLiveStatus(first) === readSnapshotLiveStatus(second) &&
    String(first?.liveSecurityStatusText || '').trim() === String(second?.liveSecurityStatusText || '').trim() &&
    String(first?.liveSecurityResultTitle || '').trim() === String(second?.liveSecurityResultTitle || '').trim() &&
    String(first?.liveSecurityResultBody || '').trim() === String(second?.liveSecurityResultBody || '').trim() &&
    String(first?.liveSecurityErrorCode || '').trim() === String(second?.liveSecurityErrorCode || '').trim()
  );
}

function buildTurnstileLogEntry(page, metadata, details) {
  return {
    recordedAt: new Date().toISOString(),
    script: metadata.script || '',
    target: process.env.BL_PROXY || '',
    testUrl: metadata.testUrl || '',
    pageUrl: page.url(),
    technicalDetailsOpen: Boolean(details.technicalDetailsOpen),
    sessionId: details.sessionId,
    ipAddress: details.ipAddress,
    turnstileStatus: details.status,
    liveSecurityStatus: details.liveSecurityStatus || '',
    liveSecurityStatusText: details.liveSecurityStatusText || '',
    liveSecurityResultTitle: details.liveSecurityResultTitle || '',
    liveSecurityResultBody: details.liveSecurityResultBody || '',
    liveSecurityErrorCode: details.liveSecurityErrorCode || '',
  };
}

async function logTurnstileRunFromPage(page, metadata = {}) {
  try {
    const { details } = await pollTurnstileDetails(page, { untilComplete: false });
    const logPath = resolveLogPath();
    const entry = buildTurnstileLogEntry(page, metadata, details);

    appendJsonLine(logPath, entry);
    return { logPath, entry };
  } catch (error) {
    return {
      logPath: '',
      entry: null,
      error,
    };
  }
}

async function logTurnstileRunAfterTechnicalDetails(page, metadata = {}, options = {}) {
  try {
    const baselineEntry = options.baselineEntry || null;
    const { details, elapsedMs, waitMs } = await pollTurnstileDetails(page, {
      untilComplete: true,
      waitMs: options.waitMs,
      pollMs: options.pollMs,
    });
    const logPath = resolveLogPath();

    if (!isTurnstileSnapshotComplete(details)) {
      return {
        logPath,
        entry: null,
        skipped: true,
        reason: 'details_incomplete',
        elapsedMs,
        waitMs,
      };
    }

    const entry = buildTurnstileLogEntry(page, metadata, details);
    if (baselineEntry && areSnapshotsEquivalent(baselineEntry, entry)) {
      return {
        logPath,
        entry,
        skipped: true,
        reason: 'unchanged',
        elapsedMs,
        waitMs,
      };
    }

    appendJsonLine(logPath, entry);
    return {
      logPath,
      entry,
      elapsedMs,
      waitMs,
    };
  } catch (error) {
    return {
      logPath: '',
      entry: null,
      error,
    };
  }
}

module.exports = {
  isTurnstileDetailsComplete,
  isLiveSecurityComplete,
  logTurnstileRunFromPage,
  logTurnstileRunAfterTechnicalDetails,
  shouldUseTurnstileWait,
};
