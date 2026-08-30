# Monitoring — dashboards & alerts

Ready-to-load Grafana dashboard and Prometheus alert rules for the
`universe-server` OpenTelemetry metrics. The instrumentation ships in the app
(see `docs/observability.md`); these files are the **dashboards/alerts** half.

```
monitoring/
  grafana/universe-observability.json   Grafana dashboard (8 panels)
  prometheus/alerts.yml                  Prometheus alerting rules (6 groups)
```

## Prerequisites

OpenTelemetry must be running (on by default in production; `OTEL_ENABLED=1`
elsewhere) and a Prometheus must be scraping the app's metrics endpoint. The
endpoint is **private by default** (binds to `127.0.0.1:9464`); point your
scraper at it from the same host, or set `PROM_EXPORTER_HOST` to a private
interface for a remote scraper. See `docs/observability.md`.

## Load the dashboard

Grafana → Dashboards → **Import** → upload `grafana/universe-observability.json`,
then select your Prometheus datasource when prompted. Panels cover all six
signals: API latency (p50/p95/p99), request rate & 5xx, pg pool pressure,
pricing drift, upload failures, and AI provider errors & spend.

## Load the alert rules

Reference the file from `prometheus.yml` and reload Prometheus:

```yaml
# prometheus.yml
rule_files:
  - /etc/prometheus/rules/universe-alerts.yml   # this repo's monitoring/prometheus/alerts.yml
```

Validate before shipping: `promtool check rules monitoring/prometheus/alerts.yml`.

## Thresholds — tune before paging

The thresholds are **starting points**, documented inline in `alerts.yml`.
Severity convention: `warning` → notify, `critical` → page.

| Alert | Default | Notes |
| --- | --- | --- |
| `ApiLatencyP95High` / `Critical` | p95 > 1s / > 2.5s | over all routes |
| `Api5xxRateHigh` / `Critical` | 5xx > 2% / > 5% | inert with no traffic |
| `PgPoolWaiting` / `Critical` | waiters > 0 / > 5 (5m) | leading bottleneck signal |
| `PricingDriftDetected` | any drift in 1h | steady state is **zero** |
| `UploadFailureRateHigh` | errors > 10% (10m) | per storage sink |
| `AiProviderErrorRateHigh` | errors > 25% (10m) | Gemini→OpenAI fallback |
| `AiSpendHourlyHigh` | > $25/h | **set to your AI budget** |

Tune `ApiLatencyP95*`, `Api5xxRate*`, and especially `AiSpendHourlyHigh`
against a baseline week of production traffic before enabling paging.
The AI cost figure is a list-price approximation (see
`server/src/observability/aiMetrics.js`).
