# API Endpoint v1

## Purpose

This document defines the v1 partner-facing API contract for website login workflows with long-running state management.

Primary use case:
- `healthequity` login with credentials + email OTP + account status extraction

Design goals:
- one stable contract for partners
- async-first execution (`run_id` as the source of truth)
- short action names for low integration overhead
- compatible with multiple websites via site adapters

## Base Conventions

- Base path: `/v1`
- Content type: `application/json`
- Partner auth header: `x-api-key: <partner_api_key>`
- Idempotency header for all `POST`: `Idempotency-Key: <uuid>`
- Time format: ISO-8601 UTC

Identity keys:
- `customer_id`: internal profile/session key in our system
- `partner_user_id`: end-user identifier under one partner

Notes:
- `x-api-key` identifies the partner application.
- `partner_user_id` identifies the end-user under that partner key.

## Core Resource: Run

A run represents one workflow session.

Example:

```json
{
  "run_id": "run_01J2YJQ8D1H3G9YV5A1Q2M3N4P",
  "site": "healthequity",
  "workflow": "login_extract_v1",
  "customer_id": "danny",
  "partner_user_id": "user_123",
  "status": "waiting_input",
  "state": "need_cred",
  "next_actions": [
    "cred"
  ],
  "result": null,
  "error": null,
  "created_at": "2026-04-23T20:10:00Z",
  "updated_at": "2026-04-23T20:10:00Z",
  "expires_at": "2026-04-23T21:10:00Z"
}
```

Run status values:
- `queued`
- `running`
- `waiting_input`
- `succeeded`
- `failed`
- `cancelled`
- `expired`

Run state values:
- `need_cred`
- `authing`
- `need_otp`
- `authed`
- `pulling`
- `extract_success`
- `failed`
- `cancelled`
- `expired`

## Partner API Endpoints

### 1) Create run

`POST /v1/runs`

Request:

```json
{
  "site": "healthequity",
  "workflow": "login_extract_v1",
  "customer_id": "danny",
  "partner_user_id": "user_123",
  "metadata": {
    "consent_id": "consent_abc_001"
  }
}
```

Response `201`:

```json
{
  "run_id": "run_01J2YJQ8D1H3G9YV5A1Q2M3N4P",
  "status": "waiting_input",
  "state": "need_cred",
  "next_actions": [
    "cred"
  ]
}
```

### 2) Get run

`GET /v1/runs/{run_id}`

Response `200`:

```json
{
  "run_id": "run_01J2YJQ8D1H3G9YV5A1Q2M3N4P",
  "site": "healthequity",
  "workflow": "login_extract_v1",
  "status": "waiting_input",
  "state": "need_otp",
  "next_actions": [
    "otp"
  ],
  "result": null,
  "error": null,
  "updated_at": "2026-04-23T20:12:40Z"
}
```

### 3) Stream run events (optional)

`GET /v1/runs/{run_id}/stream`

SSE event types:
- `run.updated`
- `run.waiting_input`
- `run.log`
- `run.completed`
- `run.failed`

Polling `GET /v1/runs/{run_id}` remains the canonical source of truth.

### 4) Action: `cred`

`POST /v1/runs/{run_id}/actions/cred`

Purpose:
- submit end-user email/password
- trigger login and move run toward OTP challenge when required

Request:

```json
{
  "email": "user@example.com",
  "password": "plain-text-user-input"
}
```

Response `202`:

```json
{
  "run_id": "run_01J2YJQ8D1H3G9YV5A1Q2M3N4P",
  "status": "running",
  "state": "authing"
}
```

### 5) Action: `otp`

`POST /v1/runs/{run_id}/actions/otp`

Purpose:
- submit 2FA verification code

Request:

```json
{
  "code": "123456"
}
```

Response `202`:

```json
{
  "run_id": "run_01J2YJQ8D1H3G9YV5A1Q2M3N4P",
  "status": "running",
  "state": "authed"
}
```

### 6) Action: `pull`

`POST /v1/runs/{run_id}/actions/pull`

Purpose:
- extract normalized account status from initial authenticated page

Request:

