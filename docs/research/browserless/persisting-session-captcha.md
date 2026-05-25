# Persisting Session CAPTCHA Research

Date: 2026-05-18

## Question

Can we use Browserless Persisting State Session API from the beginning of the
login flow, keep stealth/proxy behavior, solve CAPTCHA, and later reconnect for
daily post-auth data retrieval without repeating OTP?

This matters because the current direct CDP CAPTCHA mode can solve CAPTCHA with
`solveCaptchas=true`, but it does not create a reusable `session.connect`
checkpoint.

## Test Target

Turnstile challenge page:

```text
https://browser-compat.turnstile.workers.dev/
```

The original study runner was removed during the Puppeteer-only API cleanup.
This document is retained as research evidence, not as a current runbook.

## Key Findings

### 1. Auto CAPTCHA mode is rejected on `session.connect`

We tested appending `solveCaptchas=true` to a persisted Session API
`session.connect` URL.

Browserless rejected it:

```text
400 Bad Request
Query-parameter validation failed: "solveCaptchas" is not allowed
```

Conclusion:

```text
/stealth?...&solveCaptchas=true works for direct CDP CAPTCHA mode.
/session/connect/...?...&solveCaptchas=true does not work.
```

### 2. Manual CAPTCHA solving works on Persisting State sessions

We created a persisted Browserless session with:

```json
{
  "ttl": 180000,
  "stealth": true,
  "proxy": {
    "type": "residential",
    "country": "us"
  }
}
```

Then we connected to `session.connect` without `solveCaptchas=true`, attached a
page CDP session, and called:

```text
Browserless.solveCaptcha
```

Successful run:

```text
.log/danny/captcha-session-persisting/captcha-session-persisting-20260518-121453-814/summary.json
```

Result:

```json
{
  "manualSolveAttempted": true,
  "manualSolveSucceeded": true,
  "manualSolveError": "",
  "captchaFoundStatus": "found",
  "firstConnectionResolved": true,
  "reconnectSucceeded": true
}
```

The page reached resolved state:

```json
{
  "hasSecurityCheckPassedText": true,
  "challengeVisible": false
}
```

### 3. Reconnect can trigger CAPTCHA again

In the replay-enabled run, the first connection solved Turnstile successfully,
but the reconnect visit saw a fresh CAPTCHA:

```text
.log/danny/captcha-session-persisting/captcha-session-persisting-20260518-122813-625/summary.json
```

Reconnect result:

```json
{
  "captchaFoundSeen": true,
  "captchaFoundStatus": "found",
  "resolved": false,
  "finalSnapshot": {
    "hasVerifyingText": true,
    "hasSecurityCheckPassedText": false,
    "challengeVisible": true
  }
}
```

Event evidence:

```text
reconnect_Browserless.captchaFound -> { "type": "cloudflare", "status": "found" }
```

Screenshot:

```text
.log/danny/captcha-session-persisting/captcha-session-persisting-20260518-122813-625/reconnect.png
```

This screenshot showed an unchecked challenge because reconnect intentionally
used `solveMode: none`.

Conclusion:

```text
Persisted browser state does not guarantee the next visit avoids CAPTCHA.
Daily reconnect workflows must still include CAPTCHA detection and manual solve.
```

## Replay And Screenshot Evidence

Historical replay-enabled run:

```bash
BL_PROXY=cloud_stealth_residential \
CAPTCHA_SESSION_SOLVE_MODE=manual \
CAPTCHA_SESSION_REPLAY=true \
CAPTCHA_WAIT_MS=45000 \
CAPTCHA_POST_SOLVE_VERIFY_MS=15000 \
CAPTCHA_SCREENSHOT_INTERVAL_MS=2000 \
CAPTCHA_RECONNECT_SCREENSHOT_DELAY_MS=10000 \
<removed historical study runner>
```

Artifacts:

```text
.log/danny/captcha-session-persisting/captcha-session-persisting-20260518-122813-625/
```

Important local screenshots:

