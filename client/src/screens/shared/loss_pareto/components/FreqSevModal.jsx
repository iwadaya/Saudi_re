// loss_pareto/components/FreqSevModal.jsx — the frequency–severity
// analysis modal (distribution tabs, parameter explanations, severity /
// frequency / return-period charts), moved verbatim from
// LossParetoScreen.jsx (Phase 4.2). Only the state writes changed:
// setShowChart/setActiveDist became the onClose/onSelectDist callbacks.

import { fmt, fPct, fDec } from '../format.js';
import { DISTS, poissonPMF } from '../math/distributions';
import { ReturnPeriodChart, SeverityChart, FrequencyChart } from './ParetoCharts.jsx';

export default function FreqSevModal({ lossType, activeDist, onSelectDist, fits, xm, limit, alpha, freq, uwYrs, inflated, onClose }) {
  return (
    <div className="llp-modal-backdrop is-open" role="presentation" onClick={e=>{if(e.target===e.currentTarget)onClose();}}>
      <div className="llp-modal glass" style={{width:'min(1100px,96vw)',maxHeight:'92vh',display:'flex',flexDirection:'column'}}>
        <div className="llp-modal-head">
          <div className="llp-modal-title">Frequency–Severity Analysis · {lossType==='cat'?'Cat':'Large'} Losses</div>
          <button className="llp-modal-x" onClick={()=>onClose()}>✕</button>
        </div>
        <div style={{overflowY:'auto',padding:'14px 20px 18px'}}>
          <div className="llp-dist-tabs" style={{marginBottom:12}}>
            {DISTS.map(d=>(
              <button key={d.key} className={`llp-dist-tab ${activeDist===d.key?'active':''}`}
                style={activeDist===d.key?{borderColor:d.color,color:d.color}:{}}
                onClick={()=>onSelectDist(d.key)}>{d.label}</button>
            ))}
          </div>

          <ParameterExplanations
            activeDist={activeDist} fits={fits} xm={xm} limit={limit}
            freq={freq} uwYrs={uwYrs} tailN={inflated.filter(l=>l>=xm).length}
          />

          <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14,marginTop:14}}>
            <div>
              <div style={{fontSize:11,fontWeight:700,letterSpacing:'.08em',textTransform:'uppercase',color:'rgba(255,255,255,.65)',marginBottom:4}}>Severity Curve</div>
              <div style={{fontSize:11,color:'rgba(255,255,255,.55)',marginBottom:8}}>Probability density of a single loss size, given it exceeded the threshold. Bars = empirical histogram, line = fitted {DISTS.find(d=>d.key===activeDist)?.label} PDF.</div>
              <div className="llp-chart-wrap" style={{minHeight:300}}><SeverityChart losses={inflated} xm={xm} limit={limit} fits={fits} activeDist={activeDist}/></div>
            </div>
            <div>
              <div style={{fontSize:11,fontWeight:700,letterSpacing:'.08em',textTransform:'uppercase',color:'rgba(255,255,255,.65)',marginBottom:4}}>Frequency Curve</div>
              <div style={{fontSize:11,color:'rgba(255,255,255,.55)',marginBottom:8}}>Annual count of losses ≥ threshold, modelled as Poisson(λ). Bar height = probability of exactly N events in a year.</div>
              <div className="llp-chart-wrap" style={{minHeight:300}}><FrequencyChart lambda={freq}/></div>
            </div>
          </div>

          <div style={{marginTop:14}}>
            <div style={{fontSize:11,fontWeight:700,letterSpacing:'.08em',textTransform:'uppercase',color:'rgba(255,255,255,.65)',marginBottom:4}}>Annual Exceedance Frequency (Return Period View)</div>
            <div style={{fontSize:11,color:'rgba(255,255,255,.55)',marginBottom:8}}>Combines severity and frequency: how often per year a loss of a given size is exceeded. Return period = 1 / annual exceedance frequency.</div>
            <div className="llp-chart-wrap" style={{minHeight:300}}><ReturnPeriodChart losses={inflated} alpha={alpha} xm={xm} limit={limit} fits={fits} activeDist={activeDist}/></div>
          </div>

          <div style={{marginTop:14,padding:'12px 14px',background:'rgba(56,189,248,.06)',border:'1px solid rgba(56,189,248,.18)',borderRadius:10,fontSize:12,color:'rgba(226,232,240,.85)',lineHeight:1.5}}>
            <div style={{fontWeight:700,color:'#7dd3fc',marginBottom:6}}>How underwriters should read this</div>
            <div>• <b>Severity</b> tells you how big a single claim is likely to be once it breaches the threshold. A heavier-tailed shape (low Pareto α, high Lognormal σ) means more weight on extreme losses.</div>
            <div>• <b>Frequency</b> tells you how many such claims to expect per year. P(at least 1) is the chance of any threshold-breaching loss in the year.</div>
            <div>• <b>Pure premium</b> for a layer = E[N] × E[loss in layer]. Frequency drives the count, severity drives the size — both must look reasonable.</div>
            <div>• Switch distributions in the tabs to see how each fit changes the implied tail. The KS table on the main page ranks fits objectively.</div>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════
   PARAMETER EXPLANATIONS PANEL
   Plain-English summary of every parameter feeding the curves,
   so an underwriter can sense-check the fit at a glance.
   ══════════════════════════════════════════ */
