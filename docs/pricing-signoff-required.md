# Pricing — open findings requiring credentialed actuarial sign-off

> **Status: NOT RESOLVED. DO NOT auto-fix.**
> This document only *lists* the open actuarial findings and marks them as
> blocked on a credentialed (human) actuary / product-owner decision. The
> P0-5 scaffolding work (shared formulas, server verification, golden-master
> drift tests, strict-mode default) deliberately changed **no pricing math**
> and did **not** re-derive or resolve any of the findings below. Each item
> needs a documented decision and sign-off before any code change.

Source of record: `docs/actuarial-audit.md` (Executive Findings + Formula
Inventory). Line references drift as code changes — re-confirm against the
current file before acting.

## Open HIGH findings (blocked on actuarial sign-off)

1. **`loading >= 100` handling is inconsistent and undocumented.**
   `deriveComponentTotal` JSDoc says loading ≥ 100 returns 0, but the
   implementation clamps to 99 and returns a very large finite result, while
   `applyLoading` *throws* (`RangeError`) on loading ≥ 100.
   Evidence: `shared/pricingMath.js` (`applyLoading`, `deriveComponentTotal`).
   Decision required: a credentialed actuary/product owner must choose ONE
   legal handling — reject, clamp, or explicit no-quote — and that becomes the
   approved spec before the code is aligned.

2. **Quote-mode `computeLayerDerived` uses a legacy gross-up formula.**
   Denominator fixed at 100 and loading multiplied by `(1 + loading)` instead
   of grossing up by `1 / (1 - loading)`. This path is **not** server-verified.
   Evidence: `client/.../NpFinalPricing.jsx` (`computeLayerDerived`).
   Decision required: confirm the intended gross-up convention; align or remove
   only after actuarial review.

3. **"MBBEFD" curve is a one-parameter variant, not the published two-parameter
   Bernegger MBBEFD; Y-curve mapping differs from common references.**
   The code labelled MBBEFD implements a one-parameter log curve `G(d,c)`; the
   Swiss Re Y-curve constants also differ from published package references.
   Evidence: `client/.../npPricingEngine.js` (`mbbefdG`, `SWISS_RE_C`),
   `propPricingConstants.js`.
   Decision required: either document this exact one-parameter variant with a
   cited source, or replace with a sourced MBBEFD implementation — after review.

## Related (server-recompute deferred until approved)

- **Chain Ladder, Bornhuetter-Ferguson, Munich Chain Ladder, IBNR,
  reinstatement pricing, historical margin, expected shortfall are client-only**
  today; the server persists outputs but does not independently recompute them.
  Evidence: `docs/actuarial-audit.md` (Formula Inventory) and the client logic
  files. These formulas should move to `shared/` + server verification **only
  once the underlying formulas are actuarially approved** — moving an
  unapproved formula would merely pin an unapproved result. Tracked here so the
  scaffolding can be extended after sign-off; not done in P0-5.

## Drift SLI hook (no thresholds fabricated)

The server already emits a per-save drift signal that an SLI/alert can consume;
P0-5 did not invent any alert thresholds (those need actuarial + SRE input):

- **Computation:** `pricingDriftStats(drifts)` in
  `server/src/lib/pricingVerifier.js` → `{ pricingDriftCount, maxAbsDiff,
  driftMagnitudeBucket }`.
- **Emission:** per save in `server/src/modules/pricing/controllers/pricingController.js`
  (`driftLog` structured log) and the `X-Pricing-Drift-Count` response header
  (exposed via `app.js` `EXPOSED_HEADERS`).
- **TODO (human):** define the SLO/alert thresholds (acceptable `maxAbsDiff`,
  drift-rate over a renewal+quote window) with actuarial + SRE sign-off, then
  wire `pricingDriftStats` output to the metrics backend.
