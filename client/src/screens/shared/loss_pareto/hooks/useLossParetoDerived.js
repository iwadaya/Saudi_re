// loss_pareto/hooks/useLossParetoDerived.js — every derived quantity the
// LossParetoScreen renders, moved verbatim from the screen body
// (Phase 4.2): distribution fits, return periods (fitted / third-party /
// blended), survival function, layer burning costs (empirical / model /
// blended), OEP layer costs and the headline stats. Also owns the
// α-refit effect (fitPareto re-runs whenever the fit input or threshold
// changes — identical recompute semantics, dispatch instead of setState).

import { useEffect, useMemo } from 'react';
import { layerHit } from '../../../../../../shared/pricingMath.js';
import { toN as cn } from '../../../../utils/format';
import { isNpStopLossTreaty } from '../../../../utils/npTreatyType';
import { interpolateTpAtRp } from '../../RpComparisonModal';
import {
  calcLayerPrice,
  calcLayerPriceNumerical,
  expQ,
  fitAll,
  fitPareto,
  lognormalCDF,
  lognormalQ,
  paretoQ,
  rpAtAttachment,
  weibullQ,
} from '../math/distributions';

/**
 * @param {import('../state/lossParetoReducer').LossParetoState} state
 * @param {{
 *   lossType: 'large' | 'cat',
 *   appState: Record<string, any>,
 *   actions: import('./useLossParetoState').LossParetoActions,
 * }} opts
 */
