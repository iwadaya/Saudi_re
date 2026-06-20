# Runbook — Validate the NOT VALID foreign keys (staging first)

**Owner action required. Do not run against production.** This runbook is
produced for an operator to execute on a **restored production snapshot in
staging**. The author/agent does not run any of these steps against prod.

Context: 84 of 117 FKs are `NOT VALID` — retrofitted to protect new writes but
never checked against existing data (`docs/database-design-audit.md`). `ALTER
TABLE … VALIDATE CONSTRAINT` fails the instant it meets an orphan, so every
constraint must be orphan-checked (and cleaned) before validating.

Artifacts:
- `server/scripts/fk-orphan-report.js` — read-only orphan detector (writes nothing).
- `server/src/db/maintenance/fk_validation_emit.sql` — read-only generator that
  EMITS the orphan-check / archive-then-clean / VALIDATE SQL for the actual
  snapshot (review before running anything).
- `server/src/db/maintenance/validate_not_valid_fks.sql` — the batched VALIDATE
  statements (committed snapshot of the 84; regenerate via the emitter).

---

## 0. Preconditions

- [ ] A **restored copy** of the production snapshot is running in **staging**.
- [ ] `DATABASE_URL` / `$STAGING_URL` points at that restored snapshot — **verify
      the host is NOT production** before continuing.
- [ ] You have a fresh dump of the snapshot (so the whole exercise is disposable
      and re-runnable).
- [ ] A maintenance/quiet window is identified for the VALIDATE step (it locks
      DDL on each child table briefly; reads/writes continue).

> Re-runnability: every step below is safe to repeat. Orphan detection and the
> emitter are read-only; VALIDATE on an already-valid constraint is a no-op.

---

## 1. Orphan detection (read-only)

```bash
DATABASE_URL="$STAGING_URL" node server/scripts/fk-orphan-report.js
# machine-readable: add --json ; single constraint: --constraint <name>
```

- Exit `0` → no orphans anywhere → **skip Step 2**, go to Step 3.
- Exit `2` → one or more constraints have orphan rows → do Step 2 for those only.
- Exit `1` → error (connection/permissions) → fix and re-run.

Record the report (or `--json` output) in the change ticket.

---

## 2. Archive-then-clean orphans (only where Step 1 found > 0)

Orphans are real data with a dangling reference. **Archive before deleting** so
nothing is lost and the action is auditable/reversible.

1. Emit the per-constraint SQL (read-only; writes nothing):

   ```bash
   psql "$STAGING_URL" -f server/src/db/maintenance/fk_validation_emit.sql > /tmp/fk_emit.sql
   ```

2. From `/tmp/fk_emit.sql`, take **STEP B** blocks **only for the constraints
   that reported orphans in Step 1**. Review each block. Each one:
   - `CREATE SCHEMA IF NOT EXISTS fk_archive;`
   - copies the orphan rows into `fk_archive.<table>_<constraint>` (full row image), then
   - `DELETE`s those orphan rows from the live table.

3. Run the reviewed blocks inside an explicit transaction so you can inspect
   before committing:

   ```sql
   BEGIN;
   -- (paste the reviewed STEP B block(s) here)
   -- sanity check: archived count == deleted count, spot-check a few rows
   SELECT count(*) FROM fk_archive.<table>_<constraint>;
   COMMIT;   -- or ROLLBACK to abort
   ```

   > For a `NOT NULL`-able FK column you may prefer to **null the column** instead
   > of deleting the row — decide per table with the data owner. The emitted
   > block deletes; adjust deliberately if nulling is the correct business action.

4. **Re-run Step 1** until it reports zero orphans.

---

## 3. Batched VALIDATE (quiet window)

Pre-flight: confirm the snapshot is clean.

```bash
DATABASE_URL="$STAGING_URL" node server/scripts/fk-orphan-report.js   # expect exit 0
```

Then validate in batches. Use the committed file, or regenerate STEP C from the
emitter for the exact snapshot:

```bash
# one batch group at a time is fine; the file is grouped by child table:
psql "$STAGING_URL" -f server/src/db/maintenance/validate_not_valid_fks.sql
```

Notes:
- Each `VALIDATE` takes a `SHARE UPDATE EXCLUSIVE` lock on the child table and
  scans it once. Concurrent `SELECT`/`INSERT`/`UPDATE`/`DELETE` continue; other
  DDL on that table waits.
- If one constraint still errors on an orphan, the others in the batch still
  apply. Clean that one (Step 2) and re-run just it.
- Do **not** wrap all 84 in a single long transaction — run per batch group so
  locks are held briefly.

Verify nothing remains `NOT VALID`:

```sql
SELECT count(*) AS still_not_valid
  FROM pg_constraint con JOIN pg_namespace ns ON ns.oid = con.connamespace
 WHERE con.contype = 'f' AND con.convalidated = false AND ns.nspname = 'public';
-- expect 0
```

---

## 4. Rollback / recovery

- VALIDATE is non-destructive (it only flips the catalog flag after a clean
  scan); there is nothing to undo for a successful validate.
- If Step 2 deleted rows you want back, they are in `fk_archive.*` — re-insert
  from there.
- If anything looks wrong, the whole exercise is on a disposable snapshot:
  drop it and restore again.

---

## 5. Post-validation load-test checklist

Goal: confirm validated constraints + cleaned data did not regress the hot paths.
Run against the **staging** app pointed at the validated snapshot (the repo ships
a 10-VU smoke test — `npm run loadtest:10vu`, `load-test/k6/`).

- [ ] **Baseline first.** Capture a 10-VU run **before** validating (on the
      restored-but-not-yet-validated snapshot) to compare against.
- [ ] **Quote path** — list/create/read/price/save a quote; p95 latency and error
      rate within baseline.
- [ ] **Treaty (contract) path** — list/read/save a treaty; dashboard list loads.
- [ ] **Dashboard / portfolio** — `GET /api/dashboard/page/portfolio-overview`
      and filter combinations; aggregate latency within baseline.
- [ ] **Pricing path** — `POST /api/pricing/save` and component/snapshot reads;
      confirm no new `422 PRICING_DRIFT` introduced by data cleanup.
- [ ] **Write-amplification check** — inserts into high-write child tables
      (triangle cells, losses, pricing outputs) are not measurably slower; the
      newly-validated FKs add a per-insert parent lookup, already indexed
      (migration 072 added child-side support indexes).
- [ ] **Error budget** — overall error rate at/below baseline; no new FK-violation
      errors in the app logs.
- [ ] **DB health** — no lock-wait spikes during the run; `pg_stat_activity`
      clean; autovacuum not thrashing the cleaned tables.

Sign-off: attach the before/after k6 summaries and the final `still_not_valid = 0`
query result to the change ticket. Only then schedule the same sequence for the
real production maintenance window.
