## Turnstile
### A/B) Cloudflare Turnstile bot-detection check

Run each command, open the printed `Live URL`, wait for Turnstile result, then stop with `Ctrl+C`.
If the initial snapshot is empty, expand `Technical Details` in the page: the script now auto-captures a follow-up snapshot when those fields appear.
Each run auto-appends a JSONL snapshot to `.log/turnstile/runs.jsonl` with:
- `sessionId`
- `ipAddress`
- `turnstileStatus`
- `technicalDetailsOpen`
- `liveSecurityStatus`
- `liveSecurityErrorCode`
- `liveSecurityResultTitle`
- `target`
- `script`

```bash
URL="https://browser-compat.turnstile.workers.dev/" \
BL_PROXY=cloud \
npm run connect:cdp
```

```bash
URL="https://browser-compat.turnstile.workers.dev/" \
BL_PROXY=cloud_stealth \
npm run connect:cdp
```

```bash
URL="https://browser-compat.turnstile.workers.dev/" \
BL_PROXY=cloud_stealth_residential_sticky \
npm run connect:cdp
```

```bash
URL="https://browser-compat.turnstile.workers.dev/" \
BL_PROXY=cloud_unblock \
npm run connect:unblock
```

Quick compare:

```bash
tail -n 20 .log/turnstile/runs.jsonl | jq .
```

Expected interpretation:
- If diagnostics are all green but `turnstileStatus=failed` (e.g. `6000010`), treat this as challenge/risk failure, not missing browser APIs.
- A residential IP can still fail; this does not prove the browser config is wrong.

Recommended default path:
- Primary: `cloud_stealth`
- Fallback: `cloud_unblock` only when the target site specifically requires it
- Note: `/unblock` usually feels slower for manual LiveURL interaction because it adds an unblock pre-step before attach.

Low-latency LiveURL knobs:

```bash
LIVE_URL_COMPRESSED=false \
LIVE_URL_EMULATE_COMPONENTS=false \
LIVE_URL_SHOW_BROWSER_INTERFACE=true \
URL="https://browser-compat.turnstile.workers.dev/" \
BL_PROXY=cloud_stealth \
npm run connect:cdp
```

Optional control:
- `TURNSTILE_LOG_WAIT_MS` (default `12000` on Turnstile test page)
- `TURNSTILE_LOG_TECHNICAL_WAIT_MS` (default `300000`, follow-up wait for expanded `Technical Details`)
- `TURNSTILE_LOG_POLL_MS` (default `500`)
- `TURNSTILE_LOG_PATH` (default `.log/turnstile/runs.jsonl`)