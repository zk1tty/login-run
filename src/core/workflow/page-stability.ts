const DEFAULT_STABILITY_TIMEOUT_MS = 15000;
const DEFAULT_STABILITY_POLL_MS = 250;
const DEFAULT_STABILITY_QUIET_MS = 1000;
const DEFAULT_STABILITY_MIN_POLLS = 2;

type UnknownRecord = Record<string, unknown>;

type PageActionPlan = {
  selector?: string;
  inputSelector?: string;
  optionSelector?: string;
  submitSelector?: string;
  candidate?: { selector?: string };
  inputCandidate?: { selector?: string };
  optionCandidate?: { selector?: string };
  submitCandidate?: { selector?: string };
};

type PageLike = {
  evaluate: <T = unknown, A extends unknown[] = unknown[]>(pageFunction: (...args: A) => T, ...args: A) => Promise<T>;
  waitForTimeout: (ms: number) => Promise<void> | void;
  locator?: (...args: unknown[]) => unknown;
};

type RuntimeLike = {
  getDriverPage?: () => PageLike | Promise<PageLike | null> | null;
  evaluate?: PageLike['evaluate'];
  waitForTimeout?: PageLike['waitForTimeout'];
};

type RuntimeSnapshotTarget = {
  selector: string;
  exists: boolean;
};

type RuntimeSnapshot = {
  url: string;
  readyState: string;
  mutationCount: number;
  targets: RuntimeSnapshotTarget[];
};

type StabilityResult = {
  status: 'stable' | 'timeout';
  reason: string;
  durationMs: number;
  attempts: number;
  selectors: string[];
  stablePolls: number;
  quietMs: number;
  snapshot: RuntimeSnapshot | null;
};

function toInt(value: unknown, fallback: number, minimum = 0): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(minimum, Math.trunc(parsed));
}

function toSafeError(error: unknown): string {
  return String((error as { message?: unknown } | undefined)?.message || error || 'unknown_error');
}

function resolvePageForStability(input: unknown): PageLike | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const candidate = input as RuntimeLike;
  if (
    typeof candidate.evaluate === 'function' &&
    typeof candidate.waitForTimeout === 'function'
  ) {
    return candidate as PageLike;
  }

  if (typeof candidate.getDriverPage === 'function') {
    const page = candidate.getDriverPage();
    if (page && typeof (page as PageLike).evaluate === 'function' && typeof (page as PageLike).waitForTimeout === 'function') {
      return page as PageLike;
    }
  }

  return null;
}

function actionSelectors(plan: UnknownRecord = {}): string[] {
  return [
    (plan as UnknownRecord).selector,
    (plan as UnknownRecord).inputSelector,
    (plan as UnknownRecord).optionSelector,
    (plan as UnknownRecord).submitSelector,
    (plan.candidate as UnknownRecord)?.selector,
    (plan.inputCandidate as UnknownRecord)?.selector,
    (plan.optionCandidate as UnknownRecord)?.selector,
    (plan.submitCandidate as UnknownRecord)?.selector,
  ]
    .map(value => String(value || '').trim())
    .filter(Boolean)
    .filter((value, index, list) => list.indexOf(value) === index);
}

function targetsSignature(targets: RuntimeSnapshotTarget[] = []): string {
  return JSON.stringify(
    targets.map(target => ({
      selector: target.selector,
      exists: target.exists === true,
    }))
  );
}

function isReadyStateReady(value: string): boolean {
  return value === 'interactive' || value === 'complete';
}

function isSnapshotStable(previous: RuntimeSnapshot | null, current: RuntimeSnapshot): boolean {
  if (!previous || !current) {
    return false;
  }
  return (
    previous.url === current.url &&
    previous.mutationCount === current.mutationCount &&
    targetsSignature(previous.targets) === targetsSignature(current.targets)
  );
}

function targetsAllPresent(snapshot: RuntimeSnapshot = { url: '', readyState: '', mutationCount: 0, targets: [] }): boolean {
  const targets = Array.isArray(snapshot.targets) ? snapshot.targets : [];
  return targets.length > 0 && targets.every(target => target.exists === true);
}

async function inspectPageActionStability(pageOrRuntime: unknown, selectors: string[] = []): Promise<RuntimeSnapshot> {
  const page = resolvePageForStability(pageOrRuntime);
  if (!page) {
    throw new Error('inspectPageActionStability requires a page with locator and evaluate.');
  }

  return page.evaluate<RuntimeSnapshot, [string[]]>((inputSelectors: string[]) => {
    const env = globalThis as unknown as {
      document?: { documentElement?: unknown };
      MutationObserver?: new () => unknown;
      __loginAgentMutationObserver?: unknown;
      __loginAgentMutationCount?: number;
    };

    if (!env.__loginAgentMutationObserver) {
      env.__loginAgentMutationCount = 0;
      env.__loginAgentMutationObserver = new (env.MutationObserver as unknown as {
        new (cb: () => void): { observe: (target: unknown, options: unknown) => void };
      })(() => {
        env.__loginAgentMutationCount = (env.__loginAgentMutationCount || 0) + 1;
      });
      const target = env.document?.documentElement as unknown;
      const observer = env.__loginAgentMutationObserver as {
        observe: (target: unknown, options: unknown) => void;
      } | null;

      if (target && observer) {
        observer.observe(target, {
          childList: true,
          subtree: true,
          attributes: true,
          characterData: true,
        });
      }
    }

    const doc = env.document as {
      location?: { href?: string };
      readyState?: string;
      querySelector?: (selector: string) => unknown;
    };
    return {
      url: doc?.location?.href || '',
      readyState: doc?.readyState || '',
      mutationCount: env.__loginAgentMutationCount || 0,
      targets: inputSelectors.map(selector => ({
        selector,
        exists: Boolean(doc?.querySelector?.(selector)),
      })),
    };
  }, selectors as string[]);
}

async function waitForPageActionStability(
  pageOrRuntime: unknown,
  plan: PageActionPlan = {},
  options: { timeoutMs?: number; pollMs?: number; quietMs?: number; minStablePolls?: number; selectors?: string[] } = {},
): Promise<StabilityResult> {
  const timeoutMs = toInt(options.timeoutMs, DEFAULT_STABILITY_TIMEOUT_MS, 0);
  const pollMs = toInt(options.pollMs, DEFAULT_STABILITY_POLL_MS, 50);
  const quietMs = toInt(options.quietMs, DEFAULT_STABILITY_QUIET_MS, 0);
  const minStablePolls = toInt(options.minStablePolls, DEFAULT_STABILITY_MIN_POLLS, 1);
  const selectors = Array.isArray(options.selectors) ? options.selectors : actionSelectors(plan);
  const startedAtMs = Date.now();
  let previous: RuntimeSnapshot | null = null;
  let stableSinceMs = 0;
  let stablePolls = 0;
  let attempts = 0;
  let lastError = '';
  let lastSnapshot: RuntimeSnapshot | null = null;
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
      lastSnapshot = await inspectPageActionStability(pageOrRuntime, selectors);
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
