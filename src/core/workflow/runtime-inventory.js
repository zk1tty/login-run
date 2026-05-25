function toSafeError(error) {
  return String(error?.message || error || 'unknown_error');
}

function candidateArea(candidate = {}) {
  const box = candidate.boundingBox || {};
  return Number(box.width || 0) * Number(box.height || 0);
}

function hasTinyBoundingBox(candidate = {}) {
  if (!candidate.boundingBox) {
    return false;
  }
  const box = candidate.boundingBox;
  const width = Number(box.width || 0);
  const height = Number(box.height || 0);
  return width < 8 || height < 8 || candidateArea(candidate) < 100;
}

// Avoid being trapped by auto-complete decoy: e.g. PNC login input
// Runner:
//   re-inventory page
//   classify new state
//   decide whether workflow advanced
function isUsableCredentialInput(candidate = {}) {
  return (
    candidate.visible === true &&
    candidate.disabled !== true &&
    candidate.focusable !== false &&
    !hasTinyBoundingBox(candidate)
  );
}

async function inspectRuntimeInventory(page) {
  try {
    return await page.evaluate(() => {
      function normalizeText(value, max = 160) {
        return String(value || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, max);
      }

      function cssEscape(value) {
        const raw = String(value || '');
        if (globalThis.CSS && typeof globalThis.CSS.escape === 'function') {
          return globalThis.CSS.escape(raw);
        }
        return raw.replace(/[^a-zA-Z0-9_-]/g, match => `\\${match}`);
      }

      function quoteAttr(value) {
        return `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
      }

      function isVisible(node) {
        if (!(node instanceof HTMLElement)) {
          return false;
        }
        const style = window.getComputedStyle(node);
        const rect = node.getBoundingClientRect();
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.opacity !== '0' &&
          rect.width > 0 &&
          rect.height > 0
        );
      }

      function isFocusable(node) {
        if (!(node instanceof HTMLElement)) {
          return false;
        }
        if (node.hasAttribute('disabled')) {
          return false;
        }
        const tabindex = node.getAttribute('tabindex');
        if (tabindex != null && Number(tabindex) < 0) {
          return false;
        }
        return typeof node.focus === 'function';
      }

      function getSelector(node) {
        if (!(node instanceof Element)) {
          return '';
        }
        const id = node.getAttribute('id');
        if (id) {
          return `#${cssEscape(id)}`;
        }
        const name = node.getAttribute('name');
        if (name) {
          return `${node.tagName.toLowerCase()}[name=${quoteAttr(name)}]`;
        }
        const aria = node.getAttribute('aria-label');
        if (aria) {
          return `${node.tagName.toLowerCase()}[aria-label=${quoteAttr(aria)}]`;
        }
        const type = node.getAttribute('type');
        if (type) {
          return `${node.tagName.toLowerCase()}[type=${quoteAttr(type)}]`;
        }
        return node.tagName.toLowerCase();
      }

      function labelFor(node) {
        const labels = [];
        if (node instanceof HTMLInputElement && node.labels) {
          for (const label of node.labels) {
            labels.push(normalizeText(label.textContent));
          }
        }
        const id = node.getAttribute('id');
        if (id) {
          for (const label of document.querySelectorAll(`label[for="${cssEscape(id)}"]`)) {
            labels.push(normalizeText(label.textContent));
          }
        }
        const wrappingLabel = node.closest('label');
        if (wrappingLabel) {
          labels.push(normalizeText(wrappingLabel.textContent));
        }
        return [...new Set(labels.filter(Boolean))];
      }

      function buildCandidate(node, index) {
        const rect = node instanceof HTMLElement
          ? node.getBoundingClientRect()
          : { x: 0, y: 0, width: 0, height: 0 };
        const value = 'value' in node ? String(node.value || '') : '';
        const options = node instanceof HTMLSelectElement
          ? Array.from(node.options).map(option => ({
              value: normalizeText(option.value, 80),
              text: normalizeText(option.textContent, 120),
              selected: option.selected === true,
            }))
          : [];
        return {
          index,
          tag: node.tagName.toLowerCase(),
          selector: getSelector(node),
          type: normalizeText(node.getAttribute('type')),
          role: normalizeText(node.getAttribute('role')),
          id: normalizeText(node.getAttribute('id')),
          name: normalizeText(node.getAttribute('name')),
          text: normalizeText(node.textContent || node.getAttribute('value')),
          label: labelFor(node),
          placeholder: normalizeText(node.getAttribute('placeholder')),
          ariaLabel: normalizeText(node.getAttribute('aria-label')),
          autocomplete: normalizeText(node.getAttribute('autocomplete')),
          inputMode: normalizeText(node.getAttribute('inputmode')),
          options,
          disabled:
            node.hasAttribute('disabled') ||
            String(node.getAttribute('aria-disabled') || '').toLowerCase() === 'true',
          visible: isVisible(node),
          focusable: isFocusable(node),
          active: document.activeElement === node,
          valueLength: value.length,
          boundingBox: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        };
      }

      const allNodes = Array.from(
        document.querySelectorAll('input, textarea, button, a, select, [role="button"]')
      );
      const candidates = allNodes.map((node, index) => buildCandidate(node, index));

      return {
        title: document.title || '',
        url: location.href || '',
        text: normalizeText(document.body?.innerText || '', 5000),
        activeSelector:
          document.activeElement instanceof Element
            ? getSelector(document.activeElement)
            : '',
        formCount: document.querySelectorAll('form').length,
        candidates,
      };
    });
  } catch (error) {
    return {
      title: '',
      url: '',
      text: '',
      activeSelector: '',
      formCount: 0,
      candidates: [],
      error: toSafeError(error),
    };
  }
}

