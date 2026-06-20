// server/src/observability/telemetry.js
//
// OpenTelemetry entry. MUST be imported before any instrumented
// module (pg, express, http) so auto-instrumentation can patch them
// at require-time. We rely on ESM evaluation order: this file is the
// very first import in server/src/index.js.
//
// Disabled by default in dev/test, ENABLED BY DEFAULT in production
// (and staging, which runs as NODE_ENV=production) — no OTel
// dependencies are loaded unless we actually initialise. This keeps
// `npm start` in dev and the test suite free of the ~15 MB of
// OpenTelemetry packages while staging/prod are instrumented out of the
// box. An explicit OTEL_ENABLED value always wins (set OTEL_ENABLED=0
// to disable in production without a redeploy).
//
// Enable / configure via:
//   OTEL_ENABLED=1                             (force on; default-on in prod)
//   OTEL_ENABLED=0                             (force off, e.g. prod rollback)
//   OTEL_SERVICE_NAME=universe-server          (default: universe-server)
//   OTEL_EXPORTER_OTLP_ENDPOINT=http://...     (traces; metrics work without it)
//   OTEL_TRACES_SAMPLER_ARG=0.1                (optional, ratio 0..1)
//   PROM_EXPORTER_PORT=9464                    (default: 9464, separate port for scrape)
//
// See docs/observability.md for ready-to-copy platform recipes
// (Grafana Cloud, local Jaeger + Prometheus, Honeycomb).

import { shouldEnableOtel } from './otelConfig.js';

// Top-level await so that if we DO initialise, the SDK is fully
// started before any downstream module imports evaluate. Node 20
// supports TLA in ESM, and we only block on it when enabled.
if (shouldEnableOtel(process.env.OTEL_ENABLED, process.env.NODE_ENV)) {
  try {
    const { initOtel } = await import('./otelInit.js');
    await initOtel();
  } catch (err) {
    // A broken OTel install must NOT take the app down. We log with
    // console.warn directly because the structured logger isn't loaded
    // yet at this point in the boot sequence.
    console.warn('[otel] initialisation failed, continuing without tracing:', err?.message || err);
  }
}
