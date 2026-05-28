import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import WizardLayout from '../../components/WizardLayout';
import { useContractId } from '../../hooks/useContractId';
import { useGlobalToast } from '../../hooks/useToast';
import { useAppState } from '../../context/AppContext';
import { api } from '../../api';
import { toN as cn } from '../../utils/format';
import { isNpStopLossTreaty } from '../../utils/npTreatyType';
import { layerHit } from '../../../../shared/pricingMath.js';
import RpComparisonModal, { interpolateTpAtRp } from './RpComparisonModal';

/* ── Helpers ── */
function stableStringify(obj){
  const seen=new WeakSet();
  const norm=(v)=>{
    if(v&&typeof v==='object'){
      if(seen.has(v)) return null;
      seen.add(v);
      if(Array.isArray(v)) return v.map(norm);
      const out={};
      for(const k of Object.keys(v).sort()) out[k]=norm(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(obj));
}
async function sha256Hex(str){
  // crypto.subtle is only defined in secure contexts (HTTPS, or
  // localhost / 127.0.0.1). Plain-HTTP origins — like a LAN IP
  // served on :3000/:4000 during internal testing — leave
  // crypto.subtle undefined and reading .digest throws the
  // "Cannot read properties of undefined" we saw in the field.
  // Fall back to a cheap non-cryptographic hash so the snapshot
  // still saves; the digest is only used for change detection,
  // not for security, so collision resistance is best-effort.
  const enc = new TextEncoder().encode(str);
  if (globalThis.crypto?.subtle?.digest) {
    const buf = await globalThis.crypto.subtle.digest('SHA-256', enc);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  // djb2 → 32-bit unsigned → hex. Good enough for "did this
  // snapshot change?" equality; NOT a cryptographic hash.
  let h = 5381;
  for (let i = 0; i < enc.length; i++) h = ((h * 33) ^ enc[i]) >>> 0;
  return h.toString(16).padStart(8, '0');
}
function fmt(n) { return n == null || !Number.isFinite(Number(n)) ? '—' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 0 }); }
function fPct(n) { return n == null || !Number.isFinite(n) ? '—' : `${(n * 100).toFixed(1)}%`; }
function fDec(n, d = 4) { return n == null || !Number.isFinite(n) ? '—' : Number(n).toFixed(d); }

/* ══════════════════════════════════════════
   DISTRIBUTIONS
   ══════════════════════════════════════════ */
export function fitPareto(losses, xm) {
  const v = losses.filter(l => l >= xm); const n = v.length;
  if (n === 0) return { alpha: 0, n: 0 };
  let s = 0; for (const x of v) s += Math.log(x / xm);
  return { alpha: s > 0 ? n / s : 0, n };
}
export function paretoCDF(x, a, xm) { return x < xm ? 0 : 1 - Math.pow(xm / x, a); }
export function paretoQ(p, a, xm) { return xm * Math.pow(1 - p, -1 / a); }

function erf(x) {
  const a1=.254829592,a2=-.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=.3275911;
  const sg=x<0?-1:1,t=1/(1+p*Math.abs(x));
  return sg*(1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x));
}
function normInv(p) {
  if(p<=0)return -Infinity;if(p>=1)return Infinity;
  const a=[-3.969683028665376e1,2.209460984245205e2,-2.759285104469687e2,1.383577518672690e2,-3.066479806614716e1,2.506628277459239e0];
  const b=[-5.447609879822406e1,1.615858368580409e2,-1.556989798598866e2,6.680131188771972e1,-1.328068155288572e1];
  const c=[-7.784894002430293e-3,-3.223964580411365e-1,-2.400758277161838e0,-2.549732539343734e0,4.374664141464968e0,2.938163982698783e0];
  const d=[7.784695709041462e-3,3.224671290700398e-1,2.445134137142996e0,3.754408661907416e0];
  const pL=.02425,pH=1-pL;let q,r;
  if(p<pL){q=Math.sqrt(-2*Math.log(p));return(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);}
  if(p<=pH){q=p-.5;r=q*q;return(((((a[0]*r+a[1])*r+a[2])*r+a[3])*r+a[4])*r+a[5])*q/(((((b[0]*r+b[1])*r+b[2])*r+b[3])*r+b[4])*r+1);}
  q=Math.sqrt(-2*Math.log(1-p));return -(((((c[0]*q+c[1])*q+c[2])*q+c[3])*q+c[4])*q+c[5])/((((d[0]*q+d[1])*q+d[2])*q+d[3])*q+1);
}
function fitLognormal(losses, xm) {
  const v=losses.filter(l=>l>=xm);const n=v.length;if(n===0)return{mu:0,sigma:1,n:0};
  const lg=v.map(l=>Math.log(l)),mu=lg.reduce((a,b)=>a+b,0)/n;
  const sigma=Math.sqrt(lg.reduce((a,b)=>a+Math.pow(b-mu,2),0)/n)||.01;
  return{mu,sigma,n};
}
function lognormalCDF(x,mu,sigma){return x<=0?0:.5*(1+erf((Math.log(x)-mu)/(sigma*Math.SQRT2)));}
function lognormalQ(p,mu,sigma){return Math.exp(mu+sigma*normInv(p));}

function fitExponential(losses,xm){
  const v=losses.filter(l=>l>=xm);const n=v.length;if(n===0)return{lambda:1,n:0};
  const mean=v.reduce((a,b)=>a+(b-xm),0)/n;return{lambda:mean>0?1/mean:1,n};
}
function expCDF(x,lam,xm){return x<xm?0:1-Math.exp(-lam*(x-xm));}
function expQ(p,lam,xm){return xm-Math.log(1-p)/lam;}

function fitWeibull(losses,xm){
  const v=losses.filter(l=>l>=xm).map(l=>l-xm).filter(l=>l>0);const n=v.length;
  if(n<3)return{k:1,lam:1,n:0};
  let k=1;
  for(let it=0;it<50;it++){
    const lg=v.map(x=>Math.log(x)),vk=v.map(x=>Math.pow(x,k)),vkL=v.map((x,i)=>Math.pow(x,k)*lg[i]);
    const sVk=vk.reduce((a,b)=>a+b,0),sVkL=vkL.reduce((a,b)=>a+b,0),sLog=lg.reduce((a,b)=>a+b,0);
    const f=n/k+sLog-n*sVkL/sVk;
    const fp=-n/(k*k)-n*(vkL.map((x,i)=>x*lg[i]).reduce((a,b)=>a+b,0)*sVk-sVkL*sVkL)/(sVk*sVk);
    if(Math.abs(fp)<1e-15)break;k-=f/fp;if(k<=.01)k=.01;if(Math.abs(f/fp)<1e-8)break;
  }
  const lam=Math.pow(v.map(x=>Math.pow(x,k)).reduce((a,b)=>a+b,0)/n,1/k);return{k,lam,n};
}
function weibullCDF(x,k,lam,xm){const z=x-xm;return z<=0?0:1-Math.exp(-Math.pow(z/lam,k));}
function weibullQ(p,k,lam,xm){return xm+lam*Math.pow(-Math.log(1-p),1/k);}

export function calcKS(losses,cdfFn,xm){
  const v=losses.filter(x=>x>=xm).sort((a,b)=>a-b);const n=v.length;
  if(n===0)return{ks:1,pValue:0};let mx=0;
  for(let i=0;i<n;i++){const c=cdfFn(v[i]);mx=Math.max(mx,Math.abs((i+1)/n-c),Math.abs(i/n-c));}
  const sq=Math.sqrt(n),z=(sq+.12+.11/sq)*mx;
  return{ks:mx,pValue:Math.max(0,Math.min(1,2*Math.exp(-2*z*z)))};
}

