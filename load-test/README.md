# Load test — k6 portfolio script

> Looking for the **concurrent underwriter simulation** (N real sessions
> modelling treaties end-to-end with PUT→GET verification of every save)?
> That lives in [`agents/`](agents/README.md) — `npm run loadtest:agents`.

Two k6 scripts exercise the hot paths of the reinsurance tool:

* `k6/smoke-10vu.js` is the real operator smoke profile: 5-10
  concurrent users for release checks and migration verification.
* `k6/portfolio.js` is the stress/knee-finding profile at 30-300 VUs.
* `k6/capacity.js` is the staging capacity profile. Run it at 10, 20,
  30, and 50 VUs against production-shape data to answer "what user load
  can this support?"

## Findings (August 2026) — 100 concurrent users, local

`capacity.js` at 100 VUs for 5 minutes (`npm run loadtest:100vu`) against a
local dev server (Node + local Postgres 16, `LOAD_TEST=true`, 1200 seeded
contracts / 400 quotes, 100-account login pool, WRITE_CRUD on). Raw
export: `out/2026-08-28-local-100vu.json`.

* **102,868 requests at ~338 req/s, 0.00% errors, 100% of 95,335 checks
  passed.** Every latency threshold cleared with a wide margin (overall
  p95 31ms; dashboard, the heaviest read, p95 58ms).
* **The only threshold crossed was `pg_pool_waiting max<1`** (max 59,
  p99 25, non-zero on 80 of ~1,900 deep-health samples) — the same knee
  the June staging runs found: at 100 concurrent users the Postgres
  connection pool (`DB_POOL_MAX` default 50) queues briefly under
  spikes, without producing request failures. The multi-second max
  outliers on a few read endpoints line up with those queueing bursts.
* Conclusion unchanged from June: ~100 concurrent users is where pool
  queueing starts. The first lever is pool/PgBouncer sizing
  (`DB_POOL_MAX`), not hardware.

### Pool-sizing confirmation run (same day)

Identical run with Postgres `max_connections=400` and `DB_POOL_MAX=150`
(raw export: `out/2026-08-28-local-100vu-pool150.json`): the queueing
signal collapses — `pg_pool_waiting` max 59 → **5**, non-zero samples
80 → **3** (all during pool ramp-up), p99 25 → **0** — again at 0.00%
errors and ~338 req/s, with p99 tails tightening (treaty detail 127 →
78ms, quote list 58 → 41ms). This confirms the knee is pool
configuration with nothing behind it at this load. The residual
multi-second max outliers appear in both runs and cluster at ramp: they
are the 100-login scrypt burst saturating the 4-thread libuv pool, not
the database. Note the companion agents run (write-heavy burst, same
pool change) shows the flip side: on a CPU-bound single container a
bigger pool trades app-side queueing for in-database contention — size
the pool against the real DB host's cores (or use PgBouncer), don't
just crank it.

| endpoint | p50 ms | p95 ms | p99 ms | max ms |
| --- | ---: | ---: | ---: | ---: |
| health | 1 | 6 | 16 | 98 |
| lookups | 3 | 11 | 31 | 4062 |
| treaty_list | 15 | 36 | 67 | 4403 |
| quote_list | 8 | 24 | 58 | 322 |
| treaty_detail | 10 | 33 | 127 | 4452 |
| prop_pricing | 5 | 20 | 74 | 342 |
| quote_pricing | 4 | 17 | 60 | 304 |
| np_structure | 7 | 28 | 83 | 4280 |
| np_pricing | 5 | 22 | 54 | 455 |
| dashboard | 29 | 58 | 95 | 284 |
| agg_drilldown | 10 | 37 | 91 | 767 |

## Findings (June 2026)

A full write-up of the latest capacity run (Render + Neon, tested from
Riyadh) sits at the top of `k6/capacity.js`. Headline: the stack
comfortably handles the intended ~10-20 concurrent underwriters at 0%
errors with large headroom. The only ceiling found was the Postgres
connection pool, which first queued briefly at ~100 concurrent VUs
(`pg_pool_waiting` peaked 18) — a pool-config limit, not a
hardware/compute one. See `k6/capacity.js` for the per-VU numbers and
the ordered scaling levers.

## What it hits

| Surface                     | Share of iterations | Why it matters                                     |
| --------------------------- | ------------------- | -------------------------------------------------- |
| Cached lookups (brokers, …) | 100%                | Ref cache + ETag path — the hottest reads          |
| `GET /api/quotes` list      | 100%                | Indexed filter + pagination                        |
| Quotes CRUD (POST/PUT/GET/DELETE) | 30%            | Write path + pool pressure                         |
| `/api/dashboard/page/portfolio-overview` | 20%      | Heaviest read (GROUP BY over the whole portfolio)  |

## 5-10 VU smoke profile

Run this first for the requested production-like concurrency check:

```bash
npm run loadtest:10vu
k6 run -e BASE_URL=https://staging.example.com load-test/k6/smoke-10vu.js
```

| Stage | Duration | Target VUs | Purpose                         |
| ----- | -------- | ---------- | ------------------------------- |
| 1     | 30s      | 5          | Warm-up to low real concurrency |
| 2     | 2m       | 5          | Steady operator load            |
| 3     | 30s      | 10         | Ramp to peak expected load      |
| 4     | 2m       | 10         | Hold peak expected load         |
| 5     | 30s      | 0          | Cool-down                       |

## Stress profile

