// server/src/lib/auditDiffSummaries.js
// Summary builders for the bulk-save audit events (triangle cells, large/cat
// loss lists). These mutations replace hundreds/thousands of rows at once, so
// the audit trail records a SUMMARY (counts + the selection toggles that
// matter for pricing), never a per-cell / per-field explosion. Shared by the
// treaty (treatyData.js) and quote (quotes.js) routes.
import { numOrNull } from '../helpers.js';

// Watch list for the loss-selection snapshot diff (services/audit.js diffAudit).
// The derived Pareto curve/key-point/fit JSON blobs are intentionally excluded —
// what matters for the trail are the inputs that drive the selected losses.
export const LOSS_SELECTION_FIELDS = [
  'threshold', 'global_factor', 'selected_count', 'total_loading_pct', 'active_distribution',
  'pareto_xm', 'pareto_alpha', 'pareto_limit', 'observation_years',
  'inflation_mode', 'inflation_index', 'inflation_rate_pct', 'inflation_base_year', 'inflation_to_year',
];

/**
 * Summarise a triangle bulk save: how many cells were added / removed / changed
 * between the previous and the new set (keyed by origin_year:dev_months, values
 * numeric-normalised so "10.00" === 10). Returns counts only — never the cells.
 * @param {Array<{origin_year:number,dev_months:number,cum_value:*}>} beforeCells
 * @param {Array<{origin_year:number,dev_months:number,cum_value:*}>} afterCells
 */
export function summarizeCellChanges(beforeCells, afterCells) {
  const key = (c) => `${c.origin_year}:${c.dev_months}`;
  const beforeMap = new Map((beforeCells || []).map((c) => [key(c), numOrNull(c.cum_value)]));
  const afterMap = new Map((afterCells || []).map((c) => [key(c), numOrNull(c.cum_value)]));
  let added = 0;
  let removed = 0;
  let changed = 0;
  for (const [k, v] of afterMap) {
    if (!beforeMap.has(k)) added += 1;
    else if (beforeMap.get(k) !== v) changed += 1;
  }
  for (const k of beforeMap.keys()) if (!afterMap.has(k)) removed += 1;
  return { before: beforeMap.size, after: afterMap.size, added, removed, changed };
}

/**
 * Summarise a large/cat loss bulk save: row counts, how many existing rows had
 * their amounts edited, and — the headline for compliance — every is_selected
 * toggle with its loss id. Rows are matched by loss_id; rows in the new set
 * with no matching prior id count as `added`.
 * @param {Array<{loss_id:*,is_selected:*,incurred:*,paid:*,os:*,inflation_factor:*}>} prevRows
 * @param {Array<{loss_id:*,is_selected:*,incurred:*,paid:*,os:*,inflation_factor:*}>} nextRows
 * @returns {{before:number,after:number,added:number,removed:number,amountChanged:number,
 *   selectionToggles:Array<{loss_id:string,from:boolean,to:boolean}>}}
 */
export function summarizeLossChanges(prevRows, nextRows) {
  const prevByKey = new Map((prevRows || []).map((r) => [String(r.loss_id), r]));
  let added = 0;
  let amountChanged = 0;
  const selectionToggles = [];
  const seen = new Set();
  for (const n of nextRows || []) {
    const key = n.loss_id != null ? String(n.loss_id) : null;
    const prev = key ? prevByKey.get(key) : null;
    if (!prev) { added += 1; continue; }
    seen.add(key);
    if (Boolean(prev.is_selected) !== Boolean(n.is_selected)) {
      selectionToggles.push({ loss_id: key, from: !!prev.is_selected, to: !!n.is_selected });
    }
    if (numOrNull(prev.incurred) !== numOrNull(n.incurred)
      || numOrNull(prev.paid) !== numOrNull(n.paid)
      || numOrNull(prev.os) !== numOrNull(n.os)
      || numOrNull(prev.inflation_factor) !== numOrNull(n.inflation_factor)) {
      amountChanged += 1;
    }
  }
  const removed = (prevRows || []).filter((r) => !seen.has(String(r.loss_id))).length;
  return { before: prevRows?.length || 0, after: nextRows?.length || 0, added, removed, amountChanged, selectionToggles };
}

/**
 * True when a loss summary records no material change — used to honour the
 * "write nothing if nothing changed" rule for the loss-list save audit.
 */
export function lossSummaryIsNoop(summary) {
  return summary.added === 0 && summary.removed === 0
    && summary.amountChanged === 0 && summary.selectionToggles.length === 0;
}

/**
 * Build a { layer_<n>: {watched fields} } map so a layer set diffs (via
 * diffAudit) as one summary event — added/removed/changed layers — rather than
 * a per-column explosion. Shared by the contract and quote NP routes.
 */
export function layerDiffMap(rows, fields) {
  const map = {};
  for (const r of rows || []) {
    const o = {};
    for (const f of fields) o[f] = r[f] ?? null;
    map[`layer_${r.layer_number}`] = o;
  }
  return map;
}

/** Union of own-enumerable keys across the given objects (diffAudit field list). */
export function unionKeys(...objs) {
  const set = new Set();
  for (const o of objs) for (const k of Object.keys(o || {})) set.add(k);
  return [...set];
}
