# Actuarial Math Audit

Audit date: 2026-05-01

Scope requested:

- `shared/pricingMath.js`
- `server/src/lib/pricingVerifier.js`
- `client/src/utils/npPricingEngine.js`

Additional actuarial code reviewed because it implements formulas named in the request:

- `client/src/logic/chainLadder.js`
- `client/src/logic/bornhuetterFerguson.js`
- `client/src/logic/munichChainLadder.js`
- `client/src/screens/non_proportional/final_pricing/NpFinalPricing.jsx`
- `client/src/screens/non_proportional/final_pricing/formatters.js`
- `client/src/screens/proportional/pricing/components/propPricingConstants.js`
- `client/src/utils/format.js`

This pass is flag-only. No pricing, reserving, curve-fitting, loading, or persistence math was modified.

## Executive Findings

| Severity | Finding | Evidence | Recommendation |
| --- | --- | --- | --- |
| ~~High~~ **Resolved (2026-06-18)** | ~~Server verifier does not parse the same numeric strings as the client.~~ Fixed: the loose-number parser was extracted to `parseLooseNumber` in `shared/pricingMath.js` and is now used by BOTH `deriveComponentTotal` and the server verifier's `toN`, so `"8.00%"`, `"$2,000"`, and `"1,000"` parse identically on both sides instead of being zeroed by `Number(v)` on the server. | `shared/pricingMath.js` (`parseLooseNumber`), `server/src/lib/pricingVerifier.js` (`toN = parseLooseNumber`); covered by `shared/pricingMath.test.js` (parseLooseNumber) and `server/src/lib/pricingVerifier.test.js` ("parses formatted strings … no phantom drift"). | Done — server verifier and client formula now share one parser. Strict-mode (`PRICING_STRICT=1`) drift checks are therefore safe to enforce on formatted fields. |
| High | `deriveComponentTotal` JSDoc says loading >= 100 returns 0, but implementation clamps to 99 and returns a very large finite result. `applyLoading` throws on loading >= 100. | `shared/pricingMath.js:148-156`, `shared/pricingMath.js:180-199` | Credentialed actuary/product owner should choose one legal handling: reject, clamp, or explicit no-quote. |
| High | Quote-mode helper `computeLayerDerived` still uses a legacy formula: denominator fixed at 100 and loading multiplied by `(1 + loading)` instead of grossing up by `1 / (1 - loading)`. | `NpFinalPricing.jsx:137-149` | Remove or align after actuarial review; this is not server-verified. |
| High | The Swiss Re/MBBEFD code is labelled as MBBEFD but implements a one-parameter log curve `G(d,c)`, not the published two-parameter Bernegger MBBEFD class. The Y-curve mapping also differs from common published package references. | `npPricingEngine.js:56-65`, `propPricingConstants.js:57-63` | Add a source comment documenting this exact one-parameter variant, or replace with a sourced MBBEFD implementation after review. |
| Medium | Cat exposure rating is largely heuristic despite comments describing CRESTA damage-rate exposure rating and normal approximation. The implemented method is RP/OEP trapezoids, Pareto fallback, then flat 15% loss-ratio fallback. | `npPricingEngine.js:402-504` | Split methods in the UI/API and require an explicit `method`/source label before saving. |
| Medium | Pareto quantile comment says "exceedance probability p", but implementation uses CDF probability: `xm * (1 - p)^(-1/alpha)`. | `npPricingEngine.js:96-103` | Clarify whether `p` means CDF probability or exceedance probability before any downstream use. |
| Medium | `paretoAttachment` returns 1 for invalid `alpha` or `xm`, conflating invalid fit with 100% attachment. | `npPricingEngine.js:140-152` | Return null/no-estimate or propagate invalid state after actuarial review. |
| Medium | Risk exposure rating applies `grossLossRatio` to cumulative `totalExpLoss` inside the profile loop, so multiple profiles compound prior profiles' ratios. | `npPricingEngine.js:363-396` | Review as likely implementation bug; fix only after actuary sign-off. |
| Medium | Chain ladder, BF, Munich Chain Ladder, IBNR, reinstatement pricing, historical margin, and expected shortfall are client-only. The server persists outputs but does not independently recompute them. | client logic files and final pricing screen | Move core formulas to shared/server verification once formulas are approved. |

## Formula Inventory

### Shared Pricing Primitives

