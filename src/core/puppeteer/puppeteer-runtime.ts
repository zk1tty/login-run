import type {
  PuppeteerConnectInput,
  PuppeteerRuntimeInput,
  PuppeteerRuntimeRecord,
  PuppeteerNavigationOptions,
  PuppeteerBrowserLike,
  PuppeteerPageLike,
  PuppeteerPageAdapterLike,
  PuppeteerPageSelectionCandidate,
  PuppeteerPageSelectionInput,
} from './types';

const { adaptPuppeteerPage }: {
  adaptPuppeteerPage: (page: PuppeteerPageLike | null) => PuppeteerPageAdapterLike | null;
} = require('./page-adapter.ts');
const { redactUrlSecretParams }: {
  redactUrlSecretParams: (urlString: string | null | undefined) => string;
} = require('../browserless/browserless-session');

type PuppeteerConnectOptions = Required<Pick<PuppeteerConnectInput, 'endpoint'>> & PuppeteerConnectInput;
type PuppeteerLike = {
  connect: (input: {
    browserWSEndpoint: string;
    protocolTimeout: number;
    defaultViewport: null;
  }) => Promise<PuppeteerBrowserLike>;
};

function toInt(value: unknown, fallback: number, minimum = 0): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(minimum, Math.trunc(parsed));
}

function toErrorMessage(error: unknown): string {
  return String((error as { message?: unknown })?.message || error || 'unknown_error');
}

function isDetachedFrameNavigationError(error: unknown): boolean {
  return /navigating frame was detached|frame was detached/i.test(toErrorMessage(error));
}

function loadPuppeteer(input: PuppeteerConnectInput = {}): PuppeteerLike {
  if (input.puppeteer) {
    return input.puppeteer as PuppeteerLike;
  }

  try {
    return require('puppeteer-core') as PuppeteerLike;
  } catch {
    throw new Error(
      'Missing dependency: puppeteer-core. Install it with `npm install puppeteer-core`.'
    );
  }
}

function isLikelyPageObject(value: unknown): value is PuppeteerPageLike {
  return typeof value === 'object' && value !== null;
}

function normalizeUrlForExactMatch(value: unknown): string {
  return String(value || '').trim();
}

