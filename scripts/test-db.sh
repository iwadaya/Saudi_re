#!/usr/bin/env bash
#
# scripts/test-db.sh — run the DB-backed server integration tests locally
# (or in a cloud agent) with the same setup CI uses.
#
# It is idempotent and self-contained: it ensures a Postgres test database
# exists, runs the migrations, then runs the full server suite with
# TEST_WITH_DB=1 so the integration tests in server/tests/integration/*
# actually execute instead of skipping.
#
# Usage:
#   scripts/test-db.sh                 # use/auto-detect a local Postgres
#   DATABASE_URL=postgres://… scripts/test-db.sh   # point at an existing DB
#
# Environment:
#   DATABASE_URL   Full connection string. If unset, defaults to
#                  postgresql://postgres:postgres@localhost:5432/reinsurance_tool_test
#                  and the script will create that database if it can.
#   PRICING_STRICT Pass through to exercise strict server-side pricing
#                  verification (see server/src/lib/pricingVerifier.js).
#
# Parity note: CI (.github/workflows/ci.yml → integration job) runs
#   npm run migrate --prefix server  &&  npm run test:server
# against a postgres:16 service with TEST_WITH_DB=1. This script does the
# same thing locally; keep the two in sync when either changes.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"

DEFAULT_URL="postgresql://postgres:postgres@localhost:5432/reinsurance_tool_test"
export DATABASE_URL="${DATABASE_URL:-$DEFAULT_URL}"
export TEST_WITH_DB=1
export NODE_ENV="${NODE_ENV:-test}"
# env.js freezes provider keys at import; CI provides stubs so the
# renewal-pack import test's mocked fetch interceptor takes over. They
# are never used to call out.
export GEMINI_API_KEY="${GEMINI_API_KEY:-ci-stub-gemini-key}"
export OPENAI_API_KEY="${OPENAI_API_KEY:-ci-stub-openai-key}"

echo "▶ DATABASE_URL = $(printf '%s' "$DATABASE_URL" | sed -E 's#(://[^:]+:)[^@]*@#\1***@#')"

# Parse the database name out of the URL so we can create it if missing.
DB_NAME="$(node -e 'try{process.stdout.write(new URL(process.env.DATABASE_URL).pathname.replace(/^\//,""))}catch{process.stdout.write("")}')"

# Best-effort: create the target database if a local server is reachable
# and the DB does not exist yet. Skipped silently when psql is unavailable
# or the DB already exists (e.g. CI's pre-provisioned service container).
if command -v psql >/dev/null 2>&1 && [ -n "$DB_NAME" ]; then
  ADMIN_URL="$(node -e 'const u=new URL(process.env.DATABASE_URL);u.pathname="/postgres";process.stdout.write(u.toString())')"
  if psql "$ADMIN_URL" -tAc "SELECT 1" >/dev/null 2>&1; then
    if ! psql "$ADMIN_URL" -tAc "SELECT 1 FROM pg_database WHERE datname='${DB_NAME}'" | grep -q 1; then
      echo "▶ creating database ${DB_NAME}"
      psql "$ADMIN_URL" -c "CREATE DATABASE \"${DB_NAME}\""
    fi
  else
    echo "ℹ could not reach Postgres admin DB to auto-create ${DB_NAME}; assuming it exists"
  fi
fi

# Install deps if missing (cloud agents start from a fresh clone).
[ -d node_modules ] || npm ci --include=optional
[ -d server/node_modules ] || npm ci --include=optional --prefix server

echo "▶ running migrations"
npm run migrate --prefix server

echo "▶ running server tests (TEST_WITH_DB=1)"
npm run test:server

echo "✓ DB-backed server tests complete"
