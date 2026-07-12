import { useState, useMemo } from 'react';
import { applyLossCap, calcComm, makePCCalc, calcLPC } from '../../../../logic/propTreatyEngine';
import { toN as cn } from '../../../../utils/format.js';

const MA_PERIODS = [
  { key:'10', label:'10 Year' },
  { key:'5',  label:'5 Year'  },
  { key:'3',  label:'3 Year'  },
  { key:'2',  label:'2 Year'  },
];

function movingAvg(data, window) {
  if(!data.length) return [];
  return data.map((_,i) => {
    const start=Math.max(0,i-window+1);
    const slice=data.slice(start,i+1);
    return slice.reduce((a,v)=>a+v,0)/slice.length;
  });
}

function MiniLineChart({ title, years, treaty, raw, portfolioAvg, color, portfolioColor, yFmt }) {
  const W=420,H=200,PL=55,PR=16,PT=12,PB=28;
  const cw=W-PL-PR,ch=H-PT-PB;
  const allVals=[...treaty,...raw,portfolioAvg].filter(Number.isFinite);
  if(!allVals.length) return null;
  let yMin=Math.min(...allVals),yMax=Math.max(...allVals);
  const pad=(yMax-yMin)*0.15||0.05; yMin-=pad; yMax+=pad;
  const xOf=i=>PL+(years.length>1?(i/(years.length-1))*cw:cw/2);
  const yOf=v=>PT+ch-((v-yMin)/(yMax-yMin))*ch;
  const polyline=(data,clr,dash=false,sw=2,cls)=>{
    if(!data.length) return null;
    const pts=data.map((v,i)=>`${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`).join(' ');
    return <polyline points={pts} fill="none" className={cls} stroke={cls ? undefined : clr} strokeWidth={sw} strokeDasharray={dash?'4,3':'none'} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke"/>;
  };
  const yTicks=Array.from({length:5},(_,i)=>yMin+(yMax-yMin)*(i/4));
  const step=years.length>12?3:years.length>6?2:1;
  return (
    <div className="ma-chart-card">
      <div className="ma-chart-card-title">{title}</div>
      <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="xMidYMid meet" className="crisp-grid" style={{display:'block', fontFamily:'inherit', fontVariantNumeric:'tabular-nums'}}>
        {yTicks.map((v,i)=>(<g key={i}><line x1={PL} y1={yOf(v)} x2={W-PR} y2={yOf(v)} className="ma-grid-y" strokeWidth={1} shapeRendering="crispEdges" vectorEffect="non-scaling-stroke"/><text x={PL-6} y={yOf(v)+4} textAnchor="end" className="ma-tick" fontSize={10} fontWeight="500">{yFmt(v)}</text></g>))}
        {years.map((yr,i)=>i%step===0||i===years.length-1?(<text key={yr} x={xOf(i)} y={H-4} textAnchor="middle" className="ma-tick ma-tick--x" fontSize={10} fontWeight="500">{yr}</text>):null)}
        <line x1={PL} y1={yOf(portfolioAvg)} x2={W-PR} y2={yOf(portfolioAvg)} stroke={portfolioColor} strokeWidth={1.5} strokeDasharray="6,4" opacity={0.7} vectorEffect="non-scaling-stroke"/>
        {polyline(raw,null,false,1,'ma-raw-line')}
        {raw.map((v,i)=><circle key={i} cx={xOf(i)} cy={yOf(v)} r={2} className="ma-raw-dot"/>)}
        {polyline(treaty,color,false,2.5)}
        {treaty.map((v,i)=><circle key={i} cx={xOf(i)} cy={yOf(v)} r={3} fill={color}/>)}
      </svg>
    </div>
  );
}