| Stage | Duration | Target VUs | Purpose                          |
| ----- | -------- | ---------- | -------------------------------- |
| 1     | 30s      | 30         | Warm-up to expected concurrency  |
| 2     | 1m       | 30         | Steady state — baseline demo load|
| 3     | 30s      | 100        | Spike (3× planned)               |
| 4     | 1m       | 100        | Hold the spike                   |
| 5     | 30s      | 300        | Stress (10× planned) — find knee |
| 6     | 1m       | 300        | Hold the stress                  |
| 7     | 30s      | 0          | Cool-down                        |

Total: **~5 minutes** per run.

## Thresholds (pass/fail)

The test fails the run if any of these are breached — pick them up in
CI to catch regressions:

* `http_req_failed   rate < 1%`
* `p95 health < 100ms`
* `p95 lookups < 300ms`
* `p95 quote_list < 500ms`
* `p95 quote_crud < 800ms`
* `p95 dashboard < 1500ms`

## Running it

### Prerequisites

1. The app must be running and reachable. The test defaults to
   `http://127.0.0.1:3001`; override with `BASE_URL`.
2. Postgres must be seeded — the dashboard endpoint needs real data
   to exercise the aggregation path.

### Install k6

Pick one:

```bash
# Native (fastest)
brew install k6                 # macOS
sudo apt-get install k6         # Debian/Ubuntu (after adding the grafana repo)
winget install k6               # Windows

# Docker (no install required)
alias k6='docker run --rm -i --network=host grafana/k6'
```

### Run

```bash
# From the repo root
npm run loadtest

# Or directly
k6 run load-test/k6/portfolio.js

# Against a different deployment
k6 run -e BASE_URL=https://staging.example.com load-test/k6/portfolio.js

# Save the raw summary for later diffing / CI artifacts
mkdir -p load-test/out
k6 run \
  --summary-export=load-test/out/$(date +%F-%H%M).json \
  load-test/k6/portfolio.js
```

### Staging capacity runs

The capacity profile discovers treaty and quote IDs from staging. If the
database is filtered, pass explicit comma-separated IDs:

```bash
export BASE_URL=https://<staging-service>.onrender.com
export K6_DURATION=5m

mkdir -p load-test/out
for vus in 10 20 30 50; do
  K6_VUS=$vus k6 run \
    --summary-export=load-test/out/staging-${vus}vu.json \
    load-test/k6/capacity.js
done

npm run loadtest:summarize -- load-test/out/staging-*vu.json
```

Useful optional inputs:

```bash
CONTRACT_IDS=<uuid>,<uuid>
QUOTE_IDS=<uuid>,<uuid>
NP_CONTRACT_IDS=<uuid>,<uuid>
NP_QUOTE_IDS=<uuid>,<uuid>
COUNTRY_IDS=<uuid>,<uuid>
WRITE_CRUD=0        # disable create/update/delete quote flow
```

### High-VU runs need a pool of login accounts

The login brute-force limiter is keyed per IP + submitted identity
(5 attempts / 15 min, `createLoginLimiter` in `server/src/app.js`) and is
NOT covered by the `LOAD_TEST=true` bypass — so N VUs sharing one
`LOAD_USER` from one address hit 429s on login after the fifth VU. For
anything above ~5 VUs, seed a pool of accounts and fan the VUs across it
(one login per identity):

```bash
# Seed loadtest001..loadtest100 (idempotent; local/staging only)
DATABASE_URL=postgres://… LOAD_PASS=<password> npm run seed:loadusers

# Run with the pool — VU N logs in as loadtest001..loadtest100
LOAD_USER_PREFIX=loadtest LOAD_USER_COUNT=100 LOAD_PASS=<password> \
  npm run loadtest:100vu
```

`LOAD_USER_PREFIX` takes precedence over `LOAD_USER`; `LOAD_USER_PAD`
(default 3) controls the zero-padding. `npm run loadtest:100vu` is the
capacity profile pinned at 100 VUs ("100 concurrent users").

The run records `pg_pool_waiting` by sampling `/api/health/deep`. Any
non-zero max is the knee unless it is a single-sample deploy blip.

## Interpreting results

After the run k6 prints a summary; the signal is in:

* **`http_req_failed`** — should be near 0. A non-zero rate at 300 VUs
  usually means the DB pool is saturated (check `X-Pool-Waiting` on
  `/api/health/deep` during the run) or the per-user rate limiter is
  firing (see the `c_rate_limited` counter in the summary).
* **`http_req_duration{endpoint:…}`** — per-endpoint p95/p99. If
  `quote_crud` degrades before `quote_list`, the DB pool is the
  bottleneck; if `dashboard` degrades first, add an index or move it
  to a materialised view.
* **`c_rate_limited`** — count of 429 responses. If this is > 0, the
  synthetic user id fan-out isn't wide enough (each VU should have a
  unique bucket) or the app's own limit needs adjusting.

## When to re-run

* Before every release candidate that touches routes, pool config, or
  hot paths
* After any migration that adds an index or rewrites a query on the
  dashboard / quotes / non-prop routes
* When changing Node or Postgres major versions

## What this does NOT cover

* Memory leaks over hours — run k6 with `--duration=60m` separately if
  that's what you're hunting
* Cold-cache behaviour — the ramp is long enough to warm most caches
  well before the 100-VU stage
* Browser perf — this is pure server load. For UI work use Lighthouse
* Multi-instance behaviour — we're still single-process. If we ever
  front-end with PM2/nginx, add a test that pins `Connection: close`
  to verify load-balancer fan-out
