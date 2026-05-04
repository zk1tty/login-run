const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright-core');

const { getCustomerPaths } = require('../../../lib/helpers');
const {
  findLiveBrowserSessionByUserDataDir,
  getAttachableBrowserWSEndpoint,
  sanitizeSession,
} = require('../../../lib/session-reuse');

function isUsefulPage(page) {
  if (!page || page.isClosed()) {
    return false;
  }

  const url = String(page.url() || '').trim();
  return url !== '' && url !== 'about:blank';
}

function toSingleLine(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function truncate(value, maxLength) {
  return String(value || '').slice(0, maxLength);
}

function buildRunStamp() {
  return new Date().toISOString().replace(/[:.]/g, '-');
}

function getOutputPaths(customerPaths) {
  const outputRoot = path.resolve(
    process.env.SESSION_REUSE_CHECK_OUTPUT_DIR || path.join('out', customerPaths.customerId)
  );
  const runStamp = buildRunStamp();

  return {
    outputRoot,
    reportPath: path.resolve(outputRoot, `session-reuse-check-${runStamp}.json`),
    screenshotPath: path.resolve(
      outputRoot,
      `session-reuse-check-${runStamp}.png`
    ),
  };
}

async function readPageSnapshot(page) {
  return page.evaluate(() => {
    const title = document.title || '';
    const url = location.href || '';
    const readyState = document.readyState || '';
    const referrer = document.referrer || '';
    const body = document.body ? document.body.innerText || '' : '';
    const h2 = Array.from(document.querySelectorAll('h2'))
      .map(node => (node.textContent || '').trim())
      .filter(Boolean)
      .slice(0, 8);
    const h1 = Array.from(document.querySelectorAll('h1'))
      .map(node => (node.textContent || '').trim())
      .filter(Boolean)
      .slice(0, 3);
    const formCount = document.querySelectorAll('form').length;
    const inputCount = document.querySelectorAll('input').length;
    const buttonCount = document.querySelectorAll('button').length;
    const linkCount = document.querySelectorAll('a[href]').length;
    const topButtons = Array.from(document.querySelectorAll('button'))
      .map(node => (node.textContent || '').trim())
      .filter(Boolean)
      .slice(0, 8);
    const topLinks = Array.from(document.querySelectorAll('a[href]'))
      .map(node => ({
        text: (node.textContent || '').trim(),
        href: node.getAttribute('href') || '',
      }))
      .filter(item => item.href)
      .slice(0, 12);

    return {
      title,
      url,
      readyState,
      referrer,
      bodyText: body,
      h1,
      h2,
      formCount,
      inputCount,
      buttonCount,
      linkCount,
      topButtons,
      topLinks,
    };
  });
}

async function main() {
  const customerPaths = getCustomerPaths();
  const liveSession = await findLiveBrowserSessionByUserDataDir(
    customerPaths.browserProfileDir
  );

  if (!liveSession) {
    throw new Error(
      `No live Browserless session found for ${customerPaths.browserProfileDir}.`
    );
  }

  const endpoint = getAttachableBrowserWSEndpoint(liveSession);
  if (!endpoint) {
    throw new Error(
      `Live session ${liveSession.id || '<unknown>'} has no attachable websocket endpoint.`
    );
  }

  const browser = await chromium.connectOverCDP(endpoint);
  try {
    const context = browser.contexts()[0] || (await browser.newContext());
    const pages = context.pages();
    const page = pages.find(isUsefulPage);

    if (!page) {
      throw new Error('Connected to live browser, but found no non-blank page.');
    }

    const outputs = getOutputPaths(customerPaths);
    fs.mkdirSync(outputs.outputRoot, { recursive: true });

    const snapshot = await readPageSnapshot(page);
    const preview = toSingleLine(snapshot.bodyText).slice(0, 320);
    const bodyTextLength = snapshot.bodyText.length;
    const frameCount = page.frames().length;
    const viewport = page.viewportSize() || null;
    const userAgent = await page.evaluate(() => navigator.userAgent || '');

    try {
      await page.screenshot({
        path: outputs.screenshotPath,
        fullPage: true,
      });
    } catch (error) {
      await page.screenshot({
        path: outputs.screenshotPath,
      });
    }

    const report = {
      capturedAt: new Date().toISOString(),
      customerId: customerPaths.customerId,
      profileDir: customerPaths.browserProfileDir,
      endpoint,
      liveSession: sanitizeSession(liveSession),
      page: {
        title: snapshot.title,
        url: snapshot.url,
        readyState: snapshot.readyState,
        referrer: snapshot.referrer,
        viewport,
        frameCount,
        userAgent,
      },
      dom: {
        bodyTextLength,
        bodyPreview: preview,
        h1: snapshot.h1,
        h2: snapshot.h2,
        formCount: snapshot.formCount,
        inputCount: snapshot.inputCount,
        buttonCount: snapshot.buttonCount,
        linkCount: snapshot.linkCount,
        topButtons: snapshot.topButtons.map(text => truncate(text, 120)),
        topLinks: snapshot.topLinks.map(item => ({
          text: truncate(item.text, 120),
          href: item.href,
        })),
      },
      artifacts: {
        screenshotPath: outputs.screenshotPath,
      },
    };

    fs.writeFileSync(outputs.reportPath, `${JSON.stringify(report, null, 2)}\n`);

    console.log('Session reuse check: PASS');
    console.log('Customer ID:', customerPaths.customerId);
    console.log('Profile dir:', customerPaths.browserProfileDir);
    console.log('Connected endpoint:', endpoint);
    console.log('Live session:', JSON.stringify(sanitizeSession(liveSession)));
    console.log('Page title:', snapshot.title);
    console.log('Page URL:', snapshot.url);
    console.log('Frame count:', frameCount);
    console.log('Body text length:', bodyTextLength);
    console.log('Top h1:', snapshot.h1.length > 0 ? snapshot.h1.join(' | ') : '(none)');
    console.log('Body preview:', preview || '(empty)');
    console.log('Screenshot:', outputs.screenshotPath);
    console.log('Report JSON:', outputs.reportPath);
  } finally {
    await browser.close();
  }
}

main().catch(error => {
  console.error('Session reuse check: FAIL');
  console.error(error.message || error);
  process.exit(1);
});
