const { getCdpEndpoint } = require('../config/browserless-runtime-config');
const { BrowserlessSession } = require('./browserless-session');

const DEFAULT_ROUTE = '/stealth';

function withRouteAndParams(endpoint, input = {}) {
  const route = String(input.route || '').trim();
  const solveCaptchas = input.solveCaptchas;

  const url = new URL(endpoint);
  if (route) {
    url.pathname = route.startsWith('/') ? route : `/${route}`;
  }
  if (solveCaptchas != null) {
    url.searchParams.set('solveCaptchas', String(Boolean(solveCaptchas)));
  }
  return url.toString();
}

function normalizeConnectionMode(value) {
  const mode = String(value || 'direct_auto').trim().toLowerCase();
  if (mode === 'direct_auto' || mode === 'persistent_session' || mode === 'session_resume') {
    return mode;
  }
  throw new Error('LOGIN_CONNECTION_MODE must be direct_auto, persistent_session, or session_resume.');
}

function getBrowserlessTimeoutParam(input = {}) {
  if (input.timeout != null && input.timeout !== '') {
    return String(input.timeout);
  }
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

class DirectCdpConnection {
  constructor(input = {}) {
    this.baseEndpoint = String(input.baseEndpoint || getCdpEndpoint());
    this.route = String(input.route || DEFAULT_ROUTE).trim() || DEFAULT_ROUTE;
    this.solveCaptchas = input.solveCaptchas !== false;
  }

  get endpoint() {
    return withRouteAndParams(this.baseEndpoint, {
      route: this.route,
      solveCaptchas: this.solveCaptchas,
    });
  }

  toRecord() {
    return {
      connectionMode: 'direct_auto',
      endpoint: this.endpoint,
      session: null,
      solveCaptchas: this.solveCaptchas,
      captchaSolveMode: 'auto',
      cdpConnectionKind: 'direct-cdp:auto',
      sessionCreated: false,
      resource: this,
    };
  }
}

class LoginConnectionFactory {
  async create(input = {}) {
    const phase = String(input.phase || '1').trim();
    const mode = normalizeConnectionMode(input.connectionMode || process.env.LOGIN_CONNECTION_MODE);
    const route = String(input.route || DEFAULT_ROUTE).trim() || DEFAULT_ROUTE;
    const checkpoint = input.checkpoint || null;

    if (phase === '2' || mode === 'session_resume') {
      const session = checkpoint?.session || null;
      if (!session?.connect) {
        throw new Error('Checkpoint is missing session.connect; rerun LOGIN_PHASE=1.');
      }
      return {
        connectionMode: 'session_resume',
        endpoint: String(session.connect),
        session,
        solveCaptchas: false,
        captchaSolveMode: 'manual',
        cdpConnectionKind: 'session-resume',
        sessionCreated: false,
        resource: null,
      };
    }

    if (mode === 'persistent_session') {
      const browserlessSession = await BrowserlessSession.create({
        httpBase: input.httpBase,
        token: input.token,
        ttlMs: input.ttlMs,
        stealth: input.stealth,
        processKeepAliveMs: input.processKeepAliveMs,
        browser: input.browser,
        rawPayload: input.rawPayload,
        proxyOverride: input.proxyOverride,
      });
      const timeout = getBrowserlessTimeoutParam(input);
      return {
        connectionMode: 'persistent_session',
        endpoint: browserlessSession.buildConnectEndpoint({
          solveMode: 'manual',
          timeout,
        }),
        session: browserlessSession.session,
        sessionApiUrl: browserlessSession.sessionApiUrl,
        sessionPayload: browserlessSession.payload,
        solveCaptchas: false,
        captchaSolveMode: 'manual',
        cdpConnectionKind: 'session-api:manual-solve',
        sessionCreated: true,
        resource: browserlessSession,
      };
    }

    const directConnection = new DirectCdpConnection({
      baseEndpoint: input.baseEndpoint,
      route,
      solveCaptchas: input.solveCaptchas,
    });
    return directConnection.toRecord();
  }
}

async function resolveLoginConnection(input = {}) {
  const factory = new LoginConnectionFactory();
  return factory.create(input);
}

module.exports = {
  DEFAULT_ROUTE,
  DirectCdpConnection,
  LoginConnectionFactory,
  normalizeConnectionMode,
  resolveLoginConnection,
  withRouteAndParams,
};
