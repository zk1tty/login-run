# Deterministic Login Agent Architecture

## Goal

Build a website-agnostic login workflow runner for captcha studies.

The runner targets common user login flows:
- identifier input (`email`, `username`, `user id`, `member id`, `login id`)
- password input
- OTP delivery selection
- OTP code input
- captcha/challenge observation

It should not depend on AgentQL prompts or site-specific selectors. When the runner cannot choose a target with high confidence, it must stop and log diagnostics instead of guessing.

## Architecture Model

The deterministic login agent is a page-classification-driven state machine.

Each loop:

```text
collect page inventory
  -> classify the current auth page class
  -> validate the transition against the login workflow state machine
  -> plan one deterministic action or terminal outcome
  -> execute the action
  -> wait for transition
  -> reclassify
```

The parts must stay separate:

- Page classification decides what kind of page is currently visible.
- The state machine decides which transitions and terminal outcomes are allowed.
- The action planner chooses exactly one deterministic next action.
- The executor only performs the planned browser primitive and does not choose targets.

This separation keeps failures explainable. A failed run should make it clear whether classification was wrong, transition policy was incomplete, planning selected the wrong candidate, or execution failed.

The state model in this document is the initial login workflow model. It is informed by HealthEquity/Auth0 observations, but it should not become HealthEquity-specific. Webpage-agnostic behavior comes from collecting evidence across more websites and keeping site differences in workflow profiles, concept clusters, and validation data instead of hard-coded selectors.

Initial workflow profile boundaries:

```text
generic engine:
  inventory
  candidate scoring
  page classification
  state machine
  action planner
  executor
  artifact logging

workflow profile:
  login concept clusters
  allowed auth states
  OTP delivery preferences
  authed markers
  post-auth workflow id
```

## Connection Contract

The login runner must use the same Browserless connection shape as `captcha-mode-compare.js` auto mode:

```text
getCdpEndpoint()
  -> apply CAPTCHA_TEST_ROUTE
  -> set solveCaptchas=true
  -> chromium.connectOverCDP(endpoint)
  -> use first existing context/page, otherwise create one
  -> use context.newCDPSession(page) for Browserless captcha events
```

This keeps landing-page captcha tests and full-login captcha tests comparable.

## Control 3 Separation Path

Control 3 needs a stronger separation than the current Playwright runner.

Reason:
- Controls 1 and 2 only test persisted disk state via `session.connect`
- Control 3 needs the live browser process to remain alive across detach/reconnect
- Browserless documents that `processKeepAlive` depends on Puppeteer
  `browser.disconnect()`, which Playwright does not expose

The implementation should split by runtime ownership, not by login step:

```text
shared login-agent modules:
  runtime inventory
  page classification
  action planning
  OTP wait
  post-auth observation
  artifact logging

playwright runtime path:
  current login-workflow-runner
  direct_auto
  persistent_session
  session_resume
  disk-state reuse only

puppeteer runtime path:
  processKeepAlive session runtime
  browser.disconnect() detach
  reconnect within live-process window
  Control 3 probe runner
```

Recommended implementation path:

1. Add a dedicated Puppeteer session runtime class/module.
   - owns `puppeteer.connect()`
   - owns page selection
   - owns CDP session creation
   - owns `browser.disconnect()`
2. Keep the current Playwright workflow runner unchanged.
3. Extract runtime-agnostic login workflow services as needed.
4. Add a Puppeteer Control 3 probe runner on top of the new runtime class.
5. Compare:
   - same `session.connect` without live process
   - same `session.connect` with `processKeepAlive`

Step 1 in this path is the boundary module only. It should not yet rewrite the
current Playwright execution.

## Runtime Loop

```text
direct CDP auto connection
  -> navigate to URL
  -> capture screenshot
  -> collect runtime inventory
  -> collect static inventory
  -> merge + score candidates
  -> classify stage
  -> execute one deterministic action
  -> wait for transition
  -> repeat
```

Terminal states:
- `captcha`
- `need_otp`
- `authed`
- `blocked_or_unknown`
- `max_steps_reached`

`need_otp` is not a page class. It is a terminal pause outcome emitted when the current page requires end-user OTP input or after the agent has requested OTP delivery. The detected page class should be `otp_delivery_selection` or `otp_code`; the runner outcome should be `need_otp` when it must pause for the user.

