import { api } from '../api';
import { toN as cn } from '../utils/format';

/* Sum raw (non-inflated) incurred of ALL loss records, grouped by UW year.
   Falls back to paid + OS when an explicit incurred figure is absent.

   NO is_selected filter here — the server strips ALL large/CAT losses from
   the attritional triangle regardless of their selection flag (see
   server/src/lib/triangleStripping.js: "selection only drives the Pareto /
   loss-selection curves, not the triangle basis"). The add-back below must
   therefore cover exactly the same population the stripping removed;
   filtering deselected losses out silently dropped them from projected
   ultimates (the projection could even land below the actual diagonal). */
function sumByYear(payload) {
  const list = payload?.losses || payload?.rows || (Array.isArray(payload) ? payload : []);
  const map = new Map();
  let skipped = 0;
  for (const l of list) {
    // Missing uw_year must SKIP the loss, not bucket it under year 0:
    // Number(null) === 0 and Number('') === 0, both of which pass
    // Number.isFinite, so the finiteness guard alone let null/blank years
    // through as a phantom year-0 entry no real-year lookup could ever
    // reach (F99). Skipped losses are counted so callers can surface that
    // amounts were left out of the add-back rather than vanishing silently.
    if (l.uw_year == null || l.uw_year === '') { skipped++; continue; }
    const yr = Number(l.uw_year);
    if (!Number.isFinite(yr)) { skipped++; continue; }
    const inc = cn(l.incurred) || (cn(l.paid) + cn(l.os));
    map.set(yr, (map.get(yr) || 0) + inc);
  }
  return { map, skipped };
}

/* Per-UW-year large-loss and CAT-loss amounts for a treaty, summed from the
   saved loss grids using raw incurred values. Returns two Maps keyed by year,
   plus `skipped` counts of losses excluded for having no usable uw_year. */
export async function loadLossCategoryByYear(contractId, opts) {
  if (!contractId) return { large: new Map(), cat: new Map(), skipped: { large: 0, cat: 0 } };
  const [largeData, catData] = await Promise.all([
    api.getLargeLosses(contractId, opts).catch(() => null),
    api.getCatLosses(contractId, opts).catch(() => null),
  ]);
  const large = sumByYear(largeData);
  const cat = sumByYear(catData);
  return {
    large: large.map,
    cat: cat.map,
    skipped: { large: large.skipped, cat: cat.skipped },
  };
}

/* Single source of truth for the projected-summary loss model.
   Incurred Loss is ALWAYS the sum of its three components — never sourced or
   calculated independently. Large and CAT are passed straight through from the
   saved loss grids (raw incurred) and are never projected; attritional is what
   remains of the incurred total (projected or actual) once large + CAT are
   removed.

   Pass `incurredTotal` as the projected ultimate loss for the projected basis,
   or the raw incurred for the actual basis. `large`/`cat` are the same raw
   saved figures in both bases. */
export function deriveLossComponents({ premium = 0, incurredTotal = 0, large = 0, cat = 0 }) {
  // NOTE: Zero-floor applied to all loss components. Exception: clean cut treaties may legitimately
  // produce negative loss figures due to profit commissions and adjustments. When building clean
  // cut treaty support, revisit this floor and make it configurable per treaty type.
  const largeAmt = Math.max(0, large);
  const catAmt = Math.max(0, cat);
  const attritional = Math.max(0, incurredTotal - largeAmt - catAmt);
  const incurred = attritional + largeAmt + catAmt;
  const lr = n => (premium > 0 ? n / premium : 0);
  return {
    premium,
    attritional,
    large: largeAmt,
    cat: catAmt,
    incurred,
    attrLR: lr(attritional),
    largeLR: lr(largeAmt),
    catLR: lr(catAmt),
    incurredLR: lr(incurred),
  };
}
