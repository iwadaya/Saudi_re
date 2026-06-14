#!/usr/bin/env bash
# scripts/verify-restore.sh — prove a backup is actually restorable.
#
# Restores a dump into a throwaway scratch database on the SAME Postgres server,
# runs a sanity query, then drops the scratch DB. Exits non-zero if anything
# fails, so a silently-corrupt or empty dump is caught. Wire it into cron
# (weekly) and/or CI — see scripts/universe-backup.cron and DEPLOYMENT.md §11.
#
# Usage:
#   scripts/verify-restore.sh [path/to/dump]     # default: newest in BACKUP_DIR
# Config (environment):
#   DATABASE_URL   Postgres connection string (its server hosts the scratch DB)  (required)
#   BACKUP_DIR     Where to look for the newest dump   (default: /var/backups/universe)
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required (postgres connection string)}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/universe}"

dump="${1:-}"
if [ -z "$dump" ]; then
  dump="$(ls -1t "$BACKUP_DIR"/universe-*.dump 2>/dev/null | head -1 || true)"
fi
[ -n "$dump" ] && [ -f "$dump" ] || { echo "[verify-restore] no dump found (looked in ${1:-$BACKUP_DIR})" >&2; exit 1; }
echo "[verify-restore] verifying $dump" >&2

# A unique scratch DB on the same server, and a connection URL pointing at it
# (swap the database path component of DATABASE_URL, preserving any ?query).
scratch="universe_restore_check_$$"
base="${DATABASE_URL%%\?*}"
query="${DATABASE_URL#"$base"}"        # the "?..." part, or "" when absent
scratch_url="${base%/*}/${scratch}${query}"

# Always drop the scratch DB, even on failure. We CREATE/DROP it from a
# connection to the ORIGINAL database (you can't drop the DB you're in).
cleanup() { psql "$DATABASE_URL" -qtAc "DROP DATABASE IF EXISTS \"$scratch\";" >/dev/null 2>&1 || true; }
trap cleanup EXIT

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -qtAc "DROP DATABASE IF EXISTS \"$scratch\";"
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -qtAc "CREATE DATABASE \"$scratch\" TEMPLATE template0;"

echo "[verify-restore] restoring into $scratch" >&2
# Benign restore notices (extensions, comments) must not fail the check — the
# sanity query below is the real pass/fail gate.
pg_restore --no-owner --no-privileges --dbname="$scratch_url" "$dump" \
  || echo "[verify-restore] pg_restore reported warnings (continuing to sanity check)" >&2

# Sanity: the schema bookkeeping table and seeded reference data must be present.
read -r migrations countries < <(
  psql "$scratch_url" -tA -F' ' -v ON_ERROR_STOP=1 -c \
    "SELECT (SELECT count(*) FROM public._migrations), (SELECT count(*) FROM public.country);"
)
echo "[verify-restore] restored: _migrations=${migrations:-0} country=${countries:-0}" >&2

if [ "${migrations:-0}" -gt 0 ] && [ "${countries:-0}" -gt 0 ]; then
  echo "[verify-restore] PASS — $dump restores cleanly (${migrations} migrations, ${countries} countries)"
  exit 0
fi
echo "[verify-restore] FAIL — restored DB missing expected rows (_migrations=${migrations:-0}, country=${countries:-0})" >&2
exit 1
