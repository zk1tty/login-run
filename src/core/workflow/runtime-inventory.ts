const ZERO_WIDTH = 0;

type InventoryPage = {
  evaluate: <T = unknown>(pageFunction: (...args: unknown[]) => T, ...args: unknown[]) => Promise<T>;
  locator?: (...args: unknown[]) => unknown;
};

type RuntimePageLike = {
  getDriverPage?: () => InventoryPage | Promise<InventoryPage | null> | null;
  getPage?: () => InventoryPage | Promise<InventoryPage | null> | null;
  page?: InventoryPage;
  evaluate?: InventoryPage['evaluate'];
  locator?: (...args: unknown[]) => unknown;
};

type RuntimeCandidate = {
  placeholder?: string;
  value?: string;
  text?: string;
  label?: string[];
  ariaLabel?: string;
  autocomplete?: string;
  inputMode?: string;
  options?: Array<{ value: string; text: string; selected: boolean }>;
  valueLength?: number;
  active?: boolean;
  id?: string;
  name?: string;
  type?: string;
  role?: string;
  selector?: string;
  tag?: string;
  boundingBox?: {
    x?: number;
    y?: number;
    width?: number;
    height?: number;
  };
  visible?: boolean;
  focusable?: boolean;
  disabled?: boolean;
};

type RuntimeInventory = {
  title: string;
  url: string;
  text: string;
  activeSelector: string;
  formCount: number;
  candidates: RuntimeCandidate[];
  error?: string;
};

type RuntimeStage = {
  state: string;
  phase: string;
  reason: string;
  selector?: string;
  identifierSelector?: string;
  passwordSelector?: string;
};

type RuntimeInventoryInput = {
  candidates?: RuntimeCandidate[];
  title?: string;
  url?: string;
  text?: string;
};

type RuntimeChallengeSnapshot = {
  challengeVisible?: boolean;
};

type DocumentLike = {
  querySelectorAll?: (selector: string) => unknown[];
  querySelector?: (selector: string) => unknown;
  body?: { innerText?: string };
  title?: string;
  activeElement?: { tagName?: string };
  forms?: Array<unknown>;
  getElementById?: (value: string) => unknown;
};

type GlobalPageContext = {
  document?: DocumentLike;
  location?: { href?: string };
  URL?: { href?: string };
  CSS?: { escape?: (value: string) => string };
  getComputedStyle?: (node: unknown) => {
    display?: string;
    visibility?: string;
    opacity?: string;
  } | null;
};

function toSafeError(error: unknown): string {
  return String((error as { message?: unknown } | undefined)?.message || error || 'unknown_error');
}

async function resolveRuntimePage(input: unknown): Promise<InventoryPage | null> {
  if (!input || typeof input !== 'object') {
    return null;
  }
  const value = input as RuntimePageLike;

  if (typeof value.evaluate === 'function' && typeof value.locator === 'function') {
    return value as InventoryPage;
  }

  if (typeof value.getDriverPage === 'function') {
    const maybePage = await Promise.resolve(value.getDriverPage());
    if (maybePage && typeof maybePage.evaluate === 'function') {
      return maybePage;
    }
  }

  if (typeof value.getPage === 'function') {
    const page = await Promise.resolve(value.getPage());
    if (page && typeof page.evaluate === 'function') {
      return page;
    }
  }

  if (value.page && typeof value.page.evaluate === 'function') {
    return value.page;
  }

  return null;
}

function candidateArea(candidate: RuntimeCandidate = {}): number {
  const box = candidate.boundingBox || {};
  return Number(box.width || ZERO_WIDTH) * Number(box.height || ZERO_WIDTH);
}

function hasTinyBoundingBox(candidate: RuntimeCandidate = {}): boolean {
  if (!candidate.boundingBox) {
    return false;
  }
  const box = candidate.boundingBox;
  const width = Number(box?.width || ZERO_WIDTH);
  const height = Number(box?.height || ZERO_WIDTH);
  return width < 8 || height < 8 || candidateArea(candidate) < 100;
}

function isUsableCredentialInput(candidate: RuntimeCandidate = {}): boolean {
  return (
    candidate.visible === true &&
    candidate.disabled !== true &&
    candidate.focusable !== false &&
    !hasTinyBoundingBox(candidate)
  );
}

