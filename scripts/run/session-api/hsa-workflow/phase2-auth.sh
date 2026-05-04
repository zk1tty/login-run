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
OTP_CODE="${OTP_CODE:-}"
SELECTION="${SELECTION:-email}"
MAX_OTP_STEPS="${MAX_OTP_STEPS:-20}"
FORCE_NEW_SESSION="${FORCE_NEW_SESSION:-false}"
EXTRACT_MAX_ATTEMPTS="${EXTRACT_MAX_ATTEMPTS:-5}"
EXTRACT_RETRY_MS="${EXTRACT_RETRY_MS:-1500}"
PORTAL_WAIT_MAX_MS="${PORTAL_WAIT_MAX_MS:-45000}"
PORTAL_WAIT_POLL_MS="${PORTAL_WAIT_POLL_MS:-1500}"

if [[ -z "${OTP_CODE}" ]]; then
  cat <<'USAGE'
Missing OTP_CODE.

Usage:
  BASE=http://127.0.0.1:8787 \
  CID=danny \
  OTP_CODE="123456" \
  SELECTION="email" \
  bash scripts/run/session-api/hsa-workflow/phase2-auth.sh

Optional:
  ADMIN_API_KEY=<key>
  FORCE_NEW_SESSION=false
  MAX_OTP_STEPS=20
  EXTRACT_MAX_ATTEMPTS=5
  EXTRACT_RETRY_MS=1500
  PORTAL_WAIT_MAX_MS=45000
  PORTAL_WAIT_POLL_MS=1500
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

