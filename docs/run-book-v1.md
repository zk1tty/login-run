## Runbook V1 (Stepwise)

### 0) Start API server in stealth target mode

```bash
BL_PROXY=cloud_stealth \
bun run start:bl-server
```

### 1) Attach + refresh LiveURL

```bash
BASE=http://127.0.0.1:8787
CID=danny
```

```bash
curl -s -X POST "$BASE/admin/owners/$CID/attach" \
  -H "content-type: application/json" \
  -d '{"forceNewSession": false}' | jq .
```

```bash
curl -s -X POST "$BASE/admin/owners/$CID/live-url/refresh" \
  -H "content-type: application/json" \
  -d '{"liveUrlOptions":{"interactive":true,"showBrowserInterface":true,"timeout":900000}}' | jq .
```

### 1.5) WebSocket health check (CDP + Live stream)

```bash
BASE="$BASE" \
CID="$CID" \
URL="https://my.healthequity.com/ClientLogin.aspx" \
REFRESH_LIVE_URL=true \
bun run trace:ws
```

Use this when live view blinks to "Something happened" or DevTools disconnects.
Default live URL timeout for `check:ws` is `9000ms`.
Optional override: `WS_CHECK_LIVE_URL_TIMEOUT_MS=6000`.
The command prints `Refreshed LiveURL` first and writes full websocket message trace to `.log/<CID>/ws-health/<timestamp>/messages.json`.

### 1.6) More stable viewer entrypoint (recommended)

Prefer opening this route in browser instead of manually pasting previous `liveURL`:

```bash
echo "$BASE/live/$CID?forceRefresh=false&waitMs=8000"
```

That route reuses a valid current live URL and avoids stale-link usage.


### 2) Phase 1 script (cred + otp send-code boundary)

Phase 1 includes:
- all `cred` steps + OTP until `otp.send_code.click`

```bash
EMAIL="nessup@gmail.com" \
PASSWORD="qfb1zqu6tqt1HEK-jrm" \
bash scripts/run/session-api/hsa-workflow/phase1-auth.sh
```

`phase1-auth.sh` calls `/admin/owners/:customerId/attach` first with `forceNewSession=true` by default, so each run creates a fresh server-side Browserless session and picks up current stealth/proxy config.

Logs are saved per run under:
- `.log/<customerId>/runs/step-auth/<timestamp>/cred_*.json`
- `.log/<customerId>/runs/step-auth/<timestamp>/otp_*.json`
- `.log/<customerId>/runs/step-auth/<timestamp>/phase1-summary.json`

### 3) Phase 2 script (remaining OTP + HSA extract)

Phase 2 includes:
- `otp.code.focus`
- `otp.code.type`
- `otp.remember.toggle_if_present`
- `otp.confirm.click`
- live DOM extraction via `/admin/owners/:customerId/extract/hsa`

```bash
OTP_CODE="123456" \
SELECTION="email" \
bash scripts/run/session-api/hsa-workflow/phase2-auth.sh
```

Optional Phase 2 wait/retry tuning:
- `PORTAL_WAIT_MAX_MS` (default `45000`): max wait for redirect to member portal before extract begins.
- `PORTAL_WAIT_POLL_MS` (default `1500`): polling interval while waiting for portal redirect.
- `EXTRACT_MAX_ATTEMPTS` (default `5`): retry count for `/extract/hsa`.
- `EXTRACT_RETRY_MS` (default `1500`): delay between extract retries.

Artifacts:
- `.log/<customerId>/runs/step-auth/<timestamp>/phase2-summary.json`
- `.log/<customerId>/runs/step-auth/<timestamp>/hsa-account.json`

### 4) Direct HSA extraction endpoint (optional)

```bash
curl -s -X POST "$BASE/admin/owners/$CID/extract/hsa" \
  -H "content-type: application/json" \
  -d '{}' | jq .
```

### 5) Optional cursor reset
```bash
curl -s -X POST "$BASE/admin/owners/$CID/actions/cred/reset" -H "content-type: application/json" | jq .
curl -s -X POST "$BASE/admin/owners/$CID/actions/otp/reset" -H "content-type: application/json" | jq .
```
