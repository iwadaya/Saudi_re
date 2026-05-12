/* ─── Geomean + power-law fit (mirrors QuickBenchmark.jsx) ───
   Single source of truth for x = √((L+A)·A) / EGNPI and the
   y = a·x^b fit used by the benchmark Pricing Curve tab. */
import { toN } from '../../../utils/format';
import { deriveComponentTotal } from './formatters.js';

export const FQ_MARKET_A = 0.108;
export const FQ_MARKET_B = -1.074;
export const FQ_STRUCTURE_COLORS = ['#00d4ff', '#a78bfa', '#4ade80', '#f59e0b', '#f87171'];

export function fqToN(v) { return toN(v); }

export function fqGeomean(limit, att) {
  const top = limit + att;
  return top > 0 && att > 0 ? Math.sqrt(top * att) : 0;
}

export function fqFitPowerLaw(pts) {
  const p = (pts || []).filter((q) => q.x > 0 && q.y > 0 && isFinite(q.x) && isFinite(q.y));
  if (p.length < 2) return { a: FQ_MARKET_A, b: FQ_MARKET_B, r2: null, calibrated: false, n: p.length };
  const evalB = (b) => {
    let num = 0, den = 0;
    for (const pt of p) { const xb = Math.pow(pt.x, b); num += pt.y * xb; den += xb * xb; }
    if (!den || !isFinite(num)) return { sse: Infinity, a: NaN };
    const a = num / den;
    if (!isFinite(a) || a <= 0) return { sse: Infinity, a };
    let sse = 0;
    for (const pt of p) { const e = pt.y - a * Math.pow(pt.x, b); sse += e * e; }
    return { sse, a };
  };
  let best = { sse: Infinity, a: NaN, b: NaN };
  for (let b = -10; b <= 0; b += 0.1) { const r = evalB(b); if (r.sse < best.sse) best = { ...r, b }; }
  for (let b = best.b - 0.15; b <= best.b + 0.15; b += 0.005) { const r = evalB(b); if (r.sse < best.sse) best = { ...r, b }; }
  if (!isFinite(best.a) || !isFinite(best.b) || best.a <= 0) {
    return { a: FQ_MARKET_A, b: FQ_MARKET_B, r2: null, calibrated: false, n: p.length };
  }
  const meanY = p.reduce((s, pt) => s + pt.y, 0) / p.length;
  let ssTot = 0, ssRes = 0;
  for (const pt of p) {
    const yhat = best.a * Math.pow(pt.x, best.b);
    ssTot += (pt.y - meanY) ** 2;
    ssRes += (pt.y - yhat) ** 2;
  }
  const r2 = ssTot > 0 ? 1 - ssRes / ssTot : null;
  return { a: best.a, b: best.b, r2: isFinite(r2) ? r2 : null, calibrated: true, n: p.length };
}

// Layer → (x, y) for curve-fitting. ROL preference order:
//   explicit rol → earned premium/limit → derived from rate%·EGNPI/limit → uwPrice%
// Attachment falls back to `deductible` so contract-mode layers
// (which carry the same value under that field name) work too.
export function fqLayerToXY(l) {
  const limit = fqToN(l.limit);
  const att   = fqToN(l.attachment) || fqToN(l.deductible);
  const egnpi = fqToN(l.egnpi);
  if (!limit || !att || !egnpi) return null;
  const gm = fqGeomean(limit, att);
  const x = gm / egnpi;
  let y = 0;
  const rol = fqToN(l.rol);
  if (rol > 0) y = rol / 100;
  else {
    const ep = fqToN(l.earnedPremium) || fqToN(l.earned_premium);
    if (ep > 0) y = ep / limit;
    else {
      const rate = fqToN(l.rate);
      if (rate > 0) y = (rate / 100 * egnpi) / limit;
    }
  }
  if (y <= 0) {
    const uwPrice = fqToN(l.uwPrice);
    if (uwPrice > 0) y = uwPrice / 100;
  }
  if (x <= 0 || y <= 0) return null;
  return { x, y };
}