export function calcLayerPrice(alpha,xm,freq,ret,lim){
  if(alpha<=1)return{severity:0,rpp:0,error:'α ≤ 1'};
  // Full LEV: E[min(X, L)] = ∫_xm^L x f(x) dx + L · P(X > L).
  // The tail term L·(xm/L)^α captures losses that pierce the layer
  // ceiling — omitting it (the truncated form) overstates per-loss
  // severity by the value of the cap-survival contribution.
  const LEV=L=>{
    if(L<=xm)return L;
    const m=(alpha*xm)/(alpha-1);
    return m*(1-Math.pow(xm/L,alpha-1))+L*Math.pow(xm/L,alpha);
  };
  const att=Math.max(xm,ret),sev=LEV(att+lim)-LEV(att);return{severity:sev,rpp:freq*sev};
}

/**
 * Return period of a single loss of size x under the fitted distribution.
 *   RP(x) = 1 / (freq × P(X > x))
 * freq  = annual frequency of losses ≥ xm (already computed by the screen).
 * survivalFn = P(X > x) from the active fitted distribution.
 * Returns null when freq or survivalFn is missing / zero.
 */
export function lossReturnPeriod(x, freq, survivalFn) {
  if (!(freq > 0) || !survivalFn) return null;
  const s = survivalFn(x);
  if (!(s > 0)) return null;
  return 1 / (freq * s);
}

/**
 * Return period of the layer attachment point D.
 *   RP_attach = 1 / (freq × P(X > D))
 * Same formula as lossReturnPeriod; named separately for clarity at call sites.
 */
export function rpAtAttachment(freq, D, survivalFn) {
  return lossReturnPeriod(D, freq, survivalFn);
}

/**
 * Numerical integration of the survival function over [D, D+L].
 * E[loss in layer] = ∫[D to D+L] P(X > x) dx  (trapezoidal, 400 steps).
 * Used for non-Pareto distributions where calcLayerPrice (analytical) doesn't apply.
 * Returns { severity, rpp } matching calcLayerPrice's output shape.
 */
export function calcLayerPriceNumerical(freq, D, L, survivalFn, steps = 400) {
  if (!(L > 0) || !survivalFn) return { severity: 0, rpp: 0 };
  const h = L / steps;
  let sum = 0;
  for (let i = 0; i <= steps; i++) {
    const x = D + i * h;
    const w = (i === 0 || i === steps) ? 0.5 : 1;
    sum += w * Math.max(0, survivalFn(x));
  }
  const severity = sum * h;
  return { severity, rpp: freq * severity };
}

/* ── PDFs (conditional on x ≥ xm, normalised so ∫ f = 1 over [xm,∞)) ── */
function paretoPDF(x,a,xm){return x<xm?0:(a*Math.pow(xm,a))/Math.pow(x,a+1);}
function lognormalPDF(x,mu,sigma){
  if(x<=0)return 0;
  const z=(Math.log(x)-mu)/sigma;
  return Math.exp(-0.5*z*z)/(x*sigma*Math.sqrt(2*Math.PI));
}
function expPDF(x,lam,xm){return x<xm?0:lam*Math.exp(-lam*(x-xm));}
function weibullPDF(x,k,lam,xm){
  const z=x-xm; if(z<=0)return 0;
  return (k/lam)*Math.pow(z/lam,k-1)*Math.exp(-Math.pow(z/lam,k));
}

/* ── Poisson PMF for the frequency model N ~ Poisson(λ) ── */
function poissonPMF(n,lam){
  if(n<0||lam<=0)return n===0?1:0;
  // log-space to avoid overflow for large n
  let logFact=0; for(let i=2;i<=n;i++) logFact+=Math.log(i);
  return Math.exp(n*Math.log(lam)-lam-logFact);
}

const DISTS=[
  {key:'pareto',label:'Pareto',color:'#22c55e'},
  {key:'lognormal',label:'Lognormal',color:'#3b82f6'},
  {key:'exponential',label:'Exponential',color:'#f59e0b'},
  {key:'weibull',label:'Weibull',color:'#a855f7'},
];

function fitAll(losses,xm){
  const p=fitPareto(losses,xm),ln=fitLognormal(losses,xm),ex=fitExponential(losses,xm),wb=fitWeibull(losses,xm);
  return[
    {key:'pareto',params:p,ks:calcKS(losses,x=>paretoCDF(x,p.alpha,xm),xm),paramStr:`α=${fDec(p.alpha,3)}`,n:p.n},
    {key:'lognormal',params:ln,ks:calcKS(losses,x=>lognormalCDF(x,ln.mu,ln.sigma),xm),paramStr:`μ=${fDec(ln.mu,2)} σ=${fDec(ln.sigma,2)}`,n:ln.n},
    {key:'exponential',params:ex,ks:calcKS(losses,x=>expCDF(x,ex.lambda,xm),xm),paramStr:`λ=${fDec(ex.lambda,6)}`,n:ex.n},
    {key:'weibull',params:wb,ks:calcKS(losses,x=>weibullCDF(x,wb.k,wb.lam,xm),xm),paramStr:`k=${fDec(wb.k,3)} λ=${fDec(wb.lam,0)}`,n:wb.n},
  ];
}

/* ══════════════════════════════════════════
   RETURN PERIOD CHART
   ══════════════════════════════════════════ */
const CW=740,CH=410,CP={l:70,r:20,t:28,b:48};

