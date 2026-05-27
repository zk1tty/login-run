const loginForm = document.querySelector('#loginForm');
const otpForm = document.querySelector('#otpForm');
const otpSubmitButton = otpForm.querySelector('button[type="submit"]');
const resetButton = document.querySelector('#resetButton');
const pollButton = document.querySelector('#pollButton');
const reconnectButton = document.querySelector('#reconnectButton');
const startButton = document.querySelector('#startButton');
const connectionStatus = document.querySelector('#connectionStatus');
const runSelect = document.querySelector('#runSelect');
const runResultOutput = document.querySelector('#runResult');
const latestEventOutput = document.querySelector('#latestEvent');
const totalTimerOutput = document.querySelector('#totalTimer');
const phaseOneTimerOutput = document.querySelector('#phaseOneTimer');
const phaseTwoTimerOutput = document.querySelector('#phaseTwoTimer');
const eventLog = document.querySelector('#eventLog');
const eventCountOutput = document.querySelector('#eventCount');
const payloadOutput = document.querySelector('#payloadOutput');
const payloadStatus = document.querySelector('#payloadStatus');
const screenshotCountOutput = document.querySelector('#screenshotCount');
const screenshotImage = document.querySelector('#screenshotImage');
const emptyScreenshot = document.querySelector('#emptyScreenshot');
const previousScreenshot = document.querySelector('#previousScreenshot');
const nextScreenshot = document.querySelector('#nextScreenshot');
const screenshotLabel = document.querySelector('#screenshotLabel');
const screenshotTimestamp = document.querySelector('#screenshotTimestamp');

const terminalEvents = new Set(['login.completed', 'login.failed']);
const listenedEvents = [
  'login.updated',
  'login.waiting_input',
  'login.screenshot',
  'login.completed',
  'login.failed',
];

let eventSource = null;
let activeRun = null;
let eventCount = 0;
let totalStartedAt = 0;
let phaseOneStartedAt = 0;
let phaseOneEndedAt = 0;
let phaseTwoStartedAt = 0;
let phaseTwoEndedAt = 0;
let timerHandle = null;
let activeOperation = '';
let screenshots = [];
let screenshotIndex = 0;
let knownRuns = [];

function formatDuration(startedAt, endedAt = performance.now()) {
  if (!startedAt) {
    return '0.0s';
  }
  return `${Math.max(0, endedAt - startedAt).toFixed(0) / 1000}s`;
}

function setConnectionStatus(value) {
  connectionStatus.textContent = value;
  connectionStatus.className = `status-pill ${value}`;
}

function renderTimers() {
  const now = performance.now();
  const totalEndedAt = phaseTwoEndedAt || phaseOneEndedAt || now;

  totalTimerOutput.textContent = totalStartedAt
    ? formatDuration(totalStartedAt, terminalEvents.has(latestEventOutput.textContent) ? totalEndedAt : now)
    : '0.0s';
  phaseOneTimerOutput.textContent = phaseOneStartedAt
    ? formatDuration(phaseOneStartedAt, phaseOneEndedAt || now)
    : '0.0s';
  phaseTwoTimerOutput.textContent = phaseTwoStartedAt
    ? formatDuration(phaseTwoStartedAt, phaseTwoEndedAt || now)
    : '0.0s';
}

function startTimerLoop() {
  stopTimerLoop();
  timerHandle = window.setInterval(renderTimers, 100);
  renderTimers();
}

function stopTimerLoop() {
  if (timerHandle) {
    window.clearInterval(timerHandle);
    timerHandle = null;
  }
}

function setPayload(label, value) {
  payloadStatus.textContent = label;
  payloadOutput.textContent = JSON.stringify(value || {}, null, 2);
}

function runLabel(run) {
  if (!run?.runId) {
    return 'No runs';
  }
  const created = formatTimestamp(run.createdAt);
  return `${run.runId} - ${run.status}/${run.state} - ${created}`;
}

