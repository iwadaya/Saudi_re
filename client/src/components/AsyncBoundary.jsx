// client/src/components/AsyncBoundary.jsx
// Uniform loading / error / empty rendering for async screen regions,
// designed to pair with hooks/useResource:
//
//   const losses = useResource((signal) => api.getLargeLosses(id, { signal }), [id]);
//   <AsyncBoundary loading={losses.loading} error={losses.error}
//                  onRetry={losses.refetch} label="large losses"
//                  empty={losses.data?.losses?.length === 0}>
//     <LossTable rows={losses.data.losses} />
//   </AsyncBoundary>
//
// Render-time exceptions stay the job of ScreenErrorBoundary (which also
// reports them); this component covers the async data path and renders
// STALE_WRITE / PRICING_DRIFT failures with the shared language from
// describeResourceError. useResource has already reported the error to
// the server by the time it lands here.

import { describeResourceError } from '../hooks/useResource';

const KIND_TITLES = {
  'stale-write': 'Concurrent edit detected',
  'pricing-drift': 'Pricing outputs failed validation',
  http: 'Could not load this section',
  unknown: 'Could not load this section',
};

export default function AsyncBoundary({
  loading = false,
  error = null,
  empty = false,
  emptyMessage = 'Nothing here yet.',
  label = 'data',
  onRetry = null,
  children = null,
}) {
  if (loading) {
    return (
      <div className="async-boundary async-boundary--loading" role="status" aria-live="polite"
        style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted, #9aa3bf)' }}>
        Loading {label}…
      </div>
    );
  }

  if (error) {
    const info = describeResourceError(error) || { kind: 'unknown', message: 'Something went wrong' };
    return (
      <div className="async-boundary async-boundary--error" role="alert"
        style={{ padding: '1.5rem', maxWidth: 720, margin: '1rem auto', fontFamily: 'var(--font-sans)' }}>
        <h3 style={{ color: 'var(--danger, #f87171)', marginTop: 0 }}>
          {KIND_TITLES[info.kind] || KIND_TITLES.unknown}
        </h3>
        <p style={{ color: 'var(--text-secondary, #d7dceb)', lineHeight: 1.5 }}>{info.message}</p>
        {onRetry && (
          <button
            type="button"
            onClick={onRetry}
            style={{
              padding: '8px 16px', background: 'var(--surface-3, #334155)',
              color: 'var(--text-primary, #e2e8f0)', border: 'none',
              borderRadius: 6, cursor: 'pointer',
            }}
          >
            Retry
          </button>
        )}
      </div>
    );
  }

  if (empty) {
    return (
      <div className="async-boundary async-boundary--empty"
        style={{ padding: '2rem', textAlign: 'center', color: 'var(--text-muted, #9aa3bf)' }}>
        {emptyMessage}
      </div>
    );
  }

  return children;
}
