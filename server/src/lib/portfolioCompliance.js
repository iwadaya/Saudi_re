// server/src/lib/portfolioCompliance.js
//
// Compliance checks applied to AI line-size recommendations before they
// are surfaced to the underwriter. Each check returns a human-readable
// warning string; the caller attaches the resulting array to the
// recommendation row.
//
// Warnings are NOT blockers at this layer — they're surfaced to the UI
// so the underwriter can decide whether to accept. The staging flow
// (prompt 7.5.b) requires the user to acknowledge non-empty warnings
// before a rec can be staged.

const ROUND_PCT = (frac) => `${(Number(frac) * 100).toFixed(1)}%`;

/**
 * Run compliance checks against a single AI recommendation.
 *
 * @param {string} _cedantId
 *   Reserved for future per-jurisdiction checks (sanctions, IA Circular
 *   85, ZATCA withholding) that need to know which regulator applies.
 *
 * @param {Object} rec
 *   { contract_id, current_line_pct, recommended_line_pct, impact_on_return, ... }
 *
 * @param {Object} ctx
 *   {
 *     contracts: Map<contract_id, { premium, margin, cob }>,
 *     allRecommendations: rec[],
 *     maxLineSizePct: number,
 *     maxCobConcentrationPct: number,
 *   }
 *
 * @returns {string[]}
 */
export function checkPortfolioCompliance(_cedantId, rec, ctx) {
  const warnings = [];
  const recommended = Number(rec.recommended_line_pct ?? 0);
  const current     = Number(rec.current_line_pct ?? 0);
  const contract    = ctx.contracts?.get(String(rec.contract_id));
  const margin      = Number(contract?.margin ?? 0);

  // a. Negative margin acceptance — increasing a line on a losing
  //    structure is the textbook "throwing good money after bad" case
  //    we want to flag aggressively.
  if (recommended > current && margin < 0) {
    warnings.push(`Increasing line on negative-margin structure (${ROUND_PCT(margin)}).`);
  }

  // b. COB concentration breach — project the post-recommendation
  //    portfolio and verify no single class of business breaches the
  //    cap. We treat missing margin as 0 (neutral) so a single missing
  //    margin doesn't blow up the share calc.
  const cobShare = projectCobShareAfterRecs(rec, ctx);
  if (cobShare != null && cobShare > ctx.maxCobConcentrationPct) {
    warnings.push(
      `Would concentrate ${contract?.cob || 'this COB'} at ${ROUND_PCT(cobShare)} of portfolio ` +
      `(cap ${ROUND_PCT(ctx.maxCobConcentrationPct)}).`
    );
  }

  // c. Near-cap line size — > 90% of the user's stated cap.
  if (ctx.maxLineSizePct > 0 && recommended > 0.9 * ctx.maxLineSizePct) {
    warnings.push(`Near line size cap (${ROUND_PCT(recommended)} of ${ROUND_PCT(ctx.maxLineSizePct)}).`);
  }

  // d. Large delta — > 10 percentage points either direction.
  const delta = recommended - current;
  if (Math.abs(delta) > 0.10) {
    const sign = delta > 0 ? '+' : '−';
    warnings.push(`Large change (${sign}${(Math.abs(delta) * 100).toFixed(1)} pts) — review historical performance.`);
  }

  return warnings;

  // TODO: when the compliance module ships, also check:
  // - 30% domestic cession rule (IA / KSA)
  // - Counterparty sanctions screening (UN, OFAC, EU, UK HMT)
  // - IA Circular 85 foreign reinsurer registration
  // - ZATCA 5% WHT — affects expected return calc
}

/**
 * Estimate what fraction of the recommended portfolio premium would
 * sit in this rec's class of business after every recommendation in
 * the same set is applied. Returns null when there isn't enough data
 * to compute (no recommendations have non-zero recommended premium).
 */
function projectCobShareAfterRecs(rec, ctx) {
  const targetCob = ctx.contracts?.get(String(rec.contract_id))?.cob;
  if (!targetCob) return null;

  let cobPremium   = 0;
  let totalPremium = 0;
  for (const r of ctx.allRecommendations || []) {
    const c = ctx.contracts?.get(String(r.contract_id));
    if (!c) continue;
    const recPremium = Number(c.premium ?? 0) * Number(r.recommended_line_pct ?? 0);
    if (!Number.isFinite(recPremium) || recPremium <= 0) continue;
    totalPremium += recPremium;
    if (c.cob === targetCob) cobPremium += recPremium;
  }
  if (totalPremium <= 0) return null;
  return cobPremium / totalPremium;
}

// TODO: future compliance-module integration points
// - sanctions: screen counterparties against UN, OFAC, EU, UK HMT lists
// - IA / KSA 30% domestic cession quota
// - IA Circular 85 foreign reinsurer registration check
// - ZATCA 5% withholding tax adjustment on expected_return