function candidateCorpus(candidate = {}) {
  return [
    Array.isArray(candidate.label) ? candidate.label.join(' ') : '',
    candidate.placeholder,
    candidate.ariaLabel,
    candidate.name,
    candidate.id,
    candidate.autocomplete,
    candidate.inputMode,
    candidate.text,
    Array.isArray(candidate.options)
      ? candidate.options.map(option => `${option.text || ''} ${option.value || ''}`).join(' ')
      : '',
  ].join(' ').toLowerCase();
}

function isOtpCodeCandidate(candidate = {}) {
  const corpus = candidateCorpus(candidate);
  return (
    corpus.includes('one-time') ||
    corpus.includes('one time') ||
    corpus.includes('verification code') ||
    corpus.includes('security code') ||
    corpus.includes('confirmation code') ||
    corpus.includes('passcode') ||
    candidate.autocomplete === 'one-time-code' ||
    /\botp\b/.test(corpus)
  );
}

function isOtpDeliveryCandidate(candidate = {}, pageText = '') {
  const tag = String(candidate.tag || '').toLowerCase();
  const type = String(candidate.type || '').toLowerCase();
  const role = String(candidate.role || '').toLowerCase();
  const corpus = candidateCorpus(candidate);
  const pageCorpus = String(pageText || '').toLowerCase();
  const deliveryPageHint =
    pageCorpus.includes('send code') ||
    pageCorpus.includes('verification code') ||
    pageCorpus.includes('choose') && pageCorpus.includes('delivery') ||
    pageCorpus.includes('email') && pageCorpus.includes('text message');
  const deliveryTextHint =
    corpus.includes('email') ||
    corpus.includes('text message') ||
    corpus.includes('sms') ||
    corpus.includes('phone') ||
    corpus.includes('send code') ||
    corpus.includes('send verification') ||
    corpus.includes('delivery');
  const selectable =
    tag === 'select' ||
    tag === 'button' ||
    role === 'button' ||
    tag === 'a' ||
    (tag === 'input' && ['radio', 'button', 'submit'].includes(type));
  const negativeTextHint =
    corpus.includes('do not recognize') ||
    corpus.includes('contact member services') ||
    corpus.includes('help') ||
    corpus.includes('forgot');

  return deliveryPageHint && deliveryTextHint && selectable && !negativeTextHint;
}

function hasVisibleTextCandidate(candidates, pattern) {
  return candidates.some(item =>
    item.visible === true &&
    pattern.test([
      item.text,
      Array.isArray(item.label) ? item.label.join(' ') : '',
      item.ariaLabel,
      item.id,
    ].filter(Boolean).join(' '))
  );
}

function hasAuthenticatedUrlTitleSignal(inventory = {}) {
  const title = String(inventory.title || '').toLowerCase();
  try {
    const url = new URL(String(inventory.url || ''));
    const hostname = url.hostname.toLowerCase();
    const pathname = url.pathname.toLowerCase();

    return (
      hostname === 'member.my.healthequity.com' && title.includes('member portal') ||
      hostname.endsWith('.healthequity.com') &&
        pathname === '/member/memberhome.aspx' &&
        (title.includes('member') || title.includes('account'))
    );
  } catch {
    return false;
  }
}

