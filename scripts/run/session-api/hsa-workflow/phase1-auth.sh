#!/usr/bin/env bash
set -euo pipefail

if ! command -v jq >/dev/null 2>&1; then
  echo "jq is required."
  exit 1
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is required."
  exit 1
fi

BASE="${BASE:-http://127.0.0.1:8787}"
CID="${CID:-danny}"
EMAIL="${EMAIL:-}"
PASSWORD="${PASSWORD:-}"
SELECTION="${SELECTION:-email}"
MAX_CRED_STEPS="${MAX_CRED_STEPS:-20}"
MAX_OTP_STEPS="${MAX_OTP_STEPS:-20}"
SKIP_RESET="${SKIP_RESET:-false}"
FORCE_NEW_SESSION="${FORCE_NEW_SESSION:-true}"

if [[ -z "${EMAIL}" || -z "${PASSWORD}" ]]; then
  cat <<'USAGE'
Missing EMAIL/PASSWORD.

Usage:
  BASE=http://127.0.0.1:8787 \
  CID=danny \
  EMAIL="user@example.com" \
  PASSWORD="secret" \
  SELECTION="email" \
  bash scripts/run/session-api/hsa-workflow/phase1-auth.sh

Optional:
  ADMIN_API_KEY=<key>
  SKIP_RESET=true
  FORCE_NEW_SESSION=true
  MAX_CRED_STEPS=20
  MAX_OTP_STEPS=20
USAGE
  exit 1
fi

now_ms() {
  node -e 'process.stdout.write(String(Date.now()))'
}

to_bool() {
  case "$(printf '%s' "${1:-}" | tr '[:upper:]' '[:lower:]')" in
    1|true|yes|on) printf 'true' ;;
    *) printf 'false' ;;
  esac
}

TS="$(date -u +"%Y-%m-%dT%H-%M-%SZ")"
RUN_DIR=".log/${CID}/runs/step-auth/${TS}"
FILE_LOGS_ENABLED="true"

if ! mkdir -p "${RUN_DIR}" 2>/dev/null; then
  FALLBACK_RUN_DIR="/tmp/browserless-step-auth/${CID}/${TS}"
  if mkdir -p "${FALLBACK_RUN_DIR}" 2>/dev/null; then
    RUN_DIR="${FALLBACK_RUN_DIR}"
  else
    FILE_LOGS_ENABLED="false"
    RUN_DIR=""
  fi
fi

if [[ "${FILE_LOGS_ENABLED}" == "true" ]]; then
  echo "Run directory: ${RUN_DIR}"
else
  echo "Run directory: disabled (failed to create log directory; likely disk full)"
fi

TIMINGS_FILE=""
if [[ "${FILE_LOGS_ENABLED}" == "true" ]]; then
  TIMINGS_FILE="${RUN_DIR}/phase1-timings.ndjson"
  : > "${TIMINGS_FILE}"
fi

declare -a CURL_HEADERS
CURL_HEADERS=(-H "content-type: application/json")
if [[ -n "${ADMIN_API_KEY:-}" ]]; then
  CURL_HEADERS+=(-H "x-admin-api-key: ${ADMIN_API_KEY}")
fi

LAST_DURATION_MS=0

post_json_timed() {
  local path="$1"
  local body="$2"
  local started_ms ended_ms response
  started_ms="$(now_ms)"
  response="$(curl -sS -X POST "${BASE}${path}" "${CURL_HEADERS[@]}" -d "${body}")"
  ended_ms="$(now_ms)"
  LAST_DURATION_MS=$((ended_ms - started_ms))
  printf '%s' "${response}"
}

post_empty_timed() {
  local path="$1"
  local started_ms ended_ms response
  started_ms="$(now_ms)"
  response="$(curl -sS -X POST "${BASE}${path}" "${CURL_HEADERS[@]}")"
  ended_ms="$(now_ms)"
  LAST_DURATION_MS=$((ended_ms - started_ms))
  printf '%s' "${response}"
}

append_timing() {
  local kind="$1"
  local macro="$2"
  local idx="$3"
  local step_id="$4"
  local status="$5"
  local duration_ms="$6"

  if [[ "${FILE_LOGS_ENABLED}" != "true" ]]; then
    return 0
  fi

  local row
  row="$(jq -nc \
    --arg phase "phase1" \
    --arg kind "${kind}" \
    --arg macro "${macro}" \
    --argjson index "${idx}" \
    --arg stepId "${step_id}" \
    --arg status "${status}" \
    --argjson durationMs "${duration_ms}" \
    --arg at "$(date -u +"%Y-%m-%dT%H:%M:%SZ")" \
    '{phase:$phase,kind:$kind,macro:$macro,index:$index,stepId:$stepId,status:$status,durationMs:$durationMs,at:$at}')"

  if ! printf '%s\n' "${row}" >> "${TIMINGS_FILE}"; then
    echo "warning: failed to append timing row; disabling file logs for this run." >&2
    FILE_LOGS_ENABLED="false"
  fi
}

