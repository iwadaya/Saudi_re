# Seeding the reference lists on a new server

**Symptom this solves:** you stood up Universe on a new server and the
dropdowns (cedants, brokers, reinsurers, countries, currencies, treaty types,
classes of business, …) are empty — or they only show the built-in defaults,
not the lists your team has curated in the existing environment (e.g. the
Render production database).

## 0. First: make sure the defaults are even there

The app seeds a default set of lists by itself — no data copy needed for that:

1. Migrations must have run: `npm run migrate:status --prefix server`, then
   `npm run migrate:up --prefix server` (DEPLOYMENT.md §2, §8).
2. On every boot, `server/src/startup/ensureReferenceData.js` (re)inserts the
   default countries, currencies, brokers, treaty types, classes of business,
   reinsurers and demo cedants. Expected counts after a clean first boot:
   75 countries, 32 currencies, 11 brokers, 11 treaty types, 14 classes,
   22 cedants (DEPLOYMENT.md §8.5).

If the dropdowns are **completely** empty, migrations didn't run — fix that
first. Everything below is about getting **your** lists (the real cedants,
brokers, FX rates, … accumulated in the old environment) onto the new server.

## 1. Lists only: `syncRefLists` (recommended for this case)

`server/scripts/syncRefLists.js` copies just the reference lists between two
databases, merging into whatever the target already has (so the boot-seeded
`Aon` and the imported `Aon` become one row, not two).

Tables covered: `country`, `currency`, `brokers`, `reinsurers`,
`treaty_type`, `class_of_business`, `companies` (cedants), `ref_list` +
`ref_list_item`, `ref_exchange_rate`, `ref_cresta_zone`,
`ref_country_inflation`, `ref_benchmark_ldf`.

### Step 1 — export from Render

Get the **External Database URL** from the Render dashboard (the Postgres
instance → *Connections*). Run the export anywhere that can reach it — your
laptop or the new server:

```bash
cd /opt/universe   # any checkout with server deps installed
SOURCE_DATABASE_URL='postgresql://user:pass@…render.com/universe_db?sslmode=require' \
  npm run seed:lists:export           # writes ./ref-lists.json
```

If TLS verification fails against the external endpoint, append
`?sslmode=no-verify` instead of `?sslmode=require`.

### Step 2 — import into the new server

Copy `ref-lists.json` to the new server (if exported elsewhere), then, with
`DATABASE_URL` pointing at the new server's database (same value as the app's
`.env`):

```bash
npm run seed:lists:import -- --dry-run   # prints what would change, writes nothing
npm run seed:lists:import                # applies it (single transaction)
```

Restart the app — or wait ~5 minutes, or `DELETE /api/ref/cache` — so the
server's cached dropdowns pick up the new rows.

One-liner variant when a single machine can reach both databases:

```bash
SOURCE_DATABASE_URL=$RENDER_URL node server/scripts/syncRefLists.js export --out - \
  | DATABASE_URL=$NEW_URL node server/scripts/syncRefLists.js import --in -
```

### Behaviour you can rely on

- **Idempotent.** Re-running the import is a no-op (`unchanged` counts only).
- **Transactional.** The import is one transaction — it lands completely or
  not at all. `--dry-run` runs everything and rolls back.
- **Merge, not duplicate.** Rows are matched by primary key first (rows a
  previous run copied — renames at the source propagate), then by natural key
  (`country_code`, `broker_name`, `company_name`, `(currency_code,
  effective_date)`, …) preferring active rows, mirroring the migration-150
  partial uniques. Matched rows are updated in place keeping the target's id;
  new rows are inserted preserving the source UUID.
- **FKs remapped.** `companies.country_id`, `ref_list_item.list_id` and the
  per-country reference tables are re-pointed at the matching target row; a
  row whose parent didn't import is skipped (reported in the summary), never
  inserted dangling.
- **Soft-delete aware.** Inactive (`is_active=false`) rows are copied with
  their state. Optional `--deactivate-missing` additionally hides active
  target rows that are absent from the snapshot, so the new server's
  dropdowns end up showing *exactly* the source's lists. Rows are never
  deleted — they may be FK targets.

### Not copied by design

- **Users** — password hashes shouldn't travel between environments.
  Provision via Admin → Add User (DEPLOYMENT.md §8.6), or do a full clone.
- **Contracts, quotes, claims, documents** — business data, not lists.
- **`fac_*` rating reference** (occupancies, factor weights, rate-table
  versions, …) — seeded by migrations and governed/versioned in-app; if you
  have curated fac rates, move them with the full clone below.

## 2. Everything: full clone via backup/restore

If the new server is meant to *take over* from Render — contracts, users,
uploads metadata, fac reference and all — don't cherry-pick lists; restore a
backup instead:

```bash
# Dump production (or fetch the latest nightly dump — DEPLOYMENT.md §11):
DATABASE_URL=$RENDER_URL BACKUP_DIR=/tmp scripts/backup-db.sh

# Restore into the new server's EMPTY database:
pg_restore --no-owner --no-privileges --dbname "$NEW_URL" /tmp/universe-<stamp>.dump

# Then bring the schema up to the code you're deploying:
npm run migrate:up --prefix server
```

Restore into an empty database only — `pg_restore` does not merge. For
uploaded slip/document files, also copy the uploads directory or keep the
same Cloudinary account (DEPLOYMENT.md §11).
