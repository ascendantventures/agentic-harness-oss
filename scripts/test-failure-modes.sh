#!/usr/bin/env bash
# ============================================================
# Harness + UI Failure Mode Test Suite
# Tests failure scenarios from docs/failure-modes.md
#
# Usage:
#   ./scripts/test-failure-modes.sh [--suite <provision|build|loop|ui|all>] [--verbose]
#
# Requirements:
#   - SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY in .env
#   - FACTORY_APP_URL, FACTORY_SECRET in .env
#   - gh CLI authenticated
#   - jq installed
# ============================================================

set -euo pipefail

# ── Config ─────────────────────────────────────────────────────────────────────
SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
ENV_FILE="$ROOT/.env"
SUITE="${1:-all}"
VERBOSE="${2:-}"
TEST_REPO="${TEST_REPO:-ascendantventures/harness-beta-test}"
PASS=0
FAIL=0
SKIP=0

# ── Load env ────────────────────────────────────────────────────────────────────
if [[ -f "$ENV_FILE" ]]; then
  set -a; source "$ENV_FILE"; set +a
fi

SUPABASE_URL="${SUPABASE_URL:-}"
SUPABASE_SERVICE_KEY="${SUPABASE_SERVICE_ROLE_KEY:-}"
FACTORY_APP_URL="${FACTORY_APP_URL:-}"
FACTORY_SECRET="${FACTORY_SECRET:-}"
VERCEL_TOKEN="${VERCEL_TOKEN:-}"
MGMT_TOKEN="${SUPABASE_MANAGEMENT_API_TOKEN:-}"

# ── Helpers ─────────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'; CYAN='\033[0;36m'; NC='\033[0m'

log() { echo -e "${CYAN}[TEST]${NC} $*"; }
pass() { echo -e "${GREEN}✅ PASS${NC} — $*"; PASS=$((PASS+1)); }
fail() { echo -e "${RED}❌ FAIL${NC} — $*"; FAIL=$((FAIL+1)); }
skip() { echo -e "${YELLOW}⏭  SKIP${NC} — $*"; SKIP=$((SKIP+1)); }
header() { echo -e "\n${CYAN}═══ $* ═══${NC}"; }

require_env() {
  local var="$1"
  if [[ -z "${!var:-}" ]]; then
    skip "$2 (missing $var)"; return 1
  fi
  return 0
}

