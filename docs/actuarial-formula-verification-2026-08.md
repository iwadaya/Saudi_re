# Actuarial formula verification — August 2026

Scope: every aggregating and general actuarial formula in the codebase, checked
against published sources and, where the claim is a mathematical identity,
against an independent numerical computation.

This pass **changed no pricing math**. It changed six code comments that stated
a formula the code does not implement (listed under *Documentation corrected*),
and added a verification CLI. Everything else is a finding for the actuarial
sign-off queue in `docs/pricing-signoff-required.md`.

- Reproduce the numeric checks: `node test/verifyActuarialFormulas.mjs`
  (52 identities; exits non-zero on any failure).
- Reserving side: `node test/verifyChainLadderRAA.mjs` and
  `node test/verifyBornhuetterFergusonRAA.mjs`.
- Prior flag-only pass: `docs/actuarial-audit.md` (2026-05-01). This one
  supersedes it where the two overlap, and adds external sourcing plus a
  numerical basis for each verdict.

---

## 1. How each formula was checked

Three levels of evidence, strongest first.

**Identity against numerical integration.** Every limited expected value and
layer mean in the codebase is, by definition, `∫ over the layer of P(X > x) dx`.
Simpson's rule on the survival function is an independent computation that
shares no algebra with the module under test. Agreement to ~1e-6 or better
means the closed form is right, and depends on nobody's judgement.

**Estimator against an exact sample.** A fitting routine is fed a deterministic
sample drawn from the distribution it claims to fit, with known parameters, and
has to return those parameters.

**Benchmark dataset.** Chain ladder and Bornhuetter-Ferguson run against the RAA
triangle, the standard benchmark carried by the R `ChainLadder` package.

---

## 2. Verified correct

Each row: what the code implements, the source it matches, and how it was
confirmed.

### 2.1 Aggregate / stop loss / aggregate XL

| Formula | Source | Evidence |
| --- | --- | --- |
| `layerHit = max(0, min(x − D, L))` | Standard XL cession | Definitional |
| `annualiseLoss = totalLoss / totalYears`, zero-loss years in the denominator | Clark, *Basics of Reinsurance Pricing*, experience rating | Documented in-file; `burningCostStopLoss` and `burningCostLossCost` both pass the full window |
| `E[S] = λ·E[X]`, `Var[S] = λ·E[X²]` (compound Poisson) | Collective risk model; reconciles with `Var[S] = E[N]Var(X) + Var(N)E[X]²` at `E[N] = Var(N) = λ` | Both identities checked numerically |
| `E[(S−K)⁺] = (μ−K)Φ(z) + σφ(z)`, `z = (μ−K)/σ` | Normal stop-loss premium | Matches `∫_K^∞ P(S > x)dx` to 5e-8 |
| `E[layer] = π(D) − π(D+L)` | Same | Matches `∫_D^{D+L} S(x)dx` to 3e-7 |
| `attachmentFromLossRatio = (LR%/100)·EPI` | Stop-loss quoting convention | Definitional |
| Lognormal `σ² = ln(1+CV²)`, `μ = ln(mean) − σ²/2`; `E[X²] = e^{2μ+2σ²}` | Standard | Round-trips mean and CV exactly |
| Single-parameter Pareto `E[X] = αθ/(α−1)`, `E[X²] = αθ²/(α−2)`, `∞` outside the domain | Standard; the infinite-moment guard is the right behaviour | Closed form checked |
| Aggregate XL total cover `limit × (1 + reinstatements)`, capped at the aggregate limit | XL slip convention | Definitional |
| Reinstatement premium `= premium × pct × (fraction of limit reinstated) × (unexpired fraction)`, neither pro-rata switch assumed | XL slip convention | `shared/fac/layers.js`; the sequential burn-through in `pricingReducer.ts` charges the same per unit reinstated |

### 2.2 Severity distributions and layer costs

