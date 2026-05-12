# Observability

Traces + metrics via OpenTelemetry. Off by default; one env var
(`OTEL_ENABLED=1`) turns the whole stack on without code changes.

## What you get

When enabled, the server emits:

| Signal              | Where                                              | How                                                                    |
| ------------------- | -------------------------------------------------- | ---------------------------------------------------------------------- |
| HTTP server traces  | OTLP/HTTP → `${OTEL_EXPORTER_OTLP_ENDPOINT}/v1/traces` | Auto-instrumented by `@opentelemetry/instrumentation-http`             |
| Express route spans | Same                                               | Auto-instrumented; route path is the span name                         |
| Postgres query spans | Same                                              | Auto-instrumented; SQL text included, parameter values redacted        |
| Node runtime metrics | Prometheus scrape on `:9464/metrics`             | Process CPU, RSS, event-loop lag, GC pauses                            |
| **Pool gauges**     | Same Prometheus endpoint                           | `pg_pool_size`, `pg_pool_idle`, `pg_pool_waiting` — the bottleneck signals |

What's **not** emitted (deliberately):

- `/api/health` and `/api/metrics` traces — they'd drown signal from real traffic
- `fs.*` spans — too noisy, little insight
- SQL parameter values — `enhancedDatabaseReporting: false` keeps cedant
  names, premiums, etc. out of your APM

## Enabling it

```bash
# Minimum: install once (OpenTelemetry is an optionalDependencies block;
# on the demo box npm install picks it up automatically)
cd server && npm install

# Turn it on (example pointing at a local OTel collector)
OTEL_ENABLED=1 \
OTEL_SERVICE_NAME=universe-server \
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 \
npm start
```

When the SDK starts you'll see a single `[otel] started — service=…`
log line. If the OTel deps aren't installed or initialisation fails,
you'll see `[otel] initialisation failed, continuing without tracing`
— the app boots anyway. **Tracing never takes the app down.**

## Ready-to-copy platform recipes

### A. Grafana Cloud (free tier, no infra)

One account, one endpoint, traces and metrics flow in without running
anything locally. Good for demos.

```bash
# Sign up at grafana.com, create a stack, find your "OpenTelemetry
# Protocol" endpoint under the stack → Details pane.
OTEL_ENABLED=1
OTEL_EXPORTER_OTLP_ENDPOINT=https://otlp-gateway-prod-<region>.grafana.net/otlp
OTEL_EXPORTER_OTLP_HEADERS="Authorization=Basic <base64 of instance:token>"
OTEL_SERVICE_NAME=universe-server
```

Traces land in Grafana → Explore → Tempo. Metrics land in Grafana →
Explore → Prometheus. No local components required.

### B. Local Jaeger + Prometheus (full control, offline demo)

Add a second compose file with the observability stack. Start it
alongside the app:

```yaml
# docker-compose.observability.yml
services:
  jaeger:
    image: jaegertracing/all-in-one:latest
    environment:
      COLLECTOR_OTLP_ENABLED: 'true'
    ports:
      - '16686:16686'  # UI
      - '4318:4318'    # OTLP/HTTP
  prometheus:
    image: prom/prometheus:latest
    volumes:
      - ./docs/prometheus.yml:/etc/prometheus/prometheus.yml:ro
    ports:
      - '9090:9090'
```

Run:

```bash
docker compose -f docker-compose.yml -f docker-compose.observability.yml up
OTEL_ENABLED=1 OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 npm start
```

Jaeger UI at http://localhost:16686, Prometheus at http://localhost:9090.
Point Prometheus at the server's scrape endpoint:

```yaml
# docs/prometheus.yml
scrape_configs:
  - job_name: universe
    static_configs:
      - targets: ['host.docker.internal:9464']
```

### C. Honeycomb (events-first, fast queries)

