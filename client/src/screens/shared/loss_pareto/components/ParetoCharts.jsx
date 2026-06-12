// loss_pareto/components/ParetoCharts.jsx — the three SVG charts of the
// frequency–severity modal, moved verbatim from LossParetoScreen.jsx
// (Phase 4.2). Geometry and every rendered attribute are pinned by the
// golden master — no visual or numeric changes.

import { useMemo } from 'react';
import { fmt, fDec } from '../format.js';
import {
  DISTS,
  expPDF,
  expQ,
  lognormalPDF,
  lognormalQ,
  paretoPDF,
  paretoQ,
  poissonPMF,
  weibullPDF,
  weibullQ,
} from '../math/distributions';

/* ══════════════════════════════════════════
   RETURN PERIOD CHART
   ══════════════════════════════════════════ */
const CW=740,CH=410,CP={l:70,r:20,t:28,b:48};

export function ReturnPeriodChart({losses,alpha,xm,limit,fits,activeDist}){
  const plotL=useMemo(()=>losses.filter(l=>l>=xm).sort((a,b)=>a-b),[losses,xm]);
  const n=plotL.length;
  if(n<2)return<div style={{padding:24,color:'rgba(255,255,255,.35)',textAlign:'center'}}>Need ≥ 2 losses above threshold.</div>;

  const empRP=plotL.map((_,i)=>(n+1)/(n-i)).reverse();
  const empLoss=[...plotL].reverse();
  const rpMax=Math.max(500,Math.max(...empRP)*1.5);
  const lMin=Math.min(...plotL)*.7,lMax=Math.max(limit||0,Math.max(...plotL)*1.3,xm*5);

  const lx=v=>Math.log10(Math.max(v,1)),ly=v=>Math.log10(Math.max(v,1));
  const mapX=v=>CP.l+((lx(v)-lx(1))/(lx(rpMax)-lx(1)))*(CW-CP.l-CP.r);
  const mapY=v=>CH-CP.b-((ly(v)-ly(lMin))/(ly(lMax)-ly(lMin)))*(CH-CP.t-CP.b);

  const qFn=p=>{
    const f=fits.find(f=>f.key===activeDist);
    if(activeDist==='lognormal'&&f)return lognormalQ(p,f.params.mu,f.params.sigma);
    if(activeDist==='exponential'&&f)return expQ(p,f.params.lambda,xm);
    if(activeDist==='weibull'&&f)return weibullQ(p,f.params.k,f.params.lam,xm);
    return alpha>0?paretoQ(p,alpha,xm):0;
  };

  const curvePts=[];
  for(let i=0;i<=120;i++){
    const rp=Math.pow(10,lx(1)+i*(lx(rpMax)-lx(1))/120),p=1-1/rp;
    if(p<=0||p>=1)continue;
    const loss=qFn(p);
    if(loss>0&&Number.isFinite(loss)&&loss<lMax*10)curvePts.push(`${mapX(rp)},${mapY(loss)}`);
  }

  const dc=DISTS.find(d=>d.key===activeDist)?.color||'#22c55e';
  const rpTicks=[1,2,5,10,25,50,100,250,500].filter(v=>v<=rpMax);
  const lossTicks=[];
  for(let e=Math.floor(ly(lMin));e<=Math.ceil(ly(lMax));e++)[1,2,5].forEach(m=>{const v=m*Math.pow(10,e);if(v>=lMin&&v<=lMax)lossTicks.push(v);});
  const limY=limit>0?mapY(limit):null;

  return(
    <svg width="100%" height="100%" viewBox={`0 0 ${CW} ${CH}`} preserveAspectRatio="xMidYMid meet" className="crisp-grid" style={{fontFamily:'inherit', fontVariantNumeric:'tabular-nums'}}>
      <defs>
        <linearGradient id="cg" x1="0" x2="1"><stop offset="0%" stopColor={dc} stopOpacity=".85"/><stop offset="100%" stopColor={dc} stopOpacity=".35"/></linearGradient>
        <filter id="gl"><feGaussianBlur stdDeviation="2" result="b"/><feMerge><feMergeNode in="b"/><feMergeNode in="SourceGraphic"/></feMerge></filter>
      </defs>
      {rpTicks.map(v=><line key={`gx${v}`} x1={mapX(v)} y1={CP.t} x2={mapX(v)} y2={CH-CP.b} stroke="rgba(255,255,255,.06)" shapeRendering="crispEdges" vectorEffect="non-scaling-stroke"/>)}
      {lossTicks.map(v=><line key={`gy${v}`} x1={CP.l} y1={mapY(v)} x2={CW-CP.r} y2={mapY(v)} stroke="rgba(255,255,255,.06)" shapeRendering="crispEdges" vectorEffect="non-scaling-stroke"/>)}
      <line x1={CP.l} y1={CH-CP.b} x2={CW-CP.r} y2={CH-CP.b} stroke="rgba(255,255,255,.30)" shapeRendering="crispEdges" vectorEffect="non-scaling-stroke"/>
      <line x1={CP.l} y1={CP.t} x2={CP.l} y2={CH-CP.b} stroke="rgba(255,255,255,.30)" shapeRendering="crispEdges" vectorEffect="non-scaling-stroke"/>
      {rpTicks.map(v=><text key={`lx${v}`} x={mapX(v)} y={CH-CP.b+16} textAnchor="middle" fill="rgba(255,255,255,.65)" fontSize="11" fontWeight="500">{v}</text>)}
      {lossTicks.filter((_,i)=>i%2===0).map(v=><text key={`ly${v}`} x={CP.l-8} y={mapY(v)+3} textAnchor="end" fill="rgba(255,255,255,.65)" fontSize="11" fontWeight="500">{v>=1e6?`${(v/1e6).toFixed(1)}M`:v>=1e3?`${(v/1e3).toFixed(0)}K`:v}</text>)}
      <text x={CW/2} y={CH-6} textAnchor="middle" fill="rgba(255,255,255,.55)" fontSize="11" fontWeight="600">Return Period (years)</text>
      <text x={12} y={CH/2} textAnchor="middle" fill="rgba(255,255,255,.55)" fontSize="11" fontWeight="600" transform={`rotate(-90,12,${CH/2})`}>Loss Amount</text>
      {limY!=null&&limY>CP.t&&<><line x1={CP.l} y1={limY} x2={CW-CP.r} y2={limY} stroke="rgba(239,68,68,.45)" strokeDasharray="6,4" vectorEffect="non-scaling-stroke"/><text x={CW-CP.r-4} y={limY-5} textAnchor="end" fill="rgba(239,68,68,.85)" fontSize="10" fontWeight="600">Limit</text></>}
      {curvePts.length>1&&<polyline points={curvePts.join(' ')} fill="none" stroke="url(#cg)" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" filter="url(#gl)" vectorEffect="non-scaling-stroke"/>}
      {empRP.map((rp,i)=><circle key={i} cx={mapX(rp)} cy={mapY(empLoss[i])} r="4" fill={dc} fillOpacity=".75" stroke={dc} strokeWidth="1.5" vectorEffect="non-scaling-stroke"><title>{`RP ${rp.toFixed(1)}yr — ${fmt(empLoss[i])}`}</title></circle>)}
      <rect x={CW-200} y={CP.t+4} width="185" height="44" rx="8" fill="rgba(0,0,0,.45)" stroke="rgba(255,255,255,.10)" shapeRendering="crispEdges" vectorEffect="non-scaling-stroke"/>
      <circle cx={CW-184} cy={CP.t+18} r="3.5" fill={dc}/><text x={CW-174} y={CP.t+22} fill="rgba(255,255,255,.85)" fontSize="11" fontWeight="500">Empirical</text>
      <line x1={CW-188} y1={CP.t+36} x2={CW-176} y2={CP.t+36} stroke={dc} strokeWidth="2" vectorEffect="non-scaling-stroke"/><text x={CW-174} y={CP.t+40} fill="rgba(255,255,255,.85)" fontSize="11" fontWeight="500">{DISTS.find(d=>d.key===activeDist)?.label||'Pareto'}</text>
    </svg>
  );
}

/* ══════════════════════════════════════════
   SEVERITY PDF CHART (single-loss size distribution)
   X = loss amount, Y = probability density.
   Drawn with empirical histogram bars + fitted PDF curve.
   ══════════════════════════════════════════ */
export function SeverityChart({losses,xm,limit,fits,activeDist}){
  const v=useMemo(()=>losses.filter(l=>l>=xm).sort((a,b)=>a-b),[losses,xm]);
  const n=v.length;
  if(n<2)return<div style={{padding:24,color:'rgba(255,255,255,.35)',textAlign:'center'}}>Need ≥ 2 losses above threshold.</div>;

  // X range: from xm to a generous upper bound that includes the limit and fitted 99.5th
  const f=fits.find(f=>f.key===activeDist);
  const q995=(()=>{
    if(activeDist==='lognormal'&&f)return lognormalQ(0.995,f.params.mu,f.params.sigma);
    if(activeDist==='exponential'&&f)return expQ(0.995,f.params.lambda,xm);
    if(activeDist==='weibull'&&f)return weibullQ(0.995,f.params.k,f.params.lam,xm);
    if(activeDist==='pareto'&&f&&f.params.alpha>0)return paretoQ(0.995,f.params.alpha,xm);
    return v[n-1]*1.5;
  })();
  const xMin=xm,xMax=Math.max(q995,limit||0,v[n-1])*1.05;

  const pdf=(x)=>{
    if(activeDist==='lognormal'&&f)return lognormalPDF(x,f.params.mu,f.params.sigma);
    if(activeDist==='exponential'&&f)return expPDF(x,f.params.lambda,xm);
    if(activeDist==='weibull'&&f)return weibullPDF(x,f.params.k,f.params.lam,xm);
    if(activeDist==='pareto'&&f&&f.params.alpha>0)return paretoPDF(x,f.params.alpha,xm);
    return 0;
  };

  // Histogram bins (10 bins on log-x scale to handle heavy tails)
  const NB=10;
  const lx=v=>Math.log10(Math.max(v,1));
  const lxMin=lx(xMin),lxMax=lx(xMax);
  const edges=Array.from({length:NB+1},(_,i)=>Math.pow(10,lxMin+i*(lxMax-lxMin)/NB));
  const bins=Array(NB).fill(0);
  for(const x of v){
    const i=Math.min(NB-1,Math.max(0,Math.floor((lx(x)-lxMin)/(lxMax-lxMin)*NB)));
    bins[i]++;
  }
  // Convert counts to density: height = count / (n * width)
  const binDens=bins.map((c,i)=>c/(n*(edges[i+1]-edges[i])));

  // Curve sample
  const curve=[];
  const NP=160;
  for(let i=0;i<=NP;i++){
    const x=Math.pow(10,lxMin+i*(lxMax-lxMin)/NP);
    const d=pdf(x);
    if(Number.isFinite(d)&&d>0)curve.push({x,d});
  }

  const yMax=Math.max(...curve.map(p=>p.d),...binDens,1e-12)*1.1;

  const mapX=x=>CP.l+((lx(x)-lxMin)/(lxMax-lxMin))*(CW-CP.l-CP.r);
  const mapY=d=>CH-CP.b-(d/yMax)*(CH-CP.t-CP.b);

  const dc=DISTS.find(d=>d.key===activeDist)?.color||'#22c55e';
  const xTicks=[];
  for(let e=Math.floor(lxMin);e<=Math.ceil(lxMax);e++)[1,2,5].forEach(m=>{const x=m*Math.pow(10,e);if(x>=xMin&&x<=xMax)xTicks.push(x);});
  const limX=limit>0&&limit>=xMin&&limit<=xMax?mapX(limit):null;

  return(
    <svg width="100%" height="100%" viewBox={`0 0 ${CW} ${CH}`} preserveAspectRatio="xMidYMid meet" style={{fontFamily:'inherit',fontVariantNumeric:'tabular-nums'}}>
      <defs>
        <linearGradient id="sevg" x1="0" x2="0" y1="0" y2="1">
          <stop offset="0%" stopColor={dc} stopOpacity=".55"/>
          <stop offset="100%" stopColor={dc} stopOpacity=".05"/>
        </linearGradient>
      </defs>
      {/* gridlines */}
      {xTicks.map(v=><line key={`gx${v}`} x1={mapX(v)} y1={CP.t} x2={mapX(v)} y2={CH-CP.b} stroke="rgba(255,255,255,.06)" shapeRendering="crispEdges" vectorEffect="non-scaling-stroke"/>)}
      {/* histogram bars */}
      {bins.map((c,i)=>{
        if(c===0)return null;
        const x0=mapX(edges[i]),x1=mapX(edges[i+1]);
        const y0=mapY(binDens[i]),y1=CH-CP.b;
        return <rect key={`b${i}`} x={x0+1} y={y0} width={Math.max(1,x1-x0-2)} height={y1-y0} fill="rgba(148,163,184,.22)" stroke="rgba(148,163,184,.40)" strokeWidth="1" vectorEffect="non-scaling-stroke"><title>{`${fmt(edges[i])} – ${fmt(edges[i+1])}: ${c} loss${c===1?'':'es'}`}</title></rect>;
      })}
      {/* axes */}
      <line x1={CP.l} y1={CH-CP.b} x2={CW-CP.r} y2={CH-CP.b} stroke="rgba(255,255,255,.30)" shapeRendering="crispEdges" vectorEffect="non-scaling-stroke"/>
      <line x1={CP.l} y1={CP.t} x2={CP.l} y2={CH-CP.b} stroke="rgba(255,255,255,.30)" shapeRendering="crispEdges" vectorEffect="non-scaling-stroke"/>
      {/* x ticks */}
      {xTicks.map(v=><text key={`lx${v}`} x={mapX(v)} y={CH-CP.b+16} textAnchor="middle" fill="rgba(255,255,255,.65)" fontSize="11" fontWeight="500">{v>=1e6?`${(v/1e6).toFixed(1)}M`:v>=1e3?`${(v/1e3).toFixed(0)}K`:v}</text>)}
      {/* labels */}
      <text x={CW/2} y={CH-6} textAnchor="middle" fill="rgba(255,255,255,.55)" fontSize="11" fontWeight="600">Loss Size (log scale)</text>
      <text x={12} y={CH/2} textAnchor="middle" fill="rgba(255,255,255,.55)" fontSize="11" fontWeight="600" transform={`rotate(-90,12,${CH/2})`}>Probability Density</text>
      {/* limit line */}
      {limX!=null&&<><line x1={limX} y1={CP.t} x2={limX} y2={CH-CP.b} stroke="rgba(239,68,68,.45)" strokeDasharray="6,4" vectorEffect="non-scaling-stroke"/><text x={limX+4} y={CP.t+12} fill="rgba(239,68,68,.85)" fontSize="10" fontWeight="600">Limit</text></>}
      {/* threshold line */}
      <line x1={mapX(xm)} y1={CP.t} x2={mapX(xm)} y2={CH-CP.b} stroke="rgba(56,189,248,.45)" strokeDasharray="4,3" vectorEffect="non-scaling-stroke"/>
      <text x={mapX(xm)+4} y={CH-CP.b-6} fill="rgba(56,189,248,.85)" fontSize="10" fontWeight="600">xm</text>
      {/* fitted curve area + line */}
      {curve.length>1&&<>
        <path d={`M ${mapX(curve[0].x)} ${CH-CP.b} ${curve.map(p=>`L ${mapX(p.x)} ${mapY(p.d)}`).join(' ')} L ${mapX(curve[curve.length-1].x)} ${CH-CP.b} Z`} fill="url(#sevg)"/>
        <polyline points={curve.map(p=>`${mapX(p.x)},${mapY(p.d)}`).join(' ')} fill="none" stroke={dc} strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke"/>
      </>}
      {/* legend */}
      <rect x={CW-210} y={CP.t+4} width="195" height="44" rx="8" fill="rgba(0,0,0,.45)" stroke="rgba(255,255,255,.10)" shapeRendering="crispEdges" vectorEffect="non-scaling-stroke"/>
      <rect x={CW-200} y={CP.t+13} width="10" height="10" fill="rgba(148,163,184,.40)" stroke="rgba(148,163,184,.60)" strokeWidth="1"/><text x={CW-186} y={CP.t+22} fill="rgba(255,255,255,.85)" fontSize="11" fontWeight="500">Empirical histogram</text>
      <line x1={CW-200} y1={CP.t+36} x2={CW-188} y2={CP.t+36} stroke={dc} strokeWidth="2.5" vectorEffect="non-scaling-stroke"/><text x={CW-186} y={CP.t+40} fill="rgba(255,255,255,.85)" fontSize="11" fontWeight="500">{DISTS.find(d=>d.key===activeDist)?.label} PDF</text>
    </svg>
  );
}

/* ══════════════════════════════════════════
   FREQUENCY PMF CHART (annual count of events ≥ xm, Poisson)
   X = number of events in a year, Y = probability.
   ══════════════════════════════════════════ */
export function FrequencyChart({lambda}){
  if(!Number.isFinite(lambda)||lambda<=0)return<div style={{padding:24,color:'rgba(255,255,255,.35)',textAlign:'center'}}>Frequency unavailable (λ ≤ 0).</div>;

  // Show n = 0 .. ceil(λ + 4√λ + 2), capped
  const nMax=Math.min(30,Math.max(8,Math.ceil(lambda+4*Math.sqrt(lambda)+2)));
  const bars=Array.from({length:nMax+1},(_,n)=>({n,p:poissonPMF(n,lambda)}));
  const yMax=Math.max(...bars.map(b=>b.p),1e-9)*1.1;

  const padL=70,padR=20,padT=28,padB=48;
  const w=CW,h=CH;
  const innerW=w-padL-padR,innerH=h-padT-padB;
  const barW=innerW/(nMax+1);

  const mapX=n=>padL+(n+0.5)*barW;
  const mapY=p=>h-padB-(p/yMax)*innerH;

  const cumP=bars.reduce((a,b)=>a+(b.n>=1?b.p:0),0); // P(N ≥ 1)
  const exp=lambda;

  return(
    <svg width="100%" height="100%" viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="xMidYMid meet" style={{fontFamily:'inherit',fontVariantNumeric:'tabular-nums'}}>
      {/* gridlines */}
      {[0.25,0.5,0.75,1].map(g=>{const yt=h-padB-g*innerH;return <line key={`gy${g}`} x1={padL} y1={yt} x2={w-padR} y2={yt} stroke="rgba(255,255,255,.06)" shapeRendering="crispEdges" vectorEffect="non-scaling-stroke"/>;})}
      {/* axes */}
      <line x1={padL} y1={h-padB} x2={w-padR} y2={h-padB} stroke="rgba(255,255,255,.30)" shapeRendering="crispEdges" vectorEffect="non-scaling-stroke"/>
      <line x1={padL} y1={padT} x2={padL} y2={h-padB} stroke="rgba(255,255,255,.30)" shapeRendering="crispEdges" vectorEffect="non-scaling-stroke"/>
      {/* bars */}
      {bars.map(b=>{
        const x0=padL+b.n*barW+barW*0.15;
        const bw=barW*0.70;
        const y0=mapY(b.p),y1=h-padB;
        if(y1-y0<=0)return null;
        return <rect key={b.n} x={x0} y={y0} width={bw} height={y1-y0} rx="2" fill="#22d3ee" fillOpacity=".55" stroke="#22d3ee" strokeWidth="1" vectorEffect="non-scaling-stroke"><title>{`P(N = ${b.n}) = ${(b.p*100).toFixed(2)}%`}</title></rect>;
      })}
      {/* x ticks */}
      {bars.filter((_,i)=>i%Math.max(1,Math.ceil(nMax/12))===0).map(b=><text key={`tx${b.n}`} x={mapX(b.n)} y={h-padB+16} textAnchor="middle" fill="rgba(255,255,255,.65)" fontSize="11" fontWeight="500">{b.n}</text>)}
      {/* y ticks */}
      {[0,0.25,0.5,0.75,1].map(g=>{const yt=h-padB-g*innerH;const v=g*yMax;return <text key={`ty${g}`} x={padL-8} y={yt+3} textAnchor="end" fill="rgba(255,255,255,.65)" fontSize="11" fontWeight="500">{(v*100).toFixed(0)}%</text>;})}
      {/* labels */}
      <text x={w/2} y={h-6} textAnchor="middle" fill="rgba(255,255,255,.55)" fontSize="11" fontWeight="600">Number of Losses ≥ Threshold per Year</text>
      <text x={12} y={h/2} textAnchor="middle" fill="rgba(255,255,255,.55)" fontSize="11" fontWeight="600" transform={`rotate(-90,12,${h/2})`}>Probability</text>
      {/* expected line */}
      <line x1={mapX(exp)} y1={padT} x2={mapX(exp)} y2={h-padB} stroke="#f59e0b" strokeDasharray="4,3" vectorEffect="non-scaling-stroke"/>
      <text x={mapX(exp)+4} y={padT+12} fill="rgba(245,158,11,.95)" fontSize="10" fontWeight="600">E[N] = {fDec(exp,2)}</text>
      {/* legend */}
      <rect x={w-220} y={padT+4} width="205" height="44" rx="8" fill="rgba(0,0,0,.45)" stroke="rgba(255,255,255,.10)" shapeRendering="crispEdges" vectorEffect="non-scaling-stroke"/>
      <text x={w-210} y={padT+22} fill="rgba(255,255,255,.85)" fontSize="11" fontWeight="500">Poisson(λ = {fDec(lambda,2)})</text>
      <text x={w-210} y={padT+40} fill="rgba(255,255,255,.70)" fontSize="11" fontWeight="500">P(at least 1) = {(cumP*100).toFixed(1)}%</text>
    </svg>
  );
}