| Formula | Closed-form expression | Implementation | Match |
| --- | --- | --- | --- |
| Layer hit | `hit(x; D, L) = max(0, min(x - D, L))` for finite loss `x`, deductible `D`, limit `L > 0`. | `layerHit(loss, deductible, limit)` returns 0 for non-finite inputs or `limit <= 0`, otherwise `Math.max(0, Math.min(loss - deductible, limit))`. See `shared/pricingMath.js:29-32`. | Matches the stated expression on its finite positive-limit domain. The zero guard is a domain condition. |
| Weighted average | `sum(w_i * v_i) / sum(w_i)` over valid finite `v_i` and positive finite `w_i`. | `weightedAverage(values, weights)` skips non-finite values/weights and weights `<= 0`; returns null when total weight is 0. See `shared/pricingMath.js:44-56`. | Matches a positive-weight weighted mean. Negative weights are silently excluded by design. |
| Annualise loss | `annualLoss = totalLoss / years`. | `annualiseLoss(totalLoss, years)` returns 0 if `years <= 0` or inputs non-finite. See `shared/pricingMath.js:84-86`. | Matches on valid domain; zero fallback can hide a bad observation-window input if upstream validation is absent. |
| ROL from annual loss | `rol = annualLoss / limit`. | `rolFromAnnualLoss(annualLoss, limit)` returns 0 if `limit <= 0` or inputs non-finite. See `shared/pricingMath.js:98-100`. | Matches on valid domain. |
| Premium from ROL | `premium = rol * limit`. | `premiumFromRol(rol, limit)` returns 0 for non-finite inputs. See `shared/pricingMath.js:111-113`. | Matches on valid domain. |
| Clamp | `min(max(n, min), max)`. | `clamp(n, min, max)` preserves non-finite `n`; otherwise clamps. See `shared/pricingMath.js:124-126`. | Matches; deliberate NaN preservation. |
| Pricing loading | `gross = pureRate / (1 - loadingPct / 100)`. | `applyLoading(pureRate, loadingPct)` returns 0 for non-finite `pureRate`, clamps negative loading to 0, throws `RangeError` for loading >= 100. See `shared/pricingMath.js:148-156`. | Matches stated gross-up formula. Domain enforcement is explicit. |
| NP component total | `blended = (wB*b + wP*p + wE*e) / (wB + wP + wE)`, `total = blended / (1 - loading/100)`. | `deriveComponentTotal(...)` parses loose strings, clamps weights to `[0,100]`, returns 0 if total weight <= 0, clamps loading to `[0,99]`, then gross-ups. See `shared/pricingMath.js:182-199`. | Formula matches implementation except documentation says loading >= 100 returns 0; code clamps to 99. This also differs from `applyLoading`, which throws. |

### Server Pricing Verifier

| Formula | Closed-form expression | Implementation | Match |
| --- | --- | --- | --- |
| Weight sum validation | `abs(wB + wP + wE - 100) <= 0.5`. | `weightSum = wBurn + wPareto + wExp`; drift when outside `TOLERANCE_WEIGHT`. See `server/src/lib/pricingVerifier.js:56-59`, `100-111`. | Matches. |
| Total-price tolerance | `abs(actual - expected) <= 0.0002 OR abs(actual - expected)/abs(expected) <= 0.002`. | `withinTolerance(actual, expected)` uses absolute tolerance first, relative tolerance second. See `server/src/lib/pricingVerifier.js:51-72`. | Matches. |
| Server expected total | `deriveComponentTotal(pure, pareto, exposure, weights, loading)`. | Server pre-parses every row field with local `toN = Number(v) || 0`, then calls shared `deriveComponentTotal`. See `server/src/lib/pricingVerifier.js:61-65`, `91-115`. | The formula call matches, but floating-point and parsing behavior do not match the client for formatted strings. |

### Non-Proportional Pricing Engine

