const cheerio = require('cheerio');

const BLOCKED_CODES = {
  NOT_RENDERED: 'not_rendered',
  HIDDEN: 'hidden',
  DISABLED: 'disabled',
  OUT_OF_PHASE: 'out_of_phase',
};

function normalizeText(value) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim();
}

function quoteAttr(value) {
  return `"${String(value || '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

function buildBlocked(code) {
  return { code };
}

function buildSelector($el) {
  const id = String($el.attr('id') || '').trim();
  if (id) {
    return `#${id}`;
  }

  const tag = String($el.prop('tagName') || 'element').toLowerCase();
  const name = String($el.attr('name') || '').trim();
  if (name) {
    return `${tag}[name=${quoteAttr(name)}]`;
  }

  const dataTestId = String($el.attr('data-testid') || '').trim();
  if (dataTestId) {
    return `${tag}[data-testid=${quoteAttr(dataTestId)}]`;
  }

  return tag;
}

function isHiddenElement($, $el) {
  if (!$el || !$el.length) {
    return false;
  }

  if ($el.attr('hidden') != null) {
    return true;
  }

  const type = String($el.attr('type') || '').toLowerCase();
  if (type === 'hidden') {
    return true;
  }

  let cursor = $el;
  while (cursor && cursor.length) {
    const style = String(cursor.attr('style') || '').toLowerCase();
    if (
      style.includes('display:none') ||
      style.includes('display: none') ||
      style.includes('visibility:hidden') ||
      style.includes('visibility: hidden') ||
      style.includes('opacity:0') ||
      style.includes('opacity: 0')
    ) {
      return true;
    }
    if (String(cursor.attr('aria-hidden') || '').toLowerCase() === 'true') {
      return true;
    }
    cursor = cursor.parent();
  }

  return false;
}

function isDisabledElement($el) {
  return (
    $el.attr('disabled') != null ||
    String($el.attr('aria-disabled') || '').toLowerCase() === 'true'
  );
}

function buildMatchNotFound(code = BLOCKED_CODES.NOT_RENDERED) {
  return {
    found: false,
    selector: '',
    blocked: buildBlocked(code),
  };
}

function buildMatch($, $el, options = {}) {
  if (!$el || !$el.length) {
    return buildMatchNotFound(BLOCKED_CODES.NOT_RENDERED);
  }

  if (isHiddenElement($, $el)) {
    return buildMatchNotFound(BLOCKED_CODES.HIDDEN);
  }

  if (isDisabledElement($el)) {
    return buildMatchNotFound(BLOCKED_CODES.DISABLED);
  }

  const out = {
    found: true,
    selector: buildSelector($el),
  };

  if (options.withValue) {
    const raw = String($el.val() || '');
    out.value = {
      raw,
      length: raw.length,
      isEmpty: raw.length === 0,
    };
  }

  if (options.withOptions) {
    out.options = [];
  }

  return out;
}

function pickBest($, selector, scoreFn, options = {}) {
  const minScore = Number.isFinite(Number(options.minScore))
    ? Number(options.minScore)
    : Number.NEGATIVE_INFINITY;
  const nodes = $(selector).toArray();
  let best = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (const node of nodes) {
    const $node = $(node);
    const score = Number(scoreFn($node));
    if (!Number.isFinite(score)) {
      continue;
    }
    if (score < minScore) {
      continue;
    }
    if (score > bestScore) {
      bestScore = score;
      best = $node;
    }
  }

  return best;
}

function scoreByHints($, $el, hints = []) {
  const tag = String($el.prop('tagName') || '').toLowerCase();
  const type = String($el.attr('type') || '').toLowerCase();
  const corpus = normalizeText(
    [
      $el.attr('id'),
      $el.attr('name'),
      $el.attr('placeholder'),
      $el.attr('aria-label'),
      $el.attr('autocomplete'),
      $el.attr('value'),
      $el.text(),
      tag,
      type,
    ].join(' ')
  ).toLowerCase();

  let score = 0;
  for (const hint of hints) {
    if (corpus.includes(String(hint).toLowerCase())) {
      score += 10;
    }
  }

  return score;
}

function markOutOfPhase(action) {
  return {
    ...action,
    found: false,
    blocked: buildBlocked(BLOCKED_CODES.OUT_OF_PHASE),
  };
}

