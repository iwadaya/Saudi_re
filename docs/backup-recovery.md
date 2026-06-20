# Backup, restore-verification & scheduled jobs

Wires the backups, restore drills, and the two backlog maintenance jobs **as
code**. Two equivalent schedulers are provided — pick one (or run both):

- **GitHub Actions** — `.github/workflows/scheduled-jobs.yml` (verifiable in CI;
  the restore drill is self-contained).
- **Render Cron** — the `type: cron` services in `render.yaml` (in-network with
  the prod database).

Both reuse `scripts/backup-db.sh` and `scripts/verify-restore.sh` and alert on
failure via `scripts/run-with-alert.sh`.

## RPO / RTO targets — PLACEHOLDERS, confirm before relying on this

These are config placeholders (set in `render.yaml` as `BACKUP_RPO_TARGET` /
`BACKUP_RTO_TARGET`, and reflected in the schedules). **Confirm the real targets
with the business owner** — the values below are defaults, not a commitment.

| Target | Placeholder | Meaning | Drives |
| --- | --- | --- | --- |
| **RPO** (max data loss) | `24h` | Most data we can afford to lose | Backup cadence (nightly ⇒ ≤24h). Tighten to hourly / PITR if the business needs < 24h. |
| **RTO** (max downtime) | `4h` | Time to restore service | Restore-drill SLA + the restore procedure below. |

> If RPO must be well under 24h, nightly logical dumps are not enough — use the
> managed Postgres provider's **continuous/PITR** backups and treat these dumps
> as a secondary, portable copy.

## Scheduled jobs

| Job | Schedule (UTC, placeholder) | Command | Notes |
| --- | --- | --- | --- |
| Import-snapshot cleanup | daily `0 4 * * *` | `npm run cleanup:snapshots` | Enforces the import_snapshot 30-day retention (was manual). |
| LDF benchmark refresh | weekly `0 5 * * 1` | `npm run refresh:ldf-benchmarks` | Cadence is a placeholder — confirm. |
| DB backup | nightly `0 2 * * *` | `scripts/backup-db.sh` | Independent `pg_dump` (custom format) + retention. |
| Restore-verification | weekly `30 3 * * 0` | `scripts/verify-restore.sh` | Restores the latest dump into a throwaway scratch DB and sanity-checks it. |

## Durable storage (important)

`backup-db.sh` writes to `BACKUP_DIR`. For real durability the dump must leave
the job's ephemeral filesystem:

- **GitHub Actions**: the backup job uploads the dump as a run artifact
  (7-day retention placeholder). For production, push to **object storage**
  (S3/GCS) instead — add an upload step with the bucket creds.
- **Render Cron**: a Render disk attaches to a single service, so the backup and
  restore-verify crons cannot share one. Push dumps to **object storage** in the
  backup job and **fetch the latest into `BACKUP_DIR`** at the start of the
  restore-verify job.

## Failure alerting

`scripts/run-with-alert.sh <job> -- <command…>` runs the job and, on a non-zero
exit, POSTs a message to `ALERT_WEBHOOK_URL` (Slack/Teams/Opsgenie incoming
webhook) and still exits non-zero so the scheduler also flags the run. Set
`ALERT_WEBHOOK_URL` as a secret in both schedulers; when unset the failure is
logged loudly but not delivered.

## Restore procedure (RTO drill)

The weekly drill proves restorability automatically. To restore for real:

```bash
# 1. Pick the dump (object storage or BACKUP_DIR).
# 2. Verify it first (into a throwaway scratch DB on a NON-prod server):
DATABASE_URL=postgres://…/verify scripts/verify-restore.sh path/to/universe-<stamp>.dump
# 3. Restore into the target database:
pg_restore --no-owner --no-privileges --dbname="$TARGET_DATABASE_URL" path/to/universe-<stamp>.dump
# 4. Run migrations to catch up any schema since the dump, then smoke-test.
```

> `verify-restore.sh` CREATE/DROPs a scratch DB on the server in its
> `DATABASE_URL` — always point it at a **dedicated verification Postgres, never
> production**.

## Verified locally

`scripts/backup-db.sh` + `scripts/verify-restore.sh` were dry-run against a
throwaway DB (P0-10): backup → restore into a scratch DB → sanity check **PASS**
(118 migrations, 223 countries). The GitHub Actions `restore-verification` job
runs this same self-contained drill on a schedule and on script changes.

## To confirm / wire (owner)

- [ ] Confirm RPO/RTO targets (and whether PITR is required for RPO < 24h).
- [ ] Choose scheduler (GitHub Actions and/or Render Cron) and enable it.
- [ ] Set secrets: `ALERT_WEBHOOK_URL`, and (for prod jobs) `PROD_DATABASE_URL`
      (GH Actions) / `DATABASE_URL` (Render).
- [ ] Wire object-storage upload/fetch for durable backups.
- [ ] Confirm the LDF-refresh cadence.