function ReturnPeriodChart({losses,alpha,xm,limit,fits,activeDist}){
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
function SeverityChart({losses,xm,limit,fits,activeDist}){
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
function FrequencyChart({lambda}){
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

/* ══════════════════════════════════════════
   NP LAYER CAP HELPER
   sum limits for risk layers (large loss) or cat layers (cat loss)
   Works with both server rows (peril_scope) and appState rows (riskCover/catCover).
   ══════════════════════════════════════════ */
function sumLayerLimits(layers, isNpCat) {
  return layers
    .filter(l => {
      if (l.peril_scope !== undefined) {
        return isNpCat
          ? (l.peril_scope === 'CAT' || l.peril_scope === 'BOTH')
          : (l.peril_scope === 'RISK' || l.peril_scope === 'BOTH');
      }
      return isNpCat ? (l.catCover === true) : (l.riskCover === true);
    })
    .reduce((sum, l) => {
      const v = parseFloat(String(l.layer_limit ?? l.limit ?? '').replace(/,/g, ''));
      return sum + (Number.isFinite(v) ? v : 0);
    }, 0);
}

/* ══════════════════════════════════════════
   MAIN COMPONENT
   ══════════════════════════════════════════ */
export default function LossParetoScreen({routeKey,title,headerPill,lossType='large'}){
  const contractId=useContractId();
  const showToast=useGlobalToast();
  const {state:appState}=useAppState();
  const isNpMode = appState.wizardMode === 'NP' || appState.quoteMode;
  const td = isNpMode ? (appState.npTreatyDetail || {}) : (appState.propTreatyDetail || {});
  const [losses,setLosses]=useState([]);
  const [portfolioFallback,setPortfolioFallback]=useState(null); // {treatyCount} when the curve is fitted to cedant-portfolio losses
  const [loading,setLoading]=useState(true);
  const [xm,setXm]=useState(0);
  const [limit,setLimit]=useState(0);
  const [alpha,setAlpha]=useState(0);
  const [activeDist,setActiveDist]=useState('pareto');
  const [showChart,setShowChart]=useState(false);
  const [yearsOvr,setYearsOvr]=useState('');
  const [saving,setSaving]=useState(false);
  const [saveError,setSaveError]=useState(null);
  const [,setSavedSnapshotId]=useState(null);
  const [lastSaveTime,setLastSaveTime]=useState(null);

  const DEFAULT_OEP_ROWS = [2, 5, 10, 25, 50, 100, 200, 250, 500]
    .map(rp => ({ rp: String(rp), loss: '' }));

  // Third-party RP comparison (CAT only). The underwriter can enter a
  // vendor RP curve (Aon Catalyst, Karen Clark, Verisk, …) in a modal,
  // see it side-by-side with the fitted-distribution curve, and choose
  // FITTED / TP / BLEND with a weight. The selection swaps the
  // displayed "Estimated Loss" column on the Return Periods card; the
  // per-loss RP and layer-pricing math continue to use the fitted
  // distribution for now.
  const [tpRows, setTpRows] = useState([]);
  const [tpSource, setTpSource] = useState('');
  const [rpSource, setRpSource] = useState('FITTED'); // 'FITTED' | 'TP' | 'BLEND'
  const [rpBlend, setRpBlend]   = useState(50);       // % fitted in the blend
  const [rpCompareOpen, setRpCompareOpen] = useState(false);
  const [oepRows,  setOepRows]  = useState(DEFAULT_OEP_ROWS);
  const [showOep,  setShowOep]  = useState(false);

  useEffect(()=>{
    if(!contractId){setLoading(false);return;}
    (async()=>{
      try{
        const qm = appState.quoteMode ? { quote: true } : undefined;
        const isNpCat = lossType === 'cat';

        // Fetch structure layers: prefer appState (already loaded by NpStructure),
        // fall back to server fetch so the cap is correct even on direct navigation
        let npCap = 0;
        const stateLayers = appState.npStructureLayers || [];
        if (stateLayers.length > 0) {
          npCap = sumLayerLimits(stateLayers, isNpCat);
        } else {
          // Fetch from server — getNonPropTreaty returns { layers: [{layer_limit, peril_scope}] }
          const npData = await api.getNonPropTreaty(contractId, qm).catch(() => null);
          const serverLayers = npData?.layers || [];
          if (serverLayers.length > 0) {
            npCap = sumLayerLimits(serverLayers, isNpCat);
          }
        }

        const [treaty,lossData,snapshotData]=await Promise.all([
          api.getContract(contractId, qm).catch(()=>({})),
          (lossType==='cat'?api.getCatLosses:api.getLargeLosses)(contractId, qm),
          api.getLossSelectionLatest(contractId, lossType, qm).catch(()=>null),
        ]);
        const parseLossList = (raw) => (Array.isArray(raw)?raw:[])
          .filter(l=>l.is_selected!==false)
          .map(l=>{const inc=cn(l.incurred)||(cn(l.paid)+cn(l.os));return{...l,incurred:inc,inflated:inc*cn(l.inflation_factor||1)};})
          .filter(l=>l.inflated>0);
        // Portfolio fallback uses all inflated losses regardless of their
        // is_selected status on the source treaties, so skip that filter.
        const parsePortfolioLossList = (raw) => (Array.isArray(raw)?raw:[])
          .map(l=>{const inc=cn(l.incurred)||(cn(l.paid)+cn(l.os));return{...l,incurred:inc,inflated:inc*cn(l.inflation_factor||1)};})
          .filter(l=>l.inflated>0);
        const list=lossData?.losses||lossData?.rows||lossData||[];
        let parsed=parseLossList(list);
        // No losses saved for this treaty → fall back to the cedant's wider
        // portfolio (large/cat losses across its other treaties) so the curve
        // still renders. Contract mode only; quotes keep the empty state.
        let fallback=null;
        if(parsed.length===0 && !qm){
          const pf=await api.getPortfolioLosses(contractId, lossType).catch(()=>null);
          const pfParsed=parsePortfolioLossList(pf?.losses||[]);
          if(pfParsed.length>0){ parsed=pfParsed; fallback={treatyCount:pf?.treatyCount||0}; }
        }
        setLosses(parsed);
        setPortfolioFallback(fallback);
        const vals=parsed.map(l=>l.inflated).sort((a,b)=>a-b);
        const det=treaty?.detail||{};
        // NP: use risk or cat layer sum from structure. Prop: for cat use event_limit; for large loss use capacity/limit.
        const propCap = lossType === 'cat'
          ? (cn(det.event_limit) || cn(td.eventLimit) || cn(det.total_capacity) || cn(td.totalCapacity) || cn(det.qs_limit) || cn(td.qsLimit) || 0)
          : (cn(det.total_capacity) || cn(td.totalCapacity) || cn(det.qs_limit) || cn(td.qsLimit) || cn(det.event_limit) || cn(td.eventLimit) || 0);
        const cap = npCap > 0 ? npCap : propCap;

        // Restore from saved snapshot if available.
        // For NP: structure cap ALWAYS sets the limit (structure may have changed since snapshot).
        // Snapshot only restores the analytical parameters (xm, alpha, years, dist).
        const snap = snapshotData?.snapshot;
        if (snap) {
          if (snap.pareto_xm > 0) setXm(snap.pareto_xm);
          else if (vals.length) setXm(vals[0]);
          // limit: use live structure cap for NP; fall back to snapshot for prop
          if (cap > 0) setLimit(cap);
          else if (snap.pareto_limit > 0) setLimit(snap.pareto_limit);
          if (snap.observation_years) setYearsOvr(String(snap.observation_years));
          if (snap.active_distribution) setActiveDist(snap.active_distribution);
          if (snap.pareto_alpha > 0) setAlpha(snap.pareto_alpha);
          // layer_burning_cost and oep_input are nested inside return_period_curve
          // because the server only persists a whitelist of top-level keys.
          const rpc = snap.return_period_curve || {};
          if (rpc.layer_burning_cost) {
            if (typeof rpc.layer_burning_cost.wEmp   === 'number') setWEmp(rpc.layer_burning_cost.wEmp);
            if (typeof rpc.layer_burning_cost.wModel === 'number') setWModel(rpc.layer_burning_cost.wModel);
          }
          if (rpc.oep_input && lossType === 'cat' && Array.isArray(rpc.oep_input)) {
            setOepRows(rpc.oep_input);
          }
          // Third-party RP comparison state (CAT only).
          if (lossType === 'cat' && rpc.third_party_rp) {
            const tp = rpc.third_party_rp;
            if (Array.isArray(tp.rows)) setTpRows(tp.rows);
            if (typeof tp.source === 'string') setTpSource(tp.source);
            if (tp.selection === 'FITTED' || tp.selection === 'TP' || tp.selection === 'BLEND') {
              setRpSource(tp.selection);
            }
            if (typeof tp.blend === 'number') setRpBlend(tp.blend);
          }
          setSavedSnapshotId(snap.snapshot_id || null);
        } else {
          if (vals.length) setXm(prev => prev || vals[0]);
          if (cap > 0) setLimit(cap);
        }
      }catch(e){console.error('Pareto load',e);}
      setLoading(false);
    })();
  },[appState.npStructureLayers, appState.quoteMode, contractId, lossType, td.eventLimit, td.qsLimit, td.totalCapacity]);

  // Stop Loss treaties fit the curves to YEARLY AGGREGATES of the
  // selected losses rather than to per-claim severities. This matches
  // the way an aggregate-attaching cover is priced: we're modelling
  // the distribution of total annual loss, not the size of a single
  // claim. For Risk XL / Cat XL the fit stays on per-claim losses
  // (severity model, used for individual-layer pricing).
  const stopLossTreaty = isNpStopLossTreaty(appState);

  const yearlyAggregates = useMemo(() => {
    if (!stopLossTreaty) return [];
    const byYear = new Map();
    for (const l of losses) {
      const y = Number(l.uw_year);
      if (!Number.isFinite(y)) continue;
      const v = cn(l.inflated);
      if (!(v > 0)) continue;
      byYear.set(y, (byYear.get(y) || 0) + v);
    }
    // Sort by year so the table reads chronologically.
    return [...byYear.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([year, inflated]) => ({ uw_year: year, inflated }));
  }, [stopLossTreaty, losses]);

  // The array fed to fitPareto / fitAll. In stop-loss mode this is one
  // entry per UW year; otherwise one entry per loss.
  const fitInput = useMemo(
    () => (stopLossTreaty ? yearlyAggregates : losses),
    [stopLossTreaty, yearlyAggregates, losses],
  );

  useEffect(()=>{
    if(!fitInput.length||xm<=0)return;
    const fit=fitPareto(fitInput.map(l=>l.inflated),xm);
    if(fit.alpha>0)setAlpha(fit.alpha);
  },[fitInput,xm]);

  const inflated=useMemo(()=>fitInput.map(l=>l.inflated),[fitInput]);
  const fits=useMemo(()=>fitAll(inflated,xm),[inflated,xm]);
  const sorted=useMemo(()=>[...fitInput].sort((a,b)=>b.inflated-a.inflated),[fitInput]);
  const total=useMemo(()=>sorted.reduce((s,l)=>s+l.inflated,0),[sorted]);
  const pareto=useMemo(()=>{let c=0;return sorted.map((l,i)=>{c+=l.inflated;return{...l,rank:i+1,cum:c,cumPct:total>0?c/total:0};});},[sorted,total]);

  const returnPeriods=useMemo(()=>{
    if(xm<=0)return[];
    const f=fits.find(f=>f.key===activeDist);
    const qFn=(p)=>{
      if(activeDist==='lognormal'&&f)return lognormalQ(p,f.params.mu,f.params.sigma);
      if(activeDist==='exponential'&&f)return expQ(p,f.params.lambda,xm);
      if(activeDist==='weibull'&&f)return weibullQ(p,f.params.k,f.params.lam,xm);
      return alpha>0?paretoQ(p,alpha,xm):0;
    };
    return[500,250,100,50,25,20,10,5,2].map(rp=>{
      const loss=qFn(1-1/rp);
      return{rp,loss:Number.isFinite(loss)&&loss>0?loss:0};
    });
  },[alpha,xm,activeDist,fits]);

  // Third-party RP curve interpolated at every fitted RP. Empty array
  // when no valid TP points have been entered.
  const tpReturnPeriods = useMemo(() => {
    const valid = (tpRows || [])
      .map(r => ({ rp: parseFloat(r.rp), loss: parseFloat(String(r.loss).replace(/,/g, '')) }))
      .filter(r => r.rp > 0 && r.loss > 0)
      .sort((a, b) => a.rp - b.rp);
    if (valid.length < 2) return [];
    return returnPeriods.map(p => {
      const loss = interpolateTpAtRp(valid, p.rp);
      return { rp: p.rp, loss: loss == null ? 0 : loss };
    });
  }, [tpRows, returnPeriods]);

  // The curve actually displayed on the Return Periods card.
  // FITTED → fitted distribution. TP → third-party (interpolated).
  // BLEND → weighted average (rpBlend % from fitted).
  const effectiveReturnPeriods = useMemo(() => {
    if (rpSource === 'TP' && tpReturnPeriods.length) return tpReturnPeriods;
    if (rpSource === 'BLEND' && tpReturnPeriods.length) {
      const w = Math.max(0, Math.min(100, rpBlend)) / 100;
      return returnPeriods.map((p, i) => {
        const tp = tpReturnPeriods[i];
        return { rp: p.rp, loss: tp ? (w * p.loss + (1 - w) * tp.loss) : p.loss };
      });
    }
    return returnPeriods;
  }, [returnPeriods, tpReturnPeriods, rpSource, rpBlend]);

  const count=pareto.length;
  const avg=count>0?total/count:0;
  const mxL=count>0?pareto[0].inflated:0;
  const mnL=count>0?pareto[count-1].inflated:0;
  const sd=Math.sqrt(count>0?fitInput.reduce((a,l)=>a+Math.pow(l.inflated-avg,2),0)/count:0);
  const t5=count>=5?pareto[4].cumPct:count>0?pareto[count-1].cumPct:0;
  const uwYrs=Number(yearsOvr)||10;
  const freq=inflated.filter(l=>l>=xm).length/uwYrs;
  const avgYr=uwYrs>0?total/uwYrs:0;

  // Survival function P(X > x) for the currently selected distribution.
  // Used by both the per-loss RP column and the layer burning cost table.
  const survivalFn = useMemo(() => {
    const f = fits.find(f => f.key === activeDist);
    if (!f) return null;
    if (activeDist === 'pareto') {
      return x => x < xm ? 1 : Math.pow(xm / x, alpha);
    }
    if (activeDist === 'lognormal' && f.params) {
      const { mu, sigma } = f.params;
      return x => x <= 0 ? 1 : 1 - lognormalCDF(x, mu, sigma);
    }
    if (activeDist === 'exponential' && f.params) {
      return x => x < xm ? 1 : Math.exp(-f.params.lambda * (x - xm));
    }
    if (activeDist === 'weibull' && f.params) {
      const { k, lam } = f.params;
      return x => x < xm ? 1 : Math.exp(-Math.pow((x - xm) / lam, k));
    }
    return null;
  }, [activeDist, fits, xm, alpha]);

  // Risk Pure Premium: Pareto uses the analytical LEV; other fitted
  // distributions integrate the survival function numerically. Defined after
  // survivalFn since it depends on it.
  const lp = useMemo(() => {
    if (!survivalFn) return { severity: null, rpp: null, error: 'No fit' };
    if (activeDist === 'pareto') {
      return calcLayerPrice(alpha, xm, freq, xm, limit || xm * 10);
    }
    return calcLayerPriceNumerical(freq, xm, limit || xm * 10, survivalFn);
  }, [activeDist, survivalFn, alpha, xm, freq, limit]);

  // Structure layers scoped to this loss type (RISK for large, CAT for cat).
  // Source: appState.npStructureLayers (set by NpStructure screen on load).
  const isNpCat = lossType === 'cat';
  const structureLayers = useMemo(() => {
    const raw = Array.isArray(appState.npStructureLayers)
      ? appState.npStructureLayers
      : appState.npStructureLayers?.layers || [];
    return raw.filter(l => {
      if (l.peril_scope !== undefined) {
        return isNpCat
          ? (l.peril_scope === 'CAT' || l.peril_scope === 'BOTH')
          : (l.peril_scope === 'RISK' || l.peril_scope === 'BOTH');
      }
      return isNpCat ? !!l.catCover : !!l.riskCover;
    });
  }, [appState.npStructureLayers, isNpCat]);

  // Blend weights: wEmp (empirical) + wModel (distribution model), 0-100 each.
  // Presets: Empirical (100/0), Model (0/100), Blend (50/50 default).
  const [wEmp,   setWEmp]   = useState(50);
  const [wModel, setWModel] = useState(50);

  const empiricalLayerRols = useMemo(() => {
    if (!structureLayers.length || !losses.length || !(uwYrs > 0)) return [];

    // Group inflated losses by UW year
    const byYear = new Map();
    for (const l of losses) {
      const yr = String(l.uw_year ?? '');
      if (!yr) continue;
      if (!byYear.has(yr)) byYear.set(yr, []);
      byYear.get(yr).push(l.inflated);
    }

    return structureLayers.map((sl, i) => {
      const D = parseFloat(String(sl.deductible ?? sl.attachment ?? sl.layer_deductible ?? '').replace(/,/g, '')) || 0;
      const L = parseFloat(String(sl.limit ?? sl.layer_limit ?? '').replace(/,/g, '')) || 0;
      if (!(L > 0)) return { idx: i, layer: sl.layer || `L${i+1}`, D, L, rol: 0, annualLoss: 0 };

      // Sum in-layer loss per year; divide by full observation window (zero years included)
      let totalInLayer = 0;
      for (const yearLosses of byYear.values()) {
        for (const inc of yearLosses) {
          totalInLayer += layerHit(inc, D, L);
        }
      }
      const annualLoss = totalInLayer / uwYrs;
      return { idx: i, layer: sl.layer || `L${i+1}`, D, L, annualLoss, rol: L > 0 ? annualLoss / L : 0 };
    });
  }, [structureLayers, losses, uwYrs]);

  const modelLayerRols = useMemo(() => {
    if (!structureLayers.length || !(freq > 0) || !survivalFn) return [];

    return structureLayers.map((sl, i) => {
      const D = parseFloat(String(sl.deductible ?? sl.attachment ?? sl.layer_deductible ?? '').replace(/,/g, '')) || 0;
      const L = parseFloat(String(sl.limit ?? sl.layer_limit ?? '').replace(/,/g, '')) || 0;
      if (!(L > 0)) return { idx: i, layer: sl.layer || `L${i+1}`, D, L, rp: null, annualLoss: 0, rol: 0, error: null };

      const rp = rpAtAttachment(freq, D, survivalFn);
      let annualLoss, error;

      if (activeDist === 'pareto') {
        const result = calcLayerPrice(alpha, xm, freq, D, L);
        annualLoss = result.rpp;
        error = result.error || null;
      } else {
        annualLoss = calcLayerPriceNumerical(freq, D, L, survivalFn).rpp;
        error = null;
      }

      return { idx: i, layer: sl.layer || `L${i+1}`, D, L, rp, annualLoss, rol: L > 0 ? annualLoss / L : 0, error };
    });
  }, [structureLayers, freq, alpha, xm, activeDist, survivalFn]);

  const blendedLayerRols = useMemo(() => {
    const wE = Math.max(0, wEmp);
    const wM = Math.max(0, wModel);
    const wTot = wE + wM;

    return structureLayers.map((sl, i) => {
      const emp   = empiricalLayerRols[i];
      const model = modelLayerRols[i];
      if (!emp || !model) return null;
      const L = emp.L;

      let annualLoss;
      if (wTot <= 0) {
        annualLoss = 0;
      } else {
        annualLoss = (wE * emp.annualLoss + wM * model.annualLoss) / wTot;
      }

      return {
        idx: i,
        layer: emp.layer,
        D: emp.D, L,
        empiricalRol:  emp.rol,
        modelRol:      model.rol,
        blendedRol:    L > 0 ? annualLoss / L : 0,
        blendedAnnual: annualLoss,
        rp:            model.rp,
        error:         model.error,
      };
    }).filter(Boolean);
  }, [structureLayers, empiricalLayerRols, modelLayerRols, wEmp, wModel]);

  // Parse OEP input into a sorted (rp, loss) curve with at least 2 valid points.
  const oepPts = useMemo(() => {
    return oepRows
      .map(r => ({
        rp:   parseFloat(r.rp),
        loss: parseFloat(String(r.loss).replace(/,/g, '')),
      }))
      .filter(p => p.rp > 0 && p.loss > 0)
      .sort((a, b) => a.rp - b.rp);  // ascending RP = descending exceedance probability
  }, [oepRows]);

  // Piecewise-linear OEP survival: P(occurrence loss > x).
  // Below min OEP loss → use EP at minimum RP. Above max → 0.
  const oepSurvivalFn = useMemo(() => {
    if (oepPts.length < 2) return null;
    return (x) => {
      if (x <= 0) return 1 / oepPts[0].rp;
      if (x >= oepPts[oepPts.length - 1].loss) return 0;
      for (let i = 0; i < oepPts.length - 1; i++) {
        const lo = oepPts[i], hi = oepPts[i + 1];
        if (x >= lo.loss && x <= hi.loss) {
          const t = (x - lo.loss) / (hi.loss - lo.loss);
          return (1 / lo.rp) + t * ((1 / hi.rp) - (1 / lo.rp));
        }
      }
      return 0;
    };
  }, [oepPts]);

  const oepLayerRols = useMemo(() => {
    if (lossType !== 'cat' || !oepSurvivalFn || !structureLayers.length) return [];
    return structureLayers.map((sl, i) => {
      const D = parseFloat(String(sl.deductible ?? sl.attachment ?? sl.layer_deductible ?? '').replace(/,/g, '')) || 0;
      const L = parseFloat(String(sl.limit ?? sl.layer_limit ?? '').replace(/,/g, '')) || 0;
      if (!(L > 0)) return { idx: i, layer: sl.layer || `L${i+1}`, D, L, rol: 0, annualLoss: 0, rp: null };

      const rp = rpAtAttachment(1, D, oepSurvivalFn);  // freq=1 because OEP already encodes annual probability
      const annualLoss = calcLayerPriceNumerical(1, D, L, oepSurvivalFn, 500).rpp;
      return { idx: i, layer: sl.layer || `L${i+1}`, D, L, rp, annualLoss, rol: L > 0 ? annualLoss / L : 0 };
    });
  }, [lossType, oepSurvivalFn, structureLayers]);

  // Build the full snapshot payload.
  // Declared after wEmp / wModel / blendedLayerRols / oepLayerRols because
  // its dependency array reads them — those bindings would otherwise be in
  // the TDZ on first render.
  const buildSnapshotPayload = useCallback(async () => {
    const pts = returnPeriods.map(p => ({ rp: p.rp, loss: p.loss }));
    const rp10 = pts.find(p => p.rp === 10)?.loss ?? null;
    const rp50 = pts.find(p => p.rp === 50)?.loss ?? null;
    const rp100 = pts.find(p => p.rp === 100)?.loss ?? null;
    const rp250 = pts.find(p => p.rp === 250)?.loss ?? null;

    // Serialize all 4 distribution fits for audit
    const distFits = fits.map(f => ({
      key: f.key, params: f.params, ks: { ks: f.ks.ks, pValue: f.ks.pValue },
      paramStr: f.paramStr, n: f.n,
    }));

    const assumptions = {
      lossType, activeDist, xm, limit, yearsOvr: String(yearsOvr || ''),
      selected: losses.map(l => ({ id: l.loss_id, infl: cn(l.inflation_factor || 1) })).sort((a, b) => String(a.id).localeCompare(String(b.id))),
    };
    const assumptions_hash = await sha256Hex(stableStringify(assumptions));

    return {
      selected_count: losses.length,
      selected_losses: losses.map(l => ({
        loss_id: l.loss_id, uw_year: l.uw_year, insured_name: l.insured_name, loss_name: l.loss_name,
        date_of_loss: l.date_of_loss, class_of_business: l.class_of_business,
        paid: l.paid, os: l.os, incurred: l.incurred, inflation_factor: l.inflation_factor, inflated: l.inflated,
      })),
      distribution_fits: distFits,
      active_distribution: activeDist,
      pareto_xm: xm,
      pareto_alpha: alpha,
      pareto_limit: limit,
      observation_years: Number(yearsOvr) || 10,
      // return_period_curve carries the layer burning cost + OEP payload too,
      // since the server only persists a whitelist of top-level keys but stores
      // this one as JSONB. Nesting keeps everything within a column the handler
      // already round-trips.
      return_period_curve: {
        activeDist, xm, limit, yearsOvr: yearsOvr || null, points: pts,
        layer_burning_cost: {
          wEmp,
          wModel,
          rows: blendedLayerRols.map(r => ({
            layer:        r.layer,
            deductible:   r.D,
            limit:        r.L,
            return_period: r.rp,
            empirical_rol: r.empiricalRol,
            model_rol:     r.modelRol,
            blended_rol:   r.blendedRol,
            blended_annual_loss: r.blendedAnnual,
          })),
        },
        ...(lossType === 'cat' ? {
          oep_input: oepRows,
          oep_layer_burning_cost: oepLayerRols.map(r => ({
            layer:       r.layer,
            deductible:  r.D,
            limit:       r.L,
            return_period: r.rp,
            annual_loss: r.annualLoss,
            rol:         r.rol,
          })),
          third_party_rp: {
            rows: tpRows,
            source: tpSource,
            selection: rpSource,
            blend: rpBlend,
            effective_points: effectiveReturnPeriods,
          },
        } : {}),
      },
      return_period_key_points: { rp10, rp50, rp100, rp250 },
      assumptions_hash,
    };
  }, [lossType, activeDist, xm, limit, yearsOvr, alpha, losses, fits, returnPeriods, wEmp, wModel, blendedLayerRols, oepRows, oepLayerRols, tpRows, tpSource, rpSource, rpBlend, effectiveReturnPeriods]);

  // Explicit save function
  const saveSnapshot = useCallback(async () => {
    // Never persist a portfolio-fallback curve as this treaty's own snapshot.
    // Nothing to save here is a clean no-op, not a failure — return true so
    // WizardLayout doesn't surface a red "Save failed" banner on navigation.
    if (!contractId || !losses.length || xm <= 0 || portfolioFallback) return true;
    try {
      setSaving(true); setSaveError(null);
      const payload = await buildSnapshotPayload();
      await api.saveLossSelectionSnapshot(contractId, lossType, payload, appState.quoteMode ? { quote: true } : undefined);
      setLastSaveTime(new Date());
      setSaving(false);
      return true;
    } catch (e) {
      console.error('Save return period snapshot failed', e);
      setSaveError(e?.message || String(e));
      setSaving(false);
      return false;
    }
  }, [contractId, lossType, losses, xm, buildSnapshotPayload, appState.quoteMode, portfolioFallback]);

  // Auto-save on debounce when key parameters change. Toast only on the
  // OK→failed transition so a flaky network doesn't spam the user every
  // 800ms; the inline ⚠ banner already shows the persistent error.
  const lastAutoSaveOkRef = useRef(true);
  useEffect(() => {
    if (loading || !contractId || !losses.length || xm <= 0 || !returnPeriods.length || portfolioFallback) return;
    const t = setTimeout(async () => {
      const ok = await saveSnapshot();
      if (!ok && lastAutoSaveOkRef.current) {
        showToast('Pareto auto-save failed — click Save Curve to retry');
      }
      lastAutoSaveOkRef.current = ok;
    }, 800);
    return () => { clearTimeout(t); };
  }, [loading, contractId, lossType, losses, xm, limit, alpha, activeDist, yearsOvr, returnPeriods, saveSnapshot, showToast, portfolioFallback]);

  const bestFit=useMemo(()=>[...fits].sort((a,b)=>a.ks.ks-b.ks.ks)[0]?.key||'pareto',[fits]);

  return(
    <WizardLayout routeKey={routeKey} title={title} headerPill={headerPill} onBeforeNext={saveSnapshot} onBeforeBack={saveSnapshot}>
      {()=>(
        <div className="LARGE_LOSS_PARETO_PAGE">
          {loading?<div style={{padding:32,color:'rgba(255,255,255,.4)'}}>Loading…</div>:count===0?(
            <div style={{padding:32,textAlign:'center',color:'rgba(255,255,255,.4)'}}>No selected losses. Go to Loss Selection first.</div>
          ):(<>
            {portfolioFallback && (
              <div style={{margin:'0 0 14px',padding:'10px 16px',borderRadius:10,background:'rgba(251,191,36,0.08)',border:'1px solid rgba(251,191,36,0.30)',fontSize:12,color:'rgba(253,230,138,0.95)',lineHeight:1.5}}>
                <b style={{letterSpacing: 0 }}>PORTFOLIO AVERAGE.</b>{' '}
                This treaty has no {lossType === 'cat' ? 'CAT' : 'large'} losses of its own — the curve below is fitted to the cedant's wider portfolio
                ({lossType === 'cat' ? 'CAT' : 'large'} losses from {portfolioFallback.treatyCount} other {portfolioFallback.treatyCount === 1 ? 'treaty' : 'treaties'}). Add losses on the Loss Selection step to fit this treaty's own experience.
              </div>
            )}
            {/* HERO */}
            <div className="llp-hero">
              <div className="llp-hero-left">
                <div className="llp-title">
                  {stopLossTreaty ? 'Aggregate Distribution Fit' : 'Severity Distribution Fit'}
                </div>
                <div className="llp-subtitle">
                  {stopLossTreaty
                    ? `Stop Loss treaty: fitting Pareto / Lognormal / Exponential / Weibull to YEARLY AGGREGATES of selected ${lossType} losses (${yearlyAggregates.length} year${yearlyAggregates.length === 1 ? '' : 's'}). Toggle individual losses on the previous step to change the input.`
                    : `Fit parametric distributions to ${lossType} losses. Adjust threshold and limit. Compare Pareto, Lognormal, Exponential, Weibull via KS goodness-of-fit.`}
                </div>
              </div>
              <div className="llp-hero-right" style={{display:'flex',gap:8,alignItems:'center',flexWrap:'wrap'}}>
                {saving && <span style={{fontSize:11,color:'rgba(255,255,255,.4)'}}>Saving…</span>}
                {saveError && <span style={{fontSize:11,color:'#f87171'}}>⚠ {saveError}</span>}
                {lastSaveTime && !saving && !saveError && <span style={{fontSize:11,color:'#4ade80'}}>✓ Saved</span>}
                <button className="llp-pill-btn" style={{background:'rgba(34,197,94,0.15)',borderColor:'rgba(34,197,94,0.4)',color:'#4ade80'}} onClick={async()=>{const ok=await saveSnapshot();if(!ok)showToast('Save failed — check console');}}>💾 Save Curve</button>
                <button className="llp-pill-btn" onClick={()=>setShowChart(true)}>View Sev-Freq Curve</button>
              </div>
            </div>

            {/* PARAMETERS */}
            <div className="llp-params glass">
              <div className="llp-card-head"><div className="llp-card-title">Parameters</div><div className="llp-card-hint">Inputs auto-recompute stats + pricing</div></div>
              <div className="llp-form-grid">
                <Fld label="Pareto Min (Threshold)" help="Only losses ≥ threshold drive the tail." value={fmt(xm)} onCommit={v=>{const n=cn(v);if(n>0)setXm(n);}}/>
                <Fld label="Treaty Limit (Max)" help="Auto-set from total Risk/Cat layer limits in Structure. Editable override." value={fmt(limit)} onCommit={v=>setLimit(cn(v))}/>
                <Fld label="Alpha (α)" help="Higher α → lighter tail. Editable." value={fDec(alpha,3)} onCommit={v=>{const n=parseFloat(v);if(Number.isFinite(n)&&n>0)setAlpha(n);}}/>
                <Fld label="Observation Years" help="Frequency = tail count ÷ years." value={yearsOvr||'10'} onCommit={v=>setYearsOvr(v)}/>
              </div>
            </div>

            {/* FREQUENCY-SEVERITY CURVE MODAL */}
            {showChart&&(
              <div className="llp-modal-backdrop is-open" onClick={e=>{if(e.target===e.currentTarget)setShowChart(false);}}>
                <div className="llp-modal glass" style={{width:'min(1100px,96vw)',maxHeight:'92vh',display:'flex',flexDirection:'column'}}>
                  <div className="llp-modal-head">
                    <div className="llp-modal-title">Frequency–Severity Analysis · {lossType==='cat'?'Cat':'Large'} Losses</div>
                    <button className="llp-modal-x" onClick={()=>setShowChart(false)}>✕</button>
                  </div>
                  <div style={{overflowY:'auto',padding:'14px 20px 18px'}}>
                    <div className="llp-dist-tabs" style={{marginBottom:12}}>
                      {DISTS.map(d=>(
                        <button key={d.key} className={`llp-dist-tab ${activeDist===d.key?'active':''}`}
                          style={activeDist===d.key?{borderColor:d.color,color:d.color}:{}}
                          onClick={()=>setActiveDist(d.key)}>{d.label}</button>
                      ))}
                    </div>

                    <ParameterExplanations
                      activeDist={activeDist} fits={fits} xm={xm} limit={limit}
                      freq={freq} uwYrs={uwYrs} tailN={inflated.filter(l=>l>=xm).length}
                    />

                    <div style={{display:'grid',gridTemplateColumns:'1fr 1fr',gap:14,marginTop:14}}>
                      <div>
                        <div style={{fontSize:11,fontWeight:700,letterSpacing: 0, textTransform:'uppercase',color:'rgba(255,255,255,.65)',marginBottom:4}}>Severity Curve</div>
                        <div style={{fontSize:11,color:'rgba(255,255,255,.55)',marginBottom:8}}>Probability density of a single loss size, given it exceeded the threshold. Bars = empirical histogram, line = fitted {DISTS.find(d=>d.key===activeDist)?.label} PDF.</div>
                        <div className="llp-chart-wrap" style={{minHeight:300}}><SeverityChart losses={inflated} xm={xm} limit={limit} fits={fits} activeDist={activeDist}/></div>
                      </div>
                      <div>
                        <div style={{fontSize:11,fontWeight:700,letterSpacing: 0, textTransform:'uppercase',color:'rgba(255,255,255,.65)',marginBottom:4}}>Frequency Curve</div>
                        <div style={{fontSize:11,color:'rgba(255,255,255,.55)',marginBottom:8}}>Annual count of losses ≥ threshold, modelled as Poisson(λ). Bar height = probability of exactly N events in a year.</div>
                        <div className="llp-chart-wrap" style={{minHeight:300}}><FrequencyChart lambda={freq}/></div>
                      </div>
                    </div>

                    <div style={{marginTop:14}}>
                      <div style={{fontSize:11,fontWeight:700,letterSpacing: 0, textTransform:'uppercase',color:'rgba(255,255,255,.65)',marginBottom:4}}>Annual Exceedance Frequency (Return Period View)</div>
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
            )}

            {/* GOODNESS OF FIT TABLE */}
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
                      return(<tr key={f.key} className={selected?'llp-selected-row':best?'llp-best-row':''} style={{cursor:'pointer'}} onClick={()=>setActiveDist(f.key)}>
                        <td style={{textAlign:'center'}}><input type="radio" name="distSelect" checked={selected} onChange={()=>setActiveDist(f.key)} style={{accentColor:d?.color,cursor:'pointer'}}/></td>
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

            {/* STATS + RETURN PERIODS */}
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
                          marginLeft: 8, fontSize: 10, fontWeight: 700, letterSpacing: 0,
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
                      onClick={() => setRpCompareOpen(true)}
                      style={{
                        padding: '6px 12px', borderRadius: 7,
                        border: '1px solid var(--hairline)',
                        background: 'rgba(var(--accent-rgb),0.08)',
                        color: 'var(--accent)', cursor: 'pointer',
                        fontSize: 11, fontWeight: 700, letterSpacing: 0, textTransform: 'uppercase',
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

            {lossType === 'cat' && (
              <RpComparisonModal
                isOpen={rpCompareOpen}
                onClose={() => setRpCompareOpen(false)}
                fittedRows={returnPeriods}
                tpRows={tpRows}
                tpSource={tpSource}
                rpSource={rpSource}
                rpBlend={rpBlend}
                distLabel={DISTS.find(d => d.key === activeDist)?.label || ''}
                fmt={fmt}
                onApply={({ tpRows: rows, tpSource: src, rpSource: sel, rpBlend: blend }) => {
                  setTpRows(rows);
                  setTpSource(src);
                  setRpSource(sel);
                  setRpBlend(blend);
                  // Auto-save effect re-runs because saveSnapshot's deps
                  // (via buildSnapshotPayload) include these state values.
                }}
              />
            )}

            {/* PARETO RANKING TABLE */}
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

            {/* ── Layer Burning Cost ────────────────────────────────────── */}
            {blendedLayerRols.length > 0 && (
              <div className="llp-card glass" style={{ marginTop: 14 }}>
                <div className="llp-card-head">
                  <div>
                    <div className="llp-card-title">Layer Burning Cost</div>
                    <div className="llp-card-sub">
                      Empirical = layerHit per loss ÷ {uwYrs} years &nbsp;·&nbsp;
                      Model = {DISTS.find(d => d.key === activeDist)?.label} freq × E[loss in layer] &nbsp;·&nbsp;
                      Blend = weighted average
                    </div>
                  </div>
                </div>

                {/* Weight controls */}
                <div style={{ padding: '10px 14px 4px', display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 11, color: 'rgba(148,163,184,0.7)', fontWeight: 700, letterSpacing: 0, textTransform: 'uppercase' }}>Method</span>

                  {/* Presets */}
                  {[
                    { label: 'Empirical',  wE: 100, wM: 0   },
                    { label: '50 / 50',   wE: 50,  wM: 50  },
                    { label: 'Model',     wE: 0,   wM: 100 },
                  ].map(p => {
                    const active = wEmp === p.wE && wModel === p.wM;
                    return (
                      <button
                        key={p.label}
                        onClick={() => { setWEmp(p.wE); setWModel(p.wM); }}
                        style={{
                          fontSize: 11, fontWeight: 700, padding: '4px 12px', borderRadius: 20, cursor: 'pointer',
                          border: `1px solid ${active ? 'rgba(0,212,255,0.6)' : 'rgba(255,255,255,0.12)'}`,
                          background: active ? 'rgba(0,212,255,0.12)' : 'transparent',
                          color: active ? '#00d4ff' : 'rgba(148,163,184,0.7)',
                        }}
                      >
                        {p.label}
                      </button>
                    );
                  })}

                  {/* Custom weight inputs */}
                  <span style={{ fontSize: 11, color: 'rgba(148,163,184,0.5)', marginLeft: 8 }}>Custom:</span>
                  {[
                    { label: 'Empirical %', val: wEmp,   set: v => setWEmp(Math.max(0, Math.min(100, Number(v) || 0)))  },
                    { label: 'Model %',     val: wModel, set: v => setWModel(Math.max(0, Math.min(100, Number(v) || 0))) },
                  ].map(({ label, val, set }) => (
                    <label key={label} style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: 11, color: 'rgba(148,163,184,0.65)' }}>
                      {label}
                      <input
                        type="number" min="0" max="100" value={val}
                        onChange={e => set(e.target.value)}
                        style={{
                          width: 54, textAlign: 'center', fontSize: 12, fontWeight: 700,
                          background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)',
                          borderRadius: 6, color: '#00d4ff', padding: '3px 6px', outline: 'none',
                        }}
                      />
                    </label>
                  ))}

                  {/* Weight total indicator */}
                  {(wEmp + wModel) > 0 && (wEmp + wModel) !== 100 && (
                    <span style={{ fontSize: 10, color: '#f59e0b', marginLeft: 4 }}>
                      ⚠ Weights sum to {wEmp + wModel}% — blended ROL uses proportional share, not 100% total.
                    </span>
                  )}
                </div>

                {/* Table */}
                <div style={{ overflowX: 'auto' }}>
                  <table className="llp-table" style={{ width: '100%' }}>
                    <thead>
                      <tr>
                        <th>Layer</th>
                        <th className="num">Deductible</th>
                        <th className="num">Limit</th>
                        <th className="num">RP at Attach.</th>
                        <th className="num">Empirical ROL</th>
                        <th className="num">Model ROL</th>
                        <th className="num" style={{ color: '#00d4ff' }}>Blended ROL</th>
                        <th className="num" style={{ color: '#00d4ff' }}>Annual Loss</th>
                      </tr>
                    </thead>
                    <tbody>
                      {blendedLayerRols.map(row => {
                        const rpLabel = row.rp == null ? '—'
                          : row.rp >= 10000 ? '>10,000y'
                          : row.rp >= 100   ? `1-in-${Math.round(row.rp)}y`
                          :                   `1-in-${row.rp.toFixed(1)}y`;
                        const rpColor = row.rp == null ? 'rgba(148,163,184,0.4)'
                          : row.rp >= 50 ? '#f87171' : row.rp >= 10 ? '#f59e0b' : '#4ade80';
                        return (
                          <tr key={row.idx}>
                            <td style={{ color: '#00d4ff', fontWeight: 700 }}>{row.layer}</td>
                            <td className="num">{fmt(row.D)}</td>
                            <td className="num">{fmt(row.L)}</td>
                            <td className="num" style={{ color: rpColor, fontWeight: 600 }}>{rpLabel}</td>
                            <td className="num" style={{ color: 'rgba(226,232,240,0.7)' }}>
                              {row.empiricalRol > 0 ? (row.empiricalRol * 100).toFixed(3) + '%' : '—'}
                            </td>
                            <td className="num" style={{ color: '#a78bfa' }}>
                              {row.modelRol > 0 ? (row.modelRol * 100).toFixed(3) + '%' : '—'}
                              {row.error && <span style={{ fontSize: 10, color: '#f59e0b', marginLeft: 4 }}>⚠</span>}
                            </td>
                            <td className="num" style={{ color: '#00d4ff', fontWeight: 700 }}>
                              {row.blendedRol > 0 ? (row.blendedRol * 100).toFixed(3) + '%' : '—'}
                            </td>
                            <td className="num" style={{ color: '#4ade80' }}>
                              {fmt(Math.round(row.blendedAnnual))}
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {structureLayers.length === 0 && (
                  <div style={{ padding: '10px 14px', fontSize: 11, color: 'rgba(251,191,36,0.7)' }}>
                    No structure layers found for this peril type. Define layers in the Structure screen first.
                  </div>
                )}
              </div>
            )}

            {/* ── Cat OEP Burning Cost (cat screen only) ───────────────── */}
            {lossType === 'cat' && (
              <div className="llp-card glass" style={{ marginTop: 14 }}>
                <div
                  className="llp-card-head"
                  style={{ cursor: 'pointer' }}
                  onClick={() => setShowOep(s => !s)}
                >
                  <div>
                    <div className="llp-card-title">
                      Cat Model OEP Burning Cost {showOep ? '▲' : '▼'}
                    </div>
                    <div className="llp-card-sub">
                      Enter OEP curve from cat model (RMS / AIR / Verisk). Layer burning cost = ∫[D, D+L] P(occ loss &gt; x) dx.
                    </div>
                  </div>
                </div>

                {showOep && (
                  <div style={{ padding: '0 14px 14px', display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>

                    {/* OEP input grid */}
                    <div>
                      <div style={{ fontSize: 10, fontWeight: 700, color: 'rgba(148,163,184,0.5)', letterSpacing: 0, textTransform: 'uppercase', marginBottom: 6 }}>
                        OEP Curve Input
                      </div>
                      <table className="llp-table" style={{ width: 300 }}>
                        <thead>
                          <tr>
                            <th>Return Period (yrs)</th>
                            <th className="num">Ground-Up Loss</th>
                          </tr>
                        </thead>
                        <tbody>
                          {oepRows.map((row, i) => (
                            <tr key={i}>
                              <td>
                                <input
                                  type="text"
                                  value={row.rp}
                                  onChange={e => setOepRows(prev => {
                                    const next = [...prev];
                                    next[i] = { ...next[i], rp: e.target.value };
                                    return next;
                                  })}
                                  style={{
                                    width: '100%', textAlign: 'center', fontSize: 12,
                                    background: 'rgba(255,255,255,0.05)',
                                    border: '1px solid rgba(255,255,255,0.10)',
                                    borderRadius: 4, color: '#00d4ff', padding: '4px 6px', outline: 'none',
                                  }}
                                />
                              </td>
                              <td>
                                <input
                                  type="text"
                                  value={row.loss}
                                  placeholder="0"
                                  onChange={e => setOepRows(prev => {
                                    const next = [...prev];
                                    next[i] = { ...next[i], loss: e.target.value };
                                    return next;
                                  })}
                                  style={{
                                    width: '100%', textAlign: 'right', fontSize: 12,
                                    background: 'rgba(255,255,255,0.05)',
                                    border: '1px solid rgba(255,255,255,0.10)',
                                    borderRadius: 4, color: 'rgba(226,232,240,0.9)', padding: '4px 6px', outline: 'none',
                                  }}
                                />
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.4)', marginTop: 6 }}>
                        Minimum 2 rows with values. Piecewise linear interpolation between points.
                      </div>
                    </div>

                    {/* OEP layer results */}
                    {oepLayerRols.length > 0 && oepLayerRols.some(l => l.rol > 0) && (
                      <div style={{ flex: 1, minWidth: 300 }}>
                        <div style={{ fontSize: 10, fontWeight: 700, color: 'rgba(148,163,184,0.5)', letterSpacing: 0, textTransform: 'uppercase', marginBottom: 6 }}>
                          OEP Layer Burning Cost
                        </div>
                        <table className="llp-table" style={{ width: '100%' }}>
                          <thead>
                            <tr>
                              <th>Layer</th>
                              <th className="num">RP at Attach.</th>
                              <th className="num">Annual Loss</th>
                              <th className="num" style={{ color: '#f59e0b' }}>OEP ROL</th>
                            </tr>
                          </thead>
                          <tbody>
                            {oepLayerRols.map(row => {
                              const rpLabel = row.rp == null ? '—'
                                : row.rp >= 10000 ? '>10,000y'
                                : row.rp >= 100   ? `1-in-${Math.round(row.rp)}y`
                                :                   `1-in-${row.rp.toFixed(1)}y`;
                              return (
                                <tr key={row.idx}>
                                  <td style={{ color: '#00d4ff', fontWeight: 700 }}>{row.layer}</td>
                                  <td className="num" style={{ color: 'rgba(226,232,240,0.7)' }}>{rpLabel}</td>
                                  <td className="num" style={{ color: '#4ade80' }}>{fmt(Math.round(row.annualLoss))}</td>
                                  <td className="num" style={{ fontWeight: 700, color: '#f59e0b' }}>
                                    {row.rol > 0 ? (row.rol * 100).toFixed(3) + '%' : '—'}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                        <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.4)', marginTop: 6 }}>
                          Integration: 500-step trapezoidal rule. OEP ROL is independent of the Pareto/distribution fit above.
                        </div>
                      </div>
                    )}

                    {oepPts.length < 2 && (
                      <div style={{ fontSize: 11, color: 'rgba(251,191,36,0.65)', alignSelf: 'center' }}>
                        Enter at least 2 loss values to compute layer costs.
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </>)}
        </div>
      )}
    </WizardLayout>
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
          <div style={{fontSize:11,fontWeight:700,letterSpacing: 0, textTransform:'uppercase',color:distColor}}>Severity Model · {distLabel}</div>
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
          <div style={{fontSize:11,fontWeight:700,letterSpacing: 0, textTransform:'uppercase',color:'#22d3ee'}}>Frequency Model · Poisson</div>
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

function Fld({label,help,value,onCommit}){
  const [local,setLocal]=useState(value);
  useEffect(()=>{setLocal(value);},[value]);
  return(
    <div className="llp-field">
      <div className="llp-label">{label}</div>
      <input className="llp-input numeric" value={local} onChange={e=>setLocal(e.target.value)} onBlur={()=>onCommit(local)} onKeyDown={e=>{if(e.key==='Enter')onCommit(local);}}/>
      {help&&<div className="llp-help">{help}</div>}
    </div>
  );
}
