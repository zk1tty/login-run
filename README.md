# Browserless + Playwright Sandbox

This folder is a minimal local testbed for connecting Playwright to a Browserless Docker container.

Internal architecture notes live under `docs/`.

Useful notes:

- `docs/browser-profile-architecture.md`
- `docs/live-session-ownership-and-tabs.md`
- `docs/gap-vs-browserless-paid-session-api.md`
- `docs/api-endpoint-v1.md`

## Endpoints

TinyFish-style mental model:
- `cdp_url` -> Browserless CDP websocket: `ws://127.0.0.1:3001/chromium`
- remote Playwright socket -> Browserless Playwright websocket: `ws://127.0.0.1:3001/chromium/playwright`

## Files

- `build-auth-from-profile.js`: Launch a local persistent Chromium profile from `.pw-user-data` and export auth artifacts into `.auth`
- `connect-cdp.js`: Connect with `chromium.connectOverCDP(...)`
- `connect-playwright.js`: Connect with `chromium.connect(...)`
- `export-storage-state.js`: Connect with CDP and save remote auth artifacts locally
- `login-agentql.js`: Open `LOGIN_URL`, find the login inputs with AgentQL prompts, and submit credentials from `.env`
- `watch-session.js`: Read Browserless `/sessions` + `/json/list` and print browser-openable DevTools URLs
- `live-url.js`: Open a Browserless LiveURL session from a CDP-connected page

## Setup

```bash
cp .env.example .env
npm install
```

If your Browserless container requires a token, set `BROWSERLESS_TOKEN` in `.env`.
`BROWSERLESS_TIMEOUT_SECONDS` and `BROWSERLESS_TIMEOUT_MS` are passed through directly to Browserless `timeout=...`; use whichever matches your deployment semantics.
For Browserless cloud LiveURL, CDP now defaults to the root route (`/`) on `*.browserless.io`. Override with `BROWSERLESS_CDP_PATH` if needed (`/chromium` for local docker, empty for cloud root).

### Target Profiles (`local`, `cloud`, `cloud_stealth`, `cloud_stealth_residential_sticky`, `cloud_unblock`)

To switch all core Browserless connection settings with one value:

- set `BL_PROXY=local`, `cloud`, `cloud_stealth`, `cloud_stealth_residential_sticky`, or `cloud_unblock`
- optional: set `BL_PROXY_CONFIG` to a custom JSON file path

Default config file: `config/browserless-targets.json`

The profile applies:
- `BROWSERLESS_WS_BASE`
- `BROWSERLESS_HTTP_BASE`
- `BROWSERLESS_LOGIN_CONNECT_MODE`
- `BROWSERLESS_CDP_PATH`
- `BROWSERLESS_PROXY`
- `BROWSERLESS_PROXY_COUNTRY`
- `BROWSERLESS_PROXY_CITY`
- `BROWSERLESS_PROXY_STICKY`
- `BROWSERLESS_PROXY_LOCALE_MATCH`
- `BROWSERLESS_PROXY_PRESET`
- `BROWSERLESS_EXTERNAL_PROXY_SERVER`
- `BROWSERLESS_UNBLOCK_PATH`
- `BROWSERLESS_UNBLOCK_PROXY`
- `BROWSERLESS_UNBLOCK_PROXY_COUNTRY`
- `BROWSERLESS_UNBLOCK_PROXY_STICKY`
- `UNBLOCK_TTL_MS`
- `BROWSERLESS_REMOTE_PROFILE_ROOT`
- `BROWSERLESS_TIMEOUT_SECONDS`
- `BROWSERLESS_TIMEOUT_MS`
- `LOGIN_ENABLE_PROMPT_FALLBACKS`
- `LIVE_URL_TIMEOUT_MS`

Quick intent of cloud profiles:
- `cloud`: baseline cloud CDP route (`/`)
- `cloud_stealth`: Browserless stealth CDP route (`/stealth`)
- `cloud_stealth_residential_sticky`: `/stealth` with `proxy=residential&proxyCountry=us&proxySticky=true&proxyLocaleMatch=true`
- `cloud_unblock`: Browserless REST Unblock API route (`/unblock`) for pre-bypass then CDP attach

### A/B Bot Detection Smoke Test

