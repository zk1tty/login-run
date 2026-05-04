# Actionable Query + Stepwise Runtime Plan

## Summary
This plan moves the login runtime to a config-driven, stepwise execution model with deterministic checkpoints.

Current status:
- Query detection is deterministic and raw-HTML-driven.
- Runtime micro-step execution is generic (`:macro`) and locally testable.

## Phase 1: Config Foundation (Initial Step)
Goal:
- Make step ordering configurable and separate from execution logic.

Deliverables:
- Add a per-site/workflow micro-step config file.
- Add a config loader + validator service.
- Enforce deterministic step IDs and allowed handlers.
- Expose config metadata (`version`, `hash`) for runtime auditability.

Acceptance criteria:
- Invalid config fails validation with clear error message.
- Reordering steps in config does not require code changes in executor modules.
- Config metadata can be retrieved by runtime services.

## Phase 2: Phase-Agnostic Query Contract
Goal:
- Return one unified action map every probe render.

Deliverables:
- Replace phase-gated action surface with unified `actions`.
- Keep `phase_hint` as metadata only.
- Add value extraction metadata for detected inputs.

Acceptance criteria:
- `found` strictly means actionable now.
- Hidden/disabled/not-rendered are represented by deterministic blocked codes.

Status:
- Baseline implemented:
  - unified `actions` payload added,
  - `phaseHint` metadata added,
  - input value metadata extraction added for username/password/confirmationCodeInput,
  - `documentActions` exposed in runtime probe state.

## Phase 3: Execution Module Split
Goal:
- Separate orchestration, execution, and validation checkpoints.

Deliverables:
- Config-driven micro-step registry behavior from config.
- `micro-executor` for Puppeteer-native step handlers.
- Runtime checkpoint persistence on owner state (`lastAction`, `actionProgress`, `actionCheckpoints`).

Acceptance criteria:
- One API call advances exactly one configured micro step.
- Each executed step has structured checkpoint evidence.

Status:
- Baseline implemented:
- `src/core/workflow/micro-executor.js` added,
  - handler result validation is wired through `validateStepActionResult`,
  - progress and checkpoint fields are persisted on owner runtime status.

## Phase 4: Admin Runtime Actions
Goal:
- Add internal endpoints for stepwise action control.

Deliverables:
- Keep generic endpoint: `POST /admin/owners/:customerId/actions/:macro`
- Enriched `GET /admin/owners/:customerId/state` with `lastAction`, `actionProgress`, and checkpoint window.

Acceptance criteria:
- Step progression follows config order exactly.
- Retry behavior is deterministic when a step is blocked.

Status:
- Baseline implemented and wired via orchestrator.
- Wrapper endpoints (`/actions/cred`, `/actions/otp`) are intentionally out of scope.

## Phase 5: Partner v1 Wiring
Goal:
- Reuse the same engine under `/v1/runs/{run_id}/actions/*`.

Deliverables:
- Wire `cred` and `otp` to the same stepwise engine.
- Keep v1 run state model stable (`need_cred -> authing -> need_otp -> authed`).

Acceptance criteria:
- No contract drift from `docs/api-endpoint-v1.md`.
- Admin and partner actions share the same execution core.

## Locked Config Pattern
- Scope: per `site + workflow`.
- ID format: deterministic `macro.subject.verb`.
- Macro order comes from config lists only.
- Execution handlers are order-agnostic and referenced by name.

## Implementation Schema

### 1) Config Schema (`config/micro-steps/<site>.<workflow>.json`)
- Top-level:
  - `version: string`
  - `site: string`
  - `workflow: string`
  - `bootstrapUrl: string` (workflow bootstrap source of truth)
  - `macros: Record<string, { steps: string[] }>`
  - `steps: Record<stepId, StepDefinition>`
- `StepDefinition`:
  - `handler: string` (must be allowed handler)
  - optional runtime fields used by handlers:
    - `selectorRef`
    - `payloadKey`
    - `timeoutMs`
    - `retryable`

### 2) Action Result Schema (validated at runtime)
- Validator entrypoint: `validateStepActionResult({ stepId, handler, result })`
- Common:
  - `stepId: string`
  - `handler: string`
  - `result.status: "ok" | "blocked" | "failed"`
- Required on blocked:
  - `result.blockedCode: string`
- Required on failed:
  - `result.errorCode: string`
- Handler-specific `ok` requirements:
  - `focus_field` -> `focused: true`
  - `type_from_payload` -> `typed: true`, `typedLength >= 0`
  - `press_enter` -> `key: "Enter"`
  - `click_field` -> `clicked: true`
  - `assert_actionable` -> `actionable: true`
  - `toggle_if_present` -> `present: boolean`, and if present then `toggled: boolean`
  - `select_option` -> `selected: true`, `selectedValue: string`

