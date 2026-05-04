function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function clampInt(value, fallback, minimum = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.max(minimum, Math.trunc(parsed));
}

function normalizeSource(value) {
  const source = String(value || '').trim().toLowerCase();
  if (source === 'iframe_center' || source === 'container_center') {
    return source;
  }
  return 'unknown';
}

async function probeChallengeSurface(page) {
  return page.evaluate(() => {
    const normalizedBody = String(document.body?.innerText || '')
      .replace(/\s+/g, ' ')
      .trim()
      .toLowerCase();
    const normalizedTitle = String(document.title || '').trim().toLowerCase();

    const hasKeywordSignal =
      normalizedTitle.includes('just a moment') ||
      normalizedBody.includes('performing security verification') ||
      normalizedBody.includes('verify you are human') ||
      normalizedBody.includes('security service to protect against malicious bots') ||
      normalizedBody.includes('checking your browser before accessing');

    function toRect(el) {
      if (!el) {
        return null;
      }
      const box = el.getBoundingClientRect();
      if (!box) {
        return null;
      }
      return {
        x: box.x,
        y: box.y,
        left: box.left,
        top: box.top,
        width: box.width,
        height: box.height,
        right: box.right,
        bottom: box.bottom,
      };
    }

    function isVisible(el) {
      if (!el) {
        return false;
      }
      const style = window.getComputedStyle(el);
      if (!style) {
        return false;
      }
      if (style.display === 'none') {
        return false;
      }
      if (style.visibility === 'hidden' || style.visibility === 'collapse') {
        return false;
      }
      const opacity = Number.parseFloat(style.opacity || '1');
      if (Number.isFinite(opacity) && opacity <= 0) {
        return false;
      }
      const rect = el.getBoundingClientRect();
      return rect.width > 1 && rect.height > 1;
    }

    function frameSignal(frame) {
      const id = String(frame.getAttribute('id') || '').toLowerCase();
      const src = String(frame.getAttribute('src') || '').toLowerCase();
      const title = String(frame.getAttribute('title') || '').toLowerCase();
      const corpus = `${id} ${src} ${title}`;
      return {
        id,
        src,
        title,
        corpus,
      };
    }

    const container = document.querySelector('#HWYfR3');
    const spinner = document.querySelector('#EWla3');
    const successWrap = document.querySelector('#jQUQ8');
    const successText = document.querySelector('#challenge-success-text');
    const tokenInput = document.querySelector('input[name="cf-turnstile-response"]');

    const tokenValue = String(tokenInput?.value || '');
    const tokenLength = tokenValue.trim().length;
    const hasToken = tokenLength > 0;

    const allFrames = Array.from(document.querySelectorAll('iframe')).map(frame => {
      const signal = frameSignal(frame);
      const rect = toRect(frame);
      const visible = isVisible(frame);
      return {
        ...signal,
        visible,
        rect,
      };
    });

    const turnstileFrames = allFrames.filter(frame => {
      return (
        frame.corpus.includes('challenges.cloudflare.com') ||
        frame.corpus.includes('/cdn-cgi/challenge-platform/') ||
        frame.corpus.includes('turnstile') ||
        frame.corpus.includes('cloudflare')
      );
    });

    const interactiveFrame = turnstileFrames.find(frame => {
      return frame.visible && frame.rect && frame.rect.width > 1 && frame.rect.height > 1;
    }) || null;

    const containerRect = toRect(container);
    const containerVisible = isVisible(container);
    const spinnerVisible = isVisible(spinner);
    const successVisible = isVisible(successWrap) || isVisible(successText);

    let target = null;
    if (interactiveFrame?.rect) {
      target = {
        source: 'iframe_center',
        x: interactiveFrame.rect.left + interactiveFrame.rect.width / 2,
        y: interactiveFrame.rect.top + interactiveFrame.rect.height / 2,
        width: interactiveFrame.rect.width,
        height: interactiveFrame.rect.height,
      };
    } else if (containerVisible && containerRect) {
      target = {
        source: 'container_center',
        x: containerRect.left + containerRect.width / 2,
        y: containerRect.top + containerRect.height / 2,
        width: containerRect.width,
        height: containerRect.height,
      };
    }

    const hasChallengeSurface =
      hasKeywordSignal ||
      Boolean(container) ||
      turnstileFrames.length > 0 ||
      document.location.pathname.includes('/cdn-cgi/');

    const pending =
      !hasToken &&
      !successVisible &&
      (spinnerVisible || (hasChallengeSurface && !interactiveFrame));

    const solved = hasToken || successVisible;

    return {
      title: String(document.title || ''),
      url: String(document.location?.href || ''),
      hasChallengeSurface,
      pending,
      solved,
      hasToken,
      tokenLength,
      spinnerVisible,
      successVisible,
      hasContainer: Boolean(container),
      containerVisible,
      turnstileFrameCount: turnstileFrames.length,
      hasInteractiveFrame: Boolean(interactiveFrame),
      target,
    };
  });
}