| Formula | Source | Evidence |
| --- | --- | --- |
| Pareto LEV `E[min(X,c)] = (xmα/(α−1))(1−(xm/c)^{α−1}) + c(xm/c)^α`, and `xm(1+ln(c/xm))` at α=1 | Standard Pareto Type I | Both branches match `∫_0^c S(x)dx` to 1e-14 |
| `E[layer per year] = (n/years)·(LEV(D+L) − LEV(D))` | Frequency × conditional layer severity | Matches `(n/years)·∫_D^{D+L}S` |
| `P(X > D) = (xm/D)^α` | Pareto survival | Exact |
| Pareto MLE `α̂ = n / Σ ln(xᵢ/xm)` | Hill / thresholded MLE | Recovers α on a Pareto sample |
| GPD survival, quantile, and `∫_a^b S(y)dy = (σ/(ξ−1))[(1+ξy/σ)^{(ξ−1)/ξ}]_a^b`, with the ξ→0 and ξ→1 limits and the finite ξ<0 support | Extreme-value theory | Matches numerical integral to 1e-14, all three branches |
| GPD PWM fit `k = a₀/(a₀−2a₁) − 2`, `σ = 2a₀a₁/(a₀−2a₁)`, `ξ = −k`, unbiased weights `(n−r)/(n−1)` | Hosking & Wallis (1987), *Technometrics* 29(3) 339–349 | Recovers (ξ,σ) at ξ = −0.2, ~0, 0.3, 0.6 |
| Lognormal LEV `e^{μ+σ²/2}Φ((ln c−μ−σ²)/σ) + c(1−Φ((ln c−μ)/σ))` | Standard | Matches numerical integral |
| Weibull MLE by Newton-Raphson on the shape; `λ = (Σxᵏ/n)^{1/k}` | Standard | Recovers k and λ to 2e-5 |
| Return period `RP(x) = 1/(λ·P(X > x))` | Standard | Exact |
| `E[layer] = ∫_D^{D+L} S(x)dx` by trapezoid for non-analytic families | Standard | Matches Simpson to 3e-7 |
| Mean-excess plot `e(u) = mean(X − u | X > u)` | EVT threshold diagnostic | Definitional |
| `erf` (Abramowitz & Stegun 7.1.26), `Φ⁻¹` (Acklam) | Published approximations | Within the published error bounds (|erf error| < 1.5e-7) |

### 2.3 Exposure rating and ILFs

| Formula | Source | Evidence |
| --- | --- | --- |
| `E[loss to (D, D+L]] = (expected ground-up loss) × [G((D+L)/MPL) − G(D/MPL)]` in `shared/fac/methods/exposureCurve.js` | Swiss Re *Exposure rating* brochure; Bernegger (1997) | Correct basis — the ground-up **expected loss**, not the MPL. Contrast finding F-B |
| MBBEFD `G(x) = ln(((g−1)b + (1−bg)b^x)/(1−b))/ln(bg)` plus the `b=0/g=1`, `b=1` and `bg=1` cases | Bernegger, S. (1997), "The Swiss Re Exposure Curves and the MBBEFD Distribution Class", *ASTIN Bulletin* 27(1) 99–111 | All branches match the published closed forms; continuous as b→1; G(0)=0, G(1)=1, monotone and concave over 1000 points |
| Riebesell power ILF `ILF(L) = (L/B)^α`, `α = log₂(1+r)` | Riebesell (1936); Mata, *Casualty Excess Pricing Using Power Curves*, CARe 2009; Venter & Pagliaccio (2005) | Doubling the limit multiplies the ILF by exactly (1+r) |
| `E[L xs D] = BasicLimitLossCost × [ILF(D+L) − ILF(D)]` | Standard increased-limits arithmetic | Exact |
| HAZUS `P[exactly DS] = P[≥DS] − P[≥next DS]`, `MDR = Σ P[exactly DS]·DR_DS`, lognormal fragility `Φ(ln(im/median)/β)` | FEMA HAZUS Technical Manual convolution of fragility with damage ratios | Structure matches; the non-increasing clamp is a sound guard |
| GEM vulnerability read by linear interpolation in the IML, clamped at both ends | OpenQuake vulnerability-function convention | Matches |

### 2.4 Blending, credibility, technical premium

