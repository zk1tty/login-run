# LoginRun Codegen

LoginRun Codegen is the onboarding layer for new login websites. Its job is to generate site profiles, fixture artifacts, and regression tests that make the deterministic LoginRun workflow easier to extend across many websites.

The v1 demo is intentionally standalone. It runs from `npx`, writes local artifacts, and does not require cloning this repository, running the LoginRun API server, configuring Browserless, or providing credentials.

## Architecture

![browser-runtime-loop](./browser-runtime-loop.svg)

## Standalone Demo

```bash
npx @loginrun/codegen demo
```

Defaults:

```text
site: healthequity
output: ./loginrun
mode: mock
```

Generated output:

```text
./loginrun/healthequity/
  login-site.json
  report.md
  README.md
  fixtures/
    landing-runtime-inventory.json
    landing-candidate-scores.json
  tests/
    healthequity.discovery.test.ts
```

The demo uses bundled redacted HealthEquity-style artifacts. It does not submit credentials, request OTP, call `/v1/logins`, or start a browser.

## Generated Profile

`login-site.json` is the site-oriented configuration that will later feed live discovery and e2e runs:

```json
{
  "siteId": "healthequity",
  "loginUrl": "https://my.healthequity.com/ClientLogin.aspx",
  "allowedHosts": ["my.healthequity.com", "member.my.healthequity.com"],
  "credentials": {
    "identifierKind": "username",
    "usernameSecretKey": "LOGIN_USERNAME",
    "passwordSecretKey": "LOGIN_PASSWORD"
  },
  "otp": {
    "required": true,
    "deliveryPreference": "email"
  },
  "authenticatedMarkers": {
    "urlIncludes": ["/Member/MemberHome.aspx"],
    "titleIncludes": ["Member Portal"]
  }
}
```

The profile keeps site-specific facts out of the generic runtime workflow. Selectors can be added later as overrides, but they should stay an escape hatch rather than the default onboarding model.

## ReAct Loop

The coding agent runs outside the browser runtime loop:

```text
run Codegen command
  -> observe report, fixtures, candidate evidence, and failures
  -> reason about the failed actor
  -> patch site profile, generic workflow logic, or tests
  -> rerun discovery/e2e
```

The live browser runtime remains deterministic:

```text
Browser Runtime
  -> Runtime Inventory
  -> Candidate Identifier
  -> Page / Stage Classifier
  -> State Machine
  -> Action Planner
  -> Action Executor
  -> Page Stability / Redirect Wait
```

This split keeps live credential and OTP handling explainable while still letting a coding agent improve onboarding between runs.

## Mock Mode vs Live Modes

V1 demo command:

```bash
npx @loginrun/codegen demo
```

Future live commands shown in generated reports:

```bash
npx @loginrun/codegen discovery --profile ./loginrun/healthequity/login-site.json
npx @loginrun/codegen e2e --profile ./loginrun/healthequity/login-site.json
```

`discovery` will collect runtime/static inventory and score candidates without submitting credentials. `e2e` will run the full login workflow with credentials, OTP, redirect waiting, and authenticated-marker verification.

## Remaining Work Before Live Codegen

- Extract the shared observe/plan/act workflow loop from `PuppeteerKeepAliveProbe` into `login-workflow-engine.ts`.
- Add site profile loading and keep profiles separate from Browserless runtime/proxy config.
- Move HealthEquity-specific authenticated checks out of the generic classifier and into the HealthEquity profile.
- Add `static-inventory.ts` and `candidate-scorer.ts` with confidence, evidence, penalties, and rejected alternatives.
- Add live discovery mode for batch onboarding.
- Add fixture tests from saved redacted inventories before touching live credentials.
- Run HealthEquity plus the next nine target websites through discovery before promoting passing sites to live e2e tests.
