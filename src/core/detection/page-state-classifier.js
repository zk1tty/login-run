function normalizeText(value, limit = 30000) {
  return String(value || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, limit);
}

function toCorpus(parts = []) {
  return parts
    .map(part => normalizeText(part, 20000).toLowerCase())
    .filter(Boolean)
    .join(' ');
}

function inferTurnstilePageType(input = {}) {
  const explicit = String(input.turnstilePageType || '').trim().toLowerCase();
  if (explicit === 'waiting' || explicit === 'checkbox' || explicit === 'unknown') {
    return explicit;
  }

  const hasCheckbox = input.hasTurnstileCheckbox === true;
  const corpus = toCorpus([input.title, input.url, input.text]);

  if (
    hasCheckbox ||
    corpus.includes('verify you are human') ||
    corpus.includes('click to verify') ||
    corpus.includes('verify that you are human')
  ) {
    return 'checkbox';
  }

  if (
    corpus.includes('just a moment') ||
    corpus.includes('checking your browser') ||
    corpus.includes('performing security verification') ||
    corpus.includes('security service to protect')
  ) {
    return 'waiting';
  }

  return 'unknown';
}

function classifyPageState(input = {}) {
  const title = normalizeText(input.title, 300);
  const url = normalizeText(input.url, 2000);
  const text = normalizeText(input.text, 30000);
  const corpus = toCorpus([title, url, text]);

  const hasPasswordInput = input.hasPasswordInput === true;
  const hasLoginIdentifierInput = input.hasLoginIdentifierInput === true;
  const hasOtpInput = input.hasOtpInput === true;
  const hasLogoutControl = input.hasLogoutControl === true;
  const hasSessionExpiredPhrase = input.hasSessionExpiredPhrase === true;

  const hasChallengeKeyword =
    corpus.includes('just a moment') ||
    corpus.includes('checking your browser') ||
    corpus.includes('performing security verification') ||
    corpus.includes('verify you are human') ||
    corpus.includes('cf-challenge') ||
    corpus.includes('cloudflare') ||
    corpus.includes('/cdn-cgi/');

  const hasTurnstile = input.hasTurnstile === true || hasChallengeKeyword;
  const turnstilePageType = hasTurnstile ? inferTurnstilePageType(input) : '';

  if (hasTurnstile) {
    const reason =
      turnstilePageType === 'checkbox'
        ? 'Turnstile challenge detected: checkbox.'
        : (turnstilePageType === 'waiting'
          ? 'Turnstile challenge detected: waiting.'
          : 'Turnstile challenge detected.');

    return {
      state: 'challenge',
      reason,
      hasTurnstile: true,
      hasTurnstileCheckbox: turnstilePageType === 'checkbox',
      turnstilePageType,
      title,
      url,
    };
  }

  if (
    hasOtpInput ||
    corpus.includes('verification code') ||
    corpus.includes('one-time code') ||
    corpus.includes('one time code') ||
    corpus.includes('otp')
  ) {
    return {
      state: 'need_otp',
      reason: 'OTP verification step detected.',
      hasTurnstile: false,
      hasTurnstileCheckbox: false,
      turnstilePageType: '',
      title,
      url,
    };
  }

  const reauthSignal =
    hasSessionExpiredPhrase ||
    corpus.includes('session expired') ||
    corpus.includes('sign in again') ||
    corpus.includes('log in again') ||
    corpus.includes('reauthenticate');
  if (reauthSignal) {
    return {
      state: 'reauth',
      reason: 'Re-authentication prompt detected.',
      hasTurnstile: false,
      hasTurnstileCheckbox: false,
      turnstilePageType: '',
      title,
      url,
    };
  }

  const authedSignal =
    hasLogoutControl ||
    /\/member\//i.test(url) ||
    corpus.includes('transaction history') ||
    corpus.includes('account overview') ||
    corpus.includes('dashboard');
  if (authedSignal && !hasPasswordInput) {
    return {
      state: 'authed',
      reason: 'Authenticated account markers detected.',
      hasTurnstile: false,
      hasTurnstileCheckbox: false,
      turnstilePageType: '',
      title,
      url,
    };
  }

  const loginPath = /(clientlogin|login|sign-in|signin|auth|saml)/i.test(url);
  const loginTitle = /\b(sign in|log in|login)\b/i.test(title);
  const loginSignal =
    hasPasswordInput ||
    hasLoginIdentifierInput ||
    loginPath ||
    loginTitle ||
    corpus.includes('sign in') ||
    corpus.includes('log in');
  if (loginSignal) {
    return {
      state: 'need_cred',
      reason: 'Login form markers detected.',
      hasTurnstile: false,
      hasTurnstileCheckbox: false,
      turnstilePageType: '',
      title,
      url,
    };
  }

  return {
    state: 'unknown',
    reason: 'No known auth/challenge markers detected on current page.',
    hasTurnstile: false,
    hasTurnstileCheckbox: false,
    turnstilePageType: '',
    title,
    url,
  };
}

module.exports = {
  classifyPageState,
};
