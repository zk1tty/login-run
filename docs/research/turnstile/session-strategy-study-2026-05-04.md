# Session Strategy Study (2026-05-04)

## Scope
- Goal priority: reduce Cloudflare challenge rate first.
- Compare runtime approaches:
  - Direct browser-endpoint CDP (stateless test style)
  - Owner-managed session flow (`/attach`, `/state`, `/live-url/refresh`)
- Evaluate routes and solve modes on Cloudflare test page and HealthEquity login page.

## Runtime Models

| Topic | Direct Browser-Endpoint CDP | Owner-Managed Session Flow |
|---|---|---|
| Primary entry | `chromium.connectOverCDP(getCdpEndpoint())` | `POST /attach` + `GET /state` + `POST /live-url/refresh` |
| Session scope | Usually per-run (stateless by default) | Per-customer owned session with lifecycle state |
| Captcha solve API access | Reliable in this study (`Browserless.solveCaptcha` available) | Can miss solver API if only `pageCdpUrl` target is used |
| Best fit | Challenge-rate benchmarking, solver A/B tests | Long workflows, human handoff, persistent orchestration |
| Operational complexity | Lower | Higher, but better control-plane behavior |

## Condition and Result Matrix

| Condition | Result |
|---|---|
| Cloudflare test URL, `/chromium`, `auto` | Resolved; final state no visible challenge |
| Cloudflare test URL, `/chromium`, `programmatic` | `solveCaptcha` returned `found=true`, `solved=true` |
| Cloudflare test URL, `/stealth`, `auto` | Resolved in observed runs; timeline captured |
| Cloudflare test URL, `/stealth`, `programmatic` | `captchaFound` + `solveCaptcha(found=true, solved=true)` |
| HealthEquity URL, `/stealth`, `auto` | No challenge detected during window |
| HealthEquity URL, `/stealth`, `programmatic` | `solveCaptcha(found=false, solved=false)`; no challenge present |
| Historical browser-endpoint solve runner | `tokenAccepted=true`, `uiTransitioned=true`, `finalPass=true` on Cloudflare test URL |

## Timelapse Measurement (`/stealth`, 200ms Frames)

Run:
- `.log/danny/captcha-modes/captcha-modes-20260504-140929-069/summary.json`

Milestones and laps:

| Mode | Initial Connection | Checkmark Appears | Checkmark Resolved | Initial->Appears | Appears->Resolved |
|---|---|---|---|---:|---:|
| `auto` | `2026-05-04T21:09:30.776Z` | `2026-05-04T21:09:30.776Z` | `2026-05-04T21:09:44.128Z` | `0 ms` | `13353 ms` |
| `programmatic` | `2026-05-04T21:09:52.381Z` | `2026-05-04T21:09:52.382Z` | `2026-05-04T21:09:59.247Z` | `1 ms` | `6865 ms` |

Solver result (`programmatic`):
- `found=true`
- `solved=true`
- `time=6260 ms`

## Tail-Capture Update
- Screenshot timeline now continues after last solve/captcha event.
- Added `CAPTCHA_EVENT_TAIL_MS` (default `3000`).
- Confirmed in run:
  - last signal offset: `12118 ms`
  - mode completed at `16171 ms`
  - extra tail capture > 3 seconds present.

## HealthEquity Outcome (Why No Challenge Triggered)

Run:
- `.log/danny/captcha-modes/captcha-modes-20260504-141017-054/summary.json`

Observed facts:
- No `Browserless.captchaFound` event in auto mode.
- Programmatic solve returned:
  - `found=false`
  - `solved=false`
  - error message indicates no captcha present on page.
- Final snapshots stayed on normal login page (`HealthEquity Login`).

Interpretation:
- In this measured window and environment, HealthEquity did not present Cloudflare challenge.
- This is consistent with challenge-avoidance success under current `/stealth` conditions.

## Why Keep Owner-Managed Sessioning If Stateless Solver Works?

Use direct endpoint as primary when goal is challenge-rate reduction experiments.
Keep owner-managed flow when product behavior needs:
- per-customer owned browser lifecycle
- explicit API orchestration (`attach/state/refresh`)
- human handoff/live URL workflows
- resumable multi-step operations beyond captcha testing.

## Evidence Paths

Cloudflare test runs:
- `.log/danny/captcha-modes/captcha-modes-20260504-131907-998/summary.json`
- `.log/danny/captcha-modes/captcha-modes-20260504-134601-764/summary.json`
- `.log/danny/captcha-modes/captcha-modes-20260504-134642-540/summary.json`
- `.log/danny/captcha-modes/captcha-modes-20260504-135559-473/summary.json`
- `.log/danny/captcha-modes/captcha-modes-20260504-140929-069/summary.json`

HealthEquity run:
- `.log/danny/captcha-modes/captcha-modes-20260504-141017-054/summary.json`

Refactored resolver run:
- `.log/danny/captcha-programmatic/captcha-prog-20260504-134515-223/summary.json`
