// shared/retroImpact.js — retrocession impact on inwards line size.
//
// The offer modals ask two questions once a retro programme is in play:
//
//   1. What does our retro actually do to THIS line? (spend, recoveries,
//      PML relief, net result once the outwards cost is paid.)
//   2. Given that retro, what line should we write? A bigger line earns
//      more margin but the retro XL cover is a FIXED structure — its
//      spend does not scale, its limit does not stretch — so recoveries
//      thin out relative to exposure as the line grows. That tension has
//      an interior optimum, which is what `optimiseRetroLine` finds.
//
// Everything here is pure: same numbers on the client (live modal) and
// the server (validation / export), no I/O, no framework.
//
// Loss model. The subject aggregate is Lognormal with mean = expected
// loss at the line being tested and a caller-supplied CV. Lognormal
// keeps the layer cost positive and right-skewed, which is what matters
// at the attachment a retro programme sits at; a Normal approximation
// under-prices that tail. The retro QS is applied first (it is a share
// of every loss, so it simply scales the mean), then the XL sits on the
// net-of-QS aggregate.

import {
  clamp,
  layerHit,
  lognormalFromMeanCv,
  lognormalLayerMean,
  lognormalQuantile,
} from './pricingMath.js';

/** Return period the capital charge and the PML rows are struck at. */
export const RETRO_PML_PROBABILITY = 0.99;

/** Line grid the optimiser scans, in percentage points. */
export const RETRO_LINE_STEP_PCT = 0.5;

/**
 * @typedef {Object} RetroSubject  The inwards treaty at 100%.
 * @property {number} grossPremium100   100% premium (prop EPI, or Σ layer premium for XL).
 * @property {number} grossLimit100     100% limit / capacity.
 * @property {number} expectedLossRatio Expected loss ÷ premium, gross of retro (0..n).
 * @property {number} expenseRatio      Deterministic expense load ÷ premium (commissions,
 *                                      brokerage, taxes on the inwards treaty).
 * @property {number} lossCv            CV of the aggregate loss on the subject book.
 * @property {number} authorityMaxLimit Largest line limit the underwriter may commit.
 * @property {number} [maxLinePct]      Hard cap on the line, default 100.
 */

/**
 * @typedef {Object} RetroProgramme  The outwards protection, in percent / currency.
 * @property {number} qsCessionPct       Share of the written line ceded to retro QS.
 * @property {number} qsCommissionPct    Ceding commission received on ceded premium.
 * @property {boolean} xlEnabled         Whether the retro XL is bought at all.
 * @property {number} xlAttachment       Aggregate attachment of the retro XL (currency).
 * @property {number} xlLimit            Width of the retro XL (currency).
 * @property {number} xlRolPct           Rate on line — the XL premium is limit × ROL.
 * @property {number} xlReinstatements   Number of reinstatements (aggregate cover = limit × (1+r)).
 * @property {number} xlReinstatementPct Reinstatement premium as % of the XL premium.
 * @property {number} costOfCapitalPct   Charge applied to the net 1-in-100 downside.
 */

/** Programme used when the screen has nothing saved. */
export const DEFAULT_RETRO_PROGRAMME = Object.freeze({
  qsCessionPct: 20,
  qsCommissionPct: 27.5,
  xlEnabled: true,
  xlAttachment: 0,
  xlLimit: 0,
  xlRolPct: 12,
  xlReinstatements: 1,
  xlReinstatementPct: 100,
  costOfCapitalPct: 15,
});

const num = (v, fallback = 0) => {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? '').replace(/[^0-9.eE+-]/g, ''));
  return Number.isFinite(n) ? n : fallback;
};

/**
 * A sane starting programme for a treaty whose size we know. The XL is
 * sized off the expected loss at the seed line — a working layer
 * attaching at 1.5× the expected annual loss and covering 2× it —
 * which is roughly where a whole-account retro layer sits before the
 * underwriter tunes it in the modal.
 *
 * @param {{grossPremium100: number, expectedLossRatio: number, seedLinePct?: number,
 *          overrides?: Partial<RetroProgramme>}} params
 * @returns {RetroProgramme}
 */