```text
first-screenshots/resolved.png
first-connection.png
reconnect-screenshots/0001-sample-4737ms.png
reconnect.png
```

Replay was accepted and stopped cleanly:

```text
first_replay_stop -> ok: true
reconnect_replay_stop -> ok: true
```

For automated verification, local screenshots plus DOM snapshots are more
direct than Session Replay. Session Replay is useful for human review in the
Browserless dashboard.

## Architecture Implication

The next login architecture should be:

```text
1. Create Browserless Persisting State session before login.
2. Connect to session.connect with Playwright CDP.
3. Use stealth + residential proxy in the Session API payload.
4. Run deterministic login steps.
5. If Browserless.captchaFound or DOM challenge appears:
     call Browserless.solveCaptcha manually.
6. Complete OTP once.
7. Close the browser, but do not stop the session.
8. For daily retrieval:
     reconnect to session.connect
     navigate to the account page
     run CAPTCHA detection/manual solve if challenged
     classify authed
     export data
```

This does not prove the HSA site will keep auth cookies valid for a full day.
That must be tested separately after a real post-auth persisted-session login.

## Current Recommendation

Use Persisting State Session API as the primary POC path for daily retrieval.

Do not rely on:

- direct CDP `solveCaptchas=true` for persistence
- BrowserQL reconnect watchdog for daily persistence
- Standard Sessions for long-term reuse

Keep current same-process direct-CDP login as the working control path while the
persisted-session login path is added and measured.

## HealthEquity Smoke Comparison (Direct vs Persistent)

Date: 2026-05-18

Historical command baseline (default mode):

```bash
<removed historical login study runner>
```

Historical persisted-session mode:

```bash
LOGIN_CONNECTION_MODE=persistent_session <removed historical login study runner>
```

Summary artifacts:

```text
direct_auto:
.log/danny/direct-login-captcha-resolver/my-healthequity-com-20260518-215017-973/summary.json

persistent_session:
.log/danny/direct-login-captcha-resolver/my-healthequity-com-20260518-220152-906/summary.json
```

Result snapshot:

```json
{
  "direct_auto": {
    "requestedConnectionMode": "direct_auto",
    "connectionMode": "direct_auto",
    "captchaSolveMode": "auto",
    "durationMs": 76481,
    "terminalOutcome": "need_otp",
    "cloudflareTriggered": false,
    "cloudflareResolved": false,
    "cloudflareVisibleToResolvedMs": null,
    "captchaSeen": false,
    "captchaResolved": false,
    "browserlessFound": false,
    "browserlessSolved": false,
    "browserlessSolveFailed": false,
    "manualSolverAttempts": null
  },
  "persistent_session": {
    "requestedConnectionMode": "persistent_session",
    "connectionMode": "persistent_session",
    "captchaSolveMode": "manual",
    "durationMs": 71969,
    "terminalOutcome": "need_otp",
    "cloudflareTriggered": false,
    "cloudflareResolved": false,
    "cloudflareVisibleToResolvedMs": null,
    "captchaSeen": false,
    "captchaResolved": false,
    "browserlessFound": false,
    "browserlessSolved": false,
    "browserlessSolveFailed": false,
    "manualSolverAttempts": 0
  }
}
```

Interpretation:

- Both runs completed to the same OTP pause state (`need_otp`).
- No CAPTCHA challenge occurred in either run, so this pair does not provide a
  solve-latency comparison.
- Mode wiring is verified:
  - default mode -> `direct_auto` + `captchaSolveMode=auto`
  - persisted mode -> `persistent_session` + `captchaSolveMode=manual`

## Auth Persistence Test Design

Goal:

```text
Test whether HealthEquity skips OTP when we reconnect with the same
persistent-session browser state for the same user.
```

### Test Phases

Phase A: bootstrap auth session

- Create one Browserless persisted session per user.
- Run full login and complete OTP once.
- Confirm the page reaches `authed`.
- Save:
  - `session.connect`
  - `session.stop`
  - `session.id`
  - bootstrap summary path
  - authenticated target URL

