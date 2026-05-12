// server/src/observability/telemetry.js
//
// OpenTelemetry entry. MUST be imported before any instrumented
// module (pg, express, http) so auto-instrumentation can patch them
// at require-time. We rely on ESM evaluation order: this file is the
// very first import in server/src/index.js.
//
// Disabled by default — no OTel dependencies are even loaded unless
// OTEL_ENABLED is set. This keeps `npm start` and the test suite
// free of the ~15 MB of OpenTelemetry packages when nobody asked
// for tracing.
//
// Enable by exporting:
//   OTEL_ENABLED=1
//   OTEL_SERVICE_NAME=universe-server          (default: universe-server)
//   OTEL_EXPORTER_OTLP_ENDPOINT=http://...     (default: http://localhost:4318)
//   OTEL_TRACES_SAMPLER_ARG=0.1                (optional, ratio 0..1)
//   PROM_EXPORTER_PORT=9464                    (default: 9464, separate port for scrape)
//
// See docs/observability.md for ready-to-copy platform recipes
// (Grafana Cloud, local Jaeger + Prometheus, Honeycomb).

function truthy(v) {
  return v === '1' || v === 'true' || v === 'yes' || v === 'on';
}

// Top-level await so that if we DO initialise, the SDK is fully
// started before any downstream module imports evaluate. Node 20
// supports TLA in ESM, and we only block on it when enabled.
if (truthy(process.env.OTEL_ENABLED)) {
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
