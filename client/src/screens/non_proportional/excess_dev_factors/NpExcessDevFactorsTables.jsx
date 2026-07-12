// src/screens/non_proportional/excess_dev_factors/NpExcessDevFactorsTables.jsx
// The presentational tables of the NP excess dev-factors screen — FactorTable,
// BFProjectionsTable, LinkRatioView, UltimateSummaryTable — plus the number
// formatters they use, extracted to keep the screen under the 800-line budget.
// No behaviour change; props unchanged.
import { useEffect, useMemo, useCallback } from 'react';
import { calculateAgeToAgeFactors } from '../../../logic/chainLadder';

const fmt4  = n => (n == null || !Number.isFinite(Number(n))) ? '' : Number(n).toFixed(4);
const fmtN  = n => (n == null || !Number.isFinite(Number(n))) ? '' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 });
const fmtPct = n => (n == null || !Number.isFinite(Number(n))) ? '' : (Number(n) * 100).toFixed(1) + '%';

export function FactorTable({ pattern, cdfs, editable, onChange, sectionClass }) {
  const N = pattern?.length || 0;
  if (!N) return <div className="muted" style={{ padding: 12 }}>No factors calculated.</div>;
  const headers = Array.from({ length: N }, (_, i) => `${i + 1}–${i + 2}`);
  return (
    <div className={`df-card ${sectionClass || ''}`}>
      <div className="df-scrollX">
        <table className="df-table">
          <thead><tr>
            <th className="df-h df-h--sticky">Factor</th>
            {headers.map(h => <th key={h} className="df-h">{h}</th>)}
          </tr></thead>
          <tbody>
            <tr>
              <td className="df-r df-r--sticky">LDF</td>
              {(pattern || []).map((v, i) => (
                <td key={i} className="df-c">{editable
                  ? <input className="df-input" value={fmt4(v)} onChange={e => onChange?.('ldf', i, e.target.value)} />
                  : <div className="df-val">{fmt4(v)}</div>}
                </td>
              ))}
            </tr>
            <tr>
              <td className="df-r df-r--sticky">CDF</td>
              {(cdfs || []).slice(0, N).map((v, i) => (
                <td key={i} className="df-c">{editable
                  ? <input className="df-input" value={fmt4(v)} onChange={e => onChange?.('cdf', i, e.target.value)} />
                  : <div className="df-val">{fmt4(v)}</div>}
                </td>
              ))}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── BF Projections Table ──────────────────────────────────
export function BFProjectionsTable({ bfResults }) {
  if (!bfResults?.length) return null;
  return (
    <div className="df-section">
      <div className="df-section-head">
        <div className="df-section-title">Bornhuetter-Ferguson Projections</div>
        <div className="df-section-sub">Ultimate = Actual Excess + (A Priori × % Unreported)</div>
      </div>
      <div className="df-card"><div className="df-scrollX">
        <table className="df-table">
          <thead><tr>
            <th className="df-h df-h--sticky">Year</th>
            <th className="df-h">Latest XS</th>
            <th className="df-h">CDF</th>
            <th className="df-h">EGNPI</th>
            <th className="df-h">IELR</th>
            <th className="df-h">A Priori Ult.</th>
            <th className="df-h">% Unreported</th>
            <th className="df-h">BF IBNR</th>
            <th className="df-h">BF Ultimate</th>
            <th className="df-h">XS Loss Ratio</th>
          </tr></thead>
          <tbody>{bfResults.map(r => (
            <tr key={r.year}>
              <td className="df-r df-r--sticky">{r.year}</td>
              <td className="df-c"><div className="df-val">{fmtN(r.latest)}</div></td>
              <td className="df-c"><div className="df-val">{fmt4(r.cdf)}</div></td>
              <td className="df-c"><div className="df-val">{fmtN(r.premium)}</div></td>
              <td className="df-c"><div className="df-val">{fmtPct(r.ielr)}</div></td>
              <td className="df-c"><div className="df-val">{fmtN(r.aPrioriUltimate)}</div></td>
              <td className="df-c"><div className="df-val">{fmtPct(r.percentUnreported)}</div></td>
              <td className="df-c"><div className="df-val">{fmtN(r.expectedIbnr)}</div></td>
              <td className="df-c"><div className="df-val" style={{ fontWeight: 700 }}>{fmtN(r.ultimate)}</div></td>
              <td className="df-c"><div className="df-val">{fmtPct(r.lossRatio)}</div></td>
            </tr>
          ))}</tbody>
        </table>
      </div></div>
    </div>
  );
}

// ── Link Ratio View ───────────────────────────────────────
export function LinkRatioView({ matrix, years, numDevYears, excluded, setExcluded, onPatternChange }) {
  // Rules-of-hooks: every hook must run on every render. The early
  // return that was here made the useEffect below conditional. All
  // hooks now run first; render branches at the end.
  const factors = useMemo(() => matrix ? calculateAgeToAgeFactors(matrix) : null, [matrix]);
  const N = numDevYears - 1;
  const devHeaders = Array.from({ length: N }, (_, i) => `${i + 1}–${i + 2}`);
  const inTriangle = useCallback((r, c) => r + c < N, [N]);

  const toggle = (r, c) => {
    const key = `${r}:${c}`;
    setExcluded(prev => { const s = new Set(prev); s.has(key) ? s.delete(key) : s.add(key); return s; });
  };

  const { filteredPattern, filteredCdfs } = useMemo(() => {
    const pattern = [];
    if (matrix && factors) {
      for (let c = 0; c < N; c++) {
        let sumPrev = 0, sumCur = 0;
        for (let r = 0; r < matrix.length; r++) {
          if (!inTriangle(r, c)) continue;
          if (excluded.has(`${r}:${c}`)) continue;
          if (factors[r]?.[c] != null) { sumPrev += matrix[r][c]; sumCur += matrix[r][c + 1]; }
        }
        pattern.push(sumPrev !== 0 ? sumCur / sumPrev : 1.0);
      }
    }
    const cdfs = new Array(pattern.length + 1).fill(1.0);
    for (let i = pattern.length - 1; i >= 0; i--) cdfs[i] = pattern[i] * cdfs[i + 1];
    return { filteredPattern: pattern, filteredCdfs: cdfs.slice(0, pattern.length) };
  }, [excluded, factors, inTriangle, matrix, N]);

  useEffect(() => { onPatternChange?.(filteredPattern, filteredCdfs); }, [filteredCdfs, filteredPattern, onPatternChange]);

  if (!matrix) return <div className="muted" style={{ padding: 12 }}>No triangle data. Enter data in the triangle tab first.</div>;

  return (
    <div>
      <div style={{ fontSize: 11, color: 'rgba(var(--text-rgb),0.7)', marginBottom: 8, padding: '8px 14px', borderRadius: 10, background: 'rgba(249,115,22,0.06)', border: '1px solid rgba(249,115,22,0.15)' }}>
        Click any link ratio to exclude/include from weighted average. Excluded cells shown in red strikethrough.
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="tri-table">
          <thead><tr>
            <th className="tri-hdr" style={{ minWidth: 52 }}>Year</th>
            {devHeaders.map(h => <th key={h} className="tri-hdr">{h}</th>)}
          </tr></thead>
          <tbody>
            {years.map((yr, r) => (
              <tr key={yr}>
                <td className="tri-yr">{yr}</td>
                {Array.from({ length: N }, (_, c) => {
                  const f = inTriangle(r, c) ? factors[r]?.[c] : null;
                  const isExcl = excluded.has(`${r}:${c}`);
                  return (
                    <td key={c} className={f == null ? 'tri-off' : 'tri-cell'} onClick={() => f != null && toggle(r, c)} style={{ cursor: f != null ? 'pointer' : 'default' }}>
                      {f != null && <div className="tri-inp" style={{ textDecoration: isExcl ? 'line-through' : 'none', opacity: isExcl ? 0.35 : 1, color: isExcl ? 'var(--accent-rose)' : 'rgba(var(--text-rgb),0.88)' }}>{fmt4(f)}</div>}
                    </td>
                  );
                })}
              </tr>
            ))}
            <tr style={{ borderTop: '2px solid rgba(var(--accent-rgb),0.3)' }}>
              <td className="tri-yr" style={{ color: 'var(--accent)' }}>Weighted</td>
              {filteredPattern.map((v, c) => <td key={c} className="tri-cell"><div className="tri-inp" style={{ fontWeight: 700, color: 'var(--accent)' }}>{fmt4(v)}</div></td>)}
            </tr>
            <tr>
              <td className="tri-yr" style={{ color: 'rgba(var(--text-rgb),0.7)' }}>CDF</td>
              {filteredCdfs.map((v, c) => <td key={c} className="tri-cell"><div className="tri-inp" style={{ color: 'rgba(var(--text-rgb),0.75)' }}>{fmt4(v)}</div></td>)}
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ── Ultimate Summary Table ────────────────────────────────
export function UltimateSummaryTable({ years, chosenCdfs, manualLosses, premiums }) {
  const rows = useMemo(() => {
    return years.map((yr, i) => {
      const reported = Number(manualLosses[i] ?? 0) || 0;
      // For manual-entry mode: each year has one reported value; we apply CDF[i] where i is
      // roughly the current age (assume latest diagonal = dev period = year index from end)
      const ageIdx = Math.max(0, years.length - 1 - i); // oldest year = most developed
      const appliedCdf = Number(chosenCdfs[ageIdx] ?? chosenCdfs[chosenCdfs.length - 1] ?? 1) || 1;
      const ultimate = reported * appliedCdf;
      const ibnr = ultimate - reported;
      const prem = Number(premiums[i] ?? 0) || 0;
      const xsLr = prem > 0 ? ultimate / prem : null;
      return { year: yr, reported, appliedCdf, ultimate, ibnr, xsLr };
    });
  }, [years, chosenCdfs, manualLosses, premiums]);

  const totReported = rows.reduce((s, r) => s + r.reported, 0);
  const totUltimate = rows.reduce((s, r) => s + r.ultimate, 0);
  const totIbnr = rows.reduce((s, r) => s + r.ibnr, 0);

  return (
    <div className="df-section">
      <div className="df-section-head">
        <div className="df-section-title">Ultimate Excess Loss Summary</div>
        <div className="df-section-sub">Applied chosen CDFs to reported excess losses per accident year</div>
      </div>
      <div className="df-card"><div className="df-scrollX">
        <table className="df-table">
          <thead><tr>
            <th className="df-h df-h--sticky">Year</th>
            <th className="df-h">Reported XS Loss</th>
            <th className="df-h">Applied CDF</th>
            <th className="df-h">IBNR</th>
            <th className="df-h">Ultimate XS Loss</th>
            <th className="df-h">XS Loss Ratio</th>
          </tr></thead>
          <tbody>
            {rows.map(r => (
              <tr key={r.year}>
                <td className="df-r df-r--sticky">{r.year}</td>
                <td className="df-c"><div className="df-val">{fmtN(r.reported)}</div></td>
                <td className="df-c"><div className="df-val">{fmt4(r.appliedCdf)}</div></td>
                <td className="df-c"><div className="df-val">{fmtN(r.ibnr)}</div></td>
                <td className="df-c"><div className="df-val" style={{ fontWeight: 700 }}>{fmtN(r.ultimate)}</div></td>
                <td className="df-c"><div className="df-val">{r.xsLr != null ? fmtPct(r.xsLr) : '—'}</div></td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: '2px solid rgba(34,197,94,0.25)' }}>
              <td className="df-r df-r--sticky" style={{ color: 'var(--accent)' }}>Total</td>
              <td className="df-c"><div className="df-val" style={{ color: 'var(--accent)' }}>{fmtN(totReported)}</div></td>
              <td className="df-c"><div className="df-val">—</div></td>
              <td className="df-c"><div className="df-val" style={{ color: 'var(--accent-rose)' }}>{fmtN(totIbnr)}</div></td>
              <td className="df-c"><div className="df-val" style={{ color: 'var(--accent)', fontWeight: 700 }}>{fmtN(totUltimate)}</div></td>
              <td className="df-c"><div className="df-val">—</div></td>
            </tr>
          </tfoot>
        </table>
      </div></div>
    </div>
  );
}

// ══════════════════════════════════════════════════════════
//  MAIN SCREEN
// ══════════════════════════════════════════════════════════