function renderRunList() {
  const currentRunId = activeRun?.runId || '';
  runSelect.textContent = '';

  if (knownRuns.length === 0) {
    const option = document.createElement('option');
    option.value = '';
    option.textContent = 'No runs';
    runSelect.append(option);
    runSelect.disabled = true;
    return;
  }

  for (const run of knownRuns) {
    const option = document.createElement('option');
    option.value = run.runId;
    option.textContent = runLabel(run);
    runSelect.append(option);
  }
  runSelect.disabled = false;
  runSelect.value = knownRuns.some(run => run.runId === currentRunId)
    ? currentRunId
    : knownRuns[0].runId;
}

async function refreshRuns() {
  try {
    const result = await requestJson('/v1/logins');
    knownRuns = Array.isArray(result.runs) ? result.runs : [];
    if (activeRun?.runId) {
      activeRun = knownRuns.find(run => run.runId === activeRun.runId) || activeRun;
    }
    renderRunList();
  } catch {
    // The rest of the demo remains usable even if the list refresh misses once.
  }
}

function updateRunView(run) {
  activeRun = run;
  runResultOutput.textContent = run ? `${run.status} / ${run.state}` : 'idle';
  pollButton.disabled = !run?.runId;
  reconnectButton.disabled = !run?.runId || run.status === 'running' || !run.result?.session?.id;
  setPayload(run?.status || 'empty', run || {});
  renderRunList();
}

function formatTimestamp(value) {
  if (!value) {
    return '-';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    second: '2-digit',
  });
}

function renderScreenshot() {
  screenshotCountOutput.textContent = `${screenshots.length} frame${screenshots.length === 1 ? '' : 's'}`;
  previousScreenshot.disabled = screenshots.length <= 1;
  nextScreenshot.disabled = screenshots.length <= 1;

  if (screenshots.length === 0) {
    screenshotImage.removeAttribute('src');
    screenshotImage.classList.remove('visible');
    emptyScreenshot.classList.remove('hidden');
    screenshotLabel.textContent = '-';
    screenshotTimestamp.textContent = '-';
    return;
  }

  screenshotIndex = Math.min(Math.max(screenshotIndex, 0), screenshots.length - 1);
  const current = screenshots[screenshotIndex];
  screenshotImage.src = `${current.url}?v=${encodeURIComponent(current.createdAt || current.fileName)}`;
  screenshotImage.classList.add('visible');
  emptyScreenshot.classList.add('hidden');
  screenshotLabel.textContent = `${screenshotIndex + 1}/${screenshots.length} ${current.label || current.fileName}`;
  screenshotTimestamp.textContent = formatTimestamp(current.createdAt);
}

function sortScreenshotsByTime(items) {
  return items.sort((left, right) => {
    const leftTime = Date.parse(left.createdAt || '');
    const rightTime = Date.parse(right.createdAt || '');
    if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
      return leftTime - rightTime;
    }
    return String(left.fileName || '').localeCompare(String(right.fileName || ''));
  });
}

function appendScreenshotArtifact(screenshot) {
  if (!screenshot?.fileName || screenshot.runId !== activeRun?.runId) {
    return;
  }

  const existingIndex = screenshots.findIndex(item => item.fileName === screenshot.fileName);
  if (existingIndex >= 0) {
    screenshots[existingIndex] = {
      ...screenshots[existingIndex],
      ...screenshot,
    };
  } else {
    screenshots.push(screenshot);
  }
  sortScreenshotsByTime(screenshots);
  screenshotIndex = screenshots.findIndex(item => item.fileName === screenshot.fileName);
  renderScreenshot();
}

async function refreshScreenshots() {
  if (!activeRun?.runId) {
    screenshots = [];
    screenshotIndex = 0;
    renderScreenshot();
    return;
  }

  try {
    const result = await requestJson(`/v1/logins/${encodeURIComponent(activeRun.runId)}/artifacts/screenshots`);
    const previousFile = screenshots[screenshotIndex]?.fileName || '';
    screenshots = sortScreenshotsByTime(Array.isArray(result.screenshots) ? result.screenshots : []);
    const previousIndex = screenshots.findIndex(item => item.fileName === previousFile);
    screenshotIndex = previousIndex >= 0 ? previousIndex : Math.max(0, screenshots.length - 1);
    renderScreenshot();
  } catch (error) {
    screenshotLabel.textContent = 'Screenshot refresh failed';
    screenshotTimestamp.textContent = error.message;
  }
}

