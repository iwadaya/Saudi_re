// src/utils/npTreatyType.js
//
// Canonical NON_PROPORTIONAL treaty type names (from public.treaty_type):
//   "Risk XL"       → RISK  — only risk losses; CAT screens disabled
//   "CAT XL"        → CAT   — only cat losses; risk/large-loss screens disabled
//   "Risk & CAT XL" → BOTH  — all screens active
//   "Aggregate XL"  → BOTH  — all screens active
//   "Stop Loss"     → BOTH  — all screens active

function norm(x) {
  return String(x || '').trim().toUpperCase().replace(/\s+/g, ' ');
}

/** Read the current NP treaty type name from appState.npTreatyDetail. */
export function getCurrentNpTreatyTypeName(appState) {
  const s = appState || {};
  const c = s.npTreatyDetail;
  if (!c) return '';
  return String(c.treatyTypeName || c.treaty_type_name || c.treatyType || c.treaty_type || '');
}

/**
 * Returns the peril mode derived from the treaty type name:
 *   'RISK'  — "Risk XL"                        → CAT screens disabled
 *   'CAT'   — "CAT XL"                         → risk/large-loss screens disabled
 *   'BOTH'  — "Risk & CAT XL", "Aggregate XL",
 *             "Stop Loss", or anything else     → all screens active
 */
export function getNpTreatyTypeMode(appState) {
  const n = norm(getCurrentNpTreatyTypeName(appState));
  if (n === 'RISK XL') return 'RISK';
  if (n === 'CAT XL')  return 'CAT';
  return 'BOTH';
}

/** True for Risk XL — disable all CAT-related screens */
export function isNpCatFlowDisabled(appState) {
  return getNpTreatyTypeMode(appState) === 'RISK';
}

/** True for CAT XL — disable risk/large-loss screens */
export function isNpRiskFlowDisabled(appState) {
  return getNpTreatyTypeMode(appState) === 'CAT';
}