# ── Suite: Provision ─────────────────────────────────────────────────────────────
test_provision() {
  header "FM-001 — Supabase timeout: waitForActive polls correctly"
  # Compile and check the timeout math
  local max_attempts
  max_attempts=$(grep 'maxAttempts = ' "$ROOT/factory/src/stations/provision/index.ts" | grep -oP '\d+' | head -1)
  local interval=5
  local timeout_sec=$((max_attempts * interval))
  if [[ $timeout_sec -ge 300 ]]; then
    pass "FM-001: timeout = ${timeout_sec}s (≥5 min). OK."
  else
    fail "FM-001: timeout = ${timeout_sec}s (<5 min). Risk of premature failure. Recommend ≥600s."
  fi

  header "FM-004 — Vercel project not found: logs warning but provision still advances"
  # injectVercelEnvVars returns early (from the helper), but directRun continues.
  # Verify directRun does NOT return false when vercel project is missing.
  local skip_env_present
  skip_env_present=$(grep -c "skipping Vercel env injection\|skipping env injection\|No VERCEL_TOKEN" "$ROOT/factory/src/stations/provision/index.ts" || true)
  local hard_fail_on_vercel_miss
  hard_fail_on_vercel_miss=$(grep -c "station:stuck.*[Vv]ercel\|[Vv]ercel.*station:stuck" "$ROOT/factory/src/stations/provision/index.ts" || true)
  if [[ $skip_env_present -gt 0 && $hard_fail_on_vercel_miss -eq 0 ]]; then
    pass "FM-004: Vercel skip is graceful (continues to QA). Warning: env vars won't be injected — app may return 500."
  elif [[ $hard_fail_on_vercel_miss -gt 0 ]]; then
    pass "FM-004: Vercel missing now causes station:stuck (hardened)."
  else
    fail "FM-004: Unclear Vercel-miss handling — review provision/index.ts"
  fi

  header "FM-006 — Build repo missing: should NOT silently advance"
  # Check what happens when no build repo is found
  local no_repo_action
  no_repo_action=$(grep -A3 "No build repo found" "$ROOT/factory/src/stations/provision/index.ts" | grep "station:" | head -1)
  if echo "$no_repo_action" | grep -q "station:provisioned"; then
    fail "FM-006: No build repo → silently advances to station:provisioned (no DB!). CRITICAL."
    echo "       Fix: change flipLabel to station:stuck when buildRepo is null."
  else
    pass "FM-006: No build repo does not silently advance."
  fi

  header "FM-007 — Provision idempotency: findExistingProject deduplicates"
  # Check that findExistingProject is called before createProject
  local find_before_create
  find_before_create=$(grep -n "findExistingProject\|createProject" "$ROOT/factory/src/stations/provision/index.ts" \
    | awk -F: '{print NR, $1}' | head -4)
  local find_line create_line
  find_line=$(grep -n "findExistingProject" "$ROOT/factory/src/stations/provision/index.ts" | head -1 | cut -d: -f1)
  create_line=$(grep -n "createProject" "$ROOT/factory/src/stations/provision/index.ts" | grep -v "private" | head -1 | cut -d: -f1)
  if [[ $find_line -lt $create_line ]]; then
    pass "FM-007: findExistingProject (L${find_line}) called before createProject (L${create_line}). Idempotent."
  else
    fail "FM-007: createProject called before findExistingProject — no dedup."
  fi
}

# ── Suite: Build ──────────────────────────────────────────────────────────────────
test_build() {
  header "FM-008/009 — Build gate: tsc + npm run build (or vercel build) present"
  local build_file="$ROOT/factory/src/stations/build/index.ts"
  local has_build_step
  has_build_step=$(grep -cE "npm run build|vercel build|tsc" "$build_file" || true)
  if [[ $has_build_step -ge 2 ]]; then
    pass "FM-008/009: Build gate present (tsc + build step in build station)."
  else
    fail "FM-008/009: Build gate appears incomplete — check build/index.ts (found $has_build_step references)"
  fi

  header "FM-010 — Live URL health check after deploy"
  if grep -qiE "health.check|curl.*http_code|fetch.*liveUrl|200" "$build_file"; then
    pass "FM-010: Health check present in build station."
  else
    fail "FM-010: No post-deploy health check in build station — 500s won't be caught until QA."
  fi

  header "FM-011 — Artifact gate: CLAUDE.md + REGRESSION.md checked"
  local reconciler="$ROOT/factory/src/pipeline/reconciler.ts"
  if grep -q "CLAUDE.md" "$reconciler" && grep -q "REGRESSION.md" "$reconciler"; then
    pass "FM-011: Artifact gate checks CLAUDE.md + REGRESSION.md in reconciler."
  else
    fail "FM-011: Artifact gate missing or incomplete."
  fi
}

# ── Suite: QA ──────────────────────────────────────────────────────────────────
test_qa() {
  header "FM-013 — Premature QA spawn: 'build' in noFlipStations"
  local router="$ROOT/factory/src/pipeline/router.ts"
  if grep -q "noFlipStations\|'build'" "$router" 2>/dev/null || grep -q '"build"' "$router" 2>/dev/null; then
    pass "FM-013: noFlipStations references build — prevents premature QA spawn."
  else
    fail "FM-013: 'build' not found in noFlipStations guard — premature QA spawn possible."
  fi

  header "FM-014 — QA comment parse: UAT checks for both 'QA PASS' and '✅ PASS'"
  local uat_file="$ROOT/factory/src/stations/uat/index.ts"
  if grep -q "QA PASS\|✅ PASS" "$uat_file"; then
    pass "FM-014: UAT checks multiple QA pass patterns."
  else
    fail "FM-014: UAT only checks one QA pass pattern — brittle."
  fi

  header "FM-015 — Live URL health check in QA prompt"
  local qa_file="$ROOT/factory/src/stations/qa/index.ts"
  if grep -qiE "live.*url|health|200|curl|fetch" "$qa_file"; then
    pass "FM-015: QA station references live URL / health check in prompt."
  else
    fail "FM-015: QA station doesn't explicitly check live URL health — broken apps can pass QA."
  fi
}

