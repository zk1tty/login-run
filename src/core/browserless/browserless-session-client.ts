import type {
  BrowserlessConnectOptions,
  BrowserlessPayload,
  BrowserlessSessionPayload,
  BrowserlessSessionRecord,
  BrowserlessSessionShape,
  BrowserlessStopOptions,
} from './types';

const {
  BrowserlessSession,
  normalizeSessionPayload,
  stopBrowserlessSession,
  buildConnectEndpoint,
  redactUrlSecretParams,
} = require('./browserless-session.ts');

type BrowserlessSessionClientInput = {
  sessionApiUrl?: string;
  payload?: BrowserlessPayload | Record<string, unknown>;
  session?: BrowserlessSessionShape | Record<string, unknown>;
  rawResponse?: unknown;
};
type BrowserlessSessionLike = {
  sessionApiUrl?: string;
  session?: BrowserlessSessionShape | BrowserlessSessionPayload | Record<string, unknown>;
  payload?: BrowserlessPayload | Record<string, unknown>;
  rawResponse?: unknown;
};

function toNonNegativeInt(value: unknown, fallback = 0): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(0, Math.trunc(parsed));
}

function buildDefaultsFromPayload(payload: unknown): { ttlMs: number; processKeepAliveMs: number } {
  const source = payload && typeof payload === 'object' ? (payload as Record<string, unknown>) : {};
  return {
    ttlMs: toNonNegativeInt(source.ttl, 0),
    processKeepAliveMs: toNonNegativeInt(source.processKeepAlive, 0),
  };
}

class BrowserlessSessionClient {
  sessionApiUrl: string;
  payload: BrowserlessPayload;
  session: BrowserlessSessionPayload;
  rawResponse: unknown;

  constructor(input: BrowserlessSessionClientInput = {}) {
    const payload = input.payload && typeof input.payload === 'object'
      ? input.payload as BrowserlessPayload
      : {};
    const normalized = normalizeSessionPayload(input.session || {}, buildDefaultsFromPayload(payload));

    this.sessionApiUrl = String(input.sessionApiUrl || '').trim();
    this.payload = payload;
    this.session = normalized;
    this.rawResponse = input.rawResponse || null;
  }

  static async create(input: Record<string, unknown> = {}): Promise<BrowserlessSessionClient> {
    const created = await (BrowserlessSession as any).create(input);
    return BrowserlessSessionClient.fromBrowserlessSession(created);
  }

  static fromBrowserlessSession(browserlessSession: BrowserlessSessionLike | BrowserlessSessionRecord): BrowserlessSessionClient {
    return new BrowserlessSessionClient({
      sessionApiUrl: String((browserlessSession as any).sessionApiUrl || '').trim(),
      session: (browserlessSession as any).session,
      payload: (browserlessSession as any).payload || {},
      rawResponse: (browserlessSession as any).rawResponse || null,
    });
  }

  static fromCheckpoint(session: BrowserlessSessionShape | Record<string, unknown> = {}): BrowserlessSessionClient {
    const sessionPayload = typeof session === 'object' && session ? session : {};
    const payloadValue =
      (sessionPayload as { payload?: BrowserlessPayload }).payload;

    return new BrowserlessSessionClient({
      session,
      payload: (payloadValue && typeof payloadValue === 'object') ? payloadValue : {},
    });
  }

  get connectUrl(): string {
    return this.session.connect || '';
  }

  get stopUrl(): string {
    return this.session.stop || '';
  }

  get id(): string {
    return this.session.id || '';
  }

  get ttlMs(): number {
    return this.session.ttlMs || 0;
  }

  get processKeepAliveMs(): number {
    return this.session.processKeepAliveMs || 0;
  }

  hasConnect(): boolean {
    return Boolean(this.connectUrl);
  }

  getConnectEndpoint(input: BrowserlessConnectOptions = {}): string {
    return this.connectUrl ? buildConnectEndpoint(this.connectUrl, input) : '';
  }

  toSessionPayload(): BrowserlessSessionPayload {
    return {
      id: this.session.id || '',
      connect: this.session.connect || '',
      stop: this.session.stop || '',
      ttlMs: this.session.ttlMs || 0,
      processKeepAliveMs: this.session.processKeepAliveMs || 0,
    };
  }

  toRecord(): BrowserlessSessionRecord {
    return {
      sessionApiUrl: this.sessionApiUrl,
      payload: this.payload,
      session: this.toSessionPayload(),
      rawResponse: this.rawResponse,
    };
  }

  async stop(input: BrowserlessStopOptions = {}): Promise<void> {
    if (!this.stopUrl) {
      return;
    }
    await stopBrowserlessSession(this.stopUrl, input);
  }

  toRuntimeRedactedLogUrl(): string {
    return this.connectUrl ? redactUrlSecretParams(this.connectUrl) : '';
  }
}

module.exports = {
  BrowserlessSessionClient,
};
