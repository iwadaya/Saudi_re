// loss_pareto/math/distributions.js — the Pareto-fit loss math behind
// LossParetoScreen (severity fits, KS goodness-of-fit, layer pricing,
// return periods). Moved verbatim from LossParetoScreen.jsx in the
// Phase 4.2 decomposition — NO math changes; the numbers are pinned by
// LossParetoScreen.goldenMaster.test.jsx and utils/paretoFit.verifyExcel.test.js.
//
// fitPareto / paretoQ are the npPricingEngine implementations (single
// source of truth — import, never duplicate). calcLayerPrice keeps its
// own full-LEV form; its agreement with npPricingEngine.paretoLayerExpectedLoss
// is asserted by the verifyExcel cross-check suite.

import { erf, invNormalCdf } from '../../../../../../shared/pricingMath.js';
import { fitPareto, paretoQ } from '../../../../utils/npPricingEngine.js';
import { fDec } from '../format.js';

export { fitPareto, paretoQ };

/* ══════════════════════════════════════════
   DISTRIBUTIONS
   ══════════════════════════════════════════ */
export function paretoCDF(x, a, xm) { return x < xm ? 0 : 1 - Math.pow(xm / x, a); }

// erf and the Acklam inverse-normal come from shared/pricingMath.js — one
// implementation, pinned by this screen's golden-master test.
const normInv = invNormalCdf;
export function fitLognormal(losses, xm) {
  const v=losses.filter(l=>l>=xm);const n=v.length;if(n===0)return{mu:0,sigma:1,n:0};
  const lg=v.map(l=>Math.log(l)),mu=lg.reduce((a,b)=>a+b,0)/n;
  const sigma=Math.sqrt(lg.reduce((a,b)=>a+Math.pow(b-mu,2),0)/n)||.01;
  return{mu,sigma,n};
}
export function lognormalCDF(x,mu,sigma){return x<=0?0:.5*(1+erf((Math.log(x)-mu)/(sigma*Math.SQRT2)));}
export function lognormalQ(p,mu,sigma){return Math.exp(mu+sigma*normInv(p));}

export function fitExponential(losses,xm){
  const v=losses.filter(l=>l>=xm);const n=v.length;if(n===0)return{lambda:1,n:0};
  const mean=v.reduce((a,b)=>a+(b-xm),0)/n;return{lambda:mean>0?1/mean:1,n};
}
export function expCDF(x,lam,xm){return x<xm?0:1-Math.exp(-lam*(x-xm));}
export function expQ(p,lam,xm){return xm-Math.log(1-p)/lam;}

export function fitWeibull(losses,xm){
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
export function weibullCDF(x,k,lam,xm){const z=x-xm;return z<=0?0:1-Math.exp(-Math.pow(z/lam,k));}
export function weibullQ(p,k,lam,xm){return xm+lam*Math.pow(-Math.log(1-p),1/k);}

/**
 * Threshold-condition a CDF: Fc(x) = (F(x) − F(xm)) / (1 − F(xm)) for x ≥ xm.
 * calcKS compares every candidate against the CONDITIONAL empirical CDF of
 * losses ≥ xm, and pareto/exp/weibull CDFs are naturally conditional
 * (F(xm) = 0) — but the lognormal's support extends below the threshold, so
 * its unconditional CDF scored the KS on a different basis and biased the
 * min-KS ranking between the four families (F59). Wrap it with this before
 * ranking. Degenerate fits with all mass below xm score as a total misfit.
 * (Note: fitLognormal remains an UNTRUNCATED MLE applied to the truncated
 * tail sample — a known approximation; only the scoring basis is aligned.)
 */
export function conditionalCDF(cdfFn, xm) {
  const F0 = cdfFn(xm);
  const denom = 1 - F0;
  if (!(denom > 0)) return () => 1; // all mass below threshold — cannot fit the tail
  return x => (x < xm ? 0 : (cdfFn(x) - F0) / denom);
}

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
  // No clamp of the retention up to xm: every fitted tail loss X ≥ xm
  // pierces a retention below the threshold in full, and LEV(c) = c for
  // c ≤ xm, so the unclamped LEV difference is exact. Clamping (the old
  // att = max(xm, ret)) understated layers attaching below xm by ~30-40%.
  const att=Math.max(0,ret),sev=LEV(att+lim)-LEV(att);return{severity:sev,rpp:freq*sev};
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
export function paretoPDF(x,a,xm){return x<xm?0:(a*Math.pow(xm,a))/Math.pow(x,a+1);}
export function lognormalPDF(x,mu,sigma){
  if(x<=0)return 0;
  const z=(Math.log(x)-mu)/sigma;
  return Math.exp(-0.5*z*z)/(x*sigma*Math.sqrt(2*Math.PI));
}
export function expPDF(x,lam,xm){return x<xm?0:lam*Math.exp(-lam*(x-xm));}
export function weibullPDF(x,k,lam,xm){
  const z=x-xm; if(z<=0)return 0;
  return (k/lam)*Math.pow(z/lam,k-1)*Math.exp(-Math.pow(z/lam,k));
}

/* ── Poisson PMF for the frequency model N ~ Poisson(λ) ── */
export function poissonPMF(n,lam){
  if(n<0||lam<=0)return n===0?1:0;
  // log-space to avoid overflow for large n
  let logFact=0; for(let i=2;i<=n;i++) logFact+=Math.log(i);
  return Math.exp(n*Math.log(lam)-lam-logFact);
}

export const DISTS=[
  {key:'pareto',label:'Pareto',color:'#22c55e'},
  {key:'lognormal',label:'Lognormal',color:'#3b82f6'},
  {key:'exponential',label:'Exponential',color:'#f59e0b'},
  {key:'weibull',label:'Weibull',color:'#a855f7'},
];

export function fitAll(losses,xm){
  const p=fitPareto(losses,xm),ln=fitLognormal(losses,xm),ex=fitExponential(losses,xm),wb=fitWeibull(losses,xm);
  return[
    {key:'pareto',params:p,ks:calcKS(losses,x=>paretoCDF(x,p.alpha,xm),xm),paramStr:`α=${fDec(p.alpha,3)}`,n:p.n},
    // Lognormal is scored on the threshold-conditional CDF so all four
    // candidates rank on the same basis — see conditionalCDF (F59).
    {key:'lognormal',params:ln,ks:calcKS(losses,conditionalCDF(x=>lognormalCDF(x,ln.mu,ln.sigma),xm),xm),paramStr:`μ=${fDec(ln.mu,2)} σ=${fDec(ln.sigma,2)}`,n:ln.n},
    {key:'exponential',params:ex,ks:calcKS(losses,x=>expCDF(x,ex.lambda,xm),xm),paramStr:`λ=${fDec(ex.lambda,6)}`,n:ex.n},
    {key:'weibull',params:wb,ks:calcKS(losses,x=>weibullCDF(x,wb.k,wb.lam,xm),xm),paramStr:`k=${fDec(wb.k,3)} λ=${fDec(wb.lam,0)}`,n:wb.n},
  ];
}

/* ══════════════════════════════════════════
   NP LAYER CAP HELPER
   sum limits for risk layers (large loss) or cat layers (cat loss)
   Works with both server rows (peril_scope) and appState rows (riskCover/catCover).
   ══════════════════════════════════════════ */
export function sumLayerLimits(layers, isNpCat) {
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
