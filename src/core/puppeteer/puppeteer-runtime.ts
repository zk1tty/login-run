import type {
  PuppeteerConnectInput,
  PuppeteerRuntimeInput,
  PuppeteerRuntimeRecord,
  PuppeteerNavigationOptions,
  PuppeteerBrowserLike,
  PuppeteerPageLike,
  PuppeteerPageAdapterLike,
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

async function pickActivePage(browser: PuppeteerBrowserLike): Promise<PuppeteerPageLike> {
  const pages = typeof browser.pages === 'function' ? await browser.pages() : [];
  if (Array.isArray(pages) && pages.length > 0 && pages[0]) {
    return pages[0];
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
    const page = await pickActivePage(browser);
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
