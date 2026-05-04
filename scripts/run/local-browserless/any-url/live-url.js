const { chromium } = require('playwright-core');
const {
  getCdpEndpoint,
  getLiveUrlKeepAliveMs,
  getLiveUrlOptions,
  getTestUrl,
} = require('../../../lib/helpers');

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
  const endpoint = getCdpEndpoint();
  const browser = await chromium.connectOverCDP(endpoint);

  try {
    const context = browser.contexts()[0] || await browser.newContext();
    const pages = context.pages();
    const page =
      pages.find(candidate => {
        const url = String(candidate.url() || '').trim();
        return url !== '' && url !== 'about:blank';
      }) ||
      pages[0] ||
      (await context.newPage());

    if (page.url() === 'about:blank') {
      await page.goto(getTestUrl(), { waitUntil: 'domcontentloaded' });
    }

    const cdp = await context.newCDPSession(page);
    const liveUrlOptions = getLiveUrlOptions();
    const liveUrlResult = await cdp.send('Browserless.liveURL', liveUrlOptions);
    const { liveURL, liveURLId, error: liveUrlError } = liveUrlResult || {};

    if (!liveURL) {
      if (liveUrlError) {
        throw new Error(`Browserless.liveURL failed: ${liveUrlError}`);
      }

      throw new Error(
        'Browserless.liveURL returned no URL. This instance may not support Live URLs.'
      );
    }

    console.log('Live URL:', liveURL);
    if (liveURLId) {
      console.log('Live URL ID:', liveURLId);
    }
    console.log('Interactive:', liveUrlOptions.interactive !== false);
    console.log('Current URL:', page.url());

    const keepAliveMs = getLiveUrlKeepAliveMs();

    if (keepAliveMs > 0) {
      console.log(`Keeping browser alive for ${keepAliveMs}ms`);
      await new Promise(resolve => setTimeout(resolve, keepAliveMs));
      return;
    }

    console.log('Press Ctrl+C when you are done with the Live URL.');
    await waitForSignal();
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  if (String(error.message || '').includes(`'Browserless.liveURL' wasn't found`)) {
    console.error('Browserless.liveURL is not available on this Browserless instance.');
    console.error('Fallback: use `npm run watch:session` and open the printed DevTools URL.');
    process.exit(1);
  }

  console.error(error);
  process.exit(1);
});