| Formula | Closed-form expression | Implementation | Match |
| --- | --- | --- | --- |
| Safe numeric parse | `cn(v) = toN(v)` using flexible parser. | `cn` delegates to `client/src/utils/format.js:235-237`; handles `%`, currency, accounting negatives, and European decimals. See `npPricingEngine.js:39-42`. | Matches helper intent. Differs from server verifier parser. |
| Percent formatting | If `v > 0`, display `(v * 100).toFixed(2) + '%'`; else blank. | `fmtRol` and `fmtPct` return blank for falsy, non-finite, or `<= 0`. See `npPricingEngine.js:44-54`. | Matches display intent, but zeros become blank in some contexts and `0.00%` in others. |
| Swiss Re one-parameter curve | Implemented claim: `G(d,c) = log(1 + (exp(c) - 1) * d) / c`; limit case `c -> 0` is `d`; clamp `d <= 0` to 0 and `d >= 1` to 1. | `mbbefdG(d,c)` exactly implements this expression. See `npPricingEngine.js:56-63`. | Matches the code comment. It does not document the published two-parameter MBBEFD distribution variant. |
| Swiss Re Y curve constants | Code mapping: `{ Y1: 0, Y2: 1.5, Y3: 3.0, Y4: 5.0 }`. | `SWISS_RE_C` in `npPricingEngine.js:64-65`; duplicate in `propPricingConstants.js:57-63`. | Implementation matches itself. Source mismatch risk: published package references commonly map Swiss Re Y curves through MBBEFD `b,g` or use c-values `{1.5,2,3,4}` with c=5 as Lloyd's/industrial reference. |
| MBBEFD/SR layer LEV | `LEV_layer ~= PML * [G(min((D+L)/PML,1), c) - G(min(D/PML,1), c)]`, where `PML = SI * pmlPct/100`. | `mbbefdLayerLEV(si, pmlPct, cValue, deductible, limit)` implements the expression. See `npPricingEngine.js:67-80`. | Matches implemented one-parameter curve. Needs source/variant documentation. |
| Pareto MLE | For Pareto Type I tail with known threshold `xm`, `alpha_hat = n / sum(log(x_i/xm))`, using `x_i >= xm`. | `fitPareto(losses, xm)` filters `l >= xm`, sums `Math.log(x/xm)`, returns `n/s` if `s > 0`, else alpha 0. See `npPricingEngine.js:82-94`. | Matches thresholded MLE/Hill estimator. If all included values equal `xm`, true alpha tends to infinity; code returns 0. |
| Pareto quantile | For CDF probability `p`, `Q(p) = xm * (1 - p)^(-1/alpha)`. For exceedance probability `q`, `Q_exceed(q) = xm * q^(-1/alpha)`. | `paretoQ(p, alpha, xm)` returns `xm * Math.pow(1 - p, -1 / alpha)`. See `npPricingEngine.js:96-103`. | Implementation matches CDF probability, but comment says "exceedance probability p". Semantic mismatch. |
| Pareto LEV | For `cap >= xm` and `alpha != 1`: `E[min(X,cap)] = xm*alpha/(alpha-1)*(1-(xm/cap)^(alpha-1)) + cap*(xm/cap)^alpha`. For `alpha = 1`: `xm*(1 + ln(cap/xm))`. | `paretoLEV(alpha, xm, cap)` implements those branches and returns `cap` when `cap <= xm`. See `npPricingEngine.js:105-124`. | Matches conditional Pareto Type I limited expected value. `cap <= xm` branch is correct for support `X >= xm`, but the comment "losses below xm handled separately" is not enforced by this function. |
| Pareto layer expected loss | `E[layer per year] = (n / years) * (LEV(D+L) - LEV(D))`, with `D = max(deductible, xm)`. | `paretoLayerExpectedLoss(...)` implements exactly that. See `npPricingEngine.js:126-138`. | Matches implemented tail-frequency model. It omits any sub-threshold contribution when `deductible < xm`. |
| Pareto attachment probability | For valid Pareto tail, `P(X > D) = 1` if `D <= xm`, else `(xm/D)^alpha`. | `paretoAttachment(alpha, xm, deductible)` returns 1 if `alpha <= 0 || xm <= 0 || deductible <= xm`; otherwise `(xm/deductible)^alpha`. See `npPricingEngine.js:140-146`. | Matches for `deductible <= xm`, but invalid fit also returns 1. That hides a math error as 100% attachment. |
| Pareto exhaustion probability | `P(X > D+L)` under the same tail model. | `paretoExhaustion(...)` delegates to `paretoAttachment(alpha, xm, deductible + limit)`. See `npPricingEngine.js:148-152`. | Same caveat as attachment. |
| Pure burning cost | For each selected loss, `hit_y = max(0, min(loss - D, L))`; with year EGNPI: `avgLossCost = (sum_y hit_y / EGNPI_y) / obsYears`; `avgAnnualLayerLoss = avgLossCost * prospectiveEGNPI`; returned `rol = avgLossCost`. | `calcPureBurningCost(...)` selects losses, uses inflated incurred else incurred+OS, sums layer hits by year, averages per-year loss cost when EGNPI-by-year exists, falls back to total loss over years over current EGNPI, then returns `rol = avgLossCost`. See `npPricingEngine.js:155-255`. | Implementation matches current code comments at lines 236-250. Older Step 6 comment at line 167 still says `ROL = avgLossCost * (avgEgnpi / limit)`, which no longer matches. |
| Pareto ROL | `ROL = expectedLayerLoss / EGNPI`, using saved `alpha,xm,n,years` or raw fit. | `calcParetoROL(...)` uses saved params if present; otherwise requires at least 3 selected losses, sets `xm` to 25th percentile, fits alpha, sets years to saved value or `max(5, distinct years)`. See `npPricingEngine.js:258-311`. | Arithmetic matches implementation. Threshold choice, minimum 5 years, and saved default `n=10`, `years=10` are heuristics needing citation/approval. |
| Auto curve selection | If average SI <= 400k use Y1; <= 1M use Y2; <= 2M use Y3; else Y4. | `autoCurveForBand(avgSI)` loops `BAND_CURVE_THRESHOLDS`. See `npPricingEngine.js:313-333`. | Matches implementation. Comment says scaled from Swiss Re CHF values but no source or FX basis is documented. |
| Risk XL exposure rating | Per band: `avgSI = totalSI/nRisks`; `LEV = mbbefdLayerLEV(avgSI, pmlPct, c, D, L)`; `totalExpLoss += nRisks * LEV`; `ROL = totalExpLoss / EGNPI`. | `calcRiskExposureRating(...)` implements this, choosing auto/custom curve, defaulting PML% to 100 and gross loss ratio to 100%. See `npPricingEngine.js:335-400`. | Core expression matches. Potential bug: `totalExpLoss *= grossLossRatio` occurs inside the profile loop, compounding ratios across profiles. |
| Cat RP/OEP curve rating | Code approximates annual expected layer loss by trapezoids over return-period points: `sum((1/rp_i - 1/rp_j) * (hit_i + hit_j)/2)`, then `ROL = AEP / EGNPI`. | `calcCatExposureRating(...)` method 1 builds synthetic RP points and integrates layer hit. See `npPricingEngine.js:423-465`. | Matches implementation. Does not match the surrounding CRESTA/normal-approximation comment. Synthetic RP5/RP25/RP100/RP200/RP500 points are heuristics. |
| Cat Pareto fallback | Same Pareto tail method as risk, using cat losses. | `calcCatExposureRating(...)` method 2 repeats 25th-percentile threshold and min-5-years fallback. See `npPricingEngine.js:468-483`. | Matches implementation; same heuristic flags as risk Pareto. |
| Cat flat loss-ratio fallback | `impliedLoss = EGNPI * 0.15`; `ROL = layerHit(impliedLoss, D, L) / (EGNPI * (obsYears || 10))`. | `calcCatExposureRating(...)` method 3. See `npPricingEngine.js:487-500`. | Matches implementation. This is an explicit heuristic, not a real CRESTA exposure rating. |
| OEP interpolation | If loss lies between adjacent points, interpolate return period linearly and return `1 / interpolatedRP`. | `interpOEP(points, loss)` implements this. See `npPricingEngine.js:507-519`. | Matches implementation. Published EP curves usually interpolate probability/loss space deliberately; this variant is undocumented. |
| Layer pricing orchestrator | Component pricing returns formatted burn, Pareto, exposure, attach, exhaust; raw rates retained as underscored fields. | `calcLayerPricing(...)` gathers API data, sets observation years, prices risk/cat components, and formats outputs. See `npPricingEngine.js:591-763`. | No independent formula beyond composing functions above. API fetch failures default to empty data, which can make all formulas return zeros. |

