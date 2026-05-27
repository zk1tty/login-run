export type PuppeteerConnectInput = {
  endpoint?: string;
  connectTimeoutMs?: number | string;
  puppeteer?: unknown;
  driverPage?: unknown;
  preferredUrl?: string;
  preferredTargetId?: string;
  expectedSelector?: string;
  onPageCandidates?: (candidates: PuppeteerPageSelectionCandidate[]) => void;
};

export type PuppeteerNavigationOptions = {
  timeout?: number;
  waitUntil?: string | string[];
};

export type PuppeteerPageLike = {
  url?: () => Promise<string> | string;
  title?: () => Promise<string> | string;
  goto?: (url: string, options?: PuppeteerNavigationOptions) => Promise<unknown>;
  target?: () => {
    createCDPSession: () => Promise<unknown>;
    _targetId?: string;
    targetId?: () => string;
  };
  evaluate?: <T = unknown>(fn: (...args: unknown[]) => T, ...args: unknown[]) => Promise<T>;
  $eval?: <R = unknown>(selector: string, pageFunction: (...args: unknown[]) => R, ...args: unknown[]) => Promise<R>;
  click?: (selector: string) => Promise<unknown>;
  focus?: (selector: string) => Promise<unknown>;
  keyboard?: { press: (key: string) => Promise<unknown> };
  mouse?: unknown;
  waitForTimeout?: (timeoutMs: number) => Promise<unknown>;
};

export type PuppeteerPageSelectionInput = {
  preferredUrl?: string;
  preferredTargetId?: string;
  expectedSelector?: string;
  onPageCandidates?: (candidates: PuppeteerPageSelectionCandidate[]) => void;
};

export type PuppeteerPageSelectionCandidate = {
  index: number;
  url: string;
  title: string;
  targetId: string;
  expectedSelector: string;
  expectedSelectorFound: boolean;
  exactUrlMatch: boolean;
  samePathMatch: boolean;
  targetIdMatch: boolean;
  isBlank: boolean;
  selected: boolean;
  selectedReason: string;
};

export type PuppeteerBrowserLike = {
  pages?: () => Promise<PuppeteerPageLike[]> | PuppeteerPageLike[];
  newPage?: () => Promise<PuppeteerPageLike>;
  close?: () => Promise<unknown>;
  disconnect?: () => void;
};

export type PuppeteerRuntimeRecord = {
  runtime: 'puppeteer-runtime';
  endpoint: string;
  hasBrowser: boolean;
  hasPage: boolean;
  hasCdp: boolean;
  connectTimeoutMs: number;
};

export type PuppeteerRuntimeInput = {
  endpoint?: string;
  browser?: PuppeteerBrowserLike | null;
  page?: PuppeteerPageLike | null;
  cdp?: unknown;
  connectTimeoutMs?: number | string;
  driverPage?: PuppeteerPageAdapterLike | null;
};

export type PuppeteerLocatorLike = {
  waitFor: (input?: { state?: string; timeout?: number | string }) => Promise<unknown>;
  evaluate: <T = unknown>(fn: (...args: unknown[]) => T, ...args: unknown[]) => Promise<T>;
  check: () => Promise<unknown>;
  click: () => Promise<unknown>;
  fill: (value: unknown) => Promise<unknown>;
  press: (key?: unknown) => Promise<unknown>;
  selectOption: (option?: unknown) => Promise<unknown>;
};

export type PuppeteerPageAdapterLike = {
  locator: (selector: string) => PuppeteerLocatorLike;
  evaluate: (fn: (...args: unknown[]) => unknown, ...args: unknown[]) => Promise<unknown>;
  waitForTimeout: (ms: number) => Promise<unknown>;
  waitForLoadState: (state: string, input?: { timeout?: number | string }) => Promise<unknown>;
  mouse?: unknown;
};

export type RuntimeAdapter = {
  endpoint: string;
  browser: PuppeteerBrowserLike | null;
  page: PuppeteerPageLike | null;
  cdp: unknown;
  connectTimeoutMs: number;
  getDriverPage: () => PuppeteerPageAdapterLike | null;
  getPage: () => PuppeteerPageLike | null;
  getBrowser: () => PuppeteerBrowserLike | null;
  getCDP: () => unknown;
  getConnectTimeoutMs: () => number;
  getCurrentUrl: () => Promise<string>;
  getCurrentTitle: () => Promise<string>;
  navigate: (url: string, options?: PuppeteerNavigationOptions) => Promise<unknown>;
  listPages: () => Promise<PuppeteerPageLike[]>;
  close: () => Promise<void>;
  disconnect: () => Promise<void> | void;
  toRecord: () => PuppeteerRuntimeRecord;
};

export type LoginFlowActionPayload = {
  stage: string;
  selector: string;
  candidate: unknown;
  terminalOutcome: string;
  type?: string;
  inputSelector?: string;
  inputCandidate?: unknown;
  submitSelector?: string;
  submitCandidate?: unknown;
  payloadKey?: string;
  typedLength?: number;
  shouldSubmit?: boolean;
  optionSelector?: string;
  optionCandidate?: unknown;
  selection?: string;
};

export type RunProbeResult = {
  phase?: string;
  targetUrl?: string;
  currentUrl?: string;
  pageTitle?: string;
  workflow?: {
    terminalOutcome?: string;
    finalStage?: {
      state?: string;
    };
    postActionStage?: {
      state?: string;
    };
  };
  capture?: {
    stage?: {
      state?: string;
      phase?: string;
      reason?: string;
      selector?: string;
    };
  };
};
