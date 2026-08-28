# Agents modelling treaties — concurrent underwriter simulation

A dependency-free Node harness that plays **N real underwriters modelling a
treaty portfolio at the same time**. Unlike the k6 profiles next door (pure
load), every agent here is also an auditor: **after every PUT/POST it GETs the
entity back and field-checks the round trip**, so one run is simultaneously a
concurrency test, an API-contract test and a data-fidelity audit.

Each agent is a real authenticated session — passwordless name-login, the
httpOnly `auth_token` cookie, the CSRF double-submit header on every mutation —
exactly what the SPA does.

## What each underwriter does

* create treaties (PROP and NP), then save terms **slice by slice** the way the
  wizard screens do: header + detail → commissions (incl. sliding table) →
  structure (loss participation, COBs, EPI split, UW limits); NP treaties go
  through `non-prop/save` (layers, NP detail, COB limits)
* save premium/paid/OS **triangles** (MODIFIED + ACTUAL variants), dev factors,
  large + cat losses; assert the staleness contract (fresh after factor save,
  stale after the source triangle moves)
* walk the **workflow** DRAFT → AWAITING_APPROVAL → AWAITING_SIGNED_LINE →
  SIGNED, probe illegal jumps (422) and terminal-state freezes, check the
  history trail
* **renew** signed treaties (the renewal counts toward the portfolio) and
  verify the renewal contract: parent link, rolled dates/uw-year, copied COB
  set, copied description, **blank** financial terms, assignee = renewer,
  parent untouched
* run the **quote** flows: create (QT-ref check), full-terms save + round-trip,
  quote renewal (parent link + rolled period), then one of amend (v2 +
  SUPERSEDED original + copied terms), submit-for-approval, decline
  (+ re-decline self-transition, revive → 422), or delete (child gone,
  original survives)
* work the **documents tab** on every base treaty: multipart-upload a seeded
  PDF slip + CSV bordereau through the content-sniffing validator, list them,
  download each back and compare **sha256 against the uploaded bytes**, delete
  the bordereau and verify 404 + list removal; once per agent, upload probes:
  blocked extension → 415, spoofed `.pdf` content → 422, anonymous download →
  401, peer (non-assignee) delete → 403 with the document surviving
* adversarial probes on every treaty: stale-baseline saves (409 STALE_WRITE +
  payload must NOT land), **same-baseline concurrent PUT races** (exactly one
  winner allowed), peer write/delete → 403, anonymous write → 401/403, peer
  read → 200, malformed payloads → 400
* list endpoints: filters, pagination limits, `X-Total-Count` consistency

The orchestrator distributes the portfolio across agents (≈60 base + 40
renewals for the default 100), runs all workbooks **fully concurrently**,
samples `/api/health/deep` for pool pressure, and writes a JSON report with
per-endpoint latency percentiles, status counts, and every failed check.

## Running it

The server needs name-login enabled (real sessions for every agent) and the
shared-IP API limiter lifted (all agents come from one host):

```bash
createdb universe_agents_sim
DATABASE_URL=postgresql://localhost:5432/universe_agents_sim npm run migrate --prefix server

TZ=UTC PORT=4600 DATABASE_URL=postgresql://localhost:5432/universe_agents_sim \
  ALLOW_NAME_AUTH=true LOAD_TEST=true node server/src/index.js
```

then:

```bash
npm run loadtest:agents                  # 40 agents, 100 treaties
node load-test/agents/run.js --agents 40 --treaties 100 \
  --base-url http://127.0.0.1:4600 --seed 20260823 --out load-test/out/agents-run.json
```

Exit code is non-zero when any check fails. Runs are deterministic per seed.
Use a **disposable database** — the run creates users, contracts and quotes.

## Findings (August 2026, 100 underwriters × 250 treaties)

The "can it take 100 underwriters at peak renewal" run: 100 **distinct**
name-login accounts, fully concurrent, on a dev container (single process,
pool max 50). Report: `load-test/out/agents-run-100uw.json`, seed 20260828.

