// server/src/observability/businessMetrics.js
//
// Domain signal metrics: NP pricing drift and document-upload outcomes.
// These back the "pricing drift" and "upload failures" dashboards.
//
// Same design as httpMetrics/aiMetrics/poolMetrics: @opentelemetry/api is
// dynamic-imported only when OTel is enabled (enableBusinessMetrics is
// called from otelInit). Until then the record* functions are no-ops, so
// the pricing controllers and the upload sink carry no OTel imports in the
// default module graph and there is zero behavioural change when OTel is
// off (the default, including all of CI).

/**
 * Coarse, low-cardinality category for an upload folder. Folders look
 * like "quotes/<id>", "fac/<id>", "universe3/<id>" — the leading segment
 * is the stable category; the id would explode the series count.
 */
export function folderType(folder) {
  const first = String(folder || '').split('/')[0].trim();
  return first || 'unknown';
}

// Set by enableBusinessMetrics() once the SDK is up. While null the
// record* functions are no-ops.
let recordDrift = null;
let recordUploadFn = null;

/**
 * Record one NP pricing-drift check. `stats` is the pricingDriftStats()
 * shape ({ pricingDriftCount, maxAbsDiff, driftMagnitudeBucket }).
 * Never throws.
 */
export function recordPricingDrift({ endpoint, stats, strict }) {
  if (!recordDrift) return;
  try {
    recordDrift({ endpoint, stats: stats || {}, strict: !!strict });
  } catch {
    /* metrics must never break a save */
  }
}

/**
 * Record one document-upload attempt. `outcome` is 'success' or 'error',
 * `sink` is 'cloudinary' or 'disk'. Never throws.
 */
export function recordUpload({ folderType: ft, sink, outcome }) {
  if (!recordUploadFn) return;
  try {
    recordUploadFn({ folderType: ft, sink, outcome });
  } catch {
    /* metrics must never break an upload */
  }
}

let enabled = false;

/**
 * Create the instruments and start recording. Dynamic-imports
 * @opentelemetry/api so the dependency stays out of the default graph.
 * Idempotent.
 */
export async function enableBusinessMetrics() {
  if (enabled) return;
  const { metrics } = await import('@opentelemetry/api');
  const meter = metrics.getMeter('universe.business');

  const driftChecks = meter.createCounter('pricing.drift.checks', {
    description: 'NP pricing-drift spot checks by endpoint, drift presence, magnitude and mode',
  });
  const driftRows = meter.createCounter('pricing.drift.rows', {
    description: 'Count of individual drifted pricing rows detected',
    unit: 'row',
  });
  const uploads = meter.createCounter('upload.requests', {
    description: 'Document upload attempts by folder type, storage sink and outcome',
  });

  recordDrift = ({ endpoint, stats, strict }) => {
    const count = Number(stats.pricingDriftCount) || 0;
    driftChecks.add(1, {
      endpoint,
      has_drift: count > 0,
      magnitude_bucket: stats.driftMagnitudeBucket || '0',
      strict,
    });
    if (count > 0) driftRows.add(count, { endpoint });
  };
  recordUploadFn = ({ folderType: ft, sink, outcome }) => {
    uploads.add(1, { folder_type: ft || 'unknown', sink: sink || 'unknown', outcome });
  };
  enabled = true;
}
