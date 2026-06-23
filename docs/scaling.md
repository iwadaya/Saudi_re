# Scaling And Capacity

This page is the operating record for capacity testing. It intentionally
uses measured staging runs, not theoretical single-box estimates.

## Current Capacity Answer

Status as of **2026-06-14** (commit `177a1e6`): **unmeasured** — still no
staging run.

The staging benchmark has not been run from any workspace available so far:
no staging `BASE_URL` / Render access, no production-shape staging database,
and no `k6` binary or local app+DB on `127.0.0.1:4000` to run it against.
The numbers below remain templates, not evidence.

Do not quote a supported user count until the staging run in **How To Run**
is completed and the **Measured Results** table is filled from real output.
The old theoretical PM2 numbers were removed so estimates are never mistaken
for measurements.

> **Auth — the load scripts use the REAL production login flow (cookie + CSRF).**
> The k6 scripts (`load-test/k6/*.js`, via `load-test/k6/lib/auth.js`) log in with
> `POST /api/auth/login`, then ride the httpOnly `auth_token` cookie (k6's per-VU
> cookie jar) and send the double-submit `X-CSRF-Token` header on mutations — the
> same path a browser uses against a production-config service. They do **not**
> send `x-user-role` / `x-user-id` demo headers (a production target ignores those
> and would return 401, measuring error responses, not real work).
>
> Provide a real account on the target via env: `LOAD_USER` and `LOAD_PASS`. Seed
> a dedicated load-test user in staging (any role; a read-heavy run needs no
> elevated rights). Record the auth mode ("prod cookie+CSRF") and the account used
> next to the results. Note: the API rate-limits per authenticated user id, so a
> single shared load account concentrates that limit — set `LOAD_TEST=true` on the
> staging service to bypass the limiter when measuring raw capacity (never in prod).

## Required Staging Shape

Use the same Render service shape and connection-pool sizing as
production.

Minimum data shape:

| Data | Minimum |
| --- | ---: |
| Treaties | 1,000 |
| Layers | 5,000 |
| Loss rows | 100,000 |
| Cedants | 20 |
| Countries | Production-like spread |
| Treaty mix | Proportional, non-proportional, quote, bound |

Prefer anonymized production data. If that is not practical, generate a
seed with the same cardinality and distributions before running k6.

## Load Model

The 30-user target is roughly 30 user actions per minute on average,
with bursts from screen loads and saves. In k6 terms, use:

| Run | Purpose |
| --- | --- |
| 10 VUs | Smoke and warm-cache baseline |
| 20 VUs | Sustained expected load |
| 30 VUs | Required concurrency target |
| 50 VUs | Burst and knee discovery |

The knee is the first run where either p95 latency starts climbing
super-linearly or `pg_pool_waiting` is non-zero for more than a deploy
blip.

## How To Run

From the repo root:

```bash
export BASE_URL=https://<staging-service>.onrender.com
export K6_DURATION=5m
# Real account on the target (seed one in staging). Auth is cookie + CSRF.
export LOAD_USER='loadtest@example.com'
export LOAD_PASS='<the-account-password>'

mkdir -p load-test/out

k6 run -e BASE_URL=$BASE_URL \
  --summary-export=load-test/out/staging-smoke-10vu.json \
  load-test/k6/smoke-10vu.js

# Capacity baseline at each VU count. capacity.js logs in (cookie+CSRF),
# parameterises VUs via K6_VUS, and records pg_pool_waiting from /api/health/deep.
for vus in 10 20 30 50; do
  K6_VUS=$vus k6 run \
    --summary-export=load-test/out/staging-${vus}vu.json \
    load-test/k6/capacity.js
done

npm run loadtest:summarize -- load-test/out/staging-*vu.json
```

If staging discovery cannot find enough realistic records, pass IDs:

```bash
CONTRACT_IDS=<uuid>,<uuid> \
QUOTE_IDS=<uuid>,<uuid> \
NP_CONTRACT_IDS=<uuid>,<uuid> \
NP_QUOTE_IDS=<uuid>,<uuid> \
COUNTRY_IDS=<uuid>,<uuid> \
K6_VUS=30 \
k6 run --summary-export=load-test/out/staging-30vu.json load-test/k6/capacity.js
```

Capture these alongside the k6 summary:

| Signal | Source |
| --- | --- |
| p50/p95/p99 per endpoint | k6 summary JSON |
| Error rate | `http_req_failed` in k6 |
| `pg_pool_waiting` peak | k6 `pg_pool_waiting` and `/api/health/deep` |
| CPU utilization | Render service metrics for the same time window |
| DB CPU/connections | Render Postgres metrics for the same time window |

## Measured Results

Fill this table from `npm run loadtest:summarize` after the staging run. The
scripts now authenticate via the **real production login (cookie + CSRF)**, so a
run measures real work, not 401s. Record the auth mode + load account used.
**Do not quote a supported user count here until these rows are filled from real
evidence** (left blank deliberately).

| Run | Error rate | `pg_pool_waiting` max | CPU peak | Knee? | Notes (auth: prod cookie+CSRF) |
| --- | ---: | ---: | ---: | --- | --- |
| Smoke 10 VUs | Not run | Not run | Not run | Unknown | Pending staging run |
| 10 VUs | Not run | Not run | Not run | Unknown | Pending staging run |
| 20 VUs | Not run | Not run | Not run | Unknown | Pending staging run |
| 30 VUs | Not run | Not run | Not run | Unknown | Pending staging run |
| 50 VUs | Not run | Not run | Not run | Unknown | Pending staging run |

Endpoint table template:

| VUs | endpoint | p50 ms | p95 ms | p99 ms | max ms |
| ---: | --- | ---: | ---: | ---: | ---: |
| 30 | treaty_list | TBD | TBD | TBD | TBD |
| 30 | quote_list | TBD | TBD | TBD | TBD |
| 30 | treaty_detail | TBD | TBD | TBD | TBD |
| 30 | prop_pricing | TBD | TBD | TBD | TBD |
| 30 | quote_pricing | TBD | TBD | TBD | TBD |
| 30 | np_structure | TBD | TBD | TBD | TBD |
| 30 | np_pricing | TBD | TBD | TBD | TBD |
| 30 | dashboard | TBD | TBD | TBD | TBD |
| 30 | agg_drilldown | TBD | TBD | TBD | TBD |

## Optimization Log

No load-test-driven optimizations were applied in this pass because no
staging run was available. For each endpoint with p95 above 500 ms at
30 VUs, add an entry here:

| Endpoint | Before p95 | Change | After p95 | Verification run |
| --- | ---: | --- | ---: | --- |
| TBD | TBD | TBD | TBD | TBD |

Optimization order:

1. Confirm whether `pg_pool_waiting` was non-zero. If yes, treat pool or
   query hold time as the bottleneck before adding app workers.
2. Run `EXPLAIN (ANALYZE, BUFFERS)` for the slow endpoint query against
   staging data.
3. Add a missing composite or partial index only when the plan proves it.
4. Cache only stable reads such as lookups, market averages, and
   aggregate drilldowns with a clear invalidation rule.
5. Re-run the same VU level and record before/after p95.

### Code-level optimization backlog (static analysis, pre-staging)

These came from a read-through of the hot paths, not a staging run, so they
are split into "applied" (safe, behaviour-preserving, covered by existing
tests) and "candidates" (need the measurement gate above before landing).
Capacity numbers are still **unmeasured** — nothing here quotes a user count.

**Applied**

| Area | Change | Why it helps | Verification |
| --- | --- | --- | --- |
| Pricing save (`pricingOutputsRepository.js`) | Replaced the per-row `await INSERT` loops for `contract_pricing_yearly`, `pricing_components`, and `pricing_share_scenarios` with one `buildBatchInsert` multi-row INSERT each | Cuts DB round-trips on the save transaction from O(rows) to O(1) per child table, shortening connection-hold time — the pool is the documented first ceiling | `npm run test:server` (1202 tests) green incl. `contractPersistence.integration` round-trip; before/after p95 still TODO at staging |
| Pricing save (`repositoryUtils.js`) | Memoized `getPricingSchemaFlags` (was two `information_schema` queries on every save) | Removes two catalog queries from each save's critical path; schema is fixed after startup migrations. Mirrors the existing `getCobCols` cache | Same suite; memo dedupes the in-flight promise and clears on error |

**Candidates — verify with the gate above before landing**