* **28,514 / 28,514 checks passed** — 10,889 PUT→GET field round-trips,
  3,050 document checks, 1,425 partial-save-safety, 1,100 permission
  probes, 100/100 same-baseline write races landing exactly one winner
  (200+409). 10,648 HTTP calls, **zero 5xx, zero transport errors** (every
  4xx in the status mix is a deliberate adversarial probe).
* The whole 250-contract portfolio — slice saves, triangles, losses,
  workflow to SIGNED, 100 renewals, 175 quotes, 300 document uploads with
  byte-identical downloads — was modelled in a **23s concurrent burst**,
  i.e. far denser traffic than 100 humans produce over a renewal morning.
* Write-path latencies under that burst: `PUT /treaties/:id` p95 365ms,
  triangle saves p95 317ms, document upload p95 277ms, download p95 322ms,
  quote save p95 377ms. `POST /treaties` p95 1.3s is the outlier (create
  contends on reference/audit writes at full parallelism).
* `pg_pool_waiting` peaked at **79** — the write-heavy version of the same
  pool knee the k6 capacity runs found at 100 VUs (pool max 50). No
  failures resulted, but sizing `DB_POOL_MAX`/PgBouncer above expected
  concurrency remains the first lever before a real 100-user peak.

## Findings (August 2026, 40 agents × 100 treaties)

Reports: `load-test/out/agents-run-full-baseline.json` (pre-fix),
`agents-run-full-fixed.json` + `agents-run-full-confirm.json` (post-fix).

* **Lost-update race in treaty/quote PUT — found, fixed, regression-locked.**
  `assertEntityUnchanged` takes a `FOR UPDATE` row lock that only holds inside
  an open transaction, but the two flagship writers (`PUT /api/treaties/:id`,
  `PUT /api/quotes/:id`) called it **before** `BEGIN` — the lock lived in an
  implicit single-statement transaction and released immediately. Two
  concurrent saves carrying the same `If-Unmodified-Since` baseline could both
  pass the check; the second silently overwrote the first. The baseline run
  reproduced this in **39 of 40 races** (outcome `200+200`). Every other
  optimistic-lock call site in the codebase already asserted after `BEGIN`.
  Fix: move the assert inside the transaction in both routes. Post-fix runs:
  **40/40 races land `200+409`**, and
  `server/tests/integration/optimisticLockRace.integration.test.js` races 8
  same-baseline saves per entity in CI to keep it that way.
* **Everything else held under full concurrency.** Across ~3,580 HTTP calls
  per run: zero 5xx, zero transport errors, and 10,187–10,196 checks green —
  4,355 PUT→GET field round-trips, 570 partial-save-safety checks (a slice
  save never disturbs sibling slices), 440 permission probes, 760 renewal
  invariants, all workflow legality checks.
* **Capacity at 40 concurrent modellers is comfortable** on a dev container
  (single process, pool max 50): worst p95s at full parallelism were
  `PUT /treaties/:id` ≈ 250ms and `GET /treaties/:id` ≈ 210ms,
  `pg_pool_waiting` stayed 0 throughout. Consistent with the k6 capacity
  findings (the knee is pool config, well above this load).
* **DB state after a run is exactly the modelled portfolio**: 100 contracts
  (60 base + 40 renewals, 40 SIGNED with 3 workflow events each), 80 quotes
  (10 SUPERSEDED by amend, 10 DECLINED, 10 renewals deleted), 6,600 triangle
  cells, 0 orphaned child rows, 0 unassigned contracts.

## Files

| File | Role |
| --- | --- |
| `run.js` | orchestrator: logins, quota split, concurrency, pool sampler, report |
| `underwriter.js` | the agent persona (modelling workbook + adversarial probes) |
| `lib/http.js` | per-agent session: cookie jar, CSRF header, latency capture |
| `lib/check.js` | assertion collector + type-aware round-trip comparators |
| `lib/gen.js` | seeded generators: treaty/quote terms, triangles, factors, losses |

## What this does NOT cover

* the multi-approver engine (peer/arbiter decisions, mandates) — agents sign
  via the status-machine path, which enforces transition legality only
* pricing computation endpoints (covered by the golden-master suites)
* renewal-pack import (multi-file AI-assisted flow; plain document
  upload/download IS covered by the documents phase)
* browser behaviour — this is the API surface only
