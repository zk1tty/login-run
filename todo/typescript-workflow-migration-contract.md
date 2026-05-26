# TypeScript Workflow Migration Contract

## Goal

Migrate the remaining JavaScript login workflow/runtime code to TypeScript without changing login behavior.

The migration should make the resource ownership model explicit:

- `BrowserlessSessionClient` owns Browserless session create/reconnect/stop metadata.
- `PuppeteerRuntime` owns browser/page/CDP lifecycle.
- workflow modules consume typed runtime contracts instead of loose browser/page/session objects.
- API modules consume typed login service contracts and never expose raw Browserless URLs, passwords, or OTP values.

## Why We Keep Two Typechecks During Migration

`bun run typecheck` is the current mixed JS/TS compatibility gate. It proves the repo still compiles with `allowJs: true` while legacy JavaScript is still present.

`bun run typecheck:strict` is the TypeScript-only quality gate. It uses `allowJs: false` and only checks `.ts` files, so newly migrated code must stay strict even while old JS modules are still noisy.

Keep both until the migration is complete. Remove the split only after `src/core`, `src/api`, and relevant tests are TypeScript.

## Ground Rules

- Convert one file, or one tightly coupled pair, per slice.
- Preserve public exports until all importers are migrated.
- Do not change behavior while adding types.
- Prefer explicit interfaces at module boundaries before typing every internal helper.
- Avoid new `any`. If unavoidable, isolate it at an adapter boundary and document why.
- After each slice, run:

```bash
bun run typecheck
bun run typecheck:strict
bun test
```

## File Checklist

### 1. Shared Contracts

- [x] Add `src/core/workflow/types.ts`
  - DOM inventory candidate types
  - workflow stage/classification types
  - planned action types
  - workflow runner result types
- [x] Add `src/core/puppeteer/types.ts`
  - page adapter contract
  - runtime contract
  - locator/action surface used by workflow
- [x] Add `src/core/browserless/types.ts`
  - Browserless session payload
  - normalized session metadata
  - checkpoint-safe session shape

### 2. Browserless Boundary

- [x] Convert `src/core/browserless/browserless-session.js` to TypeScript.
  - Type session API config, payload, normalized response, and stop options.
  - Keep URL redaction behavior unchanged.
- [x] Convert `src/core/browserless/browserless-session-client.js` to TypeScript.
  - Make it the single typed owner of connect/stop/session payloads.
  - Hide raw Browserless internals from higher layers.
- [x] Convert or relocate config loading currently depending on `scripts/lib/runtime-target-config.js`.
  - Runtime code should not depend on `scripts/lib`.

### 3. Puppeteer Runtime Boundary

- [x] Convert `src/core/puppeteer/page-adapter.js` to TypeScript.
  - Type locator methods, fill/click/check/select behavior, and adapter return types.
- [x] Convert `src/core/puppeteer/puppeteer-runtime.js` to TypeScript.
  - Type `connect`, `navigate`, `listPages`, `close`, `disconnect`, and current page metadata methods.
- [x] Convert `src/core/puppeteer/session-runtime.js` to TypeScript.
  - Preserve the compatibility export for `PuppeteerSessionRuntime`.

### 4. Workflow Utility Layer

- [x] Convert `src/core/workflow/page-stability.js` to TypeScript.
  - Type selector input, stability targets, polling options, and result shape.
- [x] Convert `src/core/workflow/runtime-inventory.js` to TypeScript.
  - Type candidate extraction, DOM inventory, challenge snapshot, and classifier outputs.
- [x] Convert `src/core/workflow/captcha-state.js` to TypeScript.
  - Type CAPTCHA state transitions and solve evidence.
- [x] Convert `src/core/workflow/manual-captcha-solver.js` to TypeScript.
  - Type manual solve wait options and outcomes.

### 5. Planner And Executor

- [x] Convert `src/core/workflow/action-planner.js` to TypeScript.
  - Type planner input, candidates, OTP delivery selection, and planned actions.
  - Preserve current action priority and fallback order.
- [x] Convert `src/core/workflow/action-executor.js` to TypeScript.
  - Type executor input, runtime/page adapter contract, action result, and error cases.
  - Preserve current verification behavior after fill/select/check.

### 6. Workflow Runner And Probes

- [x] Convert `src/core/workflow/login-workflow-runner.js` to TypeScript.
  - Consume typed planner/executor/classifier contracts.
  - Keep phase loop and terminal outcome semantics unchanged.
- [x] Convert `src/core/puppeteer/keepalive-probe.js` to TypeScript.
  - Keep public method stable: `run(input)`.
  - Replace loose session/runtime helper dependencies with typed wrappers.
- [x] Convert `src/core/puppeteer/keepalive-concurrency-probe.js` to TypeScript.
  - Consume the same typed `BrowserlessSessionClient` and `PuppeteerRuntime` wrappers.

### 7. API Boundary

- [ ] Convert `src/core/run/login-run-service.js` to TypeScript.
  - Use `LoginRun`, `LoginRunService`, `StartLoginRequest`, and `SubmitOtpRequest` contracts directly.
- [ ] Convert `src/api/routes/login-routes.js` to TypeScript.
  - Type Fastify params/body/reply handlers.
  - Keep SSE events and response payloads unchanged.
- [ ] Convert `src/api/app.js` and `src/api/server.js` to TypeScript if the runtime/build decision supports it.

### 8. Tests

- [ ] Convert tests only after the implementation module they cover is TypeScript.
- [ ] Keep fake-probe tests for API/service behavior.
- [ ] Keep Puppeteer probe tests as core behavior coverage.
- [ ] Add no Browserless live dependency to unit tests.

## Runtime Decision

Before converting server entrypoints, decide how TypeScript runs in production:

- compile with `tsc` to `dist` and run Node from compiled JS, or
- run TypeScript directly with Bun.

Until this is decided, keep JS compatibility entrypoints where needed.

## Completion Criteria

- [ ] No JavaScript files remain under `src/core/workflow`.
- [ ] Browserless and Puppeteer runtime boundaries are typed classes.
- [ ] API routes depend on typed login service contracts.
- [ ] `bun run typecheck` passes.
- [ ] `bun run typecheck:strict` passes.
- [ ] `bun test` passes.
- [ ] `allowJs` can be set to `false` in the main `tsconfig.json`.