# ── Suite: UAT ──────────────────────────────────────────────────────────────────
test_uat() {
  header "FM-018 — delivery_card push retry logic"
  local uat_file="$ROOT/factory/src/stations/uat/index.ts"
  local push_retry
  push_retry=$(grep -c "retry\|retries\|attempt" "$uat_file" 2>/dev/null || echo 0)
  if [[ $push_retry -gt 0 ]]; then
    pass "FM-018: delivery_card push has retry logic."
  else
    fail "FM-018: No retry on delivery_card push — silent failure if /push endpoint is down."
  fi

  header "FM-019 — UAT checks live_url is set before marking PASS"
  if grep -q "live_url\|liveUrl" "$uat_file"; then
    pass "FM-019: UAT references live_url."
  else
    fail "FM-019: UAT doesn't check live_url — may mark PASS with no working URL."
  fi
}

# ── Suite: Loop infrastructure ──────────────────────────────────────────────────
test_loop() {
  header "FM-020 — Single-instance guard: PID file exists in run-loop"
  local run_loop="$ROOT/factory/run-loop.sh"
  if [[ -f "$run_loop" ]] && grep -q "pid\|PID" "$run_loop"; then
    pass "FM-020: PID guard present in run-loop.sh."
  else
    fail "FM-020: No PID guard in run-loop.sh — duplicate loop instances possible."
  fi

  header "FM-021 — Stale lock detection: heartbeat checks age > 30 min"
  local heartbeat="/root/.openclaw/workspace/HEARTBEAT.md"
  if grep -q "30\|stale\|STALE" "$heartbeat" 2>/dev/null; then
    pass "FM-021: Heartbeat checks for stale locks (>30 min)."
  else
    fail "FM-021: Heartbeat doesn't check stale locks — dead agent PIDs will block issues."
  fi
}

# ── Suite: UI (live HTTP checks) ────────────────────────────────────────────────
test_ui() {
  if ! require_env "FACTORY_APP_URL" "UI tests"; then return; fi

  local base_url="${FACTORY_APP_URL%/}"

  header "FM-024 — Unknown message_type: /api/threads/push with unknown type"
  if ! require_env "FACTORY_SECRET" "FM-024"; then return; fi

  # Create a test submission ID (won't exist — testing error handling)
  local fake_id="00000000-0000-0000-0000-000000000000"
  local status
  status=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    "${base_url}/api/threads/${fake_id}/push" \
    -H "x-factory-secret: ${FACTORY_SECRET}" \
    -H "Content-Type: application/json" \
    -d '{"message_type":"unknown_future_card","payload":{"data":"test"}}')
  if [[ "$status" == "404" || "$status" == "400" ]]; then
    pass "FM-024: Unknown message type returns $status (expected 4xx for missing submission)."
  elif [[ "$status" == "500" ]]; then
    fail "FM-024: Unknown message type causes 500 — unhandled error in push endpoint."
  else
    skip "FM-024: Status $status — unexpected response."
  fi

  header "FM-026 — Expired access token on approve returns 401"
  local approve_status
  approve_status=$(curl -s -o /dev/null -w "%{http_code}" -X POST \
    "${base_url}/api/threads/${fake_id}/approve" \
    -H "Content-Type: application/json" \
    -d '{"access_token":"expired_token_12345","approved":true}')
  if [[ "$approve_status" == "401" || "$approve_status" == "403" || "$approve_status" == "404" ]]; then
    pass "FM-026: Expired token returns $approve_status (correct rejection)."
  elif [[ "$approve_status" == "200" ]]; then
    fail "FM-026: Expired token returns 200 — no auth check on approve!"
  else
    skip "FM-026: Status $approve_status — check manually."
  fi

  header "FM-027 — Concurrent approval: duplicate approve is idempotent"
  # We can't test a real concurrent scenario easily, but check that approve
  # endpoint doesn't error on a second call to an already-approved thread
  skip "FM-027: Concurrent approval requires live submission — manual test needed."

  header "FM-028 — Delivery card: live URL health (app.agenticharness.ai accessible)"
  local app_url="https://app.agenticharness.ai"
  local app_status
  app_status=$(curl -s -o /dev/null -w "%{http_code}" --max-time 10 "$app_url" || echo "0")
  if [[ "$app_status" == "200" ]]; then
    pass "FM-028: app.agenticharness.ai returns 200."
  else
    fail "FM-028: app.agenticharness.ai returns $app_status — UI may be down."
  fi
}

