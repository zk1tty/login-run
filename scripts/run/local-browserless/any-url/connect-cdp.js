const { chromium } = require('playwright-core');
const {
  getCdpEndpoint,
  getLiveUrlOptions,
  getSessionKeepAliveMs,
  getSessionsViewerUrl,
  getTestUrl,
  loadAuthState,
  primeContextFromAuthState,
} = require('../../../lib/helpers');
const {
  isTurnstileDetailsComplete,
  logTurnstileRunAfterTechnicalDetails,
  logTurnstileRunFromPage,
  shouldUseTurnstileWait,
} = require('../../../lib/turnstile-watcher');
const { detectBrowserIp } = require('../../../lib/browser-ip');

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
  const endpoint = getCdpEndpoint();
  const authState = loadAuthState();
  const browser = await chromium.connectOverCDP(endpoint);

  try {
    const context = browser.contexts()[0] || await browser.newContext();
    let detectedIpAddress = '';
    if (authState) {
      await primeContextFromAuthState(context, authState.state);
    }

    try {
      const ipProbe = await detectBrowserIp(context);
      detectedIpAddress = ipProbe.ipAddress || '';
      console.log('IP probe URL:', ipProbe.probeUrl);
      console.log('Detected Egress IP:', detectedIpAddress || '(unavailable)');
    } catch (error) {
      console.log(`Detected Egress IP: unavailable (${error.message})`);
    }

    const page = context.pages()[0] || await context.newPage();
    await page.goto(getTestUrl(), { waitUntil: 'domcontentloaded' });

    console.log('Connected with connectOverCDP');
    console.log('Endpoint:', endpoint);
    console.log('Sessions API:', getSessionsViewerUrl());
    if (authState) {
      console.log('Primed auth from:', authState.sourcePath);
    }
    await printLiveUrl(context, page);
    console.log('Page title:', await page.title());
    console.log('Current URL:', page.url());

    const turnstileLog = await logTurnstileRunFromPage(page, {
      script: 'connect:cdp',
      testUrl: getTestUrl(),
      detectedIpAddress,
    });
    if (turnstileLog.error) {
      console.log(`Turnstile log: skipped (${turnstileLog.error.message})`);
    } else {
      const { entry, logPath } = turnstileLog;
      console.log('Turnstile log file:', logPath);
      console.log(
        'Turnstile snapshot:',
        JSON.stringify({
          technicalDetailsOpen: Boolean(entry.technicalDetailsOpen),
          sessionId: entry.sessionId || '',
          ipAddress: entry.ipAddress || '',
          status: entry.turnstileStatus || '',
          liveSecurityStatus: entry.liveSecurityStatus || '',
          liveSecurityErrorCode: entry.liveSecurityErrorCode || '',
        })
      );

      // Add a background watcher for Turnstile sections
      if (shouldUseTurnstileWait(page.url()) && !isTurnstileDetailsComplete(entry)) {
        logTurnstileRunAfterTechnicalDetails(
          page,
          {
            script: 'connect:cdp',
            testUrl: getTestUrl(),
            detectedIpAddress,
          },
          { baselineEntry: entry }
        )
          .then(result => {
            if (!result || result.error) {
              const message = String(result?.error?.message || 'unknown error');
              console.log(`Turnstile details watcher: skipped (${message})`);
              return;
            }

            if (result.skipped) {
              if (result.reason === 'details_incomplete') {
                console.log(
                  `Turnstile details watcher: no complete details found within ${result.waitMs}ms`
                );
              }
              return;
            }

            console.log('Turnstile log file:', result.logPath);
            console.log(
              'Turnstile snapshot (after Technical Details):',
              JSON.stringify({
                technicalDetailsOpen: Boolean(result.entry?.technicalDetailsOpen),
                sessionId: result.entry?.sessionId || '',
                ipAddress: result.entry?.ipAddress || '',
                status: result.entry?.turnstileStatus || '',
                liveSecurityStatus: result.entry?.liveSecurityStatus || '',
                liveSecurityErrorCode: result.entry?.liveSecurityErrorCode || '',
              })
            );
          })
          .catch(error => {
            console.log(`Turnstile details watcher: skipped (${error.message})`);
          });

        console.log(
          'Turnstile details watcher: waiting for Technical Details expansion and final Live Security Check result'
        );
      }
    }

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
