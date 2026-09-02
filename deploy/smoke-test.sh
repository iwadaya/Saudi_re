#!/usr/bin/env bash
# deploy/smoke-test.sh — prove a running instance is healthy.
#
#   deploy/smoke-test.sh                                  # http://127.0.0.1:4000
#   BASE_URL=https://universe.example.internal deploy/smoke-test.sh
#   SMOKE_USER=chief.underwriter SMOKE_PASSWORD=… deploy/smoke-test.sh   # also test login
#
# Environment:
#   BASE_URL         where to probe                    (default: http://127.0.0.1:4000)
#   WAIT_SECONDS     how long to wait for /api/health   (default: 30)
#   SMOKE_INSECURE   1 = accept a self-signed TLS certificate
#   SMOKE_USER / SMOKE_PASSWORD   when both set, POST /api/auth/login must succeed
#
# Checks: shallow health, deep health (DB round-trip), the login user list is
# served from the database (not the demo fallback), the SPA index is served,
# and optionally a real login sets the auth cookie. Exit code 0 = all green.
set -uo pipefail

BASE_URL="${BASE_URL:-http://127.0.0.1:4000}"
WAIT_SECONDS="${WAIT_SECONDS:-30}"
CURL=(curl -sS --max-time 10)
[ "${SMOKE_INSECURE:-0}" = 1 ] && CURL+=(-k)

fail=0
ok()   { echo "  ✓ $*"; }
bad()  { echo "  ✗ $*"; fail=1; }
json() { node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);const v=process.argv[1].split(".").reduce((o,k)=>o==null?o:o[k],j);process.stdout.write(v===undefined?"":String(v))}catch{process.stdout.write("")}})' "$1"; }

echo "Smoke test against $BASE_URL"

echo "1. waiting for /api/health (up to ${WAIT_SECONDS}s)"
up=0
for ((i = 0; i < WAIT_SECONDS; i++)); do
  if "${CURL[@]}" -o /dev/null "$BASE_URL/api/health" 2>/dev/null; then up=1; break; fi
  sleep 1
done
if [ "$up" = 1 ]; then ok "reachable"; else bad "no response within ${WAIT_SECONDS}s"; echo "FAILED"; exit 1; fi

echo "2. shallow health"
body=$("${CURL[@]}" "$BASE_URL/api/health") || body=""
status=$(printf '%s' "$body" | json status)
envname=$(printf '%s' "$body" | json env)
[ "$status" = ok ] && ok "status=ok env=$envname" || bad "unexpected body: $body"
[ "$envname" = production ] || echo "  ! NODE_ENV is '$envname', not production"

echo "3. deep health (database round-trip)"
body=$("${CURL[@]}" "$BASE_URL/api/health/deep") || body=""
if [ "$(printf '%s' "$body" | json db.ok)" = true ]; then
  ok "db.ok=true pingMs=$(printf '%s' "$body" | json db.pingMs) pool.max=$(printf '%s' "$body" | json db.pool.max)"
else
  bad "database unreachable: $body"
fi

echo "4. login user list comes from the database"
body=$("${CURL[@]}" "$BASE_URL/api/auth/users") || body=""
count=$(printf '%s' "$body" | node -e 'let d="";process.stdin.on("data",c=>d+=c).on("end",()=>{try{const j=JSON.parse(d);process.stdout.write(Array.isArray(j)?String(j.length):"0")}catch{process.stdout.write("0")}})')
if [ "$count" -gt 0 ] 2>/dev/null && ! printf '%s' "$body" | grep -q '"cuo@universe3.app"'; then
  ok "$count active user(s)"
else
  bad "user list empty or demo fallback — migrations probably did not run"
fi

echo "5. SPA index served"
code=$("${CURL[@]}" -o /dev/null -w '%{http_code}' "$BASE_URL/") || code=000
[ "$code" = 200 ] && ok "GET / → 200" || bad "GET / → $code (client/dist missing? run npm run build)"

if [ -n "${SMOKE_USER:-}" ] && [ -n "${SMOKE_PASSWORD:-}" ]; then
  echo "6. login as $SMOKE_USER"
  hdr=$(mktemp)
  payload=$(node -e 'process.stdout.write(JSON.stringify({username:process.argv[1],password:process.argv[2]}))' "$SMOKE_USER" "$SMOKE_PASSWORD")
  code=$("${CURL[@]}" -o /dev/null -D "$hdr" -w '%{http_code}' -H 'Content-Type: application/json' -X POST --data "$payload" "$BASE_URL/api/auth/login") || code=000
  if [ "$code" = 200 ] && grep -qi '^set-cookie: auth_token=' "$hdr"; then
    ok "200 + auth_token cookie"
    grep -qi 'secure' "$hdr" && echo "  ! cookie is Secure — it only works over https:// (nginx TLS)"
  else
    bad "login returned $code"
  fi
  rm -f "$hdr"
fi

if [ "$fail" = 0 ]; then echo "PASSED"; else echo "FAILED"; fi
exit "$fail"