export function defaultRetroProgramme({
  grossPremium100,
  expectedLossRatio,
  seedLinePct = 10,
  overrides = {},
} = {}) {
  const prem = Math.max(0, num(grossPremium100));
  const lr = Math.max(0, num(expectedLossRatio));
  const line = clamp(num(seedLinePct, 10), 0.5, 100) / 100;
  const expectedLoss = prem * lr * line;
  const round = (n) => {
    if (!(n > 0)) return 0;
    const mag = 10 ** Math.max(0, Math.floor(Math.log10(n)) - 1);
    return Math.round(n / mag) * mag;
  };
  return {
    ...DEFAULT_RETRO_PROGRAMME,
    xlAttachment: round(expectedLoss * 1.5),
    xlLimit: round(expectedLoss * 2),
    ...overrides,
  };
}

/** Normalise loose UI input (strings, blanks, negatives) into a usable programme. */
export function normaliseProgramme(programme = {}) {
  return {
    qsCessionPct: clamp(num(programme.qsCessionPct), 0, 100),
    qsCommissionPct: clamp(num(programme.qsCommissionPct), 0, 100),
    xlEnabled: programme.xlEnabled !== false,
    xlAttachment: Math.max(0, num(programme.xlAttachment)),
    xlLimit: Math.max(0, num(programme.xlLimit)),
    xlRolPct: clamp(num(programme.xlRolPct), 0, 100),
    xlReinstatements: clamp(Math.round(num(programme.xlReinstatements)), 0, 10),
    xlReinstatementPct: clamp(num(programme.xlReinstatementPct), 0, 200),
    costOfCapitalPct: clamp(num(programme.costOfCapitalPct), 0, 100),
  };
}

/** Normalise the subject treaty the same way. */
export function normaliseSubject(subject = {}) {
  return {
    grossPremium100: Math.max(0, num(subject.grossPremium100)),
    grossLimit100: Math.max(0, num(subject.grossLimit100)),
    expectedLossRatio: Math.max(0, num(subject.expectedLossRatio)),
    expenseRatio: Math.max(0, num(subject.expenseRatio)),
    // A book with no volatility has no retro story; floor the CV so the
    // layer maths stays meaningful when the caller passes 0.
    lossCv: clamp(num(subject.lossCv, 0.5) || 0.5, 0.05, 5),
    authorityMaxLimit: Math.max(0, num(subject.authorityMaxLimit)),
    maxLinePct: clamp(num(subject.maxLinePct, 100) || 100, 1, 100),
  };
}

/**
 * Full gross → net walk for one candidate line.
 *
 * Sign convention: `retroSpend` is money out (ceded premium net of
 * commission, plus the XL premium and its expected reinstatement),
 * `retroRecovery` is money expected back (the QS share of losses plus
 * the XL's expected layer loss). `retroNetCost` is spend − recovery, so
 * a negative net cost means the programme is expected to pay for itself.
 *
 * @param {{linePct: number, subject: RetroSubject, programme: RetroProgramme}} params
 * @returns {Object} the full evaluation — see the fields assembled below.
 */
