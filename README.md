# StayAuthed

StayAuthed is infrastructure for human and agents that need to use websites without first-class APIs.

Agents often need access to platforms where you do not own the end user's account. The user has to log in, pass CAPTCHA or OTP, and then the agent needs to keep working later without asking the user to repeat the same login flow. StayAuthed provides the remote browser session layer for that.

## What It Solves

- Forward user login into a remote browser.
- Keep the browser session authenticated after the first login.
- Let agents reconnect to the authenticated session and run repeatable workflows.
- Avoid lock-in to one browser-agent provider by keeping the login/session layer separate.

This is not the agent itself. It is the authentication and browser-session infrastructure that lets you choose or generate agents on top.

## Why This Exists

Browser agents are useful, but login management is still painful:

- CAPTCHA, proxies, and session persistence are not consistently supported by agent providers.
- Quick experiments require too much setup.
- Browser-agent startups often optimize support for enterprise customers first.
- Most agent workflows need user login, but teams usually rebuild that environment themselves.

StayAuthed focuses on the common missing layer: getting a user logged in once and keeping the remote browser usable for future agent work.

## Current API

The server exposes a small async login API.

```text
GET  /health
POST /v1/logins
GET  /v1/logins/:runId
GET  /v1/logins/:runId/events
POST /v1/logins/:runId/otp
```

Start phase 1:

```bash
curl -s -X POST http://127.0.0.1:8787/v1/logins \
  -H "content-type: application/json" \
  -d '{
    "customerId": "demo-user",
    "targetUrl": "https://example.com/login",
    "username": "user@example.com",
    "password": "password",
    "otpDeliverySelection": "email"
  }'
```

Poll status:

```bash
curl -s http://127.0.0.1:8787/v1/logins/<runId>
```

Submit OTP:

```bash
curl -s -X POST http://127.0.0.1:8787/v1/logins/<runId>/otp \
  -H "content-type: application/json" \
  -d '{"code":"123456"}'
```

Frontend clients can also subscribe to:

```text
GET /v1/logins/:runId/events
```

Polling is the source of truth; SSE is for frontend completion callbacks.

## Tech Stack

- Fastify API server
- Puppeteer over Browserless Session API
- Browserless persistent sessions and proxy profiles
- Deterministic DOM inventory, stage classification, action planning, and action execution
- Gmail OTP helper for development and testing

## Setup

```bash
cp .env.example .env
npm install
npm run start:bl-server
```

Useful environment:

- `BROWSERLESS_TOKEN`
- `BL_PROXY=local|cloud|cloud_stealth|cloud_stealth_residential|cloud_stealth_residential_sticky`
- `PUPPETEER_API_HOST=0.0.0.0`
- `PUPPETEER_API_PORT=8787`

Browserless target profiles live in `config/browserless-targets.json`.

## Scripts

```bash
npm run login:probe
npm run login:probe:concurrency
npm run otp:gmail:init
npm run otp:gmail:watcher
npm test
```

## Docs

- `docs/design/project-overview.md`
- `docs/design/puppeteer-login-api.md`
- `docs/design/login-workflow.md`
- `docs/research/`

## Direction

Next, StayAuthed will add sandbox code-mode adaptation: natural-language workflow requests generate and run site-specific workflow code in a cloud container while users can observe outcomes without manually implementing or testing every browser step.
