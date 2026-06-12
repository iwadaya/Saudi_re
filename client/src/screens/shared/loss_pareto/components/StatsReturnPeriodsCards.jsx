// loss_pareto/components/StatsReturnPeriodsCards.jsx — the side-by-side
// "Loss Statistics" and "Return Periods" cards (including the CAT
// third-party source badge and Compare-with-TP launcher). Moved verbatim
// from LossParetoScreen.jsx (Phase 4.2); setRpCompareOpen(true) became
// the onOpenRpCompare callback.

import { fmt, fPct, fDec } from '../format.js';
import { DISTS } from '../math/distributions';

export default function StatsReturnPeriodsCards({
  lossType, count, total, avg, mxL, mnL, sd, t5, avgYr, freq, lp, limit,
  activeDist, effectiveReturnPeriods, rpSource, rpBlend, tpSource, onOpenRpCompare,
}) {
  return (
    <div className="llp-grid-layout">
      <div className="llp-card glass">
        <div className="llp-card-head"><div><div className="llp-card-title">{lossType==='cat'?'Cat':'Large'} Loss Statistics</div></div></div>
        <table className="llp-table"><tbody>
          <tr><th>Count</th><td className="num">{count}</td></tr>
          <tr><th>Total Incurred</th><td className="num">{fmt(total)}</td></tr>
          <tr><th>Average</th><td className="num">{fmt(avg)}</td></tr>
          <tr><th>Max / Min</th><td className="num">{fmt(mxL)} / {fmt(mnL)}</td></tr>
          <tr><th>Std Deviation</th><td className="num">{fmt(sd)}</td></tr>
          <tr><th>Top 5 Concentration</th><td className="num">{fPct(t5)}</td></tr>
          <tr><th>Avg Yearly Loss</th><td className="num">{fmt(avgYr)}</td></tr>
          <tr className="llp-row-accent"><th>Frequency (≥ xm)</th><td className="num">{fDec(freq,2)} / yr</td></tr>
          <tr className="llp-row-accent"><th>Risk Pure Premium</th><td className="num">{fmt(lp.rpp)}</td></tr>
          {lp.error&&<tr><th colSpan={2} style={{color:'#f59e0b',fontWeight:400,fontSize:11}}>⚠ {lp.error}: infinite mean</th></tr>}
        </tbody></table>
      </div>
      <div className="llp-card glass">
        <div className="llp-card-head" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div className="llp-card-title">
              Return Periods ({DISTS.find(d=>d.key===activeDist)?.label})
              {lossType === 'cat' && rpSource !== 'FITTED' && (
                <span style={{
                  marginLeft: 8, fontSize: 10, fontWeight: 700, letterSpacing: '.06em',
                  padding: '2px 8px', borderRadius: 999,
                  background: 'rgba(var(--accent-rgb),0.14)', color: 'var(--accent)',
                  textTransform: 'uppercase',
                }}>
                  {rpSource === 'TP'
                    ? `Third-party${tpSource ? ` · ${tpSource}` : ''}`
                    : `Blend ${rpBlend}% fitted / ${100 - rpBlend}% ${tpSource || 'TP'}`}
                </span>
              )}
            </div>
            <div className="llp-card-sub">
              {rpSource === 'FITTED' ? 'Implied severity from fitted tail'
               : rpSource === 'TP'   ? 'From third-party CAT model'
                                     : 'Weighted blend of fitted + third-party'}
            </div>
          </div>
          {lossType === 'cat' && (
            <button
              type="button"
              onClick={() => onOpenRpCompare()}
              style={{
                padding: '6px 12px', borderRadius: 7,
                border: '1px solid var(--hairline)',
                background: 'rgba(var(--accent-rgb),0.08)',
                color: 'var(--accent)', cursor: 'pointer',
                fontSize: 11, fontWeight: 700, letterSpacing: '.04em', textTransform: 'uppercase',
                whiteSpace: 'nowrap',
              }}
              title="Compare against a third-party CAT model"
            >
              Compare with TP →
            </button>
          )}
        </div>
        <table className="llp-table"><thead><tr><th>Return Period</th><th className="num">Estimated Loss</th></tr></thead><tbody>
          {effectiveReturnPeriods.map(rp=>(
            <tr key={rp.rp} className={limit>0&&rp.loss>limit?'llp-over-limit':''}>
              <th>1 in {rp.rp} yr</th>
              <td className="num">{fmt(rp.loss)}{limit>0&&rp.loss>limit&&<span className="llp-exceed"> ▲</span>}</td>
            </tr>
          ))}
        </tbody></table>
      </div>
    </div>
  );
}
