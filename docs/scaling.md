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

> **Auth caveat — read before running k6.** The load scripts
> (`load-test/k6/*.js`) currently send identity via `x-user-role` / `x-user-id`
> **headers**. After the auth hardening those headers are honoured **only** when
> the target runs with `ALLOW_DEMO_AUTH=true` (a dev/preview service); against a
> production-config service they are ignored and protected endpoints return 401 —
> the run would then measure error responses, not real work. So either point k6
> at a preview service started with `ALLOW_DEMO_AUTH=true`, or first update the
> scripts to log in via `POST /api/auth/login` and send the returned
> `Authorization: Bearer` token. Record which mode was used next to the results.

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

mkdir -p load-test/out

k6 run -e BASE_URL=$BASE_URL \
  --summary-export=load-test/out/staging-smoke-10vu.json \
  load-test/k6/smoke-10vu.js

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

Fill this table from `npm run loadtest:summarize` after the staging run.

| Run | Error rate | `pg_pool_waiting` max | CPU peak | Knee? | Notes |
| --- | ---: | ---: | ---: | --- | --- |
| Smoke 10 VUs | Not run | Not run | Not run | Unknown | Blocked: no staging target in this workspace |
| 10 VUs | Not run | Not run | Not run | Unknown | Blocked: no staging target in this workspace |
| 20 VUs | Not run | Not run | Not run | Unknown | Blocked: no staging target in this workspace |
| 30 VUs | Not run | Not run | Not run | Unknown | Blocked: no staging target in this workspace |
| 50 VUs | Not run | Not run | Not run | Unknown | Blocked: no staging target in this workspace |

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
* Prefer reducing query hold time over blindly increasing pool size.
* Do not add app workers when the database is already the bottleneck.

First optimization when more headroom is needed:

Run the 30 VU profile, identify the slowest endpoint with p95 above
500 ms, capture its SQL plan on staging data, and add the narrowest
index or cache that improves that endpoint. Re-run 30 VUs and 50 VUs
before changing production capacity.