extract_top_level_error() {
  local json="$1"
  echo "${json}" | jq -r '
    if (.status | type) == "string" and .status == "error" then
      (.message // "Unknown error")
    else
      ""
    end
  '
}

save_step_response() {
  local prefix="$1"
  local idx="$2"
  local json="$3"

  if [[ "${FILE_LOGS_ENABLED}" != "true" ]]; then
    return 0
  fi

  local file_path="${RUN_DIR}/${prefix}_${idx}.json"
  if ! printf '%s\n' "${json}" > "${file_path}"; then
    echo "warning: failed to write ${file_path}; disabling file logs for this run." >&2
    FILE_LOGS_ENABLED="false"
  fi
}

print_exec() {
  local json="$1"
  if echo "${json}" | jq -e '.execution | type == "object"' >/dev/null 2>&1; then
    echo "${json}" | jq '.execution | {macro,orderIndex,stepId,status,result,nextStepId,done}'
  else
    echo "${json}" | jq '{errorStatus: (.status // null), message: (.message // null)}'
  fi
}

STARTED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
PHASE_BOUNDARY_REACHED="false"
CRED_DONE="false"

if [[ "$(to_bool "${SKIP_RESET}")" == "false" ]]; then
  echo "Resetting cred/otp cursors..."
  post_empty_timed "/admin/owners/${CID}/actions/cred/reset" >/dev/null || true
  append_timing "reset" "cred" 0 "cred.reset" "ok" "${LAST_DURATION_MS}"
  post_empty_timed "/admin/owners/${CID}/actions/otp/reset" >/dev/null || true
  append_timing "reset" "otp" 0 "otp.reset" "ok" "${LAST_DURATION_MS}"
fi

echo "Attaching owner session (forceNewSession=${FORCE_NEW_SESSION})..."
ATTACH_BODY="$(jq -nc --argjson forceNewSession "$(to_bool "${FORCE_NEW_SESSION}")" '{forceNewSession:$forceNewSession}')"
ATTACH_RES="$(post_json_timed "/admin/owners/${CID}/attach" "${ATTACH_BODY}")"
append_timing "attach" "owner" 0 "owner.attach" "ok" "${LAST_DURATION_MS}"
save_step_response "attach" 0 "${ATTACH_RES}"

if echo "${ATTACH_RES}" | jq -e '.status | type == "object"' >/dev/null 2>&1; then
  echo "${ATTACH_RES}" | jq '.status | {status, ownerConnected, sessionId, pageTitle, pageUrl, lastError}'
else
  echo "${ATTACH_RES}" | jq '{errorStatus: (.status // null), message: (.message // null)}'
  exit 2
fi

echo
echo "Phase 1-A: run all cred steps"
for ((i = 0; i < MAX_CRED_STEPS; i++)); do
  CRED_BODY="$(jq -nc --arg email "${EMAIL}" --arg password "${PASSWORD}" '{email:$email,password:$password}')"
  RES="$(post_json_timed "/admin/owners/${CID}/actions/cred" "${CRED_BODY}")"

  STATUS="$(echo "${RES}" | jq -r '.execution.status // "unknown"')"
  STEP_ID="$(echo "${RES}" | jq -r '.execution.stepId // ""')"
  DONE="$(echo "${RES}" | jq -r '.execution.done // false')"
  ERROR_CODE="$(echo "${RES}" | jq -r '.execution.result.errorCode // ""')"

  append_timing "step" "cred" "${i}" "${STEP_ID:-cred.unknown}" "${STATUS}" "${LAST_DURATION_MS}"
  save_step_response "cred" "${i}" "${RES}"
  print_exec "${RES}"

  TOP_ERROR="$(extract_top_level_error "${RES}")"
  if [[ -n "${TOP_ERROR}" ]]; then
    echo "cred endpoint error: ${TOP_ERROR}"
    exit 2
  fi

  if [[ "${DONE}" == "true" ]]; then
    CRED_DONE="true"
    break
  fi

  if [[ "${STATUS}" == "failed" ]]; then
    echo "cred failed at step=${STEP_ID} error=${ERROR_CODE}"
    exit 2
  fi
done

if [[ "${CRED_DONE}" != "true" ]]; then
  echo "cred did not finish within MAX_CRED_STEPS=${MAX_CRED_STEPS}"
  exit 3
fi

echo
echo "Phase 1-B: run OTP until otp.send_code.click is completed"
for ((i = 0; i < MAX_OTP_STEPS; i++)); do
  OTP_BODY="$(jq -nc --arg selection "${SELECTION}" '{selection:$selection}')"
  RES="$(post_json_timed "/admin/owners/${CID}/actions/otp" "${OTP_BODY}")"

  STATUS="$(echo "${RES}" | jq -r '.execution.status // "unknown"')"
  STEP_ID="$(echo "${RES}" | jq -r '.execution.stepId // ""')"
  DONE="$(echo "${RES}" | jq -r '.execution.done // false')"
  ERROR_CODE="$(echo "${RES}" | jq -r '.execution.result.errorCode // ""')"

  append_timing "step" "otp" "${i}" "${STEP_ID:-otp.unknown}" "${STATUS}" "${LAST_DURATION_MS}"
  save_step_response "otp" "${i}" "${RES}"
  print_exec "${RES}"

  TOP_ERROR="$(extract_top_level_error "${RES}")"
  if [[ -n "${TOP_ERROR}" ]]; then
    echo "otp endpoint error: ${TOP_ERROR}"
    exit 4
  fi

  if [[ "${STATUS}" == "ok" && "${STEP_ID}" == "otp.send_code.click" ]]; then
    PHASE_BOUNDARY_REACHED="true"
    echo "Phase 1 boundary reached at otp.send_code.click."
    break
  fi

  if [[ "${STEP_ID}" == "otp.code.focus" || "${STEP_ID}" == "otp.code.type" ]]; then
    PHASE_BOUNDARY_REACHED="true"
    echo "Phase 1 boundary already passed (current step=${STEP_ID})."
    break
  fi

  if [[ "${DONE}" == "true" ]]; then
    PHASE_BOUNDARY_REACHED="true"
    echo "otp macro already completed."
    break
  fi

  if [[ "${STATUS}" == "failed" ]]; then
    if [[ "${STEP_ID}" == "otp.code.type" && "${ERROR_CODE}" == "missing_payload_value" ]]; then
      PHASE_BOUNDARY_REACHED="true"
      echo "Paused at otp.code.type due to missing OTP code."
      break
    fi

    echo "otp failed at step=${STEP_ID} error=${ERROR_CODE}"
    exit 4
  fi
done

if [[ "${PHASE_BOUNDARY_REACHED}" != "true" ]]; then
  echo "otp did not reach phase-1 boundary within MAX_OTP_STEPS=${MAX_OTP_STEPS}"
  exit 5
fi

FINISHED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

if [[ "${FILE_LOGS_ENABLED}" == "true" ]]; then
  SUMMARY_JSON="$(jq -s \
    --arg customerId "${CID}" \
    --arg runDir "${RUN_DIR}" \
    --arg startedAt "${STARTED_AT}" \
    --arg finishedAt "${FINISHED_AT}" \
    --arg boundaryReached "${PHASE_BOUNDARY_REACHED}" \
    '
    def calls_for($kind; $macro): map(select(.kind == $kind and .macro == $macro));
    def duration_for($kind; $macro): (calls_for($kind; $macro) | map(.durationMs) | add // 0);
    {
      phase: "phase1",
      customerId: $customerId,
      runDir: $runDir,
      startedAt: $startedAt,
      finishedAt: $finishedAt,
      boundaryReached: ($boundaryReached == "true"),
      totalCalls: length,
      totalDurationMs: (map(.durationMs) | add // 0),
      byKind: {
        attach: {
          calls: (calls_for("attach"; "owner") | length),
          durationMs: duration_for("attach"; "owner")
        },
        reset: {
          calls: (map(select(.kind == "reset")) | length),
          durationMs: (map(select(.kind == "reset") | .durationMs) | add // 0)
        },
        cred: {
          calls: (calls_for("step"; "cred") | length),
          durationMs: duration_for("step"; "cred")
        },
        otp: {
          calls: (calls_for("step"; "otp") | length),
          durationMs: duration_for("step"; "otp")
        }
      },
      calls: .
    }
    ' "${TIMINGS_FILE}")"

  printf '%s\n' "${SUMMARY_JSON}" > "${RUN_DIR}/phase1-summary.json"

  echo
  echo "Phase 1 complete."
  echo "Summary:"
  echo "${SUMMARY_JSON}" | jq '{phase, boundaryReached, totalCalls, totalDurationMs, byKind, runDir}'
  echo "Saved summary: ${RUN_DIR}/phase1-summary.json"
  echo "Saved logs: ${RUN_DIR}"
else
  echo "Phase 1 complete."
  echo "Saved logs: disabled for this run (write failures)."
fi

echo
cat <<NEXT_PHASE
Next (Phase 2):

  BASE="${BASE}" CID="${CID}" OTP_CODE="123456" SELECTION="${SELECTION}" bash scripts/run/session-api/hsa-workflow/phase2-auth.sh
NEXT_PHASE