```bash
URL="https://browser-compat.turnstile.workers.dev/" \
BL_PROXY=cloud \
npm run connect:cdp


URL="https://browser-compat.turnstile.workers.dev/" \
BL_PROXY=cloud_unblock \
npm run connect:unblock
```

## Primary Flow

This is the main end-to-end flow for a user-specific remote browser session with human fallback:

1. Run `pnpm run build:auth`
2. The user logs in manually in the local persistent browser
3. Press Enter in the terminal to export fresh auth into `.auth/storage-state.json` and `.auth/cookies.json`
4. Run `SESSION_KEEP_ALIVE_MS=60000 pnpm run connect:cdp`

- `build:auth` captures the user's Browser Profile locally
- `connect:cdp` reuses that auth in the remote Browserless browser
- `watch:session` gives a human an interactive debugger view into the remote browser
- `export:state` persists any new auth state earned during the remote session

## Run

```bash
5. Run `pnpm run watch:session`
6. Open the printed `DevTools URL` and help the user complete OTP or any additional follow-up inside the remote browser if needed
7. If the remote session changed auth state, run `pnpm run export:state` before closing so the refreshed remote cookies and storage are saved locally

Mental model:

- `build:auth` captures the user's Browser Profile locally
- `connect:cdp` reuses that auth in the remote Browserless browser
- `watch:session` gives a human an interactive debugger view into the remote browser
- `export:state` persists any new auth state earned during the remote session

## Run

```bash
npm run build:auth
npm run connect:cdp
npm run connect:cdp
npm run connect:unblock
npm run export:state
npm run login:agentql
npm run login:agentql:initial
npm run login:agentql:recurrent
npm run login:agentql:reuse-live
npm run watch:session
npm run live:url
```

## Expected Result

- `build:auth` reads your local `.pw-user-data` profile and writes:
  - `.auth/storage-state.json`
  - `.auth/cookies.json`
  - it waits for the page to reach a more fully rendered state
  - by default it then waits for you to press Enter in the terminal before exporting and closing
- `connect:cdp` prints page title and URL after connecting to the remote Chromium instance.
- `connect:unblock` calls `/unblock`, requests `browserWSEndpoint`, then attaches via CDP and prints `navigator.webdriver`, title, and URL.
- `connect:cdp` opens `URL` (default `https://example.com`) and keeps it alive for watching if `SESSION_KEEP_ALIVE_MS` is set.
- set `SESSION_KEEP_ALIVE_MS` if you want either connection to stay open long enough to inspect with `watch:session`
- `connect:cdp` will automatically reuse `.auth/storage-state.json` when present.
- `connect:unblock` uses `URL` as the unblock target URL.
- `export:state` writes both `.auth/storage-state.json` and `.auth/cookies.json` from the remote browser.
- `login:agentql` reads `LOGIN_USERNAME` and `LOGIN_PASSWORD` from `.env`, primes `.auth/storage-state.json` when present, uses AgentQL prompts to submit the form, then exports refreshed auth artifacts after handoff.
- `login:agentql:reuse-live` tries four cases in order:
  - attach to an existing live Browserless browser for the same customer profile
  - launch a new browser with the same persisted profile
  - inject the saved auth snapshot
  - fall back to credential login
- `login:agentql:reuse-live` writes:
  - `.log/<customer>/run-summary-reuse-live-session.json`
  - `.log/<customer>/run-events-reuse-live-session.jsonl`
- `watch:session` prints `devtoolsFrontendUrl`, page CDP websocket, and browser CDP websocket for active page sessions.
- `live:url` tries to print a shareable Browserless LiveURL and keeps the browser alive until you stop it.

## AgentQL Login

Minimal login flow using env-backed credentials:

1. Add `AGENTQL_API_KEY`, `LOGIN_URL`, `LOGIN_USERNAME`, and `LOGIN_PASSWORD` to `.env`
2. Add `CUSTOMER_ID` and set `BROWSERLESS_REMOTE_PROFILE_ROOT` or `LOCAL_PROFILE_ROOT` for the customer profile root
3. Use the split customer flows for profile-aware runs:
   - `npm run login:agentql:initial`
   - `npm run login:agentql:recurrent`
   - `npm run login:agentql:reuse-live`