| Formula | Source | Evidence |
| --- | --- | --- |
| `Z = n/(n+k)`, capped per family | Bühlmann credibility | Z = ½ at n = k; see the naming note in *Documentation corrected* |
| `LossCost = Z·Experience + (1−Z)·Exposure`, complement split across available exposure methods, unavailable methods carry no weight | Standard credibility weighting | Deliberate departure from the textbook grand-mean complement; documented in-file |
| Technical build-up: `blend + cat load + additive → + θ·σ risk load → + internal expense → ÷ (1 − comm − brok − tax − margin)` | Standard-deviation premium principle plus a single expense gross-up | Gross-up happens once; verified by inspection and the family golden masters |
| `deriveComponentTotal = (Σ wᵢrᵢ / Σ wᵢ) / (1 − loading/100)` | Weighted blend + gross-up | Exact; server verifier re-derives with the same function and the same parser |
| On-level factor `adjusted(y) = original(y) × Π_{i>y}(1 + rᵢ/100)`, latest year = 1.0 | Current-rate-level adjustment | Matches the stated convention exactly |
| Sample s.d. with the `n−1` divisor for the θ·σ load; percentile by linear interpolation (Excel `PERCENTILE.INC` / R type 7) | Standard | Exact |
| Premium-weighted margin roll-ups, limit-weighted ROL roll-ups | Definitional | `Σ(limit·rol·margin)/Σ(limit·rol)` and `Σpremium/Σlimit` are correctly weighted |
| Proportional treaty: sliding-scale commission, profit commission `pct × (premium − capped claims − commission − management expenses)` with FIFO loss carry-forward, banded loss participation | Standard proportional treaty terms | Verified by inspection |
| Project period factor `1 + perMonth × (months − baseline)`; S-curve earning `3t² − 2t³` | Market convention; smoothstep chosen as a shape, stated as such | Definitional |

### 2.5 Reserving

Chain ladder, Bornhuetter-Ferguson and Munich Chain Ladder.

| Formula | Source | Evidence |
| --- | --- | --- |
| Volume-weighted LDF `f_j = ΣC_{i,j+1}/ΣC_{i,j}`; CDF as the backward product; `ultimate = latest × CDF` | Mack (1993) | RAA benchmark: all nine LDFs, all ten CDFs and every accident-year ultimate match to 5e-5; **total IBNR 52,135**, the published `ChainLadder` figure |
| BF `ultimate = latest + a-priori × (1 − 1/CDF)` | Bornhuetter & Ferguson (1972) | RAA benchmark: every field matches to 1e-6 |
| MCL: paid/incurred Pearson residuals `(F − f)√C/σ`, ratio residuals `(Q − q̄)√I/σ_Q`, `λ = Σ res_f·res_Q / Σ res_Q²`, adjusted factor `f + λ(σ_f/σ_Q)(Q_cur − q̄)` | Quarg & Mack (2004), *Munich Chain Ladder* | Structure matches the published estimator, including the volume-weighted `q̄ = ΣP/ΣI` and the single global λ per direction |

---

## 3. Findings

Severity is the effect on a price, not on the elegance of the code. None of
these were changed: pricing math in this repo needs credentialed sign-off
(`docs/pricing-signoff-required.md`).

### F-A — HIGH — `SWISS_RE_C` does not match the published Swiss Re Y curves

`client/src/utils/npPricingEngine.js` (duplicated in
`client/src/screens/proportional/pricing/components/propPricingConstants.js`).

Two separate problems.

1. **Wrong curve family.** `mbbefdG(d,c) = ln(1 + (e^c − 1)d)/c` is Bernegger's
   `b = 1` special case with `g = e^c` — one of the four MBBEFD branches, not
   the general two-parameter curve. The published Swiss Re curves have
   `b = exp(3.1 − 0.15c(1+c))` and `g = exp((0.78 + 0.12c)c)`; at c = 1.5 that
   is b ≈ 12.6, nowhere near 1. So the code is on a different curve family
   whatever c is set to.
2. **Wrong constants.** The code maps `{Y1: 0, Y2: 1.5, Y3: 3.0, Y4: 5.0}`.
   The published family is c = 1.5, 2, 3, 4.

Y1 at c = 0 collapses to `G(x) = x`, the uniform destruction rate — a curve
that asserts nothing about severity and allocates a high layer its full
proportional share of the MPL. For personal-lines-sized risks, which is what
Y1 is for, that materially over-states high-layer exposure:

| curve | code G(0.1)/G(0.3)/G(0.5) | Bernegger G(0.1)/G(0.3)/G(0.5) |
| --- | --- | --- |
| Y1 | 0.1000 / 0.3000 / 0.5000 | 0.2093 / 0.4559 / 0.6349 |
| Y2 | 0.1992 / 0.4768 / 0.6722 | 0.2667 / 0.5174 / 0.6828 |
| Y3 | 0.3559 / 0.6353 / 0.7851 | 0.4056 / 0.6437 / 0.7769 |
| Y4 | 0.5513 / 0.7623 / 0.8627 | 0.5537 / 0.7617 / 0.8614 |

Y3 and Y4 land close by coincidence; Y1 and Y2 do not.

`shared/fac/methods/exposureCurve.js` already implements Bernegger correctly and
deliberately refuses to guess the (b,g) mapping. The fix is to point the treaty
engine at the same implementation and load (b,g) — or c and the two published
formulas — as reference data.

Was flagged directionally in `docs/actuarial-audit.md`; this pass confirms the
specific mismatch against the published parameterisation.

### F-B — HIGH — Risk-XL exposure rating allocates the PML, not the expected loss

`calcRiskExposureRating` → `mbbefdLayerLEV` in `npPricingEngine.js`.

The exposure curve gives the *share of the expected ground-up loss* below a
damage ratio. The layer cost is therefore `(band expected loss) × ΔG`, where the
band's expected loss is its premium times the expected loss ratio — that is the
Swiss Re brochure's own step. `mbbefdLayerLEV` uses `PML × ΔG` instead, i.e. it
treats the maximum possible loss as if it were the expected loss.

100 risks of 1m SI at 100% PML, layer 500k xs 250k, gross loss ratio 55%:

```
expected layer loss  17,890,867   on a limit of 500,000   → ROL 3,578%
```

The result feeds the `exposureRating` component of the layer blend, so it is on
the live pricing path. In practice the exposure weight is usually small and the
number is visibly absurd, which is probably why it has survived — but any
non-zero exposure weight moves the price by orders of magnitude.

Note that `calcRiskExposureRating` receives `egnpi` and uses it only as a
non-zero gate; the premium base the correct formula needs is already in hand.

### F-C — HIGH — `FREQ_SEVERITY` multiplies a full claim count by a large-loss severity

`shared/fac/methods/freqSeverity.js`.

Frequency uses the **declared** claim count from the experience basis; severity
averages the **loss listing**. Both choices are individually defensible and the
module explains why. Multiplying them is not: `lossCost = frequency × severity ×
units` then scales the listing's total by `declaredCount / listingCount`,
which assumes every unlisted attritional claim is the size of a large loss.

Motor fleet, 1,000 vehicle-years a year for five years, 2,500 claims declared, 5
large losses listed, layer 1m xs 250k:

```
engine loss cost   220,000,000   vs observed annual layer loss   440,000   →  500×
```

The module already emits a warning that the two are measured on different
populations. The warning is right; the multiplication is the bug. In a layer the
correct frequency is the rate of claims that *pierce the attachment*, which the
listing does give.

### F-D — HIGH — Pure burning cost silently drops a loss year with no EGNPI row

`calcPureBurningCost` in `npPricingEngine.js`, per-year EGNPI branch.

The per-year loop only accumulates `layerLoss / EGNPI` for years where
`EGNPI > 0`. A year present in the loss data but absent from the premiums table
contributes nothing to the numerator, while still counting in `obsYears` in the
denominator. The layer loss for that year disappears.

Five years, one 4m loss in 2023, layer 3m xs 1m, EGNPI 20m every year:

```
all five EGNPI rows      ROL 23.33%
2023 EGNPI row missing   ROL  3.33%     ← the 3,000,000 layer loss vanishes
```

This fails silently and in the under-pricing direction. It needs, at minimum, a
warning; better, fall back to the prospective EGNPI for the missing year, or
refuse to price until the premium history is complete.

### F-E — MEDIUM — Gross loss ratio compounds across risk profiles

`calcRiskExposureRating`: `totalExpLoss *= grossLossRatio` sits inside the
per-profile loop and multiplies the running total, so profile 1's contribution
is multiplied by profile 2's loss ratio as well. Two identical profiles at 55%
give 0.775× the correct doubled figure. Previously flagged in
`docs/actuarial-audit.md`; confirmed numerically here. One line: accumulate the
profile's own contribution, scale it, then add.

