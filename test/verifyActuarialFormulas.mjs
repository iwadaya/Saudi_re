// Standalone verification CLI for the pricing / severity / aggregate maths.
//
// Companion to verifyChainLadderRAA.mjs and verifyBornhuetterFergusonRAA.mjs,
// which check the reserving side against the RAA benchmark triangle. This one
// checks the PRICING side, and it does it two ways:
//
//   1. Closed forms against numerical integration or a known closed form. A
//      limited expected value is ∫ S(x) dx over the layer; if the algebra in
//      the module is right, Simpson's rule on the survival function agrees to
//      ~1e-6. That test does not depend on anybody's judgement.
//
//   2. Estimators against exact samples. Feed fitGpdPwm a sample drawn from a
//      GPD with known (ξ, σ) and it has to come back with those numbers.
//
// It also PRINTS (does not assert) the diagnostics behind the open findings in
// docs/actuarial-formula-verification-2026-08.md — the Swiss Re curve
// mismatch, the exposure-rating base, the frequency/severity population
// mismatch, the burning-cost EGNPI gap. Those are pricing-math decisions
// blocked on actuarial sign-off (docs/pricing-signoff-required.md), so this
// file reports them rather than asserting either way.
//
// Run with: node test/verifyActuarialFormulas.mjs
// Exits non-zero if any ASSERTED identity fails.

import * as PM from '../shared/pricingMath.js';
import { mbbefdCurve, deductibleCredit } from '../shared/fac/methods/exposureCurve.js';
import {
  alphaFromDoublingLoading, ilfEvaluator, ilfLayerLossCost,
} from '../shared/fac/methods/ilfCurve.js';
import { credibilityFactor, annualLossVolatility } from '../shared/fac/credibility.js';
import { percentile } from '../shared/fac/methods/benchmark.js';
import { freqSeverityLossCost } from '../shared/fac/methods/freqSeverity.js';
import {
  paretoLEV, paretoLayerExpectedLoss, paretoAttachment, paretoQ,
  mbbefdG, SWISS_RE_C, calcRiskExposureRating, calcPureBurningCost,
} from '../client/src/utils/npPricingEngine.js';
import {
  fitGpdPwm, severityLayerMean, severitySurvival, runParetoMonteCarlo,
  invNormCdf, normCdf,
} from '../client/src/screens/non_proportional/final_pricing/paretoMonteCarlo.js';
import {
  calcKS, lognormalCDF, fitLognormal, fitWeibull, calcLayerPriceNumerical, lossReturnPeriod,
} from '../client/src/screens/shared/loss_pareto/math/distributions.js';

// ── harness ────────────────────────────────────────────────────────────────
let passed = 0;
const failures = [];
function chk(name, actual, expected, tol = 1e-6) {
  const rel = Math.abs(actual - expected) / Math.max(1e-12, Math.abs(expected));
  if (rel <= tol) { passed += 1; return; }
  failures.push(`${name}: got ${actual}, expected ${expected} (rel ${rel.toExponential(2)} > ${tol})`);
}
/** Absolute-error check — for quantities whose published bound is absolute
 *  (the A&S erf bound) or whose true value sits at or near zero (ξ → 0). */
function chkAbs(name, actual, expected, tol) {
  const abs = Math.abs(actual - expected);
  if (abs <= tol) { passed += 1; return; }
  failures.push(`${name}: got ${actual}, expected ${expected} (abs ${abs.toExponential(2)} > ${tol})`);
}
/** Composite Simpson — exact for the smooth survival functions used below. */
function simpson(f, a, b, n = 100000) {
  if (n % 2) n += 1;
  const h = (b - a) / n;
  let s = f(a) + f(b);
  for (let i = 1; i < n; i += 1) s += (i % 2 ? 4 : 2) * f(a + i * h);
  return (s * h) / 3;
}
/** Deterministic exact sample from a distribution given its quantile function. */
const exactSample = (q, n) => Array.from({ length: n }, (_, i) => q((i + 0.5) / n));

const hr = (t) => console.log(`\n── ${t} ${'─'.repeat(Math.max(0, 72 - t.length))}`);

