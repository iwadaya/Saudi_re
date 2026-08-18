// shared/fac/layers.js
//
// Excess-of-loss placement arithmetic: rate on line, payback, reinstatements
// and free cover.
//
// fac_risk has carried np_retention, np_limit and np_our_share_pct since the
// module was built, the Placement Structure screen has collected them, and
// nothing has ever priced a layer with them (finding F3). One retention and
// one limit also cannot describe a tower, which is how excess casualty and
// most marine liability is actually placed — hence fac_layer (migration 136)
// and this module.
//
// None of this is class-specific. A layer behaves the same way whether what
// sits underneath it is a factory, a fleet or a products liability book, so
// it lives beside the pipeline rather than inside a family.

import { num, numOrNull } from './num.js';

/**
 * Rate on line: layer premium as a proportion of the limit it buys.
 *
 * @param {number} premium
 * @param {number} limit
 * @returns {number|null}
 */
export function rateOnLine(premium, limit) {
  const p = numOrNull(premium);
  const l = numOrNull(limit);
  if (p === null || l === null || l <= 0) return null;
  return p / l;
}

/**
 * Payback period in years — how long the layer takes to earn its own limit
 * back. The reciprocal of the rate on line, and the number an underwriter
 * reaches for first on a high layer.
 *
 * @param {number} rol
 * @returns {number|null}
 */
export function paybackYears(rol) {
  const r = numOrNull(rol);
  if (r === null || r <= 0) return null;
  return 1 / r;
}

/**
 * Premium from a loss cost, grossed up for expenses and margin.
 *
 * @param {number} lossCost
 * @param {number} denominator  1 − commission − brokerage − tax − margin
 * @returns {number|null}
 */
export function layerPremium(lossCost, denominator) {
  const lc = numOrNull(lossCost);
  const d = numOrNull(denominator);
  if (lc === null) return null;
  if (d === null || d <= 0) return lc;
  return lc / d;
}

/**
 * Reinstatement premium for one reinstatement.
 *
 *   RP = layerPremium × pct × (fraction of limit used) × (fraction of period left)
 *
 * `pro_rata_amount` and `pro_rata_time` are the two switches an XL slip
 * states: pro rata as to amount means you pay for the share of the limit
 * actually reinstated; pro rata as to time means you pay for the unexpired
 * portion of the period. Neither is assumed — a term that is not stated is
 * not applied.
 *
 * @param {object} args
 * @param {number} args.premium
 * @param {object} args.terms       {pct_of_premium, pro_rata_amount, pro_rata_time}
 * @param {number} args.amountUsed  fraction of the limit eroded, 0..1
 * @param {number} args.timeLeft    fraction of the period unexpired, 0..1
 * @returns {number}
 */
export function reinstatementPremium({ premium, terms, amountUsed = 1, timeLeft = 1 }) {
  const p = num(premium);
  if (p <= 0) return 0;
  const pct = num(terms?.pct_of_premium, 1);
  const amt = terms?.pro_rata_amount ? Math.min(Math.max(num(amountUsed), 0), 1) : 1;
  const time = terms?.pro_rata_time ? Math.min(Math.max(num(timeLeft), 0), 1) : 1;
  return p * pct * amt * time;
}

/**
 * Total cover a layer provides once reinstatements are counted.
 *
 * `reinstatements` of null means unlimited, which is finite only in the
 * sense that an aggregate limit may still cap it.
 *
 * @param {object} layer
 * @returns {number|null} null when unlimited and uncapped
 */
export function totalCover(layer) {
  const limit = numOrNull(layer?.limit_amount);
  if (limit === null) return null;                   // unlimited top layer
  const agg = numOrNull(layer?.aggregate_limit);
  const reinstatements = numOrNull(layer?.reinstatements);
  if (reinstatements === null) return agg;           // unlimited reinstatements
  const gross = limit * (1 + reinstatements);
  return agg === null ? gross : Math.min(gross, agg);
}

/**
 * Free cover: the part of a layer sitting above anything the experience has
 * ever reached.
 *
 * A layer whose attachment is above the largest as-if'd historic loss cannot
 * be experience-rated at all — there is no data up there — and pricing it
 * off a burning cost would produce a confident nil. Naming it is how an
 * underwriter knows to fall back to exposure rating.
 *
 * @param {object} args
 * @param {number} args.attachment
 * @param {number} args.limit
 * @param {number|null} args.largestAsIfLoss
 * @returns {{isFreeCover: boolean, exposedPortion: number|null, largestAsIfLoss: number|null}}
 */
export function freeCover({ attachment, limit, largestAsIfLoss }) {
  const d = num(attachment);
  const l = numOrNull(limit);
  const max = numOrNull(largestAsIfLoss);
  if (max === null) {
    return { isFreeCover: false, exposedPortion: null, largestAsIfLoss: null };
  }
  if (max <= d) {
    return { isFreeCover: true, exposedPortion: 0, largestAsIfLoss: max };
  }
  const top = l === null ? Infinity : d + l;
  const exposed = Math.min(max, top) - d;
  return {
    isFreeCover: false,
    exposedPortion: l === null || l <= 0 ? null : Math.min(exposed / l, 1),
    largestAsIfLoss: max,
  };
}

/**
 * Price a whole tower: each layer's loss cost, premium, ROL and payback,
 * plus the share actually written.
 *
 * The per-layer loss cost comes from whichever method the family used —
 * this only assembles the placement around it.
 *
 * @param {object} args
 * @param {Array<object>} args.layers            fac_layer rows
 * @param {(layer: object) => number|null} args.lossCostFor
 * @param {number} args.grossUpDenominator
 * @param {number|null} [args.largestAsIfLoss]
 * @returns {{layers: Array<object>, total: object}}
 */
export function priceTower({ layers, lossCostFor, grossUpDenominator, largestAsIfLoss = null }) {
  const priced = (layers || [])
    .slice()
    .sort((a, b) => num(a.layer_no) - num(b.layer_no))
    .map((layer) => {
      const limit = numOrNull(layer.limit_amount);
      const lossCost = numOrNull(lossCostFor(layer));
      const premium = layerPremium(lossCost, grossUpDenominator);
      const rol = rateOnLine(premium, limit);
      const share = numOrNull(layer.our_share_pct);
      const fc = freeCover({ attachment: layer.attachment, limit, largestAsIfLoss });
      return {
        layer_no: num(layer.layer_no),
        attachment: num(layer.attachment),
        limit_amount: limit,
        our_share_pct: share,
        loss_cost: lossCost,
        premium,
        rol_pct: rol,
        payback_years: paybackYears(rol),
        total_cover: totalCover(layer),
        reinstatements: numOrNull(layer.reinstatements),
        our_premium: premium !== null && share !== null ? premium * share : null,
        free_cover: fc.isFreeCover,
        exposed_portion: fc.exposedPortion,
      };
    });

  const sum = (key) => priced.reduce((acc, l) => acc + (numOrNull(l[key]) ?? 0), 0);
  return {
    layers: priced,
    total: {
      loss_cost: sum('loss_cost'),
      premium: sum('premium'),
      our_premium: sum('our_premium'),
      layer_count: priced.length,
      free_cover_layers: priced.filter((l) => l.free_cover).length,
    },
  };
}
