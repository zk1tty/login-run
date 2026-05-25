const { waitForPageActionStability } = require('./page-stability');

function toSafeError(error) {
  return String(error?.message || error || 'unknown_error');
}

function toInt(value, fallback, minimum = 0) {
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

async function isEnabled(locator) {
  return locator.evaluate(node => {
    if (!(node instanceof HTMLElement)) {
      return false;
    }
    return !node.hasAttribute('disabled') && node.getAttribute('aria-disabled') !== 'true';
  });
}

async function waitForEnabled(page, locator, timeoutMs) {
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
async function isChecked(locator) {
  return locator.evaluate(node => Boolean(node && node.checked === true));
}

async function waitForChecked(page, locator, timeoutMs) {
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
  async check(locator, waitMs) {
    await locator.check({ force: true, timeout: Math.min(waitMs || 5000, 3000) });
  },

  async click(locator, waitMs) {
    await locator.click({ timeout: waitMs || 5000 });
  },

  async fill(locator, value, waitMs) {
    await locator.fill(value, { timeout: waitMs || 5000 });
  },

  async press(locator, key) {
    await locator.press(key);
  },

  async selectOption(locator, selection, waitMs) {
    await locator.selectOption({ label: selection }, { timeout: waitMs || 5000 })
      .catch(async () => {
        await locator.selectOption({ value: selection }, { timeout: waitMs || 5000 });
      });
  },

  async clickCandidateCenter(page, candidate = {}, waitMs) {
    const box = candidate.boundingBox || {};
    const x = Number(box.x || 0) + Number(box.width || 0) / 2;
    const y = Number(box.y || 0) + Number(box.height || 0) / 2;
    if (!Number.isFinite(x) || !Number.isFinite(y) || x <= 0 || y <= 0) {
      return false;
    }
    if (!page.mouse || typeof page.mouse.click !== 'function') {
      return false;
    }
    await page.mouse.click(x, y, { timeout: waitMs || 5000 });
    return true;
  },
};

const domVerifier = {
  waitForChecked,
  waitForEnabled,
};

function isOtpPayloadKey(payloadKey) {
  return /OTP/i.test(String(payloadKey || ''));
}

async function verifyFilledInput(locator, expectedValue, payloadKey) {
  const verification = await locator.evaluate((node, expected, otpPayload) => {
    const actual = typeof node?.value === 'string' ? node.value : '';
    const result = {
      expectedLength: expected.length,
      actualLength: actual.length,
      lengthMatches: actual.length === expected.length,
      valueMatches: actual === expected,
    };

    if (otpPayload) {
      result.expectedFormat = 'six_digits';
      result.formatMatches = /^\d{6}$/.test(actual);
    }

    return result;
  }, String(expectedValue || ''), isOtpPayloadKey(payloadKey));

  return {
    ...verification,
    verified: Boolean(verification.valueMatches),
  };
}

function cssAttrValue(value) {
  return String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

async function clickAssociatedLabel(page, option, waitMs) {
  const id = await option.evaluate(node => String(node?.id || ''));
  if (!id) {
    return false;
  }

  const label = page.locator(`label[for="${cssAttrValue(id)}"]`).first();
  await label.waitFor({ state: 'visible', timeout: Math.min(waitMs || 5000, 3000) });
  await domExecutor.click(label, waitMs);
  return true;
}

async function selectDeliveryOption(page, plan, waitMs, stabilityOptions = {}) {
  const stability = await waitForPageActionStability(page, plan, {
    timeoutMs: Math.max(waitMs || 5000, 15000),
    pollMs: 250,
    quietMs: 1000,
    minStablePolls: 2,
    ...stabilityOptions,
  });
  if (stability.status !== 'stable') {
    return {
      option: null,
      method: '',
      attempts: [`stability_${stability.status}:${stability.reason}`],
      stability,
    };
  }

  const option = page.locator(plan.optionSelector).first();
  await option.waitFor({ state: 'attached', timeout: waitMs || 5000 });

  const attempts = [];

  try {
    await domExecutor.check(option, waitMs);
    attempts.push('native_check');
    if (await domVerifier.waitForChecked(page, option, Math.min(waitMs || 5000, 1000))) {
      return { option, method: 'native_check', attempts, stability };
    }
  } catch (error) {
    attempts.push(`native_check_failed:${toSafeError(error)}`);
  }

  try {
    if (await clickAssociatedLabel(page, option, waitMs)) {
      attempts.push('label_click');
      if (await domVerifier.waitForChecked(page, option, Math.min(waitMs || 5000, 1500))) {
        return { option, method: 'label_click', attempts, stability };
      }
    }
  } catch (error) {
    attempts.push(`label_click_failed:${toSafeError(error)}`);
  }

  try {
    if (await domExecutor.clickCandidateCenter(page, plan.optionCandidate, waitMs)) {
      attempts.push('candidate_center_click');
      if (await domVerifier.waitForChecked(page, option, Math.min(waitMs || 5000, 1500))) {
        return { option, method: 'candidate_center_click', attempts, stability };
      }
    }
  } catch (error) {
    attempts.push(`candidate_center_click_failed:${toSafeError(error)}`);
  }

  return { option, method: '', attempts, stability };
}

async function executeRuntimeAction(page, plan = {}, payload = {}, options = {}) {
  const startedAtMs = Date.now();
  const waitMs = toInt(options.waitMs, 5000, 0);

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
      const target = page.locator(plan.selector).first();
      await target.waitFor({ state: 'visible', timeout: waitMs || 5000 });
      const enabled = await domVerifier.waitForEnabled(page, target, waitMs || 5000);
      if (!enabled) {
        return {
          status: 'failed',
          action: plan.type,
          stage: plan.stage,
          selector: plan.selector || '',
          error: 'target_not_enabled',
          durationMs: Math.max(0, Date.now() - startedAtMs),
        };
      }
      await domExecutor.click(target, waitMs);
      return {
        status: 'ok',
        action: plan.type,
        stage: plan.stage,
        selector: plan.selector,
        terminalOutcome: plan.terminalOutcome || '',
        durationMs: Math.max(0, Date.now() - startedAtMs),
      };
    } catch (error) {
      return {
        status: 'failed',
        action: plan.type,
        stage: plan.stage,
        selector: plan.selector || '',
        error: toSafeError(error),
        durationMs: Math.max(0, Date.now() - startedAtMs),
      };
    }
  }

  if (plan.type === 'select_option') {
    try {
      const target = page.locator(plan.selector).first();
      await target.waitFor({ state: 'visible', timeout: waitMs || 5000 });
      await domExecutor.selectOption(target, plan.selection, waitMs);
      return {
        status: 'ok',
        action: plan.type,
        stage: plan.stage,
        selector: plan.selector,
        terminalOutcome: plan.terminalOutcome || '',
        durationMs: Math.max(0, Date.now() - startedAtMs),
      };
    } catch (error) {
      return {
        status: 'failed',
        action: plan.type,
        stage: plan.stage,
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
        waitMs || 5000,
        options.pageStability || {}
      );
      const option = selection.option;

      if (!selection.method) {
        return {
          status: 'failed',
          action: plan.type,
          stage: plan.stage,
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
        const enabled = await domVerifier.waitForEnabled(page, submit, waitMs || 5000);
        if (enabled) {
          await domExecutor.click(submit, waitMs);
          submitClicked = true;
        }
      }

      if (!submitClicked) {
        await domExecutor.press(option, 'Enter').catch(() => {});
      }

      return {
        status: 'ok',
        action: plan.type,
        stage: plan.stage,
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
        stage: plan.stage,
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
    const input = page.locator(plan.inputSelector).first();
    await input.waitFor({ state: 'visible', timeout: waitMs || 5000 });
    await domExecutor.fill(input, value, waitMs);
    const fillVerification = await verifyFilledInput(input, value, plan.payloadKey);

    if (!fillVerification.verified) {
      return {
        status: 'failed',
        action: plan.type,
        stage: plan.stage,
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
        stage: plan.stage,
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
      const enabled = await domVerifier.waitForEnabled(page, submit, waitMs || 5000);
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
      stage: plan.stage,
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
      stage: plan.stage,
      inputSelector: plan.inputSelector || '',
      submitSelector: plan.submitSelector || '',
      error: toSafeError(error),
      durationMs: Math.max(0, Date.now() - startedAtMs),
    };
  }
}

module.exports = {
  executeRuntimeAction,
};