// ── 1. Normal / erf primitives ─────────────────────────────────────────────
// Abramowitz & Stegun 7.1.26 claims |error| < 1.5e-7; hold it to that.
hr('Normal primitives (Abramowitz & Stegun 7.1.26)');
chkAbs('erf(0.5)', PM.erf(0.5), 0.5204998778130465, 1.5e-7);
chkAbs('erf(1)', PM.erf(1), 0.8427007929497149, 1.5e-7);
chkAbs('erf(2)', PM.erf(2), 0.9953222650189527, 1.5e-7);
chk('normalCdf(0)', PM.normalCdf(0), 0.5, 1e-7);
chk('normalCdf(1.959963985)', PM.normalCdf(1.959963985), 0.975, 1e-6);
for (const p of [0.025, 0.5, 0.975]) chk(`invNormCdf round-trip p=${p}`, normCdf(invNormCdf(p)), p, 1e-5);
console.log('erf / Φ / Φ⁻¹ within the A&S error bound.');

// ── 2. Aggregate (stop loss / aggregate XL) ────────────────────────────────
// E[(S−K)+] = (μ−K)Φ(z) + σφ(z) must equal ∫_K^∞ P(S > x) dx.
hr('Aggregate layer maths — compound Poisson + Normal approximation');
{
  const mu = 1000; const sd = 300; const K = 1200; const D = 1100; const L = 400;
  chk('normalStopLossPremium == ∫ S(x) dx',
    PM.normalStopLossPremium(mu, sd, K),
    simpson((x) => 1 - PM.normalCdf(x, mu, sd), K, mu + 12 * sd), 1e-5);
  chk('normalLayerMean == ∫_D^{D+L} S(x) dx',
    PM.normalLayerMean(mu, sd, D, L),
    simpson((x) => 1 - PM.normalCdf(x, mu, sd), D, D + L), 1e-5);

  // Compound Poisson: E[S] = λE[X]; Var[S] = λE[X²]. Cross-check the latter
  // against the general identity Var[S] = E[N]Var(X) + Var(N)E[X]².
  const lambda = 4; const mean = 500; const cv = 1.2;
  const { mu: lmu, sigma } = PM.lognormalFromMeanCv(mean, cv);
  const mom = PM.lognormalMoments(lmu, sigma);
  chk('lognormalFromMeanCv round-trips the mean', mom.mean, mean);
  chk('lognormalFromMeanCv round-trips the CV', Math.sqrt(mom.variance) / mom.mean, cv);
  const agg = PM.compoundPoissonMoments(lambda, mom.mean, mom.secondMoment);
  chk('E[S] = λE[X]', agg.mean, lambda * mean);
  chk('Var[S] = λE[X²]', agg.variance, lambda * mom.secondMoment);
  chk('Var[S] = E[N]Var(X) + Var(N)E[X]²', agg.variance, lambda * mom.variance + lambda * mean * mean);
  console.log('Stop-loss premium, layer mean and the two aggregate moments all reconcile.');
}

// ── 3. Severity limited expected values ────────────────────────────────────
// Every layer mean is ∫_A^{A+L} S(x) dx. That is the whole test.
hr('Severity layer means — Pareto / GPD / lognormal vs ∫ S(x) dx');
{
  const alpha = 2.4; const xm = 250; const cap = 5000;
  const Sp = (x) => (x <= xm ? 1 : (xm / x) ** alpha);
  chk('paretoLEV (α≠1)', paretoLEV(alpha, xm, cap), simpson(Sp, 0, cap));
  chk('paretoLEV (α=1)', paretoLEV(1, xm, cap), simpson((x) => (x <= xm ? 1 : xm / x), 0, cap));
  chk('paretoLayerExpectedLoss = (n/yrs)·∫_D^{D+L} S',
    paretoLayerExpectedLoss(alpha, xm, 1000, 4000, 12, 10),
    (12 / 10) * simpson(Sp, 1000, 5000));
  chk('paretoAttachment = (xm/D)^α', paretoAttachment(alpha, xm, 1000), (xm / 1000) ** alpha);
  chk('paretoQ is the CDF-probability quantile',
    1 - (xm / paretoQ(0.99, alpha, xm)) ** alpha, 0.99, 1e-9);
  chk('paretoMoments E[X]', PM.paretoMoments(3, 100).mean, (3 * 100) / 2);
  chk('paretoMoments E[X²]', PM.paretoMoments(3, 100).secondMoment, (3 * 100 * 100) / 1);

  const xi = 0.35; const sg = 800; const u = 100000; const A = 150000; const L = 400000;
  chk('GPD layer mean', severityLayerMean('GPD', { xi, sigma: sg }, u, A, L),
    simpson((x) => severitySurvival('GPD', { xi, sigma: sg }, u, x), A, A + L));
  const lmu = Math.log(120000); const lsig = 1.1;
  chk('lognormal layer mean', severityLayerMean('LOGNORMAL', { mu: lmu, sigma: lsig }, 0, A, L),
    simpson((x) => 1 - normCdf((Math.log(x) - lmu) / lsig), A, A + L), 1e-4);
  chk('Pareto layer mean (MC module)', severityLayerMean('PARETO', { alpha: 2.2, xm: 100000 }, 100000, A, L),
    simpson((x) => (x <= 100000 ? 1 : (100000 / x) ** 2.2), A, A + L));
  chk('calcLayerPriceNumerical', calcLayerPriceNumerical(2, 5000, 20000, Sp, 4000).severity,
    simpson(Sp, 5000, 25000), 1e-4);
  chk('lossReturnPeriod = 1/(λ·S(x))', lossReturnPeriod(10000, 2, Sp), 1 / (2 * Sp(10000)));
  console.log('All four severity families integrate to their closed forms.');
}