## Runtime-Only First Action Flow

Before Cheerio static inventory and semantic scoring are added, the first implementation step should use runtime inventory only. This keeps the test small and lets us measure how far rendered DOM facts can take us.

```text
navigate
capture
runtime inventory
classify
if stage=identifier and LOGIN_USERNAME exists:
  execute identifier action
  capture
  runtime inventory
  classify
observe captcha
final inventory
```

The first action should only cover `identifier`. Do not add password, OTP, or generic fallback execution until the identifier transition is measured.

## Inventory Split

### Browser Runtime Inventory

Collected from the live page with browser APIs.

Purpose:
- facts that require rendering/runtime state
- interaction safety checks
- transition observation

Fields:
- visibility
- enabled/disabled
- focusable
- bounding box
- active element
- current value length only, not value
- computed role-like metadata
- screenshot path
- captcha DOM signals

### Cheerio Static Inventory

Collected from `await page.content()` and parsed in Node with Cheerio.

Purpose:
- reduce noisy HTML into semantic candidates
- extract label and context relationships
- avoid prompt-based inference

Fields:
- labels
- form nesting
- nearby text
- heading/section context
- placeholder/name/id/autocomplete/aria-label
- button text/value
- stable selector candidates
- normalized candidate list

Cheerio is preferred for structural parsing because it keeps selector/label/text extraction out of large browser-side `evaluate()` blocks.

## Candidate Model

Merged candidates should use a normalized object:

```js
{
  id: "candidate-001",
  kind: "input",
  semanticRole: "identifier",
  selector: "#ctl00_modulePageContent_txtUserIdStandard",
  visible: true,
  enabled: true,
  focusable: true,
  formId: "login-form-or-derived-id",
  confidence: 0.93,
  evidence: [
    "label includes identifier concept: username",
    "visible enabled text input",
    "inside form with login context",
    "near primary submit control"
  ],
  penalties: []
}
```

Credential values must never be stored in candidate artifacts. Log only typed length or value presence.

## Semantic Cluster Scoring

Candidate scoring belongs in a dedicated module, not in the runner script.

Proposed location:

```text
src/core/workflow/candidate-scorer.js
```

The scorer takes merged runtime/static candidates and assigns semantic roles:
- `identifier`
- `password`
- `primary_submit`
- `otp_code`
- `otp_delivery_option`
- `captcha`
- `unknown`

Identifier scoring should use semantic clusters instead of exact user-input names. For example, the caller may pass `LOGIN_USERNAME` with an email address, but the target website may label the field `Username`. Both should map to the same `identifier` role.

The semantic cluster is only the vocabulary for a concept. The actual score should combine:
- concept-cluster matches
- field attributes such as `label`, `aria-label`, `placeholder`, `name`, `id`, and `autocomplete`
- nearby text
- form and heading context
- runtime facts such as visibility, enabled state, field type, and DOM order

This keeps the scorer from degrading into raw keyword matching.

Identifier concept cluster:

```text
email
username
user name
user id
userid
login
login id
member id
member number
account id
account number
identifier
```

Score sources:
- associated label text
- `aria-label`
- placeholder
- `name`
- `id`
- `autocomplete`
- nearby text
- form heading/context
- field type
- field order
- relation to visible submit/continue control

Example scoring rules:

```text
+40 associated label matches identifier cluster
+30 aria-label or placeholder matches identifier cluster
+20 name/id/autocomplete matches identifier cluster
+15 nearby text matches identifier cluster
+10 first visible text/email input in login-like form
+10 near primary submit/continue button
+20 input type=email
+10 input type=text
-100 hidden or invisible
-80 disabled
-50 password input
-30 search/tel/date/file/checkbox/radio input
```

The exact weights can change, but every score should emit evidence and penalties. This lets failed runs show why a field was selected or rejected.

The same scoring pattern can be reused for other workflows, but the semantic roles must change with the workflow. That means each workflow should define its own candidate roles and concept clusters. For login workflows, the baseline roles are:

```text
identifier
password
primary_submit
otp_code
otp_delivery_option
captcha
```

