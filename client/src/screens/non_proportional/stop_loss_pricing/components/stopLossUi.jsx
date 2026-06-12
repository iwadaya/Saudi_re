// @ts-check
// components/stopLossUi.jsx — shared presentation primitives for the
// NP Stop Loss Pricing screen (Phase 4.2 decomposition): the dark/glass
// style map, the money/percent formatters and the Field row helper.
// All moved VERBATIM from NpStopLossPricing.jsx — the formatter output
// is pinned by goldenMaster.test.jsx.

/** @param {unknown} v @returns {string} */
export const fmtMoney = (v) => {
  if (typeof v !== 'number' || !Number.isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e9) return `${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${(v / 1e6).toFixed(2)}M`;
  if (abs >= 1e3) return `${(v / 1e3).toFixed(1)}K`;
  return v.toFixed(0);
};

/** @param {unknown} v @returns {string} */
export const fmtMoneyFull = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v).toLocaleString('en-US') : '—');
/** @param {unknown} v @param {number} [dp] @returns {string} */
export const fmtPct = (v, dp = 3) => (typeof v === 'number' && Number.isFinite(v) ? `${(v * 100).toFixed(dp)}%` : '—');

// ── Styling primitives — match the dark/glass look used elsewhere ───────────

export const COLORS = {
  cyan: '#00d4ff',
  amber: '#fbbf24',
  green: '#4ade80',
  red: '#f87171',
  purple: '#a855f7',
  mute: 'rgba(148,163,184,0.55)',
  rowEven: '#080f23',
  rowOdd: '#0a1125',
};

export const styles = /** @satisfies {Record<string, import('react').CSSProperties | ((color: string) => import('react').CSSProperties)>} */ ({
  shell: { maxWidth: 1180, margin: '0 auto', padding: '8px 0 48px' },
  section: {
    background: 'rgba(255,255,255,0.02)',
    border: '1px solid rgba(255,255,255,0.06)',
    borderRadius: 12,
    padding: '18px 22px',
    marginBottom: 16,
  },
  sectionTitle: {
    fontSize: 11,
    fontWeight: 800,
    letterSpacing: '.14em',
    textTransform: 'uppercase',
    color: COLORS.cyan,
    marginBottom: 14,
  },
  sectionSub: {
    fontSize: 11,
    color: COLORS.mute,
    marginTop: -10,
    marginBottom: 14,
  },
  label: {
    fontSize: 10,
    fontWeight: 700,
    letterSpacing: '.10em',
    textTransform: 'uppercase',
    color: 'rgba(148,163,184,0.65)',
    marginBottom: 5,
  },
  input: {
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid rgba(255,255,255,0.10)',
    borderRadius: 6,
    color: 'rgba(226,232,240,0.92)',
    padding: '7px 10px',
    height: 32,
    width: '100%',
    fontSize: 12,
    outline: 'none',
    fontVariantNumeric: 'tabular-nums',
    fontWeight: 600,
  },
  select: {
    background: 'rgba(255,255,255,0.03)',
    border: '1px solid rgba(255,255,255,0.10)',
    borderRadius: 6,
    color: 'rgba(226,232,240,0.92)',
    padding: '7px 10px',
    height: 32,
    fontSize: 12,
    outline: 'none',
    fontWeight: 600,
    cursor: 'pointer',
  },
  th: {
    padding: '11px 10px',
    fontSize: 9,
    fontWeight: 800,
    letterSpacing: '.12em',
    textTransform: 'uppercase',
    color: 'rgba(255,255,255,0.45)',
    borderBottom: '1px solid rgba(255,255,255,0.10)',
    background: '#050810',
    textAlign: 'center',
  },
  td: {
    padding: '7px 8px',
    textAlign: 'center',
    borderBottom: '1px solid rgba(255,255,255,0.05)',
    fontVariantNumeric: 'tabular-nums',
    fontSize: 12,
    verticalAlign: 'middle',
  },
  readonlyCell: {
    fontFamily: 'inherit',
    color: 'rgba(148,163,184,0.75)',
    fontWeight: 600,
  },
  warningBox: {
    marginTop: 14,
    background: 'rgba(248,113,113,0.06)',
    border: '1px solid rgba(248,113,113,0.30)',
    borderRadius: 8,
    padding: '10px 14px',
    fontSize: 11,
    color: '#fca5a5',
    lineHeight: 1.5,
  },
  resultCard: (color) => ({
    background: 'rgba(255,255,255,0.02)',
    border: `1px solid ${color}55`,
    borderRadius: 10,
    padding: '14px 16px',
    textAlign: 'center',
  }),
  resultLabel: {
    fontSize: 9,
    fontWeight: 800,
    letterSpacing: '.12em',
    textTransform: 'uppercase',
    color: 'rgba(148,163,184,0.50)',
    marginBottom: 6,
  },
  resultValue: (color) => ({
    fontSize: 22,
    fontWeight: 900,
    color,
    fontVariantNumeric: 'tabular-nums',
  }),
  resultSub: {
    fontSize: 10,
    color: 'rgba(148,163,184,0.55)',
    marginTop: 4,
  },
});

// Field row helper — label above a single input/select control.
/** @param {{ label: import('react').ReactNode, hint?: import('react').ReactNode, children?: import('react').ReactNode, span?: number }} props */
export function Field({ label, hint, children, span = 1 }) {
  return (
    <div style={{ gridColumn: `span ${span}` }}>
      <div style={styles.label}>{label}</div>
      {children}
      {hint && (
        <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.50)', marginTop: 4 }}>{hint}</div>
      )}
    </div>
  );
}
