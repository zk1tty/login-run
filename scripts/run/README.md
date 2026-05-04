# Script Workflow Index

This tree is organized by:

1. Instance type (`local-browserless`, `session-api`)
2. Target URL scope (`any-url`, `hsa-workflow`)
3. Use case (the script filename)

## Implemented today

- `local-browserless/any-url`
  - `connect-cdp.js`
  - `live-url.js`
  - `watch-session.js`
  - `session-reuse-check.js`
- `session-api/any-url`
  - `connect-unblock.js`
  - `challenge-study.js`
  - `challenge-study-report.js`
- `session-api/hsa-workflow`
  - `phase1-auth.sh`
  - `phase2-auth.sh`

## Legacy

AgentQL-based flows are under `scripts/legacy/agentql`.
