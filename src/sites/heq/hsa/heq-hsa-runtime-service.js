const { mapHsaExtractionSnapshot } = require('./heq-hsa-extractor');

function toNormalizedTextLines(value) {
  return String(value || '')
    .split('\n')
    .map(item => item.replace(/\s+/g, ' ').trim())
    .filter(Boolean);
}

function createOwnerHsaService(options = {}) {
  const now = options.now || (() => Date.now());
  const assertCustomerId = options.assertCustomerId;
  const getEntry = options.getEntry;
  const reconcileEntry = options.reconcileEntry;

  async function extractHsaData(input = {}) {
    const customerId = assertCustomerId(input.customerId);
    const entry = getEntry(customerId);
    reconcileEntry(entry);

    if (!entry.ownerConnected || !entry.page) {
      const error = new Error('Owner browser is not attached.');
      error.statusCode = 409;
      throw error;
    }

    const page = entry.page;
    const capturedAt = new Date(now()).toISOString();

    let rawSnapshot;
    try {
      rawSnapshot = await page.evaluate(() => {
        function normalizeText(value) {
          return String(value || '')
            .replace(/\s+/g, ' ')
            .trim();
        }

        function toLines(value) {
          return String(value || '')
            .split('\n')
            .map(item => normalizeText(item))
            .filter(Boolean);
        }

        function findSectionLines(pattern) {
          const candidates = Array.from(
            document.querySelectorAll('section, article, div, main')
          )
            .filter(node => {
              const text = normalizeText(node?.innerText || '');
              if (!text) {
                return false;
              }
              if (!pattern.test(text)) {
                return false;
              }
              return text.length < 3000;
            })
            .sort((left, right) => {
              const leftText = normalizeText(left?.innerText || '');
              const rightText = normalizeText(right?.innerText || '');
              return leftText.length - rightText.length;
            });

          if (!candidates.length) {
            return [];
          }

          return toLines(candidates[0].innerText || '');
        }

        return {
          url: window.location.href,
          title: document.title || '',
          profileLines: findSectionLines(/\bprofile info\b/i),
          accountLines: findSectionLines(/\baccount info\b/i),
          allLines: toLines(document.body?.innerText || ''),
        };
      });
    } catch (error) {
      const wrapped = new Error(
        `Failed to extract HSA DOM snapshot: ${String(error?.message || error)}`
      );
      wrapped.statusCode = 500;
      throw wrapped;
    }

    const mapped = mapHsaExtractionSnapshot({
      ...rawSnapshot,
      capturedAt,
      profileLines: Array.isArray(rawSnapshot?.profileLines)
        ? rawSnapshot.profileLines
        : toNormalizedTextLines(rawSnapshot?.profileText),
      accountLines: Array.isArray(rawSnapshot?.accountLines)
        ? rawSnapshot.accountLines
        : toNormalizedTextLines(rawSnapshot?.accountText),
      allLines: Array.isArray(rawSnapshot?.allLines)
        ? rawSnapshot.allLines
        : toNormalizedTextLines(rawSnapshot?.fullText),
    });

    entry.pageUrl = mapped.meta.url || entry.pageUrl;
    entry.pageTitle = mapped.meta.title || entry.pageTitle;
    entry.updatedAtMs = now();

    return mapped;
  }

  return {
    extractHsaData,
  };
}

module.exports = {
  createOwnerHsaService,
};
