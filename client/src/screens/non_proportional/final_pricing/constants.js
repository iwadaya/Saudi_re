// src/screens/non_proportional/final_pricing/constants.js
// Statics that were inline at the top of the 4K-line NpFinalPricing
// file. Extracted so every submodule can import what it needs without
// pulling in the whole screen.

export const ROUTE_KEY = 'NP_FINAL_PRICING';

/**
 * Dropdown options presented to underwriters when they route a
 * pricing decision up the chain. Order matters — displayed top-down.
 */
export const APPROVER_OPTIONS = [
  '',
  'Treaty Head',
  'Chief Underwriting Officer',
  'Head of Retro',
  'CEO Office',
];

/** Hard cap per layer in USD — used by UI validation. */
export const UW_MAX_LIMIT = 50_000_000;
