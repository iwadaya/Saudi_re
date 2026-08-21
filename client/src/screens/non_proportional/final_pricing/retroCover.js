// src/screens/non_proportional/final_pricing/retroCover.js
//
// Retro (outward reinsurance) cover analysis for the offer modal.
//
// The offer modal suggests a written line; this module answers the question the
// underwriter actually has to answer before committing to it: what does that
// line do to our own retro programme, and is it the line that gets the best
// return out of the retro capacity it consumes?
//
// Model — a written line L on the inward tower produces, for a full-tower event:
//
//   gross event loss   Σ layer limit × L
//   gross premium      Σ layer 100% premium × L
//   gross expected loss Σ layer limit × technical ROL × L   (technical ratio is
//                                                            the break-even ROL,
//                                                            same units as ROL)
//
// The outward programme sits on top of that in the usual order:
//
//   1. Retro quota share — cedes `cessionPct` of premium and loss, earns
//      `commissionPct` ceding commission on the ceded premium.
//   2. Retro XL — `limitAmt` xs `retentionAmt` on what is left, less whatever
//      the rest of the book has already burned (`usedLimitAmt`). Cost of cover
//      is charged on the limit this treaty actually consumes, at `rolPct`.
//
// Anything above retention + available limit is unprotected: the line is not
// fully covered by the programme and the excess is a net retention the
// programme was never bought to carry.
//
// Optimisation runs on return on retained capacity — net margin per unit of net
// retained event loss. Below the retention every extra point of line is fully
// retained, so the return is flat; above it the retro absorbs the exposure and
// the return climbs while premium grows against a fixed retention; once the
// retro cost outruns the marginal margin, or the limit runs out and the
// retention starts growing again, it falls away. The peak is the retro-optimal
// line.
//
// The programme itself is not guessed here: it is the outward retro contract an
// admin captures for the underwriting year (server table `retro_programme`),
// read through programmeFromRecord(). Without a record for the treaty's year and
// currency there is no analysis to show — see retroVerdict's NO_PROGRAMME.
//
// Pure functions only — no React, no DOM, no storage.

import { toN, fmtC } from './formatters.js';

/**
 * @typedef {Object} RetroProgramme
 * @property {number} cessionPct     Retro quota share cession, % of the written line.
 * @property {number} commissionPct  Ceding commission earned on the ceded premium, %.
 * @property {number} retentionAmt   Net retained priority per event, treaty currency.
 * @property {number} limitAmt       Retro XL limit in excess of the retention.
 * @property {number} rolPct         Retro XL rate on line, % — the cost of cover.
 * @property {number} usedLimitAmt   Retro XL limit already consumed by the rest of the book.
 * @property {number} maxLinePct     Largest line the optimiser is allowed to consider, %.
 */

/**
 * @typedef {Object} RetroLayer
 * @property {string} label
 * @property {number} limit       100% limit.
 * @property {number} premium100  100% premium.
 * @property {number} techRolPct  Technical (break-even) rate on line, %.
 */

/** Line grid resolution for the optimisation curve, in line points. */
export const LINE_STEP_PCT = 0.25;

/**
 * Field defaults. These are NOT a stand-in programme — an absent record means
 * no analysis at all. They only fill a column the admin left blank on a record
 * that does exist (a programme with no quota share, say).
 */
export const PROGRAMME_DEFAULTS = {
  cessionPct: 0,
  commissionPct: 0,
  retentionAmt: 0,
  limitAmt: 0,
  rolPct: 0,
  usedLimitAmt: 0,
  maxLinePct: 25,
};

const clamp = (n, lo, hi) => Math.min(hi, Math.max(lo, n));

/**
 * Turn the offer modal's per-layer rows into the shape this module wants.
 * `layerData` carries limit + 100% premium; the technical ratio lives on the
 * raw layer (per layer) and falls back to the treaty average.
 *
 * @param {Array<{layer?: string, limit?: number, ep100?: number}>} layerData
 * @param {Array<Record<string, any>>} rawLayers
 * @param {number} techRatioAvgPct
 * @returns {RetroLayer[]}
 */
export function buildRetroLayers(layerData, rawLayers = [], techRatioAvgPct = 0) {
  return (layerData || []).map((r, i) => {
    const raw = rawLayers[i] || {};
    const own = toN(String(raw.technicalRatio ?? raw.techRatio ?? '').replace(/%/g, ''));
    return {
      label: r.layer || `L${i + 1}`,
      limit: toN(r.limit),
      premium100: toN(r.ep100),
      techRolPct: own > 0 ? own : toN(techRatioAvgPct),
    };
  });
}

