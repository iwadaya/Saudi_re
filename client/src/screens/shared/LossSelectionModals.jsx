// src/screens/shared/LossSelectionModals.jsx
// Two modals extracted from LossSelectionScreen to keep it under the 800-line
// budget:
//   • YearlyAggregatesModal — per-UW-year aggregate of selected losses (a pure
//     move; the Pareto/Loss-Dev screens consume these totals).
//   • GrowthModal — the Cat-only premium-growth inflation dialog, lifted from
//     inline JSX into a child component with explicit props.
// No behaviour change.
import { useMemo } from 'react';
import PctInput from '../../components/PctInput';
import { fmtOrEm as fmt, toN as cn } from '../../utils/format';

const fp = (n, d = 1) => (n == null ? '—' : `${Number(n).toFixed(d)}%`);

export function YearlyAggregatesModal({ selected, onClose, lossType }) {
  const grouped = useMemo(() => {
    const map = new Map();
    for (const l of selected) {
      const y = Number(l.uw_year);
      if (!Number.isFinite(y)) continue;
      const inflated = cn(l.incurred) * (cn(l.inflation_factor) || 1);
      const cur = map.get(y) || { year: y, count: 0, incurred: 0, inflated: 0 };
      cur.count += 1;
      cur.incurred += cn(l.incurred);
      cur.inflated += inflated;
      map.set(y, cur);
    }
    return [...map.values()].sort((a, b) => a.year - b.year);
  }, [selected]);

  const totals = useMemo(() => grouped.reduce(
    (s, r) => ({ count: s.count + r.count, incurred: s.incurred + r.incurred, inflated: s.inflated + r.inflated }),
    { count: 0, incurred: 0, inflated: 0 },
  ), [grouped]);

  const label = lossType === 'cat' ? 'Cat' : 'Large';

  return (
    <div className="ls-modal-backdrop" role="presentation" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ls-modal">
        <div className="ls-modal-head">
          <div className="ls-modal-title">{label} Loss · Yearly Aggregates</div>
          <button className="ls-modal-x" onClick={onClose}>✕</button>
        </div>
        <div className="ls-modal-body">
          <div className="ls-modal-sub">
            Aggregate of selected losses by UW year. Inflated values use the
            inflation factor applied on this screen and feed the Pareto fit
            on the next step.
          </div>
          <div className="ls-table-wrap" style={{ marginTop: 12 }}>
            <table className="ls-table">
              <thead>
                <tr>
                  <th className="ls-th">UW Year</th>
                  <th className="ls-th ls-th--r">Count</th>
                  <th className="ls-th ls-th--r">Incurred (Σ)</th>
                  <th className="ls-th ls-th--r">Inflated (Σ)</th>
                </tr>
              </thead>
              <tbody>
                {grouped.length === 0 ? (
                  <tr><td colSpan={4} style={{ padding: 18, textAlign: 'center', color: 'rgba(148,163,184,0.55)' }}>No losses selected.</td></tr>
                ) : grouped.map((r) => (
                  <tr key={r.year}>
                    <td>{r.year}</td>
                    <td className="ls-td--r">{r.count}</td>
                    <td className="ls-td--r">{fmt(r.incurred)}</td>
                    <td className="ls-td--r" style={{ fontWeight: 700, color: '#4ade80' }}>{fmt(r.inflated)}</td>
                  </tr>
                ))}
              </tbody>
              {grouped.length > 0 && (
                <tfoot>
                  <tr style={{ background: 'rgba(0,212,255,0.06)', borderTop: '2px solid rgba(0,212,255,0.30)' }}>
                    <td style={{ fontWeight: 800, color: '#00d4ff' }}>TOTAL</td>
                    <td className="ls-td--r" style={{ fontWeight: 700 }}>{totals.count}</td>
                    <td className="ls-td--r" style={{ fontWeight: 700 }}>{fmt(totals.incurred)}</td>
                    <td className="ls-td--r" style={{ fontWeight: 800, color: '#4ade80' }}>{fmt(totals.inflated)}</td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          <div className="ls-modal-actions">
            <button className="ls-btn" onClick={onClose}>Close</button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function GrowthModal({
  growthMode, setGrowthMode, premiumByYear, growthRates, avgGrowth,
  manualGrowthPct, setManualGrowthPct, onApply, onClose,
}) {
  return (
    <div className="ls-modal-backdrop" role="presentation" onClick={e => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="ls-modal">
        <div className="ls-modal-head"><div className="ls-modal-title">Growth in Portfolio</div><button className="ls-modal-x" onClick={onClose}>✕</button></div>
        <div className="ls-modal-body">
          <div className="ls-modal-sub">Use premium growth as a proxy for exposure growth to inflate cat losses, in place of CPI inflation.</div>

          <div className="ls-mode-toggle">
            <button className={`ls-mode-btn ${growthMode === 'calculated' ? 'active' : ''}`} onClick={() => setGrowthMode('calculated')}>From Premiums</button>
            <button className={`ls-mode-btn ${growthMode === 'manual' ? 'active' : ''}`} onClick={() => setGrowthMode('manual')}>Manual Rate</button>
          </div>

          {growthMode === 'calculated' && (
            <div className="ls-modal-section">
              {premiumByYear.length < 2 ? <div className="ls-modal-empty">Need at least 2 years of premium data to calculate growth.</div> : (
                <>
                  <div className="ls-infl-table-wrap">
                    <table className="ls-infl-table">
                      <thead><tr><th>Year</th><th>Premium</th><th>Growth %</th></tr></thead>
                      <tbody>
                        {growthRates.map((r, i) => <tr key={i}><td>{r.year}</td><td>{fmt(r.premium)}</td><td className={r.growth < 0 ? 'ls-neg' : ''}>{fp(r.growth)}</td></tr>)}
                      </tbody>
                    </table>
                  </div>
                  <div className="ls-modal-avg">Average growth: <strong>{fp(avgGrowth)}</strong></div>
                </>
              )}
            </div>
          )}

          {growthMode === 'manual' && (
            <div className="ls-modal-section">
              <div className="ls-field" style={{ marginTop: 8 }}>
                <span className="ls-flabel">Annual Growth Rate</span>
                <PctInput className="ls-finput" value={manualGrowthPct} onChange={v => setManualGrowthPct(v)} style={{ width: 90 }} />
              </div>
            </div>
          )}

          <div className="ls-modal-actions">
            <button className="ls-btn" onClick={onClose}>Cancel</button>
            <button className="ls-btn ls-btn--blue" onClick={onApply}>
              Apply {growthMode === 'calculated' ? `${fp(avgGrowth)} Growth` : 'Manual Growth'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