4. Keep `npm run login:agentql` only for the older single-script flow
5. Adjust the prompt env vars if AgentQL needs different wording for the site:
   - `LOGIN_USERNAME_PROMPT`
   - `LOGIN_PASSWORD_PROMPT`
   - `LOGIN_CONTINUE_PROMPT`
   - `LOGIN_SUBMIT_PROMPT`
6. Set one of the explicit authenticated-state signals for recurrent detection when possible:
   - `LOGIN_AUTHENTICATED_URL_MATCH`
   - `LOGIN_AUTHENTICATED_TITLE_MATCH`

Current HealthEquity-style sequence:

1. AgentQL fills the username field and clicks Continue
2. AgentQL waits for the password step, fills the password field, and clicks Continue again
3. The script hands the browser back to you for two-step authentication so you can choose the email validation path and enter the code manually
4. After you finish handoff, the script writes updated `.auth/storage-state.json` and `.auth/cookies.json` for the next run

Useful knobs:

- `BROWSERLESS_LOGIN_CONNECT_MODE=pw` uses the Browserless Playwright websocket
- `BROWSERLESS_LOGIN_CONNECT_MODE=cdp` uses the Browserless CDP websocket
- `BROWSERLESS_CHROMIUM_ARGS=--remote-allow-origins=https://chrome-devtools-frontend.appspot.com` passes custom Chromium launch args when the script launches a fresh Browserless browser
- `SESSION_KEEP_ALIVE_MS=60000` keeps the remote browser open for inspection after submit
- `LOGIN_DEVTOOLS_RESOLVE_ATTEMPTS=20` sets how many times `login:agentql` retries resolving a Browserless-backed DevTools URL
- `LOGIN_DEVTOOLS_RESOLVE_DELAY_MS=500` sets delay between DevTools URL resolution retries
- `LOGIN_HANDOFF_WAIT_FOR_ENTER=true` keeps the session open until you press Enter…2458 chars truncated…ser-data-dir=...`

Important caveat:

- `BROWSERLESS_REMOTE_USER_DATA_DIR` must point to a path that already exists on the Browserless worker or container filesystem.
- This does not upload your local `.pw-user-data` folder into Browserless.
- If you want a local profile copied into remote automation, the practical bridge is exporting `.auth/storage-state.json` locally and then loading that auth state remotely.

## Auth Files

- `.auth/storage-state.json` is the main Playwright auth snapshot.
- It already includes cookies.
- `.auth/cookies.json` is exported as a convenience/debug artifact when you want cookies alone.

Useful bootstrap knobs:

- `AUTH_BOOTSTRAP_READY_SELECTOR`:
  - optional CSS selector that must become visible before export
  - good for pages like LinkedIn where the shell loads early
- `AUTH_BOOTSTRAP_READY_TIMEOUT_MS`:
  - how long to wait for the page-ready checks
- `AUTH_BOOTSTRAP_RENDER_WAIT_MS`:
  - extra settle time after ready checks
- `AUTH_BOOTSTRAP_WAIT_MS`:
  - extra manual wait before close/export if you want to click around or finish auth yourself
- `AUTH_BOOTSTRAP_WAIT_FOR_ENTER`:
  - defaults to `true`
  - keeps the local browser open until you press Enter in the terminal
  - this is the recommended setting for manual login flows like Amazon

## Watching Remote Sessions

For a free/lightweight Browserless-native option, use Browserless session metadata plus the DevTools frontend instead of rrweb:

- in terminal A, run `SESSION_KEEP_ALIVE_MS=60000 npm run connect:cdp`
- in another terminal, run `npm run watch:session`
- open the printed `DevTools URL` in Chrome
- this gives you a lightweight live view and DevTools access to the current remote page

If you see `No active page sessions found`, it usually means there is no live Browserless page at that exact moment. The watcher is passive: it does not start a browser by itself.

If the page sometimes opens and later shows `404`, use a fresh `DevTools URL` from the latest `watch:session` output. The page-level target IDs are per-session and expire when the Browserless page closes.

This Browserless build can also advertise a hosted DevTools URL that points at an ephemeral forwarded localhost port. On this machine that forwarded port is not reachable, so the watcher now builds a hosted Chrome DevTools frontend URL against the direct Browserless websocket on `127.0.0.1:3001/devtools/page/...` and prints Browserless's original advertised URL only for debugging.

Notes:

- This is much lighter than rrweb because you are using Chrome DevTools against the live remote browser.
- Browserless Session Replay is rrweb-based, but that is a separate feature and usually not the lightweight/free choice.

## LiveURL

`npm run live:url` uses the Browserless CDP command `Browserless.liveURL` on the current page.

- default behavior is interactive
- set `LIVE_URL_INTERACTIVE=false` for read-only viewing
- set `LIVE_URL_KEEP_ALIVE_MS=60000` if you want it to auto-close after a minute
- otherwise the script stays open until you press `Ctrl+C`

Useful notes:

- `watch:session` is the best minimal/free path for seeing what is happening in a remote browser
- `live:url` is the better path when you want a real browser tab that a human can click/type into
- if your Browserless build does not expose the `Browserless.liveURL` CDP command, the script will tell you to fall back to `watch:session`

## Live Alias Server to tunnel Browserless LiveURL

`npm run start:live-alias` starts a Fastify server that gives you a stable endpoint and redirects to the latest Browserless LiveURL.

Use case: 

- [ ] Test if we can resolve Cloudflare Challange page via LiveURL
  - [ ] Anti-bot test: List dowqn the Cloudflare challange page
  - [ ] Devide we can resolve the check-box
  - Cloudflare check-box:
- Forward the user credentials(email/password + verification code) from end-users.

Endpoints:

- `GET /health` -> service health payload
- `GET /live/:customerId` -> `302` redirect to live URL when ready, else `202` while refresh is in progress
- `GET /live-status/:customerId` -> current owner/session status including latest `liveURL`, `devtoolsURL`, and page CDP target
- `GET /admin/owners/:customerId` -> owner runtime status
- `POST /admin/owners/:customerId/session` -> create/reuse Browserless Session API handle
- `POST /admin/owners/:customerId/attach` -> attach Puppeteer owner connection
- `POST /admin/owners/:customerId/live-url/refresh` -> mint a fresh LiveURL from current owner page
- `POST /admin/owners/:customerId/detach` -> disconnect owner while keeping remote session alive
- `DELETE /admin/owners/:customerId/session` -> stop remote session and clear persisted handle
- `GET /admin/owners/:customerId/state` -> probe website state (`need_cred`, `need_otp`, `authed`, `challenge`, `reauth`)

Example:

```bash
curl -i "http://127.0.0.1:8787/live/danny"
curl -s "http://127.0.0.1:8787/live-status/danny"
curl -s -X POST "http://127.0.0.1:8787/admin/owners/danny/session"
- refresh execution is serialized internally to avoid env-based Browserless launch races
- the live-alias server always keeps the successful Browserless session open so redirected LiveURL/DevTools targets stay alive
- the server always uses the `post_auth_snapshot_page` phase as the stream source
- each run writes timestamped logs under `.log/<customer>/runs/reuse-live-session/`
- compatibility copies are still updated at:
  - `.log/<customer>/run-summary-reuse-live-session.json`
  - `.log/<customer>/run-events-reuse-live-session.jsonl`

## Browser profile v.s. Auth snapshot(.auth/)

so your auth snapshot keeps:

- cookies: kept in both profile and auth file
- localStorage: kept in both profile and auth file
- IndexedDB: kept in both profile and auth file in your current setup
- cached site data: profile only
- service worker state: profile only
- any device-recognition markers: depends where the site stores them

## ToDos:

- [ ] Polishment
  - 1. Change hte DevTools web host from `https://chrome-devtools-frontend.appspot.com` to our host
  - 2. Why does this weird viewpoint and size?
- any device-recognition markers: depends where the site stores them

## ToDos:

- [ ] Polishment
  - 1. Change hte DevTools web host from `https://chrome-devtools-frontend.appspot.com` to our host
  - 2. Why does this weird viewpoint and size?
  - 3. Which IP address does Browserless access to the page?:104.8.121.17 - regidential address
  - [x] Report for HealthEquity test case.

### nice to have 
- [ ] Make this preview page inside `<iframe>` tag in HTML: 
```html
<iframe
  src={agent.streamingUrl}
  className="h-full w-full"
  title={`${agent.platformName} live view`}
  sandbox="allow-same-origin allow-scripts allow-forms"
/>
```
