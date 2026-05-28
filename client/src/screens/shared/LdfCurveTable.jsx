// LdfCurveTable.jsx
// Pure presentational table — renders per-class benchmark curves plus
// the weighted blend row and the cumulative-development-factor row.
// Reused by LdfAnalysisModal (the editing surface) and the read-only
// summary card on PropNoTriangulation.

function formatLdf(v) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  return Number(v).toFixed(3);
}

export default function LdfCurveTable({
  classes = [],
  blended = [],
  classLabelById = {},  // optional { [classOfBusinessId]: 'Property — non-CAT' }
  compact = false,
}) {
  // Union of dev months across per-class curves and the blended row.
  const devSet = new Set();
  for (const c of classes) for (const p of (c.curve || [])) devSet.add(Number(p.devMonth));
  for (const p of blended) devSet.add(Number(p.devMonth));
  const devMonths = [...devSet].sort((a, b) => a - b);

  if (devMonths.length === 0) {
    return (
      <div style={{ color: 'var(--muted)', fontSize: 12, padding: 12, textAlign: 'center' }}>
        No development factors to display yet.
      </div>
    );
  }

  // Quick lookup for per-class ldf at a dev_month
  const ldfAt = (curve, dm) => {
    const pt = (curve || []).find((p) => Number(p.devMonth) === dm);
    return pt ? Number(pt.ldf) : null;
  };
  const blendedAt = (dm) => blended.find((p) => Number(p.devMonth) === dm) || null;

  const headerCell = {
    padding: compact ? '6px 8px' : '10px 10px',
    textAlign: 'right',
    fontSize: 9, fontWeight: 800, letterSpacing: 0, textTransform: 'uppercase',
    color: 'var(--muted)',
    borderBottom: '1px solid var(--hairline)',
    whiteSpace: 'nowrap',
  };
  const rowLabel = {
    padding: compact ? '5px 10px' : '8px 12px',
    fontSize: 12, color: 'var(--text)',
    borderRight: '1px solid var(--hairline)',
    whiteSpace: 'nowrap',
  };
  const numCell = {
    padding: compact ? '5px 8px' : '8px 10px',
    textAlign: 'right',
    fontFamily: 'var(--font-mono)',
    fontSize: 12, color: 'var(--text)',
  };

  return (
    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
      <thead>
        <tr>
          <th style={{ ...headerCell, textAlign: 'left', borderRight: '1px solid var(--hairline)' }}>Class</th>
          {devMonths.map((dm, i) => {
            const next = devMonths[i + 1];
            const label = next ? `${dm}→${next}` : `${dm}→Ult`;
            return <th key={dm} style={headerCell}>{label}</th>;
          })}
        </tr>
      </thead>
      <tbody>
        {classes.map((c) => (
          <tr key={c.classOfBusinessId} style={{ borderBottom: '1px solid var(--hairline)' }}>
            <td style={rowLabel}>
              {classLabelById[c.classOfBusinessId] || c.classOfBusinessId.slice(0, 8)}
              {c.weight != null && (
                <span style={{ color: 'var(--muted)', marginLeft: 6, fontSize: 11 }}>
                  ({(Number(c.weight) * 100).toFixed(1)}%)
                </span>
              )}
            </td>
            {devMonths.map((dm) => (
              <td key={dm} style={numCell}>{formatLdf(ldfAt(c.curve, dm))}</td>
            ))}
          </tr>
        ))}

        {/* Weighted blend row */}
        <tr style={{
          borderTop: '2px solid rgba(var(--accent-rgb), 0.45)',
          background: 'rgba(var(--accent-rgb), 0.06)',
        }}>
          <td style={{ ...rowLabel, fontWeight: 800, color: 'var(--accent)' }}>Weighted</td>
          {devMonths.map((dm) => {
            const pt = blendedAt(dm);
            return (
              <td key={dm} style={{ ...numCell, fontWeight: 800, color: 'var(--accent)' }}>
                {pt ? formatLdf(pt.ldf) : '—'}
              </td>
            );
          })}
        </tr>

        {/* CDF row */}
        <tr>
          <td style={{ ...rowLabel, color: 'var(--muted)', fontSize: 11 }}>CDF</td>
          {devMonths.map((dm) => {
            const pt = blendedAt(dm);
            return (
              <td key={dm} style={{ ...numCell, color: 'var(--muted)' }}>
                {pt && pt.cdf != null ? `${Number(pt.cdf).toFixed(3)}×` : '—'}
              </td>
            );
          })}
        </tr>
      </tbody>
    </table>
  );
}
