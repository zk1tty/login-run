# Puppeteer Login API Design

## Current Scope

The server has one purpose: run asynchronous Puppeteer login automation through Browserless Session API sessions.

Public routes:

```text
GET  /health
POST /v1/logins
GET  /v1/logins/:runId
GET  /v1/logins/:runId/events
POST /v1/logins/:runId/otp
```

No legacy owner-runtime, live-url alias, micro-step, or AgentQL routes are part of the current server.

## Runtime Layout

```text
src/core/run
  login-run-service.js          API-facing in-memory run state and SSE events

src/core/browserless
  browserless-session.js        Browserless Session API create/connect/stop helpers
  login-connection.js           direct/session-resume connection resolution

src/core/puppeteer
  keepalive-probe.js            main Puppeteer login probe used by API and CLI
  keepalive-concurrency-probe.js
  session-runtime.js
  page-adapter.js

src/core/workflow
  runtime-inventory.js          DOM inventory and stage classification
  action-planner.js             deterministic next-action planning
  action-executor.js            browser action execution
  page-stability.js
  captcha-state.js
  manual-captcha-solver.js

src/core/otp
  gmail-otp-reader.js
```

## Run State

The API stores runs in memory for now.

States:

```text
running / authing
waiting_input / need_otp
succeeded / authed
failed / failed
```

Polling `GET /v1/logins/:runId` is canonical. SSE is a frontend convenience channel.

## Browserless Target Config

`config/browserless-targets.json` is still active.

It is loaded through `scripts/lib/runtime-target-config.js` and `scripts/lib/helpers.js`, which are still used by Browserless/session workflow modules. During the TypeScript refactor, move this config loader into `src/core/browserless` so runtime code no longer depends on `scripts/lib`.
