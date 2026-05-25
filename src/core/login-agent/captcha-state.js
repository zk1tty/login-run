function createCaptchaState() {
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

function markFirstSeen(state, event) {
  if (!state.firstSeenAt) {
    state.firstSeenAt = event.at;
    state.firstSeenOffsetMs = event.offsetMs;
  }
}

function markResolved(state, event, source, evidence) {
  if (!state.resolvedAt) {
    state.resolvedAt = event.at;
    state.resolvedOffsetMs = event.offsetMs;
    state.resolutionSource = source;
    state.resolutionEvidence = evidence;
  }
}

function applyBrowserlessCaptchaFound(state, params = {}, event) {
  state.browserless.found = true;
  state.browserless.foundAt = state.browserless.foundAt || event.at;
  state.browserless.foundOffsetMs ??= event.offsetMs;
  state.browserless.type = String(params.type || state.browserless.type || '').trim();
  state.browserless.status = String(params.status || state.browserless.status || '').trim();
  markFirstSeen(state, event);
}

function applyBrowserlessCaptchaAutoSolved(state, params = {}, event) {
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

function applyBrowserlessCaptchaManualSolve(state, params = {}, event) {
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

function domResolutionEvidence(snapshot = {}) {
  if (snapshot.hasSecurityCheckPassedText === true) {
    return 'DOM contains security check passed text.';
  }
  if (Number(snapshot.tokenLength || 0) > 0) {
    return 'Challenge token is present in DOM.';
  }
  return '';
}

function applyDomChallengeObservation(state, snapshot = {}, event) {
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

module.exports = {
  createCaptchaState,
  applyBrowserlessCaptchaFound,
  applyBrowserlessCaptchaAutoSolved,
  applyBrowserlessCaptchaManualSolve,
  applyDomChallengeObservation,
};
