// components/LinkRatioView.jsx — link-ratio triangle with outlier exclusion
// (Phase 4.2 decomposition of DevFactorsScreen.jsx). JSX + hooks moved
// VERBATIM; the recalculated averages are pinned by goldenMaster.test.jsx.
import { useEffect, useMemo, useCallback } from 'react';
import {
  calculateAgeToAgeFactors, calculatePattern, calculateCdfs,
} from '../../../../logic/chainLadder';
import { AVG_METHOD_LABEL, fmt4 } from '../state/devFactorsCalcs';

/* ═══════════════ Link Ratio View with outlier exclusion ═══════════════ */
export default function LinkRatioView({ matrix, years, numDevYears, excluded, setExcluded, onPatternChange, method = 'weighted' }) {
  // Rules-of-hooks: every hook must run on every render. The old
  // layout had `if (!matrix) return …` before the useEffect below,
  // which made the hook order conditional — lint error. Compute the
  // filtered pattern unconditionally (empty arrays when matrix is
  // missing), run the hook, then branch at render time.
  const factors = useMemo(() => matrix ? calculateAgeToAgeFactors(matrix) : null, [matrix]);
  const N = numDevYears - 1;
  const devHeaders = Array.from({ length: N }, (_, i) => `${i + 1}–${i + 2}`);
  const inTriangle = useCallback((r, c) => r + c < N, [N]);

  const toggle = (r, c) => {
    const key = `${r}:${c}`;
    setExcluded(prev => { const s = new Set(prev); s.has(key) ? s.delete(key) : s.add(key); return s; });
  };

  // Single source of truth: the same calculatePattern used by the Dev Factors
  // view, so the link-ratio recalculation honours the selected averaging method
  // (weighted / simple / last3 / last5) as well as the excluded cells.
  const { filteredPattern, filteredCdfs } = useMemo(() => {
    if (!matrix || !factors) return { filteredPattern: [], filteredCdfs: [] };
    const { pattern } = calculatePattern(matrix, factors, method, { excluded });
    const cdfs = calculateCdfs(pattern, 1.0).slice(0, pattern.length);
    return { filteredPattern: pattern, filteredCdfs: cdfs };
  }, [excluded, factors, matrix, method]);

  // Notify parent of filtered pattern — hook now runs unconditionally
  useEffect(() => { onPatternChange?.(filteredPattern, filteredCdfs); }, [filteredCdfs, filteredPattern, onPatternChange]);

  if (!matrix) return <div className="muted" style={{ padding: 12 }}>No triangle data. Enter data in triangle screens first.</div>;

  return (
    <div>
      <div style={{ fontSize: 11, color: 'rgba(var(--text-rgb),.7)', marginBottom: 8 }}>Click any link ratio to exclude/include it from weighted average. Excluded cells shown in red strikethrough.</div>
      <div style={{ overflowX: 'auto' }}>
        <table className="tri-table">
          <thead><tr><th className="tri-hdr" style={{ minWidth: 52 }}>Year</th>{devHeaders.map(h => <th key={h} className="tri-hdr">{h}</th>)}</tr></thead>
          <tbody>
            {years.map((yr, r) => (
              <tr key={yr}>
                <td className="tri-yr">{yr}</td>
                {Array.from({ length: N }, (_, c) => {
                  const f = inTriangle(r, c) ? factors[r]?.[c] : null;
                  const isExcl = excluded.has(`${r}:${c}`);
                  return (
                    <td key={c} className={f == null ? 'tri-off' : 'tri-cell'} onClick={() => f != null && toggle(r, c)} style={{ cursor: f != null ? 'pointer' : 'default' }}>
                      {f != null && <div className="tri-inp" style={{ textDecoration: isExcl ? 'line-through' : 'none', opacity: isExcl ? 0.35 : 1, color: isExcl ? '#f87171' : 'rgba(var(--text-rgb),0.88)' }}>{fmt4(f)}</div>}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr style={{ borderTop: '2px solid rgba(var(--accent-rgb),0.3)' }}>
              <td className="tri-yr" style={{ color: 'var(--accent)' }}>{AVG_METHOD_LABEL[method] || 'Weighted'}</td>
              {filteredPattern.map((v, c) => <td key={c} className="tri-cell"><div className="tri-inp" style={{ fontWeight: 700, color: 'var(--accent)' }}>{fmt4(v)}</div></td>)}
            </tr>
            <tr>
              <td className="tri-yr" style={{ color: 'rgba(var(--text-rgb),.7)' }}>CDF</td>
              {filteredCdfs.map((v, c) => <td key={c} className="tri-cell"><div className="tri-inp" style={{ color: 'rgba(var(--text-rgb),.75)' }}>{fmt4(v)}</div></td>)}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
