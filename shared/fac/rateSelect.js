// shared/fac/rateSelect.js
//
// Territorial rate precedence shared by the family rate selectors: an
// exact territory match wins; otherwise the WORLDWIDE row backstops, and
// the caller is told the price fell back so the screen can say so. Each
// family narrows its own candidate pool first (occupation, conveyance,
// vehicle category, ...) — only the tail is common.

/**
 * @param {Array<object>} pool   candidate rate rows, already family-filtered
 * @param {string|null} territory
 * @param {string} [field]       row field carrying the territory
 * @returns {{rate: object|null, fellBackToWorldwide: boolean}}
 */
export function pickByTerritory(pool, territory, field = 'territory') {
  const norm = (s) => String(s || '').toUpperCase();
  const rows = pool || [];
  const exact = rows.find((r) => norm(r[field]) === norm(territory));
  if (exact) return { rate: exact, fellBackToWorldwide: false };
  const worldwide = rows.find((r) => norm(r[field]) === 'WORLDWIDE');
  return { rate: worldwide || null, fellBackToWorldwide: Boolean(worldwide) };
}
