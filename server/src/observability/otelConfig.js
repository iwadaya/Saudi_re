// server/src/observability/otelConfig.js
//
// Pure, side-effect-free configuration helpers for the OTel bootstrap.
// Split out from telemetry.js (which has import-time side effects) so the
// enablement policy can be unit-tested in isolation.

function flag(v) {
  return v == null ? '' : String(v).trim().toLowerCase();
}

/** Explicit truthy flag value. */
export function truthyFlag(v) {
  const s = flag(v);
  return s === '1' || s === 'true' || s === 'yes' || s === 'on';
}

/** Explicit falsy flag value. */
export function falsyFlag(v) {
  const s = flag(v);
  return s === '0' || s === 'false' || s === 'no' || s === 'off';
}

/**
 * Whether to start the OTel SDK. Mirrors the pricing verifier's
 * isStrictMode() policy: an explicit OTEL_ENABLED value always wins
 * (including an emergency `OTEL_ENABLED=0` rollback that disables it in
 * production without a redeploy); when unset, OTel is ON in production
 * (so staging/prod are instrumented by default) and OFF everywhere else
 * (dev/test stay free of the OpenTelemetry packages).
 *
 * @param {string|undefined} rawFlag  process.env.OTEL_ENABLED
 * @param {string|undefined} nodeEnv  process.env.NODE_ENV
 */
export function shouldEnableOtel(rawFlag, nodeEnv) {
  if (falsyFlag(rawFlag)) return false; // explicit opt-out wins anywhere
  if (truthyFlag(rawFlag)) return true; // explicit opt-in wins anywhere
  return nodeEnv === 'production'; // unset → on in prod (and staging), off elsewhere
}

/**
 * The OTLP trace endpoint, or null when none is configured. Returning
 * null lets the SDK run metrics-only (Prometheus scrape) without an
 * OTLP trace exporter retrying against a non-existent collector — so a
 * default production deploy gets the dashboards' metrics with no
 * connection-error noise. Traces flow as soon as an endpoint is set.
 */
export function otlpTraceEndpoint(rawEndpoint) {
  const s = typeof rawEndpoint === 'string' ? rawEndpoint.trim() : '';
  return s || null;
}
