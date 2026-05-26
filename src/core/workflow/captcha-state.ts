type TimestampMs = number | null;

type CaptchaResolutionEvent = {
  at: string;
  offsetMs: number;
};

type CaptchaSolverEvent = {
  at: string;
  offsetMs: number;
  [key: string]: unknown;
};

type BrowserlessCaptchaState = {
  found: boolean;
  foundAt: string;
  foundOffsetMs: TimestampMs;
  type: string;
  status: string;
  solved: boolean;
  solvedAt: string;
  solvedOffsetMs: TimestampMs;
  solveFailed: boolean;
  error: string;
};

type DomChallengeState = {
  challengeSeen: boolean;
  challengeSeenAt: string;
  challengeSeenOffsetMs: TimestampMs;
  challengeResolved: boolean;
  challengeResolvedAt: string;
  challengeResolvedOffsetMs: TimestampMs;
  resolutionEvidence: string;
  lastChallengeVisible: boolean | null;
};

type CaptchaState = {
  firstSeenAt: string;
  firstSeenOffsetMs: TimestampMs;
  resolvedAt: string;
  resolvedOffsetMs: TimestampMs;
  resolutionSource: string;
  resolutionEvidence: string;
  browserless: BrowserlessCaptchaState;
  dom: DomChallengeState;
};

type BrowserlessPayload = {
  type?: string;
  status?: string;
  solved?: boolean;
  found?: boolean;
  success?: boolean;
  error?: string;
};

function createCaptchaState(): CaptchaState {
  return {
    firstSeenAt: '',
    firstSeenOffsetMs: null,
    resolvedAt: '',
    resolvedOffsetMs: null,
    resolutionSource: '',
    resolutionEvidence: '',
    browserless: {
      found: false,
      foundAt: '',
      foundOffsetMs: null,
      type: '',
      status: '',
      solved: false,
      solvedAt: '',
      solvedOffsetMs: null,
      solveFailed: false,
      error: '',
    },
    dom: {
      challengeSeen: false,
      challengeSeenAt: '',
      challengeSeenOffsetMs: null,
      challengeResolved: false,
      challengeResolvedAt: '',
      challengeResolvedOffsetMs: null,
      resolutionEvidence: '',
      lastChallengeVisible: null,
    },
  };
}

function markFirstSeen(state: CaptchaState, event: CaptchaResolutionEvent): void {
  if (!state.firstSeenAt) {
    state.firstSeenAt = event.at;
    state.firstSeenOffsetMs = event.offsetMs;
  }
}

function markResolved(state: CaptchaState, event: CaptchaResolverEvent, source: string, evidence: string): void {
  if (!state.resolvedAt) {
    state.resolvedAt = event.at;
    state.resolvedOffsetMs = event.offsetMs;
    state.resolutionSource = source;
    state.resolutionEvidence = evidence;
  }
}

function applyBrowserlessCaptchaFound(
  state: CaptchaState,
  params: BrowserlessPayload = {},
  event: CaptchaResolutionEvent,
): void {
  state.browserless.found = true;
  state.browserless.foundAt = state.browserless.foundAt || event.at;
  state.browserless.foundOffsetMs ??= event.offsetMs;
  state.browserless.type = String(params.type || state.browserless.type || '').trim();
  state.browserless.status = String(params.status || state.browserless.status || '').trim();
  markFirstSeen(state, event);
}

function applyBrowserlessCaptchaAutoSolved(
  state: CaptchaState,
  params: BrowserlessPayload = {},
  event: CaptchaResolutionEvent,
): void {
  const solved = params.solved === true;
  const error = String(params.error || '').trim();

  if (solved && !error) {
    state.browserless.solved = true;
    state.browserless.solvedAt = state.browserless.solvedAt || event.at;
    state.browserless.solvedOffsetMs ??= event.offsetMs;
    markResolved(state, event, 'browserless', 'Browserless reported solved=true.');
    return;
  }

  state.browserless.solveFailed = true;
  state.browserless.error = error || 'Browserless reported captcha solve failure.';
}

function applyBrowserlessCaptchaManualSolve(
  state: CaptchaState,
  params: BrowserlessPayload = {},
  event: CaptchaResolutionEvent,
): void {
  const solved = params.solved === true || params.success === true;
  const error = String(params.error || '').trim();

  if (solved && !error) {
    state.browserless.solved = true;
    state.browserless.solvedAt = state.browserless.solvedAt || event.at;
    state.browserless.solvedOffsetMs ??= event.offsetMs;
    markResolved(state, event, 'browserless_manual', 'Browserless.solveCaptcha returned solved=true.');
    return;
  }

  if (error) {
    state.browserless.solveFailed = true;
    state.browserless.error = error;
  }
}

function domResolutionEvidence(snapshot: { hasSecurityCheckPassedText?: boolean; tokenLength?: unknown } = {}): string {
  if (snapshot.hasSecurityCheckPassedText === true) {
    return 'DOM contains security check passed text.';
  }
  if (Number(snapshot.tokenLength || 0) > 0) {
    return 'Challenge token is present in DOM.';
  }
  return '';
}

function applyDomChallengeObservation(
  state: CaptchaState,
  snapshot: { challengeVisible?: boolean; hasSecurityCheckPassedText?: boolean; tokenLength?: unknown } = {},
  event: CaptchaSolverEvent,
): void {
  const challengeVisible = snapshot.challengeVisible === true;
  const explicitResolutionEvidence = domResolutionEvidence(snapshot);

  if (challengeVisible) {
    state.dom.challengeSeen = true;
    state.dom.challengeSeenAt = state.dom.challengeSeenAt || event.at;
    state.dom.challengeSeenOffsetMs ??= event.offsetMs;
    state.dom.lastChallengeVisible = true;
    markFirstSeen(state, event);
    return;
  }

  if (explicitResolutionEvidence && state.firstSeenAt) {
    state.dom.challengeResolved = true;
    state.dom.challengeResolvedAt = state.dom.challengeResolvedAt || event.at;
    state.dom.challengeResolvedOffsetMs ??= event.offsetMs;
    state.dom.resolutionEvidence = explicitResolutionEvidence;
    state.dom.lastChallengeVisible = false;
    markResolved(state, event, 'dom', explicitResolutionEvidence);
    return;
  }

  if (state.dom.challengeSeen === true && state.dom.lastChallengeVisible === true) {
    state.dom.challengeResolved = true;
    state.dom.challengeResolvedAt = state.dom.challengeResolvedAt || event.at;
    state.dom.challengeResolvedOffsetMs ??= event.offsetMs;
    state.dom.resolutionEvidence = 'DOM-visible challenge disappeared after being observed.';
    state.dom.lastChallengeVisible = false;
    markResolved(state, event, 'dom', state.dom.resolutionEvidence);
    return;
  }

  state.dom.lastChallengeVisible = false;
}

type CaptchaResolverEvent = {
  at: string;
  offsetMs: number;
  [key: string]: unknown;
};

module.exports = {
  createCaptchaState,
  applyBrowserlessCaptchaFound,
  applyBrowserlessCaptchaAutoSolved,
  applyBrowserlessCaptchaManualSolve,
  applyDomChallengeObservation,
};
