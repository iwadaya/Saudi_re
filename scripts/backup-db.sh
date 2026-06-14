#!/usr/bin/env bash
# scripts/backup-db.sh — nightly compressed pg_dump of the Universe database.
#
# Checked in so backups are reproducible, not tribal knowledge. Schedule it via
# scripts/universe-backup.cron (host cron) or a Render Cron Job (DEPLOYMENT.md
# §11). ALWAYS pair it with scripts/verify-restore.sh — a dump you have never
# restored is not a backup.
#
# Config (environment):
#   DATABASE_URL           Postgres connection string                (required)
#   BACKUP_DIR             Directory dumps land in   (default: /var/backups/universe)
#   BACKUP_RETENTION_DAYS  Prune dumps older than N days, 0 = keep all   (default: 30)
#
# Logs go to stderr; the single line on stdout is the dump path (so callers can
# chain, e.g.  dump=$(scripts/backup-db.sh) ).
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required (postgres connection string)}"
BACKUP_DIR="${BACKUP_DIR:-/var/backups/universe}"
RETENTION_DAYS="${BACKUP_RETENTION_DAYS:-30}"

mkdir -p "$BACKUP_DIR"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
out="$BACKUP_DIR/universe-${stamp}.dump"

echo "[backup-db] dumping -> $out" >&2
# --format=custom = compressed + selective restore; --no-owner/--no-privileges
# keep the dump portable so it restores under whatever role owns the target DB.
pg_dump --format=custom --no-owner --no-privileges --file="$out" "$DATABASE_URL"
echo "[backup-db] ok: $out ($(du -h "$out" | cut -f1))" >&2

# Retention: drop dumps older than RETENTION_DAYS (skip when 0 / non-numeric).
if [[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] && [ "$RETENTION_DAYS" -gt 0 ]; then
  find "$BACKUP_DIR" -maxdepth 1 -type f -name 'universe-*.dump' -mtime "+${RETENTION_DAYS}" \
    -print -delete | sed 's/^/[backup-db] pruned /' >&2 || true
fi

echo "$out"
