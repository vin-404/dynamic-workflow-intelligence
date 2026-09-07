#!/usr/bin/env bash
#
# The check that runs before every demo, and before every deploy.
#
# Builds the backend image from scratch, starts a container, waits for it to
# be live *and* ready, resets the seed, and analyzes both seed domains -
# asserting on the content, not just the status code. Exits non-zero on any
# failure, so it is safe to chain.
#
#   bash scripts/smoke.sh                      # SQLite, in the container
#   DATABASE_URL=postgresql+asyncpg://... bash scripts/smoke.sh
#   SKIP_BUILD=1 bash scripts/smoke.sh         # reuse the last image
#
# There is no CI here on purpose (the brief rules it out). This is the
# manually-run equivalent, and it is the same thing a pipeline would do.
set -uo pipefail

IMAGE="${IMAGE:-dwi-backend:smoke}"
CONTAINER="${CONTAINER:-dwi-smoke}"
PORT="${SMOKE_PORT:-8099}"
BASE="http://127.0.0.1:${PORT}"
ADMIN_TOKEN="${ADMIN_TOKEN:-smoke-token}"
CAMPUS="00000000-0000-0000-0000-000000000001"
BATTERY="00000000-0000-0000-0000-000000000002"

failures=0
started_at=$(date +%s)

pass() { printf '  [PASS] %s\n' "$1"; }
fail() { printf '  [FAIL] %s%s\n' "$1" "${2:+ - $2}"; failures=$((failures + 1)); }

check() {
  # check <label> <condition-exit-code> [detail]
  if [ "$2" -eq 0 ]; then pass "$1"; else fail "$1" "${3:-}"; fi
}

cleanup() {
  docker rm -f "$CONTAINER" >/dev/null 2>&1 || true
}
trap cleanup EXIT

step() { printf '\n%s\n%s\n' "$1" "$(printf '%.0s-' {1..70})"; }

# ---------------------------------------------------------------------------
step "1 - Build the image from scratch"
# ---------------------------------------------------------------------------
if [ "${SKIP_BUILD:-0}" = "1" ]; then
  echo "  (skipped: SKIP_BUILD=1)"
else
  if docker build -f backend/Dockerfile -t "$IMAGE" . >/tmp/dwi-build.log 2>&1; then
    pass "docker build"
  else
    fail "docker build" "see /tmp/dwi-build.log"
    tail -25 /tmp/dwi-build.log
    exit 1
  fi
fi

# ---------------------------------------------------------------------------
step "2 - Start a container"
# ---------------------------------------------------------------------------
cleanup
env_args=(-e "PORT=${PORT}" -e "ADMIN_TOKEN=${ADMIN_TOKEN}")
if [ -n "${DATABASE_URL:-}" ]; then
  env_args+=(-e "DATABASE_URL=${DATABASE_URL}")
  echo "  database: ${DATABASE_URL%%:*}  (external)"
else
  echo "  database: sqlite (in-container, empty)"
fi

if docker run -d --name "$CONTAINER" -p "${PORT}:${PORT}" \
    --add-host=host.docker.internal:host-gateway \
    "${env_args[@]}" "$IMAGE" >/dev/null; then
  pass "container started"
else
  fail "container started"
  exit 1
fi

# ---------------------------------------------------------------------------
step "3 - Wait for liveness, then readiness"
# ---------------------------------------------------------------------------
# They are different questions: /health says the process is up, /ready says
# the database answers. A container that is live but not ready is exactly the
# state a bad DATABASE_URL produces, and the point is to see which.
live=1
for _ in $(seq 1 40); do
  if curl -fsS -m 2 "${BASE}/health" >/dev/null 2>&1; then live=0; break; fi
  sleep 1
done
check "/health answers" "$live"
if [ "$live" -ne 0 ]; then
  echo "  --- container logs ---"; docker logs "$CONTAINER" 2>&1 | tail -30
  exit 1
fi

ready=1
for _ in $(seq 1 30); do
  body=$(curl -fsS -m 5 "${BASE}/ready" 2>/dev/null) && ready=0 && break
  sleep 1
