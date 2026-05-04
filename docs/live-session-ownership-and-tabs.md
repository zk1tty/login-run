# Session Ownership And Tabs

This note captures the runtime ownership model for the `reuse-live-session` flow and the practical difference between reusing an existing tab versus opening a new one.

## Ownership Model

The clean mental model is:

```text
Node process
  -> websocket client / controller
  -> sends Playwright or CDP commands

Browserless
  -> websocket server
  -> hosts the remote Chromium runtime

Remote Chromium browser process
  -> Browser
    -> BrowserContext
      -> Page / Tab
```

In practical terms:

- Browserless is the server-side runtime manager.
- The remote Chromium process owns the real browser state.
- The Node process does not contain the browser state. It only drives the remote browser over websocket.
- The `BrowserContext` is usually the best unit for "same logged-in environment".
- The `Page` is the closest unit to "same exact live browsing session in the same tab".

## Who Owns What

### Browserless

Browserless owns:

- the websocket endpoint
- browser launch and teardown
- the remote Chromium runtime
- session metadata exposed through `/sessions`

Browserless does not own the site login itself. It only keeps the remote browser alive long enough for the site session to remain usable.

### Remote Chromium Browser Process

The remote Chromium process owns:

- cookies
- localStorage
- IndexedDB
- service workers
- in-memory JavaScript state
- open tabs
- DOM state
- network connections initiated by the page

If the remote browser dies, all page-memory-only state is gone immediately, even if profile-backed state still exists on disk.

### Node Process

The Node process owns:

- the control flow
- strategy decisions
- the current websocket connection
- log writing
- auth export calls

The Node process does not own:

- the browser profile
- cookies in memory
- the page DOM
- the browser tabs themselves

The Node process can keep a live browser session reachable by staying connected and not closing the attached browser.

## Browser, Context, Page

### Browser

`Browser` means the remote Chromium instance we are attached to.

Reusing the same live browser is stronger than launching a fresh browser with the same persisted profile, because the live browser still has memory-only state.

### BrowserContext

`BrowserContext` is the logged-in container shared by tabs in that context.

State commonly shared across tabs in the same context includes:

- cookies
- localStorage
- IndexedDB-backed auth state
- permission grants

If we keep the same browser and same context, a new tab still inherits a lot of useful state.

### Page / Tab

`Page` is the automation object. `Tab` is the browser UI concept.

In this repo, when we call `context.newPage()`, that usually means "open a new tab in the same browser context."

They are often effectively the same thing here, but the names emphasize different viewpoints:

- `Page`: what Playwright controls
- `Tab`: what a human sees in the browser UI

## Existing Tab Vs New Tab

### Best

Best preservation is:

- same browser
- same context
- same page

This keeps:

- cookies
- localStorage
- IndexedDB
- service workers
- same DOM
- same form/input state
- same SPA memory
- same pending requests/websocket connections
- same tab history
- same page-specific anti-bot or challenge progress

This is the closest thing to "the exact same live session."

### Fallback

Fallback preservation is:

- same browser
- same context
- new page

This still keeps:

- cookies
- localStorage
- IndexedDB
- service workers
- profile-backed recognized-device signals

But it does not keep:

- the old DOM tree
- unsaved form state in the old tab
- page JavaScript heap state
- pending XHR/fetch/websocket connections from the old tab
- exact tab history of the old page
- page-memory-only challenge progress

So the fallback is still good, but it is not as pure as reusing the exact tab.

## Why Existing Tab Is Better For Measurement

If our question is:

> Is the same live browsing session still alive?

then reusing the existing tab is the most faithful test.

If we open a new tab, we introduce one extra variable:

- the app may treat a fresh tab load differently from a continuously alive tab

That difference matters for:

- SPAs that keep auth or challenge state in memory
- apps with hidden iframe/bootstrap logic
- anti-bot checks tied to the original page lifecycle

So the preferred order is:

1. same browser + same context + same page
2. same browser + same context + new page
3. new browser + same persisted profile
4. auth snapshot injection
5. credential login

## "New Page" Vs "New Tab"

In everyday use in this repo:

- `new page` usually means `context.newPage()`
- in Chromium UI, that usually appears as `new tab`

So most of the time they mean the same thing here.

The subtle difference is:

- `page` is the Playwright/CDP automation object
- `tab` is the browser UI presentation

A `Page` may also correspond to a popup or separate browser window in some flows, not only a standard tab. That is why the code usually says `page`, while architecture discussions often say `tab`.

## Current Repo Direction

For attach-mode reuse, the repo should prefer:

1. reusing an existing HealthEquity page when one already exists
2. opening a new page only when no suitable existing page is available

That gives us:

- the cleanest measurement of same-session longevity
- the strongest preservation of live in-memory state
- a controlled fallback when no reusable page exists