Phase B: reconnect probe

- Reconnect to the same `session.connect`.
- Navigate directly to a known post-auth page.
- Classify the terminal state:
  - `authed`
  - `otp_delivery_selection`
  - `otp_code`
  - `identifier`
  - `blocked_or_unknown`

Phase C: interval matrix

- Repeat Phase B after fixed delays:
  - 5 minutes
  - 15 minutes
  - 30 minutes
  - 1 hour
  - 6 hours
  - 12 hours
  - 24 hours

### Three Control Groups

These controls should be mapped onto Phases A to C as follows:

#### Control 1: persisted-session test group

Purpose:

```text
Measure whether the same Browserless persisted session skips OTP on reconnect.
```

Mapping:

- Phase A: bootstrap login + OTP in `persistent_session`
- Phase B: reconnect to the same `session.connect`
- Phase C: repeat reconnect probes across the delay matrix

#### Control 2: fresh-session login control

Purpose:

```text
Measure the normal OTP requirement for the same user without persisted browser state.
```

Mapping:

- No shared Phase A artifact
- For each Phase C delay bucket, create a brand-new session and log in again
- Compare whether OTP appears relative to Control 1 at the same probe time

Interpretation:

```text
If Control 1 skips OTP and Control 2 requires OTP, the persisted browser state
is providing real value.
```

#### Control 3: same-session active-vs-passive reconnect control

Purpose:

```text
Separate simple cookie/profile persistence from a still-live browser process.
```

Mapping:

- Phase A: bootstrap login + OTP in `persistent_session`
- Phase B:
  - passive branch: disconnect and let the browser process die, then reconnect
  - active branch: reconnect within `processKeepAlive` while the process is still alive
- Phase C: repeat both branches where possible inside the same short-window test

Important limitation:

```text
Browserless supports `processKeepAlive`, but the official docs state this
feature is Puppeteer-only because it requires `browser.disconnect()`. Playwright
does not expose `disconnect()`, so this control is not available in the current
Playwright runner.
```

For the current Playwright-based architecture, Controls 1 and 2 are the main
decision-making controls. Control 3 should be added if we build a Puppeteer
probe runner, because it is the highest-probability path for preserving the
full live browser state and reducing re-auth friction.

## Browserless Session Lifetime Constraints

According to the Browserless Persisting State docs:

- Persisted browser data survives for the session `ttl`.
- After all connections close, the browser process normally terminates.
- On reconnect, Browserless starts a new browser process and restores cookies,
  localStorage, and cache from disk.
- `processKeepAlive` keeps the browser process alive only for a short grace
  window after disconnect.
- `processKeepAlive` is Puppeteer-only because it requires `browser.disconnect()`;
  Playwright does not support that feature.
- Session data lifetime depends on plan maximum:
  - Free: 1 day
  - Prototyping: 7 days
  - Starter: 30 days
  - Scale: 90 days

Official source:

- https://docs.browserless.io/baas/session-management/persisting-state

### Updated Caveat

The key caveat is not just "can the HSA site keep cookies valid for a day."
There are two separate constraints:

1. Browserless session persistence window

```text
The session `ttl` must remain alive long enough to test the target interval.
`ttl` is absolute from session creation time and does not reset on reconnect or
daily usage.
```

2. Site-side trust persistence

```text
Even if Browserless still has the profile data, HealthEquity may still force OTP
again on reconnect.
```

For the current Playwright runner, daily reuse means:

- set a long enough `ttl`
- reconnect to the same `session.connect`
- expect a fresh browser process on reconnect
- rely on persisted cookies/localStorage, not on live tabs or in-memory state

For a future Puppeteer runner, daily reuse could additionally test:

- `processKeepAlive` to preserve the live browser process between disconnects
- whether reconnecting inside that live-process grace window reduces OTP or
  other re-auth challenges more effectively than disk-restored state alone

### TTL vs processKeepAlive

These two timers do different jobs:

- `ttl`