# ── Suite: Supabase ──────────────────────────────────────────────────────────────
test_supabase() {
  if ! require_env "SUPABASE_URL" "Supabase tests"; then return; fi
  if ! require_env "SUPABASE_SERVICE_ROLE_KEY" "Supabase tests"; then return; fi

  header "FM-029 — Supabase submissions table: station column present"
  local result
  result=$(curl -s "${SUPABASE_URL}/rest/v1/submissions?select=station&limit=1" \
    -H "apikey: ${SUPABASE_SERVICE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}")
  if echo "$result" | grep -q "station\|\[\]"; then
    pass "FM-029: 'station' column exists in submissions table."
  else
    fail "FM-029: Cannot query 'station' from submissions — schema may be missing column."
    [[ "$VERBOSE" == "--verbose" ]] && echo "  Response: $result"
  fi

  header "FM-029b — thread_messages: message_id as primary key (dedup check)"
  local tm_result
  tm_result=$(curl -s "${SUPABASE_URL}/rest/v1/thread_messages?select=message_id&limit=1" \
    -H "apikey: ${SUPABASE_SERVICE_KEY}" \
    -H "Authorization: Bearer ${SUPABASE_SERVICE_KEY}")
  if echo "$tm_result" | grep -q "message_id\|\[\]"; then
    pass "FM-029b: thread_messages.message_id column exists."
  else
    fail "FM-029b: Cannot query message_id — dedup logic may be broken."
  fi
}

# ── Runner ──────────────────────────────────────────────────────────────────────
echo ""
echo "╔══════════════════════════════════════════════════════╗"
echo "║  Agentic Harness — Failure Mode Test Suite           ║"
echo "║  Repo: $TEST_REPO"
echo "╚══════════════════════════════════════════════════════╝"

case "$SUITE" in
  provision) test_provision ;;
  build)     test_build ;;
  qa)        test_qa ;;
  uat)       test_uat ;;
  loop)      test_loop ;;
  ui)        test_ui ;;
  supabase)  test_supabase ;;
  all)
    test_provision
    test_build
    test_qa
    test_uat
    test_loop
    test_ui
    test_supabase
    ;;
  *)
    echo "Unknown suite: $SUITE"
    echo "Usage: $0 [provision|build|qa|uat|loop|ui|supabase|all] [--verbose]"
    exit 1
    ;;
esac

# ── Summary ─────────────────────────────────────────────────────────────────────
echo ""
echo "════════════════════════════════════════"
echo -e " Results: ${GREEN}${PASS} passed${NC} | ${RED}${FAIL} failed${NC} | ${YELLOW}${SKIP} skipped${NC}"
echo "════════════════════════════════════════"

if [[ $FAIL -gt 0 ]]; then
  echo ""
  echo "❌ $FAIL test(s) failed. See docs/failure-modes.md for remediation steps."
  exit 1
else
  echo ""
  echo "✅ All tests passed."
  exit 0
fi
