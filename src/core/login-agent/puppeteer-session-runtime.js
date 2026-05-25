function toInt(value, fallback, minimum = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(minimum, Math.trunc(parsed));
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

async function pickActivePage(browser) {
  const pages = typeof browser.pages === 'function' ? await browser.pages() : [];
  if (Array.isArray(pages) && pages.length > 0 && pages[0]) {
    return pages[0];
  }
  if (typeof browser.newPage !== 'function') {
    throw new Error('Puppeteer browser did not expose pages() or newPage().');
  }
  return browser.newPage();
}

class PuppeteerSessionRuntime {
  constructor(input = {}) {
    this.endpoint = String(input.endpoint || '');
    this.browser = input.browser || null;
    this.page = input.page || null;
    this.cdp = input.cdp || null;
    this.connectTimeoutMs = toInt(input.connectTimeoutMs, 60000, 1000);
  }

  static async connect(input = {}) {
    const endpoint = String(input.endpoint || '').trim();
    if (!endpoint) {
      throw new Error('PuppeteerSessionRuntime.connect requires an endpoint.');
    }

    const puppeteer = loadPuppeteer(input);
    const browser = await puppeteer.connect({
      browserWSEndpoint: endpoint,
      protocolTimeout: toInt(input.connectTimeoutMs, 60000, 1000),
      defaultViewport: null,
    });
    const page = await pickActivePage(browser);
    const cdp = await page.target().createCDPSession();

    return new PuppeteerSessionRuntime({
      endpoint,
      browser,
      page,
      cdp,
      connectTimeoutMs: input.connectTimeoutMs,
    });
  }

  toRecord() {
    return {
      runtime: 'puppeteer',
      endpoint: this.endpoint,
      hasBrowser: Boolean(this.browser),
      hasPage: Boolean(this.page),
      hasCdp: Boolean(this.cdp),
      connectTimeoutMs: this.connectTimeoutMs,
    };
  }

  async disconnect() {
    if (this.browser && typeof this.browser.disconnect === 'function') {
      this.browser.disconnect();
    }
  }

  async close() {
    if (this.browser && typeof this.browser.close === 'function') {
      await this.browser.close();
    }
  }
}

module.exports = {
  PuppeteerSessionRuntime,
  loadPuppeteer,
  pickActivePage,
};