```text
Absolute session lifetime. When it expires, Browserless permanently deletes the
session and all persisted data. This timer does not reset on reconnect.
```

- `processKeepAlive`

```text
Grace period after the last disconnect during which the live browser process
stays alive. If you reconnect before it expires, you get back open tabs,
history, scroll position, and in-memory page state.
```

Important implication:

```text
You cannot keep a session alive indefinitely by reconnecting daily if the
session `ttl` is only 7 days. Daily usage may restart the `processKeepAlive`
window after each disconnect, but it does not extend the underlying `ttl`.
```

For the Prototyping plan:

- maximum `ttl` is 7 days
- `processKeepAlive` must be less than or equal to `ttl`
- after day 7 from session creation, the session is deleted even if it was used
  in between

### What Is Reused

| Resource / State | Same `session.connect` without `processKeepAlive` | Same `session.connect` with `processKeepAlive` |
| --- | --- | --- |
| Browserless session record | Reused until `ttl` expires | Reused until `ttl` expires |
| `session.connect` URL | Same URL | Same URL |
| Cookies | Reused from persisted disk state | Reused, still live in browser process |
| localStorage | Reused from persisted disk state | Reused, still live in browser process |
| Cache | Reused from persisted disk state | Reused, still live in browser process |
| Browser profile data | Restored from disk | Same live profile remains loaded |
| Browser process | New browser process on reconnect | Same browser process if reconnect is inside `processKeepAlive` |
| Open tabs | Usually not preserved | Preserved |
| Current page URL | Not reliably preserved unless restored from browser/session state | Preserved |
| JS runtime memory | Not preserved | Preserved |
| In-memory app state | Not preserved | Preserved |
| Navigation history | Not reliably preserved | Preserved |
| WebSocket connections | Not preserved | Possibly preserved if still connected, but may be stale |
| Pending timers/async work | Not preserved | Possibly preserved |
| Browser fingerprint continuity | Partial: same persisted profile, new process | Stronger: same live process |
| Site perception | Returning browser profile | Same browser session resumed |
| OTP skip chance | Medium | Highest |
| CAPTCHA skip chance | Medium, still may be challenged | Higher, but still not guaranteed |
| Requires Puppeteer `browser.disconnect()` | No | Yes |
| Works with current Playwright runner | Yes | No |
| Main timer | `ttl` | `ttl` plus `processKeepAlive` |
| Timer behavior | `ttl` is absolute and does not reset | `ttl` is absolute; `processKeepAlive` grace window applies after disconnect |
| Example | Reconnect after 1 day; Browserless restores cookies/localStorage into a new browser process | Disconnect, reconnect within 30 minutes, attach to same browser process |
| Failure mode | HealthEquity may force OTP because it sees a new browser process using restored state | HealthEquity may still force OTP, but this is the best-case reuse path |

## Updated First Experiment

The first experiment should be narrowed to what the current runner can prove:

1. Bootstrap one user with `LOGIN_CONNECTION_MODE=persistent_session`.
2. Complete OTP once and reach `authed`.
3. Reconnect to the same `session.connect` after:
   - 5 minutes
   - 30 minutes
   - 2 hours
   - 24 hours
4. At each reconnect probe:
   - navigate to a known post-auth page
   - record whether the classifier reaches `authed` or OTP
   - record whether CAPTCHA appears
5. For each same delay bucket, run one fresh-session control login for the same
   user.

Success criterion:

```text
Persistent-session reconnect reaches `authed` without OTP, while fresh-session
control still requires OTP.
```

Failure criterion:

```text
Persistent-session reconnect still reaches `otp_delivery_selection` or `otp_code`
at the same rate as fresh-session control.
```

If that experiment looks promising, the next experiment should be:

1. Build a small Puppeteer probe runner.
2. Set a long `ttl` and a shorter `processKeepAlive`.
3. Compare:
   - reconnect inside `processKeepAlive`
   - reconnect after `processKeepAlive` but before `ttl`
4. Measure whether the live-process reconnect path skips OTP more often than the
   disk-restored reconnect path.
