#!/usr/bin/env bash
# scripts/backup-uploads.sh — disaster-recovery for UPLOADED DOCUMENTS.
#
# pg_dump (scripts/backup-db.sh) captures the DATABASE only. Uploaded files
# (treaty/quote/fac/claim attachments) live OUTSIDE Postgres and had no backup
# story — a gap flagged in the enterprise-readiness audit. This script closes it
# for the local-disk storage backend and documents the Cloudinary path.
#
# Two storage backends exist (see server/src/lib/uploadStorage.js):
#   • LOCAL DISK  (UPLOAD_DIR)      — ephemeral on most PaaS hosts; MUST be
#                                     mirrored off-box or it is lost on redeploy.
#   • CLOUDINARY  (remote)          — durable third-party copy, but a SINGLE
#                                     unversioned one; see the note at the end.
#
# Config (environment):
#   UPLOAD_DIR             Local upload root to back up            (required for local mode)
#   BACKUP_S3_BUCKET       S3-compatible destination bucket        (required)
#   BACKUP_S3_PREFIX       Key prefix                              (default: uploads)
#   BACKUP_S3_ENDPOINT     Custom endpoint (MinIO/R2/Spaces/GCS)   (optional)
#   BACKUP_ENCRYPTION_PASSPHRASE
#                          When set, the archive is gpg AES-256 encrypted before
#                          upload (documents contain PII), same as backup-db.sh.
#   (Auth via the standard AWS_* env/role. Object-storage retention is a bucket
#    lifecycle rule, not this script — see docs/backup-recovery.md.)
set -euo pipefail

: "${BACKUP_S3_BUCKET:?BACKUP_S3_BUCKET is required (destination for the upload archive)}"
UPLOAD_DIR="${UPLOAD_DIR:-}"
prefix="${BACKUP_S3_PREFIX:-uploads}"
endpoint_args=()
[ -n "${BACKUP_S3_ENDPOINT:-}" ] && endpoint_args=(--endpoint-url "$BACKUP_S3_ENDPOINT")

if [ -z "$UPLOAD_DIR" ] || [ ! -d "$UPLOAD_DIR" ]; then
  echo "[backup-uploads] UPLOAD_DIR not set or not a directory — nothing to archive." >&2
  echo "[backup-uploads] If this deployment uses Cloudinary, uploaded files live in" >&2
  echo "[backup-uploads] Cloudinary (durable but unversioned). See docs/backup-recovery.md" >&2
  echo "[backup-uploads] → 'Uploaded documents' for the Cloudinary backup guidance." >&2
  exit 0
fi

stamp="$(date -u +%Y%m%dT%H%M%SZ)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
archive="$work/uploads-${stamp}.tar.gz"

echo "[backup-uploads] archiving $UPLOAD_DIR -> $archive" >&2
tar -czf "$archive" -C "$UPLOAD_DIR" .
echo "[backup-uploads] archive ok ($(du -h "$archive" | cut -f1))" >&2

# Encrypt before upload when a passphrase is configured — attachments are PII.
if [ -n "${BACKUP_ENCRYPTION_PASSPHRASE:-}" ]; then
  command -v gpg >/dev/null 2>&1 || { echo "[backup-uploads] gpg not installed but BACKUP_ENCRYPTION_PASSPHRASE is set" >&2; exit 1; }
  enc="${archive}.gpg"
  echo "[backup-uploads] encrypting -> $enc" >&2
  gpg --batch --yes --pinentry-mode loopback --passphrase-fd 3 \
      --symmetric --cipher-algo AES256 --output "$enc" "$archive" 3<<<"$BACKUP_ENCRYPTION_PASSPHRASE"
  rm -f "$archive"
  archive="$enc"
fi

dest="s3://${BACKUP_S3_BUCKET}/${prefix%/}/$(basename "$archive")"
echo "[backup-uploads] uploading -> $dest" >&2
aws s3 cp "${endpoint_args[@]}" "$archive" "$dest" >&2
echo "[backup-uploads] uploaded ok: $dest" >&2
echo "$dest"