function inspectAuthDocumentFromHtml(input = {}) {
  const html = String(input.html || '');
  const url = String(input.url || '').trim();
  const $ = cheerio.load(html);
  const title = normalizeText(input.title || $('title').first().text());

  const username = buildMatch(
    $,
    pickBest($, 'input, textarea', $el =>
      scoreByHints($, $el, [
        'username',
        'user name',
        'user',
        'email',
        'login',
        'member id',
        'account',
        'userid',
      ]) - (String($el.attr('type') || '').toLowerCase() === 'password' ? 100 : 0),
      { minScore: 10 }
    ),
    { withValue: true }
  );

  const password = buildMatch(
    $,
    pickBest($, 'input, textarea', $el =>
      scoreByHints($, $el, ['password', 'passcode', 'pin']) +
      (String($el.attr('type') || '').toLowerCase() === 'password' ? 25 : 0)
    , { minScore: 10 })
  );

  const continueButton = buildMatch(
    $,
    pickBest($, 'button, input[type="submit"], input[type="button"], a', $el =>
      scoreByHints($, $el, ['continue', 'next', 'sign in', 'log in']),
      { minScore: 10 }
    )
  );

  const selection = buildMatch(
    $,
    pickBest($, 'input[type="radio"], select option, label', $el =>
      scoreByHints($, $el, [
        'sms',
        'text',
        'phone',
        'call',
        'email',
        'authenticator',
        'app',
        'verification',
        'code',
      ])
    , { minScore: 10 })
  );

  const sendCodeButton = buildMatch(
    $,
    pickBest($, 'button, input[type="submit"], input[type="button"], [role="button"], a', $el => {
      const text = normalizeText($el.text() || $el.attr('value') || '').toLowerCase();
      if (/\bsend\b/.test(text) && /\b(code|verification|confirmation)\b/.test(text)) {
        return 100;
      }
      return scoreByHints($, $el, ['send code']);
    }, { minScore: 20 })
  );

  const confirmButton = buildMatch(
    $,
    pickBest($, 'button, input[type="submit"], input[type="button"], [role="button"], a', $el => {
      const text = normalizeText($el.text() || $el.attr('value') || '').toLowerCase();
      if (/\bsend\b/.test(text) && /\b(code|verification|confirmation)\b/.test(text)) {
        return -100;
      }
      if (/\b(confirm|verify)\b/.test(text)) {
        return 100;
      }
      return scoreByHints($, $el, ['confirm', 'verify']);
    }, { minScore: 20 })
  );

  const confirmationCodeInput = buildMatch(
    $,
    pickBest($, 'input, textarea', $el =>
      scoreByHints($, $el, [
        'confirmation code',
        'verification code',
        'security code',
        'otp',
        'one-time',
        'passcode',
        'code',
      ]),
      { minScore: 10 }
    )
  );

  const rememberDevice = buildMatch(
    $,
    pickBest(
      $,
      'input[type="checkbox"], label, button, [role="button"], a',
      $el =>
        scoreByHints($, $el, [
          'remember this device',
          'remember device',
          'trust this device',
          'trusted device',
          'keep me signed in',
        ]),
      { minScore: 10 }
    )
  );

  const hasPasswordInput = password.found;
  const hasOtpInput = confirmationCodeInput.found;
  const hasLoginIdentifierInput = username.found;
  const hasLogoutControl = $('a[href*="logout" i], a[id*="logout" i], button[id*="logout" i]').length > 0;
  const hasCloudflareChallenge =
    $('#challenge-running, [id*="cf-challenge" i], [class*="cf-challenge" i], iframe[src*="challenges.cloudflare" i]').length > 0 ||
    url.toLowerCase().includes('/cdn-cgi/');

  const headings = $('h1, h2, h3, [role="heading"]')
    .toArray()
    .slice(0, 24)
    .map(node => ({
      tag: String(node.tagName || '').toLowerCase(),
      text: normalizeText($(node).text()),
    }))
    .filter(item => item.text);

  const navLinks = $('header a, nav a')
    .toArray()
    .slice(0, 24)
    .map(node => ({
      text: normalizeText($(node).text()),
      href: String($(node).attr('href') || ''),
    }))
    .filter(item => item.text || item.href);

  const formActionLabels = $('form button, form [type="submit"], [role="button"]')
    .toArray()
    .slice(0, 12)
    .map(node => normalizeText($(node).text() || $(node).attr('value')))
    .filter(Boolean);

  const pageLabelHints = $('main h1, main h2, .page-title, [class*="title" i], [data-testid*="title" i]')
    .toArray()
    .slice(0, 12)
    .map(node => normalizeText($(node).text()))
    .filter(Boolean);

  const bodyText = normalizeText($.root().text()).toLowerCase();
  const otpHintsFromText =
    bodyText.includes('verification code') ||
    bodyText.includes('one-time code') ||
    bodyText.includes('security verification');
  const phase =
    /securitycode|two[-_ ]?factor|otp|verification/i.test(url) ||
    hasOtpInput ||
    selection.found ||
    sendCodeButton.found ||
    rememberDevice.found ||
    otpHintsFromText
      ? 'two_factor'
      : 'initial';

  const actions = {
    username,
    password,
    continueButton,
    selection,
    sendCodeButton,
    confirmButton,
    confirmationCodeInput,
    rememberDevice,
  };

  const queries = {
    initial: phase === 'initial'
      ? {
          username,
          password,
          continueButton,
        }
      : {
          username: markOutOfPhase(username),
          password: markOutOfPhase(password),
          continueButton: markOutOfPhase(continueButton),
        },
    twoFactor: phase === 'two_factor'
      ? {
          selection,
          confirmationCodeInput,
          rememberDevice,
        }
      : {
          selection: markOutOfPhase(selection),
          confirmationCodeInput: markOutOfPhase(confirmationCodeInput),
          rememberDevice: markOutOfPhase(rememberDevice),
        },
  };

  const hasSessionExpiredPhrase =
    bodyText.includes('session expired') ||
    bodyText.includes('sign in again') ||
    bodyText.includes('log in again');

  return {
    title,
    url,
    phase,
    phaseHint: phase,
    hasPasswordInput,
    hasOtpInput,
    hasLoginIdentifierInput,
    hasLogoutControl,
    hasCloudflareChallenge,
    hasSessionExpiredPhrase,
    headings,
    navLinks,
    formActionLabels,
    pageLabelHints,
    actions,
    queries,
  };
}