/**
 * Map the admin-captured `retro_programme` record onto the shape the maths
 * wants. Returns null for no record — the caller must say "no programme", not
 * analyse against zeros.
 *
 * @param {Record<string, any>|null|undefined} record
 * @returns {(RetroProgramme & {uwYear: number, currency: string, label: string|null})|null}
 */
export function programmeFromRecord(record) {
  if (!record) return null;
  return {
    ...normaliseProgramme({
      cessionPct: record.cession_pct,
      commissionPct: record.commission_pct,
      retentionAmt: record.retention_amt,
      limitAmt: record.limit_amt,
      rolPct: record.rol_pct,
      usedLimitAmt: record.used_limit_amt,
      maxLinePct: record.max_line_pct,
    }),
    uwYear: toN(record.uw_year),
    currency: record.currency || '',
    label: record.label || null,
  };
}

/** Coerce anything — a record, a what-if edit — into a usable programme.
 *  Absent fields fall back to the field default; an emptied field reads as 0. */
export function normaliseProgramme(raw) {
  const p = raw || {};
  const num = (v, d) => (v === undefined || v === null ? d : toN(v));
  return {
    cessionPct: clamp(num(p.cessionPct, PROGRAMME_DEFAULTS.cessionPct), 0, 100),
    commissionPct: clamp(num(p.commissionPct, PROGRAMME_DEFAULTS.commissionPct), 0, 100),
    retentionAmt: Math.max(0, num(p.retentionAmt, PROGRAMME_DEFAULTS.retentionAmt)),
    limitAmt: Math.max(0, num(p.limitAmt, PROGRAMME_DEFAULTS.limitAmt)),
    rolPct: clamp(num(p.rolPct, PROGRAMME_DEFAULTS.rolPct), 0, 100),
    usedLimitAmt: Math.max(0, num(p.usedLimitAmt, 0)),
    maxLinePct: clamp(num(p.maxLinePct, PROGRAMME_DEFAULTS.maxLinePct), 1, 100),
  };
}

/**
 * The retro position produced by one written line.
 *
 * @param {RetroLayer[]} layers
 * @param {RetroProgramme} programme  Already normalised.
 * @param {number|number[]} line  Uniform line %, or one line % per layer.
 */
export function retroImpact(layers, programme, line) {
  const lineFor = i => toN(Array.isArray(line) ? line[i] : line) / 100;
  let grossEventLoss = 0, grossPremium = 0, grossExpLoss = 0, weightedLine = 0, totalLimit = 0;

  (layers || []).forEach((l, i) => {
    const f = Math.max(0, lineFor(i));
    const limit = toN(l.limit);
    grossEventLoss += limit * f;
    grossPremium += toN(l.premium100) * f;
    grossExpLoss += limit * (toN(l.techRolPct) / 100) * f;
    weightedLine += limit * f;
    totalLimit += limit;
  });

  const linePct = totalLimit > 0
    ? (weightedLine / totalLimit) * 100
    : (Array.isArray(line) ? 0 : toN(line));

  // 1 — retro quota share.
  const c = programme.cessionPct / 100;
  const cededPremium = grossPremium * c;
  const commissionIncome = cededPremium * (programme.commissionPct / 100);
  const qsNetPremium = grossPremium - cededPremium + commissionIncome;
  const qsNetExpLoss = grossExpLoss * (1 - c);
  const qsNetEventLoss = grossEventLoss * (1 - c);

  // 2 — retro XL on what the quota share leaves behind.
  const availableLimit = Math.max(0, programme.limitAmt - programme.usedLimitAmt);
  const aboveRetention = Math.max(0, qsNetEventLoss - programme.retentionAmt);
  const retroRecovery = Math.min(aboveRetention, availableLimit);
  const unprotected = aboveRetention - retroRecovery;
  const netRetainedEvent = qsNetEventLoss - retroRecovery;
  const retroCost = retroRecovery * (programme.rolPct / 100);

  const netPremium = qsNetPremium - retroCost;
  const netMargin = netPremium - qsNetExpLoss;
  const grossMargin = grossPremium - grossExpLoss;

  return {
    linePct,
    grossEventLoss, grossPremium, grossExpLoss, grossMargin,
    grossMarginPct: grossPremium > 0 ? (grossMargin / grossPremium) * 100 : 0,
    cededPremium, commissionIncome, qsNetPremium, qsNetExpLoss, qsNetEventLoss,
    availableLimit, retroRecovery, unprotected, netRetainedEvent, retroCost,
    netPremium, netMargin,
    netMarginPct: netPremium > 0 ? (netMargin / netPremium) * 100 : 0,
    retroCostRatioPct: grossPremium > 0 ? (retroCost / grossPremium) * 100 : 0,
    retentionUtilPct: programme.retentionAmt > 0
      ? (netRetainedEvent / programme.retentionAmt) * 100
      : (netRetainedEvent > 0 ? 100 : 0),
    retroLimitUtilPct: availableLimit > 0 ? (retroRecovery / availableLimit) * 100 : 0,
    // Return on the capacity the line actually retains. The floor of 1 keeps a
    // fully-protected, zero-retention line comparable instead of dividing by 0.
    returnOnCapacity: netMargin / Math.max(netRetainedEvent, 1),
    fullyProtected: unprotected <= 0,
    profitable: netMargin > 0,
  };
}

