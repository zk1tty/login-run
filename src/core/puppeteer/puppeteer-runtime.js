const { adaptPuppeteerPage } = require('./page-adapter');

function toInt(value, fallback, minimum = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(minimum, Math.trunc(parsed));
}

function toErrorMessage(error) {
  return String(error?.message || error || 'unknown_error');
}

function loadPuppeteer(input = {}) {
  if (input.puppeteer) {
    return input.puppeteer;
  }

  try {
    return require('puppeteer-core');
  } catch {
    throw new Error(
      'Missing dependency: puppeteer-core. Install it with `npm install puppeteer-core`.'
    );
  }
}

function isLikelyPageObject(value) {
  return value && typeof value === 'object';
}

function pickActivePage(browser) {
  return (async () => {
    const pages = typeof browser.pages === 'function' ? await browser.pages() : [];
    if (Array.isArray(pages) && pages.length > 0 && pages[0]) {
      return pages[0];
    }
    if (typeof browser.newPage !== 'function') {
      throw new Error('Puppeteer browser did not expose pages() or newPage().');
    }
    return browser.newPage();
  })();
}

class PuppeteerRuntime {
  constructor(input = {}) {
    this.endpoint = String(input.endpoint || '');
    this.browser = input.browser || null;
    this.page = input.page || null;
    this.cdp = input.cdp || null;
    this.connectTimeoutMs = toInt(input.connectTimeoutMs, 60000, 1000);
    this._driverPage = input.driverPage || null;
    this._endpoint = String(input.endpoint || '');
  }

  static async connect(input = {}) {
    const endpoint = String(input.endpoint || '').trim();
    if (!endpoint) {
      throw new Error('PuppeteerRuntime.connect requires an endpoint.');
    }

    const puppeteer = loadPuppeteer(input);
    const browser = await puppeteer.connect({
      browserWSEndpoint: endpoint,
      protocolTimeout: toInt(input.connectTimeoutMs, 60000, 1000),
      defaultViewport: null,
    });
    const page = await pickActivePage(browser);
    const cdp = await page.target().createCDPSession();

    return new PuppeteerRuntime({
      endpoint,
      browser,
      page,
      cdp,
      connectTimeoutMs: input.connectTimeoutMs,
      driverPage: input.driverPage || null,
    });
  }

  getDriverPage() {
    if (!this._driverPage && isLikelyPageObject(this.page)) {
      this._driverPage = adaptPuppeteerPage(this.page);
    }
    return this._driverPage;
  }

  getPage() {
    return this.page;
  }

  getBrowser() {
    return this.browser;
  }

  getConnectTimeoutMs() {
    return this.connectTimeoutMs;
  }

  async getCurrentUrl() {
    if (!this.page) {
      return '';
    }
    if (typeof this.page.url === 'function') {
      return this.page.url();
    }
    return String(this.page.url || '');
  }

  async getCurrentTitle() {
    if (!this.page) {
      return '';
    }
    if (typeof this.page.title === 'function') {
      return this.page.title();
    }
    return String(this.page.title || '');
  }

  async navigate(url, options = {}) {
    if (!this.page || typeof this.page.goto !== 'function') {
      throw new Error('Puppeteer runtime has no active page.');
    }
    await this.page.goto(url, options);
  }

  async listPages() {
    if (!this.browser || typeof this.browser.pages !== 'function') {
      return [];
    }
    return this.browser.pages().catch(() => []);
  }

  toRecord() {
    return {
      runtime: 'puppeteer-runtime',
      endpoint: this.endpoint,
      hasBrowser: Boolean(this.browser),
      hasPage: Boolean(this.page),
      hasCdp: Boolean(this.cdp),
      connectTimeoutMs: this.connectTimeoutMs,
    };
  }

  async close() {
    if (this.browser && typeof this.browser.close === 'function') {
      await this.browser.close();
    }
  }

  async disconnect() {
    if (this.browser && typeof this.browser.disconnect === 'function') {
      this.browser.disconnect();
    }
  }
}

module.exports = {
  PuppeteerRuntime,
  loadPuppeteer,
  pickActivePage,
  toErrorMessage,
};