function appendEvent(type, data) {
  eventCount += 1;
  eventCountOutput.textContent = `${eventCount} event${eventCount === 1 ? '' : 's'}`;
  latestEventOutput.textContent = type;

  const row = document.createElement('div');
  row.className = 'event-row';
  row.innerHTML = `
    <span>${new Date().toLocaleTimeString()}</span>
    <code>${type}</code>
    <span>${data?.status && data?.state ? `${data.status} / ${data.state}` : data?.label || data?.fileName || '-'}</span>
  `;
  eventLog.prepend(row);
}

function closeEvents() {
  if (eventSource) {
    eventSource.close();
    eventSource = null;
  }
}

function handleRunEvent(type, run) {
  if (type === 'login.screenshot') {
    appendEvent(type, run);
    appendScreenshotArtifact(run);
    return;
  }

  appendEvent(type, run);
  updateRunView(run);

  if (type === 'login.waiting_input' || run?.status === 'waiting_input') {
    phaseOneEndedAt = phaseOneEndedAt || performance.now();
    otpForm.classList.remove('hidden');
    otpSubmitButton.disabled = false;
  }

  if (run?.status === 'running') {
    otpSubmitButton.disabled = true;
  }

  if (type === 'login.completed') {
    if (activeOperation === 'otp') {
      phaseTwoEndedAt = phaseTwoStartedAt ? performance.now() : 0;
    }
    phaseOneEndedAt = phaseOneEndedAt || performance.now();
    setConnectionStatus('completed');
    activeOperation = '';
    closeEvents();
    stopTimerLoop();
    renderTimers();
    refreshRuns();
  }

  if (type === 'login.failed') {
    if (activeOperation === 'otp') {
      phaseTwoEndedAt = phaseTwoStartedAt ? performance.now() : 0;
    }
    phaseOneEndedAt = phaseOneEndedAt || performance.now();
    setConnectionStatus('failed');
    activeOperation = '';
    closeEvents();
    stopTimerLoop();
    renderTimers();
    refreshRuns();
  }
}

function openEvents(eventsUrl) {
  closeEvents();
  setConnectionStatus('connecting');
  eventSource = new EventSource(eventsUrl);
  eventSource.onopen = () => setConnectionStatus('connected');
  eventSource.onerror = () => {
    if (!eventSource || eventSource.readyState === EventSource.CLOSED) {
      return;
    }
    setConnectionStatus('reconnecting');
  };

  for (const type of listenedEvents) {
    eventSource.addEventListener(type, event => {
      handleRunEvent(type, JSON.parse(event.data));
    });
  }
}

function resetDemo() {
  closeEvents();
  stopTimerLoop();
  activeRun = null;
  eventCount = 0;
  totalStartedAt = 0;
  phaseOneStartedAt = 0;
  phaseOneEndedAt = 0;
  phaseTwoStartedAt = 0;
  phaseTwoEndedAt = 0;
  activeOperation = '';
  screenshots = [];
  screenshotIndex = 0;
  knownRuns = [];
  eventLog.textContent = '';
  eventCountOutput.textContent = '0 events';
  latestEventOutput.textContent = '-';
  otpForm.classList.add('hidden');
  otpForm.reset();
  otpSubmitButton.disabled = false;
  updateRunView(null);
  setPayload('empty', {});
  setConnectionStatus('idle');
  startButton.disabled = false;
  renderTimers();
  renderScreenshot();
  refreshRuns();
}

async function readJson(response) {
  const text = await response.text();
  if (!text) {
    return {};
  }
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      'content-type': 'application/json',
      ...(options.headers || {}),
    },
    ...options,
  });
  const body = await readJson(response);
  if (!response.ok) {
    const message = body?.message || `Request failed with ${response.status}`;
    throw new Error(message);
  }
  return body;
}