function ParameterExplanations({activeDist,fits,xm,limit,freq,uwYrs,tailN}){
  const f=fits.find(f=>f.key===activeDist);
  const distLabel=DISTS.find(d=>d.key===activeDist)?.label||'Pareto';
  const distColor=DISTS.find(d=>d.key===activeDist)?.color||'#22c55e';

  // Distribution-specific parameter rows
  const sevRows=[];
  if(activeDist==='pareto'&&f){
    const a=f.params.alpha;
    const tailNote=a<=1?'α ≤ 1 → infinite mean (cannot price a layer)':a<2?'1 < α < 2 → finite mean, infinite variance (very heavy tail)':a<3?'2 ≤ α < 3 → heavy tail, finite variance':'α ≥ 3 → relatively light tail';
    sevRows.push({sym:'α',val:fDec(a,3),desc:'Tail heaviness. Lower α = heavier tail; doubling the loss size only divides probability by 2^α.',note:tailNote});
    sevRows.push({sym:'xm',val:fmt(xm),desc:'Threshold (Pareto minimum). Only losses ≥ xm enter the tail fit.'});
  } else if(activeDist==='lognormal'&&f){
    const {mu,sigma}=f.params;
    sevRows.push({sym:'μ',val:fDec(mu,3),desc:'Mean of ln(loss). The median of a lognormal is exp(μ).',note:`Median ≈ ${fmt(Math.exp(mu))}`});
    sevRows.push({sym:'σ',val:fDec(sigma,3),desc:'Std-dev of ln(loss). Higher σ = wider, more skewed loss distribution.',note:sigma>1.5?'σ > 1.5 → very heavy skew':sigma>1?'σ > 1 → heavily skewed':'σ ≤ 1 → moderately skewed'});
    sevRows.push({sym:'xm',val:fmt(xm),desc:'Threshold used as the lower truncation point for fitting and KS.'});
  } else if(activeDist==='exponential'&&f){
    const {lambda}=f.params;
    sevRows.push({sym:'λ_s',val:fDec(lambda,8),desc:'Severity rate. Mean excess loss above threshold = 1/λ_s.',note:lambda>0?`Mean excess ≈ ${fmt(1/lambda)}`:''});
    sevRows.push({sym:'xm',val:fmt(xm),desc:'Threshold; severity is shifted exponential on (xm, ∞).'});
  } else if(activeDist==='weibull'&&f){
    const {k,lam}=f.params;
    const shapeNote=k<1?'k < 1 → heavier than exponential (decreasing hazard)':k===1?'k = 1 → exponential':k<2?'1 < k < 2 → lighter than exponential':'k ≥ 2 → light tail';
    sevRows.push({sym:'k',val:fDec(k,3),desc:'Weibull shape. Controls tail heaviness via the hazard slope.',note:shapeNote});
    sevRows.push({sym:'λ_w',val:fmt(lam),desc:'Weibull scale (in loss currency, measured from xm).'});
    sevRows.push({sym:'xm',val:fmt(xm),desc:'Threshold; Weibull is shifted by xm.'});
  }
  if(limit>0)sevRows.push({sym:'Limit',val:fmt(limit),desc:'Treaty / structure limit. Used to flag return-period losses that would breach cover.'});

  const cell={padding:'8px 10px',fontSize:12,verticalAlign:'top',borderBottom:'1px solid rgba(255,255,255,.05)'};
  const symStyle={fontFamily:'var(--font-mono)',fontWeight:700,color:'#fff',width:64,whiteSpace:'nowrap'};
  const valStyle={fontFamily:'var(--font-mono)',color:'rgba(226,232,240,.95)',width:140,whiteSpace:'nowrap'};
  const descStyle={color:'rgba(226,232,240,.78)',lineHeight:1.4};
  const noteStyle={color:'rgba(148,163,184,.85)',fontStyle:'italic',fontSize:11,marginTop:2};

  return(
    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14}}>
      {/* Severity model */}
      <div style={{border:`1px solid ${distColor}33`,borderRadius:10,background:'rgba(8,16,40,.35)',overflow:'hidden'}}>
        <div style={{padding:'10px 14px',background:`linear-gradient(to right, ${distColor}22, transparent)`,borderBottom:`1px solid ${distColor}33`}}>
          <div style={{fontSize:11,fontWeight:700,letterSpacing:'.08em',textTransform:'uppercase',color:distColor}}>Severity Model · {distLabel}</div>
          <div style={{fontSize:11,color:'rgba(226,232,240,.65)',marginTop:2}}>How big is one loss, given it exceeds the threshold? Fit on n = {f?.n||0} tail observations.</div>
        </div>
        <table style={{width:'100%',borderCollapse:'collapse'}}>
          <tbody>
            {sevRows.map((r,i)=>(
              <tr key={i}>
                <td style={{...cell,...symStyle}}>{r.sym}</td>
                <td style={{...cell,...valStyle}}>{r.val}</td>
                <td style={{...cell,...descStyle}}>{r.desc}{r.note&&<div style={noteStyle}>{r.note}</div>}</td>
              </tr>
            ))}
            {f&&<tr>
              <td style={{...cell,...symStyle}}>KS</td>
              <td style={{...cell,...valStyle}}>{fDec(f.ks.ks,4)} (p={fDec(f.ks.pValue,3)})</td>
              <td style={{...cell,...descStyle}}>Kolmogorov–Smirnov goodness-of-fit. Lower KS = closer match to empirical data; p &gt; 0.05 means the fit is statistically acceptable.</td>
            </tr>}
          </tbody>
        </table>
      </div>

      {/* Frequency model */}
      <div style={{border:'1px solid rgba(34,211,238,.25)',borderRadius:10,background:'rgba(8,16,40,.35)',overflow:'hidden'}}>
        <div style={{padding:'10px 14px',background:'linear-gradient(to right, rgba(34,211,238,.14), transparent)',borderBottom:'1px solid rgba(34,211,238,.25)'}}>
          <div style={{fontSize:11,fontWeight:700,letterSpacing:'.08em',textTransform:'uppercase',color:'#22d3ee'}}>Frequency Model · Poisson</div>
          <div style={{fontSize:11,color:'rgba(226,232,240,.65)',marginTop:2}}>How often per year does a loss exceed the threshold? Independent-arrivals (Poisson) assumption.</div>
        </div>
        <table style={{width:'100%',borderCollapse:'collapse'}}>
          <tbody>
            <tr>
              <td style={{...cell,...symStyle}}>λ</td>
              <td style={{...cell,...valStyle}}>{fDec(freq,3)} / yr</td>
              <td style={{...cell,...descStyle}}>Annual frequency of losses ≥ threshold. Equals tail count ÷ observation years.<div style={noteStyle}>= {tailN} losses ÷ {fDec(uwYrs,1)} yrs</div></td>
            </tr>
            <tr>
              <td style={{...cell,...symStyle}}>E[N]</td>
              <td style={{...cell,...valStyle}}>{fDec(freq,3)}</td>
              <td style={{...cell,...descStyle}}>Expected number of threshold-breaching losses next year. For Poisson, mean = variance = λ.</td>
            </tr>
            <tr>
              <td style={{...cell,...symStyle}}>P(N≥1)</td>
              <td style={{...cell,...valStyle}}>{fPct(1-Math.exp(-freq))}</td>
              <td style={{...cell,...descStyle}}>Probability of at least one threshold-breaching loss in a year. = 1 − e^(−λ).</td>
            </tr>
            <tr>
              <td style={{...cell,...symStyle}}>P(N≥3)</td>
              <td style={{...cell,...valStyle}}>{fPct(Math.max(0,1-poissonPMF(0,freq)-poissonPMF(1,freq)-poissonPMF(2,freq)))}</td>
              <td style={{...cell,...descStyle}}>Probability of three or more threshold-breaching losses in a year — useful sanity check on aggregation risk.</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
}