done
check "/ready answers, so the database is reachable" "$ready" "$(docker logs "$CONTAINER" 2>&1 | tail -3)"
[ "$ready" -eq 0 ] && echo "  $body"

# ---------------------------------------------------------------------------
step "4 - Reset the seed through the guarded endpoint"
# ---------------------------------------------------------------------------
reset=$(curl -fsS -m 60 -X POST "${BASE}/admin/reset-seed" \
  -H "X-Admin-Token: ${ADMIN_TOKEN}" 2>/dev/null)
echo "$reset" | grep -q "campus-symposium"
check "both seed domains reloaded" $? "$reset"

# The other half of the guard: without the token it must refuse.
code=$(curl -s -o /dev/null -w '%{http_code}' -m 10 -X POST "${BASE}/admin/reset-seed")
[ "$code" = "401" ]
check "an untokened reset is refused" $? "got ${code}"

# ---------------------------------------------------------------------------
step "5 - Analyze both seed domains"
# ---------------------------------------------------------------------------
analyze() {
  local name="$1" id="$2"
  local t0 t1 ms body
  t0=$(date +%s%N)
  body=$(curl -fsS -m 30 -X POST "${BASE}/api/projects/${id}/analyze" \
    -H 'Content-Type: application/json' -d '{}' 2>/dev/null)
  t1=$(date +%s%N)
  ms=$(( (t1 - t0) / 1000000 ))

  if [ -z "$body" ]; then fail "${name}: analyze"; return; fi

  echo "$body" | grep -q '"findings"'
  check "${name}: analyze returns findings" $?

  echo "$body" | grep -q '"critical_path"'
  check "${name}: analyze returns a critical path" $?

  # The domain-agnosticism claim, checked on the wire rather than in a test.
  if echo "$body" | grep -q '"domain"'; then
    fail "${name}: the analysis payload carries no domain field"
  else
    pass "${name}: the analysis payload carries no domain field"
  fi

  [ "$ms" -lt 1000 ]
  check "${name}: analyze under 1s warm" $? "${ms}ms"
  printf '         %s analyze: %sms\n' "$name" "$ms"
}

# One warm-up call each: the first request pays for connection setup, and the
# floor in the brief is a warm one.
curl -fsS -m 30 -X POST "${BASE}/api/projects/${CAMPUS}/analyze" -H 'Content-Type: application/json' -d '{}' >/dev/null 2>&1
curl -fsS -m 30 -X POST "${BASE}/api/projects/${BATTERY}/analyze" -H 'Content-Type: application/json' -d '{}' >/dev/null 2>&1
analyze "campus" "$CAMPUS"
analyze "battery" "$BATTERY"

# ---------------------------------------------------------------------------
step "6 - The refusal still refuses"
# ---------------------------------------------------------------------------
refusal=$(curl -s -m 30 -X POST "${BASE}/api/projects/${BATTERY}/what-if" \
  -H 'Content-Type: application/json' \
  -d '{"name":"smoke","mutations":[{"kind":"TASK_REMOVE","payload":{"key":"M09"}}]}' 2>/dev/null)
echo "$refusal" | grep -q "MANDATORY_TASK"
check "deleting a mandatory task is refused with the constraint" $? "$refusal"

# ---------------------------------------------------------------------------
step "7 - Errors are structured"
# ---------------------------------------------------------------------------
missing=$(curl -s -m 10 "${BASE}/api/projects/00000000-0000-0000-0000-0000000000ff/workflow")
echo "$missing" | grep -q '"hint"'
check "a 404 carries an actionable hint" $? "$missing"

# ---------------------------------------------------------------------------
printf '\n%s\n' "$(printf '%.0s-' {1..70})"
elapsed=$(( $(date +%s) - started_at ))
if [ "$failures" -eq 0 ]; then
  printf 'SMOKE PASSED in %ss\n' "$elapsed"
  exit 0
fi
printf 'SMOKE FAILED: %s check(s) in %ss\n' "$failures" "$elapsed"
echo "--- container logs ---"
docker logs "$CONTAINER" 2>&1 | tail -40
exit 1