function detectAuthState(signals = {}) {
  const title = String(signals.title || '').toLowerCase();
  const url = String(signals.url || '').toLowerCase();
  const headingCorpus = Array.isArray(signals.headings)
    ? signals.headings
        .map(item => String(item?.text || '').toLowerCase())
        .join(' ')
    : '';
  const navCorpus = Array.isArray(signals.navLinks)
    ? signals.navLinks
        .map(item => String(item?.text || '').toLowerCase())
        .join(' ')
    : '';
  const actionCorpus = Array.isArray(signals.formActionLabels)
    ? signals.formActionLabels
        .map(item => String(item || '').toLowerCase())
        .join(' ')
    : '';
  const pageLabelCorpus = Array.isArray(signals.pageLabelHints)
    ? signals.pageLabelHints
        .map(item => String(item || '').toLowerCase())
        .join(' ')
    : '';
  const corpus = `${title} ${headingCorpus} ${navCorpus} ${actionCorpus} ${pageLabelCorpus}`;
  const onMemberPath = /\/member\//i.test(url);
  const onLoginPath = /(clientlogin|login|sign-in|signin|auth|saml)/i.test(url);
  const hasCredentialQueries =
    signals?.queries?.initial?.username?.found === true ||
    signals?.queries?.initial?.password?.found === true;
  const hasOtpQueries =
    signals?.queries?.twoFactor?.confirmationCodeInput?.found === true ||
    signals?.queries?.twoFactor?.selection?.found === true;

  if (
    signals.hasCloudflareChallenge ||
    title.includes('just a moment') ||
    url.includes('/cdn-cgi/')
  ) {
    return {
      state: 'challenge',
      reason: 'Challenge page markers detected (Cloudflare-style).',
    };
  }

  if (
    signals.hasOtpInput ||
    hasOtpQueries ||
    corpus.includes('verification code') ||
    corpus.includes('one-time code')
  ) {
    return {
      state: 'need_otp',
      reason: 'OTP verification markers detected.',
    };
  }

  if (
    signals.hasPasswordInput &&
    (signals.hasSessionExpiredPhrase ||
      corpus.includes('session expired') ||
      corpus.includes('sign in again') ||
      corpus.includes('log in again'))
  ) {
    return {
      state: 'reauth',
      reason: 'Password prompt with re-auth/session-expired markers detected.',
    };
  }

  if (
    !signals.hasPasswordInput &&
    (onMemberPath ||
      signals.hasLogoutControl ||
      url.includes('membertransactions') ||
      corpus.includes('transaction history') ||
      corpus.includes('health savings account (hsa)'))
  ) {
    return {
      state: 'authed',
      reason: 'Authenticated member page markers detected.',
    };
  }

  if (
    signals.hasPasswordInput ||
    hasCredentialQueries ||
    (onLoginPath && signals.hasLoginIdentifierInput)
  ) {
    return {
      state: 'need_cred',
      reason: 'Login form markers detected.',
    };
  }

  return {
    state: 'unknown',
    reason: 'No strong markers for auth stage classification.',
  };
}

