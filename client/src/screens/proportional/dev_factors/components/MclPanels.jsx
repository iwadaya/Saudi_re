// components/MclPanels.jsx — Munich Chain Ladder panels (Phase 4.2
// decomposition of DevFactorsScreen.jsx): the toggle/help card and the MCL
// projections table. JSX moved VERBATIM; numbers pinned by
// goldenMaster.test.jsx.
import { formatWithCommas as fmtN } from '../../../../utils/format';

/* ═══════════════ Munich Chain Ladder toggle + explainer card ═══════════════ */
export function MunichToggleCard({ munichAvailable, useMunich, onToggleMunich, showMunichHelp, onToggleHelp, mclResult }) {
  return (
    <div
      style={{
        display: 'flex', flexDirection: 'column', gap: 6,
        margin: '8px 0 12px', padding: '10px 14px', borderRadius: 12,
        background: 'rgba(56,189,248,0.06)',
        border: '1px solid rgba(56,189,248,0.20)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <label
          title={munichAvailable
            ? 'Run the Munich Chain Ladder using paid + incurred (paid + OS) triangles.'
            : 'Munich Chain Ladder needs both Paid and OS Claims triangles. Open the Incurred Development Factors screen to use it.'}
          style={{
            display: 'flex', alignItems: 'center', gap: 8,
            cursor: munichAvailable ? 'pointer' : 'not-allowed',
            opacity: munichAvailable ? 1 : 0.55,
            fontSize: 13, color: 'var(--accent-blue)', fontWeight: 600,
          }}
        >
          <input
            type="checkbox"
            disabled={!munichAvailable}
            checked={!!useMunich && munichAvailable}
            onChange={(e) => onToggleMunich(e.target.checked)}
          />
          Use Munich Chain Ladder
        </label>
        <button
          type="button"
          onClick={onToggleHelp}
          style={{
            fontSize: 11, padding: '3px 10px', borderRadius: 6,
            cursor: 'pointer', border: '1px solid rgba(56,189,248,0.35)',
            background: 'rgba(56,189,248,0.08)', color: 'var(--accent-blue)',
          }}
        >
          {showMunichHelp ? 'Hide info' : 'When to use this?'}
        </button>
        {!munichAvailable && (
          <span style={{ fontSize: 11, color: 'rgba(var(--text-rgb),.5)' }}>
            Available on the Incurred Development Factors screen.
          </span>
        )}
      </div>
      {showMunichHelp && (
        <div style={{ fontSize: 12, lineHeight: 1.55, color: 'rgba(var(--text-rgb),.85)' }}>
          <b style={{ color: 'var(--accent-blue)' }}>What it does.</b>{' '}
          Munich Chain Ladder (Quarg & Mack, 2004) extends the standard chain ladder by
          using the correlation between paid/incurred (P/I) ratios and the link ratios.
          Each step's link ratio is adjusted upward when paid is currently below the
          P/I average for the column, and downward when paid is above — and symmetrically
          for incurred. The two correlation slopes λ_P and λ_I are estimated once from
          Pearson residuals on the historical triangle.
          <br /><br />
          <b style={{ color: 'var(--accent-blue)' }}>When to use it.</b>{' '}
          Reach for MCL when:
          <ul style={{ margin: '4px 0 4px 18px' }}>
            <li>The paid-only and incurred-only chain-ladder ultimates persistently disagree.</li>
            <li>You have enough history (≥ 3 origin years × ≥ 3 dev periods) for residuals to be meaningful.</li>
            <li>The book has a stable case-reserving philosophy — MCL assumes the P/I relationship is informative.</li>
          </ul>
          <b style={{ color: 'var(--accent-blue)' }}>When to avoid it.</b>{' '}
          Skip MCL on very thin triangles, on lines where case reserves swing wildly
          (the residual correlation becomes noise rather than signal), or when paid and
          incurred ultimates already agree — vanilla CL is simpler and as accurate.
          {mclResult && (
            <>
              <br /><br />
              <b style={{ color: 'var(--accent-blue)' }}>This triangle:</b>{' '}
              λ_P = {mclResult.lambdaP == null ? '—' : mclResult.lambdaP.toFixed(4)},
              {' '}λ_I = {mclResult.lambdaI == null ? '—' : mclResult.lambdaI.toFixed(4)}.
              {mclResult.warnings?.length > 0 && (
                <span style={{ color: 'var(--accent-amber)' }}> {mclResult.warnings.join(' ')}</span>
              )}
            </>
          )}
        </div>
      )}
    </div>
  );
}

/* ═══════════════ Munich Chain Ladder Projections Table ═══════════════ */
export function MclProjectionsTable({ mcl }) {
  if (!mcl?.projections?.length) return null;
  return (
    <div className="df-section">
      <div className="df-section-head">
        <div className="df-section-title">Munich Chain Ladder Projections</div>
        <div className="df-section-sub">
          Cell-by-cell link ratios adjusted by current P/I (λ_P = {mcl.lambdaP == null ? '—' : mcl.lambdaP.toFixed(4)},
          λ_I = {mcl.lambdaI == null ? '—' : mcl.lambdaI.toFixed(4)})
        </div>
      </div>
      <div className="df-card"><div className="df-scrollX">
        <table className="df-table">
          <thead><tr>
            <th className="df-h df-h--sticky">Year</th>
            <th className="df-h">Latest Paid</th>
            <th className="df-h">Latest Incurred</th>
            <th className="df-h">MCL Ult. Paid</th>
            <th className="df-h">MCL Ult. Incurred</th>
            <th className="df-h">IBNR (Paid)</th>
            <th className="df-h">IBNR (Incurred)</th>
            <th className="df-h">Gap (I − P)</th>
          </tr></thead>
          <tbody>{mcl.projections.map(p => (
            <tr key={p.year}>
              <td className="df-r df-r--sticky">{p.year}</td>
              <td className="df-c"><div className="df-val">{fmtN(p.latestPaid)}</div></td>
              <td className="df-c"><div className="df-val">{fmtN(p.latestIncurred)}</div></td>
              <td className="df-c"><div className="df-val" style={{ fontWeight: 700 }}>{fmtN(p.ultimatePaid)}</div></td>
              <td className="df-c"><div className="df-val" style={{ fontWeight: 700 }}>{fmtN(p.ultimateIncurred)}</div></td>
              <td className="df-c"><div className="df-val">{fmtN(p.ibnrPaid)}</div></td>
              <td className="df-c"><div className="df-val">{fmtN(p.ibnrIncurred)}</div></td>
              <td className="df-c"><div className="df-val">{fmtN(p.ultimateIncurred - p.ultimatePaid)}</div></td>
            </tr>
          ))}</tbody>
        </table>
      </div></div>
      {mcl.warnings?.length > 0 && (
        <div style={{ marginTop: 8, fontSize: 11, color: 'var(--accent-amber)' }}>
          {mcl.warnings.map((w, i) => <div key={i}>⚠ {w}</div>)}
        </div>
      )}
    </div>
  );
}