// ── 4. Estimators against exact samples ────────────────────────────────────
hr('Fitted estimators recover known parameters');
{
  // GPD via probability-weighted moments (Hosking & Wallis 1987, Technometrics 29(3)).
  for (const [xi, sg] of [[0.3, 1000], [1e-7, 1000], [-0.2, 1000], [0.6, 500]]) {
    const q = (p) => (Math.abs(xi) < 1e-6 ? -sg * Math.log(1 - p) : (sg / xi) * ((1 - p) ** -xi - 1));
    const f = fitGpdPwm(exactSample(q, 20000));
    chkAbs(`fitGpdPwm ξ (true ${xi})`, f.xi, xi, 0.01);
    chk(`fitGpdPwm σ (true ${sg})`, f.sigma, sg, 0.02);
  }
  // Weibull MLE by Newton-Raphson on the shape.
  const k = 1.7; const lam = 5000;
  const wb = fitWeibull(exactSample((p) => lam * (-Math.log(1 - p)) ** (1 / k), 20000), 0);
  chk('fitWeibull k', wb.k, k, 2e-2);
  chk('fitWeibull λ', wb.lam, lam, 2e-2);
  console.log('GPD PWM and Weibull MLE recover their generating parameters.');
}

// ── 5. Exposure curves and ILFs ────────────────────────────────────────────
hr('MBBEFD (Bernegger 1997) and Riebesell ILFs');
{
  const x = 0.37;
  chk('MBBEFD b=1 branch', mbbefdCurve(1, 5)(x), Math.log(1 + (5 - 1) * x) / Math.log(5));
  chk('MBBEFD bg=1 branch', mbbefdCurve(0.25, 4)(x), (1 - 0.25 ** x) / (1 - 0.25));
  chk('MBBEFD continuous as b→1', mbbefdCurve(1 + 1e-7, 5)(x), mbbefdCurve(1, 5)(x), 1e-5);
  const G = mbbefdCurve(3.6693, 30.5694); // Bernegger Swiss Re Y3 (c = 3)
  chk('G(0) = 0', G(0), 0, 1e-12);
  chk('G(1) = 1', G(1), 1);
  let mono = true; let conc = true; let prev = 0; let prevSlope = Infinity;
  for (let i = 1; i <= 1000; i += 1) {
    const v = G(i / 1000);
    const slope = (v - prev) * 1000;
    if (v < prev) mono = false;
    if (slope > prevSlope + 1e-9) conc = false;
    prev = v; prevSlope = slope;
  }
  if (mono) passed += 1; else failures.push('MBBEFD curve is not monotone');
  if (conc) passed += 1; else failures.push('MBBEFD curve is not concave');

  const a = alphaFromDoublingLoading(0.20);
  chk('Riebesell α = log₂(1+r)', a, Math.log2(1.2));
  const ILF = ilfEvaluator({ kind: 'POWER', basic_limit: 1e6, params: { alpha: a } });
  chk('ILF doubles by exactly (1+r)', ILF(2e6) / ILF(1e6), 1.2, 1e-12);
  chk('E[L xs D] = BLLC·(ILF(D+L) − ILF(D))',
    ilfLayerLossCost({ basicLimitLossCost: 100, attachment: 1e6, limit: 4e6, ILF }), 100 * (5 ** a - 1));
  console.log('MBBEFD special cases, monotonicity/concavity and Riebesell all hold.');
}

