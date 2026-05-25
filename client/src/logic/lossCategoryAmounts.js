import { api } from '../api';
import { toN as cn } from '../utils/format';

/* Sum raw (non-inflated) incurred of selected loss records, grouped by UW year.
   Falls back to paid + OS when an explicit incurred figure is absent. */
function sumByYear(payload) {
  const list = payload?.losses || payload?.rows || (Array.isArray(payload) ? payload : []);
  const map = new Map();
  for (const l of list) {
    if (l.is_selected === false) continue;
    const yr = Number(l.uw_year);
    if (!Number.isFinite(yr)) continue;
    const inc = cn(l.incurred) || (cn(l.paid) + cn(l.os));
    map.set(yr, (map.get(yr) || 0) + inc);
  }
  return map;
}

/* Per-UW-year large-loss and CAT-loss amounts for a treaty, summed from the
   saved loss grids using raw incurred values. Returns two Maps keyed by year. */
export async function loadLossCategoryByYear(contractId, opts) {
  if (!contractId) return { large: new Map(), cat: new Map() };
  const [largeData, catData] = await Promise.all([
    api.getLargeLosses(contractId, opts).catch(() => null),
    api.getCatLosses(contractId, opts).catch(() => null),
  ]);
  return { large: sumByYear(largeData), cat: sumByYear(catData) };
}
