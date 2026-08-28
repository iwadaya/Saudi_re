// shared/onLevel.js
//
// On-level premium adjustment math. Given per-UW-year rate changes
// (e.g. 2022: +5%, 2023: -3%, 2024: +2%), brings every historical
// premium up to the current rate level so loss ratios computed
// against the adjusted premiums reflect today's pricing instead of a
// mix of vintages.
//
// Convention: the rate change r_y for year y is the rate movement
// applied IN year y — i.e. the premium for year y sits r_y% above the
// prior year's rate level. To on-level the premium for year y to
// the latest year's level we multiply by every rate change that has
// occurred AFTER year y:
//
//     adjusted(y) = original(y) × Π over i > y of (1 + r_i / 100)
//
// The product runs over EVERY year a rate change is known for, not just
// the years a factor is requested for — a year missing from `years`
// (say, a year with no premium recorded) still moved the rate level,
// and dropping its rate change would under-adjust every earlier year.
// The latest chained year's on-level factor is 1.0 (no adjustment);
// earlier years scale up by the cumulative subsequent rate movement.
//
// Lives alongside pricingMath.js so the client (Stop Loss Pricing
// screen, Premiums Table rate-change modal) and any future server
// validation use the same arithmetic.

/**
 * @param {number[]} years      sorted-or-unsorted list of UW years to
 *   return factors for
 * @param {Map<number, number>|Object<number, number>} rateByYear
 *   per-year rate change percentages (e.g. {2022: 5, 2023: -3}).
 *   Accepts both Map and plain-object shapes; missing/NaN entries
 *   are treated as 0% (no change). Years present here but absent from
 *   `years` still contribute their rate change to the chain — only the
 *   returned factors are limited to the requested years.
 * @returns {Map<number, number>}  factor per requested year
 */
export function computeOnLevelFactors(years, rateByYear) {
  const factors = new Map();
  if (!Array.isArray(years) || years.length === 0) return factors;
  const getRate = (y) => {
    const v = rateByYear instanceof Map
      ? rateByYear.get(y)
      : rateByYear?.[y];
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  };
  const requested = new Set(years.filter((y) => Number.isFinite(y)));
  if (requested.size === 0) return factors;

  // Chain over the union of the requested years and every year carrying a
  // rate change. A requested list with gaps ([2020, 2024]) must still pick
  // up the 2021–2023 movements, or the documented contract above is
  // violated for every year before the gap.
  const chainYears = new Set(requested);
  const rateKeys = rateByYear instanceof Map
    ? rateByYear.keys()
    : Object.keys(rateByYear ?? {});
  for (const k of rateKeys) {
    const y = Number(k);
    if (Number.isFinite(y)) chainYears.add(y);
  }

  const sorted = [...chainYears].sort((a, b) => a - b);
  let factor = 1.0;
  for (let i = sorted.length - 1; i >= 0; i--) {
    const y = sorted[i];
    if (requested.has(y)) factors.set(y, factor);
    factor *= 1 + getRate(y) / 100;
  }
  return factors;
}

/**
 * Apply on-level factors to a per-year premium map. Returns one map
 * with adjusted premiums; years missing from `premiumByYear` are
 * dropped (we can't on-level what we don't have).
 *
 * @param {Map<number, number>|Object<number, number>} premiumByYear
 * @param {Map<number, number>} factorByYear  output of computeOnLevelFactors
 * @returns {Map<number, number>}
 */
export function applyOnLevelFactors(premiumByYear, factorByYear) {
  const out = new Map();
  const get = (y) => (premiumByYear instanceof Map ? premiumByYear.get(y) : premiumByYear?.[y]);
  for (const [year, factor] of factorByYear.entries()) {
    const p = Number(get(year));
    if (Number.isFinite(p)) out.set(year, p * factor);
  }
  return out;
}
