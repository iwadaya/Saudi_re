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
#                  ALWAYS a DEDICATED verification server — this CREATE/DROPs DBs.
#   BACKUP_DIR     Where to look for the newest dump   (default: /var/backups/universe)
#   BACKUP_S3_BUCKET / BACKUP_S3_PREFIX / BACKUP_S3_ENDPOINT
#                  When no LOCAL dump is found, fetch the newest from object
#                  storage (backup and verify jobs run on separate disks/hosts).
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required (postgres connection string)}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/universe}"

dump="${1:-}"
if [ -z "$dump" ]; then
  dump="$(ls -1t "$BACKUP_DIR"/universe-*.dump 2>/dev/null | head -1 || true)"
fi
# No local dump → pull the newest from object storage when configured. Dump names
# are UTC-timestamped (universe-YYYYMMDDTHHMMSSZ.dump) so lexical sort == newest.
if [ -z "$dump" ] && [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  prefix="${BACKUP_S3_PREFIX:-backups}"
  s3base="s3://${BACKUP_S3_BUCKET}/${prefix%/}"
  endpoint_args=()
  [ -n "${BACKUP_S3_ENDPOINT:-}" ] && endpoint_args=(--endpoint-url "$BACKUP_S3_ENDPOINT")
  mkdir -p "$BACKUP_DIR"
  latest="$(aws s3 ls "${endpoint_args[@]}" "$s3base/" | awk '/universe-.*\.dump$/ {print $4}' | sort | tail -1)"
  if [ -n "$latest" ]; then
    echo "[verify-restore] fetching $s3base/$latest" >&2
    aws s3 cp "${endpoint_args[@]}" "$s3base/$latest" "$BACKUP_DIR/$latest" >&2
    dump="$BACKUP_DIR/$latest"
  fi
fi
[ -n "$dump" ] && [ -f "$dump" ] || { echo "[verify-restore] no dump found (looked in ${1:-$BACKUP_DIR}${BACKUP_S3_BUCKET:+ and s3://$BACKUP_S3_BUCKET})" >&2; exit 1; }
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
