const { waitForPageActionStability } = require('./page-stability');
import type { PlanAction } from './types';

type LocatorLike = {
  first: () => LocatorLike;
  waitFor: (input?: { state?: string; timeout?: number | string }) => Promise<unknown>;
  evaluate: <T = unknown>(fn: (...args: unknown[]) => T, ...args: unknown[]) => Promise<T>;
  check: (input?: { force?: boolean; timeout?: number | string }) => Promise<unknown>;
  click: (input?: { timeout?: number | string }) => Promise<unknown>;
  fill: (value: string, input?: { timeout?: number | string }) => Promise<unknown>;
  press: (key: string) => Promise<unknown>;
  selectOption: (option?: { label?: string; value?: string }, input?: { timeout?: number | string }) => Promise<unknown>;
  checked?: boolean;
};

type MouseLike = {
  click: (x: number, y: number, input?: { timeout?: number | string }) => Promise<unknown>;
};

type RuntimePageLike = {
  locator: (selector: string) => LocatorLike;
  evaluate?: (...args: unknown[]) => Promise<unknown>;
  waitForTimeout: (ms: number) => Promise<unknown> | void;
  mouse?: MouseLike | null;
  waitForLoadState?: (state: string, input?: { timeout?: number | string }) => Promise<unknown>;
};

type RuntimeInputLike = RuntimePageLike & {
  getDriverPage?: () => RuntimePageLike | null;
  getPage?: () => unknown;
};

type ExecuteActionOptions = {
  waitMs?: number | string;
  pageStability?: Partial<PageStabilityOptions>;
};

type FillVerificationResult = {
  expectedLength: number;
  actualLength: number;
  lengthMatches: boolean;
  valueMatches: boolean;
  expectedFormat?: 'six_digits';
  formatMatches?: boolean;
  verified?: boolean;
};

type PageStabilityOptions = {
  timeoutMs?: number;
  pollMs?: number;
  quietMs?: number;
  minStablePolls?: number;
};

type PageStabilityResult = {
  status: string;
  reason: string;
  durationMs: number;
  attempts: number;
  selectors: string[];
  stablePolls: number;
  quietMs: number;
  snapshot: unknown;
};

type DeliverySelectionResult = {
  option: LocatorLike | null;
  method: string;
  attempts: string[];
  stability: PageStabilityResult;
};

type ExecutionResult = {
  status: 'ok' | 'failed' | 'skipped' | 'paused';
  reason?: string;
  action?: PlanAction['type'];
  stage?: string;
  selector?: string;
  optionSelector?: string;
  submitSelector?: string;
  inputSelector?: string;
  terminalOutcome?: string;
  error?: string;
  durationMs: number;
  plan?: PlanAction;
  detail?: unknown;
  typedLength?: number;
  fillVerification?: FillVerificationResult;
  submitClicked?: boolean;
  submitMethod?: string;
  selectionMethod?: string;
  selectionAttempts?: string[];
  pageStability?: {
    status: string;
    reason: string;
    durationMs: number;
    attempts: number;
    selectors: string[];
    snapshot: unknown;
  } | null;
};

function resolveRuntimePage(input: unknown): RuntimePageLike | null {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const runtime = input as RuntimeInputLike;

  if (typeof runtime.locator === 'function') {
    return runtime;
  }

  if (typeof runtime.getDriverPage === 'function') {
    const page = runtime.getDriverPage();
    if (page && typeof (page as RuntimePageLike).locator === 'function') {
      return page as RuntimePageLike;
    }
  }

  if (typeof runtime.getPage === 'function') {
    const page = runtime.getPage();
    if (page && typeof (page as RuntimePageLike).locator === 'function') {
      return page as RuntimePageLike;
    }
    if (page && typeof (page as RuntimeInputLike).getDriverPage === 'function') {
      const driverPage = (page as RuntimeInputLike).getDriverPage?.();
      if (
        driverPage &&
        typeof (driverPage as RuntimePageLike).evaluate === 'function' &&
        typeof (driverPage as RuntimePageLike).locator === 'function'
      ) {
        return driverPage as RuntimePageLike;
      }
    }
  }

  return null;
}

