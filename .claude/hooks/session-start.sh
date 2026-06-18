#!/bin/bash
# SessionStart hook for Claude Code on the web.
#
# Bootstraps the workspace so tests and linters work out of the box:
#   1. installs root + server + client npm deps
#   2. (best-effort) stands up a local Postgres test DB, runs migrations, and
#      exports DATABASE_URL / TEST_WITH_DB so the DB-backed integration suite
#      (server/tests/integration/*) actually runs instead of skipping.
#
# Idempotent and non-interactive. Web-only — local machines already have their
# own setup. See CONTRIBUTING.md → "Database integration tests".
set -euo pipefail

# Only run in the remote (web) environment.
if [ "${CLAUDE_CODE_REMOTE:-}" != "true" ]; then
  exit 0
fi

ROOT="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
cd "$ROOT"

echo "[session-start] installing npm deps (root + server + client)…"
npm install
npm install --prefix server
npm install --prefix client

# ── Best-effort Postgres test DB ─────────────────────────────────────────────
# Skipped silently if Postgres isn't available in the image; the unit suite
# still runs without it (integration tests just skip without TEST_WITH_DB=1).
TEST_DB_URL="postgresql://postgres:postgres@localhost:5432/reinsurance_tool_test"
if command -v pg_ctlcluster >/dev/null 2>&1 && command -v psql >/dev/null 2>&1; then
  echo "[session-start] starting Postgres + preparing test DB…"
  pg_ctlcluster "$(pg_lsclusters -h | awk 'NR==1{print $1}')" main start >/dev/null 2>&1 || \
    service postgresql start >/dev/null 2>&1 || true

  # Wait briefly for the socket.
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    pg_isready -h localhost -p 5432 >/dev/null 2>&1 && break
    sleep 1
  done

  if pg_isready -h localhost -p 5432 >/dev/null 2>&1; then
    sudo -u postgres psql -c "ALTER USER postgres PASSWORD 'postgres';" >/dev/null 2>&1 || true
    sudo -u postgres psql -tAc "SELECT 1 FROM pg_database WHERE datname='reinsurance_tool_test'" 2>/dev/null \
      | grep -q 1 || sudo -u postgres psql -c "CREATE DATABASE reinsurance_tool_test;" >/dev/null 2>&1 || true

    DATABASE_URL="$TEST_DB_URL" npm run migrate --prefix server >/dev/null 2>&1 \
      && echo "[session-start] test DB migrated." \
      || echo "[session-start] WARN: migrations failed — run scripts/test-db.sh to diagnose."

    # Persist for the session so `TEST_WITH_DB=1 npm run test:server` just works.
    if [ -n "${CLAUDE_ENV_FILE:-}" ]; then
      {
        echo "export DATABASE_URL=\"$TEST_DB_URL\""
        echo "export TEST_WITH_DB=1"
      } >> "$CLAUDE_ENV_FILE"
    fi
  else
    echo "[session-start] WARN: Postgres did not become ready — skipping test DB."
  fi
else
  echo "[session-start] Postgres tooling not found — skipping test DB (unit tests still run)."
fi

echo "[session-start] done."
