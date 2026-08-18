// shared/fac/num.js
//
// Numeric coercion for the facultative pipeline.
//
// These exist because `Number(null)` is `0` and `Number('')` is `0`, and
// both are `Number.isFinite`. A bare `Number.isFinite(Number(v))` guard
// therefore treats "no value" as "zero", which has bitten this module in
// three different places and in three different ways: a missing figure
// rendered as `0` instead of `—`; a candidate with no rate silently
// dragging a weighted blend toward zero; and an adequacy ratio of 0%
// reported for a quote that had no rate at all.
//
// Zero and absent are different statements about a price. Keep them apart.

/** Number, or null when the value is absent rather than zero. */
export function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

/** Number, defaulting absent/unparseable to 0. Use only where 0 is the honest default. */
export function num(v, fallback = 0) {
  const n = numOrNull(v);
  return n === null ? fallback : n;
}

/** True when the value is a real, finite number — not blank, not NaN. */
export function isNum(v) {
  return numOrNull(v) !== null;
}