export function evaluateRetroAtLine({ linePct, subject, programme } = {}) {
  const s = normaliseSubject(subject);
  const p = normaliseProgramme(programme);
  const lineFrac = clamp(num(linePct), 0, 100) / 100;

  // ── Gross (pre-retro) position ────────────────────────────────────
  const grossPremium = s.grossPremium100 * lineFrac;
  const grossExpectedLoss = grossPremium * s.expectedLossRatio;
  const grossExpenses = grossPremium * s.expenseRatio;
  const grossLimit = s.grossLimit100 * lineFrac;
  const grossResult = grossPremium - grossExpectedLoss - grossExpenses;
  const grossParams = lognormalFromMeanCv(grossExpectedLoss, s.lossCv);
  const grossPml = grossParams
    ? lognormalQuantile(grossParams.mu, grossParams.sigma, RETRO_PML_PROBABILITY)
    : 0;

  // ── Retro quota share ─────────────────────────────────────────────
  const q = p.qsCessionPct / 100;
  const qsCededPremium = grossPremium * q;
  const qsCommission = qsCededPremium * (p.qsCommissionPct / 100);
  const qsRecovery = grossExpectedLoss * q;
  const qsNetCost = qsCededPremium - qsCommission - qsRecovery;

  const premiumAfterQs = grossPremium - qsCededPremium + qsCommission;
  const lossAfterQs = grossExpectedLoss * (1 - q);

  // ── Retro excess of loss, sitting on the net-of-QS aggregate ──────
  // No subject premium means no treaty to protect — don't charge the
  // absolute-sized XL premium against an empty position.
  const xlLive = p.xlEnabled && p.xlLimit > 0 && grossPremium > 0;
  const xlCover = xlLive ? p.xlLimit * (1 + p.xlReinstatements) : 0;
  const xlPremium = xlLive ? p.xlLimit * (p.xlRolPct / 100) : 0;
  const netParams = lognormalFromMeanCv(lossAfterQs, s.lossCv);
  const xlRecovery = xlLive && netParams
    ? lognormalLayerMean(netParams.mu, netParams.sigma, p.xlAttachment, xlCover)
    : 0;
  // Expected reinstatement premium, pro-rata to amount: each limit burnt
  // beyond the first reinstates at `xlReinstatementPct` of the XL
  // premium, capped at the number of reinstatements bought.
  const xlReinstatementPremium = xlLive && p.xlLimit > 0
    ? xlPremium * (p.xlReinstatementPct / 100)
      * Math.min(xlRecovery / p.xlLimit, p.xlReinstatements)
    : 0;
  const xlSpend = xlPremium + xlReinstatementPremium;

  // ── Net position ──────────────────────────────────────────────────
  const retroSpend = (qsCededPremium - qsCommission) + xlSpend;
  const retroRecovery = qsRecovery + xlRecovery;
  const retroNetCost = retroSpend - retroRecovery;
  const retroEfficiency = retroSpend > 0 ? retroRecovery / retroSpend : 0;

  const netPremium = premiumAfterQs - xlSpend;
  const netExpectedLoss = lossAfterQs - xlRecovery;
  // Inwards acquisition costs stay with us in full — the retro QS
  // compensates them through its ceding commission, already inside
  // premiumAfterQs.
  const netResult = netPremium - netExpectedLoss - grossExpenses;
  const netMargin = grossPremium > 0 ? netResult / grossPremium : 0;
  const grossMargin = grossPremium > 0 ? grossResult / grossPremium : 0;

  // ── Tail, capital and authority ───────────────────────────────────
  const netPmlBeforeXl = netParams
    ? lognormalQuantile(netParams.mu, netParams.sigma, RETRO_PML_PROBABILITY)
    : 0;
  const pmlXlRecovery = xlLive ? layerHit(netPmlBeforeXl, p.xlAttachment, xlCover) : 0;
  const netPml = netPmlBeforeXl - pmlXlRecovery;
  const pmlRelief = grossPml - netPml;

  const capitalCharge = (p.costOfCapitalPct / 100) * Math.max(0, netPml - netExpectedLoss);
  const riskAdjustedResult = netResult - capitalCharge;

  const netRetainedLimit = grossLimit * (1 - q);
  const withinAuthority = s.authorityMaxLimit <= 0 || grossLimit <= s.authorityMaxLimit;

  return {
    linePct: lineFrac * 100,
    lineFrac,
    grossPremium,
    grossExpectedLoss,
    grossExpenses,
    grossLimit,
    grossResult,
    grossMargin,
    grossPml,
    qsCededPremium,
    qsCommission,
    qsRecovery,
    qsNetCost,
    premiumAfterQs,
    lossAfterQs,
    xlPremium,
    xlReinstatementPremium,
    xlSpend,
    xlRecovery,
    xlCover,
    retroSpend,
    retroRecovery,
    retroNetCost,
    retroEfficiency,
    netPremium,
    netExpectedLoss,
    netResult,
    netMargin,
    netPml,
    pmlRelief,
    capitalCharge,
    riskAdjustedResult,
    netRetainedLimit,
    withinAuthority,
  };
}