### Chain Ladder, BF, Munich Chain Ladder, IBNR

These are client-only calculations today; no server recomputation was found.

| Formula | Closed-form expression | Implementation | Match |
| --- | --- | --- | --- |
| Age-to-age factors | `f_{i,j} = C_{i,j+1} / C_{i,j}` when both cells exist and denominator is nonzero. | `calculateAgeToAgeFactors(matrix)` pushes `next / cur` else null. See `chainLadder.js:32-40`. | Matches. |
| Chain ladder selected LDF | Weighted method: `f_j = sum_i C_{i,j+1} / sum_i C_{i,j}`. Last3/last5/simple methods: arithmetic mean of selected individual factors. | `calculatePattern(matrix, factors, method)` implements weighted, last3, last5, and simple average; defaults to 1.0 when no denominator/count. See `chainLadder.js:58-92`. | Matches implemented variants. Thin-column warning for fewer than 3 rows is useful but not a formula guard. |
| CDF from LDFs | `CDF_N = tailFactor`; `CDF_j = LDF_j * CDF_{j+1}`. | `calculateCdfs(pattern, tailFactor)` implements backward product. See `chainLadder.js:95-110`. | Matches. |
| Ultimate and IBNR | `ultimate_i = latest_i * CDF_{latestCol}`; `IBNR_i = ultimate_i - latest_i`. | `projectToUltimate(...)` finds latest observed column and applies CDF. See `chainLadder.js:113-137`. | Matches. |
| Exponential CDF smoothing | Fit `ln(CDF_j - 1) = a + b*x_j` by OLS for `CDF_j > 1.0000001`; output `1 + exp(a+b*x_j)`. | `fitExponentialCdfs(cdfs)` implements OLS and returns original CDFs on insufficient points or near-singular denominator. See `chainLadder.js:140-159`. | Matches implementation. This is a heuristic tail/smoothing regression and should cite a specific actuarial tail-factor method if retained. |
| LDFs from CDFs | `LDF_j = CDF_j / CDF_{j+1}`. | `deriveLdfsFromCdfs(cdfs)` returns ratio or null if invalid. See `chainLadder.js:161-168`. | Matches. |
| Bornhuetter-Ferguson ultimate | `aPrioriUltimate = premium * IELR`; `%reported = 1/CDF`; `%unreported = 1 - 1/CDF`; `expectedIBNR = aPrioriUltimate * %unreported`; `BF ultimate = latest + expectedIBNR`; `LR = ultimate/premium`. | `calculateBF(...)` implements exactly this. See `bornhuetterFerguson.js:2-20`. | Matches classic BF formulation. Needs validation of `CDF >= 1`; current fallback `row.cdf || 1.0` can hide invalid low/zero CDF. |
| Premium BF variant | `aPrioriUltimate = EPI * achievedRatio`; `%unachieved = 1 - 1/CDF`; `BF unearned = aPrioriUltimate * %unachieved`; `ultimate = latest + BF unearned`. | `calculateBFPremium(...)` implements this. See `bornhuetterFerguson.js:22-52`. | Matches implementation. This is a premium-development adaptation and needs explicit source/approval. |
| Munich Chain Ladder base patterns | Paid and incurred `f_j = sum C_{j+1}/sum C_j`; CDFs as backward products. | `chainLadderPattern` and `cdfsFromPattern`. See `munichChainLadder.js:38-59`, `102-105`. | Matches standard volume-weighted base. |
| Munich Chain Ladder P/I and I/P means | `qBar_j = sum(P_j)/sum(I_j)`; `qStarBar_j = sum(I_j)/sum(P_j)`. | Implemented in `calculateMunichChainLadder`. See `munichChainLadder.js:107-120`. | Matches implementation. |
| Munich residual variances and lambdas | Uses weighted Pearson residuals for paid/incurred link ratios and P/I, I/P ratios; `lambdaP = sum(fpRes*qsRes)/sum(qsRes^2)`, `lambdaI = sum(fiRes*qRes)/sum(qRes^2)`. | See `munichChainLadder.js:122-186`. | High-level match to Quarg-Mack style MCL. Exact residual weighting variant should be reviewed against the cited paper/package. |
| Munich adjusted projection | `fpAdj = fpBase + lambdaP * (sigmaP/sigmaQStar) * (qStarCur - qStarBar)` and analogously for incurred; project forward multiplicatively. | See `munichChainLadder.js:216-258`. | Matches implementation. Non-finite or nonpositive adjusted factors fall back to base factors. |

### Final Pricing, Reinstatements, Margins, Expected Shortfall