### 2-1) Unified Action Keys (phase-agnostic)
- `username`
- `password`
- `continueButton`
- `selection`
- `sendCodeButton`
- `confirmButton`
- `confirmationCodeInput`
- `rememberDevice`

### 3) Runtime Execution Schema
- Request:
  - `POST /admin/owners/:customerId/actions/:macro`
  - body: generic payload map used by configured steps
- Response:
  - `execution`:
    - `macro`, `orderIndex`, `stepId`, `status`, `result`, `nextStepId`, `done`, `phaseHintAfter`
  - `status`:
    - standard owner status + `actionProgress`, `lastAction`, `actionCheckpoints`
- Progress model:
  - `actionProgress`: `{ macro, cursor, totalSteps, done, currentStepId, nextStepId, configVersion, configHash, updatedAt }`

## Local Testing Focus
- Keep endpoint surface generic (`:macro`) and test locally first.
- Required local tests:
  - config loading + sanity validation
  - handler result validation unit tests
  - micro-executor unit tests for `ok/blocked/failed`
  - owner runtime integration for cursor advance and checkpoint persistence
- Smoke runbook:
  1. `POST /admin/owners/:customerId/session`
  2. `POST /admin/owners/:customerId/attach`
  3. `GET /admin/owners/:customerId/state`
  4. `POST /admin/owners/:customerId/actions/cred` (or `otp`) repeatedly
  5. `GET /admin/owners/:customerId/state` after each step to inspect progress/checkpoints

---
For **reusing the same persistent session**, use these POST params:

Common headers (for all POST):
- `content-type: application/json`
- `x-admin-api-key: <key>` (only if your server is configured with `ADMIN_API_KEY`)

Assume:
- `BASE=http://127.0.0.1:8787`
- `CID=danny`

### 1) Create/reuse session
`POST /admin/owners/:customerId/session`

Body params:
- `forceNew` (boolean, optional) -> use `false` to reuse
- `attachOwner` (boolean, optional)
- `ttlMs` (int, optional)
- `processKeepAliveMs` (int, optional)
- `connectTimeoutMs` (int, optional)
- `bootstrapUrl` (string, optional)

Reuse call:
```bash
curl -s -X POST "$BASE/admin/owners/$CID/session" \
  -H "content-type: application/json" \
  -d '{"forceNew": false}'
```

### 2) Attach owner to reused session
`POST /admin/owners/:customerId/attach`

Body params:
- `forceNewSession` (boolean, optional) -> use `false` to reuse
- `ttlMs` (int, optional)
- `processKeepAliveMs` (int, optional)
- `connectTimeoutMs` (int, optional)
- `bootstrapUrl` (string, optional)

Reuse call:
```bash
curl -s -X POST "$BASE/admin/owners/$CID/attach" \
  -H "content-type: application/json" \
  -d '{"forceNewSession": false, "bootstrapUrl":"https://my.healthequity.com/ClientLogin.aspx"}'

 
```
### 2-2) Get liveURL
```bash
curl -s -X POST "${BASE}/admin/owners/${CID}/live-url/refresh" \n
-H "content-type: application/json" \n
-d '{"liveUrlOptions": {"interactive": true,"showBrowserInterface": true,"timeout": 900000}}'| jq .
```

### 3) Execute micro step (generic macro endpoint)
`POST /admin/owners/:customerId/actions/:macro`

Path param:
- `macro` -> from config (currently `cred`, `otp`)

Body params (depends on macro):
- for `cred`: `email`, `password`
- for `otp`: `code`, optional `selection`

Examples:
```bash
# cred stepwise
curl -s -X POST "$BASE/admin/owners/$CID/actions/cred" \
  -H "content-type: application/json" \
  -d '{"email":"user@example.com","password":"secret"}'

# otp stepwise
curl -s -X POST "$BASE/admin/owners/$CID/actions/otp" \
  -H "content-type: application/json" \
  -d '{"code":"123456","selection":"sms"}'
```

### 3-2) Reset macro progress to step zero (same session)
`POST /admin/owners/:customerId/actions/:macro/reset`

No body required.

Example:
```bash
curl -s -X POST "$BASE/admin/owners/$CID/actions/cred/reset"
```

### 4) Refresh Live URL (optional)
`POST /admin/owners/:customerId/live-url/refresh`

`POST /admin/owners/:customerId/detach`

No body required.

```bash
curl -s -X POST "$BASE/admin/owners/$CID/detach"
```

Note: when endpoint schema expects body object, send `{}` (not empty body), otherwise Fastify can return `body must be object`. The reset endpoint does not require a body.
