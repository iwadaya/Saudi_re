# Backup, restore-verification & scheduled jobs

Wires the backups, restore drills, and the two backlog maintenance jobs **as
code**. Two equivalent schedulers are provided — pick one (or run both):

- **GitHub Actions** — `.github/workflows/scheduled-jobs.yml` (verifiable in CI;
  the restore drill is self-contained).
- **Render Cron** — the `type: cron` services in `render.yaml` (in-network with
  the prod database).

Both reuse `scripts/backup-db.sh` and `scripts/verify-restore.sh` and alert on
failure via `scripts/run-with-alert.sh`.

## RPO / RTO targets (committed)

These are the platform's committed recovery targets, pinned in config
(`render.yaml` / the scheduled-jobs workflow as `BACKUP_RPO_TARGET` /
`BACKUP_RTO_TARGET`) and reflected in the schedules below. They are deliberately
conservative defaults for an enterprise rollout; revise here (and in the two
config files) if a customer contract sets a tighter SLA.

| Target | Committed | Meaning | How it's met |
| --- | --- | --- | --- |
| **RPO** (max data loss) | **≤ 24h** | Most data we can afford to lose | Nightly logical dump (02:00 UTC) pushed to object storage. For sub-24h RPO, layer the managed provider's PITR (below). |
| **RTO** (max downtime) | **≤ 4h** | Time to restore service | Tested restore path (below); the weekly drill keeps it exercised so the real restore is routine, not first-time. |

> **Sub-24h RPO:** nightly logical dumps alone cannot beat 24h. Where the
> business needs tighter, enable the managed Postgres provider's
> **continuous archiving / PITR** as the primary recovery mechanism and treat
> these dumps as the secondary, portable, provider-independent copy (they also
> protect against logical corruption that PITR would faithfully replay).

## Scheduled jobs

| Job | Schedule (UTC) | Command | Notes |
| --- | --- | --- | --- |
| Import-snapshot cleanup | daily `0 4 * * *` | `npm run cleanup:snapshots` | Enforces the import_snapshot 30-day retention (was manual). |
| LDF benchmark refresh | weekly `0 5 * * 1` | `npm run refresh:ldf-benchmarks` | Cadence is a placeholder — confirm. |
| DB backup | nightly `0 2 * * *` | `scripts/backup-db.sh` | `pg_dump` (custom format) + local prune + object-storage upload. Cadence meets RPO ≤ 24h. |
| Restore-verification | weekly `30 3 * * 0` | `scripts/verify-restore.sh` | Fetches the newest dump from object storage, restores into a scratch DB on a **dedicated** verification server, sanity-checks it. |

## Durable object storage

A dump that never leaves the job's ephemeral disk is not a backup. Both scripts
now speak S3-compatible object storage directly (no app changes): set
`BACKUP_S3_BUCKET` and the standard `AWS_*` credentials and

- `backup-db.sh` uploads the dump to
  `s3://$BACKUP_S3_BUCKET/$BACKUP_S3_PREFIX/universe-<stamp>.dump` after the
  local write. **A failed upload fails the job** (and pages via the alert
  wrapper) — a backup that didn't reach durable storage is surfaced, never
  silently dropped.
- `verify-restore.sh` **fetches the newest object** into `BACKUP_DIR` when no
  local dump is present, so the backup and restore-verify jobs need not share a
  disk.

| Variable | Default | Notes |
| --- | --- | --- |
| `BACKUP_S3_BUCKET` | — | Enables upload/fetch when set. Unset ⇒ local-only (unchanged behaviour). |
| `BACKUP_S3_PREFIX` | `backups` | Key prefix within the bucket. |
| `BACKUP_S3_ENDPOINT` | — | Only for non-AWS S3-compatible stores (MinIO, Cloudflare R2, DigitalOcean Spaces, GCS via the XML/HMAC endpoint). Omit for AWS S3. |
| `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` / `AWS_DEFAULT_REGION` | — | Standard AWS auth (or use an instance role and omit the keys). |

