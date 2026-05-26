export type BrowserlessEnv = {
  BROWSERLESS_TOKEN?: string;
  BROWSERLESS_PROXY?: string;
  BROWSERLESS_PROXY_COUNTRY?: string;
  BROWSERLESS_PROXY_CITY?: string;
  BROWSERLESS_PROXY_PRESET?: string;
  BROWSERLESS_PROXY_STICKY?: string;
  SESSION_API_PAYLOAD_JSON?: string;
  SESSION_API_TTL_MS?: string;
  SESSION_API_STEALTH?: string;
  SESSION_API_PROCESS_KEEP_ALIVE_MS?: string;
};

export type BrowserlessHttpBaseConfig = {
  httpBase?: string;
  token?: string;
  connectEndpoint?: string;
};

export type BrowserlessPayload = {
  ttl?: number | string;
  stealth?: boolean | string;
  processKeepAlive?: number | string;
  browser?: string;
  proxy?: BrowserlessProxyShape;
  rawPayload?: string;
};

export type BrowserlessProxyShape = {
  type: string;
  country?: string;
  city?: string;
  preset?: string;
  sticky?: boolean;
};

export type BrowserlessSessionShape = {
  id?: string;
  sessionId?: string;
  connect?: string;
  connectUrl?: string;
  connectURL?: string;
  browserWSEndpoint?: string;
  connectEndpoint?: string;
  stop?: string;
  stopUrl?: string;
  stopURL?: string;
  killURL?: string;
  ttl?: number | string;
  ttlMs?: number | string;
  processKeepAlive?: number | string;
  processKeepAliveMs?: number | string;
  payload?: unknown;
};

export type BrowserlessConnectOptions = {
  solveMode?: 'manual' | 'auto' | 'none';
  timeout?: number | string;
  replay?: boolean;
};

export type BrowserlessSessionOptions = {
  httpBase?: string;
  token?: string;
  ttlMs?: number | string;
  stealth?: boolean;
  processKeepAliveMs?: number | string;
  browser?: string;
  proxyOverride?: BrowserlessProxyShape | null;
  rawPayload?: string;
};

export type BrowserlessStopOptions = {
  maxAttempts?: number | string;
  delayMs?: number | string;
  force?: boolean;
};

export type BrowserlessSessionRecord = {
  sessionApiUrl: string;
  payload: BrowserlessPayload | Record<string, unknown>;
  session: BrowserlessSessionPayload;
  rawResponse: unknown;
};

export type BrowserlessSessionPayload = {
  id: string;
  connect: string;
  stop: string;
  ttlMs: number;
  processKeepAliveMs: number;
};

export type BrowserlessCreateInput = {
  httpBase?: string;
  token?: string;
  ttlMs?: number | string;
  stealth?: boolean;
  processKeepAliveMs?: number | string;
  browser?: string;
  proxyOverride?: BrowserlessProxyShape | null;
  rawPayload?: string;
  ttl?: number | string;
  stealthMode?: boolean;
  payload?: BrowserlessPayload | Record<string, unknown>;
  session?: BrowserlessSessionShape;
  sessionApiUrl?: string;
  rawResponse?: unknown;
};

export type SessionTargetConfig = {
  sessionPayload?: BrowserlessPayload | Record<string, unknown>;
  session?: BrowserlessSessionShape;
  sessionApiUrl?: string;
  rawResponse?: unknown;
};
