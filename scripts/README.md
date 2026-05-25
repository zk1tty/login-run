# Script Index

Current scripts are limited to Puppeteer login operations and Gmail OTP helpers.

## Puppeteer Login

- `puppeteer-login/keepalive-probe.js`
  - Runs one Browserless Session API Puppeteer login probe.
- `puppeteer-login/keepalive-concurrency-probe.js`
  - Runs the keepalive/session concurrency probe.
- `puppeteer-login/gmail-oauth-init.js`
  - Initializes Gmail read-only OAuth credentials for OTP polling.
- `puppeteer-login/gmail-otp-to-file.js`
  - Polls Gmail for a 6-digit OTP and writes the existing `OTP_CODE_FILE` contract.

## Shared Helpers

- `lib/helpers.js`
- `lib/runtime-target-config.js`
- `lib/cdp-screenshot-capture.js`

These remain because current core modules and tests still import them. They should move into
`src/core/browserless` or `src/core/utils` during the TypeScript/class-structure refactor.