Grant the backup principal **least privilege**: `s3:PutObject` for the backup
job, `s3:GetObject` + `s3:ListBucket` for restore-verify. The Render Cron image
(`Dockerfile.jobs`) ships the AWS CLI; GitHub Actions passes the same env from
secrets.

### Object-storage retention (lifecycle, not the script)

`BACKUP_RETENTION_DAYS` only prunes the **local** `BACKUP_DIR`. Retention of the
durable copies is a **bucket lifecycle policy** so it is enforced server-side and
the job needs no delete permission. Recommended baseline (tune to compliance):

- transition dumps to infrequent-access after **30 days**,
- expire after **90 days** (or your contractual retention),
- enable **versioning + a delete/MFA-delete guard** so a compromised job key
  can't erase history, and a **bucket Object-Lock / retention** if immutability
  is required.

## Failure alerting

`scripts/run-with-alert.sh <job> -- <command…>` runs the job and, on a non-zero
exit, POSTs a message to `ALERT_WEBHOOK_URL` (Slack/Teams/Opsgenie incoming
webhook) and still exits non-zero so the scheduler also flags the run. Set
`ALERT_WEBHOOK_URL` as a secret in both schedulers; when unset the failure is
logged loudly but not delivered.

## Restore procedure (RTO drill)

The weekly drill proves restorability automatically. To restore for real:

```bash
# 1. Pick the dump. From object storage:
aws s3 cp s3://$BACKUP_S3_BUCKET/$BACKUP_S3_PREFIX/universe-<stamp>.dump .
# 2. Verify it first (into a scratch DB on a DEDICATED verification server):
DATABASE_URL=postgres://…/verify scripts/verify-restore.sh ./universe-<stamp>.dump
# 3. Restore into the target database:
pg_restore --no-owner --no-privileges --dbname="$TARGET_DATABASE_URL" ./universe-<stamp>.dump
# 4. Run migrations to catch up any schema since the dump, then smoke-test.
```

> **Verification environment.** `verify-restore.sh` CREATE/DROPs a scratch DB on
> the server in its `DATABASE_URL`, so it must point at a **dedicated
> verification Postgres, never production**. Use a small, isolated instance (the
> Render `universe-restore-verify` cron and the GitHub Actions drill each stand
> one up) — this both protects prod and proves the dump restores into a clean
> environment, not just back onto the box it came from.

## Verified locally

`scripts/backup-db.sh` + `scripts/verify-restore.sh` were dry-run against a
throwaway DB (P0-10): backup → restore into a scratch DB → sanity check **PASS**
(118 migrations, 223 countries). The GitHub Actions `restore-verification` job
runs this same self-contained drill on a schedule and on script changes.

## To wire (owner)

Mechanism is committed in code; these are the deploy-time settings:

- [x] RPO/RTO targets committed (≤24h / ≤4h) — revise here + the two config
      files if a contract sets a tighter SLA; add PITR for sub-24h RPO.
- [x] Object-storage upload/fetch wired into `backup-db.sh` / `verify-restore.sh`.
- [ ] Choose scheduler (GitHub Actions and/or Render Cron) and enable it.
- [ ] Create the bucket; set `BACKUP_S3_BUCKET` + least-privilege `AWS_*` creds
      (and `BACKUP_S3_ENDPOINT` for non-AWS). Set `BACKUP_S3_BUCKET` as a secret
      in whichever scheduler(s) you enable.
- [ ] Apply the bucket **lifecycle + versioning** retention policy (above).
- [ ] Stand up the **dedicated verification Postgres** and point the
      restore-verify job's `DATABASE_URL` at it (never prod).
- [ ] Set secrets: `ALERT_WEBHOOK_URL`, and (for prod jobs) `PROD_DATABASE_URL`
      (GH Actions) / `DATABASE_URL` (Render).
- [ ] Confirm the LDF-refresh cadence.
