// Shared reinstatement dropdown options for the NP layer / quote tables.
//
// Single source of truth so the structure screen (LayerTableCard /
// ExpiringStructureCard via useNpStructureState), the quote expiring panel
// (FQQuotePricingPanel) and the pricing-analysis modal (FQPricingAnalysisModal)
// all offer the same choices and stay consistent: blank, 1–10, and the
// 'UNLIMITED' sentinel.
//
// 'UNLIMITED' is the literal string the save path / server reinstatInt()
// recognise: the numeric column stays null and the value is preserved in the
// JSONB terms. Anything that coerces this value to a number before a save
// (e.g. toN) would discard the sentinel, so callers must pass it through.
export const REINSTATEMENT_OPTIONS = [
  { v: '', l: '—' },
  ...Array.from({ length: 10 }, (_, i) => ({ v: String(i + 1), l: String(i + 1) })),
  { v: 'UNLIMITED', l: 'Unlimited' },
];
