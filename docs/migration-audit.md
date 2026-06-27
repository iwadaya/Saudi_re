# Migration Audit And Prod-Schema Rebase Plan

Audit date: 2026-05-01.

## Current State

The migration chain is file-based and applied through
`server/src/startup/runMigrations.js`. It:

* creates `public._migrations(filename, applied_at)`;
* sorts `server/src/db/migrations/*.sql` lexicographically;
* uses a Postgres advisory lock to serialize app workers;
* records only the filename, not a checksum.

The runner is invoked by the standalone `npm run migrate:up`
(`server/src/db/migrate.js`) from CI / predeploy hooks. It runs on app boot only
when `RUN_MIGRATIONS_ON_BOOT=true`, which defaults to **false** — local dev and
docker-compose opt in for convenience, while production applies migrations as a
separate predeploy step so a bad migration fails the deploy instead of taking
the API down on boot.

Current SQL files run from `000_core_schema.sql` through
`128_fac_document_meta.sql`. Number gaps exist at `041`, `058`, `060`, `070`,
and `085`–`089`; that is operationally safe because ordering is by filename, but
future migrations should not reuse those numbers unless they are known never to
have shipped.

> Note: the per-migration findings below were written at the 2026-05-01 audit,
> which covered the chain through `073`. Migrations `074`–`128` have since been
> added (facultative schema, AI / market-intelligence, import jobs, LDF
> benchmarks, auth sessions, etc.); they follow the same additive, idempotent
> conventions but are not individually catalogued here yet.

## Audit Findings

* `000_core_schema.sql` is a large baseline dump. Later migrations patch
  shape gaps and production drift. Treat it as historical: do not edit it
  for prod rebase work.
* The runner records filenames without checksums. Editing any applied
  migration will not change production. All prod rebase work must be
  additive in a new migration.
* Quote/treaty parity is now intentional. Most child entities should
  have `contract_*` and `quote_*` table pairs with equivalent indexes
  and constraints. The main known exceptions are lifecycle-specific
  columns such as `quote_version*`, `bound_contract_id`, and
  `source_quote_id`.
* `057_foreign_key_retrofit.sql` retrofits a broad FK layer. Later
  `071_audit_event_fk_drop.sql` removes legacy audit-event contract FKs,
  which is consistent with audit rows now spanning contract and quote
  workflows.
* Performance migrations are split across `042`, `050`, `056`, and
  `066`. A production rebase must preserve their indexes; they are tied
  to `/api/quotes`, dashboard, loss-selection, and offer hot paths.
* `072_database_alignment_and_index_cleanup.sql` closes the latest audit
  gaps: shared quote/treaty owner constraints, quote-side shared-table
  FKs, contract pricing FKs, missing FK support indexes, and duplicate
  index cleanup.
* `073_pricing_component_persistence_alignment.sql` aligns the active
  pricing save/component-snapshot routes with storage: component UI
  columns exist, snapshot IDs have a default sequence, and proportional
  pricing monetary results can hold realistic treaty-sized values.

## Prod Rebase Procedure

Use this sequence when a production schema dump or connection is
available:

1. Capture prod structure without data:

   ```bash
   pg_dump "$PROD_DATABASE_URL" --schema-only --no-owner --no-privileges > /tmp/prod-schema.sql
   ```

2. Build a fresh local schema from migrations against an empty database:

   ```bash
   DATABASE_URL=postgres://postgres:postgres@localhost:5432/reinsurance_tool npm run migrate --prefix server
   pg_dump "$DATABASE_URL" --schema-only --no-owner --no-privileges > /tmp/local-schema.sql
   ```

3. Diff normalized structure, ignoring grants/owners/comments:

   ```bash
   diff -u /tmp/prod-schema.sql /tmp/local-schema.sql > /tmp/schema.diff
   ```

4. Turn real drift into a new migration, for example
   `074_prod_schema_rebase.sql`. Keep it idempotent with
   `IF [NOT] EXISTS` and `DO $$` guards.

5. Verify on a restored prod snapshot before production:

   ```bash
   DATABASE_URL="$RESTORED_PROD_SNAPSHOT_URL" npm run migrate --prefix server
   npm run test:server
   npm run loadtest:10vu
   ```

## Rebase Acceptance Checklist

* No historical migration files are edited.
* New migration is additive/idempotent and can run twice without error.
* Quote and treaty table pairs remain symmetric unless documented.
* `/api/quotes?status=DRAFT&limit=10` and
  `/api/dashboard/page/portfolio-overview?uwYear=2026` pass the 10 VU
  load test thresholds.
* Any data backfill is bounded, batched, and safe under app traffic.