```bash
OTEL_ENABLED=1
OTEL_SERVICE_NAME=universe-server
OTEL_EXPORTER_OTLP_ENDPOINT=https://api.honeycomb.io
OTEL_EXPORTER_OTLP_HEADERS="x-honeycomb-team=<your api key>"
```

Traces appear under the "universe-server" dataset.

## Sampling — when the trace bill starts showing up

Auto-instrumentation samples every request by default. At 300 req/s
that's 25M spans/day, which will hit Grafana Cloud's free-tier cap or
make Honeycomb expensive.

```bash
# Sample 10% of traces; the rest are never even generated (cheap, not
# just dropped at export). ParentBased means a sampled parent keeps
# its whole downstream trace sampled, so we don't shred distributed
# traces.
OTEL_TRACES_SAMPLER_ARG=0.10
```

For a 3-week demo you almost certainly don't need sampling. Keep it
at 100% until the volume actually hurts.

## What to watch first

Five metrics/spans that pay for the whole setup:

1. **`pg_pool_waiting` > 0** — at any sustained non-zero value, DB pool
   is the bottleneck; re-run `npm run loadtest` with `DB_POOL_MAX` bumped.
2. **HTTP p95 by route** — sort routes by p95 duration, the outliers
   point at N+1s, missing indexes, or accidentally synchronous work.
3. **Postgres query latency by statement** — auto-instrumentation
   attaches SQL text to spans; sort by duration to find the slow ones.
4. **Process event-loop lag** — if `nodejs_eventloop_lag_p99_seconds`
   climbs past 100ms, something is blocking the loop (sync pricing
   math? large JSON stringify?). Profile it.
5. **`process_resident_memory_bytes`** — flat is good; a ramp means a
   leak. The 1GB `max_memory_restart` in `ecosystem.config.cjs` bounds
   the damage, but you still want to find the leak.

## Pricing Drift Triage

Pricing saves run a server-side spot check against the canonical NP
pricing formula. Every checked save now emits:

- Response header: `X-Pricing-Drift-Count`
- Structured app log message: `pricing drift check`
- Log fields: `endpoint`, `pricingDriftCount`, `maxAbsDiff`,
  `driftMagnitudeBucket`, `requestId`, `contractId` or `quoteId`,
  `parentType`, `route`, and `summary`

Endpoint labels:

| Endpoint label | Route | Meaning |
| --- | --- | --- |
| `treaty_pricing` | `POST /api/pricing/save` | Composite treaty pricing save. |
| `np_layer_pricing` | `PUT /api/treaties/:id/np-pricing` | Contract NP layer pricing save. |
| `quote_pricing` | `PUT /api/quotes/:id/np-pricing` | Quote NP pricing save. |

Magnitude buckets use the maximum absolute drift on the request:

| Bucket | Definition |
| --- | --- |
| `0` | No drift rows. |
| `<0.001` | `0 < maxAbsDiff < 0.001`. |
| `<0.01` | `0.001 <= maxAbsDiff < 0.01`. |
| `<0.1` | `0.01 <= maxAbsDiff < 0.1`. |
| `>=0.1` | `maxAbsDiff >= 0.1`. |

Cedant and country are not emitted by the app logger by default, to
avoid pushing customer names into generic log sinks. If your trace/log
collector enriches request events with `cedantName`, `cedantId`,
`countryName`, or `countryCode`, add those dimensions to the dashboard.
Otherwise group them as `unknown` and drill down by `contractId` or
`quoteId` inside the app.

### 7-Day Dashboard Query

Use this CloudWatch Logs Insights query for the production app log
group. The same shape works in Loki/Honeycomb if you adapt the syntax
to JSON fields.

