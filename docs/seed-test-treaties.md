# Seeding treaty test data

`server/scripts/seedTestTreaties.js` builds a complete treaty portfolio for
manual testing: **50 proportional** and **50 non-proportional** contracts, plus
the Ghanaian reference data they need.

```bash
npm run seed:treaties          # add the portfolio
npm run seed:treaties:reset    # delete the previous seed, then reseed
npm run seed:treaties:verify   # NULL-coverage report, no writes
node server/scripts/seedTestTreaties.js --reset-only   # delete only
```

`DATABASE_URL` selects the target database, as everywhere else in the server.

## What you get

| | |
|---|---|
| Contracts | 50 `PROPORTIONAL` + 50 `NON_PROPORTIONAL` |
| Underwriting years | current year back to current − 4, weighted to recent |
| Statuses | `SIGNED`, `AWAITING_SIGNED_LINE`, `AWAITING_APPROVAL`, `NTU`, `DECLINED` |
| Renewal lineages | 2–4 consecutive years per programme, chained via `parent_contract_id` |
| Currencies | the cedant's local currency (GHS, AED, SAR, KWD, EGP, GBP) or USD |
| Per contract | classes + EPI split + UW limits, risk and claims profiles (8 bands each), CRESTA aggregates, four development triangles in both variants, selected LDFs and blends, large- and CAT-loss listings with inflation snapshots, commissions and sliding scale, loss participation, pricing components/shares/leads, offer with peer review, workflow and audit trail, wording checklist |
| NP extras | 2–5 layer tower, expiring tower, EGNPI and historical performance by year, burn/exposure/Pareto pricing per layer for both RISK and CAT sections, excess/large/CAT LDFs and ultimates, stop-loss pricing |

## Ghana

The seed adds eight Ghanaian cedants (SIC, Enterprise, Star Assurance, Hollard
Ghana, GLICO General, Vanguard, Ghana Union, Activa) and the reference data a
Ghanaian treaty needs but the base migrations do not ship: the **GHS** currency
and its USD rate, eight Ghana CRESTA zones, and the **Ghana CPI series
2000–2026** in `ref_country_inflation` so the loss-inflation screens work.
Around 40% of the portfolio is written on those cedants.

The CPI and FX figures are indicative reference values for a test environment,
not a source of record.

## Running it on Render

Yes — the script has no build step and no dependency the deployed service does
not already have.

The web service in `render.yaml` uses `runtime: node`, so the whole repo is
checked out on the instance and `npm ci --prefix server` installs everything the
script imports (it pulls in `server/src/db/pool.js`, whose only real dependency
is `pg`, a plain server dependency — the server has no devDependencies at all).
`DATABASE_URL` is already in the service environment.

Open **Shell** on the service (paid instance types) and run:

```bash
NODE_ENV=production SEED_ALLOW_PRODUCTION=1 npm run seed:treaties
```

Notes:

- **`validateEnv()` is not on this path.** It only runs from
  `startup/bootstrap.js`, so the script needs `DATABASE_URL` and nothing else —
  no `AUTH_JWT_SECRET`, no `SESSION_SECRET`. That also means it runs fine from a
  `runtime: node` cron service that only carries `DATABASE_URL`, the same way
  `cleanup:snapshots` does.
- **It is slower there.** ~40k `INSERT`s, one round trip each. That is ~16s
  against a local Postgres and closer to a few minutes over a network hop to a
  managed database. Let it finish; it prints progress.
- **In the Docker image, call `node` directly.** The runtime image deletes npm
  (see the Dockerfile), so `npm run seed:treaties` will not work there:
  `node server/scripts/seedTestTreaties.js`. The script *is* in the image —
  `.dockerignore` excludes tests and docs, not `server/scripts/`.
- **Migrations first.** `preDeployCommand` already runs them; the script only
  reads the schema, it never creates it.

### The production guard

Seeding refuses to run when `NODE_ENV=production` unless
`SEED_ALLOW_PRODUCTION=1` is set, and prints the (password-redacted) target
first. This is a real foot-gun otherwise: the web service's `DATABASE_URL` is
the live database, and 100 fabricated treaties show up in the dashboards, home
summary, portfolio exports and country aggregates that everyone sees.

`--verify` (read-only) and `--reset-only` are never blocked — the undo has to
work even when the guard would have said no.

## Determinism

The generator is seeded (`SEED_RANDOM_SEED`, default `20260820`), so two runs
against the same reference data produce the identical portfolio — useful when
comparing numbers between machines. The draw depends on what it reads, so a
database with extra cedants or treaty types (a test run leaves some behind)
will land on a different mix. `SEED_PROP_COUNT` and `SEED_NP_COUNT` change the
volumes.

## Sentinel and cleanup

Every seeded contract carries `import_metadata->>'source' = 'seed:test-treaties'`
— that is the delete key used by `--reset`, and it is already indexed. It is
deliberately *not* `contract_description`, which is left free for a readable
treaty name.

```sql
SELECT count(*) FROM public.contract WHERE import_metadata->>'source' = 'seed:test-treaties';
```

## "All fields have data"

Every column of every table the seed writes is populated on every seeded row.
`npm run seed:treaties:verify` proves it: it walks 60 tables / ~670 columns and
reports any unexpected NULL, exiting non-zero if it finds one.

Four groups of columns are deliberately left NULL, and are listed in
`EXPECTED_NULLS` in the script:

- `contract.source_quote_id` — these are direct treaties, not bound from a
  quote; pointing the column at a non-existent quote would dangle.
- `contract.parent_contract_id` — NULL on the first year of each renewal
  lineage only.
- The status-exclusive terminals (`signed_at`/`signed_line_pct`, `ntu_at`/
  `ntu_reason`, `declined_at`/`decline_reason`, and their `contract_offer`
  mirrors) — a contract is in exactly one terminal state, so only that state's
  columns are filled. All five statuses appear across the portfolio.
- `quote_id` on contract-owned rows — a `CHECK (num_nonnulls(contract_id,
  quote_id) = 1)` forbids filling both.

`contract_document` is not seeded at all: those rows describe uploaded files,
and metadata without a blob gives you a documents tab that 404s on download.
