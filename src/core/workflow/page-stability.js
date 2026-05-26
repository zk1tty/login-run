const DEFAULT_STABILITY_TIMEOUT_MS = 15000;
const DEFAULT_STABILITY_POLL_MS = 250;
const DEFAULT_STABILITY_QUIET_MS = 1000;
const DEFAULT_STABILITY_MIN_POLLS = 2;

function toInt(value, fallback, minimum = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(minimum, Math.trunc(parsed));
}

function toSafeError(error) {
  return String(error?.message || error || 'unknown_error');
}

function resolvePageForStability(input = {}) {
  if (!input || typeof input !== 'object') {
    return null;
  }
  if (
    typeof input.evaluate === 'function' &&
    typeof input.waitForTimeout === 'function'
  ) {
    return input;
  }
  if (typeof input.getDriverPage === 'function') {
    const page = input.getDriverPage();
    if (page && typeof page.evaluate === 'function' && typeof page.waitForTimeout === 'function') {
      return page;
    }
  }
  return null;
}

function actionSelectors(plan = {}) {
  return [
    plan.selector,
    plan.inputSelector,
    plan.optionSelector,
    plan.submitSelector,
    plan.candidate?.selector,
    plan.inputCandidate?.selector,
    plan.optionCandidate?.selector,
    plan.submitCandidate?.selector,
  ]
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index);
}

function targetsSignature(targets = []) {
  return JSON.stringify(
    targets.map(target => ({
      selector: target.selector,
      exists: target.exists === true,
    }))
  );
}

function isReadyStateReady(value) {
  return value === 'interactive' || value === 'complete';
}

function isSnapshotStable(previous, current) {
  if (!previous || !current) {
    return false;
  }
  return (
    previous.url === current.url &&
    previous.mutationCount === current.mutationCount &&
    targetsSignature(previous.targets) === targetsSignature(current.targets)
  );
}

function targetsAllPresent(snapshot = {}) {
  const targets = Array.isArray(snapshot.targets) ? snapshot.targets : [];
  return targets.length > 0 && targets.every(target => target.exists === true);
}

async function inspectPageActionStability(pageOrRuntime, selectors = []) {
  const page = resolvePageForStability(pageOrRuntime);
  if (!page) {
    throw new Error('inspectPageActionStability requires a page with locator and evaluate.');
  }
  return page.evaluate(inputSelectors => {
    if (!window.__loginAgentMutationObserver) {
      window.__loginAgentMutationCount = 0;
      window.__loginAgentMutationObserver = new MutationObserver(() => {
        window.__loginAgentMutationCount += 1;
      });
      window.__loginAgentMutationObserver.observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        characterData: true,
      });
    }

    return {
      url: location.href,
      readyState: document.readyState,
      mutationCount: window.__loginAgentMutationCount || 0,
      targets: inputSelectors.map(selector => ({
        selector,
        exists: Boolean(document.querySelector(selector)),
      })),
    };
  }, selectors);
}

async function waitForPageActionStability(pageOrRuntime, plan = {}, options = {}) {
  const timeoutMs = toInt(options.timeoutMs, DEFAULT_STABILITY_TIMEOUT_MS, 0);
  const pollMs = toInt(options.pollMs, DEFAULT_STABILITY_POLL_MS, 50);
  const quietMs = toInt(options.quietMs, DEFAULT_STABILITY_QUIET_MS, 0);
  const minStablePolls = toInt(options.minStablePolls, DEFAULT_STABILITY_MIN_POLLS, 1);
  const selectors = Array.isArray(options.selectors) ? options.selectors : actionSelectors(plan);
  const startedAtMs = Date.now();
  let previous = null;
  let lastSnapshot = null;
  let lastError = '';
  let stableSinceMs = 0;
  let stablePolls = 0;
  let attempts = 0;
  const page = resolvePageForStability(pageOrRuntime);
  if (!page) {
    return {
      status: 'timeout',
      reason: 'runtime_page_missing',
      durationMs: 0,
      attempts,
      selectors,
      stablePolls,
      quietMs,
      snapshot: null,
    };
  }

  while (Date.now() - startedAtMs <= timeoutMs) {
    attempts += 1;
    try {
      lastSnapshot = await inspectPageActionStability(page, selectors);
      lastError = '';
    } catch (error) {
      lastError = toSafeError(error);
      stableSinceMs = 0;
      stablePolls = 0;
      await page.waitForTimeout(pollMs);
      continue;
    }

    const ready = isReadyStateReady(lastSnapshot.readyState);
    const targetsPresent = targetsAllPresent(lastSnapshot);
    const unchanged = isSnapshotStable(previous, lastSnapshot);

    if (ready && targetsPresent && unchanged) {
      stablePolls += 1;
      if (!stableSinceMs) {
        stableSinceMs = Date.now();
      }
      if (stablePolls >= minStablePolls && Date.now() - stableSinceMs >= quietMs) {
        return {
          status: 'stable',
          reason: 'ready_targets_quiet',
          durationMs: Math.max(0, Date.now() - startedAtMs),
          attempts,
          selectors,
          stablePolls,
          quietMs,
          snapshot: lastSnapshot,
        };
      }
    } else {
      stableSinceMs = 0;
      stablePolls = 0;
    }

    previous = lastSnapshot;
    await page.waitForTimeout(pollMs);
  }

  return {
    status: 'timeout',
    reason: lastError || 'page_action_stability_timeout',
    durationMs: Math.max(0, Date.now() - startedAtMs),
    attempts,
    selectors,
    stablePolls,
    quietMs,
    snapshot: lastSnapshot,
  };
}

module.exports = {
  DEFAULT_STABILITY_TIMEOUT_MS,
  DEFAULT_STABILITY_POLL_MS,
  DEFAULT_STABILITY_QUIET_MS,
  actionSelectors,
  inspectPageActionStability,
  isReadyStateReady,
  isSnapshotStable,
  targetsAllPresent,
  waitForPageActionStability,
};