export default function PropMovingAverageCharts({ yearly, terms }) {
  const [period, setPeriod] = useState('5');
  const win = parseInt(period);
  const t = useMemo(() => terms || {}, [terms]);

  // Moving averages need historical actuals — projected rows would skew
  // the trend. Anything saved without an explicit record_type=ACTUAL is
  // treated as PROJECTED (the DB column defaults that way), so the
  // filter is the single source of truth for "is this row an actual?".
  const actuals = useMemo(() => {
    return (yearly||[])
      .filter(r=>r.uw_year&&(String(r.record_type||'').toUpperCase()==='ACTUAL'||!r.record_type))
      .sort((a,b)=>Number(a.uw_year)-Number(b.uw_year));
  }, [yearly]);

  const hasRowsButNoActuals = (yearly||[]).length > 0 && actuals.length === 0;

  // Run the same financial engine Quick Summary uses on the historical
  // actuals so the chart ties out to QS's result column exactly:
  //   result = prem − cappedLoss − comm − brokerage − taxes − PC + LPC
  //   margin = result / prem
  //   commission line = (comm + PC − LPC) / prem   (LPC contributes only
  //   when loss participation is enabled — calcLPC returns 0 otherwise).
  // Commission, brokerage and taxes are derived from treaty terms (not the
  // stored *_amt columns), and PC is stateful (LCF carries deficits FIFO
  // across years), so we walk the years in chronological order.
  const { lrRaw, commRaw, marginRaw, years } = useMemo(() => {
    const yrs = actuals.map(r => Number(r.uw_year));
    const pcCalc = makePCCalc(t);
    const brokeragePct = cn(t.brokerage_pct) / 100;
    const taxesPct = cn(t.taxes_pct) / 100;
    const lr = [], comm = [], margin = [];
    for (const r of actuals) {
      const prem = cn(r.ultimate_premium);
      const loss = cn(r.ultimate_loss);
      const cappedLoss = applyLossCap(loss, prem, t);
      const c = calcComm(prem, loss, t);
      const brok = prem * brokeragePct;
      const taxes = prem * taxesPct;
      const pc = pcCalc(Number(r.uw_year), prem, loss, c);
      const lpc = calcLPC(prem, loss, t);

      if (prem > 0) {
        lr.push(cn(r.loss_ratio) ? (cn(r.loss_ratio) > 2 ? cn(r.loss_ratio) / 100 : cn(r.loss_ratio)) : loss / prem);
        comm.push((c + pc - lpc) / prem);
        margin.push((prem - cappedLoss - c - brok - taxes - pc + lpc) / prem);
      } else {
        lr.push(0); comm.push(0); margin.push(0);
      }
    }
    return { lrRaw: lr, commRaw: comm, marginRaw: margin, years: yrs };
  }, [actuals, t]);

  const lrMA=movingAvg(lrRaw,win), commMA=movingAvg(commRaw,win), marginMA=movingAvg(marginRaw,win);
  const avgLR=lrRaw.length?lrRaw.reduce((a,v)=>a+v,0)/lrRaw.length:0;
  const avgComm=commRaw.length?commRaw.reduce((a,v)=>a+v,0)/commRaw.length:0;
  const avgMargin=marginRaw.length?marginRaw.reduce((a,v)=>a+v,0)/marginRaw.length:0;

  const charts=[
    {title:'Loss Ratio',treaty:lrMA,raw:lrRaw,portfolioAvg:avgLR,color:'#f87171',portfolioColor:'#60a5fa',yFmt:v=>(v*100).toFixed(1)+'%'},
    {title:'Margin',treaty:marginMA,raw:marginRaw,portfolioAvg:avgMargin,color:'#4ade80',portfolioColor:'#60a5fa',yFmt:v=>(v*100).toFixed(1)+'%'},
    {title:'Commission Ratio',treaty:commMA,raw:commRaw,portfolioAvg:avgComm,color:'#facc15',portfolioColor:'#60a5fa',yFmt:v=>(v*100).toFixed(1)+'%'},
  ];

  if(!actuals.length) {
    const message = hasRowsButNoActuals
      ? `${(yearly||[]).length} yearly row${(yearly||[]).length===1?'':'s'} present but none are marked as ACTUAL. Moving averages chart only historical actuals — set record_type=ACTUAL on rows to include them.`
      : 'No yearly data available. Add historical year rows above to see moving average charts.';
    return (
      <div className="ma-charts-section">
        <div className="ma-charts-header"><div className="ma-charts-title">Moving Averages</div></div>
        <div style={{padding:20,color:'rgba(var(--text-rgb),.7)',fontSize:13}}>{message}</div>
      </div>
    );
  }

  return (
    <div className="ma-charts-section">
      <div className="ma-charts-header">
        <div className="ma-charts-title">Moving Averages</div>
        <div className="ma-period-selector">
          {MA_PERIODS.map(p=>(<button key={p.key} className={`ma-period-btn ${period===p.key?'active':''}`} onClick={()=>setPeriod(p.key)}>{p.label}</button>))}
        </div>
      </div>
      <div className="ma-legend">
        <span className="ma-legend-item"><span className="ma-legend-dot" style={{background:'currentColor'}}></span> Treaty ({win}yr MA)</span>
        <span className="ma-legend-item" style={{color:'#60a5fa'}}><span className="ma-legend-dot" style={{background:'#60a5fa'}}></span> Portfolio Avg</span>
        <span className="ma-legend-item" style={{color:'rgba(var(--text-rgb),.5)'}}><span className="ma-legend-dot" style={{background:'rgba(var(--text-rgb),.35)'}}></span> Treaty (raw)</span>
      </div>
      <div className="ma-charts-grid">
        {charts.map(ch=>(<MiniLineChart key={ch.title} title={ch.title} years={years} treaty={ch.treaty} raw={ch.raw} portfolioAvg={ch.portfolioAvg} color={ch.color} portfolioColor={ch.portfolioColor} yFmt={ch.yFmt}/>))}
      </div>
    </div>
  );
}