export function useLossParetoDerived(state, { lossType, appState, actions }) {
  const { losses, xm, limit, alpha, activeDist, yearsOvr, tpRows, rpSource, rpBlend, oepRows, wEmp, wModel } = state;

  // Stop Loss treaties fit the curves to YEARLY AGGREGATES of the
  // selected losses rather than to per-claim severities. This matches
  // the way an aggregate-attaching cover is priced: we're modelling
  // the distribution of total annual loss, not the size of a single
  // claim. For Risk XL / Cat XL the fit stays on per-claim losses
  // (severity model, used for individual-layer pricing).
  const stopLossTreaty = isNpStopLossTreaty(appState);

  const yearlyAggregates = useMemo(() => {
    if (!stopLossTreaty) return [];
    const byYear = new Map();
    for (const l of losses) {
      const y = Number(l.uw_year);
      if (!Number.isFinite(y)) continue;
      const v = cn(l.inflated);
      if (!(v > 0)) continue;
      byYear.set(y, (byYear.get(y) || 0) + v);
    }
    // Sort by year so the table reads chronologically.
    return [...byYear.entries()]
      .sort((a, b) => a[0] - b[0])
      .map(([year, inflated]) => ({ uw_year: year, inflated }));
  }, [stopLossTreaty, losses]);

  // The array fed to fitPareto / fitAll. In stop-loss mode this is one
  // entry per UW year; otherwise one entry per loss.
  const fitInput = useMemo(
    () => (stopLossTreaty ? yearlyAggregates : losses),
    [stopLossTreaty, yearlyAggregates, losses],
  );

  useEffect(() => {
    if (!fitInput.length || xm <= 0) return;
    const fit = fitPareto(fitInput.map(l => l.inflated), xm);
    if (fit.alpha > 0) actions.setAlpha(fit.alpha);
  }, [fitInput, xm, actions]);

  const inflated = useMemo(() => fitInput.map(l => l.inflated), [fitInput]);
  const fits = useMemo(() => fitAll(inflated, xm), [inflated, xm]);
  const sorted = useMemo(() => [...fitInput].sort((a, b) => b.inflated - a.inflated), [fitInput]);
  const total = useMemo(() => sorted.reduce((s, l) => s + l.inflated, 0), [sorted]);
  const pareto = useMemo(() => { let c = 0; return sorted.map((l, i) => { c += l.inflated; return { ...l, rank: i + 1, cum: c, cumPct: total > 0 ? c / total : 0 }; }); }, [sorted, total]);

  const returnPeriods = useMemo(() => {
    if (xm <= 0) return [];
    const f = fits.find(f => f.key === activeDist);
    const qFn = (p) => {
      if (activeDist === 'lognormal' && f) return lognormalQ(p, f.params.mu, f.params.sigma);
      if (activeDist === 'exponential' && f) return expQ(p, f.params.lambda, xm);
      if (activeDist === 'weibull' && f) return weibullQ(p, f.params.k, f.params.lam, xm);
      return alpha > 0 ? paretoQ(p, alpha, xm) : 0;
    };
    return [500, 250, 100, 50, 25, 20, 10, 5, 2].map(rp => {
      const loss = qFn(1 - 1 / rp);
      return { rp, loss: Number.isFinite(loss) && loss > 0 ? loss : 0 };
    });
  }, [alpha, xm, activeDist, fits]);

  // Third-party RP curve interpolated at every fitted RP. Empty array
  // when no valid TP points have been entered.
  const tpReturnPeriods = useMemo(() => {
    const valid = (tpRows || [])
      .map(r => ({ rp: parseFloat(r.rp), loss: parseFloat(String(r.loss).replace(/,/g, '')) }))
      .filter(r => r.rp > 0 && r.loss > 0)
      .sort((a, b) => a.rp - b.rp);
    if (valid.length < 2) return [];
    return returnPeriods.map(p => {
      const loss = interpolateTpAtRp(valid, p.rp);
      return { rp: p.rp, loss: loss == null ? 0 : loss };
    });
  }, [tpRows, returnPeriods]);

  // The curve actually displayed on the Return Periods card.
  // FITTED → fitted distribution. TP → third-party (interpolated).
  // BLEND → weighted average (rpBlend % from fitted).
  const effectiveReturnPeriods = useMemo(() => {
    if (rpSource === 'TP' && tpReturnPeriods.length) return tpReturnPeriods;
    if (rpSource === 'BLEND' && tpReturnPeriods.length) {
      const w = Math.max(0, Math.min(100, rpBlend)) / 100;
      return returnPeriods.map((p, i) => {
        const tp = tpReturnPeriods[i];
        return { rp: p.rp, loss: tp ? (w * p.loss + (1 - w) * tp.loss) : p.loss };
      });
    }
    return returnPeriods;
  }, [returnPeriods, tpReturnPeriods, rpSource, rpBlend]);

  const count = pareto.length;
  const avg = count > 0 ? total / count : 0;
  const mxL = count > 0 ? pareto[0].inflated : 0;
  const mnL = count > 0 ? pareto[count - 1].inflated : 0;
  const sd = Math.sqrt(count > 0 ? fitInput.reduce((a, l) => a + Math.pow(l.inflated - avg, 2), 0) / count : 0);
  const t5 = count >= 5 ? pareto[4].cumPct : count > 0 ? pareto[count - 1].cumPct : 0;
  const uwYrs = Number(yearsOvr) || 10;
  const freq = inflated.filter(l => l >= xm).length / uwYrs;
  const avgYr = uwYrs > 0 ? total / uwYrs : 0;

  // Survival function P(X > x) for the currently selected distribution.
  // Used by both the per-loss RP column and the layer burning cost table.
  const survivalFn = useMemo(() => {
    const f = fits.find(f => f.key === activeDist);
    if (!f) return null;
    if (activeDist === 'pareto') {
      return x => x < xm ? 1 : Math.pow(xm / x, alpha);
    }
    if (activeDist === 'lognormal' && f.params) {
      const { mu, sigma } = f.params;
      return x => x <= 0 ? 1 : 1 - lognormalCDF(x, mu, sigma);
    }
    if (activeDist === 'exponential' && f.params) {
      return x => x < xm ? 1 : Math.exp(-f.params.lambda * (x - xm));
    }
    if (activeDist === 'weibull' && f.params) {
      const { k, lam } = f.params;
      return x => x < xm ? 1 : Math.exp(-Math.pow((x - xm) / lam, k));
    }
    return null;
  }, [activeDist, fits, xm, alpha]);

  // Risk Pure Premium: Pareto uses the analytical LEV; other fitted
  // distributions integrate the survival function numerically. Defined after
  // survivalFn since it depends on it.
  const lp = useMemo(() => {
    if (!survivalFn) return { severity: null, rpp: null, error: 'No fit' };
    if (activeDist === 'pareto') {
      return calcLayerPrice(alpha, xm, freq, xm, limit || xm * 10);
    }
    return calcLayerPriceNumerical(freq, xm, limit || xm * 10, survivalFn);
  }, [activeDist, survivalFn, alpha, xm, freq, limit]);

  // Structure layers scoped to this loss type (RISK for large, CAT for cat).
  // Source: appState.npStructureLayers (set by NpStructure screen on load).
  const isNpCat = lossType === 'cat';
  const structureLayers = useMemo(() => {
    const raw = Array.isArray(appState.npStructureLayers)
      ? appState.npStructureLayers
      : appState.npStructureLayers?.layers || [];
    return raw.filter(l => {
      if (l.peril_scope !== undefined) {
        return isNpCat
          ? (l.peril_scope === 'CAT' || l.peril_scope === 'BOTH')
          : (l.peril_scope === 'RISK' || l.peril_scope === 'BOTH');
      }
      return isNpCat ? !!l.catCover : !!l.riskCover;
    });
  }, [appState.npStructureLayers, isNpCat]);

  const empiricalLayerRols = useMemo(() => {
    if (!structureLayers.length || !losses.length || !(uwYrs > 0)) return [];

    // Group inflated losses by UW year
    const byYear = new Map();
    for (const l of losses) {
      const yr = String(l.uw_year ?? '');
      if (!yr) continue;
      if (!byYear.has(yr)) byYear.set(yr, []);
      byYear.get(yr).push(l.inflated);
    }

    return structureLayers.map((sl, i) => {
      const D = parseFloat(String(sl.deductible ?? sl.attachment ?? sl.layer_deductible ?? '').replace(/,/g, '')) || 0;
      const L = parseFloat(String(sl.limit ?? sl.layer_limit ?? '').replace(/,/g, '')) || 0;
      if (!(L > 0)) return { idx: i, layer: sl.layer || `L${i + 1}`, D, L, rol: 0, annualLoss: 0 };

      // Sum in-layer loss per year; divide by full observation window (zero years included)
      let totalInLayer = 0;
      for (const yearLosses of byYear.values()) {
        for (const inc of yearLosses) {
          totalInLayer += layerHit(inc, D, L);
        }
      }
      const annualLoss = totalInLayer / uwYrs;
      return { idx: i, layer: sl.layer || `L${i + 1}`, D, L, annualLoss, rol: L > 0 ? annualLoss / L : 0 };
    });
  }, [structureLayers, losses, uwYrs]);

  const modelLayerRols = useMemo(() => {
    if (!structureLayers.length || !(freq > 0) || !survivalFn) return [];

    return structureLayers.map((sl, i) => {
      const D = parseFloat(String(sl.deductible ?? sl.attachment ?? sl.layer_deductible ?? '').replace(/,/g, '')) || 0;
      const L = parseFloat(String(sl.limit ?? sl.layer_limit ?? '').replace(/,/g, '')) || 0;
      if (!(L > 0)) return { idx: i, layer: sl.layer || `L${i + 1}`, D, L, rp: null, annualLoss: 0, rol: 0, error: null };

      const rp = rpAtAttachment(freq, D, survivalFn);
      let annualLoss, error;

      if (activeDist === 'pareto') {
        const result = calcLayerPrice(alpha, xm, freq, D, L);
        annualLoss = result.rpp;
        error = result.error || null;
      } else {
        annualLoss = calcLayerPriceNumerical(freq, D, L, survivalFn).rpp;
        error = null;
      }

      return { idx: i, layer: sl.layer || `L${i + 1}`, D, L, rp, annualLoss, rol: L > 0 ? annualLoss / L : 0, error };
    });
  }, [structureLayers, freq, alpha, xm, activeDist, survivalFn]);

  const blendedLayerRols = useMemo(() => {
    const wE = Math.max(0, wEmp);
    const wM = Math.max(0, wModel);
    const wTot = wE + wM;

    return structureLayers.map((sl, i) => {
      const emp = empiricalLayerRols[i];
      const model = modelLayerRols[i];
      if (!emp || !model) return null;
      const L = emp.L;

      let annualLoss;
      if (wTot <= 0) {
        annualLoss = 0;
      } else {
        annualLoss = (wE * emp.annualLoss + wM * model.annualLoss) / wTot;
      }

      return {
        idx: i,
        layer: emp.layer,
        D: emp.D, L,
        empiricalRol: emp.rol,
        modelRol: model.rol,
        blendedRol: L > 0 ? annualLoss / L : 0,
        blendedAnnual: annualLoss,
        rp: model.rp,
        error: model.error,
      };
    }).filter(Boolean);
  }, [structureLayers, empiricalLayerRols, modelLayerRols, wEmp, wModel]);

  // Parse OEP input into a sorted (rp, loss) curve with at least 2 valid points.
  const oepPts = useMemo(() => {
    return oepRows
      .map(r => ({
        rp: parseFloat(r.rp),
        loss: parseFloat(String(r.loss).replace(/,/g, '')),
      }))
      .filter(p => p.rp > 0 && p.loss > 0)
      .sort((a, b) => a.rp - b.rp);  // ascending RP = descending exceedance probability
  }, [oepRows]);

  // Piecewise-linear OEP survival: P(occurrence loss > x).
  // Below min OEP loss → use EP at minimum RP. Above max → 0.
  const oepSurvivalFn = useMemo(() => {
    if (oepPts.length < 2) return null;
    return (x) => {
      if (x <= 0) return 1 / oepPts[0].rp;
      if (x >= oepPts[oepPts.length - 1].loss) return 0;
      for (let i = 0; i < oepPts.length - 1; i++) {
        const lo = oepPts[i], hi = oepPts[i + 1];
        if (x >= lo.loss && x <= hi.loss) {
          const t = (x - lo.loss) / (hi.loss - lo.loss);
          return (1 / lo.rp) + t * ((1 / hi.rp) - (1 / lo.rp));
        }
      }
      return 0;
    };
  }, [oepPts]);

  const oepLayerRols = useMemo(() => {
    if (lossType !== 'cat' || !oepSurvivalFn || !structureLayers.length) return [];
    return structureLayers.map((sl, i) => {
      const D = parseFloat(String(sl.deductible ?? sl.attachment ?? sl.layer_deductible ?? '').replace(/,/g, '')) || 0;
      const L = parseFloat(String(sl.limit ?? sl.layer_limit ?? '').replace(/,/g, '')) || 0;
      if (!(L > 0)) return { idx: i, layer: sl.layer || `L${i + 1}`, D, L, rol: 0, annualLoss: 0, rp: null };

      const rp = rpAtAttachment(1, D, oepSurvivalFn);  // freq=1 because OEP already encodes annual probability
      const annualLoss = calcLayerPriceNumerical(1, D, L, oepSurvivalFn, 500).rpp;
      return { idx: i, layer: sl.layer || `L${i + 1}`, D, L, rp, annualLoss, rol: L > 0 ? annualLoss / L : 0 };
    });
  }, [lossType, oepSurvivalFn, structureLayers]);

  const bestFit = useMemo(() => [...fits].sort((a, b) => a.ks.ks - b.ks.ks)[0]?.key || 'pareto', [fits]);

  return {
    stopLossTreaty,
    yearlyAggregates,
    fitInput,
    inflated,
    fits,
    sorted,
    total,
    pareto,
    returnPeriods,
    tpReturnPeriods,
    effectiveReturnPeriods,
    count,
    avg,
    mxL,
    mnL,
    sd,
    t5,
    uwYrs,
    freq,
    avgYr,
    survivalFn,
    lp,
    structureLayers,
    empiricalLayerRols,
    modelLayerRols,
    blendedLayerRols,
    oepPts,
    oepSurvivalFn,
    oepLayerRols,
    bestFit,
  };
}

export default useLossParetoDerived;