async function inspectAuthDocument(page) {
  return page.evaluate(() => {
    function normalizeText(value, max = 200) {
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
      if (
        style.display === 'none' ||
        style.visibility === 'hidden' ||
        style.opacity === '0'
      ) {
        return false;
      }
      const rect = node.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0;
    }

    function isEnabled(node) {
      if (!node || !(node instanceof HTMLElement)) {
        return false;
      }
      return !node.hasAttribute('disabled') && node.getAttribute('aria-disabled') !== 'true';
    }

    function getLabelText(node) {
      if (!node || !(node instanceof HTMLElement)) {
        return '';
      }

      const labels = [];
      if (Array.isArray(node.labels)) {
        for (const label of node.labels) {
          labels.push(normalizeText(label.textContent, 200));
        }
      }
      const id = node.getAttribute('id');
      if (id) {
        const escaped = cssEscape(id);
        const byFor = document.querySelectorAll(`label[for="${escaped}"]`);
        for (const label of byFor) {
          labels.push(normalizeText(label.textContent, 200));
        }
      }
      const wrappingLabel = node.closest('label');
      if (wrappingLabel) {
        labels.push(normalizeText(wrappingLabel.textContent, 200));
      }

      return labels.filter(Boolean).join(' ').trim();
    }

    function buildSelector(node) {
      if (!node || !(node instanceof Element)) {
        return '';
      }

      const id = node.getAttribute('id');
      if (id) {
        const selector = `#${cssEscape(id)}`;
        if (document.querySelectorAll(selector).length === 1) {
          return selector;
        }
      }

      const preferredAttrs = ['data-testid', 'data-test', 'data-qa', 'name', 'aria-label'];
      for (const attr of preferredAttrs) {
        const value = node.getAttribute(attr);
        if (!value) {
          continue;
        }
        const tag = node.tagName.toLowerCase();
        const selector = `${tag}[${attr}=${quoteAttr(value)}]`;
        if (document.querySelectorAll(selector).length === 1) {
          return selector;
        }
      }

      const tag = node.tagName.toLowerCase();
      const type = node.getAttribute('type');
      if (type) {
        const selector = `${tag}[type=${quoteAttr(type)}]`;
        if (document.querySelectorAll(selector).length === 1) {
          return selector;
        }
      }

      const parts = [];
      let current = node;
      let depth = 0;
      while (current && current.nodeType === Node.ELEMENT_NODE && depth < 6) {
        let segment = current.nodeName.toLowerCase();
        if (current.id) {
          segment += `#${cssEscape(current.id)}`;
          parts.unshift(segment);
          break;
        }
        const siblings = current.parentElement
          ? Array.from(current.parentElement.children).filter(
              sibling => sibling.nodeName === current.nodeName
            )
          : [];
        if (siblings.length > 1) {
          const index = siblings.indexOf(current) + 1;
          segment += `:nth-of-type(${index})`;
        }
        parts.unshift(segment);
        current = current.parentElement;
        depth += 1;
      }
      return parts.join(' > ');
    }

    function collectTexts(selector, maxItems = 12, maxLength = 140) {
      return Array.from(document.querySelectorAll(selector))
        .map(node => normalizeText(node.textContent, maxLength))
        .filter(Boolean)
        .slice(0, maxItems);
    }

    function collectLinks(selector, maxItems = 16, maxLength = 120) {
      return Array.from(document.querySelectorAll(selector))
        .map(node => ({
          text: normalizeText(node.textContent, maxLength),
          href: String(node.getAttribute('href') || '').slice(0, 240),
        }))
        .filter(item => item.text || item.href)
        .slice(0, maxItems);
    }

    function buildElementMatch(node, score = 0) {
      if (!node || !(node instanceof Element)) {
        return null;
      }

      const tag = node.tagName.toLowerCase();
      return {
        found: true,
        selector: buildSelector(node),
        score,
        tag,
        type: String(node.getAttribute('type') || '').toLowerCase(),
        id: String(node.getAttribute('id') || ''),
        name: String(node.getAttribute('name') || ''),
        autocomplete: String(node.getAttribute('autocomplete') || ''),
        placeholder: String(node.getAttribute('placeholder') || ''),
        label: getLabelText(node),
        text: normalizeText(node.textContent, 200),
      };
    }

    function buildNotFound() {
      return {
        found: false,
        selector: '',
        score: 0,
      };
    }

    function scoreByHints(node, hints = [], options = {}) {
      const type = String(node.getAttribute('type') || '').toLowerCase();
      const attrCorpus = [
        node.getAttribute('id'),
        node.getAttribute('name'),
        node.getAttribute('placeholder'),
        node.getAttribute('aria-label'),
        node.getAttribute('autocomplete'),
        node.getAttribute('value'),
        getLabelText(node),
        normalizeText(node.textContent, 220),
      ]
        .filter(Boolean)
        .join(' ')
        .toLowerCase();

      let score = 0;
      if (isVisible(node)) {
        score += 10;
      } else {
        score -= 10;
      }
      if (isEnabled(node)) {
        score += 6;
      } else {
        score -= 20;
      }

      for (const hint of hints) {
        if (attrCorpus.includes(String(hint).toLowerCase())) {
          score += 15;
        }
      }

      if (options.preferTypes && options.preferTypes.includes(type)) {
        score += 20;
      }

      if (options.autocompleteHints) {
        const autocomplete = String(node.getAttribute('autocomplete') || '').toLowerCase();
        for (const hint of options.autocompleteHints) {
          if (autocomplete.includes(String(hint).toLowerCase())) {
            score += 18;
          }
        }
      }

      return score;
    }

    function selectTop(nodes, hints, options = {}) {
      const scored = [];
      for (const node of nodes) {
        if (!(node instanceof Element)) {
          continue;
        }
        if (options.requireVisible && !isVisible(node)) {
          continue;
        }
        const score = scoreByHints(node, hints, options);
        if (options.minScore != null && score < options.minScore) {
          continue;
        }
        const match = buildElementMatch(node, score);
        if (match) {
          scored.push(match);
        }
      }
      scored.sort((a, b) => b.score - a.score);
      return scored;
    }

    function topOrNotFound(matches, action) {
      const top = matches[0] || buildNotFound();
      return {
        ...top,
        action,
        candidates: matches.slice(0, 5),
      };
    }

    function collectTwoFactorSelectionOptions() {
      const hints = [
        'sms',
        'text',
        'phone',
        'call',
        'email',
        'authenticator',
        'app',
        'verification',
        'code',
        'send',
      ];
      const nodes = [
        ...Array.from(document.querySelectorAll('input[type="radio"]')),
        ...Array.from(document.querySelectorAll('select option')),
        ...Array.from(document.querySelectorAll('button, [role="button"], label')),
      ];
      const options = selectTop(nodes, hints, {
        requireVisible: true,
        minScore: 10,
      })
        .filter(item => item.text || item.label)
        .slice(0, 10);

      return {
        found: options.length > 0,
        action: 'select_option',
        options,
      };
    }

    const title = normalizeText(document.title, 300);
    const url = String(window.location.href || '');
    const headings = Array.from(
      document.querySelectorAll('h1, h2, h3, [role="heading"]')
    )
      .slice(0, 24)
      .map(node => {
        const tag = String(node.tagName || '').toUpperCase();
        const ariaLevel = Number(node.getAttribute?.('aria-level') || 0);
        const headingLevel =
          Number.isFinite(ariaLevel) && ariaLevel > 0
            ? ariaLevel
            : /^H[1-6]$/.test(tag)
              ? Number(tag.slice(1))
              : 0;
        return {
          tag: tag.toLowerCase(),
          level: headingLevel,
          text: normalizeText(node.textContent, 220),
        };
      })
      .filter(item => item.text);

    const hasPasswordInput = Boolean(
      document.querySelector('input[type="password"]')
    );
    const hasOtpInput = Boolean(
      document.querySelector(
        'input[autocomplete="one-time-code"], input[name*="otp" i], input[id*="otp" i], input[name*="verification" i], input[id*="verification" i], input[name*="code" i], input[id*="code" i]'
      )
    );
    const hasLoginIdentifierInput = Boolean(
      document.querySelector(
        'input[type="email"], input[name*="email" i], input[id*="email" i], input[name*="user" i], input[id*="user" i], input[name*="login" i], input[id*="login" i]'
      )
    );
    const hasLogoutControl = Boolean(
      document.querySelector(
        'a[href*="logout" i], a[id*="logout" i], button[id*="logout" i], [aria-label*="logout" i]'
      )
    );
    const hasCloudflareChallenge = Boolean(
      document.querySelector(
        '#challenge-running, [id*="cf-challenge" i], [class*="cf-challenge" i], iframe[src*="challenges.cloudflare" i], form[action*="/cdn-cgi/challenge-platform" i]'
      )
    );

    const formActionLabels = collectTexts(
      'form button, form [type="submit"], [role="button"]',
      12,
      120
    );
    const pageLabelHints = collectTexts(
      'main h1, main h2, .page-title, [class*="title" i], [data-testid*="title" i]',
      12,
      160
    );
    const navLinks = collectLinks('header a, nav a', 24, 100);

    const corpus = [
      title,
      ...headings.map(item => item.text),
      ...formActionLabels,
      ...pageLabelHints,
      ...navLinks.map(item => item.text),
    ]
      .join(' ')
      .toLowerCase();
    const hasSessionExpiredPhrase =
      corpus.includes('session expired') ||
      corpus.includes('sign in again') ||
      corpus.includes('log in again');

    const usernameMatches = selectTop(
      Array.from(document.querySelectorAll('input, textarea')),
      ['username', 'user name', 'email', 'login', 'member id', 'account', 'userid'],
      {
        preferTypes: ['email', 'text', 'tel'],
        autocompleteHints: ['username', 'email'],
        requireVisible: true,
        minScore: 8,
      }
    );
    const passwordMatches = selectTop(
      Array.from(document.querySelectorAll('input[type="password"], input, textarea')),
      ['password', 'passcode', 'pin'],
      {
        preferTypes: ['password'],
        autocompleteHints: ['current-password', 'password'],
        requireVisible: true,
        minScore: 8,
      }
    );
    const continueMatches = selectTop(
      Array.from(
        document.querySelectorAll(
          'button, input[type="submit"], input[type="button"], [role="button"], a'
        )
      ),
      ['continue', 'next', 'sign in', 'log in', 'submit', 'verify', 'send code'],
      {
        requireVisible: true,
        minScore: 10,
      }
    );
    const confirmationCodeMatches = selectTop(
      Array.from(document.querySelectorAll('input, textarea')),
      ['confirmation code', 'verification code', 'security code', 'otp', 'one-time', 'passcode', 'code'],
      {
        preferTypes: ['text', 'tel', 'number'],
        autocompleteHints: ['one-time-code'],
        requireVisible: true,
        minScore: 10,
      }
    );
    const rememberDeviceMatches = selectTop(
      Array.from(
        document.querySelectorAll(
          'input[type="checkbox"], label, button, [role="button"], a'
        )
      ),
      ['remember this device', 'remember device', 'trust this device', 'trusted device', 'keep me signed in'],
      {
        requireVisible: true,
        minScore: 10,
      }
    );

    return {
      title,
      url,
      hasPasswordInput,
      hasOtpInput,
      hasLoginIdentifierInput,
      hasLogoutControl,
      hasCloudflareChallenge,
      hasSessionExpiredPhrase,
      headings,
      navLinks,
      formActionLabels,
      pageLabelHints,
      queries: {
        initial: {
          username: topOrNotFound(usernameMatches, 'type_and_press_enter'),
          password: topOrNotFound(passwordMatches, 'type_and_press_enter'),
          continueButton: topOrNotFound(continueMatches, 'click'),
        },
        twoFactor: {
          selection: collectTwoFactorSelectionOptions(),
          confirmationCodeInput: topOrNotFound(
            confirmationCodeMatches,
            'type_code'
          ),
          rememberDevice: topOrNotFound(
            rememberDeviceMatches,
            'click_if_present'
          ),
        },
      },
    };
  });
}

module.exports = {
  BLOCKED_CODES,
  inspectAuthDocumentFromHtml,
  inspectAuthDocument,
  detectAuthState,
};