| Formula | Closed-form expression | Implementation | Match |
| --- | --- | --- | --- |
| Quote-mode layer derived total | Legacy helper: `wE = max(0, 100 - wB - wP)`; `blended = (wB*burn + wP*pareto + wE*exposure)/100`; `total = blended * (1 + loading/100)`. | `computeLayerDerived(l)` in `NpFinalPricing.jsx:137-149`. | Matches implementation but conflicts with canonical `deriveComponentTotal`, which divides by total selected weight and uses gross-up loading. |
| Component total in final pricing table | Canonical `deriveComponentTotal(...)` from shared math. | Imported via `formatters.js:94-98` and used for risk/cat recalculation in `NpFinalPricing.jsx:838-866`. | Matches shared implementation. |
| Combined UW price | If both risk and cat active, `riskUW + catUW`; else active component only; else 0. | `deriveCombinedUwPrice(l)` in `formatters.js:78-91`; used in `NpFinalPricing.jsx:869-874`. | Matches. |
| Expiring layer interpolation | Direct known layer ROL; below first use first, above last use last, between known points linear interpolate by layer index. | `computeExpiringFor(...)` in `NpFinalPricing.jsx:727-745`. | Matches implementation. Heuristic; not actuarial source-based. |
| Historical margin with reinstatements | For each year: `basePremium = pricingPct/100 * limit`; capacity `= limit*(1+nReinst)`; sequentially consume layer hits up to remaining capacity; paid reinstatement premium `+= (reinstUsed/limit) * reinstPct * basePremium`; margin `= 100 - avgLoss/avgIncome*100 - brokerage - taxes`. | `NpFinalPricing.jsx:895-1000`. | Matches implementation. It is an empirical burn-through model, not a stochastic reinstatement pricing model; no pro-rata-as-to-time handling found. |
| Technical ratio | Delegated helper `calcTechRatio(historicalMargin, brokerage, taxes)`. | Called in `NpFinalPricing.jsx:771-777`, `876-885`, `1005-1016`; helper not audited in depth because not in requested files. | Formula should be separately reviewed if used for approval. |
| Programme premium by share | `premium = round(totalEP * sharePct/100)`. | `rowCalc` in `NpFinalPricing.jsx:2216-2254`. | Matches. |
| Per-risk/cat/cedant total limits by share | `round(totalLimit * sharePct/100)`. | `rowCalc` in `NpFinalPricing.jsx:2226-2237`. | Matches. |
| Annual aggregate limit | If explicit aggregate limit exists, `round(structAAL * share)` else `round(limit * (1 + nReinst) * share)`. | `rowCalc` in `NpFinalPricing.jsx:2239-2246`. | Matches. |
| Expected shortfall display | `ES = round(limit * ROL%/100 * (1 + 0.5*nReinst) * share)`. | `rowCalc` in `NpFinalPricing.jsx:2248-2252`. | Matches implementation. The "50% chance of using reinstatements" assumption is heuristic and uncited. |
| Proportional duplicate MBBEFD/Pareto helpers | Same `mbbefdG`, `SWISS_RE_C`, `fitPareto`, and `paretoQ` as NP engine. | `propPricingConstants.js:57-75`. | Numerically identical for tested inputs. Duplicated code should move to shared pricing math once variant is approved. |

## Duplicate Calculations and Floating-Point Comparison

Harness used:

- Imported client/shared `deriveComponentTotal`.
- Recreated server verifier pre-parse behavior from `pricingVerifier.js`. The
  divergences in the table below were the original audit finding; as of
  2026-06-18 the server verifier shares the client/shared `parseLooseNumber`,
  so the "server zeros formatted strings" rows are now historical — both sides
  produce the "Client/shared output" column.
- Compared duplicated NP/Prop `mbbefdG`, `fitPareto`, and `paretoQ`.
- Compared legacy quote helper formula to canonical shared formula.

| Calculation | Input | Client/shared output | Server/duplicate output | Max divergence | Notes |
| --- | --- | ---: | ---: | ---: | --- |
| `deriveComponentTotal` | numeric rates: burn 0.03, pareto 0.01, exposure 0.05, weights 40/20/40, loading 20 | 0.0425 | 0.0425 | 0 | Same formula and numeric parse. |
| `deriveComponentTotal` | percent strings: `"10.00%"`, `"2.00%"`, `"5.00%"`, weights `"40/20/40"`, loading `"20"` | 8 | ~~0~~ → **8** | ~~8~~ → **0** | FIXED 2026-06-18: server now uses `parseLooseNumber` and strips `%`; both sides return 8. |
| `deriveComponentTotal` | comma/currency strings: `"1,000"`, `"$2,000"`, `"3,000"`, weights 25/25/50, loading 10 | 2500 | ~~0~~ → **2500** | ~~2500~~ → **0** | FIXED 2026-06-18: server shares the client parser; symbols stripped on both sides. |
| `deriveComponentTotal` | European decimal `"1.234,56"`, weight 100 | 1.23456 | ~~0~~ → **1.23456** | ~~1.23456~~ → **0** | FIXED 2026-06-18: server parses identically. (Shared parser strips non-numeric chars, so still not truly EU-aware — a separate, lower-severity item.) |
| `deriveComponentTotal` | loading 150 with numeric inputs | 3.3999999999999972 | 3.3999999999999972 | 0 | Both paths call shared math after numeric parse; both clamp loading to 99. |
| Legacy `computeLayerDerived` vs canonical | burn 8, pareto 2, exposure 10, weights burn 50/pareto 0/exposure 50, loading 20 | canonical 11.25 | legacy 10.799999999999999 | 0.45000000000000107 | Loading formula differs: gross-up vs multiply-by-loading. |
| Legacy `computeLayerDerived` vs canonical | burn 4, pareto 2, exposure 6, weights burn 80/pareto 0/exposure 20, loading 20 | canonical 5.5 | legacy 5.28 | 0.21999999999999975 | Same divergence cause. |
| Legacy `computeLayerDerived` vs canonical | burn 3, pareto 1, exposure 5, weights burn 40/pareto 20/exposure 40, loading 20 | canonical 4.25 | legacy 4.08 | 0.16999999999999993 | Same divergence cause. |
| `mbbefdG` NP vs Prop | `d` in `[0, 0.2, 0.5, 0.9, 1]`; `c` in `[0, 1.5, 3, 5]` | same | same | 0 | Duplicate code is numerically identical for tested points. |
| `fitPareto` NP vs Prop | losses 100/200/500/1000, `xm=100` | alpha 0.8685889638065035, n 4 | same | 0 | Duplicate code is identical. |
| `fitPareto` NP vs Prop | losses 50/75/100/200/500, `xm=100` | alpha 1.3028834457097556, n 3 | same | 0 | Duplicate code is identical. |
| `paretoQ` NP vs Prop | `p=0.75`, `alpha=1.3`, `xm=50` | 105.40925533894598 | same | 0 | Duplicate code is identical; semantic comment issue remains. |
| Chain ladder sample | pattern `[1.5,1.2]`, tail 1 | CDFs `[1.7999999999999998,1.2,1]` | no server path | N/A | Client-only. |

