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

// Age in months of `dateLike` relative to the start of its underwriting
// year. Returns null when the date (or year) is missing/unparseable.
function ageMonths(uwYear, dateLike) {
  if (dateLike == null) return null;
  const d = dateLike instanceof Date ? dateLike : new Date(dateLike);
  if (Number.isNaN(d.getTime())) return null;
  const year = Number(uwYear);
  if (!Number.isFinite(year)) return null;
  return Math.max(0, (d.getUTCFullYear() - year) * 12 + d.getUTCMonth());
}

// Development age (in months) at which a loss first appears in its row.
//
// A loss surfaces in the triangle the quarter *after* it is reported, so
// when a reliable actuarial reported date is available we use its age plus a
// quarter. Otherwise we fall back to the loss date plus a quarter — the proxy
// used before per-loss reported dates existed.
//
// The reported date is only trusted when it (a) is on or after the loss date
// — a loss can't be reported before it happens — and (b) its resulting entry
// period lands within the row's observed development range. Both guards
// matter because a stale/auto-set reported date (e.g. defaulted far in the
// future) would otherwise compute an entry period past the triangle and never
// strip; in that case we fall back to the loss-date proxy.
export function resolveLossEntry(uwYear, dateOfLoss, reportedDate, rowMaxDev) {
  const lossAge = ageMonths(uwYear, dateOfLoss);
  const proxyEntry = lossAge == null ? 0 : lossAge + 3;
  const repAge = ageMonths(uwYear, reportedDate);
  if (repAge != null && repAge >= (lossAge ?? 0)) {
    const repEntry = repAge + 3; // surfaces the quarter after reporting
    if (rowMaxDev == null || repEntry <= rowMaxDev) {
      // 'reported' = placed precisely from the actuarial reported date.
      return { entry: repEntry, basis: 'reported' };
    }
  }
  // 'proxy' = placed approximately from the loss date (reporting date absent
  // or implausible) — the actuary should verify these.
  return { entry: proxyEntry, basis: 'proxy' };
}

export function lossEntryDevMonths(uwYear, dateOfLoss, reportedDate, rowMaxDev) {
  return resolveLossEntry(uwYear, dateOfLoss, reportedDate, rowMaxDev).entry;
}

// Max observed dev_months per origin year, used to resolve each loss's entry.
function maxDevByOriginYear(cells) {
  const m = new Map();
  for (const c of Array.isArray(cells) ? cells : []) {
    const yr = Number(c.origin_year);
    const dev = Number(c.dev_months);
    if (!m.has(yr) || dev > m.get(yr)) m.set(yr, dev);
  }
  return m;
}

// Counts how many strippable losses were placed precisely (from a reliable
// reported date) versus approximately (loss-date proxy). Lets the UI flag the
// guessed placements.
export function summarizeLossPlacement(cells, losses, amountField) {
  const out = { reported: 0, proxy: 0, total: 0 };
  if (!amountField || !Array.isArray(losses)) return out;
  const maxDev = maxDevByOriginYear(cells);
  for (const l of losses) {
    if (num(l[amountField]) <= 0) continue;
    const yr = Number(l.uw_year);
    if (!Number.isFinite(yr) || !maxDev.has(yr)) continue; // no matching row → not placed
    const rowMaxDev = maxDev.get(yr);
    const { entry, basis } = resolveLossEntry(yr, l.date_of_loss, l.actuarial_reported_date, rowMaxDev);
    // Only count losses that actually enter within the observed triangle. A
    // loss whose entry period is past the latest observed dev column is not
    // stripped from any observed cell, so it shouldn't be flagged as placed.
    if (entry > rowMaxDev) continue;
    out[basis] += 1;
    out.total += 1;
  }
  return out;
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

  // Group losses by origin year, keeping the raw dates — the entry period is
  // resolved per row below, where the row's observed dev range is known.
  const byYear = new Map();
  for (const l of losses) {
    const amt = num(l[amountField]);
    if (amt <= 0) continue;
    const yr = Number(l.uw_year);
    if (!Number.isFinite(yr)) continue;
    if (!byYear.has(yr)) byYear.set(yr, []);
    // The actuarial reported date (when the loss was booked into the
    // triangle) drives the entry period — not reported_date, which is the
    // "saved into Universe" timestamp.
    byYear.get(yr).push({ amt, dateOfLoss: l.date_of_loss, reportedDate: l.actuarial_reported_date });
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
    const rowMaxDev = sorted.length ? Number(sorted[sorted.length - 1].dev_months) : null;
    const lossesForYear = (byYear.get(yr) || []).map((l) => ({
      amt: l.amt,
      entry: lossEntryDevMonths(yr, l.dateOfLoss, l.reportedDate, rowMaxDev),
    }));
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