| Rank | Area | Candidate | Guardrail |
| --- | --- | --- | --- |
| 1 | Dashboard portfolio-overview (`routes/dashboard.js`) | The 7 parallel aggregates each re-declare the same `units` CTE; materialize it once (temp table / single CTE) and run the cheap SELECTs from it. Also single-pass the 3× `buildPivot` scans over the same row set | Measure p95 at 30 VUs first; behaviour-preserving refactor, needs an EXPLAIN/ANALYZE before/after |
| 2 | Portfolio reads (`portfolioInsights.js`, `reinsurerAnalysis.js`, `lookups.js` cedant-summary) | Add `jsonCache()`/ETag — large stable reads recomputed every request | Cache only with a clear invalidation rule (bust on quote bind / decision); these are decisioned-book reads, so stale data is a correctness risk — design invalidation first |
| 3 | Index candidates | `contract (country_id, uw_status)`, `contract_pricing_outputs (contract_id, updated_at DESC)` for the DISTINCT-ON latest-per-contract reads | **Only add when `EXPLAIN (ANALYZE, BUFFERS)` on staging data proves the seq scan** (team rule) |
| 4 | Renewal-pack Excel export (`routes/renewalPack.js`) | Large workbook built inline on the request thread with unbounded row queries; stream rows in batches or offload to a job | Memory/event-loop risk under concurrency; needs a job-queue decision before building |
| 5 | Market-average tiers (`pricingAggregateRepository.js`) | 5-tier fallback runs sequentially per pricing workflow; cache deterministic result keyed on `(countryId, treatyTypeId, cobIds)` | Redis cache + bust on pricing save; verify tier-fallback semantics unchanged |
| 6 | Client (`LossListScreen.jsx`, `useLossParetoDerived.js`, `AppContext.jsx`) | Virtualize large loss tables; debounce Pareto fitting off keystroke; split AppContext to cut wide re-renders | Front-end perf, separate workstream; measure with the frontend budget + React profiler |

## Supported User Count

Do not fill this in until the 10/20/30/50 VU sequence has measured
results.

| Supported load | Evidence |
| --- | --- |
| TBD users | Awaiting staging run |

Decision rule:

* Supported: 30 VUs has error rate below 1%, no sustained
  `pg_pool_waiting`, and all bind-path p95 values under 500 ms except
  dashboard/aggregate endpoints, which must stay under 1500 ms.
* Marginal: 30 VUs passes functionally but one or more bind-path p95s
  exceed 500 ms. Optimize those endpoints before declaring support.
* Not supported: any non-transient 5xx/429 rate, sustained
  `pg_pool_waiting`, or p95 knee before 30 VUs.

## Runbook: pg_pool_waiting Non-Zero

`pg_pool_waiting > 0` means requests are queued waiting for a Postgres
connection. It is the leading indicator that user-facing latency is
about to fan out.

Immediate triage:

1. Check `/api/health/deep` and Render Postgres connection graphs for
   the same minute.
2. Confirm whether app CPU is low while latency is high. Low CPU plus
   waiting connections usually means the database is the bottleneck.
3. Check active SQL:

```sql
SELECT pid, state, wait_event_type, wait_event, now() - query_start AS age, query
FROM pg_stat_activity
WHERE datname = current_database()
ORDER BY age DESC
LIMIT 20;
```

4. Check slow statements if `pg_stat_statements` is enabled:

```sql
SELECT calls,
       round((total_exec_time / NULLIF(calls, 0))::numeric, 2) AS mean_ms,
       round(max_exec_time::numeric, 2) AS max_ms,
       rows,
       query
FROM pg_stat_statements
ORDER BY total_exec_time DESC
LIMIT 20;
```

5. If one query dominates, optimize that query or add the proven index.
   If many short queries are queued, increase pool/database capacity.

Safe mitigations:

* Raise `DB_POOL_MAX` only if Postgres `max_connections` and memory have
  headroom.
* In PM2 cluster mode, remember `DB_POOL_MAX` is per worker. Four
  workers with `DB_POOL_MAX=20` can open 80 app connections.
* In any multi-instance setup (PM2 cluster or multiple hosts) set
  `REDIS_URL` so the rate limiters share counts — otherwise each worker
  keeps its own in-memory counts and N workers allow N× the intended
  ceiling, most dangerously on the login route. See
  `server/src/lib/rateLimitStore.js`.
* Prefer reducing query hold time over blindly increasing pool size.
* Do not add app workers when the database is already the bottleneck.

First optimization when more headroom is needed:

Run the 30 VU profile, identify the slowest endpoint with p95 above
500 ms, capture its SQL plan on staging data, and add the narrowest
index or cache that improves that endpoint. Re-run 30 VUs and 50 VUs
before changing production capacity.