/**
 * Sweep the line from one step up to the programme's ceiling.
 *
 * @param {RetroLayer[]} layers
 * @param {RetroProgramme} programme  Already normalised.
 * @param {{step?: number}} [opts]
 */
export function retroLineCurve(layers, programme, opts = {}) {
  const step = opts.step || LINE_STEP_PCT;
  const out = [];
  for (let line = step; line <= programme.maxLinePct + 1e-9; line += step) {
    out.push(retroImpact(layers, programme, Math.round(line * 1000) / 1000));
  }
  return out;
}

/**
 * Pick the line that gets the most out of the retro programme.
 *
 * Preference order: fully protected and profitable → fully protected →
 * nothing (the programme cannot cover any line of this treaty). Ties go to the
 * larger line — the same return on capacity for more absolute margin. That
 * matters below the retention, where every line retains its whole exposure and
 * the return is flat: without it the optimiser would collapse onto the smallest
 * line on the grid.
 */
export function optimiseLine(curve) {
  const protectedRows = (curve || []).filter(r => r.fullyProtected);
  const candidates = protectedRows.filter(r => r.profitable);
  const pool = candidates.length ? candidates : protectedRows;
  // Ascending sweep + `>=` (within float noise) keeps the larger line on a tie.
  const atLeast = (a, b) => a >= b - Math.abs(b) * 1e-9;
  const best = pool.reduce((b, r) => (b && !atLeast(r.returnOnCapacity, b.returnOnCapacity) ? b : r), null);
  const marginPeak = pool.reduce((b, r) => (b && !atLeast(r.netMargin, b.netMargin) ? b : r), null);
  const capacity = protectedRows.length ? protectedRows[protectedRows.length - 1] : null;
  return { optimal: best, marginPeak, capacity, constrained: candidates.length === 0 };
}

/**
 * The whole analysis the panel renders: the suggested line, the line currently
 * written, the retro-optimal line, and the curve behind them.
 *
 * @param {RetroLayer[]} layers
 * @param {RetroProgramme} rawProgramme
 * @param {{suggestedLinePct?: number, currentLines?: number[]|number}} [opts]
 */
export function analyseRetroCover(layers, rawProgramme, opts = {}) {
  const programme = normaliseProgramme(rawProgramme);
  // No retro contract captured for this year and currency: nothing to price a
  // line through, and inventing one would be worse than saying so.
  if (!rawProgramme) {
    return {
      programme, curve: [], hasProgramme: false,
      hasExposure: (layers || []).some(l => toN(l.limit) > 0),
      suggestedLinePct: toN(opts.suggestedLinePct),
      suggested: null, current: null, optimal: null, marginPeak: null,
      capacity: null, constrained: false,
    };
  }
  const curve = retroLineCurve(layers, programme);
  const { optimal, marginPeak, capacity, constrained } = optimiseLine(curve);
  const suggestedLinePct = toN(opts.suggestedLinePct);
  const hasCurrent = Array.isArray(opts.currentLines)
    ? opts.currentLines.some(v => toN(v) > 0)
    : toN(opts.currentLines) > 0;

  return {
    programme,
    curve,
    hasProgramme: true,
    hasExposure: (layers || []).some(l => toN(l.limit) > 0),
    suggestedLinePct,
    suggested: suggestedLinePct > 0 ? retroImpact(layers, programme, suggestedLinePct) : null,
    current: hasCurrent ? retroImpact(layers, programme, opts.currentLines) : null,
    optimal,
    marginPeak,
    capacity,
    constrained,
  };
}

/**
 * Plain-language read on the suggested line versus the retro-optimal one.
 * Status drives the banner colour: BREACH / OVER / HEADROOM / ALIGNED / NONE.
 *
 * @param {ReturnType<typeof analyseRetroCover>} analysis
 * @param {{money?: (n: number) => string}} [fmt]
 */