function isLikelyAuthenticated(inventory = {}, candidates = []) {
  const url = String(inventory.url || '').toLowerCase();
  const title = String(inventory.title || '').toLowerCase();
  const text = String(inventory.text || '').toLowerCase();
  const urlTitleSignal = hasAuthenticatedUrlTitleSignal(inventory);
  const hasSignOut = hasVisibleTextCandidate(candidates, /\bsign\s*out\b/i);
  const accountUrlHint =
    url.includes('/member/memberhome') ||
    url.includes('/member/') ||
    url.includes('/account') ||
    url.includes('/dashboard');
  const accountTextHint =
    text.includes('account balance') ||
    text.includes('available balance') ||
    text.includes('member home') ||
    text.includes('my account') ||
    title.includes('account') ||
    title.includes('member');
  return urlTitleSignal || (hasSignOut && (accountUrlHint || accountTextHint));
}

function hasOtpError(inventory = {}) {
  const text = String(inventory.text || '').toLowerCase();
  return (
    text.includes('invalid code') ||
    text.includes('incorrect code') ||
    text.includes('expired code') ||
    text.includes('code has expired') ||
    text.includes('try again') && text.includes('code') ||
    text.includes('could not verify') ||
    text.includes('unable to verify')
  );
}

function classifyRuntimeStage(inventory = {}, challengeSnapshot = {}) {
  const snapshot = challengeSnapshot || {};
  if (snapshot.challengeVisible === true) {
    return {
      state: 'captcha',
      phase: 'challenge',
      reason: 'Challenge markers are visible on the page.',
    };
  }

  const candidates = Array.isArray(inventory.candidates) ? inventory.candidates : [];
  const visible = candidates.filter(item => item.visible === true && item.disabled !== true);
  const usableCredentialInputs = visible.filter(
    item => ['input', 'textarea', 'select'].includes(item.tag) && isUsableCredentialInput(item)
  );

  if (isLikelyAuthenticated(inventory, candidates)) {
    const hasOtpInput = usableCredentialInputs.some(isOtpCodeCandidate);
    const hasPasswordInput = usableCredentialInputs.some(
      item => item.tag === 'input' && item.type === 'password'
    );
    if (!hasOtpInput && !hasPasswordInput) {
      return {
        state: 'authed',
        phase: 'authenticated',
        reason: 'Authenticated page signals detected.',
      };
    }
  }

  const passwordCandidate = usableCredentialInputs.find(
    item => item.tag === 'input' && item.type === 'password'
  );
  const otpCandidate = usableCredentialInputs.find(isOtpCodeCandidate);
  if (otpCandidate) {
    if (hasOtpError(inventory)) {
      return {
        state: 'otp_error',
        phase: 'credential',
        reason: 'OTP input is visible with an OTP error message.',
        selector: otpCandidate.selector,
      };
    }
    return {
      state: 'otp_code',
      phase: 'credential',
      reason: 'Visible enabled OTP-like input detected.',
      selector: otpCandidate.selector,
    };
  }

  const otpDeliveryCandidates = candidates.filter(
    item => item.disabled !== true && (item.visible === true || item.focusable === true)
  );
  const otpDeliveryCandidate = otpDeliveryCandidates.find(item =>
    isOtpDeliveryCandidate(item, inventory.text)
  );
  if (otpDeliveryCandidate) {
    return {
      state: 'otp_delivery_selection',
      phase: 'credential',
      reason: 'Visible OTP delivery option detected.',
      selector: otpDeliveryCandidate.selector,
    };
  }

  const identifierCandidate = usableCredentialInputs.find(item => {
    if (!['input', 'textarea'].includes(item.tag)) {
      return false;
    }
    return item.type === '' || item.type === 'text' || item.type === 'email';
  });
  if (identifierCandidate && passwordCandidate) {
    return {
      state: 'id+pw',
      phase: 'credential',
      reason: 'Visible enabled identifier and password inputs detected.',
      selector: identifierCandidate.selector,
      identifierSelector: identifierCandidate.selector,
      passwordSelector: passwordCandidate.selector,
    };
  }

  if (passwordCandidate) {
    return {
      state: 'password',
      phase: 'credential',
      reason: 'Visible enabled password input detected.',
      selector: passwordCandidate.selector,
    };
  }

  if (identifierCandidate) {
    return {
      state: 'identifier',
      phase: 'credential',
      reason: 'Visible enabled text-like input detected.',
      selector: identifierCandidate.selector,
    };
  }

  return {
    state: 'blocked_or_unknown',
    phase: 'unknown',
    reason: 'No confident login-stage candidate found from runtime inventory.',
  };
}

module.exports = {
  inspectRuntimeInventory,
  classifyRuntimeStage,
  isOtpCodeCandidate,
  isOtpDeliveryCandidate,
  isLikelyAuthenticated,
  hasAuthenticatedUrlTitleSignal,
  hasOtpError,
};
