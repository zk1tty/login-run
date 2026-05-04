#!/usr/bin/env node

require('dotenv').config();

const fs = require('fs');
const path = require('path');

const CONDITIONS = ['fresh', 'persistent'];

function sanitizeTag(value, fallback = 'default') {
  const normalized = String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return normalized || fallback;
}

function resolveUrlTag(targetUrl) {
  const value = String(targetUrl || '').trim();
  if (!value) {
    return 'any-url';
  }

  try {
    const parsed = new URL(value);
    const host = sanitizeTag(parsed.hostname, 'url');
    const pathname = sanitizeTag(parsed.pathname.replace(/\//g, '-'), '');
    const combined = [host, pathname].filter(Boolean).join('_');
    return combined || host;
  } catch (error) {
    return sanitizeTag(value, 'any-url');
  }
}

function resolveDefaultStudyRoot(customerId, proxyMode, targetUrl) {
  return path.resolve(
    path.join(
      '.log',
      customerId,
      'challenge-study',
      sanitizeTag(proxyMode || 'no-proxy', 'no-proxy'),
      resolveUrlTag(targetUrl)
    )
  );
}

function parseJsonLines(filePath) {
  if (!fs.existsSync(filePath)) {
    return [];
  }

  const raw = fs.readFileSync(filePath, 'utf8');
  return raw
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean)
    .map(line => {
      try {
        return JSON.parse(line);
      } catch (error) {
        return null;
      }
    })
    .filter(Boolean);
}

function loadJsonIfExists(filePath) {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

function toIso(value) {
  const parsed = Date.parse(String(value || ''));
  if (!Number.isFinite(parsed)) {
    return '';
  }
  return new Date(parsed).toISOString();
}

function parseIsoMs(value) {
  const parsed = Date.parse(String(value || ''));
  return Number.isFinite(parsed) ? parsed : 0;
}

function dedupeTimeline(items) {
  const deduped = [];
  const seen = new Set();

  for (const item of items) {
    const timestamp = toIso(item.timestamp);
    const condition = String(item.condition || '').trim();
    const pageStatus = String(item.pageStatus || '').trim().toLowerCase();
    if (!timestamp || !condition || !['waiting', 'checkbox'].includes(pageStatus)) {
      continue;
    }

    const key = `${timestamp}|${condition}|${pageStatus}`;
    if (seen.has(key)) {
      continue;
    }

    seen.add(key);
    deduped.push({
      timestamp,
      condition,
      pageStatus,
      source: String(item.source || '').trim(),
    });
  }

  deduped.sort((a, b) => parseIsoMs(a.timestamp) - parseIsoMs(b.timestamp));
  return deduped;
}

function timelineFromEvents(events) {
  const timeline = [];
  for (const event of events) {
    const pageStatus = String(event.turnstilePageType || '').trim().toLowerCase();
    if (!['waiting', 'checkbox'].includes(pageStatus)) {
      continue;
    }

    timeline.push({
      timestamp: event.timestamp,
      condition: event.condition,
      pageStatus,
      source: String(event.phase || 'probe').trim() || 'probe',
    });
  }
  return dedupeTimeline(timeline);
}

function timelineFromState(state) {
  const timeline = [];

  for (const condition of CONDITIONS) {
    const item = state?.conditions?.[condition] || {};
    if (item.firstWaitingAt) {
      timeline.push({
        timestamp: item.firstWaitingAt,
        condition,
        pageStatus: 'waiting',
        source: 'state',
      });
    }
    if (item.firstCheckboxAt) {
      timeline.push({
        timestamp: item.firstCheckboxAt,
        condition,
        pageStatus: 'checkbox',
        source: 'state',
      });
    }
  }

  return dedupeTimeline(timeline);
}

function metricsFromWsEvents(events) {
  let firstWaitingAt = '';
  let firstCheckboxAt = '';
  let firstNeedCredAt = '';
  let waitingToCheckboxMs = 0;
  let waitingToLoginMs = 0;
  let wsTraceCount = 0;
  let wsScreenshotCount = 0;

  for (const event of events) {
    const timestampIso = toIso(event.timestamp);
    const wsState = String(event.wsState || '').trim().toLowerCase();
    const wsMetrics = event.wsTransitionMetrics && typeof event.wsTransitionMetrics === 'object'
      ? event.wsTransitionMetrics
      : null;

    if (event.wsTracePath) {
      wsTraceCount += 1;
    }
    if (Number.isFinite(Number(event.wsScreenshotCount)) && Number(event.wsScreenshotCount) > 0) {
      wsScreenshotCount += Math.trunc(Number(event.wsScreenshotCount));
    }

    if (!firstWaitingAt) {
      if (wsMetrics?.firstWaitingAt && timestampIso) {
        firstWaitingAt = timestampIso;
      } else if (wsState === 'challenge' && String(event.turnstilePageType || '').trim() === 'waiting' && timestampIso) {
        firstWaitingAt = timestampIso;
      }
    }

    if (!firstCheckboxAt) {
      if (wsMetrics?.firstCheckboxAt && timestampIso) {
        firstCheckboxAt = timestampIso;
      } else if (wsState === 'challenge' && String(event.turnstilePageType || '').trim() === 'checkbox' && timestampIso) {
        firstCheckboxAt = timestampIso;
      }
    }

    if (!firstNeedCredAt) {
      if (wsMetrics?.firstNeedCredAt && timestampIso) {
        firstNeedCredAt = timestampIso;
      } else if (wsState === 'need_cred' && timestampIso) {
        firstNeedCredAt = timestampIso;
      }
    }

    if (!waitingToCheckboxMs && Number.isFinite(Number(wsMetrics?.waitingToCheckboxMs))) {
      const value = Math.trunc(Number(wsMetrics.waitingToCheckboxMs));
      if (value > 0) {
        waitingToCheckboxMs = value;
      }
    }

    if (!waitingToLoginMs && Number.isFinite(Number(wsMetrics?.waitingToLoginMs))) {
      const value = Math.trunc(Number(wsMetrics.waitingToLoginMs));
      if (value > 0) {
        waitingToLoginMs = value;
      }
    }
  }

  return {
    firstWaitingAt,
    firstCheckboxAt,
    firstNeedCredAt,
    waitingToCheckboxMs,
    waitingToLoginMs,
    wsTraceCount,
    wsScreenshotCount,
  };
}

function buildSummary(state, events) {
  const eventsTimeline = timelineFromEvents(events);
  const stateTimeline = timelineFromState(state);
  const timeline = dedupeTimeline([...eventsTimeline, ...stateTimeline]);
  const wsMetrics = metricsFromWsEvents(events);
  const waitingCount = timeline.filter(item => item.pageStatus === 'waiting').length;
  const checkboxCount = timeline.filter(item => item.pageStatus === 'checkbox').length;

  return {
    generatedAt: new Date().toISOString(),
    customerId: String(state?.customerId || process.env.CID || process.env.CUSTOMER_ID || ''),
    proxyMode: String(state?.proxyMode || state?.target || process.env.BL_PROXY || ''),
    targetUrl: String(state?.targetUrl || process.env.URL || ''),
    status: String(state?.status || ''),
    turnstileAppeared: timeline.length > 0,
    turnstileTimeline: timeline,
    turnstileTimelineCount: timeline.length,
    waitingCount,
    checkboxCount,
    firstTurnstileAt: timeline[0]?.timestamp || '',
    firstWaitingAt: wsMetrics.firstWaitingAt || timeline.find(item => item.pageStatus === 'waiting')?.timestamp || '',
    firstCheckboxAt: wsMetrics.firstCheckboxAt || timeline.find(item => item.pageStatus === 'checkbox')?.timestamp || '',
    firstNeedCredAt: wsMetrics.firstNeedCredAt || '',
    waitingToCheckboxMs: wsMetrics.waitingToCheckboxMs || Number(state?.conditions?.fresh?.waitingToCheckboxMs || state?.conditions?.persistent?.waitingToCheckboxMs || 0),
    waitingToLoginMs: wsMetrics.waitingToLoginMs || Number(state?.conditions?.fresh?.waitingToLoginMs || state?.conditions?.persistent?.waitingToLoginMs || 0),
    wsTraceCount: wsMetrics.wsTraceCount,
    wsScreenshotCount: wsMetrics.wsScreenshotCount,
  };
}

function toMarkdown(summary) {
  const lines = [
    '# Turnstile Result',
    '',
    `- Generated At: ${summary.generatedAt}`,
    `- Customer ID: ${summary.customerId || '(unset)'}`,
    `- Proxy Mode: ${summary.proxyMode || '(unset)'}`,
    `- URL: ${summary.targetUrl || '(unset)'}`,
    `- Turnstile Appeared: ${summary.turnstileAppeared ? 'yes' : 'no'}`,
    `- First Waiting At: ${summary.firstWaitingAt || '(none)'}`,
    `- First Checkbox At: ${summary.firstCheckboxAt || '(none)'}`,
    `- First Login At: ${summary.firstNeedCredAt || '(none)'}`,
    `- Waiting -> Checkbox (ms): ${summary.waitingToCheckboxMs || 0}`,
    `- Waiting -> Login (ms): ${summary.waitingToLoginMs || 0}`,
    `- WS Traces: ${summary.wsTraceCount || 0}`,
    `- WS Screenshots: ${summary.wsScreenshotCount || 0}`,
    '',
    '## Timeline',
  ];

  if (summary.turnstileTimeline.length === 0) {
    lines.push('- none');
  } else {
    for (const item of summary.turnstileTimeline) {
      lines.push(`- ${item.timestamp} | ${item.condition} | ${item.pageStatus}`);
    }
  }

  return `${lines.join('\n')}\n`;
}

function main() {
  const customerId = String(process.env.CID || process.env.CUSTOMER_ID || 'danny').trim();
  const targetUrl = String(process.env.URL || process.env.CHALLENGE_STUDY_BOOTSTRAP_URL || '').trim();
  const proxyMode = String(process.env.BL_PROXY || '').trim();
  const studyRoot = path.resolve(
    process.env.CHALLENGE_STUDY_DIR || resolveDefaultStudyRoot(customerId, proxyMode, targetUrl)
  );
  const statePath = path.resolve(studyRoot, 'state.json');
  const eventsPath = path.resolve(studyRoot, 'events.jsonl');
  const summaryPath = path.resolve(studyRoot, 'summary.json');
  const summaryMarkdownPath = path.resolve(studyRoot, 'summary.md');
  const timelinePath = path.resolve(studyRoot, 'turnstile-timeline.jsonl');
  const state = loadJsonIfExists(statePath);
  const events = parseJsonLines(eventsPath);

  if (!state) {
    throw new Error(`State file not found: ${statePath}`);
  }

  const summary = buildSummary(state, events);
  fs.mkdirSync(path.dirname(summaryPath), { recursive: true });
  fs.writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  fs.writeFileSync(summaryMarkdownPath, toMarkdown(summary));
  const timelineBody = summary.turnstileTimeline.map(item => JSON.stringify(item)).join('\n');
  fs.writeFileSync(timelinePath, timelineBody ? `${timelineBody}\n` : '');

  console.log('Turnstile result generated');
  console.log('Output:', summaryPath);
  console.log(
    JSON.stringify(
      {
        turnstileAppeared: summary.turnstileAppeared,
        timeline: summary.turnstileTimeline,
      },
      null,
      2
    )
  );
}

try {
  main();
} catch (error) {
  console.error(error.message || error);
  process.exit(1);
}