/**
 * Largest line the authority limit allows, in percentage points.
 * Returns `maxLinePct` when no authority cap is configured.
 *
 * @param {RetroSubject} subject
 * @returns {number}
 */
export function authorityCapPct(subject) {
  const s = normaliseSubject(subject);
  if (s.authorityMaxLimit <= 0 || s.grossLimit100 <= 0) return s.maxLinePct;
  const cap = (s.authorityMaxLimit / s.grossLimit100) * 100;
  return clamp(Math.floor(cap / RETRO_LINE_STEP_PCT) * RETRO_LINE_STEP_PCT, 0, s.maxLinePct);
}

/**
 * Evaluate every line on the grid the optimiser searches. Handy for the
 * sensitivity strip in the modal, which plots net result and retro
 * efficiency against line size.
 *
 * @param {{subject: RetroSubject, programme: RetroProgramme, step?: number}} params
 * @returns {Object[]} one evaluation per candidate line, ascending.
 */
export function buildRetroLineCurve({ subject, programme, step = RETRO_LINE_STEP_PCT } = {}) {
  const s = normaliseSubject(subject);
  const stepPct = num(step, RETRO_LINE_STEP_PCT) > 0 ? num(step, RETRO_LINE_STEP_PCT) : RETRO_LINE_STEP_PCT;
  const out = [];
  for (let line = stepPct; line <= s.maxLinePct + 1e-9; line += stepPct) {
    out.push(evaluateRetroAtLine({ linePct: Math.round(line * 1e6) / 1e6, subject: s, programme }));
  }
  return out;
}

function describe(best, noRetro, capPct, currentPct) {
  if (!best) return 'Enter the treaty premium and limit to generate a retro-adjusted suggestion.';
  const line = `${best.linePct.toFixed(1)}%`;
  const bits = [];
  if (best.netResult <= 0) {
    bits.push(`No line clears its retro cost — net result stays negative (${line} is the least-bad).`);
  } else if (best.retroEfficiency >= 1) {
    bits.push(`At ${line} the programme is expected to recover more than it costs (${best.retroEfficiency.toFixed(2)}× spend).`);
  } else {
    bits.push(`${line} maximises risk-adjusted net result after ${(best.retroEfficiency * 100).toFixed(0)}% retro cost recovery.`);
  }
  if (noRetro && best.riskAdjustedResult > noRetro.riskAdjustedResult) {
    bits.push('Buying the retro beats running the line net.');
  } else if (noRetro && noRetro.riskAdjustedResult > best.riskAdjustedResult) {
    bits.push('Running net scores better — the XL spend is not earning its keep at this structure.');
  }
  if (capPct > 0 && best.linePct >= capPct - 1e-9) {
    bits.push('Capped by the authority limit.');
  }
  if (Number.isFinite(currentPct) && currentPct > 0) {
    const delta = best.linePct - currentPct;
    if (Math.abs(delta) >= 0.25) {
      bits.push(`${delta > 0 ? 'Up' : 'Down'} ${Math.abs(delta).toFixed(1)}pts on the written line.`);
    }
  }
  return bits.join(' ');
}

/**
 * The retro-adjusted line suggestion: the line on the grid with the
 * highest risk-adjusted net result (net result less a cost-of-capital
 * charge on the 1-in-100 downside that survives the programme), subject
 * to the underwriter's authority limit.
 *
 * Also evaluates the same treaty with the retro switched off, so the
 * caller can say whether the programme is earning its cost.
 *
 * @param {{subject: RetroSubject, programme: RetroProgramme,
 *          currentLinePct?: number, step?: number}} params
 * @returns {{suggestedLinePct: number, best: Object|null, current: Object|null,
 *            noRetro: Object|null, curve: Object[], capPct: number,
 *            uplift: number, reason: string}}
 */