### F-F — MEDIUM — Lognormal goodness-of-fit is measured on the wrong scale

`client/src/screens/shared/loss_pareto/math/distributions.js`.

`calcKS` builds an empirical CDF running 0→1 over the sample **above** `xm`, so
the fitted CDF must be conditional on `x ≥ xm`. Pareto, exponential and Weibull
are (their CDFs are zero at `xm` by construction). `lognormalCDF` is the plain
unconditional lognormal. On top of that, `fitLognormal` takes the untruncated
MLE of a truncated sample.

**Status (2026-09):** the scoring-basis half is fixed — `distributions.js` now
exports `conditionalCDF()` and `fitAll` wraps the lognormal with it before
ranking, so all four families are scored against the same conditional
empirical CDF. The untruncated-MLE approximation in `fitLognormal` remains.

Given an exact lognormal(μ = ln 100,000, σ = 1) sample and a 200,000 threshold:

```
true parameters, calcKS D = 0.7561, p ≈ 0   ← a perfect model is rejected outright
fitLognormal on the tail  μ = 12.798 (true 11.513),  σ = 0.488 (true 1.000)
```

The two errors partly cancel with the fitted parameters, which is why this has
not been obvious — but the reported D is not a valid statistic either way, and
`fitAll` uses it to rank distributions. The fix is the conditional CDF
`(F(x) − F(xm))/(1 − F(xm))` — which `ksStatistic` in `paretoMonteCarlo.js`
already does correctly — and a truncated MLE for the fit.