function guardRuntimePage(input: unknown): RuntimePageLike {
  const page = resolveRuntimePage(input);
  if (!page) {
    throw new Error('executeRuntimeAction requires a runtime page with locator and evaluate.');
  }
  return page;
}

function toSafeError(error: unknown): string {
  return String((error as { message?: unknown } | undefined)?.message || error || 'unknown_error');
}

function toInt(value: unknown, fallback: number, minimum = 0): number {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(minimum, Math.trunc(parsed));
}

// DOM executor: each DOM action must verify its local DOM effect before returning ok.
// The runner still verifies workflow progress by re-inventorying and reclassifying the page.
// ActionExecutor:
//   execute interaction
//   run action-specific local verifier
//   return structured result

async function isEnabled(locator: LocatorLike): Promise<boolean> {
  return locator.evaluate((node: unknown) => {
    if (!node || typeof node !== 'object') {
      return false;
    }
    const candidateNode = node as {
      hasAttribute?: (name: string) => boolean;
      getAttribute?: (name: string) => string | null;
    };
    if (candidateNode.getAttribute?.('disabled') === 'true' || candidateNode.hasAttribute?.('disabled')) {
      return false;
    }
    return candidateNode.getAttribute?.('aria-disabled') !== 'true';
  });
}

async function waitForEnabled(page: RuntimePageLike, locator: LocatorLike, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (await isEnabled(locator)) {
        return true;
      }
    } catch {
      return false;
    }
    await page.waitForTimeout(100);
  }
  return false;
}

// DOM execution and DOM verification are separate: an interaction can fire
// without changing state, and the runner still verifies page-level transition.
async function isChecked(locator: LocatorLike): Promise<boolean> {
  return locator.evaluate(node => {
    const candidateNode = node as { checked?: unknown };
    return Boolean(candidateNode && candidateNode.checked === true);
  });
}

async function waitForChecked(page: RuntimePageLike, locator: LocatorLike, timeoutMs: number): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    try {
      if (await isChecked(locator)) {
        return true;
      }
    } catch {
      return false;
    }
    await page.waitForTimeout(100);
  }
  return false;
}

const domExecutor = {
  async check(locator: LocatorLike, waitMs?: number): Promise<void> {
    await locator.check({ force: true, timeout: Math.min(waitMs ?? 0, 3000) });
  },

  async click(locator: LocatorLike, waitMs?: number): Promise<void> {
    await locator.click({ timeout: waitMs ?? 0 });
  },

  async fill(locator: LocatorLike, value: string, waitMs?: number): Promise<void> {
    await locator.fill(value, { timeout: waitMs ?? 0 });
  },

  async press(locator: LocatorLike, key: string): Promise<void> {
    await locator.press(key);
  },

  async selectOption(locator: LocatorLike, selection: string, waitMs?: number): Promise<void> {
    await locator.selectOption({ label: selection }, { timeout: waitMs ?? 0 }).catch(async () => {
      await locator.selectOption({ value: selection }, { timeout: waitMs ?? 0 });
    });
  },

  async clickCandidateCenter(page: RuntimePageLike, candidate: FillCandidate = {}, waitMs?: number): Promise<boolean> {
    const box = candidate.boundingBox || {};
    const x = Number(box.x || 0) + Number(box.width || 0) / 2;
    const y = Number(box.y || 0) + Number(box.height || 0) / 2;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0) {
      return false;
    }
    if (!page.mouse || typeof page.mouse.click !== 'function') {
      return false;
    }
    await page.mouse.click(x, y, { timeout: waitMs ?? 0 });
    return true;
  },
};

type CandidateLike = {
  value?: string;
  text?: string;
  selector?: string;
  id?: string;
  index?: number;
  boundingBox?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  };
};

type FillCandidate = {
  boundingBox?: CandidateLike['boundingBox'];
};

const domVerifier = {
  waitForChecked,
  waitForEnabled,
};

function isOtpPayloadKey(payloadKey: string): boolean {
  return /OTP/i.test(String(payloadKey || ''));
}

type VerificationResult = FillVerificationResult & {
  expectedFormat?: 'six_digits';
  formatMatches?: boolean;
};