async function inspectRuntimeInventory(pageOrRuntime: unknown): Promise<RuntimeInventory> {
  const runtimePage = await resolveRuntimePage(pageOrRuntime);
  try {
    if (!runtimePage) {
      throw new Error('inspectRuntimeInventory requires a runtime page with evaluate().');
    }

    return await runtimePage.evaluate<RuntimeInventory>(() => {
      const globalContext = globalThis as unknown as GlobalPageContext;

      const documentObj = globalContext.document || {};
      const body = documentObj.body as { innerText?: string } | undefined;
      const doc = {
        body,
        title: documentObj.title || '',
        querySelectorAll: (selector: string) => (documentObj.querySelectorAll?.(selector) || []),
        querySelector: (selector: string) => documentObj.querySelector?.(selector),
      };

      function normalizeText(value: unknown, max = 160): string {
        return String(value || '')
          .replace(/\s+/g, ' ')
          .trim()
          .slice(0, max);
      }

      function cssEscape(value: unknown): string {
        const raw = String(value || '');
        if (globalContext.CSS?.escape) {
          return globalContext.CSS.escape(raw);
        }
        return raw.replace(/[^a-zA-Z0-9_-]/g, match => `\\${match}`);
      }

      function quoteAttr(value: unknown): string {
        return `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
      }

      function isVisible(node: unknown): boolean {
        if (!(node && typeof node === 'object')) {
          return false;
        }
        const candidateNode = node as {
          style?: { display?: string; visibility?: string; opacity?: string };
          getBoundingClientRect?: () => { width: number; height: number };
        };
        const style = globalContext.getComputedStyle?.(node as never) || candidateNode.style || {};
        const rect = candidateNode.getBoundingClientRect ? candidateNode.getBoundingClientRect() : { width: 0, height: 0 };
        return (
          style.display !== 'none' &&
          style.visibility !== 'hidden' &&
          style.opacity !== '0' &&
          rect.width > 0 &&
          rect.height > 0
        );
      }

      function isFocusable(node: unknown): boolean {
        if (!(node && typeof node === 'object')) {
          return false;
        }
        const candidateNode = node as { getAttribute?: (name: string) => string | null; focus?: () => void };
        if (candidateNode.getAttribute?.('disabled')) {
          return false;
        }
        const tabindex = candidateNode.getAttribute?.('tabindex');
        if (tabindex != null && Number(tabindex) < 0) {
          return false;
        }
        return typeof candidateNode.focus === 'function';
      }

      function getSelector(node: unknown): string {
        if (!(node && typeof node === 'object')) {
          return '';
        }
        const candidateNode = node as { getAttribute?: (name: string) => string | null; tagName?: string };
        const id = candidateNode.getAttribute?.('id');
        if (id) {
          return `#${cssEscape(id)}`;
        }
        const name = candidateNode.getAttribute?.('name');
        if (name) {
          return `${String(candidateNode.tagName || '').toLowerCase()}[name=${quoteAttr(name)}]`;
        }
        const aria = candidateNode.getAttribute?.('aria-label');
        if (aria) {
          return `${String(candidateNode.tagName || '').toLowerCase()}[aria-label=${quoteAttr(aria)}]`;
        }
        const type = candidateNode.getAttribute?.('type');
        if (type) {
          return `${String(candidateNode.tagName || '').toLowerCase()}[type=${quoteAttr(type)}]`;
        }
        return String(candidateNode.tagName || '').toLowerCase();
      }

      function labelFor(node: unknown): string[] {
        const labels: string[] = [];
        if (!(node && typeof node === 'object')) {
          return labels;
        }
        const candidateNode = node as {
          labels?: Array<{ textContent?: string }>;
          getAttribute?: (name: string) => string | null;
          closest?: (selector: string) => unknown;
          id?: string;
        };
        if (Array.isArray(candidateNode.labels)) {
          for (const label of candidateNode.labels) {
            labels.push(normalizeText(label.textContent));
          }
        }
        const id = candidateNode.getAttribute?.('id');
        if (id) {
          const query = `label[for="${cssEscape(id)}"]`;
          for (const label of documentObj.querySelectorAll?.(query) || []) {
            labels.push(normalizeText((label as { textContent?: string }).textContent));
          }
        }
        const wrappingLabel = candidateNode.closest?.('label');
        if (wrappingLabel) {
          labels.push(normalizeText((wrappingLabel as { textContent?: string }).textContent));
        }
        return [...new Set(labels.filter(Boolean))];
      }

      function buildCandidate(node: unknown, index: number) {
        if (!node || typeof node !== 'object') {
          return {
            index,
            tag: 'unknown',
            selector: '',
          };
        }
        const candidateNode = node as {
          getBoundingClientRect?: () => { x?: number; y?: number; width?: number; height?: number };
          value?: string | number;
          options?: Array<{ value: string; text: string; selected: boolean }>;
          tagName?: string;
          getAttribute?: (name: string) => string | null;
          hasAttribute?: (name: string) => boolean;
          nodeName?: string;
          textContent?: string;
          selected?: boolean;
        };
        const rect = candidateNode.getBoundingClientRect
          ? candidateNode.getBoundingClientRect()
          : { x: 0, y: 0, width: 0, height: 0 };
        const value = 'value' in candidateNode ? String(candidateNode.value || '') : '';
        const options = Array.isArray(candidateNode.options)
          ? candidateNode.options.map((option) => ({
              value: normalizeText(option?.value, 80),
              text: normalizeText(option?.text, 120),
              selected: option?.selected === true,
            }))
          : [];
        const element = node as { tagName?: string };
        return {
          index,
          tag: String(element.tagName || '').toLowerCase(),
          selector: getSelector(node),
          type: normalizeText(candidateNode.getAttribute?.('type')),
          role: normalizeText(candidateNode.getAttribute?.('role')),
          id: normalizeText(candidateNode.getAttribute?.('id')),
          name: normalizeText(candidateNode.getAttribute?.('name')),
          text: normalizeText(
            (candidateNode.textContent as string) ||
            (candidateNode.getAttribute?.('value') as string)
          ),
          label: labelFor(node),
          placeholder: normalizeText(candidateNode.getAttribute?.('placeholder')),
          ariaLabel: normalizeText(candidateNode.getAttribute?.('aria-label')),
          autocomplete: normalizeText(candidateNode.getAttribute?.('autocomplete')),
          inputMode: normalizeText(candidateNode.getAttribute?.('inputmode')),
          options,
          disabled:
            candidateNode.hasAttribute?.('disabled') ||
            String(candidateNode.getAttribute?.('aria-disabled') || '').toLowerCase() === 'true',
          visible: isVisible(node),
          focusable: isFocusable(node),
          active: activeElement === node,
          valueLength: value.length,
          boundingBox: {
            x: Math.round(Number(rect.x || 0)),
            y: Math.round(Number(rect.y || 0)),
            width: Math.round(Number(rect.width || 0)),
            height: Math.round(Number(rect.height || 0)),
          },
        };
      }

      const allNodes = Array.from(
        doc.querySelectorAll('input, textarea, button, a, select, [role="button"]')
      );
      const candidates = allNodes.map((node, index) => buildCandidate(node, index));
      const activeElement = documentObj.activeElement || null;

      return {
        title: doc.title || '',
        url: String(globalContext.location?.href || globalContext.URL?.['href'] || ''),
        text: normalizeText(body?.innerText || '', 5000),
        activeSelector:
          activeElement && String((activeElement as { nodeType?: number; tagName?: string }).tagName).length > 0
            ? getSelector(activeElement as unknown)
            : '',
        formCount: Array.isArray(documentObj.forms) ? documentObj.forms.length : 0,
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

function candidateCorpus(candidate: RuntimeCandidate = {}): string {
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

function isOtpCodeCandidate(candidate: RuntimeCandidate = {}): boolean {
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

function isOtpDeliveryCandidate(
  candidate: RuntimeCandidate = {},
  pageText = '',
): boolean {
  const tag = String(candidate.tag || '').toLowerCase();
  const type = String(candidate.type || '').toLowerCase();
  const role = String(candidate.role || '').toLowerCase();
  const corpus = candidateCorpus(candidate);
  const pageCorpus = String(pageText || '').toLowerCase();
  const deliveryPageHint =
    pageCorpus.includes('send code') ||
    pageCorpus.includes('verification code') ||
    (pageCorpus.includes('choose') && pageCorpus.includes('delivery')) ||
    (pageCorpus.includes('email') && pageCorpus.includes('text message'));
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

function hasVisibleTextCandidate(candidates: RuntimeCandidate[] = [], pattern: RegExp): boolean {
  return candidates.some(item =>
    item.visible === true &&
    pattern.test(
      [
        item.text,
        Array.isArray(item.label) ? item.label.join(' ') : '',
        item.ariaLabel,
        item.id,
      ].filter(Boolean).join(' ')
    )
  );
}

function hasAuthenticatedUrlTitleSignal(inventory: { title?: string; url?: string } = {}): boolean {
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

function isLikelyAuthenticated(
  inventory: { url?: string; title?: string; text?: string } = {},
  candidates: RuntimeCandidate[] = [],
): boolean {
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

function hasOtpError(inventory: { text?: string } = {}): boolean {
  const text = String(inventory.text || '').toLowerCase();
  return (
    text.includes('invalid code') ||
    text.includes('incorrect code') ||
    text.includes('expired code') ||
    text.includes('code has expired') ||
    (text.includes('try again') && text.includes('code')) ||
    text.includes('could not verify') ||
    text.includes('unable to verify')
  );
}

function classifyRuntimeStage(
  inventory: RuntimeInventoryInput = {},
  challengeSnapshot: RuntimeChallengeSnapshot = {},
): RuntimeStage {
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
    item => ['input', 'textarea', 'select'].includes(String(item.tag || '')) && isUsableCredentialInput(item)
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
    isOtpDeliveryCandidate(item, String(inventory.text || ''))
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
    if (!['input', 'textarea'].includes(String(item.tag || ''))) {
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
