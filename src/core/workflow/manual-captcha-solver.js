function toInt(value, fallback, minimum = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }
  return Math.max(minimum, Math.trunc(parsed));
}

function toSafeError(error) {
  return String(error?.message || error || 'unknown_error');
}

function sanitizeSolveResult(result) {
  if (!result || typeof result !== 'object') {
    return result || null;
  }
  const sanitized = {
    ...result,
  };
  if (typeof sanitized.token === 'string') {
    sanitized.hasToken = sanitized.token.length > 0;
    sanitized.tokenLength = sanitized.token.length;
    sanitized.token = '[redacted]';
  }
  return sanitized;
}

async function sendSolveCaptcha(cdp, timeoutMs) {
  let timer = null;
  try {
    return await Promise.race([
      cdp.send('Browserless.solveCaptcha'),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`solve_captcha_timeout_${timeoutMs}ms`)),
          timeoutMs
        );
      }),
    ]);
  } finally {
    if (timer) {
      clearTimeout(timer);
    }
  }
}

class ManualCaptchaSolver {
  constructor(input = {}) {
    this.cdp = input.cdp;
    this.recordEvent = typeof input.recordEvent === 'function' ? input.recordEvent : () => {};
    this.timeoutMs = toInt(
      input.timeoutMs || process.env.CAPTCHA_SOLVE_COMMAND_TIMEOUT_MS,
      90000,
      1000
    );
    this.inFlight = null;
    this.attempts = 0;
    this.lastResult = null;
    this.lastError = '';
    this.lastDurationMs = 0;
    this.lastReason = '';
  }

  async solve(reason = 'unknown') {
    if (!this.cdp) {
      throw new Error('ManualCaptchaSolver requires a CDP session.');
    }
    if (this.inFlight) {
      return this.inFlight;
    }
    this.inFlight = this.#solveInternal(reason);
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  async #solveInternal(reason) {
    this.attempts += 1;
    this.lastReason = String(reason || 'unknown');
    const startedAtMs = Date.now();
    this.recordEvent('captcha_manual_solve_start', {
      reason: this.lastReason,
      timeoutMs: this.timeoutMs,
      attempts: this.attempts,
    });

    try {
      const rawResult = await sendSolveCaptcha(this.cdp, this.timeoutMs);
      this.lastResult = sanitizeSolveResult(rawResult);
      this.lastDurationMs = Math.max(0, Date.now() - startedAtMs);
      this.lastError = '';
      this.recordEvent('captcha_manual_solve_done', {
        reason: this.lastReason,
        durationMs: this.lastDurationMs,
        result: this.lastResult,
      });
      return this.lastResult;
    } catch (error) {
      this.lastResult = null;
      this.lastDurationMs = Math.max(0, Date.now() - startedAtMs);
      this.lastError = toSafeError(error);
      this.recordEvent('captcha_manual_solve_failed', {
        reason: this.lastReason,
        durationMs: this.lastDurationMs,
        error: this.lastError,
      });
      return null;
    }
  }

  toSummary() {
    return {
      attempts: this.attempts,
      lastReason: this.lastReason,
      lastDurationMs: this.lastDurationMs,
      lastError: this.lastError,
      lastResult: this.lastResult,
    };
  }
}

module.exports = {
  ManualCaptchaSolver,
  sanitizeSolveResult,
  sendSolveCaptcha,
};
