// client/src/components/LoadErrorPanel.jsx
// Shared "this section failed to load" panel with a Retry action, for screens
// that own bespoke local state and can't drop in AsyncBoundary wholesale (e.g.
// editable grids). Living in components/ keeps its inline styles out of the
// screens-layer budget while giving every screen one consistent error surface.
//
//   {loadError && <LoadErrorPanel onRetry={load}
//       message="Couldn’t load saved losses. Saving is disabled to avoid
//                overwriting server data." />}
//
// `variant="block"` is a centered card (use when the whole screen failed);
// `variant="inline"` is a full-width banner (use above an editable region).

const wrapBase = {
  display: 'flex',
  alignItems: 'center',
  gap: 12,
  border: '1px solid var(--danger, #7f1d1d)',
  background: 'rgba(127,29,29,.14)',
  color: 'var(--text-secondary, #fca5a5)',
  fontFamily: 'var(--font-sans)',
};

const VARIANTS = {
  inline: { ...wrapBase, margin: '12px 0', padding: '12px 16px', borderRadius: 6 },
  block: { ...wrapBase, flexDirection: 'column', maxWidth: 540, margin: '60px auto', padding: 30, borderRadius: 8, textAlign: 'center' },
};

export default function LoadErrorPanel({
  title = 'Couldn’t load this section',
  message = 'The data failed to load. Check your connection and try again.',
  onRetry = null,
  retryLabel = 'Retry',
  variant = 'inline',
}) {
  const isBlock = variant === 'block';
  return (
    <div role="alert" className={`load-error-panel load-error-panel--${variant}`} style={VARIANTS[variant] || VARIANTS.inline}>
      <div style={{ flex: isBlock ? undefined : 1 }}>
        {isBlock && <h3 style={{ color: 'var(--danger, #f87171)', margin: '0 0 8px' }}>{title}</h3>}
        <span style={{ lineHeight: 1.5 }}>{isBlock ? message : `⚠ ${message}`}</span>
      </div>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          style={{
            padding: '8px 16px', background: 'var(--surface-3, #334155)',
            color: 'var(--text-primary, #e2e8f0)', border: 'none',
            borderRadius: 6, cursor: 'pointer', whiteSpace: 'nowrap',
          }}
        >
          {retryLabel}
        </button>
      )}
    </div>
  );
}
