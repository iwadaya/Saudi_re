# Runbook — Disaster recovery (database restore)

Invocation-time runbook for restoring the database from backup. The *mechanism*
and its verification live in `docs/backup-recovery.md`; this is the **who-does-what
under pressure** companion, referenced from the incident-response mitigation index.

**Committed targets:** RPO ≤ 24h · RTO ≤ 4h.

## When to invoke

- Database is unrecoverable in place (corruption, accidental destructive change,
  failed migration that cannot be rolled forward), **or**
- A restore to a point in time is required (e.g. to recover data deleted in error).

Declare a **SEV1** (data loss/corruption) and follow `incident-response.md` in
parallel — this runbook is the mitigation step.

## Decision authority

| Decision | Owner |
| --- | --- |
| Declare DR / begin restore (destructive to current state) | **Incident commander**, with [DB owner / eng lead] sign-off |
| Restore target (in-place vs new instance) | IC + [DB owner] |
| Go/no-go after verification | IC |

Restoring **overwrites current data** — it is itself destructive. Prefer restoring
into a **new instance** and cutting over, so the damaged original is preserved for
forensics and as a fallback.

## Procedure

Preconditions: `pg_dump`/`pg_restore`/`psql` and the AWS CLI available (the
`Dockerfile.jobs` image has both), plus `BACKUP_S3_*` creds and, for encrypted
backups, `BACKUP_ENCRYPTION_PASSPHRASE`.

```bash
# 1. Identify the dump to restore (newest, or a specific timestamp).
aws s3 ls s3://$BACKUP_S3_BUCKET/$BACKUP_S3_PREFIX/

# 2. VERIFY it first — never restore an unverified dump onto anything you care
#    about. Runs against a DEDICATED verification server, decrypts if needed.
DATABASE_URL=$VERIFY_DB_URL scripts/verify-restore.sh
#    (or pass an explicit dump path as $1)

# 3. Provision/choose the restore target (prefer a NEW empty database).

# 4. Restore. If the dump is encrypted (*.dump.gpg), decrypt first:
#      gpg --batch --pinentry-mode loopback --passphrase-fd 3 \
#          --decrypt --output restore.dump backup.dump.gpg 3<<<"$BACKUP_ENCRYPTION_PASSPHRASE"
pg_restore --no-owner --no-privileges --dbname="$TARGET_DATABASE_URL" restore.dump

# 5. Catch up schema since the dump, then smoke-test.
npm run migrate --prefix server
#    Verify: login, load a contract, run a pricing save, check row counts vs expectation.

# 6. Cut over (point the app's DATABASE_URL at the restored instance) and
#    monitor. Keep the damaged original until the incident is closed.
```

## Uploaded documents

If attachments were also lost, restore them from the upload backup (see
`docs/backup-recovery.md` → *Uploaded documents*):
- Local-disk backend: download and untar the newest `uploads-<stamp>.tar.gz[.gpg]`
  into `UPLOAD_DIR`.
- Cloudinary backend: assets persist in Cloudinary; reconcile the restored
  `*_document` rows against the Cloudinary/auto-backup mirror.

## After recovery

- Record actual **RPO achieved** (gap between the dump time and the incident) and
  **RTO achieved** (declaration → service restored) in the postmortem; if either
  target was missed, that is an action item.
- If RPO ≤ 24h is insufficient for a contractual SLA, implement **PITR**
  (WAL archiving / a managed-Postgres PITR tier) — nightly dumps alone cannot beat 24h.