For a different workflow, such as checkout or billing, the engine can stay the same while the concept clusters change. The reusable part is the scoring pipeline, not one universal vocabulary.

Password scoring is simpler:

```text
+80 input type=password
+30 label/name/id/placeholder includes password/passcode/pin
-100 hidden or invisible
-80 disabled
```

OTP code scoring:

```text
+50 label/nearby text includes verification code/security code/one-time code/otp/passcode
+20 inputmode=numeric or autocomplete=one-time-code
+10 short text/tel/number input in OTP stage
-50 password field unless page context says passcode
```

Primary submit scoring:

```text
+40 text/value includes continue/next/sign in/log in/submit/verify
+20 associated with same form as selected input
+15 follows selected input in DOM order
+10 visible button/input[type=submit]/role=button
-100 hidden or invisible
-80 disabled before input is filled
```

Disabled submit controls should not be clicked. The executor should fill the field, wait for enablement, then re-score or click the now-enabled primary submit.

## Stage Classifier

Proposed location:

```text
src/core/workflow/stage-classifier.js
```

Inputs:
- merged candidates
- page title/url
- captcha signals
- form/page text signals
- previous action/result

Stages:

```text
captcha
identifier
id+pw
password
otp_delivery_selection
otp_code
authed
blocked_or_unknown
```

Rules:
- Captcha markers win over login stages.
- Visible identifier and password candidates on the same page can mean `id+pw`.
- Visible password candidate means `password`.
- Visible OTP code candidate means `otp_code`.
- Visible identifier candidate without password means `identifier`.
- OTP delivery options without code input means `otp_delivery_selection`.
- Strong authenticated markers mean `authed`.
- No confident candidate means `blocked_or_unknown`.

The classifier should not return `need_otp`. It should return the observed page class. `need_otp` is produced later by the state machine/planner when the only safe next step requires human input.

The initial stages above cover the HealthEquity/Auth0-shaped flow:

```text
identifier -> password -> otp_delivery_selection -> otp_code -> authed
```

Other websites may require additional page classes, such as passwordless OTP, account chooser, authenticator app code, security questions, consent interstitials, SAML/IdP redirects, or already-authenticated sessions. Those should be added from multi-site evidence, not guessed into the first implementation.

## Action Planner

Proposed location:

```text
src/core/workflow/action-planner.js
```

The planner chooses one next action only:

```text
identifier -> fill LOGIN_USERNAME, wait for primary submit to enable, submit
id+pw -> fill missing identifier/password fields, submit only after required fields are present
password -> fill LOGIN_PASSWORD, submit
otp_code -> if OTP_CODE exists, fill and submit; otherwise stop need_otp
otp_delivery_selection -> click configured delivery option, then stop need_otp
captcha -> wait/observe auto-solve
authed -> stop auth success
blocked_or_unknown -> stop with diagnostics
```

No fallback path should exist initially. Low confidence is a stop condition.

OTP handling is intentionally split into two phases:

```text
phase 1:
  credentials/captcha
    -> otp_delivery_selection or otp_code
    -> request delivery if configured
    -> terminal outcome need_otp

phase 2:
  resume same browser session with OTP_CODE
    -> fill otp_code
    -> submit verification
    -> wait for redirect
    -> classify authed or blocked_or_unknown
```

The runner must not log credential or OTP values. It may log value presence and typed length.

## Submit Target Rule

Every input action needs an associated submit target resolution step.

For `identifier`, `password`, and `otp_code`, the planner should return both:
- the selected input target
- the selected submit target, or an explicit `press_enter` fallback reason

Submit target candidates:
- `button`
- `input[type=submit]`
- `input[type=button]`
- `[role=button]`

Initial runtime-only rule:
- prefer a visible submit-like candidate after the input in DOM order
- prefer same-form candidates when form data is available
- do not click disabled controls
- after filling the input, re-check or wait for the submit target to become enabled
- if no enabled submit target appears, press Enter on the input and log that choice

For the HealthEquity landing page, this should map:
- input target: `#ctl00_modulePageContent_txtUserIdStandard`
- submit target: `#ctl00_modulePageContent_btnSubmitUsername`

## Executor

Proposed location:

```text
src/core/workflow/action-executor.js
```