export function optimiseRetroLine({ subject, programme, currentLinePct, step } = {}) {
  const s = normaliseSubject(subject);
  const capPct = authorityCapPct(s);
  const curve = buildRetroLineCurve({ subject: s, programme, step });
  const feasible = curve.filter((r) => r.linePct <= capPct + 1e-9);
  // An authority cap tighter than one grid step leaves nothing feasible;
  // fall back to the whole curve so the modal still shows a number and
  // flags the breach rather than rendering an empty suggestion.
  const pool = feasible.length > 0 ? feasible : curve;

  let best = null;
  for (const row of pool) {
    if (!best || row.riskAdjustedResult > best.riskAdjustedResult) best = row;
  }

  const current = Number.isFinite(num(currentLinePct)) && num(currentLinePct) > 0
    ? evaluateRetroAtLine({ linePct: num(currentLinePct), subject: s, programme })
    : null;

  const noRetro = best
    ? evaluateRetroAtLine({
      linePct: best.linePct,
      subject: s,
      programme: { ...normaliseProgramme(programme), qsCessionPct: 0, qsCommissionPct: 0, xlEnabled: false },
    })
    : null;

  return {
    suggestedLinePct: best ? Math.round(best.linePct * 10) / 10 : 0,
    best,
    current,
    noRetro,
    curve,
    capPct,
    uplift: best && current ? best.riskAdjustedResult - current.riskAdjustedResult : 0,
    reason: describe(best, noRetro, capPct, num(currentLinePct)),
  };
}

/** Stored programme_type values that behave as proportional (QS-style) retro. */
const PROPORTIONAL_RETRO_TYPES = new Set(['QUOTA_SHARE', 'SURPLUS']);

/**
 * Map the STORED retro programmes covering a treaty (rows from
 * GET /api/retro/applicable — snake_case DB fields) onto the single
 * QS + XL programme this engine models:
 *
 *   • The first proportional programme (QUOTA_SHARE / SURPLUS) supplies the
 *     QS cession + commission; with none stored, cession is 0 — a stored
 *     book with no proportional retro genuinely cedes nothing pro-rata.
 *   • The first non-proportional programme (any XL / stop loss) supplies the
 *     XL terms; with none stored, the XL is off.
 *
 * Extra programmes beyond the first of each kind are reported in
 * `unusedNames` so the UI can say what the single-layer model left out.
 *
 * @param {Array<Object>} rows  Stored programme rows (may be empty).
 * @returns {{programme: RetroProgramme, sourceNames: string[],
 *            unusedNames: string[], hasStored: boolean}}
 */
export function programmeFromStored(rows) {
  const list = Array.isArray(rows) ? rows : [];
  if (!list.length) {
    return {
      programme: { ...DEFAULT_RETRO_PROGRAMME },
      sourceNames: [], unusedNames: [], hasStored: false,
    };
  }
  const prop = list.filter((r) => PROPORTIONAL_RETRO_TYPES.has(r.programme_type));
  const xls = list.filter((r) => !PROPORTIONAL_RETRO_TYPES.has(r.programme_type));
  const qs = prop[0] || null;
  const xl = xls[0] || null;
  const programme = normaliseProgramme({
    qsCessionPct: qs ? num(qs.cession_pct) : 0,
    qsCommissionPct: qs ? num(qs.commission_pct) : 0,
    xlEnabled: !!xl,
    xlAttachment: xl ? num(xl.attachment) : 0,
    xlLimit: xl ? num(xl.occurrence_limit) : 0,
    xlRolPct: xl ? num(xl.rol_pct, DEFAULT_RETRO_PROGRAMME.xlRolPct) : DEFAULT_RETRO_PROGRAMME.xlRolPct,
    xlReinstatements: xl ? num(xl.reinstatements) : 0,
    xlReinstatementPct: DEFAULT_RETRO_PROGRAMME.xlReinstatementPct,
    costOfCapitalPct: DEFAULT_RETRO_PROGRAMME.costOfCapitalPct,
  });
  return {
    programme,
    sourceNames: [qs?.programme_name, xl?.programme_name].filter(Boolean),
    unusedNames: [...prop.slice(1), ...xls.slice(1)].map((r) => r.programme_name),
    hasStored: true,
  };
}
