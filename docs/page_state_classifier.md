# Page State Classification Modules

| File | Method | Input (Target Object) | Output | Purpose |
| --- | --- | --- | --- | --- |
| `src/core/detection/page-state-classifier.js` | `classifyPageState(input)` | Normalized signal object (`title`, `url`, `text`, `hasPasswordInput`, `hasOtpInput`, `hasTurnstile`, etc.) | `{ state, reason, turnstilePageType, ... }` | Shared rule engine for page-state labels (`challenge`, `need_cred`, `need_otp`, `authed`, `reauth`, `unknown`). |
| `src/core/owner-runtime/owner-runtime.js` | `probeState({ customerId })` | Raw DOM snapshot from live page (`document` text, iframe presence, input presence) | Probe object stored in runtime state | DOM signal collector + runtime-facing probe API. It delegates final classification to `classifyPageState`. |
| `src/core/detection/live-ws-state-classifier.js` | `recordLiveSignalFromWsText(liveSignals, { text, at, preferredTargetId })` | WebSocket text blob (Browserless live protocol messages like `pageMeta`, `tabsUpdate`) | Incremental live signal cache (`commandCounts`, timeline events) + tab-switch hints | WebSocket signal extractor; keeps ws blob parsing out of scripts. |
| `src/core/detection/live-ws-state-classifier.js` | `derivePageStateFromLiveSignals({ liveSignals, fallbackProbe })` | Extracted websocket signal object (`pageMetaEvents`, `tabsActiveEvents`) | `{ state, reason, timeline, comparedWithProbe, matchesProbe }` | Classifies page state from websocket events and compares against probe as fallback/cross-check. |
| `scripts/lib/ws-trace-runner.js` | `runWsTrace(...)` / `traceLiveSession(...)` / `probeWebSocket(...)` | Runtime API responses + ws connection stream | Trace output (`messages.json`, `screenshots.jsonl`, state summary) | Script-side WS/CDP trace engine shared by both `trace:ws` and `study:run`. |
| `scripts/run/session-api/any-url/ws-health-check.js` | `main()` | CLI/env inputs (`BASE`, `CID`, `URL`, trace knobs) | Health-check console JSON + artifact pointers | Thin wrapper only; delegates tracing to `ws-trace-runner`. |

## Separation Rule

- DOM classification path:
  - `owner-runtime.probeState` collects DOM signals.
  - `page-state-classifier.classifyPageState` assigns state.
- WebSocket classification path:
  - `live-ws-state-classifier.recordLiveSignalFromWsText` parses websocket blobs.
  - `live-ws-state-classifier.derivePageStateFromLiveSignals` assigns state.
- Shared rule source:
  - both paths reuse `page-state-classifier.classifyPageState` to avoid drift.

## Placement Rationale

- WS trace execution is script-side (`scripts/lib/ws-trace-runner.js`) for this phase.
- Reason:
  - study tooling can evolve quickly without adding server API surface
  - no production route contract changes are required
  - `challenge-study` and `trace:ws` can share one runner module
- Server remains responsible for ownership/session/state APIs only.

## WS Trace Knobs

- `WS_TRACE_MS`:
  - How long `check:ws` keeps collecting live websocket events.
  - Default is `90000` ms.
- `WS_MAX_MESSAGES`:
  - Max retained websocket messages in the trace output.
  - Default is `300`.
- `WS_TRACE_ENABLED`:
  - Enable/disable WS tracing in challenge study.
  - Default is `true`.
- `WS_CHECK_LIVE_URL_TIMEOUT_MS`:
  - Live URL/session timeout requested during refresh.
  - Default is `90000`.
- `WS_SCREENSHOT_ENABLED`:
  - Enable screenshot capture during trace.
  - Default is `true`.
- `WS_SCREENSHOT_INTERVAL_MS`:
  - Periodic screenshot interval.
  - Default is `2000`.
- `WS_SCREENSHOT_MAX`:
  - Per-trace screenshot cap.
  - Default is `120`.

## Screenshot Policy

- Triggered by two sources:
  - periodic capture every `WS_SCREENSHOT_INTERVAL_MS`
  - immediate capture on transition key change (`state:turnstilePageType`)
- Stored under:
  - `.log/<cid>/.../ws/<run-id>/screenshots/*.png`
  - index: `screenshots.jsonl`

## Transition Metrics

- `pageStateFromLive.transitions`:
  - State-change points (deduplicated timeline).
- `pageStateFromLive.transitionMetrics.firstWaitingAt`
- `pageStateFromLive.transitionMetrics.firstCheckboxAt`
- `pageStateFromLive.transitionMetrics.firstNeedCredAt`
- `pageStateFromLive.transitionMetrics.waitingToCheckboxMs`
- `pageStateFromLive.transitionMetrics.waitingToLoginMs`

## Challenge Study Flow

- `challenge-study` probe cycle:
  - attach + probe state (existing)
  - invoke `runWsTrace` with `attachMode=none`
  - refresh live URL + WS trace + screenshots
  - merge WS fields into event payload:
    - `wsTracePath`
    - `wsState`
    - `wsTransitions`
    - `wsTransitionMetrics`
    - `wsScreenshotCount`
- Precedence:
  - WS transition metrics are preferred.
  - probe-based waiting->checkbox polling remains fallback.
