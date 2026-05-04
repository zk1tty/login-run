const { classifyPageState } = require('./page-state-classifier');

function tryParseJson(value) {
  try {
    const parsed = JSON.parse(String(value || ''));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (error) {
    return null;
  }
}

function createLiveSignals() {
  return {
    commandCounts: {},
    pageMetaEvents: [],
    tabsActiveEvents: [],
    iframeBoundsEvents: [],
  };
}

function hasVisibleIframeFrame(frames) {
  return Array.isArray(frames)
    ? frames.some(frame => {
        const bounds = frame && typeof frame === 'object' ? frame.bounds : null;
        const width = Number(bounds?.width || 0);
        const height = Number(bounds?.height || 0);
        return width > 1 && height > 1;
      })
    : false;
}

function recordLiveSignalFromWsText(liveSignals, input = {}) {
  if (!liveSignals || typeof liveSignals !== 'object') {
    return {
      command: '',
      activeTab: null,
      shouldSwitchToPreferred: false,
    };
  }

  const at = String(input.at || '');
  const preferredTargetId = String(input.preferredTargetId || '').trim();
  const parsed = tryParseJson(input.text);
  const command = String(parsed?.command || parsed?.method || '').trim();
  if (!command) {
    return {
      command: '',
      activeTab: null,
      shouldSwitchToPreferred: false,
    };
  }

  liveSignals.commandCounts[command] = (liveSignals.commandCounts[command] || 0) + 1;

  if (command === 'pageMeta') {
    liveSignals.pageMetaEvents.push({
      at,
      title: String(parsed?.data?.title || ''),
      url: String(parsed?.data?.url || ''),
    });
  }

  if (command === 'iframeBoundsUpdate') {
    const frames = Array.isArray(parsed?.data?.frames) ? parsed.data.frames : [];
    liveSignals.iframeBoundsEvents.push({
      at,
      hasVisibleFrame: hasVisibleIframeFrame(frames),
    });
  }

  if (command !== 'tabsUpdate') {
    return {
      command,
      activeTab: null,
      shouldSwitchToPreferred: false,
    };
  }

  const tabs = Array.isArray(parsed?.data?.tabs) ? parsed.data.tabs : [];
  const preferredTab = preferredTargetId
    ? tabs.find(tab => String(tab?.id || '') === preferredTargetId)
    : null;
  const currentActive = tabs.find(tab => tab?.isActive === true) || null;

  if (currentActive) {
    liveSignals.tabsActiveEvents.push({
      at,
      title: String(currentActive.title || ''),
      url: String(currentActive.url || ''),
    });
  }

  return {
    command,
    activeTab: currentActive
      ? {
          id: String(currentActive.id || ''),
          title: String(currentActive.title || ''),
          url: String(currentActive.url || ''),
        }
      : null,
    shouldSwitchToPreferred: Boolean(
      preferredTab &&
      currentActive &&
      String(currentActive.id || '') !== preferredTargetId
    ),
  };
}

function toTimelineEvent(source, event = {}) {
  return {
    at: String(event.at || ''),
    source,
    title: String(event.title || ''),
    url: String(event.url || ''),
  };
}

function parseAtLabelToMs(at) {
  const raw = String(at || '').trim();
  const match = /^(\d{2}):(\d{2}):(\d{2})\.(\d{3})$/.exec(raw);
  if (!match) {
    return Number.POSITIVE_INFINITY;
  }
  const hh = Number(match[1]);
  const mm = Number(match[2]);
  const ss = Number(match[3]);
  const ms = Number(match[4]);
  return (((hh * 60 + mm) * 60 + ss) * 1000) + ms;
}

function pushTransitionIfNew(transitions, event, lastStateRef) {
  const state = String(event?.state || '');
  const type = String(event?.turnstilePageType || '');
  const key = `${state}:${type}`;
  if (lastStateRef.value === key) {
    return;
  }
  lastStateRef.value = key;
  transitions.push({
    at: String(event?.at || ''),
    source: String(event?.source || ''),
    state,
    turnstilePageType: type,
    title: String(event?.title || ''),
    url: String(event?.url || ''),
    evidenceSource: String(event?.source || ''),
    confidence: event?.inferred === true ? 'supporting' : 'high',
  });
}

function computeTransitionMetrics(transitions = []) {
  const firstByKey = new Map();
  for (const event of transitions) {
    const key = `${event.state}:${event.turnstilePageType || ''}`;
    if (!firstByKey.has(key)) {
      firstByKey.set(key, event);
    }
  }

  const firstWaiting = firstByKey.get('challenge:waiting') || null;
  const firstCheckbox = firstByKey.get('challenge:checkbox') || null;
  const firstNeedCred = firstByKey.get('need_cred:') || null;

  const waitingAtMs = parseAtLabelToMs(firstWaiting?.at || '');
  const checkboxAtMs = parseAtLabelToMs(firstCheckbox?.at || '');
  const loginAtMs = parseAtLabelToMs(firstNeedCred?.at || '');

  return {
    firstWaitingAt: firstWaiting?.at || '',
    firstCheckboxAt: firstCheckbox?.at || '',
    firstNeedCredAt: firstNeedCred?.at || '',
    waitingToCheckboxMs:
      Number.isFinite(waitingAtMs) && Number.isFinite(checkboxAtMs)
        ? Math.max(0, checkboxAtMs - waitingAtMs)
        : null,
    waitingToLoginMs:
      Number.isFinite(waitingAtMs) && Number.isFinite(loginAtMs)
        ? Math.max(0, loginAtMs - waitingAtMs)
        : null,
  };
}

function derivePageStateFromLiveSignals(input = {}) {
  const liveSignals = input?.liveSignals && typeof input.liveSignals === 'object'
    ? input.liveSignals
    : {};
  const fallbackProbe = input?.fallbackProbe && typeof input.fallbackProbe === 'object'
    ? input.fallbackProbe
    : null;
  const pageMetaEvents = Array.isArray(liveSignals.pageMetaEvents)
    ? liveSignals.pageMetaEvents
    : [];
  const tabsActiveEvents = Array.isArray(liveSignals.tabsActiveEvents)
    ? liveSignals.tabsActiveEvents
    : [];
  const iframeBoundsEvents = Array.isArray(liveSignals.iframeBoundsEvents)
    ? liveSignals.iframeBoundsEvents
    : [];
  const timeline = [
    ...pageMetaEvents.map(event => toTimelineEvent('pageMeta', event)),
    ...tabsActiveEvents.map(event => toTimelineEvent('tabsUpdate', event)),
  ]
    .filter(event => event.title || event.url)
    .slice(0, 40);
  const classifiedTimeline = timeline.map(event => {
    const classified = classifyPageState({
      title: event.title,
      url: event.url,
      text: `${event.title} ${event.url}`,
    });
    return {
      ...event,
      state: classified.state,
      turnstilePageType: classified.turnstilePageType || '',
    };
  })
    .sort((a, b) => parseAtLabelToMs(a.at) - parseAtLabelToMs(b.at));
  const firstVisibleIframeEvent = iframeBoundsEvents.find(event => event?.hasVisibleFrame === true) || null;
  if (firstVisibleIframeEvent) {
    const nearest = classifiedTimeline.find(event => {
      const eventMs = parseAtLabelToMs(event.at);
      const iframeMs = parseAtLabelToMs(firstVisibleIframeEvent.at);
      return Number.isFinite(eventMs) && Number.isFinite(iframeMs) ? eventMs >= iframeMs : false;
    }) || classifiedTimeline[classifiedTimeline.length - 1] || null;
    if (nearest) {
      classifiedTimeline.push({
        at: String(firstVisibleIframeEvent.at || ''),
        source: 'iframeBoundsUpdate',
        title: String(nearest.title || ''),
        url: String(nearest.url || ''),
        state: 'challenge',
        turnstilePageType: 'checkbox',
        inferred: true,
      });
      classifiedTimeline.sort((a, b) => parseAtLabelToMs(a.at) - parseAtLabelToMs(b.at));
    }
  }
  const lastEvent = classifiedTimeline[classifiedTimeline.length - 1] || null;

  const transitions = [];
  const lastState = { value: '' };
  for (const event of classifiedTimeline) {
    pushTransitionIfNew(transitions, event, lastState);
  }
  const transitionMetrics = computeTransitionMetrics(transitions);

  if (!lastEvent) {
    return {
      source: fallbackProbe ? 'probe' : '',
      state: String(fallbackProbe?.state || ''),
      reason: String(
        fallbackProbe?.reason || 'No pageMeta/tabsUpdate websocket signals captured.'
      ),
      url: String(fallbackProbe?.url || ''),
      title: String(fallbackProbe?.title || ''),
      hasTurnstile: fallbackProbe?.hasTurnstile === true,
      turnstilePageType: String(fallbackProbe?.turnstilePageType || ''),
      timeline: classifiedTimeline,
      transitions,
      transitionMetrics,
      comparedWithProbe: false,
      matchesProbe: null,
    };
  }

  const latestText = `${lastEvent.title || ''} ${lastEvent.url || ''}`.trim();
  const corpus = classifiedTimeline
    .map(event => `${event.title} ${event.url}`)
    .filter(Boolean)
    .join('\n');
  let classified = classifyPageState({
    title: lastEvent.title,
    url: lastEvent.url,
    text: latestText,
  });
  if (classified.state === 'unknown' && corpus) {
    classified = classifyPageState({
      title: lastEvent.title,
      url: lastEvent.url,
      text: corpus,
    });
  }
  const probeState = String(fallbackProbe?.state || '');
  const matchesProbe = probeState ? probeState === classified.state : null;

  return {
    source: `live_ws:${lastEvent.source}`,
    state: classified.state,
    reason: classified.reason,
    url: classified.url,
    title: classified.title,
    hasTurnstile: classified.hasTurnstile === true,
    turnstilePageType: classified.turnstilePageType || '',
    timeline: classifiedTimeline,
    transitions,
    transitionMetrics,
    comparedWithProbe: Boolean(probeState),
    matchesProbe,
    probeState,
  };
}

module.exports = {
  createLiveSignals,
  recordLiveSignalFromWsText,
  derivePageStateFromLiveSignals,
};
