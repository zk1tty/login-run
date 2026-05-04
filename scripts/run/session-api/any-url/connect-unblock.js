const { chromium } = require('playwright-core');
const {
  getLiveUrlOptions,
  getSessionKeepAliveMs,
  getTestUrl,
  getUnblockApiUrl,
} = require('../../../lib/helpers');

function parseNumber(value, fallback, minimum = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(minimum, Math.trunc(parsed));
}

function withToken(endpoint) {
  const token = String(process.env.BROWSERLESS_TOKEN || '').trim();
  if (!token || !endpoint) {
    return endpoint;
  }

  const raw = String(endpoint).trim();
  if (!raw) {
    return raw;
  }

  try {
    const url = new URL(raw);
    if (!url.searchParams.has('token')) {
      url.searchParams.set('token', token);
    }
    return url.toString();
  } catch (error) {
    const separator = raw.includes('?') ? '&' : '?';
    return `${raw}${separator}token=${encodeURIComponent(token)}`;
  }
}

async function printLiveUrl(context, page) {
  const liveUrlOptions = getLiveUrlOptions();
  let cdp;

  try {
    cdp = await context.newCDPSession(page);
    const liveUrlResult = await cdp.send('Browserless.liveURL', liveUrlOptions);
    const { liveURL, liveURLId, error: liveUrlError } = liveUrlResult || {};

    if (liveURL) {
      console.log('Live URL:', liveURL);
      if (liveURLId) {
        console.log('Live URL ID:', liveURLId);
      }
      console.log('Live URL Interactive:', liveUrlOptions.interactive !== false);
      return;
    }

    if (liveUrlError) {
      console.log(`Live URL: unavailable (${liveUrlError})`);
      return;
    }

    console.log('Live URL: unavailable (no URL returned)');
  } catch (error) {
    const message = String(error?.message || error);
    if (message.includes(`'Browserless.liveURL' wasn't found`)) {
      console.log('Live URL: unavailable (Browserless.liveURL not supported)');
      return;
    }

    console.log(`Live URL: unavailable (${message})`);
  } finally {
    if (cdp) {
      await cdp.detach().catch(() => {});
    }
  }
}

function waitForSignal() {
  return new Promise(resolve => {
    const onSignal = signal => {
      process.off('SIGINT', handleSigint);
      process.off('SIGTERM', handleSigterm);
      resolve(signal);
    };
    const handleSigint = () => onSignal('SIGINT');
    const handleSigterm = () => onSignal('SIGTERM');

    process.on('SIGINT', handleSigint);
    process.on('SIGTERM', handleSigterm);
  });
}

async function main() {
  const targetUrl = getTestUrl();
  const unblockApiUrl = getUnblockApiUrl();
  const ttl = parseNumber(process.env.UNBLOCK_TTL_MS, 120000, 1000);
  const payload = {
    url: targetUrl,
    content: false,
    cookies: true,
    screenshot: false,
    browserWSEndpoint: true,
    ttl,
  };

  console.log('Calling Unblock API');
  console.log('Endpoint:', unblockApiUrl);
  console.log('Target URL:', targetUrl);
  console.log('Request payload:', JSON.stringify(payload));

  const response = await fetch(unblockApiUrl, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Unblock API failed: HTTP ${response.status}\n${body}`);
  }

  const result = await response.json();
  const cookieCount = Array.isArray(result.cookies) ? result.cookies.length : 0;
  console.log('Unblock response received');
  console.log('Returned browserWSEndpoint:', Boolean(result.browserWSEndpoint));
  console.log('Returned cookies:', cookieCount);

  if (!result.browserWSEndpoint) {
    console.log('No browserWSEndpoint returned. Skipping CDP attach.');
    return;
  }

  const cdpEndpoint = withToken(result.browserWSEndpoint);
  const browser = await chromium.connectOverCDP(cdpEndpoint);

  try {
    const context = browser.contexts()[0] || await browser.newContext();
    if (cookieCount > 0) {
      await context.addCookies(result.cookies);
    }

    const page = context.pages()[0] || await context.newPage();
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });

    const webdriver = await page.evaluate(() => navigator.webdriver);
    console.log('Connected with connectOverCDP from /unblock');
    console.log('CDP endpoint:', cdpEndpoint);
    await printLiveUrl(context, page);
    console.log('navigator.webdriver:', webdriver);
    console.log('Page title:', await page.title());
    console.log('Current URL:', page.url());

    const keepAliveMs = getSessionKeepAliveMs();
    if (keepAliveMs > 0) {
      console.log(`Keeping session alive for ${keepAliveMs}ms`);
      await page.waitForTimeout(keepAliveMs);
      return;
    }

    console.log('Keeping session alive until Ctrl+C');
    await waitForSignal();
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error(error);
  process.exit(1);
});