Rounding and epsilon comparison:

- Shared/client `deriveComponentTotal` does not round internally. Display helpers round when formatting strings with `toFixed(2)`.
- Server verifier compares unrounded numeric expected vs stored numeric `total_price` using `0.0002` absolute tolerance or `0.002` relative tolerance.
- Client final-pricing fields are often saved as formatted percent strings (`"8.00%"`). The verifier currently treats those strings as zero before comparing.
- NP/Prop duplicated MBBEFD/Pareto helpers use the same hard-coded epsilons: `abs(c) < 1e-10` for MBBEFD and `abs(alpha - 1) < 1e-9` for Pareto LEV in NP. Prop duplicate lacks Pareto LEV.
- Chain ladder smoothing uses `CDF > 1.0000001` and singular denominator `abs(denom) < 1e-12`; server has no corresponding path.

## Heuristics and Source Gaps

The following formulas need explicit source comments in a follow-up. The comment text should go near the implementation, but was not added in this pass.

| Code | Current variant | Source or citation to add | Notes |
| --- | --- | --- | --- |
| `mbbefdG`, `mbbefdLayerLEV`, `SWISS_RE_C` | One-parameter logarithmic exposure curve with `c -> 0` linear limit. | Bernegger, "The Swiss Re Exposure Curves and the MBBEFD Distribution Class", ASTIN Bulletin 27(1), 1997: https://www.cambridge.org/core/journals/astin-bulletin-journal-of-the-iaa/article/swiss-re-exposure-curves-and-the-mbbefd-distribution-class1/0360BFFA7640908DC177687523164485. Also compare R `mbbefd::swissRe`: https://www.rdocumentation.org/packages/mbbefd/versions/0.8.14/topics/swissRe | Published MBBEFD is a two-parameter class. Code should state that it implements a simplified one-parameter curve, not full MBBEFD, or be replaced. |
| `fitPareto` | Pareto Type I thresholded MLE/Hill estimator with known `xm`. | Pareto MLE reference: https://search.r-project.org/CRAN/refmans/univariateML/html/mlpareto.html and https://rdrr.io/cran/distributionsrd/man/pareto.mle.html | Code-selected `xm` is a heuristic 25th percentile, not MLE `min(x)` and not Clauset threshold fitting. |
| `paretoQ` | CDF quantile despite comment saying exceedance probability. | Same Pareto distribution source as above. | Decide naming: `cdfProbability` or change formula for exceedance probability. |
| `calcPureBurningCost` | Year-matched burning-cost rate on EGNPI; returns premium-rate ROL rather than layer-limit ROL. | Clark, "Basics of Reinsurance Pricing", CAS study note: https://www.casact.org/sites/default/files/2021-03/8_Clark.pdf | Current implementation is coherent, but the older Step 6 line in the comment conflicts with current units. |
| `calcParetoROL` threshold/year defaults | 25th percentile threshold, minimum 5 years, saved fallback `n=10`, `years=10`. | No specific source found in code. Candidate threshold-fitting methods should cite a Pareto/Hill threshold-selection reference if retained. | These defaults materially affect rates and should be explicit assumptions. |
| `autoCurveForBand` | Size bands 400k/1M/2M mapped to Y1/Y2/Y3/Y4. | Code says Swiss Re brochure page 17/20 but no accessible source was found in repo. | Add exact document name/version and currency/FX scaling basis. |
| `calcRiskExposureRating` gross loss ratio | Applies gross loss ratio after each profile loop. | Swiss Re exposure-rating source once identified. | Current placement likely compounds ratios across profiles. Needs review before source comment. |
| `calcCatExposureRating` RP curve | Trapezoidal integration over layer hits using `1/RP` as exceedance probability; synthetic missing return-period points. | CAS OEP/AEP overview: https://www.casact.org/sites/default/files/2021-03/02_humphreys.pdf. General EP/AAL integration reference: https://wmo.int/media/magazine-article/quantifying-risk-disasters-occur-hazard-information-probabilistic-risk-assessment | Code should document whether it is approximating OEP layer AAL, AEP, or occurrence layer expected loss. |
| `calcCatExposureRating` flat 15% fallback | `EGNPI * 15%` seed and `obsYears || 10` denominator. | No actuarial source found. | Should remain visibly labelled as heuristic/no-quote fallback unless approved. |
| `fitExponentialCdfs` | OLS on `ln(CDF - 1)` as CDF smoothing/tail extrapolation. | ChainLadder Mack docs mention log-linear tail estimation: https://www.rdocumentation.org/packages/ChainLadder/versions/0.2.21/topics/MackChainLadder | Code smooths all CDF points, not just a tail factor. Variant must be documented. |
| Chain ladder LDF/CDF | Volume-weighted chain ladder default, last3/last5/simple averages. | Friedland CAS study note: https://www.casact.org/sites/default/files/database/studynotes_friedland_estimating.pdf and R ChainLadder docs: https://www.rdocumentation.org/packages/ChainLadder/versions/0.2.6/topics/chainladder | Method variants should be named in UI/report exports. |
| Bornhuetter-Ferguson | `latest + expected ultimate * unreported percentage`. | Friedland CAS study note: https://www.casact.org/sites/default/files/database/studynotes_friedland_estimating.pdf | Standard formula matches. Premium BF variant needs separate business approval. |
| Munich Chain Ladder | Quarg-Mack style MCL with paid/incurred ratio adjustments. | R ChainLadder Munich docs: https://mages.github.io/ChainLadder/reference/MunichChainLadder.html | Exact residual weighting/lambda variant needs actuary review. |
| Reinstatement margin model | Historical burn-through with paid reinstatement premium pro-rated by amount of reinstatement capacity used. | Mata, "Pricing Excess of Loss Reinsurance with Reinstatements", ASTIN Bulletin 30(2), 2000: https://www.cambridge.org/core/journals/astin-bulletin-journal-of-the-iaa/article/pricing-excess-of-loss-reinsurance-with-reinstatements/A49CDF30B8D289838FFF3E6F90C16623 | Current model is empirical and deterministic, not a full stochastic reinstatement pricing method. |
| Expected shortfall display | `limit * ROL * (1 + 0.5*nReinst) * share`. | No source found. | Rename if it is a display proxy, or replace with a sourced TVaR/shortfall definition. |

