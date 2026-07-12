// components/BfPanels.jsx — Bornhuetter-Ferguson panels (Phase 4.2
// decomposition of DevFactorsScreen.jsx): the loss-BF IELR input bar, the
// premium-BF % achieved bar, and both projection tables. JSX moved VERBATIM;
// numbers pinned by goldenMaster.test.jsx.
import { fmt4, fmtPct } from '../state/devFactorsCalcs';
import { formatWithCommas as fmtN } from '../../../../utils/format';

/* ═══════════════ BF IELR input bar (loss BF) ═══════════════ */
export function BfIelrBar({ inputId, ielr, onIelrChange }) {
  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'center', margin: '12px 0', padding: '10px 16px', borderRadius: 14, background: 'rgba(249,115,22,0.06)', border: '1px solid rgba(249,115,22,0.2)' }}>
      <label style={{ fontSize: 12, color: 'var(--accent-amber)', fontWeight: 600 }} htmlFor={inputId}>Initial Expected Loss Ratio (IELR)</label>
      <input id={inputId} className="fi" type="number" min="0" max="2" step="0.01" value={ielr} onChange={e => onIelrChange(e.target.value)} style={{ width: 100, textAlign: 'center', borderColor: 'rgba(249,115,22,0.4)' }} />
      <span style={{ fontSize: 11, color: 'rgba(var(--text-rgb),.5)' }}>{(Number(ielr) * 100 || 0).toFixed(0)}%</span>
    </div>
  );
}

/* ═══════════════ BF % Achieved Premium bar (premium BF) ═══════════════ */
export function BfPremiumAchievedBar({ inputId, percentAchieved, onPercentAchievedChange, suggestedPercentAchieved, onApplySuggested }) {
  return (
    <div style={{ display: 'flex', gap: 16, alignItems: 'center', margin: '12px 0', padding: '10px 16px', borderRadius: 14, background: 'rgba(99,102,241,0.06)', border: '1px solid rgba(99,102,241,0.20)', flexWrap: 'wrap' }}>
      <label style={{ fontSize: 12, color: 'var(--accent-blue)', fontWeight: 600 }} htmlFor={inputId}>% Achieved Premium</label>
      <input
        id={inputId}
        className="fi"
        type="number"
        min="0"
        max="3"
        step="0.01"
        value={percentAchieved}
        onChange={(e) => onPercentAchievedChange(e.target.value)}
        style={{ width: 100, textAlign: 'center', borderColor: 'rgba(99,102,241,0.4)' }}
      />
      <span style={{ fontSize: 11, color: 'rgba(var(--text-rgb),.5)' }}>
        {(Number(percentAchieved) * 100 || 0).toFixed(0)}%
      </span>
      {suggestedPercentAchieved != null && (
        <button
          type="button"
          onClick={onApplySuggested}
          style={{
            marginLeft: 'auto', fontSize: 11, padding: '4px 10px', borderRadius: 6,
            cursor: 'pointer', border: '1px solid rgba(99,102,241,0.4)',
            background: 'rgba(99,102,241,0.10)', color: 'var(--accent-blue)',
          }}
          title="Average of (current premium ÷ EPI) across years where both are positive"
        >
          Use observed avg ({(suggestedPercentAchieved * 100).toFixed(1)}%)
        </button>
      )}
      <span style={{ fontSize: 11, color: 'rgba(var(--text-rgb),.5)', flexBasis: '100%' }}>
        Average over past years; default 100 %. &gt;100 % means past premium overachieved budget, &lt;100 % means underachieved.
      </span>
    </div>
  );
}

/* ═══════════════ BF Projections Table ═══════════════ */
export function BFProjectionsTable({ bfResults }) {
  if (!bfResults?.length) return null;
  return (
    <div className="df-section">
      <div className="df-section-head">
        <div className="df-section-title">Bornhuetter-Ferguson Projections</div>
        <div className="df-section-sub">Ultimate = Actual + (A Priori × % Unreported)</div>
      </div>
      <div className="df-card"><div className="df-scrollX">
        <table className="df-table">
          <thead><tr>
            <th className="df-h df-h--sticky">Year</th><th className="df-h">Latest</th><th className="df-h">CDF</th>
            <th className="df-h">Premium</th><th className="df-h">IELR</th><th className="df-h">A Priori Ult.</th>
            <th className="df-h">% Unreported</th><th className="df-h">BF IBNR</th><th className="df-h">BF Ultimate</th><th className="df-h">Loss Ratio</th>
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

/* ═══════════════ BF Premium Projections Table ═══════════════ */
export function BFPremiumProjectionsTable({ bfResults, epiPerYear, onEpiChange }) {
  if (!bfResults?.length) return null;
  return (
    <div className="df-section">
      <div className="df-section-head">
        <div className="df-section-title">Bornhuetter-Ferguson Projections (Premium)</div>
        <div className="df-section-sub">Ultimate Premium = Current + (EPI × % Achieved × % Unachieved)</div>
      </div>
      <div className="df-card"><div className="df-scrollX">
        <table className="df-table">
          <thead><tr>
            <th className="df-h df-h--sticky">Year</th>
            <th className="df-h">Current Premium</th>
            <th className="df-h">CDF</th>
            <th className="df-h">EPI</th>
            <th className="df-h">% Achieved</th>
            <th className="df-h">A Priori Ult.</th>
            <th className="df-h">% Unachieved</th>
            <th className="df-h">BF Unearned Premium</th>
            <th className="df-h">BF Ultimate Premium</th>
            <th className="df-h">Achieved Ratio</th>
          </tr></thead>
          <tbody>{bfResults.map((r, i) => (
            <tr key={r.year}>
              <td className="df-r df-r--sticky">{r.year}</td>
              <td className="df-c"><div className="df-val">{fmtN(r.latest)}</div></td>
              <td className="df-c"><div className="df-val">{fmt4(r.cdf)}</div></td>
              <td className="df-c">
                <input
                  className="df-input"
                  type="text"
                  value={epiPerYear?.[i] ?? ''}
                  onChange={(e) => onEpiChange?.(i, e.target.value)}
                  placeholder="0"
                />
              </td>
              <td className="df-c"><div className="df-val">{fmtPct(r.percentAchieved)}</div></td>
              <td className="df-c"><div className="df-val">{fmtN(r.aPrioriUltimate)}</div></td>
              <td className="df-c"><div className="df-val">{fmtPct(r.percentUnachieved)}</div></td>
              <td className="df-c"><div className="df-val">{fmtN(r.bfUnearned)}</div></td>
              <td className="df-c"><div className="df-val" style={{ fontWeight: 700 }}>{fmtN(r.ultimate)}</div></td>
              <td className="df-c"><div className="df-val">{fmtPct(r.achievedRatio)}</div></td>
            </tr>
          ))}</tbody>
        </table>
      </div></div>
    </div>
  );
}
