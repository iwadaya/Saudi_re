import { fmt, fmtPct } from './propPricingConstants.js';

/*
  PropBloombergHero — the top-of-screen Bloomberg-style info panel.

  Props:
    drivers          – [{k, v, threshold}]
    balance          – number (balance %)
    safeCcy          – validated currency code string
    displayCcy       – currently shown currency (may differ if showUSD=true)
    showUSD          – bool
    fxLabel          – string | null
    fxRate           – number
    setShowUSD       – fn
    uwYear           – string
    offerStatus      – string
    tMode            – 'quota'|'surplus'|'both'
    isQS, isSurplus  – booleans
    qsLimit, retentionPct, retentionAmt, surplusRetention, numLines, totalCapacity,
    combinedTotalLimit, epi, eventLimit, commissionPctVal, profitCommPct, mgmtExpPct,
    taxesPctVal, brokeragePctVal  – numbers
    treatyType       – string
    crAct, crUw, marginAct, marginUw – numbers
    worstLR          – {lr: number|null, year: string}
    toDisplay        – fn(n) => n  (FX conversion)
    money            – fn(n) => string
    onInsight        – fn(key)  (opens insight modal)
    INSIGHT_BUTTONS  – array
*/
export default function PropBloombergHero({
  drivers, balance, safeCcy, displayCcy, showUSD, fxLabel, setShowUSD,
  uwYear, offerStatus, tMode, isQS, isSurplus,
  qsLimit, retentionPct, retentionAmt, surplusRetention, numLines, totalCapacity,
  combinedTotalLimit, epi, eventLimit, commissionPctVal, profitCommPct, mgmtExpPct,
  taxesPctVal, brokeragePctVal, treatyType, cobLabel,
  cedant, country, broker,
  crAct, crUw, marginAct, marginUw, worstLR,
  epiSplit, cobNames,
  toDisplay, money,
}) {
  const cls  = (v,lo,hi) => v<=lo?'pos':v<=hi?'warn':'neg';
  const clsInv = (v,lo,hi) => v>=hi?'pos':v>=lo?'warn':'neg';
  const statusKey = (offerStatus || 'DRAFT').toLowerCase().replace(/\s+/g, '_');

  return (
    <div className="bbg-hero">
      <div className="bbg-topbar">
        <div className="bbg-topbar-id">{treatyType.toUpperCase()}</div>
        <div className="bbg-topbar-meta">
          {cedant  && <span>CEDANT <b>{cedant}</b></span>}
          {country && <span>COUNTRY <b>{country}</b></span>}
          {cobLabel && <span>COB <b>{cobLabel}</b></span>}
          {broker  && <span>BROKER <b>{broker}</b></span>}
          <span>CCY <b>{safeCcy}</b></span>
          {safeCcy !== 'USD' && (
            <button className={`bbg-fx-toggle ${showUSD?'bbg-fx-toggle--active':''}`}
              onClick={()=>setShowUSD(p=>!p)} title={fxLabel||'Show in USD'}>
              {showUSD?`Showing USD · click for ${safeCcy}`:`Show in USD`}
            </button>
          )}
          {showUSD && fxLabel && <span className="bbg-fx-rate">{fxLabel}</span>}
          <span>UW YEAR <b>{uwYear}</b></span>
          <span className={`bbg-status bbg-status--${statusKey}`}>{(offerStatus || 'DRAFT').replace(/_/g,' ')}</span>
        </div>
      </div>

      {/* Left: Loss & Cost Drivers */}
      <div className="bbg-col">
        <div className="bbg-sec">▸ Loss & Cost Drivers</div>
        {drivers.map(d=>(<div key={d.k} className="bbg-row"><span className="bbg-k">{d.k}</span><span className={`bbg-v ${cls(d.v,d.threshold[0],d.threshold[1])}`}><span className="bbg-dot"/>{fmtPct(d.v)}</span></div>))}
        <div className="bbg-row"><span className="bbg-k">Balance</span><span className={`bbg-v ${balance>=0.05?'pos':balance>=0?'warn':'neg'}`}><span className="bbg-dot"/>{fmtPct(balance)}</span></div>
      </div>
      <div className="bbg-divider"/>

      {/* Centre: Premium + structure */}
      <div className="bbg-center">
        <div className="bbg-prem-label">Total Premium · 100% Share</div>
        <div className="bbg-prem-ccy">{displayCcy}</div>
        <div className="bbg-prem-val">{epi ? fmt(Math.round(toDisplay(epi))) : '—'}</div>
        <div className="bbg-ctr-rows">
          {isQS && <div className="bbg-ctr-row"><span className="bbg-ctr-k">100% Limit</span><span className="bbg-ctr-v">{qsLimit?money(qsLimit):'—'}</span></div>}
          {isQS && <div className="bbg-ctr-row"><span className="bbg-ctr-k">Retention %</span><span className="bbg-ctr-v">{retentionPct?`${retentionPct}%`:'—'}</span></div>}
          <div className="bbg-ctr-row"><span className="bbg-ctr-k">Retention Amt</span><span className="bbg-ctr-v">{(isQS?retentionAmt:surplusRetention)?money(isQS?retentionAmt:surplusRetention):'—'}</span></div>
          {isSurplus && <div className="bbg-ctr-row"><span className="bbg-ctr-k">No. of Lines</span><span className="bbg-ctr-v">{numLines||'—'}</span></div>}
          {isSurplus && <div className="bbg-ctr-row"><span className="bbg-ctr-k">Total Limit</span><span className="bbg-ctr-v">{(tMode==='both'?combinedTotalLimit:totalCapacity)?money(tMode==='both'?combinedTotalLimit:totalCapacity):'—'}</span></div>}
          <div className="bbg-ctr-row"><span className="bbg-ctr-k">Event Limit</span><span className="bbg-ctr-v">{eventLimit?money(eventLimit):'—'}</span></div>
          <div className="bbg-ctr-row"><span className="bbg-ctr-k">Commission</span><span className="bbg-ctr-v">{commissionPctVal?`${commissionPctVal}%`:'—'}</span></div>
          <div className="bbg-ctr-row"><span className="bbg-ctr-k">Profit Comm.</span><span className="bbg-ctr-v">{profitCommPct?`${profitCommPct}%`:'—'}</span></div>
          <div className="bbg-ctr-row"><span className="bbg-ctr-k">Mgmt Expenses</span><span className="bbg-ctr-v">{mgmtExpPct?`${mgmtExpPct}%`:'—'}</span></div>
          <div className="bbg-ctr-row"><span className="bbg-ctr-k">Taxes</span><span className="bbg-ctr-v">{taxesPctVal?`${taxesPctVal}%`:'—'}</span></div>
          <div className="bbg-ctr-row"><span className="bbg-ctr-k">Brokerage</span><span className="bbg-ctr-v">{brokeragePctVal?`${brokeragePctVal}%`:'—'}</span></div>
        </div>
        <div className={`bbg-act-margin ${marginAct<0?'bbg-act-margin--neg':''}`}><span className="lbl">ACT. MARGIN</span>{fmtPct(marginAct)}</div>
      </div>
      <div className="bbg-divider"/>

      {/* Right: Profitability */}
      <div className="bbg-col">
        <div className="bbg-sec">▸ Profitability & Ratios</div>
        <div className="bbg-row"><span className="bbg-k">Actuarial CR</span><span className={`bbg-v ${cls(crAct,0.95,1)}`}><span className="bbg-dot"/>{fmtPct(crAct)}</span></div>
        <div className="bbg-row"><span className="bbg-k">Actuarial Margin</span><span className={`bbg-v ${clsInv(marginAct,0,0.05)}`}><span className="bbg-dot"/>{fmtPct(marginAct)}</span></div>
        <div className="bbg-row-divider"/>
        <div className="bbg-row"><span className="bbg-k">UW CR</span><span className={`bbg-v ${cls(crUw,0.95,1)}`}><span className="bbg-dot"/>{fmtPct(crUw)}</span></div>
        <div className="bbg-row"><span className="bbg-k">UW Margin</span><span className={`bbg-v ${clsInv(marginUw,0,0.05)}`}><span className="bbg-dot"/>{fmtPct(marginUw)}</span></div>
        <div className="bbg-row-divider"/>
        <div className="bbg-row bbg-row--worst">
          <span className="bbg-k">Worst LR</span>
          <span className={`bbg-v ${worstLR.lr!=null?cls(worstLR.lr,0.55,0.70):'muted'}`}>
            <span className="bbg-dot"/>
            {worstLR.lr!=null?fmtPct(worstLR.lr):'—'}
            {worstLR.year&&<span className="bbg-worst-year">{worstLR.year}</span>}
          </span>
        </div>

        {/* EPI Split Mini Pie */}
        {epiSplit&&epiSplit.length>0&&(()=>{
          const COLORS=['#00e8b8','#60a5fa','#a78bfa','#fbbf24','#f87171','#4ade80','#fb923c','#e879f9'];
          const total=epiSplit.reduce((s,r)=>s+Number(r.premium||0),0);
          if(!total) return null;
          const R=28,cx=34,cy=34,tau=2*Math.PI;
          let angle=-Math.PI/2;
          const slices=epiSplit.map((r,i)=>{
            const prem=Number(r.premium||0),frac=prem/total;
            const s=angle; angle+=frac*tau; const e=angle;
            const x1=cx+R*Math.cos(s),y1=cy+R*Math.sin(s);
            const x2=cx+R*Math.cos(e),y2=cy+R*Math.sin(e);
            return {d:`M${cx},${cy} L${x1.toFixed(2)},${y1.toFixed(2)} A${R},${R},0,${frac>0.5?1:0},1,${x2.toFixed(2)},${y2.toFixed(2)} Z`,
              color:COLORS[i%COLORS.length],pct:Math.round(frac*100),
              name:(cobNames&&cobNames[i])||`Class ${i+1}`};
          });
          return (
            <div style={{marginTop:8,paddingTop:8,borderTop:'1px solid rgba(255,255,255,0.07)'}}>
              <div style={{fontSize:10,fontWeight:700,letterSpacing:'.07em',textTransform:'uppercase',color:'rgba(255,255,255,0.35)',marginBottom:6}}>EPI Split</div>
              <div style={{display:'flex',alignItems:'center',gap:10}}>
                <svg width="68" height="68" viewBox="0 0 68 68" style={{flexShrink:0}}>
                  {slices.map((s,i)=><path key={i} d={s.d} fill={s.color} opacity={0.9}><title>{s.name}: {s.pct}%</title></path>)}
                </svg>
                <div style={{display:'flex',flexDirection:'column',gap:3,minWidth:0}}>
                  {slices.map((s,i)=>(
                    <div key={i} style={{display:'flex',alignItems:'center',gap:5,fontSize:10}}>
                      <div style={{width:7,height:7,borderRadius:2,background:s.color,flexShrink:0}}/>
                      <span style={{color:'rgba(255,255,255,0.55)',flex:1,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}}>{s.name}</span>
                      <span style={{color:s.color,fontWeight:700,flexShrink:0}}>{s.pct}%</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          );
        })()}
      </div>
    </div>
  );
}