## Fallback, Silent-Zero, and NaN-Protection Branches

| Location | Branch | Hides math error or handles domain? | Comment |
| --- | --- | --- | --- |
| `shared/pricingMath.js:29-32` | `layerHit` returns 0 for non-finite values or `limit <= 0`. | Domain condition for nonpositive limit; can hide malformed loss/deductible input. | Upstream validation should reject non-finite monetary values before actuarial calc. |
| `shared/pricingMath.js:44-56` | `weightedAverage` returns null for invalid arrays/zero total weight; skips non-finite and nonpositive weights. | Mostly domain condition. | Skipping invalid values is acceptable if caller surfaces reduced sample count. |
| `shared/pricingMath.js:84-86` | `annualiseLoss` returns 0 for invalid years. | Can hide math error. | Observation years should be explicit and positive. |
| `shared/pricingMath.js:98-100` | `rolFromAnnualLoss` returns 0 for invalid/nonpositive limit. | Domain condition. | Save path should distinguish no limit from zero price. |
| `shared/pricingMath.js:111-113` | `premiumFromRol` returns 0 for non-finite inputs. | Can hide math error. | Non-finite ROL should be rejected upstream. |
| `shared/pricingMath.js:148-156` | `applyLoading` returns 0 for non-finite pure rate, clamps negative loading, throws for >= 100. | Good domain enforcement for loading; pure-rate zero fallback can hide parse errors. | Prefer nullable invalid state for malformed pure rate. |
| `shared/pricingMath.js:188-199` | `deriveComponentTotal` parses loose strings to 0 if unparseable, clamps weights/loading, returns 0 for zero weights. | Mixed. Handles UI strings, but can hide invalid pricing inputs; loading clamp conflicts with docs. | Needs validation and consistent parser. |
| `server/src/lib/pricingVerifier.js:61-65` | `toN` returns 0 for formatted strings and invalid values. | Hides math errors and creates false verifier drifts/false expected zeros. | High-priority parser alignment. |
| `server/src/lib/pricingVerifier.js:82-86` | Non-array outputs or invalid rows are skipped. | Domain condition, but can hide missing pricing rows. | Count skipped rows in verifier summary. |
| `npPricingEngine.js:45-54` | Percent formatters return blank for zero/non-finite values. | Display fallback. | Can make true zero and missing value visually similar. |
| `npPricingEngine.js:58-63` | `mbbefdG` clamps outside `[0,1]` and uses linear limit for small `c`. | Domain condition for damage ratio; epsilon branch is mathematically valid. | Negative `d` probably indicates bad attachment/PML input. |
| `npPricingEngine.js:73-80` | MBBEFD layer LEV returns 0 for nonpositive SI/limit/PML. | Domain condition. | Should surface no exposure vs invalid PML separately. |
| `npPricingEngine.js:87-94` | Pareto fit returns alpha 0 for no tail rows or zero log denominator. | Can hide degenerate fit. | All losses equal threshold should be reported as degenerate/infinite alpha, not zero. |
| `npPricingEngine.js:100-103` | Pareto quantile returns 0 for invalid p/alpha/xm. | Can hide math error. | Better as null/no-estimate. |
| `npPricingEngine.js:116-124` | Pareto LEV returns 0 for invalid params; returns cap for cap <= xm; epsilon for alpha near 1. | Mixed. Alpha=1 epsilon is valid; invalid-param zero hides fit failure. | Callers should carry fit status. |
| `npPricingEngine.js:132-138` | Pareto layer loss returns 0 for invalid alpha/years/n. | Can hide math error or no data. | Distinguish no data, invalid fit, and true zero expected layer loss. |
| `npPricingEngine.js:143-146` | Pareto attachment returns 1 for invalid alpha/xm. | Hides math error. | High-risk: invalid fit becomes 100% attachment. |
| `npPricingEngine.js:177-188` | Pure burn returns zero result when no losses/limit/no selected positive losses. | Mixed. Valid no-loss treaty, but also hides data fetch failure. | Pair with data-availability flags. |
| `npPricingEngine.js:206-233` | Per-year EGNPI only uses years with positive EGNPI; fallback uses current-year EGNPI. | Handles partial data but can bias. | Missing historical EGNPI should be explicit in output. |
| `npPricingEngine.js:274-311` | Pareto ROL returns zeros for invalid limit/EGNPI, fewer than 3 losses, alpha <= 0; defaults saved n/years to 10. | Mixed; defaults are high-risk heuristic. | Missing saved `selected_count`/`observation_years` should not silently become 10. |
| `npPricingEngine.js:328-333` | Auto curve defaults to Y4 above threshold. | Domain condition for known bands. | If avgSI invalid, current loop sends invalid low values to Y1; upstream usually filters. |
| `npPricingEngine.js:355-400` | Risk exposure returns 0 for missing profiles/limit/EGNPI; skips invalid bands; defaults PML% 100, curve Y3, GLR 100. | Mixed. Missing profile and explicit zero exposure look identical. | Add method/status field. |
| `npPricingEngine.js:423-505` | Cat exposure returns 0 for invalid limit/EGNPI; tries RP curve, Pareto, flat 15%, else `method:'none'`. | Method label helps. Flat 15% is heuristic, not domain math. | Good that method is explicit; UI/save should expose it. |
| `npPricingEngine.js:507-519` | OEP interpolation returns 0 for empty points/loss<=0/above max; first point prob for below min. | Domain condition with modelling assumptions. | Above max returning 0 is reasonable for finite curve but underestimates unmodelled tail. |
| `npPricingEngine.js:606-614`, `674-686` | API fetch failures become empty data/profile lists. | Hides operational errors as zero pricing. | Pricing engine should return data-quality warnings. |
| `chainLadder.js:32-40` | Missing/zero denominator factors become null. | Domain condition. | Good; downstream should surface null count. |
| `chainLadder.js:68-77` | Missing pattern defaults LDF to 1.0. | Can hide insufficient data. | Warning exists for thin columns but zero-contribution columns should be more explicit. |
| `chainLadder.js:123-137` | Missing triangle/projection returns empty or zero ultimate/IBNR. | Mixed. | UI should indicate no data rather than zero reserve. |
| `chainLadder.js:140-159` | Exponential smoothing returns original CDFs for insufficient/degenerate regression. | Good fallback. | Should log/display "not fitted". |
| `bornhuetterFerguson.js:2-20` | Missing premiums/IELRs/CDFs default to 0 or 1.0. | Can hide math error. | BF with missing premium or invalid CDF should be no-estimate, not zero IBNR. |
| `bornhuetterFerguson.js:32-52` | Premium BF defaults percent achieved to 1 for missing array entries, but 0 for scalar invalid. | Mixed and inconsistent. | Document intended default. |
| `munichChainLadder.js:92-99` | Invalid/mismatched triangles return null. | Domain condition. | Good. |
| `munichChainLadder.js:185-190` | Missing lambdas produce warning and base chain-ladder fallback. | Good, visible fallback. | Warning should reach UI/export. |
| `munichChainLadder.js:238-242` | Non-finite/nonpositive adjusted factors fall back to base factors. | Domain protection. | Should count fallback cells. |
| `NpFinalPricing.jsx:137-149` | Exposure weight is complement of burn/pareto; loading multiplied by `(1+loading)`. | Legacy heuristic/mismatch. | Remove or align after approval. |
| `NpFinalPricing.jsx:729-745` | Expiring ROL interpolates or carries endpoints. | Heuristic. | Useful display fallback, not actuarial pricing. |
| `NpFinalPricing.jsx:901-1001` | Loss API errors are swallowed; missing losses return without changing historical margin; invalid limit/pricing/year returns unchanged layer. | Can hide data/operational errors. | Historical margin should expose data status. |
| `NpFinalPricing.jsx:949-999` | Reinstatement premium only when amount of reinstatement capacity used; invalid reinstatement fields become 0. | Handles no-reinstatement domain; can hide malformed fields. | Needs explicit reinstatement assumptions. |
| `NpFinalPricing.jsx:2216-2254` | Share table zeros out premium/limits/shortfall for missing share/ROL/limit. | Display domain condition. | Expected shortfall label is too formal for heuristic proxy. |
| `client/src/utils/format.js:195-237` | Flexible parser returns null/0 for invalid strings. | Good UI helper; risky for actuarial validation. | Validation should distinguish empty, invalid, and zero. |

## Follow-Up Review Queue

1. Align server and client numeric parsing before enabling strict pricing verification.
2. Decide a single loading treatment for loading >= 100 and update `applyLoading`, `deriveComponentTotal`, docs, and UI validation together.
3. Replace or document the one-parameter Swiss Re/MBBEFD curve variant and Y-curve constants.
4. Review Pareto parameter semantics: threshold selection, saved default `n/years`, quantile probability naming, and invalid-fit behavior.
5. Split cat exposure methods into sourced RP/OEP, Pareto, and heuristic fallback outputs, with data-quality warnings.
6. Move approved chain ladder/BF/Munich formulas to shared/server-verifiable modules, or explicitly mark them as client-side analytical displays.
7. Review reinstatement and expected-shortfall formulas with a credentialed actuary before changing outputs.