export function retroVerdict(analysis, fmt = {}) {
  const money = fmt.money || (n => fmtC(Math.round(n)));
  const pct1 = n => `${(Number.isFinite(n) ? n : 0).toFixed(1)}%`;
  // Lines sit on a quarter-point grid, so keep 2dp but drop dead zeros:
  // 16.5%, 3.25%, 10%.
  const line1 = n => `${(Number.isFinite(n) ? n : 0).toFixed(2).replace(/\.?0+$/, '')}%`;
  const { suggested, optimal, capacity } = analysis || {};

  if (!analysis?.hasExposure) {
    return { status: 'NONE', headline: 'No layer limits yet', detail: 'Enter layer limits and pricing to see the retro impact of a line.' };
  }
  if (!analysis.hasProgramme) {
    return {
      status: 'NO_PROGRAMME',
      headline: 'No retro contract captured',
      detail: 'The outward retro programme for this treaty\'s underwriting year and currency has not been entered yet. An administrator captures it under Admin → Retro Programme.',
    };
  }
  if (!suggested) {
    return { status: 'NONE', headline: 'No line suggestion yet', detail: 'Run the pricing engine to generate a suggested line to test against the retro programme.' };
  }

  const used = pct1(suggested.retroLimitUtilPct);
  const cost = money(suggested.retroCost);

  if (!suggested.fullyProtected) {
    return {
      status: 'BREACH',
      headline: `${line1(suggested.linePct)} breaches the retro programme`,
      detail: `Net event loss of ${money(suggested.qsNetEventLoss)} leaves ${money(suggested.unprotected)} above retention + available limit. `
        + (capacity ? `${line1(capacity.linePct)} is the largest fully-protected line.` : 'No line of this treaty is fully protected by the programme as entered.'),
    };
  }
  if (!optimal) {
    return {
      status: 'BREACH',
      headline: 'Programme cannot cover this treaty',
      detail: 'No line clears the retro retention and limit as entered — check the assumptions.',
    };
  }

  const delta = optimal.linePct - suggested.linePct;
  if (delta > LINE_STEP_PCT) {
    return {
      status: 'HEADROOM',
      headline: `Retro headroom to ${line1(optimal.linePct)}`,
      detail: `${line1(suggested.linePct)} uses ${used} of the retro limit at ${cost} of cover. `
        + `${line1(optimal.linePct)} stays fully protected and lifts net margin from ${money(suggested.netMargin)} to ${money(optimal.netMargin)}.`,
    };
  }
  if (delta < -LINE_STEP_PCT) {
    return {
      status: 'OVER',
      headline: `Retro-optimal line is ${line1(optimal.linePct)}`,
      detail: `${line1(suggested.linePct)} costs ${cost} of retro cover for ${money(suggested.netMargin)} of net margin. `
        + `${line1(optimal.linePct)} retains ${money(optimal.netRetainedEvent)} for ${money(optimal.netMargin)} — a better return on the capacity used.`,
    };
  }
  return {
    status: 'ALIGNED',
    headline: `${line1(suggested.linePct)} is retro-optimal`,
    detail: `Fully protected, ${used} of the retro limit consumed at ${cost} of cover, `
      + `${money(suggested.netRetainedEvent)} net retained per event.`,
  };
}

/**
 * The offer modal's AI line suggestion, extracted so the retro panel tests the
 * same number the modal applies. Margin quality (60%) and balance — tower
 * against EGNPI — (40%), scaled onto a 1–20% line.
 *
 * @param {{layers: Array<{limit?: number, rolPct?: number}>, egnpi?: number, techRatioAvgPct?: number}} input
 */
export function aiLineSuggestion({ layers = [], egnpi = 0, techRatioAvgPct = 0 } = {}) {
  const totalLimit = layers.reduce((s, r) => s + toN(r.limit), 0);
  const rolLayers = layers.filter(r => toN(r.rolPct) > 0);
  const avgRolPct = rolLayers.length ? rolLayers.reduce((s, r) => s + toN(r.rolPct), 0) / rolLayers.length : 0;
  const techR = toN(techRatioAvgPct) / 100;
  const marginAct = avgRolPct > 0 && techR > 0 ? Math.max(0, (avgRolPct / 100) - techR) : 0;
  const balanceRatio = toN(egnpi) > 0 ? totalLimit / toN(egnpi) : 0;
  const mQ = clamp(marginAct / 0.3, 0, 1);
  const bQ = clamp(balanceRatio / 60, 0, 1);
  const linePct = Math.max(1, Math.min(20, Math.round((mQ * 0.6 + bQ * 0.4) * 20 * 10) / 10 || 10));
  const reason = marginAct >= 0.15
    ? `Strong margin (${(marginAct * 100).toFixed(1)}%) — full line supportable.`
    : marginAct >= 0.08
      ? `Acceptable margin (${(marginAct * 100).toFixed(1)}%) — moderate line.`
      : techR > 0
        ? `Thin margin (${(marginAct * 100).toFixed(1)}%) — conservative line advised.`
        : 'Run pricing engine to generate suggestion.';
  return { linePct, reason, avgRolPct, marginAct, balanceRatio, totalLimit };
}
