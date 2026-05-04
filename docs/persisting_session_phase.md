## Phased Plan: Runtime Ownership First, Then Reliability Proof, Then Partner API Rollout

## Phase 1 Implementation Status (Completed)

Implemented in server:
- Session API ownership runtime (`create -> attach -> refresh liveURL -> detach -> stop`)
- File-backed session handle persistence at `.log/<customer_id>/owner-session.json`
- Existing live routes now run on owner runtime foundation:
  - `GET /live/:customerId`
  - `GET /live-status/:customerId`
- Admin/runtime routes added:
  - `GET /admin/owners/:customerId`
  - `POST /admin/owners/:customerId/session`
  - `POST /admin/owners/:customerId/attach`
  - `POST /admin/owners/:customerId/live-url/refresh`
  - `POST /admin/owners/:customerId/detach`
  - `DELETE /admin/owners/:customerId/session`
  - `GET /admin/owners/:customerId/state`

Phase 1 prerequisites:
- install dependency: `npm install`
- set `BL_PROXY=cloud` and valid `BROWSERLESS_TOKEN`
- set optional `ADMIN_API_KEY` for remote admin route protection
- if `ADMIN_API_KEY` is set, add header `x-admin-api-key: <value>` to every `/admin/*` request

### Phase 1 Runbook (Step-by-step)

1. Start server:
   - `npm run start:live-alias`

2. Create/reuse session handle:
   - `curl -s -X POST http://127.0.0.1:8787/admin/owners/danny/session -H "content-type: application/json" -d '{}'`

3. Attach owner process:
   - `curl -s -X POST http://127.0.0.1:8787/admin/owners/danny/attach`

4. Mint live URL:
   - `curl -s -X POST http://127.0.0.1:8787/admin/owners/danny/live-url/refresh`

5. Check owner status:
   - `curl -s http://127.0.0.1:8787/admin/owners/danny`

6. Probe website state:
   - `curl -s http://127.0.0.1:8787/admin/owners/danny/state`
   - this now stores probe artifacts at:
     - `.log/<customer_id>/probes/<timestamp>-<state>.html`
     - `.log/<customer_id>/probes/<timestamp>-<state>.json`
   - `probe.snapshot.htmlPath` and `probe.snapshot.metaPath` return the exact artifact paths.

7. Open stable alias:
   - `http://127.0.0.1:8787/live/danny`

8. Detach owner without stopping session:
   - `curl -s -X POST http://127.0.0.1:8787/admin/owners/danny/detach`

9. Stop and cleanup session:
   - `curl -s -X DELETE http://127.0.0.1:8787/admin/owners/danny/session`

### Summary
- Re-sequence implementation into 5 phases with strict priority on runtime validation before partner API exposure.
- Phase-1 focus is operational truth: can Session API persist, how often Cloudflare challenge appears, and when re-auth is required.
- Chosen defaults for this cycle:
  - 30-minute observation window
  - 5 runs
  - Browserless **no-proxy only**
  - tunnel is transport only (not primary experiment factor)

### Implementation Phases
1. **Phase 1: Runtime Ownership Core (Session API + Puppeteer owner)**
- Build an owner runtime service that owns `create session -> attach -> mint liveURL -> detach -> stop`.
- Persist owner session handles per `customer_id` to disk (file-backed).
- Keep existing `/live` + `/live-status` routes, but back them with this owner runtime (not one-off runner flow).
- Add admin control endpoints for runtime lifecycle (`session`, `attach`, `refresh liveURL`, `detach`, `stop`) and owner status.
- Add a state probe endpoint that detects current website state (`need_cred`, `need_otp`, `authed`, challenge/re-auth markers) from the active page.

2. **Phase 2: Manual LiveURL State Driving + Instrumentation**
- Use LiveURL for human-in-the-loop transitions (manual credential/OTP/input flow).
- Add runless experiment tracker (separate from partner `run_id`) that records:
  - timestamped state transitions
  - challenge detections
  - re-auth prompt detections
  - session attach/detach continuity outcomes
- Redact all secrets from logs/events.
- Store experiment artifacts in file-backed logs for reproducible analysis.

3. **Phase 3: Execute Reliability Study (Top 3 Questions)**
- Execute 5 runs, each with 30-minute observation.
- For each run, collect:
  - **Q1 Persistence**: reattach success using same Session API handle, same session id continuity, and liveURL refresh viability.
  - **Q2 Cloudflare challenge frequency**: challenge events per run and per minute.
  - **Q3 Re-auth timing**: elapsed time from authenticated state to first re-auth prompt (or no re-auth within window).
- Fixed condition for this cycle: Browserless cloud **no proxy**.
- Output machine-readable summary + human-readable findings doc.

4. **Phase 4: Share Partner-Facing Reliability Report**
- Produce a concise partner report with:
  - methodology (window, sample size, no-proxy condition, manual steps)
  - KPI table for Q1/Q2/Q3
  - observed failure modes and reproducibility notes
  - operational recommendation for current readiness
- Include explicit limitations: no residential-proxy comparison in this cycle.
- Shareable artifact: one markdown report in `docs/` plus linked raw metrics file.

5. **Phase 5: User-Facing API v1 Rollout + Documentation Refresh**
- Implement partner `run_id` API on top of validated runtime foundation:
  - `POST /v1/runs`
  - `GET /v1/runs/:run_id`
  - `POST /v1/runs/:run_id/actions/{cred|otp|pull|stop}`
  - optional `GET /v1/runs/:run_id/stream`
- Keep single-active-run per `customer_id`, file-backed run durability, idempotency replay semantics.
- Keep LiveURL/DevTools as admin-only.
- Update user-facing docs:
  - API Endpoint v1 contract
  - state machine concept and transition rules
  - integration quickstart + troubleshooting from reliability findings

### Test Plan and Acceptance Criteria
- **Phase 1 gate**
  - Session create/attach/detach/stop works for a customer profile.
  - `/live/:customerId` resolves to a valid liveURL from owner runtime.
  - state probe can distinguish at least: `need_cred`, `need_otp`, `authed`, `challenge`, `reauth`.
- **Phase 2 gate**
  - Manual LiveURL interactions produce timestamped, redacted transition logs.
  - experiment tracker persists and reloads state across server restart.
- **Phase 3 gate**
  - 5 completed runs with complete telemetry and no missing core fields.
  - KPI outputs for Q1/Q2/Q3 generated automatically from logs.
- **Phase 4 gate**
  - partner report includes conclusions + limitations + recommendation.
- **Phase 5 gate**
  - `run_id` contract matches `docs/api-endpoint-v1`.
  - action/state behavior conforms to `need_cred -> authing -> need_otp -> authed -> pulling -> extract_success`.

### Assumptions and Defaults
- This cycle is intentionally no-proxy only.
- Cloudflare tunnel behavior is treated as transport context, not primary variable.
- HealthEquity is the first adapter; architecture remains site-agnostic.
- Partner API release is gated on Phase 1–4 evidence, not implemented blindly first.