async function verifyFilledInput(
  locator: LocatorLike,
  expectedValue: string,
  payloadKey: string | undefined,
): Promise<FillVerificationResult> {
  const verification = (await locator.evaluate((...rawArgs: unknown[]) => {
    const node = rawArgs[0];
    const expected = String(rawArgs[1] || '');
    const otpPayload = Boolean(rawArgs[2]);
    const actual = typeof (node as { value?: unknown })?.value === 'string' ? String((node as { value?: string }).value) : '';
    const result = {
      expectedLength: expected.length,
      actualLength: actual.length,
      lengthMatches: actual.length === expected.length,
      valueMatches: actual === expected,
    };

    if (otpPayload) {
      return {
        ...result,
        expectedFormat: 'six_digits' as const,
        formatMatches: /^\d{6}$/.test(actual),
      };
    }

    return result;
  }, String(expectedValue || ''), isOtpPayloadKey(payloadKey || '')) as VerificationResult);

  return {
    ...verification,
    verified: Boolean(verification.valueMatches),
  };
}

function cssAttrValue(value: unknown): string {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function clickAssociatedLabel(page: RuntimePageLike, option: LocatorLike, waitMs?: number): Promise<boolean> {
  const id = await option.evaluate(node => String((node as { id?: string }).id || ''));
  if (!id) {
    return false;
  }

  const label = page.locator(`label[for="${cssAttrValue(id)}"]`).first();
  await label.waitFor({ state: 'visible', timeout: Math.min(waitMs ?? 0, 3000) });
  await domExecutor.click(label, waitMs);
  return true;
}

async function selectDeliveryOption(
  page: RuntimePageLike,
  plan: PlanAction,
  waitMs: number,
  stabilityOptions: PageStabilityOptions = {},
): Promise<DeliverySelectionResult> {
  const stability = await waitForPageActionStability(page, {
    optionSelector: plan.optionSelector,
    submitSelector: plan.submitSelector,
    selector: plan.selector,
    inputSelector: plan.inputSelector,
    optionCandidate: plan.optionCandidate,
    inputCandidate: plan.inputCandidate,
    submitCandidate: plan.submitCandidate,
    selection: plan.selection,
  } as unknown, {
    timeoutMs: Math.max(waitMs ?? 0, 15000),
    pollMs: 250,
    quietMs: 1000,
    minStablePolls: 2,
    ...stabilityOptions,
  });

  if ((stability as { status?: string }).status !== 'stable') {
    return {
      option: null,
      method: '',
      attempts: [`stability_${(stability as { status?: string }).status || 'unknown'}:${(stability as { reason?: string }).reason || ''}`],
      stability: stability as PageStabilityResult,
    };
  }

  const option = page.locator(String(plan.optionSelector || '')).first();
  await option.waitFor({ state: 'attached', timeout: waitMs ?? 0 });

  const attempts: string[] = [];

  try {
    await domExecutor.check(option, waitMs);
    attempts.push('native_check');
    if (await domVerifier.waitForChecked(page, option, Math.min(waitMs ?? 0, 1000))) {
      return { option, method: 'native_check', attempts, stability: stability as PageStabilityResult };
    }
  } catch (error) {
    attempts.push(`native_check_failed:${toSafeError(error)}`);
  }

  try {
    if (await clickAssociatedLabel(page, option, waitMs)) {
      attempts.push('label_click');
      if (await domVerifier.waitForChecked(page, option, Math.min(waitMs ?? 0, 1500))) {
        return { option, method: 'label_click', attempts, stability: stability as PageStabilityResult };
      }
    }
  } catch (error) {
    attempts.push(`label_click_failed:${toSafeError(error)}`);
  }

  try {
    if (await domExecutor.clickCandidateCenter(page, plan.optionCandidate as unknown as CandidateLike, waitMs)) {
      attempts.push('candidate_center_click');
      if (await domVerifier.waitForChecked(page, option, Math.min(waitMs ?? 0, 1500))) {
        return { option, method: 'candidate_center_click', attempts, stability: stability as PageStabilityResult };
      }
    }
  } catch (error) {
    attempts.push(`candidate_center_click_failed:${toSafeError(error)}`);
  }

  return { option, method: '', attempts, stability: stability as PageStabilityResult };
}

export async function executeRuntimeAction(
  pageOrRuntime: unknown,
  plan: PlanAction = { type: 'none' },
  payload: Record<string, string> = {},
  options: ExecuteActionOptions = {},
): Promise<ExecutionResult> {
  const startedAtMs = Date.now();
  const waitMs = toInt(options.waitMs, 5000, 0);
  const page = guardRuntimePage(pageOrRuntime);

  if (!plan || plan.type === 'none') {
    return {
      status: 'skipped',
      reason: plan?.reason || 'no_action',
      durationMs: Math.max(0, Date.now() - startedAtMs),
      plan,
    };
  }

  if (plan.type === 'pause') {
    return {
      status: 'paused',
      terminalOutcome: plan.terminalOutcome || 'need_otp',
      reason: plan.reason || 'pause_requested',
      durationMs: Math.max(0, Date.now() - startedAtMs),
      plan,
    };
  }

  if (plan.type === 'click_candidate') {
    try {
      const target = page.locator(String(plan.selector || '')).first();
      await target.waitFor({ state: 'visible', timeout: waitMs ?? 0 });
      const enabled = await domVerifier.waitForEnabled(page, target, waitMs ?? 0);
      if (!enabled) {
        return {
          status: 'failed',
          action: plan.type,
          stage: String(plan.stage || ''),
          selector: plan.selector || '',
          error: 'target_not_enabled',
          durationMs: Math.max(0, Date.now() - startedAtMs),
        };
      }
      await domExecutor.click(target, waitMs);
      return {
        status: 'ok',
        action: plan.type,
        stage: String(plan.stage || ''),
        selector: plan.selector,
        terminalOutcome: plan.terminalOutcome || '',
        durationMs: Math.max(0, Date.now() - startedAtMs),
      };
    } catch (error) {
      return {
        status: 'failed',
        action: plan.type,
        stage: String(plan.stage || ''),
        selector: plan.selector || '',
        error: toSafeError(error),
        durationMs: Math.max(0, Date.now() - startedAtMs),
      };
    }
  }

  if (plan.type === 'select_option') {
    try {
      const target = page.locator(String(plan.selector || '')).first();
      await target.waitFor({ state: 'visible', timeout: waitMs ?? 0 });
      await domExecutor.selectOption(target, String(plan.selection || ''), waitMs);
      return {
        status: 'ok',
        action: plan.type,
        stage: String(plan.stage || ''),
        selector: plan.selector,
        terminalOutcome: plan.terminalOutcome || '',
        durationMs: Math.max(0, Date.now() - startedAtMs),
      };
    } catch (error) {
      return {
        status: 'failed',
        action: plan.type,
        stage: String(plan.stage || ''),
        selector: plan.selector || '',
        error: toSafeError(error),
        durationMs: Math.max(0, Date.now() - startedAtMs),
      };
    }
  }

  if (plan.type === 'select_delivery_and_submit') {
    try {
      const selection = await selectDeliveryOption(
        page,
        plan,
        waitMs ?? 0,
        options.pageStability || {},
      );
      const option = selection.option;

      if (!selection.method) {
        return {
          status: 'failed',
          action: plan.type,
          stage: String(plan.stage || ''),
          optionSelector: plan.optionSelector || '',
          submitSelector: plan.submitSelector || '',
          error: 'option_not_selected',
          selectionAttempts: selection.attempts,
          pageStability: selection.stability
            ? {
                status: selection.stability.status,
                reason: selection.stability.reason,
                durationMs: selection.stability.durationMs,
                attempts: selection.stability.attempts,
                selectors: selection.stability.selectors,
                snapshot: selection.stability.snapshot,
              }
            : null,
          durationMs: Math.max(0, Date.now() - startedAtMs),
        };
      }

      let submitClicked = false;
      if (plan.submitSelector) {
        const submit = page.locator(plan.submitSelector).first();
        const enabled = await domVerifier.waitForEnabled(page, submit, waitMs ?? 0);
        if (enabled) {
          await domExecutor.click(submit, waitMs);
          submitClicked = true;
        }
      }

      if (!submitClicked && option && typeof option.press === 'function') {
        await domExecutor.press(option, 'Enter').catch(() => {});
      }

      return {
        status: 'ok',
        action: plan.type,
        stage: String(plan.stage || ''),
        optionSelector: plan.optionSelector,
        submitSelector: plan.submitSelector || '',
        selectionMethod: selection.method,
        selectionAttempts: selection.attempts,
        pageStability: selection.stability
          ? {
              status: selection.stability.status,
              reason: selection.stability.reason,
              durationMs: selection.stability.durationMs,
              attempts: selection.stability.attempts,
              selectors: selection.stability.selectors,
              snapshot: selection.stability.snapshot,
            }
          : null,
        submitClicked,
        terminalOutcome: plan.terminalOutcome || '',
        durationMs: Math.max(0, Date.now() - startedAtMs),
      };
    } catch (error) {
      return {
        status: 'failed',
        action: plan.type,
        stage: String(plan.stage || ''),
        optionSelector: plan.optionSelector || '',
        submitSelector: plan.submitSelector || '',
        error: toSafeError(error),
        durationMs: Math.max(0, Date.now() - startedAtMs),
      };
    }
  }

  if (plan.type !== 'fill_input_and_submit') {
    return {
      status: 'failed',
      error: 'unsupported_action_type',
      durationMs: Math.max(0, Date.now() - startedAtMs),
      plan,
    };
  }

  const value = String(payload[String(plan.payloadKey || '')] || '');
  if (!value) {
    return {
      status: 'failed',
      error: `missing_${plan.payloadKey || 'payload'}`,
      durationMs: Math.max(0, Date.now() - startedAtMs),
      plan,
    };
  }

  try {
    const input = page.locator(String(plan.inputSelector || '')).first();
    await input.waitFor({ state: 'visible', timeout: waitMs ?? 0 });
    await domExecutor.fill(input, value, waitMs);
    const fillVerification = await verifyFilledInput(input, value, plan.payloadKey);

    if (!fillVerification.verified) {
      return {
        status: 'failed',
        action: plan.type,
        stage: String(plan.stage || ''),
        inputSelector: plan.inputSelector || '',
        submitSelector: plan.submitSelector || '',
        error: 'input_value_verification_failed',
        typedLength: value.length,
        fillVerification,
        durationMs: Math.max(0, Date.now() - startedAtMs),
      };
    }

    if (plan.shouldSubmit === false) {
      return {
        status: 'ok',
        action: plan.type,
        stage: String(plan.stage || ''),
        inputSelector: plan.inputSelector,
        submitSelector: plan.submitSelector || '',
        submitMethod: 'none',
        submitClicked: false,
        typedLength: value.length,
        fillVerification,
        durationMs: Math.max(0, Date.now() - startedAtMs),
      };
    }

    let submitMethod = 'press_enter';
    let submitClicked = false;
    if (plan.submitSelector) {
      const submit = page.locator(plan.submitSelector).first();
      const enabled = await domVerifier.waitForEnabled(page, submit, waitMs ?? 0);
      if (enabled) {
        await domExecutor.click(submit, waitMs);
        submitMethod = 'click';
        submitClicked = true;
      } else {
        await domExecutor.press(input, 'Enter');
      }
    } else {
      await domExecutor.press(input, 'Enter');
    }

    return {
      status: 'ok',
      action: plan.type,
      stage: String(plan.stage || ''),
      inputSelector: plan.inputSelector,
      submitSelector: plan.submitSelector || '',
      submitMethod,
      submitClicked,
      typedLength: value.length,
      fillVerification,
      durationMs: Math.max(0, Date.now() - startedAtMs),
    };
  } catch (error) {
    return {
      status: 'failed',
      action: plan.type,
      stage: String(plan.stage || ''),
      inputSelector: plan.inputSelector || '',
      submitSelector: plan.submitSelector || '',
      error: toSafeError(error),
      durationMs: Math.max(0, Date.now() - startedAtMs),
    };
  }
}
