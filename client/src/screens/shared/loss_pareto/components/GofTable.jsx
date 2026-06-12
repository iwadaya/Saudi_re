// loss_pareto/components/GofTable.jsx — goodness-of-fit card (KS ranking
// of the four fitted distributions, radio select for the active one).
// Moved verbatim from LossParetoScreen.jsx (Phase 4.2);
// setActiveDist(f.key) became the onSelectDist callback.

import { fDec } from '../format.js';
import { DISTS } from '../math/distributions';

export default function GofTable({ fits, bestFit, activeDist, onSelectDist }) {
  return (
    <div className="llp-card glass" style={{marginBottom:16}}>
      <div className="llp-card-head"><div><div className="llp-card-title">Goodness of Fit</div><div className="llp-card-sub">Select a distribution to use for return periods and pricing. KS statistic: lower = better fit.</div></div></div>
      <div style={{overflowX:'auto'}}>
        <table className="llp-table llp-gof-table">
          <thead><tr><th>Use</th><th>Distribution</th><th>Parameters</th><th className="num">n</th><th className="num">KS Stat</th><th className="num">p-value</th><th>Verdict</th></tr></thead>
          <tbody>
            {fits.map(f=>{
              const d=DISTS.find(d=>d.key===f.key);const best=f.key===bestFit;const selected=f.key===activeDist;
              const verd=f.ks.ks<.1?'Excellent':f.ks.ks<.2?'Good':f.ks.ks<.35?'Fair':'Poor';
              const vc=f.ks.ks<.1?'#4ade80':f.ks.ks<.2?'#22d3ee':f.ks.ks<.35?'#f59e0b':'#ef4444';
              return(<tr key={f.key} className={selected?'llp-selected-row':best?'llp-best-row':''} style={{cursor:'pointer'}} onClick={()=>onSelectDist(f.key)}>
                <td style={{textAlign:'center'}}><input type="radio" name="distSelect" checked={selected} onChange={()=>onSelectDist(f.key)} style={{accentColor:d?.color,cursor:'pointer'}}/></td>
                <td><span className="llp-dist-dot" style={{background:d?.color}}/>{d?.label}{best&&<span className="llp-best-badge">BEST</span>}</td>
                <td className="llp-mono">{f.paramStr}</td><td className="num">{f.n}</td>
                <td className="num llp-mono">{fDec(f.ks.ks,4)}</td><td className="num llp-mono">{fDec(f.ks.pValue,4)}</td>
                <td><span style={{color:vc,fontWeight:600,fontSize:11}}>{verd}</span></td>
              </tr>);
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
