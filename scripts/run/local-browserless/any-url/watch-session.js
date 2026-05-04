const {
  fetchJson,
  getHostedDevtoolsFrontendUrl,
  getHttpVersionEndpoint,
  getJsonListUrl,
  getSessionsApiUrl,
  normalizeDevtoolsFrontendUrl,
  normalizeWsUrl,
} = require('../../../lib/helpers');

function getWsFromDevtoolsFrontendUrl(devtoolsFrontendUrl) {
  if (!devtoolsFrontendUrl) {
    return '';
  }

  const url = new URL(devtoolsFrontendUrl);
  const ws = url.searchParams.get('ws');

  if (!ws) {
    return '';
  }

  return ws.startsWith('ws://') || ws.startsWith('wss://') ? ws : `ws://${ws}`;
}

function pickSessions(sessions) {
  const match = (process.env.WATCH_SESSION_MATCH || '').toLowerCase();
  const filtered = sessions.filter(session => session.type === 'page');

  if (!match) {
    return filtered;
  }

  return filtered.filter(session => {
    const haystack = [
      session.id,
      session.browserId,
      session.title,
      session.url,
    ]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();

    return haystack.includes(match);
  });
}

function findMatchingJsonTarget(session, jsonList, jsonTargetsById) {
  const directMatch = jsonTargetsById.get(session.id);

  if (directMatch) {
    return directMatch;
  }

  if (jsonList.length === 1) {
    return jsonList[0];
  }

  return jsonList.find(target => {
    return target.title === session.title && target.url === session.url;
  }) || {};
}

function mergePageSession(session, jsonList, jsonTargetsById, debuggerVersion) {
  const target = findMatchingJsonTarget(session, jsonList, jsonTargetsById);
  const pageWebSocketDebuggerUrl = normalizeWsUrl(session.webSocketDebuggerUrl || target.webSocketDebuggerUrl || '');
  const hostedDevtoolsUrl = getHostedDevtoolsFrontendUrl(debuggerVersion, pageWebSocketDebuggerUrl);

  return {
    id: session.id,
    browserId: session.browserId || '',
    title: session.title || target.title || '',
    url: session.url || target.url || '',
    hostedDevtoolsFrontendUrl: hostedDevtoolsUrl,
    browserlessAdvertisedDevtoolsUrl: target.devtoolsFrontendUrl || '',
    localDevtoolsFrontendUrl: normalizeDevtoolsFrontendUrl(session.devtoolsFrontendUrl || ''),
    pageWebSocketDebuggerUrl: getWsFromDevtoolsFrontendUrl(hostedDevtoolsUrl) || pageWebSocketDebuggerUrl,
    browserWebSocketDebuggerUrl: normalizeWsUrl(session.browserWSEndpoint || ''),
  };
}

async function main() {
  const [sessions, jsonList, version] = await Promise.all([
    fetchJson(getSessionsApiUrl()),
    fetchJson(getJsonListUrl()),
    fetchJson(getHttpVersionEndpoint()),
  ]);
  const debuggerVersion = version['Debugger-Version'] || '';
  const jsonTargetsById = new Map(jsonList.map(target => [target.id, target]));
  const pageSessions = pickSessions(sessions).map(session => mergePageSession(session, jsonList, jsonTargetsById, debuggerVersion));

  if (pageSessions.length === 0) {
    console.log('No active page sessions found.');
    console.log('Sessions API:', getSessionsApiUrl());
    console.log('JSON targets:', getJsonListUrl());
    if (process.env.WATCH_SESSION_MATCH) {
      console.log('Filter:', process.env.WATCH_SESSION_MATCH);
    }
    return;
  }

  console.log(`Active page sessions: ${pageSessions.length}`);
  console.log('Sessions API:', getSessionsApiUrl());

  for (const [index, session] of pageSessions.entries()) {
    console.log('');
    console.log(`Session ${index + 1}`);
    console.log('Page ID:', session.id);
    if (session.browserId) {
      console.log('Browser ID:', session.browserId);
    }
    console.log('Title:', session.title || '(untitled)');
    console.log('URL:', session.url || '(unknown)');
    if (session.hostedDevtoolsFrontendUrl) {
      console.log('DevTools URL:', session.hostedDevtoolsFrontendUrl);
    }
    if (session.browserlessAdvertisedDevtoolsUrl) {
      console.log('Advertised DevTools URL:', session.browserlessAdvertisedDevtoolsUrl);
    }
    if (session.localDevtoolsFrontendUrl) {
      console.log('Local DevTools URL:', session.localDevtoolsFrontendUrl);
    }
    if (session.pageWebSocketDebuggerUrl) {
      console.log('Page CDP URL:', session.pageWebSocketDebuggerUrl);
    }
    if (session.browserWebSocketDebuggerUrl) {
      console.log('Browser CDP URL:', session.browserWebSocketDebuggerUrl);
    }
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