loginForm.addEventListener('submit', async event => {
  event.preventDefault();
  resetDemo();
  startButton.disabled = true;

  const form = new FormData(loginForm);
  const payload = {
    customerId: String(form.get('customerId') || '').trim(),
    targetUrl: String(form.get('targetUrl') || '').trim(),
    username: String(form.get('username') || '').trim(),
    password: String(form.get('password') || ''),
    otpDeliverySelection: String(form.get('otpDeliverySelection') || 'email').trim(),
  };

  totalStartedAt = performance.now();
  phaseOneStartedAt = totalStartedAt;
  activeOperation = 'login';
  startTimerLoop();

  try {
    const accepted = await requestJson('/v1/logins', {
      method: 'POST',
      body: JSON.stringify(payload),
    });

    updateRunView(accepted);
    appendEvent('login.accepted', accepted);
    refreshRuns();
    openEvents(accepted.eventsUrl);
  } catch (error) {
    activeOperation = '';
    phaseOneEndedAt = performance.now();
    stopTimerLoop();
    setConnectionStatus('failed');
    setPayload('request failed', {
      message: error.message,
    });
  } finally {
    startButton.disabled = false;
    renderTimers();
  }
});

otpForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!activeRun?.runId || otpSubmitButton.disabled) {
    return;
  }

  const code = String(new FormData(otpForm).get('code') || '').trim();
  if (!code) {
    return;
  }

  otpSubmitButton.disabled = true;
  activeOperation = 'otp';
  phaseTwoStartedAt = performance.now();
  phaseTwoEndedAt = 0;
  startTimerLoop();

  try {
    const accepted = await requestJson(`/v1/logins/${encodeURIComponent(activeRun.runId)}/otp`, {
      method: 'POST',
      body: JSON.stringify({ code }),
    });
    updateRunView(accepted);
    appendEvent('otp.accepted', accepted);
    refreshRuns();
  } catch (error) {
    activeOperation = '';
    otpSubmitButton.disabled = false;
    setConnectionStatus('failed');
    setPayload('otp request failed', {
      message: error.message,
    });
  }
});

pollButton.addEventListener('click', async () => {
  if (!activeRun?.runId) {
    return;
  }
  try {
    const run = await requestJson(`/v1/logins/${encodeURIComponent(activeRun.runId)}`);
    updateRunView(run);
    appendEvent('poll.result', run);
    refreshScreenshots();
  } catch (error) {
    setPayload('poll failed', {
      message: error.message,
    });
  }
});

reconnectButton.addEventListener('click', async () => {
  if (!activeRun?.runId || reconnectButton.disabled) {
    return;
  }

  activeOperation = 'reconnect';
  reconnectButton.disabled = true;

  try {
    const accepted = await requestJson(`/v1/logins/${encodeURIComponent(activeRun.runId)}/reconnect`, {
      method: 'POST',
      body: JSON.stringify({}),
    });
    updateRunView(accepted);
    appendEvent('reconnect.accepted', accepted);
    refreshRuns();
    openEvents(accepted.eventsUrl);
  } catch (error) {
    activeOperation = '';
    reconnectButton.disabled = false;
    setPayload('reconnect failed', {
      message: error.message,
    });
  }
});

runSelect.addEventListener('change', async () => {
  const runId = runSelect.value;
  if (!runId) {
    return;
  }
  try {
    const run = await requestJson(`/v1/logins/${encodeURIComponent(runId)}`);
    updateRunView(run);
    appendEvent('run.selected', run);
    refreshScreenshots();
  } catch (error) {
    setPayload('run select failed', {
      message: error.message,
    });
  }
});

resetButton.addEventListener('click', resetDemo);
previousScreenshot.addEventListener('click', () => {
  if (screenshots.length <= 1) {
    return;
  }
  screenshotIndex = (screenshotIndex - 1 + screenshots.length) % screenshots.length;
  renderScreenshot();
});
nextScreenshot.addEventListener('click', () => {
  if (screenshots.length <= 1) {
    return;
  }
  screenshotIndex = (screenshotIndex + 1) % screenshots.length;
  renderScreenshot();
});
window.addEventListener('beforeunload', closeEvents);
resetDemo();
