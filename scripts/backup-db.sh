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
#   BACKUP_RETENTION_DAYS  Prune LOCAL dumps older than N days, 0 = keep all (default: 30)
#
# Encryption at rest (STRONGLY recommended for a reinsurance dataset — the dump
# contains cedant, treaty, claim and PII data and, once uploaded, lives on
# third-party object storage):
#   BACKUP_ENCRYPTION_PASSPHRASE  When set, the dump is encrypted with
#                          gpg --symmetric AES-256 BEFORE any retention/upload,
#                          and the plaintext .dump is shredded. The artifact
#                          becomes <name>.dump.gpg. verify-restore.sh needs the
#                          same passphrase to decrypt. Store it in the secret
#                          manager, NEVER in the repo or alongside the backups.
#
# Durable object storage (optional but REQUIRED for production durability — a
# dump that never leaves the job's ephemeral disk is not a real backup):
#   BACKUP_S3_BUCKET       S3-compatible bucket; when set the dump is uploaded
#   BACKUP_S3_PREFIX       Key prefix within the bucket           (default: backups)
#   BACKUP_S3_ENDPOINT     Custom endpoint for S3-compatible stores (MinIO, R2,
#                          DigitalOcean Spaces, GCS XML/HMAC). Omit for AWS S3.
#   (Object-storage RETENTION is a bucket LIFECYCLE rule, not this script — see
#    docs/backup-recovery.md. Auth via the standard AWS_* env/role.)
#
# Logs go to stderr; the single line on stdout is the LOCAL dump path (so callers
# can chain, e.g.  dump=$(scripts/backup-db.sh) ).
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

# Encrypt at rest before the dump ever leaves this host. Symmetric AES-256 via
# gpg; the passphrase is a shared secret held in the secret manager. A FAILED
# encryption FAILS the job (set -e) — we must never fall back to shipping
# plaintext. The plaintext dump is removed once the ciphertext is written.
if [ -n "${BACKUP_ENCRYPTION_PASSPHRASE:-}" ]; then
  command -v gpg >/dev/null 2>&1 || { echo "[backup-db] gpg not installed but BACKUP_ENCRYPTION_PASSPHRASE is set" >&2; exit 1; }
  enc="${out}.gpg"
  echo "[backup-db] encrypting -> $enc" >&2
  gpg --batch --yes --pinentry-mode loopback \
      --passphrase-fd 3 --symmetric --cipher-algo AES256 \
      --output "$enc" "$out" 3<<<"$BACKUP_ENCRYPTION_PASSPHRASE"
  rm -f "$out"
  out="$enc"
  echo "[backup-db] encrypted ok: $out ($(du -h "$out" | cut -f1))" >&2
fi

# Retention (LOCAL disk): drop dumps older than RETENTION_DAYS (skip when 0 /
# non-numeric). Object-storage retention is a separate bucket lifecycle rule.
if [[ "$RETENTION_DAYS" =~ ^[0-9]+$ ]] && [ "$RETENTION_DAYS" -gt 0 ]; then
  find "$BACKUP_DIR" -maxdepth 1 -type f \( -name 'universe-*.dump' -o -name 'universe-*.dump.gpg' \) \
    -mtime "+${RETENTION_DAYS}" -print -delete | sed 's/^/[backup-db] pruned /' >&2 || true
fi

# Durable copy: push to object storage when configured. A FAILED upload FAILS the
# job (set -e) — a backup that never reached durable storage must be flagged. The
# job needs only PutObject; retention is enforced by the bucket lifecycle policy.
if [ -n "${BACKUP_S3_BUCKET:-}" ]; then
  prefix="${BACKUP_S3_PREFIX:-backups}"
  dest="s3://${BACKUP_S3_BUCKET}/${prefix%/}/$(basename "$out")"
  endpoint_args=()
  [ -n "${BACKUP_S3_ENDPOINT:-}" ] && endpoint_args=(--endpoint-url "$BACKUP_S3_ENDPOINT")
  echo "[backup-db] uploading -> $dest" >&2
  aws s3 cp "${endpoint_args[@]}" "$out" "$dest" >&2
  echo "[backup-db] uploaded ok: $dest" >&2
fi

echo "$out"
