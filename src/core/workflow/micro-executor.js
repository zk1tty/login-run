function normalizeBlockedCode(actionState) {
  const blockedCode = String(actionState?.blocked?.code || '').trim();
  return blockedCode || 'not_rendered';
}

function toActionSnapshot(actionState) {
  if (!actionState || typeof actionState !== 'object') {
    return {
      found: false,
      blockedCode: 'not_rendered',
      selector: '',
    };
  }

  return {
    found: actionState.found === true,
    selector: String(actionState.selector || ''),
    blockedCode: normalizeBlockedCode(actionState),
    action: String(actionState.action || ''),
  };
}

function isTransientPostInspectError(error) {
  const message = String(error?.message || error || '').toLowerCase();
  return (
    message.includes('execution context was destroyed') ||
    message.includes('cannot find context with specified id')
  );
}

function createMicroExecutor(options = {}) {
  if (typeof options.inspectAuthDocument !== 'function') {
    throw new Error('createMicroExecutor requires inspectAuthDocument function.');
  }
  if (typeof options.validateStepActionResult !== 'function') {
    throw new Error('createMicroExecutor requires validateStepActionResult function.');
  }

  const inspectAuthDocument = options.inspectAuthDocument;
  const validateStepActionResult = options.validateStepActionResult;
  const now = options.now || (() => Date.now());

  async function runHandler(input = {}) {
    const page = input.page;
    const stepDef = input.stepDef || {};
    const payload = input.payload || {};
    const selectorRef = String(stepDef.selectorRef || '').trim();
    const actionState = input.actionsBefore?.[selectorRef];
    const selector = String(actionState?.selector || '').trim();

    function blockedResult() {
      return {
        status: 'blocked',
        blockedCode: normalizeBlockedCode(actionState),
      };
    }

    if (stepDef.handler === 'assert_actionable') {
      if (!actionState?.found) {
        return blockedResult();
      }
      return {
        status: 'ok',
        actionable: true,
      };
    }

    if (stepDef.handler === 'toggle_if_present') {
      if (!actionState?.found) {
        return {
          status: 'ok',
          present: false,
          toggled: false,
        };
      }

      await page.click(selector);
      return {
        status: 'ok',
        present: true,
        toggled: true,
      };
    }

    if (!actionState?.found || !selector) {
      return blockedResult();
    }

    switch (stepDef.handler) {
      case 'focus_field': {
        await page.focus(selector);
        return {
          status: 'ok',
          focused: true,
        };
      }
      case 'type_from_payload': {
        const payloadKey = String(stepDef.payloadKey || '').trim();
        const rawValue = payload[payloadKey];
        if (rawValue == null) {
          return {
            status: 'failed',
            errorCode: 'missing_payload_value',
          };
        }
        const value = String(rawValue);
        await page.click(selector, { clickCount: 3 });
        await page.keyboard.press('Backspace');
        if (value) {
          await page.type(selector, value);
        }
        return {
          status: 'ok',
          typed: true,
          typedLength: value.length,
        };
      }
      case 'press_enter': {
        await page.focus(selector);
        await page.keyboard.press('Enter');
        return {
          status: 'ok',
          key: 'Enter',
        };
      }
      case 'click_field': {
        await page.click(selector);
        return {
          status: 'ok',
          clicked: true,
        };
      }
      case 'select_option': {
        const preferredValue = String(payload[String(stepDef.payloadKey || 'selection')] || '')
          .trim()
          .toLowerCase();
        const optionsList = Array.isArray(actionState.options)
          ? actionState.options
          : [];
        let selected = optionsList[0] || null;
        if (preferredValue) {
          selected = optionsList.find(item =>
            String(item?.text || '')
              .toLowerCase()
              .includes(preferredValue)
          ) || selected;
        }
        const targetSelector = String(selected?.selector || selector).trim();
        if (!targetSelector) {
          return {
            status: 'failed',
            errorCode: 'selection_target_missing',
          };
        }
        await page.click(targetSelector);
        return {
          status: 'ok',
          selected: true,
          selectedValue: String(selected?.text || preferredValue || 'selected'),
        };
      }
      default:
        return {
          status: 'failed',
          errorCode: 'unsupported_handler',
        };
    }
  }

  async function executeStep(input = {}) {
    const page = input.page;
    const macro = String(input.macro || '').trim();
    const stepId = String(input.stepId || '').trim();
    const stepDef = input.stepDef || {};
    const payload = input.payload || {};
    const startedAtMs = now();

    const before = await inspectAuthDocument(page);
    const actionsBefore = before.actions || before.queries || {};

    let rawResult;
    try {
      rawResult = await runHandler({
        page,
        stepDef,
        payload,
        actionsBefore,
      });
    } catch (error) {
      rawResult = {
        status: 'failed',
        errorCode: 'execution_exception',
        message: String(error?.message || error),
      };
    }

    const validated = validateStepActionResult({
      stepId,
      handler: stepDef.handler,
      result: rawResult,
    });

    let after = null;
    let postInspect = {
      state: 'ok',
      errorCode: '',
      message: '',
    };
    try {
      after = await inspectAuthDocument(page);
    } catch (error) {
      if (!isTransientPostInspectError(error)) {
        throw error;
      }
      postInspect = {
        state: 'transient_navigation',
        errorCode: 'execution_context_destroyed',
        message: String(error?.message || error),
      };
    }
    const actionStateBefore = toActionSnapshot(actionsBefore[String(stepDef.selectorRef || '')]);
    const actionsAfter = after ? (after.actions || after.queries || {}) : {};
    const actionStateAfter = toActionSnapshot(actionsAfter[String(stepDef.selectorRef || '')]);
    const phaseHintAfter = after
      ? (after.phaseHint || after.phase || 'unknown')
      : 'transient_navigation';

    return {
      macro,
      stepId,
      handler: stepDef.handler,
      startedAt: new Date(startedAtMs).toISOString(),
      finishedAt: new Date(now()).toISOString(),
      result: validated.result,
      status: validated.status,
      telemetry: {
        phaseHintBefore: before.phaseHint || before.phase || 'unknown',
        phaseHintAfter,
        actionBefore: actionStateBefore,
        actionAfter: actionStateAfter,
        postInspect,
      },
      actionsAfter,
    };
  }

  return {
    executeStep,
  };
}

module.exports = {
  createMicroExecutor,
};