sleep_ms() {
  local ms="$1"
  local seconds
  seconds="$(awk -v value="${ms}" 'BEGIN { printf "%.3f", value / 1000 }')"
  sleep "${seconds}"
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
  TIMINGS_FILE="${RUN_DIR}/phase2-timings.ndjson"
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

get_json_timed() {
  local path="$1"
  local started_ms ended_ms response
  started_ms="$(now_ms)"
  response="$(curl -sS "${BASE}${path}" "${CURL_HEADERS[@]}")"
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
    --arg phase "phase2" \
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

print_exec() {
  local json="$1"
  if echo "${json}" | jq -e '.execution | type == "object"' >/dev/null 2>&1; then
    echo "${json}" | jq '.execution | {macro,orderIndex,stepId,status,result,nextStepId,done}'
  else
    echo "${json}" | jq '{errorStatus: (.status // null), message: (.message // null)}'
  fi
}

has_hsa_data() {
  local json="$1"
  echo "${json}" | jq -e '(.completeness.nonEmptyFieldCount // 0) > 0' >/dev/null 2>&1
}

is_member_portal_ready() {
  local json="$1"
  echo "${json}" | jq -e '
    if (.status | type) == "string" and .status == "error" then
      false
    else
      (.ownerConnected == true)
      and (.sessionExpired != true)
      and (
        ((.pageUrl // "") | ascii_downcase | test("/member/|membertransactions"))
        or
        ((.pageTitle // "") | ascii_downcase | test("health savings account|account info|dashboard"))
      )
      and (((.pageTitle // "") | ascii_downcase | test("just a moment|checking your browser|verify you are human") | not))
      and (((.pageUrl // "") | ascii_downcase | test("clientlogin\\.aspx|/cdn-cgi/") | not))
    end
  ' >/dev/null 2>&1
}

STARTED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"
OTP_DONE="false"
LAST_OTP_RESPONSE=""


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
echo "Phase 2-A: run remaining OTP steps through otp.confirm.click"
for ((i = 0; i < MAX_OTP_STEPS; i++)); do
  OTP_BODY="$(jq -nc --arg selection "${SELECTION}" --arg code "${OTP_CODE}" '{selection:$selection,code:$code}')"
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
    exit 3
  fi

  LAST_OTP_RESPONSE="${RES}"

  if [[ "${DONE}" == "true" ]]; then
    OTP_DONE="true"
    break
  fi

  if [[ "${STATUS}" == "failed" ]]; then
    echo "otp failed at step=${STEP_ID} error=${ERROR_CODE}"
    exit 3
  fi
done

if [[ "${OTP_DONE}" != "true" ]]; then
  echo "otp did not complete within MAX_OTP_STEPS=${MAX_OTP_STEPS}"
  exit 4
fi

echo
echo "Phase 2-B: extract HSA profile/account from live DOM"
if (( PORTAL_WAIT_MAX_MS > 0 )); then
  echo "Waiting for Member Portal redirect before extraction (max ${PORTAL_WAIT_MAX_MS}ms)..."
  WAIT_START_MS="$(now_ms)"
  WAIT_LAST_STATUS=""
  while true; do
    WAIT_LAST_STATUS="$(get_json_timed "/admin/owners/${CID}")"
    WAIT_ERROR="$(extract_top_level_error "${WAIT_LAST_STATUS}")"

    if [[ -n "${WAIT_ERROR}" ]]; then
      echo "warning: status polling failed while waiting for Member Portal: ${WAIT_ERROR}"
      break
    fi

    WAIT_PAGE_TITLE="$(echo "${WAIT_LAST_STATUS}" | jq -r '.pageTitle // ""')"
    WAIT_PAGE_URL="$(echo "${WAIT_LAST_STATUS}" | jq -r '.pageUrl // ""')"

    if is_member_portal_ready "${WAIT_LAST_STATUS}"; then
      echo "Member Portal detected: ${WAIT_PAGE_TITLE} (${WAIT_PAGE_URL})"
      break
    fi

    NOW_MS="$(now_ms)"
    WAITED_MS=$((NOW_MS - WAIT_START_MS))
    if (( WAITED_MS >= PORTAL_WAIT_MAX_MS )); then
      echo "warning: Member Portal was not detected after ${PORTAL_WAIT_MAX_MS}ms (last title='${WAIT_PAGE_TITLE}' url='${WAIT_PAGE_URL}')."
      echo "continuing with extract retries anyway."
      break
    fi

    sleep_ms "${PORTAL_WAIT_POLL_MS}"
  done
fi

EXTRACT_RESPONSE=""
EXTRACT_DONE="false"
for ((attempt = 1; attempt <= EXTRACT_MAX_ATTEMPTS; attempt++)); do
  RES="$(post_json_timed "/admin/owners/${CID}/extract/hsa" '{}')"
  STATUS="$(echo "${RES}" | jq -r '.status // "ok"')"
  TOP_ERROR="$(extract_top_level_error "${RES}")"
  append_timing "extract" "hsa" "${attempt}" "extract.hsa" "${STATUS}" "${LAST_DURATION_MS}"
  save_step_response "extract_hsa" "${attempt}" "${RES}"

  EXTRACT_RESPONSE="${RES}"

  if [[ -n "${TOP_ERROR}" ]]; then
    echo "warning: extract/hsa attempt ${attempt} failed: ${TOP_ERROR}"
  fi

  if has_hsa_data "${RES}"; then
    EXTRACT_DONE="true"
    break
  fi

  if [[ "${attempt}" -lt "${EXTRACT_MAX_ATTEMPTS}" ]]; then
    sleep_ms "${EXTRACT_RETRY_MS}"
  fi
done

if [[ -z "${EXTRACT_RESPONSE}" ]]; then
  echo "extract endpoint returned no response"
  exit 5
fi

if [[ "${EXTRACT_DONE}" != "true" ]]; then
  echo "warning: extract/hsa returned empty data after ${EXTRACT_MAX_ATTEMPTS} attempts"
fi

FINISHED_AT="$(date -u +"%Y-%m-%dT%H:%M:%SZ")"

if [[ "${FILE_LOGS_ENABLED}" == "true" ]]; then
  printf '%s\n' "${EXTRACT_RESPONSE}" > "${RUN_DIR}/hsa-account.json"

  SUMMARY_JSON="$(jq -s \
    --arg customerId "${CID}" \
    --arg runDir "${RUN_DIR}" \
    --arg startedAt "${STARTED_AT}" \
    --arg finishedAt "${FINISHED_AT}" \
    --arg otpDone "${OTP_DONE}" \
    --arg extractDone "${EXTRACT_DONE}" \
    '
    def calls_for($kind; $macro): map(select(.kind == $kind and .macro == $macro));