// Peer → (x, y). Peer rows store rolPct as a number (e.g. 5.42)
export function fqPeerToXY(p) {
  const limit = p.limit;
  const att   = p.ded;
  const egnpi = p.egnpi;
  if (!limit || !att || !egnpi) return null;
  const x = fqGeomean(limit, att) / egnpi;
  const y = (p.rolPct || 0) / 100;
  if (x <= 0 || y <= 0) return null;
  return { x, y };
}

export function fqCurveBaseEgnpi(expLayers = [], npDetail = {}) {
  const layerVals = (expLayers || []).map((l) => fqToN(l?.egnpi));
  const detailVals = [
    npDetail.estGnpi,
    npDetail.est_gnpi,
    npDetail.egnpi,
    npDetail.gnpi,
    npDetail.estimated_gnpi,
    npDetail.estimatedGrossNetPremiumIncome,
  ].map(fqToN);
  return Math.max(0, ...layerVals, ...detailVals);
}

export function fqPriceLayerOnCurve(layer, fit, fallbackEgnpi = 0) {
  const limit = fqToN(layer?.limit);
  const att = fqToN(layer?.attachment) || fqToN(layer?.deductible);
  const egnpi = fqToN(layer?.egnpi) || fqToN(fallbackEgnpi);
  if (!limit || !att || !egnpi || !fit) return null;
  const x = fqGeomean(limit, att) / egnpi;
  const y = x > 0 ? fit.a * Math.pow(x, fit.b) : 0;
  if (!Number.isFinite(x) || !Number.isFinite(y) || x <= 0 || y <= 0) return null;
  const premium = y * limit;
  const rate = egnpi > 0 ? premium / egnpi : 0;
  return { x, y, premium, rate, limit, attachment: att, egnpi };
}

export function fqQuoteLayerDerived(layer = {}) {
  const pb = fqToN(layer.pureBurn);
  const pa = fqToN(layer.pareto);
  const ex = fqToN(layer.exposure);
  const wb = fqToN(layer.wtBurn);
  const wp = fqToN(layer.wtPareto);
  const ld = fqToN(layer.loading);
  const wtExp = Math.max(0, 100 - wb - wp);
  const burnPlusPareto = pb + pa;
  const totalRol = deriveComponentTotal(pb, pa, ex, wb, wp, wtExp, ld);
  return { burnPlusPareto, wtExp, totalRol };
}

export function fqBuildPricingCurve({ expLayers = [], structures = [], npDetail = {} } = {}) {
  const baseEgnpi = fqCurveBaseEgnpi(expLayers, npDetail);
  const expPts = (expLayers || []).map((layer, i) => {
    const egnpi = baseEgnpi || fqToN(layer?.egnpi);
    const point = fqLayerToXY({
      ...layer,
      egnpi,
    });
    return point ? {
      ...point,
      limit: fqToN(layer?.limit),
      attachment: fqToN(layer?.attachment) || fqToN(layer?.deductible),
      egnpi,
      layer: i + 1,
      label: `E${i + 1}`,
    } : null;
  }).filter(Boolean);

  const fit = fqFitPowerLaw(expPts);
  const structPts = (structures || []).map((structure, sIdx) => {
    const color = FQ_STRUCTURE_COLORS[sIdx % FQ_STRUCTURE_COLORS.length];
    return (structure?.layers || []).map((layer, lIdx) => {
      const point = fqPriceLayerOnCurve(layer, fit, baseEgnpi);
      return point ? {
        ...point,
        structure: sIdx + 1,
        layer: lIdx + 1,
        label: `S${sIdx + 1}L${lIdx + 1}`,
        color,
      } : null;
    }).filter(Boolean);
  });

  const flatStructPts = structPts.flat();
  return {
    baseEgnpi,
    fit,
    expPts,
    structPts,
    flatStructPts,
    allPts: [...expPts, ...flatStructPts],
  };
}
