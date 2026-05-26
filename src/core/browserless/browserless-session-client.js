const {
  BrowserlessSession,
  buildConnectEndpoint,
  normalizeSessionPayload,
  stopBrowserlessSession,
  redactUrlSecretParams,
} = require('./browserless-session');

function toNonNegativeInt(value, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(0, Math.trunc(parsed));
}

function buildDefaultsFromPayload(payload = {}) {
  return {
    ttlMs: toNonNegativeInt(payload.ttl, 0, 0),
    processKeepAliveMs: toNonNegativeInt(payload.processKeepAlive, 0, 0),
  };
}

class BrowserlessSessionClient {
  constructor(input = {}) {
    const payload = input.payload || {};
    const normalized = normalizeSessionPayload(input.session || {}, buildDefaultsFromPayload(payload));
    this.sessionApiUrl = String(input.sessionApiUrl || '').trim();
    this.payload = payload;
    this.session = normalized;
    this.rawResponse = input.rawResponse || null;
  }

  static async create(input = {}) {
    const created = await BrowserlessSession.create(input);
    return BrowserlessSessionClient.fromBrowserlessSession(created);
  }

  static fromBrowserlessSession(browserlessSession = {}) {
    return new BrowserlessSessionClient({
      sessionApiUrl: String(browserlessSession.sessionApiUrl || '').trim(),
      session: browserlessSession.session || {},
      payload: browserlessSession.payload || {},
      rawResponse: browserlessSession.rawResponse || null,
    });
  }

  static fromCheckpoint(session = {}) {
    return new BrowserlessSessionClient({
      session,
      payload: session.payload || {},
    });
  }

  get connectUrl() {
    return this.session.connect || '';
  }

  get stopUrl() {
    return this.session.stop || '';
  }

  get id() {
    return this.session.id || '';
  }

  get ttlMs() {
    return this.session.ttlMs || 0;
  }

  get processKeepAliveMs() {
    return this.session.processKeepAliveMs || 0;
  }

  hasConnect() {
    return Boolean(this.connectUrl);
  }

  getConnectEndpoint(input = {}) {
    return this.connectUrl ? buildConnectEndpoint(this.connectUrl, input) : '';
  }

  toSessionPayload() {
    return {
      id: this.session.id || '',
      connect: this.session.connect || '',
      stop: this.session.stop || '',
      ttlMs: this.session.ttlMs || 0,
      processKeepAliveMs: this.session.processKeepAliveMs || 0,
    };
  }

  toRecord() {
    return {
      sessionApiUrl: this.sessionApiUrl,
      payload: this.payload,
      session: this.toSessionPayload(),
      rawResponse: this.rawResponse,
    };
  }

  async stop(input = {}) {
    if (!this.stopUrl) {
      return;
    }
    await stopBrowserlessSession(this.stopUrl, input);
  }

  toRuntimeRedactedLogUrl() {
    return this.connectUrl ? redactUrlSecretParams(this.connectUrl) : '';
  }
}

module.exports = {
  BrowserlessSessionClient,
};