// ── 6. Credibility and order statistics ────────────────────────────────────
hr('Credibility and order statistics');
chk('Z = n/(n+k) is ½ at n = k', credibilityFactor(8, { k: 8, maxZ: 1 }).z, 0.5);
chk('percentile p50', percentile([1, 2, 3, 4, 5], 0.5), 3);
chk('percentile p25 interpolates', percentile([1, 2, 3, 4, 5], 0.25), 2);
chk('annualLossVolatility uses the n−1 divisor',
  annualLossVolatility([10, 20, 30, 40].map((v) => ({ layer_loss: v }))).sigma,
  Math.sqrt((225 + 25 + 25 + 225) / 3));
console.log('Bühlmann Z, percentile interpolation and the sample s.d. divisor are as documented.');

// ── 7. Monte-Carlo engine reconciles with its own analytic mean ────────────
hr('Monte-Carlo aggregate engine');
{
  const losses = exactSample((p) => 100000 * (1 - p) ** (-1 / 2.0), 60);
  const r = runParetoMonteCarlo({
    seed: 7, nSims: 60000, bootstrap: 100, losses, threshold: 100000,
    severity: { family: 'PARETO' },
    frequency: { type: 'POISSON', lambda: 3, years: 10 },
    layer: { attachment: 250000, limit: 750000, reinstatements: 1, reinstPct: 1, premium: 100000 },
  });
  const { analyticExpectedLoss: an, simulatedMeanUncapped: sim, zScore, withinTolerance } = r.reconciliation;
  console.log(`analytic λ·E[ceded] = ${an.toFixed(0)}   simulated (uncapped) = ${sim.toFixed(0)}   z = ${zScore.toFixed(2)}`);
  if (withinTolerance) passed += 1; else failures.push(`MC mean does not reconcile with the analytic mean (z=${zScore})`);
}

// ── 8. Diagnostics for the open findings (printed, not asserted) ───────────
hr('OPEN FINDINGS — diagnostics only, see docs/actuarial-formula-verification-2026-08.md');

console.log('\n[F-A] Swiss Re Y-curve constants vs Bernegger (1997) c = 1.5 / 2 / 3 / 4');
{
  const bOf = (c) => Math.exp(3.1 - 0.15 * c * (1 + c));
  const gOf = (c) => Math.exp((0.78 + 0.12 * c) * c);
  const publishedC = { Y1: 1.5, Y2: 2, Y3: 3, Y4: 4 };
  console.log('curve  code c   code G(.1)/G(.3)/G(.5)      published c   Bernegger G(.1)/G(.3)/G(.5)');
  for (const key of ['Y1', 'Y2', 'Y3', 'Y4']) {
    const c = SWISS_RE_C[key];
    const pc = publishedC[key];
    const B = mbbefdCurve(bOf(pc), gOf(pc));
    const codeVals = [0.1, 0.3, 0.5].map((v) => mbbefdG(v, c).toFixed(4)).join(' / ');
    const trueVals = [0.1, 0.3, 0.5].map((v) => B(v).toFixed(4)).join(' / ');
    console.log(`${key}     ${String(c).padEnd(6)}  ${codeVals}      ${String(pc).padEnd(11)}   ${trueVals}`);
  }
  console.log('Y1 in the code is c = 0, i.e. G(x) = x — the uniform destruction rate, not a Swiss Re curve.');
}

console.log('\n[F-B] Risk-XL exposure rating base: PML vs the band’s expected loss');
{
  const profile = (glr) => ({
    profile: { pml_percentage: 100, selected_curve: 'Y3', gross_loss_ratio: glr },
    bands: [{ no_of_risks: 100, total_sum_insured: 100e6 }],
  });
  const r = calcRiskExposureRating([profile(55)], 250000, 500000, 50e6);
  console.log(`100 risks × 1m SI, layer 500k xs 250k, GLR 55% → expected layer loss ${Math.round(r.totalExpLoss).toLocaleString()} on a 500,000 limit (ROL ${(r.rol * 100).toFixed(0)}%).`);
  const one = r.totalExpLoss;
  const two = calcRiskExposureRating([profile(55), profile(55)], 250000, 500000, 50e6).totalExpLoss;
  console.log(`gross-loss-ratio compounding: 2 identical profiles give ${(two / (2 * one)).toFixed(4)}× the doubled single-profile figure (should be 1.0000).`);
}