Two smaller notes in the same function: the p-value uses only the first term of
the Kolmogorov series `Q(z) = 2Σ(−1)^{j−1}e^{−2j²z²}` (conservative, and
standard as a first-order approximation); and Stephens' `z = (√n + 0.12 +
0.11/√n)·D` is correctly applied.

### F-G — MEDIUM — Historical margin averages over loss years only

`applyHistoricalMargins` in
`client/src/screens/non_proportional/final_pricing/state/pricingReducer.ts`.

`years` is the key set of the loss map, so a year with no losses never appears.
Both `avgLoss` and `avgIncome` divide by that count, but income is roughly
constant per year while losses are not — so the loss ratio is inflated by
`totalYears / lossYears` and the reported margin is understated. This is the
exact bias `annualiseLoss`'s own documentation warns about, applied in the
opposite (conservative) direction. The observation window should come from the
premium/exposure history, not from the losses.

### F-H — MEDIUM — Two different combined risk+cat ROLs coexist

`client/src/screens/non_proportional/final_pricing/fqQuoteMath.js`.

`layerCombinedPricing` returns `riskRol + catRol` — correct, since both are
expressed against the same limit. `quoteComponentSummary` instead sums the three
component rates and re-blends them with the *average* of the per-component
weights and loadings. The two agree only when risk and cat carry identical
weights and loading; otherwise the row's Total ROL and the structure's combined
pricing disagree. The in-file comment explains the choice as a display-consistency
trade-off, which is reasonable — but the two numbers should not both be called
the combined ROL.

### F-I — LOW — Heavy-tailed Pareto reports the Normal approximation as valid

`exposureRatingStopLoss` in `client/src/logic/stopLossPricing.js`. At α ≤ 1 the
severity mean is infinite, `compoundPoissonMoments` returns `{0, 0, 0}`, and
`normalApproxValid` is then computed as `Number.isFinite(0)` → `true`, with an
annual loss of 0. A warning is raised, but the structured flag says the opposite
of what happened. At 1 < α ≤ 2 the flag is correctly `false`.

### F-J — LOW — Cat exposure rating is three heuristics behind one method name

`calcCatExposureRating`. Method 1 integrates trapezoids over an OEP curve whose
RP5 / RP25 / RP100 / RP200 / RP500 points are synthesised by fixed multipliers
(`rp10 × 0.4`, `rp50 × 1.5`, `rp100 × 1.4`, `rp200 × 1.5`) when not supplied.
Method 3 is an explicit flat 15% loss-ratio seed. The trapezoid rule over
`(1/rp)` against layer hit is a sound estimator of the annual expected layer loss
*given* the curve; the invented anchor points are not sourced. The code labels
method 3 honestly (`flat_loss_ratio_fallback`); the synthesised RP points in
method 1 deserve the same explicit labelling, since `method: 'rp_curve'` reads as
a real curve.

### F-K — LOW — Threshold and observation-window defaults are uncited

- `xm` = the 25th percentile of the selected losses (`calcParetoROL`,
  `calcCatExposureRating`). A threshold that keeps 75% of the body in a
  tail fit biases α upward. The mean-excess plot needed to defend a
  threshold already exists in `paretoMonteCarlo.buildMeanExcess` but does not
  drive this default.
- `years = max(5, distinct loss years)` and the saved defaults `n = 10`,
  `years = 10`. A floor on the observation window silently reduces the modelled
  frequency when the real window is shorter.
- `BAND_CURVE_THRESHOLDS` (400k / 1m / 2m) are described as Swiss Re CHF values
  "scaled generously", with no FX basis or date.
- `DEFAULT_DEVELOPMENT_FACTOR = 1.15` for open claims and
  `DEFAULT_CREDIBILITY = {k: 8, maxZ: 0.75}` are reasonable working defaults but
  carry no source. Both are overridable, and the fac pipeline surfaces them.
- `straightProjections.LDF_CONFIG` is explicitly flagged `IS_BENCHMARK_LDF =
  true` with `reviewed: null` on every entry — correctly handled already.

### F-L — LOW — Pareto layer cost ignores the band below the fit threshold

`paretoLayerExpectedLoss` sets `D = max(deductible, xm)` and then takes the top
of the layer as `D + limit`. When the attachment sits below the fit threshold,
the layer both loses the `deductible → xm` slice and silently shifts its ceiling
up by `xm − deductible`. Conservative in one direction and not in the other; the
in-file note says the sub-threshold contribution is handled separately, but
nothing enforces that.

---

## 4. Documentation corrected in this pass

No numeric behaviour changed.

1. `shared/fac/methods/exposureCurve.js` — the header said the deductible credit
   is `1 − G(d/MPL)`. The cedant keeps `G(d/MPL)`, which is what
   `deductibleCredit()` returns; the complement is the insurer's share. Header
   now matches the function.
2. `client/src/utils/npPricingEngine.js` — the burning-cost step list still said
   `ROL = avgAnnualLayerLoss / limit` without the prospective-EGNPI step that the
   body performs and documents further down.
3. `client/src/utils/npPricingEngine.js` — `paretoQ`'s doc called `p` an
   exceedance probability; it is a CDF probability, so the 1-in-N loss is
   `paretoQ(1 − 1/N, …)`. Getting this backwards inverts the return period.
4. `client/src/logic/stopLossPricing.js` — the large-λ Poisson branch claimed a
   continuity correction it does not apply.
5. `shared/fac/credibility.js` — `Z = n/(n+k)` is Bühlmann; Bühlmann–Straub
   weights each year by its own exposure. Noted that the two coincide for a
   single pooled volume.
6. `client/src/screens/shared/loss_pareto/math/distributions.js` — the comment
   claimed all four PDFs are conditional on `x ≥ xm`. Three are; the lognormal is
   not. Added the caveat on `calcKS` (finding F-F).

---

## 5. Sources

- Bernegger, S. (1997). "The Swiss Re Exposure Curves and the MBBEFD Distribution
  Class." *ASTIN Bulletin* 27(1), 99–111. —
  [CAS abstract](https://www.casact.org/abstract/swiss-re-exposure-curves-and-mbbefd-distribution-class),
  [Cambridge Core PDF](https://www.cambridge.org/core/services/aop-cambridge-core/content/view/0360BFFA7640908DC177687523164485/S0515036100011910a.pdf/the-swiss-re-exposure-curves-and-the-mbbefd-distribution-class1.pdf)
- Swiss Re curve parameterisation `b = exp(3.1 − 0.15c(1+c))`,
  `g = exp((0.78 + 0.12c)c)`, curves Y1–Y4 at c = 1.5, 2, 3, 4 — R package
  `mbbefd`, `swissRe()`:
  [CRAN reference manual](https://cran.r-project.org/web/packages/mbbefd/mbbefd.pdf),
  [rdrr.io](https://rdrr.io/cran/mbbefd/man/swissRe.html)
- Swiss Re. *Exposure rating* (Property technical publishing brochure). —
  [swissre.com](https://www.swissre.com/dam/jcr:7137dac0-83a6-4cfa-80a4-93d33c35562f/exposure-rating-brochure.pdf)
- Ludwig, S. (with the property per-risk exposure-rating literature):
  "Experience and Exposure Rating for Property Per Risk Excess of Loss
  Reinsurance Revisited," *ASTIN Bulletin*. —
  [Cambridge Core](https://www.cambridge.org/core/journals/astin-bulletin-journal-of-the-iaa/article/abs/experience-and-exposure-rating-for-property-per-risk-excess-of-loss-reinsurance-revisited/2F1A730DD0C9798A211A354C41B7F45D)
- Riebesell, P. (1936), power-curve ILFs. See Mata, A., "Casualty Excess Pricing
  Using Power Curves," CARe 2009; Venter, G. & Pagliaccio, "Distributions
  Underlying Power Function ILFs (Riebesell Revisited)" (2005) —
  [PDF](http://www.garyventer.com/wp-content/uploads/2018/09/Venter-Pagliaccio-2005-Distributions-Underlying-Power-Function-ILF-%E2%80%99-s-Riebesell-Revisited-.pdf);
  Riegel, U., "Generalizations of common ILF models," *Blätter der DGVFM* —
  [Springer](https://link.springer.com/article/10.1007/s11857-008-0045-3)
- Clark, D. R. *Basics of Reinsurance Pricing* (CAS study note, 2014 revision). —
  [CAS](https://www.casact.org/sites/default/files/old/studynotes_clark_2014.pdf)
- Hosking, J. R. M. & Wallis, J. R. (1987). "Parameter and Quantile Estimation
  for the Generalized Pareto Distribution." *Technometrics* 29(3), 339–349. —
  [Taylor & Francis](https://www.tandfonline.com/doi/abs/10.1080/00401706.1987.10488243)
- Quarg, G. & Mack, T. (2004). "Munich Chain Ladder." *Blätter der DGVFM*. —
  [Springer](https://link.springer.com/article/10.1007/BF02808969),
  [CAS abstract](https://www.casact.org/abstract/munich-chain-ladder-claims-reserving-technique-closes-gap-between-paid-and-incurred-based);
  estimator layout cross-checked against the R `ChainLadder` package —
  [MunichChainLadder reference](https://mages.github.io/ChainLadder/reference/MunichChainLadder.html)
- Bornhuetter, R. L. & Ferguson, R. E. (1972). "The Actuary and IBNR." *PCAS* LIX.
- Mack, T. (1993). "Distribution-free Calculation of the Standard Error of Chain
  Ladder Reserve Estimates." *ASTIN Bulletin* 23(2). RAA benchmark triangle and
  the 52,135 total-IBNR figure via the R `ChainLadder` package —
  [vignette](https://mages.github.io/ChainLadder/articles/ChainLadder.html)
- Bühlmann credibility `Z = n/(n+k)` and the Bühlmann–Straub exposure-weighted
  extension — Korn, U., "Credibility for Pricing Loss Ratios and Loss Costs,"
  *CAS E-Forum* (2015) —
  [CAS](https://www.casact.org/sites/default/files/database/forum_15fforum_korn.pdf);
  *Loss Data Analytics*, ch. 9 —
  [openacttexts](https://openacttexts.github.io/Loss-Data-Analytics/ChapCredibility.html)
- Compound-Poisson aggregate moments and the Normal approximation —
  *Loss Data Analytics*, ch. 5 —
  [openacttexts](https://openacttexts.github.io/Loss-Data-Analytics/ChapAggLossModels.html)
- Abramowitz, M. & Stegun, I. A. (1964). *Handbook of Mathematical Functions*,
  7.1.26 (erf). Acklam's inverse-normal rational approximation.
- FEMA. *HAZUS Earthquake Model Technical Manual* — fragility curves and
  per-occupancy damage ratios.

Note: this pass ran in an environment where direct page fetches are blocked by
the network egress proxy, so the sources above were located and their content
confirmed through search rather than by retrieving each PDF. Every formula
attributed to a source was **independently confirmed numerically** by
`test/verifyActuarialFormulas.mjs`; the citations record provenance, not the
proof.
