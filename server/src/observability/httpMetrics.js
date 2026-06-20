// server/src/observability/httpMetrics.js
//
// Inbound HTTP request metrics: a latency histogram and a request
// counter, both labelled by route template, method and status class.
// These back the two headline dashboards — API latency (p50/p95/p99)
// and 5xx error rate.
//
// Design mirrors poolMetrics.js: the @opentelemetry/api dependency is
// only pulled in when OTel is actually enabled (enableHttpMetrics is
// called from otelInit, which only runs under OTEL_ENABLED). Until
// then the middleware is a pure pass-through with zero per-request cost
// and no OTel imports in the default module graph — so `npm start` and
// the test suite stay free of the OpenTelemetry packages.

// Set by enableHttpMetrics() once the SDK is up. While null the
// middleware is a no-op, so it is safe to mount unconditionally.
let record = null;

/**
 * Low-cardinality route label. Uses the matched Express route template
 * (e.g. "/api/quotes/:id") rather than the concrete URL so per-id paths
 * don't explode the metric's series count. Unmatched requests (404s,
 * the SPA fallback, static assets) collapse to a single bucket.
 */
export function routeLabel(req) {
  const base = req?.baseUrl || '';
  const path = req?.route?.path;
  if (path != null && path !== '') {
    const p = Array.isArray(path) ? path[0] : path;
    return `${base}${String(p)}` || '/';
  }
  return base ? `${base}/*` : 'unmatched';
}

/** Bucket an HTTP status into its class — "2xx", "4xx", "5xx", etc. */
export function statusClass(status) {
  const s = Number(status);
  if (!Number.isFinite(s) || s < 100 || s > 599) return 'unknown';
  return `${Math.floor(s / 100)}xx`;
}

/**
 * Express middleware. Records duration + a count on response finish.
 * No-op (just `next()`) until enableHttpMetrics() wires the recorder,
 * and it never lets a metrics failure affect the response.
 */
export function httpMetricsMiddleware(req, res, next) {
  if (!record) return next();
  const startNs = process.hrtime.bigint();
  res.once('finish', () => {
    try {
      const durSec = Number(process.hrtime.bigint() - startNs) / 1e9;
      record(req, res, durSec);
    } catch {
      /* metrics must never break a request */
    }
  });
  next();
}

let enabled = false;

/**
 * Create the instruments and start recording. Dynamic-imports
 * @opentelemetry/api so the dependency stays out of the default graph.
 * Idempotent.
 */
export async function enableHttpMetrics() {
  if (enabled) return;
  const { metrics } = await import('@opentelemetry/api');
  const meter = metrics.getMeter('universe.http.server');

  const duration = meter.createHistogram('http.server.request.duration', {
    description: 'Duration of inbound HTTP requests',
    unit: 's',
    // Prometheus-friendly second buckets so Grafana p95/p99 queries
    // line up with the platform's default histogram boundaries.
    advice: {
      explicitBucketBoundaries: [
        0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5, 10,
      ],
    },
  });
  const count = meter.createCounter('http.server.requests', {
    description: 'Count of inbound HTTP requests by route, method and status class',
  });

  record = (req, res, durSec) => {
    const attrs = {
      'http.request.method': req.method,
      'http.route': routeLabel(req),
      'http.response.status_code': res.statusCode,
      status_class: statusClass(res.statusCode),
    };
    duration.record(durSec, attrs);
    count.add(1, attrs);
  };
  enabled = true;
}