async function clickPointerTarget(page, target) {
  const x = Number(target?.x);
  const y = Number(target?.y);

  if (!Number.isFinite(x) || !Number.isFinite(y)) {
    return {
      ok: false,
      errorCode: 'invalid_target',
    };
  }

  if (!page || !page.mouse || typeof page.mouse.click !== 'function') {
    return {
      ok: false,
      errorCode: 'mouse_api_unavailable',
    };
  }

  try {
    if (typeof page.bringToFront === 'function') {
      await page.bringToFront();
    }
  } catch (error) {
    // Best effort only.
  }

  await page.mouse.click(x, y);
  return {
    ok: true,
  };
}

function createChallengeStateMachine(options = {}) {
  const now = typeof options.now === 'function' ? options.now : () => Date.now();
  const sleepFn = typeof options.sleep === 'function' ? options.sleep : sleep;
  const probeSurface =
    typeof options.probeSurface === 'function' ? options.probeSurface : probeChallengeSurface;
  const clickTarget =
    typeof options.clickTarget === 'function' ? options.clickTarget : clickPointerTarget;

  const defaultPollIntervalMs = clampInt(options.pollIntervalMs, 200, 25);
  const defaultMaxWaitMs = clampInt(options.maxWaitMs, 8000, 0);
  const defaultPostClickWaitMs = clampInt(options.postClickWaitMs, 400, 0);
  const defaultClickCooldownMs = clampInt(options.clickCooldownMs, 1000, 0);
  const defaultMaxClicks = clampInt(options.maxClicks, 2, 1);

  async function run(input = {}) {
    const page = input.page;
    if (!page) {
      return {
        machine: 'cloudflare_turnstile_v1',
        status: 'failed',
        reason: 'missing_page',
        durationMs: 0,
        clickAttempts: [],
      };
    }

    const startedAtMs = now();
    const maxWaitMs = clampInt(input.maxWaitMs, defaultMaxWaitMs, 0);
    const pollIntervalMs = clampInt(input.pollIntervalMs, defaultPollIntervalMs, 25);
    const postClickWaitMs = clampInt(input.postClickWaitMs, defaultPostClickWaitMs, 0);
    const clickCooldownMs = clampInt(input.clickCooldownMs, defaultClickCooldownMs, 0);
    const maxClicks = clampInt(input.maxClicks, defaultMaxClicks, 1);

    const clickAttempts = [];
    let pendingObserved = false;
    let interactiveObserved = false;
    let firstInteractiveAtMs = 0;
    let firstPendingAtMs = 0;
    let lastClickAtMs = Number.NEGATIVE_INFINITY;
    let finalSnapshot = null;

    while (true) {
      const currentMs = now();
      const elapsedMs = Math.max(0, currentMs - startedAtMs);
      const timedOut = elapsedMs >= maxWaitMs;

      let snapshot;
      try {
        snapshot = await probeSurface(page);
      } catch (error) {
        return {
          machine: 'cloudflare_turnstile_v1',
          status: 'failed',
          reason: 'probe_failed',
          error: String(error?.message || error),
          durationMs: elapsedMs,
          clickAttempts,
          finalSnapshot,
        };
      }

      finalSnapshot = snapshot && typeof snapshot === 'object' ? snapshot : null;

      if (!finalSnapshot || finalSnapshot.hasChallengeSurface !== true) {
        return {
          machine: 'cloudflare_turnstile_v1',
          status: 'not_challenge',
          reason: 'challenge_surface_missing',
          durationMs: elapsedMs,
          pendingObserved,
          interactiveObserved,
          clickAttempts,
          finalSnapshot,
        };
      }

      if (finalSnapshot.pending) {
        pendingObserved = true;
        if (!firstPendingAtMs) {
          firstPendingAtMs = elapsedMs;
        }
      }

      if (finalSnapshot.hasInteractiveFrame || finalSnapshot.target) {
        interactiveObserved = true;
        if (!firstInteractiveAtMs) {
          firstInteractiveAtMs = elapsedMs;
        }
      }

      if (finalSnapshot.solved) {
        return {
          machine: 'cloudflare_turnstile_v1',
          status: 'solved',
          reason: finalSnapshot.hasToken ? 'turnstile_token_present' : 'challenge_success_visible',
          durationMs: elapsedMs,
          pendingObserved,
          interactiveObserved,
          firstPendingAtMs,
          firstInteractiveAtMs,
          clickAttempts,
          finalSnapshot,
        };
      }

      const canClick =
        Boolean(finalSnapshot.target) &&
        clickAttempts.length < maxClicks &&
        elapsedMs - lastClickAtMs >= clickCooldownMs &&
        (
          finalSnapshot.hasInteractiveFrame === true ||
          finalSnapshot.pending !== true
        );

      if (canClick) {
        const target = finalSnapshot.target;
        const clickStartedAtMs = now();
        let clickResult;

        try {
          clickResult = await clickTarget(page, target);
        } catch (error) {
          clickResult = {
            ok: false,
            errorCode: 'click_exception',
            error: String(error?.message || error),
          };
        }

        clickAttempts.push({
          atMs: Math.max(0, clickStartedAtMs - startedAtMs),
          source: normalizeSource(target.source),
          x: Number.isFinite(Number(target.x)) ? Number(target.x) : null,
          y: Number.isFinite(Number(target.y)) ? Number(target.y) : null,
          ok: clickResult?.ok === true,
          errorCode: clickResult?.ok === true ? '' : String(clickResult?.errorCode || 'click_failed'),
        });

        lastClickAtMs = elapsedMs;

        if (timedOut) {
          return {
            machine: 'cloudflare_turnstile_v1',
            status: 'timeout',
            reason: 'timeout_after_click',
            durationMs: elapsedMs,
            pendingObserved,
            interactiveObserved,
            firstPendingAtMs,
            firstInteractiveAtMs,
            clickAttempts,
            finalSnapshot,
          };
        }

        if (postClickWaitMs > 0) {
          await sleepFn(postClickWaitMs);
        }

        continue;
      }

      if (timedOut) {
        return {
          machine: 'cloudflare_turnstile_v1',
          status: 'timeout',
          reason: interactiveObserved ? 'interactive_not_resolved' : 'challenge_still_pending',
          durationMs: elapsedMs,
          pendingObserved,
          interactiveObserved,
          firstPendingAtMs,
          firstInteractiveAtMs,
          clickAttempts,
          finalSnapshot,
        };
      }

      await sleepFn(pollIntervalMs);
    }
  }

  return {
    run,
  };
}

module.exports = {
  createChallengeStateMachine,
  probeChallengeSurface,
  clickPointerTarget,
};