```json
{}
```

Response `202`:

```json
{
  "run_id": "run_01J2YJQ8D1H3G9YV5A1Q2M3N4P",
  "status": "running",
  "state": "pulling"
}
```

### 7) Action: `stop`

`POST /v1/runs/{run_id}/actions/stop`

Purpose:
- cancel an in-progress run

Request:

```json
{}
```

Response `202`:

```json
{
  "run_id": "run_01J2YJQ8D1H3G9YV5A1Q2M3N4P",
  "status": "cancelled",
  "state": "cancelled"
}
```

## Required Flow Path

Requested success path:

`need_cred` (state) -- `cred` (action) --> `authing` (state) --> `need_otp` (state) -- `otp` (action) --> `authed` (state) -- `pull` (action) --> `pulling` (state) --> `extract_success` (state)

## State Transition Diagram

```mermaid
flowchart LR
  A[need_cred] -- cred --> B[authing]
  B -- 2FA required --> C[need_otp]
  C -- otp --> D[authed]
  D -- pull --> E[pulling]
  E -- extract done --> F[extract_success]

  B -- invalid credentials --> A
  C -- otp invalid --> C

  A -- stop --> X[cancelled]
  C -- stop --> X
  D -- stop --> X
  E -- stop --> X

  A -- ttl --> T[expired]
  C -- ttl --> T
  D -- ttl --> T
  E -- ttl --> T

  B -- fatal error --> Z[failed]
  C -- fatal error --> Z
  E -- extraction error --> Z

  classDef success fill:#dcfce7,stroke:#16a34a,stroke-width:3px,color:#14532d;
  class A,B,C,D,E,F success;
  linkStyle 0,1,2,3,4 stroke:#16a34a,stroke-width:3px,color:#14532d;
```

## Result Schema (Minimal v1)

On success (`status=succeeded`, `state=extract_success`):

```json
{
  "run_id": "run_01J2YJQ8D1H3G9YV5A1Q2M3N4P",
  "status": "succeeded",
  "state": "extract_success",
  "result": {
    "normalized": {
      "user_match": true,
      "cash_balance": {
        "amount": "350.64",
        "currency": "USD"
      },
      "investment_balance": {
        "amount": "0.00",
        "currency": "USD"
      },
      "contribution_limit": {
        "amount": "4300.00",
        "currency": "USD"
      },
      "contributed_to_date": {
        "amount": "358.00",
        "currency": "USD"
      },
      "snapshot_at": "2026-04-23T20:16:22Z"
    },
    "site_payload": {}
  }
}
```

## Error Contract

All error responses follow this shape:

```json
{
  "error": {
    "code": "invalid_state",
    "message": "Action otp is only allowed when state=need_otp",
    "retryable": false,
    "current_status": "waiting_input",
    "current_state": "need_cred"
  }
}
```

Common error codes:
- `invalid_request`
- `unauthorized`
- `forbidden`
- `not_found`
- `invalid_state`
- `rate_limited`
- `upstream_timeout`
- `site_challenge_required`
- `internal_error`

## Admin Endpoints (Operational Debug)

These are not partner endpoints. Protect behind a separate admin key.

- `POST /admin/owners/{customer_id}/session`
  - create or load Browserless persistent session
- `POST /admin/owners/{customer_id}/attach`
  - attach Puppeteer owner connection
- `POST /admin/owners/{customer_id}/live-url/refresh`
  - mint new interactive LiveURL for debugging
- `POST /admin/owners/{customer_id}/detach`
  - `disconnect()` owner while keeping remote browser alive when possible
- `DELETE /admin/owners/{customer_id}/session`
  - stop Browserless session and cleanup local state

## Security and Data Handling

- credentials and OTP are process-only inputs
- raw secrets are never persisted
- logs and stream events must redact secrets
- run metadata stays observable for audit/debug without exposing sensitive fields

## Multi-Site Extension Model

This API is generic by design:
- `site` selects adapter behavior (example: `healthequity`)
- endpoint surface remains unchanged when adding new sites
- `result.normalized` remains stable across sites
- site-specific fields go to `result.site_payload`
