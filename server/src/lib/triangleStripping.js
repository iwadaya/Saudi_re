// server/src/lib/triangleStripping.js
// Produces the "stripped" variant of a claims triangle — the same cells
// with large- and cat-loss amounts removed so dev factors can be selected
// on the underlying attritional experience.
//
// Linkage: losses carry an underwriting year (= triangle origin_year) but
// no development period, so we infer the period a loss enters the triangle
// from its date_of_loss. A loss is assumed reported the quarter following
// the loss date, measured from the start of its underwriting year, and is
// subtracted from that development column onward (the triangle is
// cumulative). A loss with no usable date is treated as present from the
// first observed column.
//
// ALL large + cat losses are stripped regardless of their is_selected flag
// — selection only drives the Pareto / loss-selection curves, not the
// triangle basis.

// Which loss amount maps to each triangle type. Premium (and any
// non-claims type) is never stripped — losses don't reduce premium.
const STRIP_FIELD_BY_TYPE = {
  CLAIMS_PAID: 'paid',
  CLAIMS_OS: 'os',
  INCURRED: 'incurred',
};

export function stripFieldForType(type) {
  return STRIP_FIELD_BY_TYPE[String(type || '').toUpperCase()] || null;
}

// Development age (in months) at which a loss first appears in its row.
// "Appears the quarter after the loss date" → +3 months from the loss's
// age within its underwriting year.
export function lossEntryDevMonths(uwYear, dateOfLoss) {
  if (dateOfLoss == null) return 0;
  const d = dateOfLoss instanceof Date ? dateOfLoss : new Date(dateOfLoss);
  if (Number.isNaN(d.getTime())) return 0;
  const year = Number(uwYear);
  if (!Number.isFinite(year)) return 0;
  const ageMonths = (d.getUTCFullYear() - year) * 12 + d.getUTCMonth();
  return Math.max(0, ageMonths) + 3;
}

function num(v) {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Strip losses from triangle cells.
 *
 * @param {Array<{origin_year:number,dev_months:number,cum_value:number}>} cells
 * @param {Array<{uw_year:number,date_of_loss:*,paid:*,os:*,incurred:*}>} losses
 * @param {string|null} amountField  'paid' | 'os' | 'incurred' | null (no strip)
 * @returns {Array} cells with adjusted cum_value (originals untouched)
 */
export function stripTriangleCells(cells, losses, amountField) {
  const src = Array.isArray(cells) ? cells : [];
  if (!amountField || !Array.isArray(losses) || !losses.length) {
    // Nothing to strip — return clones so callers can treat full/stripped
    // as independent arrays.
    return src.map((c) => ({ ...c }));
  }

  // Pre-compute each loss's entry period + amount, grouped by origin year.
  const byYear = new Map();
  for (const l of losses) {
    const amt = num(l[amountField]);
    if (amt <= 0) continue;
    const yr = Number(l.uw_year);
    if (!Number.isFinite(yr)) continue;
    const entry = lossEntryDevMonths(yr, l.date_of_loss);
    if (!byYear.has(yr)) byYear.set(yr, []);
    byYear.get(yr).push({ entry, amt });
  }

  // Work row by row (origin_year), walking dev columns ascending so the
  // monotonic guard can lean on the prior stripped value.
  const rows = new Map();
  for (const c of src) {
    const yr = Number(c.origin_year);
    if (!rows.has(yr)) rows.set(yr, []);
    rows.get(yr).push(c);
  }

  const out = [];
  for (const [yr, rowCells] of rows) {
    const sorted = [...rowCells].sort((a, b) => Number(a.dev_months) - Number(b.dev_months));
    const lossesForYear = byYear.get(yr) || [];
    let prevStripped = 0;
    for (const c of sorted) {
      const dev = Number(c.dev_months);
      // Sum every loss that has entered the triangle by this dev column.
      let subtract = 0;
      for (const { entry, amt } of lossesForYear) {
        if (entry <= dev) subtract += amt;
      }
      const rawStripped = num(c.cum_value) - subtract;
      // Clamp to zero, then enforce cumulative monotonicity (never drop
      // below the prior stripped column). max() folds both rules together
      // since prevStripped is always >= 0.
      const stripped = Math.max(rawStripped, prevStripped);
      prevStripped = stripped;
      out.push({ ...c, cum_value: stripped });
    }
  }

  // Preserve the input ordering (origin_year, dev_months) callers expect.
  out.sort((a, b) =>
    Number(a.origin_year) - Number(b.origin_year) ||
    Number(a.dev_months) - Number(b.dev_months));
  return out;
}