console.log('\n[F-C] FREQ_SEVERITY: declared claim count × large-loss-listing severity');
{
  const basis = [2021, 2022, 2023, 2024, 2025].map((y) => ({ loss_year: y, exposure_base: 1000, claim_count: 500 }));
  const losses = [400000, 600000, 900000, 350000, 1200000].map((v, i) => ({ loss_year: 2021 + i, fgu_incurred: v }));
  const r = freqSeverityLossCost({
    losses, basis, exposureUnits: 1000, severityTrendPct: 0, asOfYear: 2026, attachment: 250000, limit: 1000000,
  });
  const observed = losses.reduce((t, l) => t + Math.min(Math.max(l.fgu_incurred - 250000, 0), 1000000), 0) / 5;
  console.log(`declared count ${r.diagnostics.claim_count}, listing count ${r.diagnostics.listing_count}, engine loss cost ${Math.round(r.lossCost).toLocaleString()} vs observed annual layer loss ${observed.toLocaleString()} → ${(r.lossCost / observed).toFixed(0)}× on the same exposure.`);
}

console.log('\n[F-D] Pure burning cost drops a loss year that has no EGNPI row');
{
  const losses = [
    { uw_year: 2021, incurred: 0 }, { uw_year: 2022, incurred: 1_500_000 },
    { uw_year: 2023, incurred: 4_000_000 },
    { uw_year: 2024, incurred: 0 }, { uw_year: 2025, incurred: 800_000 },
  ];
  const full = { 2021: 20e6, 2022: 20e6, 2023: 20e6, 2024: 20e6, 2025: 20e6 };
  const gap = { 2021: 20e6, 2022: 20e6, 2024: 20e6, 2025: 20e6 };
  const a = calcPureBurningCost(losses, 1e6, 3e6, 20e6, 5, full);
  const b = calcPureBurningCost(losses, 1e6, 3e6, 20e6, 5, gap);
  console.log(`all five EGNPI rows: ROL ${(a.rol * 100).toFixed(2)}%   2023 EGNPI row missing: ROL ${(b.rol * 100).toFixed(2)}% — the 3,000,000 layer loss vanishes.`);
}

console.log('\n[F-E] exposureCurve.js module header contradicts deductibleCredit()');
{
  const G = mbbefdCurve(3.6693, 30.5694);
  const mpl = 1e6; const d = 2e5;
  console.log(`G(d/MPL) = ${G(d / mpl).toFixed(4)}; deductibleCredit() returns ${deductibleCredit({ mpl, deductible: d, G }).toFixed(4)}; the header says the credit is 1 − G(d/MPL) = ${(1 - G(d / mpl)).toFixed(4)}.`);
}

console.log('\n[F-F] calcKS compares a truncated sample against an UNCONDITIONAL lognormal CDF');
{
  const mu = Math.log(1e5); const sg = 1.0; const xm = 2e5;
  const sample = exactSample((p) => Math.exp(mu + sg * invNormCdf(p)), 4000);
  const trueParams = calcKS(sample, (x) => lognormalCDF(x, mu, sg), xm);
  const fit = fitLognormal(sample, xm);
  console.log(`exact lognormal sample, true parameters: calcKS D = ${trueParams.ks.toFixed(4)} (p = ${trueParams.pValue.toFixed(4)}) — a perfect model is rejected.`);
  console.log(`fitLognormal on the tail above ${xm.toLocaleString()}: μ = ${fit.mu.toFixed(3)} (true ${mu.toFixed(3)}), σ = ${fit.sigma.toFixed(3)} (true ${sg.toFixed(3)}) — untruncated MLE on truncated data.`);
}

// ── result ─────────────────────────────────────────────────────────────────
hr('Result');
console.log(`${passed} identities verified, ${failures.length} failed.`);
if (failures.length) {
  failures.forEach((f) => console.log(`  FAIL ${f}`));
  process.exitCode = 1;
} else {
  console.log('Overall: EVERY ASSERTED IDENTITY HOLDS (open findings above are reported, not asserted).');
}
