# Facultative Pricing — Multi-Class Design & Redesign Proposal

**Status:** Phases 0, 1, 2 and 3 are **implemented** — see [§9 Implementation status](#9-implementation-status).
Phases 3–5 remain proposals for review.
**Audience:** Underwriting / actuarial / product / engineering.
**Scope:** The facultative (`/fac/*`) pricing capability across all classes of
business, grouped into families that share a rating basis.

> **Decisions taken** (§7): first non-property family is Casualty
> (`LIABILITY_LIMIT`, Phase 3); the legacy ①②③④ manual block is **retired**;
> the territorial capacity budget is an **absolute cap**, with the grade
> percentage applying to the risk's own exposure.

---

## 0. Executive summary

The facultative module today is, in substance, **a single-class tool wearing a
multi-class UI**. The class catalogue lists 29 classes across six categories
(Property, Engineering, Marine, Casualty, Cyber, Energy), and the Risk Detail
screen lets an underwriter tick any of them — but the only real pricing engine,
`client/src/logic/facPropertyPricing.js`, is a faithful port of a Saudi Re
**property fire (FLEXA + NatCat)** Excel workbook. It is driven by an occupancy
code, a FLEXA base rate per mille of sum insured, a NatCat country zone, and 20
property-flavoured underwriting factors. A Marine Hull, a Professional
Indemnity or a Cyber risk cannot be priced by it at all: the engine throws on a
missing `occupancy_code` / `risk_country_zone`, and the underwriter is silently
dropped onto a legacy "type a market rate and a blend weight" form that is
arithmetic, not pricing.

Everything else follows from that. There is no exposure rating for a layer even
though a working MBBEFD implementation already sits in the treaty engine. Loss
history is captured on a dedicated screen and never enters the price. The
underwriting score that governs the maximum line is computed from property
factors regardless of class, so a cyber risk is graded partly on its fire-fighting
equipment. Reference rate tables are unversioned, so re-opening last quarter's
quote can produce a different number.

This document proposes:

1. A **two-level taxonomy** — *Segment* (how the department is organised) and
   *Rating Family* (what actually determines the maths) — with classes mapped
   into both.
2. A **single, universal pricing pipeline** (Exposure → Loss cost candidates →
   Credibility blend → Technical premium → Placement → Decision → Quote) that
   every family flows through, so the screen, the audit trail, the referral
   rules and the reporting are identical class to class.
3. A **family plugin contract** — each family declares its exposure schema,
   rating basis, permitted methods, factor set, extension catalogue and
   referral rules as data, not as branching code.
4. **Per-family rating specifications** for all ten proposed families, with
   formulas.
5. Concrete **schema, API and UI changes**, a **governance model**
   (versioned reference data, server-side verification, override reason codes),
   and a **phased plan** that delivers value at each phase.

It also lists **14 defects and inconsistencies found in the current
implementation**, several of which cause silent data loss or silently wrong
numbers today and are worth fixing regardless of which parts of this design you
choose to build.

---

## 1. What exists today

### 1.1 Data model

| Table | Purpose | Assessment |
| --- | --- | --- |
| `fac_class_of_business` | 29 classes, `category` ∈ {PROPERTY, ENGINEERING, MARINE, CASUALTY, CYBER, ENERGY}, `is_project` flag | Good bones. `category` is used only for grouping checkboxes, colouring chips, and filtering the Extensions list — it drives no maths. |
| `fac_risk` | The header. Parties, policy period, SI (total/PD/BI), placement (prop share **or** XL retention/limit), commission/brokerage/tax, PML/MFL, status, notes | Flat and **property-shaped**. `occupancy_code`, `hazard_grade_override`, `risk_country_zone`, `pd_sum_insured`/`bi_sum_insured`, `pml_pct` are all fire concepts. Non-property classes have no home for their exposure. |
| `fac_location` | Per-site PD/BI SI, CRESTA zone, lat/long, PML%, FX to SAR, carrier share | Property/engineering only. Useful, and the only place PML% actually lives per-site. |
| `fac_cope` | Construction / Occupation / Protection / Exposure + survey | Hard-coded property fire survey. No equivalent for any other class. |
| `fac_loss_history` | Per-year FGU paid/OS/incurred, RI paid/OS, cause, open flag | Generic and fine. **Never used in pricing.** No indexation, no as-if, no development. |
| `fac_pricing` | Legacy dual-engine (market rate, actuarial rate, 50/50 blend, UW adjustment) **plus** the whole engine snapshot from migration 082 **plus** summary fields from 084 | Two unreconciled pricing models in one row. |
| `fac_occupancy_master` | 1..N occupancies with hazard grade, frequency category, FLEXA base rate ‰ | Property only. |
| `fac_factor_master` / `_option` / `_weight` | 20 factors, 84 options, two weight schemes (WITH_BI / WITHOUT_BI) summing to 1.0 | Property-calibrated. Applied to every class. |
| `fac_natcat_rate` | Flood/storm + EQ rate ‰ per country zone | ~50 zones seeded. |
| `fac_capacity_band` | Score 0–100 → grade A..K → max capacity % → UW action | Sound concept, single global calibration. |
| `fac_territorial_capacity` | KSA 300m, Rest of ME / Africa / Asia 50m, Others 0 | Static budget, not netted against live exposure. |
| `fac_bi_indemnity_loading` | Indemnity months → base rate multiplier | Property BI only. |
| `fac_market_rate` | Benchmark ‰ by class × region × hazard grade | **Seeded from a synthetic cross join and referenced by no pricing code.** |
| `fac_underwriting_factors` | JSONB `{factor_code: option_label}` per risk | Fine as a shape. |
| `fac_clause_master` + checklist | Clause catalogue and per-risk ticks | Not linked to price. |

### 1.2 The pricing engine (`facPropertyPricing.js`)

Two pure functions plus an entry point. All rates in ‰ of sum insured.

**Rate path** (`computeRatePath`):

```
flexa_base                 = occupancy.flexa_base_rate_pm
technical_rate (no natcat) = flexa_base × (1 + Σ D/L over 9 rate factors)      ⌊floored at 0.5×base when Σ ≤ −50%⌋
flood_loaded               = zone.flood_storm_rate × (1 + Σ D/L over 6 factors)
eq_loaded                  = zone.earthquake_rate  × (1 + Σ D/L over 5 factors)
total_rate                 = technical_rate + flood_loaded + eq_loaded
bi_rate                    = indemnity_loading[months] × total_rate × (1 + BI_PLAN D/L)
net_rate                   = pd_share × total_rate + (1 − pd_share) × bi_rate      (if BI included)
final_net                  = net_rate × (1 + Σ extra_cover_loadings)
final_gross                = final_net / (1 − commission − margin − other_expenses)
```

**Score path** (`computeScoreAndDecision`): each of 20 factors yields a score in
roughly −100..+100 (hazard grade and frequency from lookup tables, the rest from
the selected option, `MARKET_VS_TECH` from a banded market/technical ratio).
Weighted sum against the WITH_BI or WITHOUT_BI scheme, clamped to 0..100 → capacity
band → grade A..K, `max_capacity_pct`, and a UW action (Accept / Accept with
Caution / Refer / Decline). Max line in SAR is the lesser of the territorial
budget and top-location SI × max capacity %.

The gross-up is done correctly (`/(1 − loadings)`, not `×(1 + loadings)`), which is
better than the treaty quote-mode path flagged in `docs/pricing-signoff-required.md`.

### 1.3 The pricing screen (`FacPricing.jsx`, 764 lines)

Runs **three parallel and unreconciled pricing mechanisms on one page**:

1. **The engine** — UW factor panel + five engine inputs + a read-only 18-row
   output table. Recomputes on a 150 ms debounce, entirely client-side.
2. **The Extensions checklist** — hard-coded in the JSX, `EXTENSIONS_BY_CATEGORY`,
   e.g. Property Earthquake +15%, Marine War & Strikes +20%. Filtered by the
   risk's COB category. Its total loading feeds **only** mechanism 3.
3. **The legacy dual engine** — ① Market Rate, ② Actuarial (method dropdown,
   ELR, loading, rate), ③ 50/50 blend, ④ UW adjustment → Final Rate / Final
   Premium. This is what gets written back to `fac_risk.ri_premium` and
   `original_rate`, and it is what the Summary screen shows as "accepted".

The engine's own `extra_cover_loadings` list is a *fourth*, separate loading
mechanism with no relationship to the Extensions checkboxes.

### 1.4 Assets already in the codebase that facultative does not use

This is the good news. The treaty side already contains most of the actuarial
machinery a proper multi-class fac engine needs:

| Asset | Location | Reusable for |
| --- | --- | --- |
| MBBEFD exposure curve `G(d,c)`, Swiss Re Y-curve map, `mbbefdLayerLEV` | `client/src/utils/npPricingEngine.js` | Property/engineering/energy exposure rating, PML-band allocation, fac XL layers |
| `ref_swiss_re_curve` tabulated curves + `/api/ref/swiss-re-curves` | `000_core_schema.sql`, `routes/nonProp.js` | Curve library, extensible to ILF curves |
| Pareto fit / LEV / layer expected loss / attachment & exhaustion probability | `npPricingEngine.js` | Large-loss extrapolation on any class with a loss list |
| Burning cost with EGNPI weighting | `npPricingEngine.js` | Experience rating for every family |
| Compound Poisson, lognormal/Pareto severity, Monte Carlo, normal stop-loss | `logic/stopLossPricing.js`, `shared/pricingMath.js` | Frequency-severity for casualty, cyber, marine cargo |
| On-levelling by year rate change | `shared/onLevel.js` | As-if of historic fac premiums |
| CRESTA cat exposure rating, OEP interpolation | `npPricingEngine.js` | NatCat load and accumulation |
| Server-side pricing verification + drift header (`PRICING_STRICT`) | `lib/pricingVerifier.js`, `modules/pricing/` | Governance for the fac engine |
| Exchange rates table + integration tests | `016_exchange_rates.sql` | Multi-currency fac pricing |
| LDF benchmark materialised views | `services/ldf/benchmark.js` | Class-level benchmark feedback |

**None of this is wired into the facultative path.** Facultative reimplements a
narrower version from scratch.

---

## 2. Gap analysis

Ranked. F1–F5 are design gaps; F6–F14 are defects verifiable in the current code.

### F1 — One engine, one class *(critical)*

`computeRatePath` throws `Unknown occupancy_code` / `Unknown country_zone` for any
risk without a property occupancy and NatCat zone. `EngineReadout` renders the
throw as a red line. For Marine, Casualty, Cyber and most of Energy, the tool
provides no technical price at all — only the manual blend, where the
"actuarial rate" is a number the underwriter types.

### F2 — Rating basis is hard-coded to ‰ of sum insured *(critical)*

Every rate in the system is ‰ of SI. That is correct for property and hull, and
wrong for most other classes:

| Class | Correct exposure base | What the tool forces |
| --- | --- | --- |
| General / Public / Products Liability | Turnover, payroll, units — priced to a **limit** via ILFs | ‰ of a "sum insured" that does not exist |
| Professional Indemnity, D&O | Fee income / assets, limit-based | Same |
| Marine Cargo | Annual turnover or per-sending values, with a max any-one-conveyance | ‰ of a single SI |
| CAR / EAR | Contract value over the **whole project period** (often > 12 months), + testing + maintenance | Annual ‰ of SI |
| Motor fleet | Vehicle-years by category | ‰ of SI |
| Cyber | Revenue + limit (rate per USD 1m of limit) | ‰ of SI |
| Personal Accident | Benefit units × headcount × occupational class | ‰ of SI |

### F3 — No exposure rating, and non-proportional fac is a dead end *(high)*

`fac_risk` carries `np_retention`, `np_limit`, `np_our_share_pct` and
`placement_type = NON_PROPORTIONAL`, and the Coverage Structure screen collects
them — but nothing prices a layer. There is no first-loss-scale allocation, no
ROL, no reinstatement, no payback view. Meanwhile `mbbefdLayerLEV` sits unused
two directories away.

### F4 — Loss history never reaches the price *(high)*

`fac_loss_history` collects FGU paid/OS by year with cause and mitigation. The
pricing screen has a free-text `burning_cost_ratio` field the underwriter fills
in by hand. No indexation to current values, no as-if for changes in SI or
deductible, no development for open claims, no credibility weighting against the
exposure rate.

### F5 — The score model is property-calibrated but applied universally *(high)*

All 20 factors are scored for every risk. `CONSTRUCTION`, `FIRE_FIGHTING`,
`AGE_OF_RISK`, `SURVEY_RATING`, `BI_PLAN` are meaningless for a PI or Cyber risk,
yet they enter the weighted sum. Because unselected factors score **0**, and 0
sits mid-scale in a −100..+100 range, an incompletely-filled risk converges to a
score near 0 → **grade K → DECLINE**. An incomplete form is indistinguishable
from a bad risk.

Related: when no market rate has been entered, `computeScoreAndDecision` falls
through the band cascade to `'Less than 40%'`, which seeds at **score −30** with
a **6% weight** — so simply not having typed a market rate yet costs ~1.8 points
and can push a borderline risk down a grade. A blank input should be neutral or
unscored, never the worst band.

### F6 — Multi-section / multi-COB entry is silently discarded *(defect, data loss)*

`FacRiskDetail` lets the underwriter define up to 5 sections, tick multiple
classes per section, and enter a sum insured **per class**. On save
(`saveRisk`), only `fac_cob_id` — the first COB of the last-edited section — and
the summed `total_sum_insured` are persisted. On reload, `hydrate` rebuilds a
single section with a single COB carrying the whole total. **Every section
boundary and per-class SI split is lost on refresh.** For a multi-section
package policy (the normal case in fac) this is the single most damaging bug in
the module.

### F7 — Capacity in SAR is computed two inconsistent ways *(defect)*

`facPropertyPricing.js`, `computeScoreAndDecision`:

```js
const topLocCap = top_location_si_sar != null ? num(top_location_si_sar) * max_capacity_pct : null;
if (territorialCap != null && topLocCap != null) {
  max_capacity_sar = Math.min(territorialCap, topLocCap);      // territorial NOT scaled by grade
} else if (territorialCap != null) {
  max_capacity_sar = territorialCap * max_capacity_pct;        // territorial IS scaled by grade
}
```

Whether the territorial budget should be graded is a business question; the two
branches disagreeing with each other is not. Today the answer depends on whether
a region happens to be selected.

### F8 — The percent/decimal heuristic is ambiguous *(defect)*

```js
function pct(v) { const n = num(v); return Math.abs(n) > 1 ? n / 100 : n; }
```

Applied to `commission_pct`, `margin_pct`, `other_expenses_pct` and every
`extra_cover_loadings` entry. A 150% extra-cover loading entered as `1.5` becomes
0.015 (1.5%). A 1% loading entered as `1` becomes 100%. There is no value of the
input that is unambiguous across the whole range. The UI hints "Stored as 0..1"
for three fields and "0..1" for the loadings, but the placeholder is a hint, not
a constraint.

### F9 — Four disconnected loading mechanisms *(defect)*

Extensions checkboxes (additive %, into the legacy blend only), engine
`extra_cover_loadings` (additive fraction, into `final_net`), factor
`discount_loading` (additive fraction, into base rates), and `uw_adjustment_pct`
(multiplicative, into the legacy final). No single build-up shows an underwriter
where the rate came from.

### F10 — BI can be "included" and simultaneously ignored *(defect)*

`bi_included` is derived from `bi_sum_insured > 0` **or** any location BI, but
`pd_si_share` is derived from **locations only**, defaulting to 1.0 when the
Locations screen is empty. So a risk with BI on the header but no locations
computes a BI rate and then weights it at zero:
`net = 1.0 × total + 0.0 × bi`. The output table shows a BI rate that has no
effect on the price.

### F11 — Two different totals feed the premium *(defect)*

`enginePremiums` uses `totalLocSar || tsi` — the sum of location PD+BI if any
locations exist, otherwise `risk.total_sum_insured` (which is the sum of
per-class SI from Risk Detail). Adding a single location flips the premium basis
without warning.

### F12 — Reference data is unversioned *(governance, high)*

`fac_occupancy_master`, `fac_factor_option`, `fac_natcat_rate`,
`fac_capacity_band`, `fac_bi_indemnity_loading` and `fac_territorial_capacity`
have no `effective_from` / `version`. Migration 078 upserts them in place.
Re-opening a quote written before a rate revision recomputes it against today's
rates. `fac_pricing` snapshots the *outputs*, so the stored numbers are safe, but
the screen will disagree with them and no one will know why.

### F13 — The engine is client-only and self-versioned *(governance)*

`ENGINE_VERSION = '1.0.0'` is a constant in `FacPricing.jsx`, posted by the
client and stored verbatim. The server accepts whatever rates and premiums the
browser sends. The NP flow has `PRICING_STRICT` server recomputation and an
`X-Pricing-Drift-Count` header; facultative has neither.

### F14 — No accumulation check, and `fac_market_rate` is decorative *(medium)*

`max_capacity_sar` compares against a **static** territorial budget, not against
capacity already committed in that zone/occupancy by bound fac risks and inforce
treaties. And `fac_market_rate` — the one table that could ground the
market-vs-technical band in something real — is seeded by a synthetic
`CROSS JOIN` of arbitrary multipliers, exposed through
`GET /api/fac/lookups/market-rates` and `api.facListMarketRates()`, and then
called by **no screen and no pricing code**. The market rate that drives the
score is typed by hand.

**Also worth noting** (not defects, but friction): the UW factors panel exposes
its save handle through `window.__facUwFactorsSave`; the auto-calc effects mark
the screen dirty on load so every navigation writes; and premiums are labelled
"SAR" in the UI while the risk carries a `currency_id`.

---

## 3. How the market actually prices facultative

Research summary, used to justify the design in §4. Sources at the end.

### 3.1 The universal pipeline

Every serious facultative pricing process — regardless of class — is the same
seven steps. Only the content of steps 1 and 2 changes:

```
1. Exposure        Characterise what is at risk in the units that class uses.
2. Loss cost       Produce 2–4 independent estimates of expected loss:
                     • Exposure rating   (curve / ILF applied to the exposure profile)
                     • Experience rating (as-if'd, indexed, developed burning cost)
                     • Frequency×severity (parametric, for low-count/high-severity)
                     • Market benchmark  (peer rate for the class/region/band)
                     • Cat model AAL     (separately, for modelled perils)
3. Credibility     Blend them with weights justified by data volume, not taste.
4. Technical       Risk premium → + cat load → + risk/capital load → ÷ (1 − expenses
   premium          − brokerage − commission − tax − margin) → gross technical rate.
5. Placement       Apply the structure: proportional share, or XL layer with
                    reinstatements; short-period / multi-year adjustment; MDP.
6. Decision        Score → grade → max line; referral triggers; accumulation check;
                    technical vs quoted rate adequacy.
7. Quote           Terms, clauses, conditions, subjectivities; audit snapshot.
```

The current fac tool collapses steps 1–4 into one property formula and skips 2
(experience), 3 (credibility) and 5 (layers) entirely.

### 3.2 Exposure rating — property and property-like

The standard technique (Salzmann 1963, Ludwig 1991, Bernegger's MBBEFD, the
Swiss Re and Lloyd's curve families) allocates a ground-up expected loss to a
layer using an **exposure curve** `G(x)` — the proportion of total expected loss
falling below a damage ratio `x` of the maximum possible loss:

```
E[loss to layer (D, D+L]]  =  MPL × [ G(min((D+L)/MPL, 1)) − G(min(D/MPL, 1)) ]
```

Practically: band the schedule by SI (or MPL), pick a curve per band by risk size
and occupancy, apply the formula per band, sum. The steeper the curve, the more
loss concentrated in small damage ratios (better protected / lower hazard risks).
Curve selection is the underwriting judgement; the arithmetic is mechanical.

This is exactly `mbbefdLayerLEV(si, pmlPct, c, deductible, limit)` in
`npPricingEngine.js`. **Caveat**: `docs/pricing-signoff-required.md` records an
open HIGH finding that this implementation is a **one-parameter log variant**,
not the published two-parameter Bernegger MBBEFD, and that the `SWISS_RE_C`
Y-curve constants `{Y1:0, Y2:1.5, Y3:3.0, Y4:5.0}` differ from common references.
Reusing it for facultative **inherits that finding**. See §8.

### 3.3 Exposure rating — casualty

Casualty has no sum insured, so exposure rating is done through **Increased
Limits Factors**: a severity curve `ILF(L)` gives the ratio of expected loss
capped at limit `L` to expected loss at a basic limit `B`. Expected loss to an
excess layer `L xs D` is then

```
E[layer]  =  BasicLimitLossCost × [ ILF(D + L) − ILF(D) ]
```

In the London and international markets, non-US liability is commonly rated on
**power (Riebesell / "alpha") curves**, `ILF(L) = (L/B)^z`, where a "doubling
loading" `d` implies `z = log₂(1 + d)` — a 20% doubling loading gives
`z ≈ 0.263`. US-exposed business uses ISO-style tabulated ILFs. For claims-made
classes, retroactive date and step factors sit on top.

### 3.4 Experience rating and credibility

Burning cost is the workhorse where there is history: index historic FGU losses
to current values, adjust for changes in SI / deductible / limit ("as-if"),
develop open claims, apply to the current structure, divide by an on-levelled
exposure base. The result is credibility-weighted against the exposure rate,
classically Bühlmann–Straub:

```
Z  =  n / (n + k)                        (n = claim count or exposure volume)
LossCost  =  Z × Experience  +  (1 − Z) × Exposure
```

with `k` calibrated per class. Practically most reinsurers cap `Z` by class
(e.g. ≤ 0.75 for casualty excess, ≤ 0.9 for high-frequency property) and require
a documented reason to override the mechanical weight.

### 3.5 Class-specific practice

- **Property**: FLEXA base rate by occupancy × risk-quality adjustments, plus a
  separately-rated NatCat component (increasingly a modelled AAL rather than a
  flat zone rate). PML/EML drives both the layer allocation and the line size.
- **Engineering (CAR/EAR)**: rated on **contract value for the whole project
  period**, not annually. Loadings for testing & commissioning, maintenance
  period, DSU/ALoP, offsite storage, and the peril profile (NatCat during
  construction is materially different from operational). Premium is typically
  100% at inception with a defined earning pattern.
- **Marine hull**: rate on agreed value, with laid-up returns, navigation
  limits/trading warranties, and **war/strikes written as a separate binary
  coverage** (Institute War Clauses) whose rate is set by transit region and can
  move by hundreds of percent in weeks — Hormuz war rates moved from ~0.02–0.05%
  of hull value to 3–4× that during 2024–25 escalations.
- **Marine cargo**: rate on **annual turnover** (or per-sending values), with a
  maximum any-one-conveyance / any-one-location limit that is the real exposure
  control. Commodity, packing, conveyance, voyage, and storage/accumulation are
  the rating factors. Burning cost works on large accounts; credibility blends
  toward portfolio rates on small ones.
- **Energy**: onshore rated close to property with process-hazard grading;
  offshore construction on WELCAR form rated on project value with a distinct
  peril set (windstorm season, installation phases), plus Control of Well /
  OEE / pollution sub-limits rated separately.
- **Cyber**: frequency-severity, with account size driving the model — SME rated
  on controls + industry with frequency dominating, large enterprise on scenario
  and severity tail. **Aggregation/systemic modelling is the differentiator**,
  not the per-risk rate. Priced per unit of limit with a heavy attachment
  discount curve.
- **Motor / PA**: high-frequency, credible experience; rated per vehicle-year or
  per benefit-unit by occupational class; fac is unusual except for large fleets
  and excess layers.

### 3.6 Technical premium build-up

The market-standard build-up, which the design in §4 adopts verbatim:

```
Risk premium         = credibility-blended loss cost (attritional + large)
+ Cat load           = modelled AAL for the covered perils
= Expected loss
+ Risk load          = θ × σ(loss)   or   CoC × capital consumed
+ Internal expense   = per-risk acquisition & admin
= Technical net premium
÷ (1 − brokerage − ceding commission − taxes − target margin)
= Technical gross premium
```

Reinsurers then measure the **quoted** premium against this and report the
technical adequacy ratio (quoted / technical) — which is precisely what the
existing `MARKET_VS_TECH` band is groping towards, and what should become a
first-class portfolio metric.

---

## 4. Proposed design

### 4.1 Taxonomy — Segment, Rating Family, Class

Two orthogonal groupings. **Segment** is organisational: how the fac book is
managed, reported and reinsured. **Rating family** is technical: what maths
applies. Similar classes are grouped together in both.

| Segment | Rating family | Classes |
| --- | --- | --- |
| **Non-Marine Property** | `SCHEDULE_PROPERTY` | Property All Risks, Industrial All Risks, Assets All Risks, Buildings Combined, Business Interruption, Householders/Commercial Fire |
| **Engineering & Construction** | `PROJECT_WORKS` | CAR, EAR, ALoP/DSU, Project Cargo (as a section) |
| | `PLANT_OPERATIONAL` | Machinery Breakdown, Electronic Equipment, Plant All Risks, CPM, Deterioration of Stock, CECR |
| **Marine & Transit** | `HULL_VALUE` | Hull & Machinery, Hull War, Builders' Risk, Yacht, Fishing Vessels |
| | `TRANSIT_VALUES` | Cargo, Goods in Transit, Stock Throughput, Project Cargo (standalone) |
| | `MARINE_LIABILITY` | Marine Liability, P&I buy-downs, Ship Repairers' Liability |
| **Energy & Power** | `ENERGY_ASSET` | Energy Onshore, Energy Offshore (operational), Power Generation, Renewable Energy (operational) |
| | `PROJECT_WORKS` | Offshore/onshore construction (WELCAR), Renewable construction |
| **Casualty & Liability** | `LIABILITY_LIMIT` | General/Public Liability, Products Liability, Employers' Liability, Professional Indemnity, D&O, Medical Malpractice, Environmental |
| **Motor** | `MOTOR_FLEET` | Motor Fleet, Motor TPL excess, Passenger Liability |
| **Financial & Specialty** | `LIABILITY_LIMIT` | Fidelity Guarantee, Crime, Financial Lines, Surety/Bonds (with a `SURETY` sub-profile) |
| | `CYBER_LIMIT` | Cyber First Party, Cyber Third Party, Tech E&O |
| **Accident & Health** | `PA_BENEFIT` | Personal Accident, Group PA, Medical, Travel |
| **Aviation & Space** | `AVIATION` | Aviation Hull, Aviation Liability, Airport Liability, Space |
| **Agriculture** | `AGRI_YIELD` | Crop (MPCI/named peril), Livestock, Aquaculture, Forestry |

Ten families, ten segments, mapping many-to-one in both directions. A single
risk may carry sections in **multiple families** (a CAR policy with a Section II
TPL is `PROJECT_WORKS` + `LIABILITY_LIMIT`) — the design must support that (see
§4.4, `fac_risk_section`).

Migration path: add `segment_code` and `rating_family` columns to
`fac_class_of_business`, backfill from the existing `category`, and keep
`category` as a display alias so nothing breaks.

### 4.2 The unified pipeline

Every family flows through the same seven stages. The stages are the same
objects, the same screens, the same audit records, the same referral engine.
Only the family plugin's contribution changes.

```
┌ 1 EXPOSURE ────────────────────────────────────────────────────────────┐
│  Family-declared schema. Property: locations × (PD, BI, PML%).          │
│  Casualty: turnover/payroll + limit/excess + territory + retro date.    │
│  Cargo: annual sendings + max any-one-conveyance + commodity mix.       │
│  Output: a normalised ExposureProfile { basis, base_amount, bands[],    │
│          limit, attachment, period_months, currency }                   │
└────────────────────────────────────────────────────────────────────────┘
┌ 2 LOSS COST CANDIDATES ────────────────────────────────────────────────┐
│  Methods the family permits, each producing { rate, basis, diagnostics }│
│   EXPOSURE_CURVE  MBBEFD/first-loss over SI or PML bands                │
│   ILF_CURVE       power/tabulated ILF over the limit structure          │
│   BURNING_COST    indexed, as-if'd, developed experience                │
│   FREQ_SEVERITY   Poisson × lognormal/Pareto, analytic or Monte Carlo   │
│   BENCHMARK       fac_market_rate / peer feedback for class×region×band │
│   CAT_MODEL       AAL from CRESTA/vendor output, added not blended      │
│   MANUAL          underwriter rate, always requires a reason code       │
└────────────────────────────────────────────────────────────────────────┘
┌ 3 CREDIBILITY BLEND ───────────────────────────────────────────────────┐
│  Z = n/(n+k) with family-specific k and cap; mechanical weights shown,  │
│  override allowed with a mandatory reason code. Cat load added after.   │
└────────────────────────────────────────────────────────────────────────┘
┌ 4 TECHNICAL PREMIUM ───────────────────────────────────────────────────┐
│  Expected loss → + risk/capital load → + internal expense               │
│  → ÷ (1 − brokerage − commission − tax − margin) = gross technical rate │
│  Extensions/clauses applied here, from the versioned catalogue, each    │
│  declared additive or multiplicative, each traced in the build-up.      │
└────────────────────────────────────────────────────────────────────────┘
┌ 5 PLACEMENT ───────────────────────────────────────────────────────────┐
│  Proportional: our share × (rate × exposure base)                       │
│  Non-proportional: layer(s) with reinstatements, ROL, payback,          │
│                    free-cover check, MDP, short-period/multi-year       │
└────────────────────────────────────────────────────────────────────────┘
┌ 6 DECISION ────────────────────────────────────────────────────────────┐
│  Family-weighted score → grade → max line %                            │
│  ∩ territorial budget ∩ live accumulation ∩ hard referral triggers      │
│  Technical adequacy = quoted / technical                                │
└────────────────────────────────────────────────────────────────────────┘
┌ 7 QUOTE ───────────────────────────────────────────────────────────────┐
│  Terms, clauses, subjectivities, validity. Immutable snapshot of        │
│  inputs + outputs + reference-data version + engine version.            │
└────────────────────────────────────────────────────────────────────────┘
```

### 4.3 The family plugin contract

The central architectural idea: **families are data + a small pure module, not
`if (category === 'MARINE')` branches**. One registry, one interface.

```js
// shared/fac/families/index.js
export const FAMILY = {
  code: 'SCHEDULE_PROPERTY',
  label: 'Schedule Property',
  segment: 'NON_MARINE_PROPERTY',

  // 1. What exposure this family collects, and how it is validated.
  //    Rendered generically by the Exposure screen; validated by the same
  //    schema on client and server.
  exposureSchema: zodSchema,
  ratingBasis: 'SI_PER_MILLE',       // SI_PER_MILLE | TURNOVER | CONTRACT_VALUE
                                      // | LIMIT_ILF | PER_UNIT | AGREED_VALUE
  periodBasis:  'ANNUAL',            // ANNUAL | PROJECT | VOYAGE

  // 2. Which loss-cost methods are permitted, and the default weights.
  methods: ['EXPOSURE_CURVE', 'BURNING_COST', 'BENCHMARK', 'CAT_MODEL'],
  defaultWeights: { EXPOSURE_CURVE: 0.6, BURNING_COST: 0.4 },
  credibility: { k: 8, maxZ: 0.9, unit: 'CLAIM_COUNT' },

  // 3. Scoring: which factors apply and how they are weighted.
  //    Missing selections are UNSCORED, not zero (fixes F5).
  factorSet: ['HAZARD_GRADE','CONSTRUCTION','FIRE_FIGHTING', ...],
  weightScheme: 'PROPERTY_WITH_BI' | 'PROPERTY_WITHOUT_BI',

  // 4. Extension / clause catalogue keys (from versioned reference data).
  extensionGroup: 'PROPERTY',

  // 5. Referral triggers evaluated after step 6.
  referralRules: [
    { code: 'PML_OVER_40', when: (ctx) => ctx.pmlPct > 0.4 },
    { code: 'NO_SURVEY_OVER_50M', when: (ctx) => ctx.siSar > 50e6 && !ctx.surveyDate },
  ],

  // 6. Pure functions the pipeline calls. Everything else is generic.
  buildExposureProfile(risk, sections, locations),
  lossCost: { EXPOSURE_CURVE: fn, BURNING_COST: fn, ... },
};
```

Adding a class means adding a row to `fac_class_of_business` and pointing it at
an existing family. Adding a *family* means one module and one reference-data
seed — no changes to the screens, the API, the audit trail, or the referral
engine.

**Where it lives:** `shared/fac/` so the server can recompute and verify, exactly
as `shared/pricingMath.js` does for NP. This resolves F13.

### 4.4 Per-family rating specifications

#### `SCHEDULE_PROPERTY`

- **Basis** ‰ of SI (PD and BI separately), annual.
- **Exposure** locations × {PD SI, BI SI, indemnity months, PML% PD, PML% BI,
  CRESTA zone, occupancy}. Aggregate to SI bands.
- **Exposure curve method** — keep the existing FLEXA + factor-adjusted rate as
  the *ground-up* burn rate; add MBBEFD allocation for the layer/deductible:
  ```
  groundUpRate‰   = flexa(occ) × (1 + Σ D/L)                      [existing]
  perRiskLoss     = Σ_bands  SI_b × groundUpRate‰/1000
  layerLoss       = Σ_bands  mbbefdLayerLEV(SI_b, PML%_b, c_b, D, L)
  deductibleCredit= 1 − G(ded/MPL, c)                             [new — prices the deductible]
  ```
- **NatCat** stays separate: keep the zone flood/EQ rate as the fallback, but
  allow a modelled AAL per CRESTA zone (the CRESTA machinery already exists) to
  supersede it. Never blend NatCat into the credibility weighting — add it.
- **BI** rate = indemnity loading × PD rate × (1 + BI plan D/L), weighted by the
  true PD/BI SI split from **sections and locations combined** (fixes F10/F11).

#### `PROJECT_WORKS` (CAR / EAR / offshore construction)

- **Basis** ‰ of **total contract value**, for the **whole project period**.
- **Exposure** contract value split into civil works / plant & machinery /
  permanent works, construction period months, testing & commissioning weeks,
  maintenance period months (and whether extended/visits-only), DSU indemnity
  period + sum insured, NatCat exposure by phase.
- **Rate**
  ```
  baseRate‰(project type, contract value band, country)
  × (1 + Σ project factors)                                   contractor experience,
                                                              method, ground conditions,
                                                              wet risk, phasing
  × periodFactor(months)          e.g. 1 + 0.03 × max(0, months − 12)
  + testingLoad‰(weeks, plant %)
  + maintenanceLoad‰(months, type)
  + natcatLoad‰(zone, phase-weighted exposure)
  + dsuLoad‰(indemnity months, SI, delay-driver profile)
  ```
- **Premium** is 100% at inception; store an earning pattern (straight-line or
  S-curve) so the portfolio view can earn it correctly. `policy_period_months`
  already exists on `fac_risk` and supports > 12.

#### `PLANT_OPERATIONAL` (MB / EEI / CPM)

- **Basis** ‰ of replacement value per item class, annual.
- **Rate** by machine type × age × usage intensity × maintenance regime; PML is
  item-level, not site-level. Deterioration-of-stock as an add-on rated on stock
  value × indemnity period.

#### `HULL_VALUE`

- **Basis** ‰ of **agreed value**, annual, with laid-up returns.
- **Exposure** vessel type, tonnage, age, classification society, flag, trading
  area/navigation limits, management (ISM/DOC), crew nationality mix.
- **Rate**
  ```
  baseRate‰(vessel type, tonnage band) × ageFactor × classFactor × tradeFactor
  × managementFactor × claimsFactor(5-yr record)
  + IV/disbursements load
  − laidUpReturn(days)
  ```
- **War & strikes is a separate, separately-rated section** — never a percentage
  loading on hull. Rated per transit/region from a `fac_war_rate` table keyed by
  region with an `effective_from` (these move weekly), plus breach-of-warranty
  additional premium (AP) rules for listed areas.
- **Deductible credit** via a first-loss scale on agreed value.

#### `TRANSIT_VALUES` (Cargo / GIT / Stock Throughput)

- **Basis** rate per mille of **annual turnover / sendings**, capped by the
  max any-one-conveyance and any-one-location limits.
- **Exposure** annual sendings by commodity × conveyance × route; max
  any-one-conveyance; storage locations and duration; accumulation points
  (ports, hubs).
- **Rate**
  ```
  Σ_segments  turnover_s × baseRate‰(commodity, conveyance, route)
              × packingFactor × temperatureFactor × warRegionFactor
  ÷ totalTurnover                                              → blended ‰
  + storageLoad‰(static values, duration)
  ```
- **Experience** is usually credible on cargo — Bühlmann–Straub blend with
  `k` calibrated on claim count, cap `Z` at ~0.8.
- **Accumulation** on max any-one-conveyance and on storage locations is the
  binding constraint, not the annual rate.

#### `MARINE_LIABILITY` → uses `LIABILITY_LIMIT` mechanics with a marine ILF curve.

#### `ENERGY_ASSET`

- **Basis** ‰ of SI (asset values), annual; onshore close to `SCHEDULE_PROPERTY`
  with a process-hazard grade; offshore on platform/asset values.
- **Adds** Control of Well / OEE / seepage & pollution / removal of wreck as
  separately-rated sub-limits (not percentage loadings), plus a windstorm-season
  load for GoM-type exposure and a BI/LOPI section on daily production value.

#### `LIABILITY_LIMIT`

- **Basis** loss cost to a **limit**, from a basic-limit rate and an ILF curve.
- **Exposure** turnover / payroll / fee income / units; territory split
  (especially US/Canada); limit and excess; occurrence vs claims-made; retro
  date; defence costs in or in addition; aggregate vs each-and-every.
- **Rate**
  ```
  basicLimitLossCost = exposureBase × basicRate(class, territory) / basisUnit
  ILF(L) = (L / B)^z ,  z = log₂(1 + doublingLoading)          Riebesell / power curve
           or tabulated ILF for US-exposed classes
  layerLossCost = basicLimitLossCost × [ ILF(D + L) − ILF(D) ]
  × claimsMadeStepFactor(retro years)
  × defenceCostsFactor(in / in addition)
  × aggregateFactor(number of reinstated aggregates)
  ```
- **Credibility** cap `Z` low (≤ 0.6) for excess layers — layer experience is
  rarely credible.
- **Trend** is the dominant driver: apply severity trend from the mid-point of
  the experience period to the mid-point of the policy period **before** the ILF
  step, and expose the trend assumption as a first-class, audited input.

#### `MOTOR_FLEET`

- **Basis** per vehicle-year by category (private / commercial / heavy / special).
- Frequency × severity per category, credible experience (`Z` cap 0.9), NCD /
  fleet-rating adjustment, TPL limit via ILF where excess.

#### `CYBER_LIMIT`

- **Basis** rate per USD 1m of limit, scaled by revenue band.
- **Exposure** revenue, industry (NAICS/SIC), records held, control posture
  (MFA, EDR, backups, patching, vendor concentration), limit/attachment.
- **Rate**
  ```
  baseRatePerMillion(revenue band, industry)
  × controlsFactor(security posture score)
  × Σ layerFactor via a cyber ILF/attachment-discount curve
  + BI/system-failure load(dependency profile)
  ```
- **Aggregation is a mandatory gate, not an option**: every cyber risk must be
  tagged with its critical vendor/cloud dependencies, and the referral engine
  must check the portfolio's exposure to a common-vendor scenario before bind.

#### `PA_BENEFIT`

- Benefit units × headcount × occupational class rate, with 24-hr vs
  occupational-only and cat-accumulation (one conveyance / one event) limits.

#### `AVIATION`

- Hull on agreed value by type/age/utilisation; liability via aviation ILFs on
  seats/passenger-legs; war and AVN52 hull-war as separate sections.

#### `AGRI_YIELD`

- Yield/area rate with a burn-rate history by region and peril, indexed for
  price and yield trend; systemic/drought correlation as an explicit cat load.

### 4.5 Schema changes

Proposed migrations, additive and backward-compatible. Nothing is dropped.

**M1 — Taxonomy**
```sql
ALTER TABLE public.fac_class_of_business
  ADD COLUMN segment_code   text,
  ADD COLUMN rating_family  text,
  ADD COLUMN exposure_basis text;      -- SI_PER_MILLE | TURNOVER | CONTRACT_VALUE | LIMIT_ILF | PER_UNIT | AGREED_VALUE
-- backfill from category; keep category as a display alias
```

**M2 — Sections (fixes F6)**
```sql
CREATE TABLE public.fac_risk_section (
  section_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fac_risk_id     uuid NOT NULL REFERENCES fac_risk(fac_risk_id) ON DELETE CASCADE,
  section_no      integer NOT NULL,
  fac_cob_id      uuid NOT NULL REFERENCES fac_class_of_business(fac_cob_id),
  rating_family   text NOT NULL,
  sum_insured     numeric(18,2),
  exposure_base   numeric(18,2),       -- turnover / contract value / vehicle-years / limit
  exposure_unit   text,
  limit_amount    numeric(18,2),
  attachment      numeric(18,2),
  deductible      numeric(18,2),
  deductible_basis text,
  currency_id     uuid REFERENCES currency(currency_id),
  exposure_detail jsonb NOT NULL DEFAULT '{}',  -- family-schema-validated payload
  UNIQUE (fac_risk_id, section_no, fac_cob_id)
);
```
This is the single most valuable schema change: it fixes the data loss in F6,
gives every non-property class a home for its exposure (F1/F2), and lets one
risk carry multiple families.

**M3 — Loss experience for pricing (fixes F4)**
```sql
ALTER TABLE public.fac_loss_history
  ADD COLUMN section_id       uuid REFERENCES fac_risk_section(section_id),
  ADD COLUMN currency_id      uuid REFERENCES currency(currency_id),
  ADD COLUMN indexed_incurred numeric(18,2),   -- to current values
  ADD COLUMN as_if_incurred   numeric(18,2),   -- to current structure
  ADD COLUMN development_factor numeric(9,4),
  ADD COLUMN exclude_from_rating boolean DEFAULT false,
  ADD COLUMN exclusion_reason text;

CREATE TABLE public.fac_experience_basis (   -- the denominator, per year
  fac_risk_id  uuid REFERENCES fac_risk(fac_risk_id) ON DELETE CASCADE,
  section_id   uuid REFERENCES fac_risk_section(section_id),
  loss_year    integer NOT NULL,
  exposure_base numeric(18,2),   -- SI / turnover / vehicle-years that year
  rate_change_pct numeric(9,4),  -- for on-levelling, reuses shared/onLevel.js
  PRIMARY KEY (fac_risk_id, section_id, loss_year)
);
```

**M4 — Layered (non-proportional) fac (fixes F3)**
```sql
CREATE TABLE public.fac_layer (
  layer_id      uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  fac_risk_id   uuid NOT NULL REFERENCES fac_risk(fac_risk_id) ON DELETE CASCADE,
  layer_no      integer NOT NULL,
  attachment    numeric(18,2) NOT NULL,
  limit_amount  numeric(18,2) NOT NULL,
  our_share_pct numeric(9,6),
  reinstatements integer,
  reinstatement_terms jsonb,      -- [{pct_of_premium, pro_rata_time, pro_rata_amount}]
  aggregate_limit numeric(18,2),
  rol_pct       numeric(9,6),
  premium       numeric(18,2),
  UNIQUE (fac_risk_id, layer_no)
);
```

**M5 — Pricing results, per method, per section (replaces the flat `fac_pricing`)**
```sql
CREATE TABLE public.fac_pricing_method (
  fac_risk_id  uuid NOT NULL REFERENCES fac_risk(fac_risk_id) ON DELETE CASCADE,
  section_id   uuid REFERENCES fac_risk_section(section_id),
  layer_id     uuid REFERENCES fac_layer(layer_id),
  method_code  text NOT NULL,        -- EXPOSURE_CURVE | BURNING_COST | ...
  loss_cost    numeric(18,2),
  rate_value   numeric(14,8),
  rate_basis   text,
  weight       numeric(7,4),
  weight_source text,                -- MECHANICAL | OVERRIDE
  override_reason_code text,
  diagnostics  jsonb,                -- curve id, α, λ, n, Z, years used, warnings
  PRIMARY KEY (fac_risk_id, COALESCE(section_id,'…'), COALESCE(layer_id,'…'), method_code)
);
```
`fac_pricing` stays as the **final, signed-off** row (it already has the right
columns for that) and gains provenance:
```sql
ALTER TABLE public.fac_pricing
  ADD COLUMN rate_table_version   text,      -- fixes F12
  ADD COLUMN family_code          text,
  ADD COLUMN technical_gross_rate numeric(14,8),
  ADD COLUMN technical_adequacy   numeric(9,4),   -- quoted / technical
  ADD COLUMN capital_load         numeric(18,2),
  ADD COLUMN currency_id          uuid REFERENCES currency(currency_id),
  ADD COLUMN fx_rate_used         numeric(18,8);
```

**M6 — Versioned reference data (fixes F12)**

Give every rate/factor table `version_id`, `effective_from`, `effective_to`, and
introduce a `fac_rate_table_version` header row that the engine pins at compute
time and stamps on `fac_pricing.rate_table_version`. Reads default to "current
as at the risk's inception date". Re-opening a quote then reproduces the number
it was written with, by construction.

**M7 — Extension & clause catalogue as data (fixes F9)**
```sql
CREATE TABLE public.fac_extension_catalogue (
  extension_code text PRIMARY KEY,
  label          text NOT NULL,
  family_code    text NOT NULL,
  application    text NOT NULL,      -- ADDITIVE_RATE | MULTIPLICATIVE | SEPARATE_SECTION
  default_value  numeric(9,4),
  min_value numeric(9,4), max_value numeric(9,4),
  requires_referral boolean DEFAULT false,
  version_id uuid, effective_from date, effective_to date
);
```
`EXTENSIONS_BY_CATEGORY` moves out of `FacPricing.jsx` and into this table.
Crucially, `application` makes the treatment explicit and auditable — today
nobody can tell from the UI whether Earthquake +15% multiplies the base rate or
is added to a sum of loadings.

**M8 — Accumulation (fixes F14)**
```sql
CREATE MATERIALIZED VIEW public.mv_fac_accumulation AS
  SELECT cresta_zone, country_id, rating_family, uw_year,
         SUM(carrier_si) AS committed_si,
         SUM(carrier_pml) AS committed_pml
  FROM   -- bound fac risks (fac_location × share) UNION inforce contract exposure
  GROUP BY 1,2,3,4;
```
Refreshed on bind and nightly, alongside the existing
`refresh:ldf-benchmarks` job that already runs on the same trigger pattern.

### 4.6 API surface

Additive; existing endpoints keep working.

```
GET  /api/fac/reference/families                 → family registry (codes, labels, bases, methods)
GET  /api/fac/reference/families/:code/schema    → exposure JSON schema for generic form rendering
GET  /api/fac/reference/curves?family=…          → exposure/ILF curve library (extends /api/ref/swiss-re-curves)
GET  /api/fac/reference/extensions?family=…      → versioned extension catalogue
GET  /api/fac/reference/versions?asOf=…          → active rate-table version for a date

GET  /api/fac/risks/:id/sections                 ┐
PUT  /api/fac/risks/:id/sections                 ┘ multi-section CRUD (M2)
GET/PUT /api/fac/risks/:id/layers                  layered fac (M4)
GET/PUT /api/fac/risks/:id/experience              loss basis + as-if (M3)

POST /api/fac/risks/:id/price                    → server-side compute of ALL methods.
                                                   Returns per-method loss costs, mechanical
                                                   weights, blend, technical build-up, decision,
                                                   referrals, warnings, and the version stamp.
POST /api/fac/risks/:id/price/commit             → persists the selected/overridden result
GET  /api/fac/risks/:id/accumulation             → committed vs available capacity for this risk
GET  /api/fac/benchmarks?family=&region=&band=   → peer feedback from bound business
```

`POST …/price` is the important one: **the server becomes the pricing authority**.
The client may still compute for instant feedback (the current 150 ms debounce is
good UX), but the committed number is the server's, and any client/server
divergence emits a drift signal exactly as `PRICING_STRICT` does for NP.

### 4.7 UI / UX

**Wizard, family-driven.** Keep the existing 9-step shape and make step
visibility a function of the families present on the risk:

| Step | Shown when |
| --- | --- |
| Risk Detail | always — now includes segment/class picker driving everything downstream |
| Documents | always |
| **Sections & Exposure** *(replaces Locations)* | always; renders the family exposure form(s). Property/energy families additionally render the location schedule; casualty renders turnover/limit/territory; cargo renders sendings by commodity/route |
| COPE / Risk Survey | `SCHEDULE_PROPERTY`, `ENERGY_ASSET`, `PROJECT_WORKS` |
| **Risk Profile** *(new, non-property)* | `LIABILITY_LIMIT` (claims-made, retro, territory), `CYBER_LIMIT` (controls questionnaire), `HULL_VALUE` (vessel/trading), `MOTOR_FLEET` (fleet schedule) |
| Placement Structure | always; proportional **or** layered (layer grid when NP) |
| Deductibles & Clauses | always; clause catalogue filtered by family |
| Loss Experience | always; now with indexation, as-if, development, and a live burning-cost readout |
| **Pricing** | always — one screen, one build-up (below) |
| Summary & Approval | always |

**The pricing screen — one rate, one build-up.** Replace the three parallel
mechanisms with a single vertical waterfall the underwriter can read top to
bottom, with every line traceable:

```
  LOSS COST                                              rate      weight   →  blended
    Exposure curve      Y3, 4 SI bands, PML 35%         0.412‰      60%
    Burning cost        5 yrs, indexed 4%, Z = 0.42     0.338‰      40%     ⚙ override
    Benchmark           GCC · IAR · hazard 6            0.390‰       —      (reference)
  ─────────────────────────────────────────────────────────────────────────────
  Blended loss cost                                                            0.382‰
  + NatCat load         EQ zone 3 AAL + flood                                  0.061‰
  = Expected loss                                                              0.443‰
  + Risk / capital load  CoC 8% × capital 12.4m                                0.038‰
  + Internal expense     2.0%                                                  0.010‰
  = Technical net                                                              0.491‰
  ÷ (1 − 20% comm − 2.5% brok − 0.5% tax − 5% margin)                          0.680‰
  = TECHNICAL GROSS                                                            0.680‰
  ─────────────────────────────────────────────────────────────────────────────
  Extensions            EQ ×1.15, SRCC +0.02‰, Terrorism ×1.05    (3 applied) 0.803‰
  UW adjustment         −5%  “long-standing client, clean 5 yrs”  ⚠ reason req 0.763‰
  ═════════════════════════════════════════════════════════════════════════════
  QUOTED RATE                                                                  0.763‰
  Technical adequacy    quoted / technical                            112%  ✅
  Score 78 → Grade D · Max line 75% · Available after accumulation: SAR 41.2m
  Referrals: none
```

Every row is expandable to its diagnostics. Nothing is computed in a place the
underwriter cannot see. This single change probably does more for adoption than
any modelling improvement — the current screen's biggest failing is that an
underwriter cannot explain the number to a broker.

**Score panel.** Show only the factors in the family's `factorSet`; render
unselected factors as **UNSCORED** with a completeness meter ("14 of 18 scored —
score provisional"), and refuse to grade below a completeness threshold rather
than silently returning grade K (fixes F5).

**Portfolio view.** Extend `FacHomeScreen` KPIs with: technical adequacy
distribution, bound premium vs technical premium, hit ratio by family and
cedant, capacity utilisation by zone, and average score by grade band.

### 4.8 Governance

| Concern | Mechanism |
| --- | --- |
| Reproducibility | Versioned reference data (M6) + `rate_table_version` stamped on every priced row + full input snapshot |
| Correctness | `POST /api/fac/risks/:id/price` recomputes server-side from `shared/fac/`; client/server divergence emits a drift metric and (under `FAC_PRICING_STRICT`) a `422` |
| Auditability | `fac_pricing_method` retains every candidate method, its mechanical weight, and any override with a **reason code from a closed list** |
| Authority | Referral engine evaluates family rules + score grade + accumulation; referrals route through the existing approvals workflow |
| Change control | Reference-data edits require a new version row; a version cannot be edited once any `fac_pricing` row references it |
| Model risk | Golden-master tests per family (the pattern already exists — `FacPricing.goldenMaster.test.jsx`, `propTreatyEngine.verifyExcel.test.js`) |

### 4.9 Accumulation and capacity

Replace the static territorial budget with a live check at three levels, run at
quote and re-run at bind:

1. **Per-risk line** — grade-derived max % × the family's line-size basis
   (top location SI for property, limit for casualty, agreed value for hull).
2. **Zone/peril accumulation** — committed PML in the CRESTA zone + this risk's
   contribution vs the zone budget (uses `mv_fac_accumulation`, M8).
3. **Systemic/correlated** — cyber common-vendor scenario, cargo
   any-one-conveyance and storage location, marine war region, agri drought
   region.

And resolve F7: pick one definition of whether the territorial budget is graded,
document it, and apply it in one place.

### 4.10 Benchmark feedback loop

`fac_market_rate` should stop being synthetic seed data and start being derived
from the book:

- Nightly, aggregate bound fac risks into rate benchmarks by
  (family, class, region, hazard/size band, UW year) — median, quartiles, count.
- Serve it as the `BENCHMARK` loss-cost method and as the reference line in the
  waterfall.
- Feed the same aggregate into the `MARKET_VS_TECH` factor so the score reacts to
  a real market position instead of a hand-typed rate.
- The `mv_ldf_benchmark_*` refresh job and its
  terminal-state trigger are the template — the plumbing already exists.

---

## 5. Formula appendix

**Exposure curve (first-loss scale)**
```
G(x)  = exposure curve, x = damage ratio ∈ [0,1]
E[layer (D, D+L]] = MPL × [ G(min((D+L)/MPL,1)) − G(min(D/MPL,1)) ]
Deductible credit  = 1 − G(min(ded/MPL,1))
```

**Increased limits (power / Riebesell)**
```
ILF(L) = (L/B)^z ,   z = log₂(1 + d)     d = "doubling loading"
E[layer L xs D] = BasicLimitLossCost × [ ILF(D+L) − ILF(D) ]
```

**Burning cost, as-if and on-levelled**
```
indexed_i   = incurred_i × Π(1 + severity_trend)^(t_now − t_i)
as_if_i     = indexed_i adjusted for structure change (SI, deductible, limit)
layer_i     = min(max(as_if_i − D, 0), L)
burnRate    = Σ_i layer_i / Σ_y onLevelledExposureBase_y
```
(`shared/onLevel.js` already implements the on-levelling factor product.)

**Credibility**
```
Z = min( n/(n+k), Zmax )         n = claim count (or exposure volume)
LossCost = Z × Experience + (1 − Z) × Exposure
```

**Frequency–severity**
```
λ = expected claim count above threshold
S ~ Lognormal(μ,σ) or Pareto(α, xm)
E[layer] = λ × ( E[min(S, D+L)] − E[min(S, D)] )
```
(`paretoLEV`, `normalLayerMean`, `compoundPoissonMoments` and the Monte Carlo
sampler already exist.)

**Technical premium**
```
Expected loss  = blended loss cost + cat AAL
Risk load      = θ × σ(loss)         or    CoC × capital consumed
Technical net  = Expected loss + Risk load + Internal expense
Technical gross= Technical net / (1 − brokerage − commission − tax − margin)
Technical adequacy = Quoted gross / Technical gross
```

**Non-proportional placement**
```
ROL         = LayerPremium / LayerLimit
Payback     = 1 / ROL   (years)
Reinstatement premium = LayerPremium × pct × (timeUsed) × (amountUsed)
Free cover  = layer top above the highest as-if'd loss  → flag for exposure-only rating
```

---

## 6. Phased implementation plan

Each phase is independently shippable and independently valuable.

### Phase 0 — Fix what is broken (≈ 1 sprint, no new concepts)

Worth doing whatever else you decide.

1. **F6** persist sections and per-class SI (`fac_risk_section`, M2 minimal form).
2. **F7** single definition of `max_capacity_sar`.
3. **F8** remove the `pct()` heuristic; store fractions, format at the edge, use
   the existing `PctInput` consistently.
4. **F10/F11** one SI basis: sections are the truth, locations refine it; make
   `pd_si_share` and the premium base agree, and warn when they cannot.
5. **F5 (partial)** distinguish *unscored* from *scored zero*; add a completeness
   gate before a grade is issued.
6. Collapse the legacy ①②③④ block into a single **Benchmark** input feeding the
   engine, so there is one final rate on the screen.

### Phase 1 — Taxonomy and plugin skeleton (≈ 2 sprints)

7. M1 taxonomy columns + backfill; family registry in `shared/fac/`.
8. Move `facPropertyPricing.js` to `shared/fac/families/scheduleProperty.js`
   behind the plugin interface — **behaviour identical**, golden-master enforced.
9. Family-driven wizard step visibility; generic exposure-form renderer.
10. M6 versioned reference data; stamp `rate_table_version`.
11. `POST /api/fac/risks/:id/price` server compute + drift metric (warn-only).

At the end of Phase 1 nothing prices differently, but the architecture is in
place and reproducibility is fixed.

### Phase 2 — Loss cost methods (≈ 3 sprints)

12. `BURNING_COST` with indexation, as-if, development and on-levelling (M3).
13. `EXPOSURE_CURVE` via the existing MBBEFD (subject to §8 sign-off), with the
    curve library and per-band curve selection.
14. Credibility blend + the pricing waterfall UI (§4.7). This is the phase where
    an underwriter first sees a defensible number.
15. `BENCHMARK` from real bound business (§4.10).

### Phase 3 — Second and third families (≈ 3 sprints) — **built**

16. `LIABILITY_LIMIT` — ILF curves, turnover/limit exposure, claims-made
    handling. Highest business value after property: it unlocks the entire
    Casualty segment, which today has no engine at all. `MARINE_LIABILITY`
    shares the engine on a marine curve, which came free.
17. `TRANSIT_VALUES` and `HULL_VALUE` — unlocks Marine, with war as a separate
    section and a `fac_war_rate` table.
18. M4 layered fac + reinstatements + ROL/payback, which all three families need.

### Phase 4 — Remaining families and portfolio (≈ 3 sprints)

19. `PROJECT_WORKS` (period-based rating, earning pattern), `ENERGY_ASSET`,
    `PLANT_OPERATIONAL`.
20. `CYBER_LIMIT` with the mandatory aggregation gate; `MOTOR_FLEET`,
    `PA_BENEFIT`, `AVIATION`, `AGRI_YIELD` as capacity allows.
21. M8 accumulation + capacity gate at bind.
22. Portfolio analytics: technical adequacy distribution, hit ratio, capacity
    utilisation.

### Phase 5 — Hardening

23. `FAC_PRICING_STRICT` enforced; golden masters per family.
24. Reference-data admin UI with version control and four-eyes approval.
25. Renewal differencing: last year's terms, rate change decomposition
    (exposure change vs rate change vs structure change).

---

## 7. Decisions I need from you

These change the shape of the build, so I would rather ask than guess.

1. **Scope of the first non-property family.** My recommendation is Casualty
   (`LIABILITY_LIMIT`) — it is the largest gap and the ILF machinery generalises
   to marine liability, financial lines and motor excess. Marine is a defensible
   alternative if the book is marine-led.
2. **Rate table ownership.** Who owns the base rates, ILF curve parameters and
   war rates — actuarial, or the fac underwriters through an admin screen? This
   determines whether M6 needs a four-eyes approval workflow in Phase 1 or
   Phase 5.
3. **Capital load.** Do you want a real cost-of-capital load (requires a capital
   model per family) or a simpler standard-deviation load `θ × σ` in Phase 2?
   I would start with `θ × σ` and make the interface capital-model-ready.
4. **Territorial capacity semantics** (F7): is the territorial budget graded by
   the risk's grade, or is it an absolute cap? One line of code, but it needs an
   owner's answer.
5. **Legacy dual-engine.** Can the ①②③④ manual block be retired in Phase 0 (my
   recommendation — it is the source of most of the confusion), or must it stay
   visible during a parallel-run period?
6. **Currency.** Price in original currency and convert for capacity only (my
   recommendation), or keep converting everything to SAR at entry?
7. **How much of the existing property engine is sacred?** The FLEXA + 20-factor
   model is a faithful port of a signed-off workbook. My design keeps it intact
   as one *method* inside a wider pipeline. Confirm that is acceptable, or tell
   me it must remain the sole property answer.

---

## 8. Risks and open items

- **Inherited actuarial finding.** `docs/pricing-signoff-required.md` records
  that the `mbbefdG` implementation is a **one-parameter log variant, not the
  published two-parameter Bernegger MBBEFD**, and that the `SWISS_RE_C` Y-curve
  constants differ from common references — blocked on credentialed sign-off and
  explicitly marked "do not auto-fix". Phase 2 depends on exposure curves.
  **Either** the existing variant is documented and signed off with a cited
  source, **or** a sourced implementation is added alongside it. This is a
  scheduling dependency on a human actuary, not on engineering, and it should be
  started now rather than at the start of Phase 2.
- **Property score weights are the only calibrated set.** Every new family needs
  its own factor weights and capacity bands. Those are underwriting-judgement
  inputs, not code. Without them, a new family can price but cannot grade.
  Budget underwriting workshop time per family.
- **Benchmark quality.** Deriving benchmarks from bound business is only
  meaningful once there is enough bound business per (family, region, band). Until
  then the benchmark method should report low confidence rather than a
  spuriously precise number.
- **Migration of live risks.** `fac_risk` rows priced under the current engine
  must keep rendering their stored outputs after M5/M6. The design keeps
  `fac_pricing` as the signed row precisely so this works, but the Summary screen
  needs a "priced under engine v1.0.0 / rate table 2026-Q1" provenance line.
- **Scope discipline.** Ten families is a lot. Phases 1–3 (property + casualty +
  marine, with proper loss-cost methods and a readable build-up) cover the large
  majority of a typical fac book. Phase 4 should be re-justified against actual
  submission volumes before it is built.

---

## 9. Implementation status

Phases 0, 1, 2 and 3 are built. Nothing in Phases 4–5 is.

### What landed

| Area | Change |
| --- | --- |
| **Migration 133** | `fac_risk_section` — sections, classes and a sum insured per class, plus the nullable exposure columns the non-property families will need. Backfills one section per existing risk from `fac_risk.fac_cob_id`. |
| **Migration 134** | `segment_code` / `rating_family` / `exposure_basis` on `fac_class_of_business`, backfilled for all 29 classes; `fac_rate_table_version` with `FAC-REF-2026.1` as the current set; `rate_table_version`, `family_code`, `score_completeness`, `exposure_basis` on `fac_pricing`. |
| **`shared/fac/`** | New. `registry.js` (ten families, one implemented, nine declared), `families/scheduleProperty.js` (the engine, moved out of `client/src/logic/` so the server can run it), `exposure.js` (one exposure profile), `index.js` (`priceFacRisk`). |
| **Server** | `GET`/`PUT /api/fac/risks/:id/sections`; `POST /api/fac/risks/:id/price` (the pricing authority); `GET /api/fac/reference/families` and `/rate-version`; `services/facPricingService.js` with reference loading, recompute and drift verification; `X-Fac-Pricing-Drift-Count` on every pricing save. |
| **Client** | Risk Detail persists sections; Pricing is a single build-up with the legacy block removed; `FacPricing.css` replaces 87 inline styles; wizard steps are family-driven; Summary shows provenance and no longer renders an incomplete score as a grade. |
| **Tests** | 43 new tests in `shared/fac/`, a rewritten `FacPricing.goldenMaster.test.jsx`, and `facSectionsAndPricing.integration.test.js` (17 DB-backed tests). `npm run verify` passes; the DB suite is 234 tests green. |

### Findings closed

| # | Fix |
| --- | --- |
| **F1** | `pricingBlocker` returns a typed state — "Hull & Machinery rates on agreed value; that engine is not built yet (Phase 3)" — instead of the property engine throwing `Unknown occupancy_code` and the screen rendering the exception. |
| **F5** | Unselected factors are **UNSCORED**, not zero: excluded from both sides of the weighted average, which is renormalised over the weight actually selected. Below 80% completeness no grade is issued and `uw_action` is `INCOMPLETE`. A fully-scored risk prices identically to before. |
| **F5b** | A blank market rate leaves `MARKET_VS_TECH` unscored rather than dropping it to the worst band (−30 against a 6% weight). |
| **F6** | Sections and per-class sums insured persist to `fac_risk_section` and rehydrate. |
| **F7** | One capacity formula: the territorial budget is an absolute cap; the grade percentage applies to the risk's own exposure. |
| **F8** | The percent-vs-decimal heuristic is gone. Fractions are taken at face value, an out-of-range one warns, and the inputs are `PctInput` so the UI is unambiguous at source. |
| **F9** | Extensions are the engine's cover loadings. Four loading mechanisms became one build-up, with the UW adjustment as its own visible final line. |
| **F10** | The BI flag and the PD share come from one exposure profile, so a BI rate can no longer be computed and then weighted at zero. |
| **F11** | One sum insured drives both the share and the premium, and the screen names which source it used. |
| **F12** | Every priced row is stamped with the reference-set label in force at the risk's inception date; Summary shows it. |
| **F13** | The engine is in `shared/`, the server recomputes it, and drift is logged and counted (warn-only; `FAC_PRICING_STRICT=1` enforces). |

### Phase 2 — loss-cost methods and the blend

An underwriter can now see where a rate came from, and the risk's own loss
history finally moves it.

| Area | Change |
| --- | --- |
| **Migration 135** | Restatement columns on `fac_loss_history` (indexed, as-if, development factor, exclude-with-reason); `fac_experience_basis` — the per-year exposure a burn rate divides by; `fac_pricing_method` — every candidate with its weight and where that weight came from; `fac_exposure_curve` / `_point` / `fac_curve_band` — the curve library; the technical build-up columns on `fac_pricing`. |
| **`BURNING_COST`** | Index to current values, develop open claims, restate as-if the structure being quoted, apply the layer, divide by every exposure year — including the clean ones. Per-loss overrides beat the derived chain. Reports an on-levelled loss ratio as a cross-check using the treaty side's own `shared/onLevel.js`. |
| **`EXPOSURE_CURVE`** | Layer and deductible allocation off a curve, with monotone interpolation of tabulated curves and a verified two-parameter Bernegger MBBEFD generator. Curves are reference data selected per size band. |
| **`BENCHMARK`** | The median rate the book has actually bound for the same family and region, with quartiles and a confidence grade. Shown beside the priced methods and never weighted — it records what was charged, not what the losses will be. Replaces the synthetic `fac_market_rate` seed nothing read. |
| **Credibility** | Bühlmann–Straub `Z = n/(n+k)`, with `k` and a cap per family — property attritional experience can carry 80%, casualty excess 60%, cyber 50%. Weight overrides require a reason code from a closed list. |
| **Pipeline** | Blend → cat load → risk load (θ×σ measured from the risk's own annual dispersion where there are three or more years, a flat percentage otherwise) → internal expense → gross up **once**. |
| **UI** | A Loss Cost panel showing every method, its rate and its weight; a Technical Build-Up beneath it; the Loss Experience screen gained the per-year exposure grid, the claims-inflation assumption and a working claim-ratio column. |
| **Tests** | 135 new tests in `shared/fac`, 15 new DB-backed integration tests, and the golden master extended. |

**The invariant that made this safe.** With the workbook rate as the only
candidate and no loads configured, the pipeline's technical gross rate equals
the engine's own final gross rate exactly. A risk with no loss history and no
curve prices today as it did before Phase 2. There is a unit test and an
integration test that each assert it.

### Phase 3 — Casualty, Marine, and the excess tower

Five of the ten families now have engines. The Casualty segment, which had
none at all, prices; Marine splits into the three things it actually is; and an
excess placement is a tower rather than a single band.

| Area | Change |
| --- | --- |
| **Migration 136** | `fac_layer` — the excess tower, with per-layer share, reinstatements (and their terms), aggregate limit and price; existing non-proportional placements backfilled as layer 1. `fac_ilf_curve` / `_point`. `fac_liability_base_rate`, `fac_transit_base_rate`, `fac_hull_base_rate`, `fac_hull_factor`, `fac_war_rate`. Every rate table ships **empty**. |
| **`ILF_CURVE`** | Riebesell power curves — `ILF(L) = (L/B)^α` with `α = log₂(1 + r)` from the doubling loading — and tabulated curves with monotone interpolation, flat above the table and proportional below it. Claims-made step factors, defence costs in addition, and aggregate reinstatements each apply only where the curve or the slip states them. |
| **`LIABILITY_LIMIT`** | `basicLimitLossCost = exposureBase ÷ divisor × lossCostPerUnit`, stepped to the limit by `ILF(D+L) − ILF(D)`. Rates against turnover, payroll, fee income or units — and **refuses to price** when the section's unit and the loaded rate's unit disagree, naming the units it does hold. Territory is a hard preference with a flagged worldwide fallback, because a worldwide rate on US-exposed liability is the classic way to underprice one. |
| **`MARINE_LIABILITY`** | The same engine on a marine curve. Curves carry a `family_code`, and a curve another family owns is never handed to this one. |
| **`TRANSIT_VALUES`** | Turnover-weighted blend across commodity × conveyance × route segments, with packing and temperature factors and a separately-stated storage load. Prices what it can rate and reports what share of the turnover it could not. The any-one-conveyance limit is carried as the accumulation control, never as a rating base. |
| **`HULL_VALUE`** | Base rate by vessel type and half-open tonnage band, moved by age, class, flag, trading area, management and claims factors — each loaded, each reported when it is not. Increased value and laid-up returns are priced only when their own rate is set. |
| **War & strikes** | A separate section with its own candidate and its own `ADDITIVE` role in the pipeline: added to the blend's result, never averaged into it. Rated per region off `fac_war_rate`, newest effective row first, with the breach-of-warranty AP. Its contribution is converted through money rather than rate, because a per-transit war rate and an annual cargo rate are per mille of different things. |
| **Layers** | ROL, payback, total cover, free cover, reinstatement premium (pro rata as to time and amount **only where the slip says so**) and whole-tower pricing. The Placement Structure screen gained the tower grid, with ROL and payback derived rather than typed so they cannot disagree with the premium beside them. |
| **The dispatch** | `priceFacRiskFull` no longer knows which family it is holding: every family contributes candidates through `family.computeCandidates`, and burning cost and benchmark are added generically. Adding a family is a module and a registry entry. The premium base follows the family's rating basis — turnover for cargo and casualty, values for property and hull. |
| **Server & client** | `GET`/`PUT /api/fac/risks/:id/layers`; `GET /api/fac/reference/rate-tables`; `loadFamilyRates` in the pricing service; the war section as its own line in the technical build-up; the workbook-only sections hidden for families that have no workbook. |
| **Tests** | 110 new tests in `shared/fac`, 14 new DB-backed integration tests, 10 for the tower grid. |

**What a family with no rates loaded does.** It reports itself unavailable
with a reason naming the table to load — "No ILF curve is loaded for this
class and territory", "No hull base rate is loaded for BULK_CARRIER at 45,000
tons" — takes no weight, and lets the blend carry on with the methods that do
have data. This is the same discipline as the exposure curves, applied to five
more tables. A plausible default would be worse than a refusal, because nobody
goes looking for a number that looks right.

**Multi-section risks.** A risk whose sections span more than one family is
priced on its primary section, and the build-up says so and names the sections
it left out. Pricing every section and summing them is Phase 4 work; presenting
one section's answer as the whole risk silently would not be.

### A constraint we kept: curves are loaded, not invented

The plan called for exposure rating "via the existing MBBEFD". The
implementation deliberately does not use it.

`client/src/utils/npPricingEngine.js` carries a one-parameter log curve
labelled MBBEFD, with Swiss Re Y-curve constants — and
`docs/pricing-signoff-required.md` records both as an open **HIGH** finding
marked "do not auto-fix". Reproducing that mapping in the facultative path
would have put an unverified parameterisation into a price.

What shipped instead:

- The **allocation arithmetic**, which is the definition of an exposure curve
  and needs no calibration:
  `E[layer] = MPL × [G(min((D+L)/MPL,1)) − G(min(D/MPL,1))]`.
- Bernegger's **two-parameter** curve `G(x)` in full, all four parameter
  cases, with the ASTIN citation. Its branch continuity is unit-tested —
  the general case converging on the `b = 1` and `bg = 1` special cases —
  which is what makes the transcription checkable rather than trusted.
- **No `c → (b, g)` mapping.** Two sources disagreed on the exponent in the
  Swiss Re one-parameter subfamily and the primary references were
  unreachable from this environment. Parameters are supplied by whoever owns
  the curve set, not guessed here.
- **One curve ships as data**: `G(x) = x`, the uniform destruction rate. It
  is the definitional baseline and asserts nothing about severity. Every
  other curve encodes a view of severity that belongs to whoever holds the
  data behind it, so curve sets are loaded. `fac_exposure_curve.source` is
  `NOT NULL` — a curve nobody can attribute is a rate nobody can defend.

The practical consequence: until a curve set is loaded, `EXPOSURE_CURVE`
reports itself unavailable with a reason, takes no weight, and the blend
carries on with the methods that do have data. That is a working state, not
a broken one — and it means the MBBEFD sign-off no longer blocks Phase 2,
only the *convenience* of picking a curve by number.

### Deliberately not done

- **F14** (accumulation, real benchmarks) — Phase 4 and §4.10; needs the
  materialised view and enough bound business to be meaningful.
- **M6 in full** — reference tables still have no per-row effective dating.
  What shipped is the version *identity* and the provenance stamp, which is
  what makes a historic quote explainable. The admin UI that edits versions
  is Phase 5.
- **M7** — the extension catalogue is still hard-coded in `FacPricing.jsx`.
  Its numbers now feed the engine, but they are not yet versioned data with
  an explicit additive/multiplicative flag.
- **Nine of ten families** — declared with their rating basis, methods,
  credibility parameters and planned phase, so the tool can say what a class
  needs. No engines.
- **`FREQ_SEVERITY` and `CAT_MODEL`** — declared in the method registry and
  wired through the blend as roles, but not implemented. The cat load is an
  input the pipeline adds; nothing computes it yet.
- **Curve admin UI** — curves and bands are loaded by SQL. The screen reads
  them; nothing in the UI edits them.
- **Per-section pricing** — `fac_pricing_method` carries a `section_id` and
  the pipeline runs once per risk. A multi-family risk still prices through
  its primary class.

### Notes for review

- **`ENGINE_VERSION` is now `2.0.0`.** The rate path is arithmetically
  unchanged, but the score, capacity and loading paths are not — a risk
  re-opened after this change can show a different grade. Rows priced under
  `1.0.0` keep their stored figures and are stamped as such.
- **`npm run budget:frontend` was already red on `main`** at 3286 inline
  styles against a 3133 baseline. This change reduces it to 3199 and
  reconciles the baseline, the same way the committed note records the
  earlier 3065→3133 reconciliation. It did not introduce the breach.
- **The MBBEFD sign-off in §8 is still open.** It no longer gates exposure
  rating — see "curves are loaded, not invented" above — but the treaty
  engine's own curve remains unresolved, and any future `c → (b, g)`
  convenience mapping depends on it.
- **The blend can move an existing rate.** A risk that has loss history
  entered will now price off a credibility-weighted blend rather than the
  workbook rate alone. That is the point of Phase 2, but it means the first
  save after loading experience data can change a quoted number.

---

## Sources

Market-practice research supporting §3:

- [Swiss Re — Exposure rating (technical publishing, Property)](https://www.swissre.com/dam/jcr:7137dac0-83a6-4cfa-80a4-93d33c35562f/exposure-rating-brochure.pdf)
- [Exposure rating, destruction rate models and the mbbefd package (CRAN vignette)](https://cran.r-project.org/web//packages//mbbefd/vignettes/Introduction_to_mbbefd.pdf)
- [A generalised property exposure rating framework incorporating scale-independent losses and MPL uncertainty](https://www.researchgate.net/publication/341461945_A_GENERALISED_PROPERTY_EXPOSURE_RATING_FRAMEWORK_THAT_INCORPORATES_SCALE-INDEPENDENT_LOSSES_AND_MAXIMUM_POSSIBLE_LOSS_UNCERTAINTY)
- [Exposure modelling in property reinsurance (Prague Economic Papers)](https://pep.vse.cz/pdfs/pep/2019/02/01.pdf)
- [Property excess of loss reinsurance pricing in the Lloyd's market (Institut des Actuaires)](https://www.institutdesactuaires.com/docs/mem/664946b2aad2ae92352ecd2445f45fea.pdf)
- [Clark — Basics of Reinsurance Pricing (CAS study note)](https://www.casact.org/sites/default/files/old/studynotes_clark_2014.pdf)
- [Mata — Casualty Excess Pricing Using Power Curves (CARe)](https://matblas.com/wp-content/uploads/2018/11/4_London_CARe_2009_PowerCurves.pdf)
- [Understanding ILF curves in insurance: how power curves shape casualty excess pricing](https://matblas.com/understanding-ilf-curves-in-insurance-how-power-curves-shape-casualty-excess-pricing/)
- [Extreme value techniques part III: increased limits factors (IFoA)](https://www.actuaries.org.uk/system/files/documents/pdf/0301-0339.pdf)
- [Marine insurance & reinsurance (IFoA)](https://www.actuaries.org.uk/system/files/documents/pdf/marine.pdf)
- [hyperexponential — Marine cargo pricing factors](https://www.hyperexponential.com/lob-pricing-factors/marine-cargo)
- [hyperexponential — Excess & umbrella pricing factors](https://www.hyperexponential.com/lob-pricing-factors/excess-umbrella)
- [hyperexponential — Cyber pricing factors](https://www.hyperexponential.com/lob-pricing-factors/cyber)
- [Munich Re — Facultative engineering solutions (CAR/EAR/DSU/CPM/CECR)](https://www.munichre.com/us-non-life/en/solutions/reinsurance/facultative-engineering.munichreamerica.html)
- [Clyde & Co — Offshore construction (WELCAR) overview](https://www.clydeco.com/blog/energy/article/offshore-construction-an-overview)
- [Marine hull rates in the Gulf could rise 50% (Reinsurance News)](https://www.reinsurancene.ws/marine-hull-insurance-rates-in-the-gulf-could-rise-50-due-to-iran-conflict-marsh/)
- [CyberCube — Pricing in catastrophe: modelling aggregation in cyber](https://insights.cybcube.com/en/post_typeblogpostp1545)
- [Modeling and pricing cyber insurance (European Actuarial Journal)](https://link.springer.com/article/10.1007/s13385-023-00341-9)
- [Loss Data Analytics — Experience rating using credibility theory (Bühlmann–Straub)](https://openacttexts.github.io/Loss-Data-Analytics/ChapCredibility.html)
- [Munich Re — Automated underwriting platform for facultative & corporate business](https://www.munichre.com/en/solutions/for-industry-clients/automated-underwriting-platform.html)
- [Send Technology — Reinsurance underwriting platform](https://send.technology/products/reinsurance-underwriting/)
