# LoginRun Codegen Report

## Summary

Mock discovery completed with status `ready` for the HealthEquity sample.

Codegen selected one high-confidence identifier field and one plausible submit control from bundled redacted artifacts. No credentials, OTP codes, Browserless configuration, or LoginRun API calls were used.

## Detected Workflow Surface

- Login URL: `https://my.healthequity.com/ClientLogin.aspx`
- Stage: `identifier`
- Selected identifier: username field
- Selected submit: continue button

## Selected Candidates

Identifier field:

```json
{
  "semanticRole": "identifier",
  "selector": "#ctl00_modulePageContent_txtUserIdStandard",
  "confidence": 0.94,
  "evidence": [
    "associated label includes username",
    "visible enabled text input",
    "inside login form context"
  ],
  "penalties": []
}
```

Submit control:

```json
{
  "semanticRole": "primary_submit",
  "selector": "#ctl00_modulePageContent_btnSubmitUsername",
  "confidence": 0.91,
  "evidence": [
    "button text includes continue",
    "visible enabled submit-like control",
    "follows selected identifier in DOM order"
  ],
  "penalties": []
}
```

## Generated Tests

The generated fixture test asserts that:

- the site profile uses the expected HealthEquity login URL
- discovery status is `ready`
- identifier and submit candidates exceed the confidence threshold
- generated fixtures do not contain credential values

## Runtime Loop Mapping

The future live runner will keep browser actions deterministic:

```text
Browser Runtime -> Runtime Inventory -> Candidate Identifier -> Page / Stage Classifier -> State Machine -> Action Planner -> Action Executor -> Page Stability / Redirect Wait
```

The coding agent operates outside that runtime loop. It reads artifacts, reasons about failures, patches profiles or generic workflow logic, runs tests, and reruns discovery.

## Future Live Commands

```bash
npx @loginrun/codegen discovery --profile ./loginrun/healthequity/login-site.json
npx @loginrun/codegen e2e --profile ./loginrun/healthequity/login-site.json
```