Allowed browser primitives:
- focus
- fill/type
- click
- press Enter
- wait for selector/state
- wait for navigation/network idle as best effort

The executor should never choose targets. It only executes a plan that already names a selected candidate and selector.

## Post-Auth Workflow Boundary

The login agent ends at `authed`. Site-specific work should run through a post-auth workflow dispatcher after authentication succeeds.

```text
deterministic login agent
  -> terminal outcome authed
  -> post-auth workflow dispatcher
  -> selected workflow, for example hsa_balance_export
```

For HealthEquity/HSA, balance export, personal account navigation, and DOM extraction belong in the post-auth workflow. They should not be embedded in the generic login state machine.

## Proposed File Structure

Core, reusable logic:

```text
src/core/workflow/
  runtime-inventory.js
  static-inventory.js
  candidate-normalizer.js
  candidate-scorer.js
  stage-classifier.js
  action-planner.js
  action-executor.js
  artifact-writer.js
  index.js
```

Script wrapper:

```text
scripts/puppeteer-login/keepalive-probe.js
```

The script should remain thin:
- read env
- create direct CDP auto connection
- create artifact directory
- call `runDeterministicLoginAgent(...)`
- print summary paths

Artifact output:

```text
.log/<cid>/direct-login-captcha-resolver/<runTag>/
  summary.json
  events.jsonl
  inventories/
    0001-runtime.json
    0001-static.json
    0001-candidates.json
    0002-runtime.json
    0002-static.json
    0002-candidates.json
  screenshots/
    0001-landing.png
    0002-after-identifier.png
```

## Decision Logging

Every step should log:
- current stage
- selected candidate
- confidence
- evidence
- rejected top candidates
- planned action
- action result
- screenshot path
- captcha state

Example:

```json
{
  "stage": "identifier",
  "selectedCandidate": {
    "semanticRole": "identifier",
    "selector": "#ctl00_modulePageContent_txtUserIdStandard",
    "confidence": 0.93,
    "evidence": [
      "label includes identifier concept: username",
      "visible enabled text input"
    ]
  },
  "action": {
    "type": "fill_and_submit",
    "payloadKey": "LOGIN_USERNAME"
  }
}
```

## Semantic Search Staging

The candidate search path should evolve in stages, with deterministic behavior first.

1. Deterministic concept clusters.
   - Keep small generic login concepts such as `submitCredentialForm`, `passwordVisibilityToggle`, `clearInput`, `rememberMe`, and `helpOrFeedback`.
   - Score candidates with text plus DOM semantics, form relationship, layout, and negative concepts.
   - This stays fast, debuggable, and does not require an API.
2. Static inventory with Cheerio.
   - Add nearby text, parent text, sibling text, and form nesting.
   - Use this to improve candidate context without adding inference.
3. Optional local semantic matcher.
   - Use string similarity or embeddings only for ambiguous button text such as "Access account" or "Proceed".
   - Keep deterministic structure signals as the primary evidence.
4. LLM or embedding fallback for analysis mode only.
   - Use failed-run artifacts to propose concept-cluster updates.
   - Do not make this required for default runtime execution.

Submit target selection should not rely on proximity alone. For example, a password visibility toggle next to the password field is closer than a login button, but it is a negative concept for `submitCredentialForm`. A real submit button with text like `Log in` should score higher even when it appears later in DOM order.

## Non-Goals

- No AgentQL prompt dependency.
- No site-specific selector rules.
- No HealthEquity-specific optimization.
- No object detection unless DOM inventory is insufficient and the purpose is clearly defined.
- No blind fallback clicks.
- No credential values in logs.

## Validation Plan

1. Run HealthEquity landing page.
   - Expected first classification: `identifier`.
   - Expected selected input: visible text input labeled `Username`.
   - Expected submit target: visible `Continue` submit control after it becomes enabled.
2. Re-inventory after identifier submission.
   - Expected next state: `password`, `otp_code`, `captcha`, or `blocked_or_unknown`.
3. Run the 10-site set.
   - Compare captcha timing across stages:
     - before identifier submit
     - after identifier submit
     - after password submit
     - OTP stage
4. Inspect blocked runs using inventory and screenshot artifacts.