function normalizeUrlForPathMatch(value: unknown): string {
  const raw = String(value || '').trim();
  if (!raw || raw === 'about:blank') {
    return raw;
  }

  try {
    const url = new URL(raw);
    return `${url.origin}${url.pathname}${url.search}`;
  } catch {
    return raw.replace(/#.*$/, '');
  }
}

async function safePageUrl(page: PuppeteerPageLike): Promise<string> {
  try {
    if (typeof page.url === 'function') {
      return String(await page.url());
    }
    return String(page.url || '');
  } catch {
    return '';
  }
}

async function safePageTitle(page: PuppeteerPageLike): Promise<string> {
  try {
    if (typeof page.title === 'function') {
      return String(await page.title());
    }
    return String(page.title || '');
  } catch {
    return '';
  }
}

function safeTargetId(page: PuppeteerPageLike): string {
  try {
    const target = page.target?.();
    if (!target) {
      return '';
    }
    if (typeof target.targetId === 'function') {
      return String(target.targetId() || '');
    }
    return String(target._targetId || '');
  } catch {
    return '';
  }
}

async function hasExpectedSelector(
  page: PuppeteerPageLike,
  expectedSelector: string
): Promise<boolean> {
  if (!expectedSelector || typeof page.evaluate !== 'function') {
    return false;
  }

  try {
    return Boolean(await page.evaluate(selector => {
      const globalContext = globalThis as unknown as {
        document?: {
          querySelector?: (selector: string) => unknown;
        };
      };
      return Boolean(globalContext.document?.querySelector?.(String(selector || '')));
    }, expectedSelector));
  } catch {
    return false;
  }
}

function scorePageCandidate(input: {
  url: string;
  title: string;
  targetId: string;
  expectedSelectorFound: boolean;
  preferredUrl: string;
  preferredTargetId: string;
}): Omit<PuppeteerPageSelectionCandidate, 'index' | 'expectedSelector'> {
  const preferredUrl = normalizeUrlForExactMatch(input.preferredUrl);
  const candidateUrl = normalizeUrlForExactMatch(input.url);
  const exactUrlMatch = Boolean(preferredUrl && candidateUrl && preferredUrl === candidateUrl);
  const samePathMatch = Boolean(
    preferredUrl &&
      candidateUrl &&
      normalizeUrlForPathMatch(preferredUrl) === normalizeUrlForPathMatch(candidateUrl)
  );
  const targetIdMatch = Boolean(
    input.preferredTargetId &&
      input.targetId &&
      input.preferredTargetId === input.targetId
  );
  const isBlank = !candidateUrl || candidateUrl === 'about:blank';
  let score = 0;

  if (targetIdMatch) {
    score += 1000;
  }
  if (exactUrlMatch) {
    score += 800;
  } else if (samePathMatch) {
    score += 450;
  }
  if (input.expectedSelectorFound) {
    score += 650;
  }
  if (!isBlank) {
    score += 80;
  } else {
    score -= 100;
  }
  if (input.title) {
    score += 10;
  }

  return {
    url: candidateUrl,
    title: input.title,
    targetId: input.targetId,
    expectedSelectorFound: input.expectedSelectorFound,
    exactUrlMatch,
    samePathMatch,
    targetIdMatch,
    isBlank,
    score,
  };
}

async function inspectPageCandidate(
  page: PuppeteerPageLike,
  index: number,
  input: PuppeteerPageSelectionInput
): Promise<PuppeteerPageSelectionCandidate> {
  const expectedSelector = String(input.expectedSelector || '').trim();
  const url = await safePageUrl(page);
  const title = await safePageTitle(page);
  const targetId = safeTargetId(page);
  const expectedSelectorFound = await hasExpectedSelector(page, expectedSelector);
  const scored = scorePageCandidate({
    url,
    title,
    targetId,
    expectedSelectorFound,
    preferredUrl: String(input.preferredUrl || '').trim(),
    preferredTargetId: String(input.preferredTargetId || '').trim(),
  });

  return {
    index,
    expectedSelector,
    ...scored,
  };
}

async function pickActivePage(
  browser: PuppeteerBrowserLike,
  input: PuppeteerPageSelectionInput = {}
): Promise<PuppeteerPageLike> {
  const pages = typeof browser.pages === 'function' ? await browser.pages() : [];
  if (Array.isArray(pages) && pages.length > 0) {
    const candidates = await Promise.all(
      pages.map((page, index) => inspectPageCandidate(page, index, input))
    );
    try {
      input.onPageCandidates?.(candidates);
    } catch {
      // Candidate diagnostics must not affect browser reconnect.
    }

    const sorted = candidates
      .map((candidate, index) => ({ candidate, page: pages[index] }))
      .filter(item => Boolean(item.page))
      .sort((left, right) => {
        const scoreDelta = right.candidate.score - left.candidate.score;
        if (scoreDelta !== 0) {
          return scoreDelta;
        }
        return left.candidate.index - right.candidate.index;
      });

    if (sorted[0]?.page) {
      return sorted[0].page;
    }
  }
  if (typeof browser.newPage !== 'function') {
    throw new Error('Puppeteer browser did not expose pages() or newPage().');
  }
  return browser.newPage();
}

class PuppeteerRuntime {
  endpoint: string;
  browser: PuppeteerBrowserLike | null;
  page: PuppeteerPageLike | null;
  cdp: unknown;
  connectTimeoutMs: number;
  private _driverPage: PuppeteerPageAdapterLike | null;
  private _endpoint: string;

  constructor(input: PuppeteerRuntimeInput = {}) {
    this.endpoint = String(input.endpoint || '');
    this.browser = input.browser || null;
    this.page = input.page || null;
    this.cdp = input.cdp || null;
    this.connectTimeoutMs = toInt(input.connectTimeoutMs, 60000, 1000);
    this._driverPage = input.driverPage || null;
    this._endpoint = String(input.endpoint || '');
  }

  static async connect(input: PuppeteerConnectInput = {}): Promise<PuppeteerRuntime> {
    const rawEndpoint = String(input.endpoint || '').trim();
    if (!rawEndpoint) {
      throw new Error('PuppeteerRuntime.connect requires an endpoint.');
    }

    const puppeteer = loadPuppeteer(input);
    const browser = await puppeteer.connect({
      browserWSEndpoint: rawEndpoint,
      protocolTimeout: toInt(input.connectTimeoutMs, 60000, 1000),
      defaultViewport: null,
    });
    const page = await pickActivePage(browser, {
      preferredUrl: input.preferredUrl,
      preferredTargetId: input.preferredTargetId,
      expectedSelector: input.expectedSelector,
      onPageCandidates: input.onPageCandidates,
    });
    const target = page.target?.();
    if (!target || typeof target.createCDPSession !== 'function') {
      throw new Error('Puppeteer page did not expose target().createCDPSession().');
    }
    const cdp = await target.createCDPSession();

    return new PuppeteerRuntime({
      endpoint: rawEndpoint,
      browser,
      page,
      cdp,
      connectTimeoutMs: input.connectTimeoutMs,
      driverPage: null,
    });
  }

  getDriverPage() {
    if (!this._driverPage && isLikelyPageObject(this.page)) {
      this._driverPage = adaptPuppeteerPage(this.page);
    }
    return this._driverPage;
  }

  getPage(): PuppeteerPageLike | null {
    return this.page;
  }

  getBrowser(): PuppeteerBrowserLike | null {
    return this.browser;
  }

  getCDP(): unknown {
    return this.cdp;
  }

  getConnectTimeoutMs(): number {
    return this.connectTimeoutMs;
  }

  async getCurrentUrl(): Promise<string> {
    if (!this.page) {
      return '';
    }
    if (typeof this.page.url === 'function') {
      return this.page.url();
    }
    return String(this.page.url || '');
  }

  async getCurrentTitle(): Promise<string> {
    if (!this.page) {
      return '';
    }
    if (typeof this.page.title === 'function') {
      return this.page.title();
    }
    return String(this.page.title || '');
  }

  async navigate(url: string, options: PuppeteerNavigationOptions = {}): Promise<unknown> {
    if (!this.page || typeof this.page.goto !== 'function') {
      throw new Error('Puppeteer runtime has no active page.');
    }
    try {
      return await this.page.goto(url, options);
    } catch (error) {
      if (!isDetachedFrameNavigationError(error) || !this.browser || typeof this.browser.pages !== 'function') {
        throw error;
      }

      this.page = await pickActivePage(this.browser);
      this._driverPage = null;
      return null;
    }
  }

  async listPages(): Promise<PuppeteerPageLike[]> {
    if (!this.browser || typeof this.browser.pages !== 'function') {
      return [];
    }
    try {
      const pages = await this.browser.pages();
      return Array.isArray(pages) ? pages : [];
    } catch {
      return [];
    }
  }

  toRecord(): PuppeteerRuntimeRecord {
    return {
      runtime: 'puppeteer-runtime',
      endpoint: redactUrlSecretParams(this.endpoint),
      hasBrowser: Boolean(this.browser),
      hasPage: Boolean(this.page),
      hasCdp: Boolean(this.cdp),
      connectTimeoutMs: this.connectTimeoutMs,
    };
  }

  async close(): Promise<void> {
    if (this.browser && typeof this.browser.close === 'function') {
      await this.browser.close();
    }
  }

  async disconnect(): Promise<void> {
    if (this.browser && typeof this.browser.disconnect === 'function') {
      this.browser.disconnect();
    }
  }
}

export { PuppeteerRuntime, isDetachedFrameNavigationError, loadPuppeteer, pickActivePage };
