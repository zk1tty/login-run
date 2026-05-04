# Turnstile Behaivieral Study

## Goal
Run a repeatable Turnstile behavior study every 10 minutes across:
- Session condition: `fresh` vs `persistent`
- Proxy mode: `cloud`, `cloud_stealth`, `cloud_stealth_residential_sticky`, `cloud_unblock`
- Target URL: any URL (set via `URL`)

Primary outcome:
- Determine whether rendered page is a Turnstile challenge page
- If challenge page is rendered, classify challenge type:
- `waiting`: "Just a moment" style auto-redirect flow (no checkbox click required)
- `checkbox`: checkbox appears after waiting flow and requires user click
- Measure transition timing for each page phase
- Specifically measure time from `waiting` page to `checkbox` page when checkbox appears
- Generate machine-readable + human-readable study outputs

## Session Condition Spec
- `fresh` condition must call `/attach` with `forceNewSession=true`.
- `persistent` condition must call `/attach` with `forceNewSession=false`.
- The runner resets baseline once at condition start by calling `DELETE /admin/owners/:customerId/session` before the first probe of that condition.
- In `fresh`, runner deletes session after each probe.
- In `persistent`, runner keeps session alive across probes.

## Proxy Mode Spec
Use `BL_PROXY` with these canonical values:
- `cloud`
- `cloud_stealth`
- `cloud_stealth_residential_sticky`
- `cloud_unblock`

## Runtime Entry Points
- Runner: `scripts/run/session-api/any-url/challenge-study.js`
- Reporter: `scripts/run/session-api/any-url/challenge-study-report.js`

## Required Env
- `BASE` (default: `http://127.0.0.1:8787`)
- `CID` or `CUSTOMER_ID`
- `URL`
- `BL_PROXY`

Recommended:
- `ADMIN_API_KEY`
- `CHALLENGE_STUDY_INTERVAL_MINUTES=10`
- `CHALLENGE_STUDY_MAX_HOURS=24`

## Cron Design
Use `--once` in cron. Cron provides the 10-minute cadence.

Example single proxy cron command:
```bash
*/10 * * * * cd /Users/norikakizawa/Projects/browserless && BASE="http://127.0.0.1:8787" CID="danny_cloud_stealth" URL="https://browser-compat.turnstile.workers.dev/" BL_PROXY="cloud_stealth" bun run study:url:run -- --once >> .log/cron/persistent-study-v2-cloud_stealth.log 2>&1
```

Run one cron line per proxy mode.
Use distinct `CID` per proxy mode to prevent cross-proxy session contamination.

## Output Layout
Default output root is namespaced by customer, proxy, and URL:
- `.log/<cid>/challenge-study/<proxy-tag>/<url-tag>/state.json`
- `.log/<cid>/challenge-study/<proxy-tag>/<url-tag>/events.jsonl`
- `.log/<cid>/challenge-study/<proxy-tag>/<url-tag>/summary.json`
- `.log/<cid>/challenge-study/<proxy-tag>/<url-tag>/summary.md`

You can override with `CHALLENGE_STUDY_DIR`.

## Report Contract
`summary.json` and `summary.md` include:
- Proxy mode and target URL
- Probe counts and challenge counts
- Unique session IDs and egress IPs per condition
- Assertions:
- `freshAttachModePass` (fresh uses `forceNewSession=true`)
- `persistentAttachModePass` (persistent uses `forceNewSession=false`)
- `freshSessionRotationPass`
- `persistentSessionReusePass`
- `reChallengeObservedAfterManualSolve`

## Manual Solve Steps
When challenge is first detected:
- `bun run study:url:run -- --manual-solve-start`
- Open live URL and solve manually
- `bun run study:url:run -- --manual-solve-complete`

## Reset
To restart a study namespace:
```bash
bun run study:url:run -- --reset
```
