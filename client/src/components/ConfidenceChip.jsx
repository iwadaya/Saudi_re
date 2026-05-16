// Small chip placed next to a field label to surface the LLM's
// confidence in the extracted value.
//   ≥ 0.9 → green (uses the dashboard's --accent teal)
//   ≥ 0.5 → amber
//   < 0.5 or null → red
// Colours intentionally line up with the existing dark-theme palette
// rather than introducing new tokens.

const TIERS = [
  { min: 0.9,  className: 'cc--ok',  label: 'high' },
  { min: 0.5,  className: 'cc--med', label: 'medium' },
  { min: -Infinity, className: 'cc--low', label: 'low' },
];

function tier(value) {
  if (value == null || Number.isNaN(value)) {
    return { className: 'cc--low', label: 'missing' };
  }
  for (const t of TIERS) if (value >= t.min) return t;
  return TIERS[TIERS.length - 1];
}

export default function ConfidenceChip({ value, compact = false }) {
  const t = tier(value);
  const text = value == null
    ? '—'
    : `${Math.round(value * 100)}%`;
  return (
    <>
      <style>{`
        .cc {
          display: inline-flex; align-items: center; gap: 4px;
          padding: ${compact ? '1px 5px' : '2px 7px'}; border-radius: 8px;
          font-size: 9px; font-weight: 700; letter-spacing: .06em;
          text-transform: uppercase; line-height: 1.2;
          border: 1px solid transparent;
          font-variant-numeric: tabular-nums;
        }
        .cc--ok  {
          background: rgba(var(--accent-rgb), .14);
          color: var(--accent);
          border-color: rgba(var(--accent-rgb), .28);
        }
        .cc--med {
          background: rgba(250, 191, 36, .12);
          color: #fbbf24;
          border-color: rgba(250, 191, 36, .28);
        }
        .cc--low {
          background: rgba(248, 113, 113, .12);
          color: #f87171;
          border-color: rgba(248, 113, 113, .30);
        }
      `}</style>
      <span className={`cc ${t.className}`} title={`Confidence: ${t.label}`}>
        {text}
      </span>
    </>
  );
}
