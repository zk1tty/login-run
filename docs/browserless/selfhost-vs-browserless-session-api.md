# Selfhost Vs Browserless Paid Session API

This note captures how our current self-hosted profile-reuse flow compares to Browserless paid Session API (`POST /session`) and why our current path is still useful.

## Context

Browserless Session API (Persisting State) provides explicit session lifecycle APIs:

- `POST /session` to create a session
- `session.connect` websocket URL to attach automation clients
- `session.stop` URL to terminate and clean up
- required `ttl` to control session data lifetime
- optional `processKeepAlive` to preserve live in-memory browser state briefly after disconnect

Reference:

- https://docs.browserless.io/baas/session-management/persisting-state
- https://docs.browserless.io/baas/session-management/standard-sessions

As of the referenced docs, persisted session data duration depends on plan (for example, Prototyping plan lists up to 7 days). Pricing and limits can change, so always confirm in Browserless billing/docs.

## What We Already Do (Self-Hosted)

Our current repo already implements the core persistence mechanism directly:

- customer-scoped profile directories via `--user-data-dir=/profiles/<customer>`
- reconnect/attach by discovering running sessions from `/sessions`
- auth artifact exports (`storage-state.json`, `cookies.json`) as fallback bootstrap
- optional hold-open and periodic measurement workflows

Implementation references:

- `src/helpers.js` (`launch` query + `--user-data-dir`)
- `src/reuse-live-session-module.js` (`/sessions` lookup + attach logic)
- `src/login-agentql-reuse-live-session.js` (reuse decision flow + measurement)

## Architecture Comparison

| Capability | Browserless Paid Session API | Current TinyFish Flow |
| --- | --- | --- |
| Session creation contract | Explicit `POST /session` | Implicit via websocket connect to `/chromium` |
| Session handle | Stable `id`, `connect`, `stop` | Derived from `/sessions` metadata and profile path |
| Data persistence unit | Server-managed isolated `userDataDir` per session | Profile path managed by us (`/profiles/<customer>`) |
| Retention policy | API-level `ttl` with plan limits | We rely on local Docker volume + our own process practices |
| Live-state grace after disconnect | `processKeepAlive` (Session API feature) | Hold-open/reattach behavior in our scripts |
| Concurrency policy | Documented single-client semantics for session access | Not explicitly enforced by our own API layer |
| Access control | API key + managed URLs | Local infra/network control only |
| Stop/cleanup API | First-class `session.stop` endpoint | Manual process close / container cleanup |

## Current Gap Summary

What we are missing versus the paid API:

1. First-class Session API contract (`create/connect/stop`) for callers.
2. Explicit, enforceable TTL and cleanup semantics at API level.
3. Clear single-client lock and conflict responses from our own interface.
4. Managed operational guarantees (uptime/SLA/hosted controls) from Browserless Cloud.

## Why Current Approach Is Still Valuable

The current approach is a practical "Session API lite" for prototyping:

1. It validates product behavior and customer login/session persistence now.
2. It avoids immediate paid dependency while requirements are still shifting.
3. It can be wrapped behind a small internal session broker later, then swapped to Browserless Session API with minimal frontend changes.

## Recommended Path

1. Keep current flow for immediate testing and iteration.
2. Introduce an internal session abstraction now (`create/connect/stop`, TTL metadata).
3. Later choose backend:
   - continue self-hosted implementation
   - or switch to Browserless paid Session API without changing the frontend contract
