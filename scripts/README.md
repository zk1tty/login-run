# Script Index

Current scripts are Puppeteer login operations, Gmail OTP helpers, and the agent-browser CDP probe.

## Puppeteer Login

- `puppeteer-login/keepalive-probe.js`
  - Runs one Browserless Session API Puppeteer login probe.
- `puppeteer-login/keepalive-concurrency-probe.js`
  - Runs the keepalive/session concurrency probe.
- `puppeteer-login/gmail-oauth-init.js`
  - Initializes Gmail read-only OAuth credentials for OTP polling.
- `puppeteer-login/gmail-otp-to-file.js`
  - Polls Gmail for a 6-digit OTP and writes the existing `OTP_CODE_FILE` contract.

## agent-browser CDP probe

`agent-browser/cdp-probe.js` resolves a CDP endpoint from the configured browser provider
(`src/core/provider`, default `browserless`) and checks that the `agent-browser` CLI can
connect, open a page, snapshot and screenshot it.

| npm script | What it does |
|---|---|
| `bun run ab` | Generic entry point; pass flags after `--` |
| `bun run ab:ws` | `--mode ws`: connect straight to the provider WS route (Browserless `/stealth` when the `BL_PROXY` profile sets it). Stateless: browser dies with the connection |
| `bun run ab:session` | `--mode session`: create a provider session, write `checkpoint.private.json`, do not attach |
| `bun run ab:reconnect` | `--reconnect`: attach agent-browser to the latest checkpoint's session |

Both `ab:ws` and `ab:session` target the same mock form so results are comparable. Switching
provider (e.g. a future Kernel implementation) is `BROWSER_PROVIDER=<name>`.

## Shared Helpers

- `lib/helpers.js`
- `lib/runtime-target-config.js`
- `lib/cdp-screenshot-capture.js`

These remain because current core modules and tests still import them. They should move into
`src/core/browserless` or `src/core/utils` during the TypeScript/class-structure refactor.