```sql
fields @timestamp,
       endpoint,
       pricingDriftCount,
       maxAbsDiff,
       driftMagnitudeBucket,
       requestId,
       contractId,
       quoteId,
       cedantName,
       cedantId,
       countryName,
       countryCode
| filter message = "pricing drift check"
| filter @timestamp >= ago(7d)
| fields coalesce(cedantName, cedantId, "unknown") as cedant,
         coalesce(countryName, countryCode, "unknown") as country
| stats
    count(*) as save_requests,
    sum(pricingDriftCount) as drift_rows,
    max(maxAbsDiff) as max_abs_drift,
    latest(requestId) as sample_request_id,
    latest(contractId) as sample_contract_id,
    latest(quoteId) as sample_quote_id
  by endpoint,
     driftMagnitudeBucket,
     cedant,
     country
| sort endpoint asc, driftMagnitudeBucket asc, drift_rows desc
```

If your ingress logs capture response headers instead of app logs, add
`$sent_http_x_pricing_drift_count` and `$sent_http_x_request_id` to the
nginx access log format and build the count panel from that field. Use
the app-log query above for magnitude buckets, because the response
header contains only the count.

### Triage Query

Use this when the dashboard shows non-zero drift. It lists individual
requests and keeps the capped `drifts` payload for root-cause review.

```sql
fields @timestamp,
       endpoint,
       requestId,
       contractId,
       quoteId,
       pricingDriftCount,
       maxAbsDiff,
       driftMagnitudeBucket,
       summary,
       drifts
| filter message = "pricing drift check"
| filter pricingDriftCount > 0
| filter @timestamp >= ago(7d)
| sort maxAbsDiff desc, @timestamp desc
| limit 200
```

Triage rules:

1. Keep `PRICING_STRICT` unset in production for one full week. This is
   warn-only mode: saves complete, the header/logs record drift, and
   users are not blocked.
2. For each non-zero request, classify it:
   - `maxAbsDiff < 0.001` with a clear rounding-step explanation:
     acceptable. Record the rounding explanation in the triage notes.
   - `maxAbsDiff >= 0.001`: real bug. File a fix against the drift
     source.
   - Any magnitude with no rounding explanation: real bug. File a fix.
3. The strict-mode gate is open only after the real-bug triage tail is
   empty for 48 consecutive hours.

### Enabling Strict Mode

After the gate is open, set this in production:

```env
PRICING_STRICT=1
```

Reload workers:

```bash
cd /opt/universe
npm run cluster:reload
```

Monitor 422s for at least the first business day:

```sql
fields @timestamp, requestId, path, code, error, drifts
| filter code = "PRICING_DRIFT" or status = 422
| filter @timestamp >= ago(24h)
| sort @timestamp desc
| limit 200
```

If users hit `422 PRICING_DRIFT`, fix the drift source. Do not treat
turning strict mode back off as the normal rollback path; use that only
for an explicitly declared production incident.

## Cost

The SDK with auto-instrumentation adds:

- ~20 MB of node_modules when `npm install` is run with OTel enabled
- ~3–5 ms per request overhead (mostly HTTP + pg span creation)
- One extra port (9464) listening for Prometheus scrapes

Memory footprint in a warm process: ~30 MB additional RSS for the SDK
plus batched spans. Disable and it's zero.

## When to disable

- **In tests** — already disabled (OTEL_ENABLED is never set under
  `NODE_ENV=test`, and the telemetry file is a no-op anyway)
- **In local dev where you're iterating on UI** — the SDK's startup
  cost and extra logs are noise you don't need
- **Behind a firewall with no outbound OTLP** — set `OTEL_ENABLED=0`;
  the Prometheus scrape still works locally if you need metrics only

## When to expand scope

We ship auto-instrumentation only. Places where **manual** spans
would add real signal:

- Around the NP/Prop pricing math (`shared/pricingMath.js`) — these
  are the CPU-heaviest synchronous paths in the app
- The xlsx export (`routes/home.js` → `portfolio-export`) — slow,
  infrequent, and when it's slow you want to know which sheet dominates
- Migration runs — already bracketed in logs, but turning them into
  spans would make boot-time traces legible

None of those are in scope for the initial cut. Add when you have a
specific question the auto-instrumentation can't answer.
