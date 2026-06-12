// loss_pareto/components/ParetoRankingTable.jsx — the Pareto ranking
// card: per-loss table with cum% and fitted return periods, or the
// yearly-aggregates variant for Stop Loss treaties. Moved verbatim from
// LossParetoScreen.jsx (Phase 4.2).

import { toN as cn } from '../../../../utils/format';
import { fmt, fPct } from '../format.js';
import { lossReturnPeriod } from '../math/distributions';

export default function ParetoRankingTable({ stopLossTreaty, pareto, freq, survivalFn }) {
  return (
    <div className="llp-card glass" style={{marginTop:16}}>
      <div className="llp-card-head"><div><div className="llp-card-title">{stopLossTreaty ? 'Yearly Aggregates · Ranking' : 'Pareto Ranking'}</div></div></div>
      <div style={{overflowX:'auto'}}>
        {stopLossTreaty ? (
          <table className="llp-table" style={{width:'100%'}}>
            <thead><tr><th>#</th><th>UW Yr</th><th className="num">Aggregate (Inflated)</th><th className="num">Cum%</th></tr></thead>
            <tbody>{pareto.map(p=>(
              <tr key={p.rank}>
                <td>{p.rank}</td>
                <td>{p.uw_year||'—'}</td>
                <td className="num" style={{fontWeight:600}}>{fmt(p.inflated)}</td>
                <td className="num" style={{color:p.cumPct>.8?'#f97316':'#4ade80'}}>{fPct(p.cumPct)}</td>
              </tr>
            ))}</tbody>
          </table>
        ) : (
          <table className="llp-table" style={{width:'100%'}}>
            <thead><tr><th>#</th><th>UW Yr</th><th>Insured / Event</th><th>Loss</th><th className="num">Paid</th><th className="num">OS</th><th className="num">Incurred</th><th>Infl.</th><th className="num">Inflated</th><th className="num">Cum%</th><th className="num">Return Period</th></tr></thead>
            <tbody>{pareto.map(p=>(
              <tr key={p.rank}><td>{p.rank}</td><td>{p.uw_year||'—'}</td><td>{p.insured_name||p.event_name||'—'}</td><td>{p.loss_name||'—'}</td>
                <td className="num">{fmt(cn(p.paid))}</td><td className="num">{fmt(cn(p.os))}</td><td className="num">{fmt(p.incurred)}</td>
                <td>{cn(p.inflation_factor).toFixed(2)}</td><td className="num" style={{fontWeight:600}}>{fmt(p.inflated)}</td>
                <td className="num" style={{color:p.cumPct>.8?'#f97316':'#4ade80'}}>{fPct(p.cumPct)}</td>
                {(() => {
                  const rp = lossReturnPeriod(p.inflated, freq, survivalFn);
                  if (rp == null) return <td className="num">—</td>;
                  const label = rp >= 10000 ? '>10,000y'
                    : rp >= 1000 ? `${Math.round(rp / 100) * 100}y`
                    : rp >= 100  ? `${Math.round(rp / 10) * 10}y`
                    : rp >= 10   ? `${Math.round(rp)}y`
                    :              `${rp.toFixed(1)}y`;
                  const color = rp >= 50 ? '#f87171' : rp >= 10 ? '#f59e0b' : '#4ade80';
                  return (
                    <td className="num" style={{ color, fontWeight: 600 }}>
                      {label}
                    </td>
                  );
                })()}
              </tr>
            ))}</tbody>
          </table>
        )}
      </div>
    </div>
  );
}
