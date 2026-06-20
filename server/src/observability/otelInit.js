// server/src/observability/otelInit.js
//
// Actual OpenTelemetry SDK wiring. Only imported when OTEL_ENABLED is
// truthy (see telemetry.js). This split keeps the heavy @opentelemetry/*
// deps out of the `import` graph when tracing is off.
//
// What we ship out of the box:
//   - Traces via OTLP/HTTP (auto-instrumented HTTP, Express, pg)
//   - Metrics via a Prometheus scrape endpoint on a separate port
//     so /api/ remains cleanly dedicated to app traffic
//   - Process resource attributes (service name, version, host, pid)
//
// What's excluded:
//   - File-system tracing (noisy, useless for this app)
//   - /api/health traces (polled by load balancers, would swamp backends)

import { NodeSDK } from '@opentelemetry/sdk-node';
import { getNodeAutoInstrumentations } from '@opentelemetry/auto-instrumentations-node';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { PrometheusExporter } from '@opentelemetry/exporter-prometheus';
import { resourceFromAttributes } from '@opentelemetry/resources';
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
  ATTR_DEPLOYMENT_ENVIRONMENT_NAME,
} from '@opentelemetry/semantic-conventions';
import { TraceIdRatioBasedSampler, ParentBasedSampler } from '@opentelemetry/sdk-trace-base';

/**
 * Build + start the SDK. Idempotent — if somebody imports this twice,
 * the second call is a no-op.
 */
let started = false;
export async function initOtel() {
  if (started) return;
  started = true;

  const serviceName = process.env.OTEL_SERVICE_NAME || 'universe-server';
  const endpoint    = process.env.OTEL_EXPORTER_OTLP_ENDPOINT || 'http://localhost:4318';
  const samplerArg  = Number(process.env.OTEL_TRACES_SAMPLER_ARG);
  const promPort    = Number(process.env.PROM_EXPORTER_PORT) || 9464;

  // Sampling — default AlwaysOn, opt-in ratio via env. ParentBased
  // means a parent-sampled trace stays sampled downstream (otherwise
  // distributed traces get shredded).
  const sampler = Number.isFinite(samplerArg) && samplerArg >= 0 && samplerArg <= 1
    ? new ParentBasedSampler({ root: new TraceIdRatioBasedSampler(samplerArg) })
    : undefined;

  const sdk = new NodeSDK({
    resource: resourceFromAttributes({
      [ATTR_SERVICE_NAME]:             serviceName,
      [ATTR_SERVICE_VERSION]:          process.env.npm_package_version || process.env.APP_VERSION || '0.0.0',
      [ATTR_DEPLOYMENT_ENVIRONMENT_NAME]: process.env.NODE_ENV || 'development',
    }),
    traceExporter: new OTLPTraceExporter({ url: `${endpoint}/v1/traces` }),
    metricReader: new PrometheusExporter({ port: promPort, endpoint: '/metrics' }),
    sampler,
    instrumentations: [
      getNodeAutoInstrumentations({
        // FS instrumentation emits a span for every fs.open — drowns
        // out application signal and adds measurable overhead.
        '@opentelemetry/instrumentation-fs': { enabled: false },
        // Don't trace health probes; they'd dominate sampled traffic.
        '@opentelemetry/instrumentation-http': {
          ignoreIncomingRequestHook: (req) => {
            const url = req.url || '';
            return url.startsWith('/api/health') || url === '/api/metrics';
          },
        },
        // pg auto-instrumentation records SQL text — redact parameters
        // so PII (cedant names, premiums) doesn't leave the process.
        '@opentelemetry/instrumentation-pg': {
          enhancedDatabaseReporting: false,
        },
      }),
    ],
  });

  sdk.start();
  console.log(`[otel] started — service=${serviceName} traces→${endpoint} metrics→:${promPort}/metrics`);

  // Register custom metrics once the SDK is up. Dynamic-imported here so
  // a missing file doesn't cascade failures in the SDK itself.
  try {
    const { registerPoolMetrics } = await import('./poolMetrics.js');
    registerPoolMetrics();
    const { enableHttpMetrics } = await import('./httpMetrics.js');
    await enableHttpMetrics();
  } catch (err) {
    console.warn('[otel] custom metrics registration failed:', err?.message || err);
  }

  // Drain spans/metrics cleanly on shutdown. We install ours here
  // rather than piggy-backing on gracefulShutdown.js so OTel dies
  // last — after the HTTP server has flushed its final spans.
  const stop = async (signal) => {
    try {
      await sdk.shutdown();
      console.log(`[otel] shut down on ${signal}`);
    } catch (err) {
      console.warn('[otel] shutdown error:', err?.message || err);
    }
  };
  process.once('SIGTERM', () => stop('SIGTERM'));
  process.once('SIGINT',  () => stop('SIGINT'));
}
