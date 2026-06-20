// components/fqGraphHelpers.js
// Pure pricing-curve / structure-analysis / AI-reasoning helpers extracted from
// FQPricingGraphModal to keep that screen under the 800-line budget. No React,
// no side effects — straight functions over plain data. No behaviour change.
import { formatWithCommas } from '../../../../utils/format';
import {
  FQ_MARKET_A,
  FQ_MARKET_B,
  fqFitPowerLaw,
  fqLayerToXY,
  fqQuoteLayerDerived,
  fqToN,
} from '../fqHelpers.js';

export const EPS = 1e-9;
export const SERIES = [
  { key: 'expiring', label: 'Expiring implied', color: 'rgba(167,139,250,0.95)', dash: '7 4' },
  { key: 'structure', label: 'Structure pricing', color: '#00d4ff', dash: '' },
  { key: 'portfolio', label: 'Portfolio curve', color: '#4ade80', dash: '5 4' },
  { key: 'country', label: 'Country curve', color: '#f59e0b', dash: '3 5' },
];

export function fmtPct(v, digits = 2) {
  return Number.isFinite(v) && v > 0 ? `${(v * 100).toFixed(digits)}%` : '-';
}

export function fmtMoney(v) {
  const n = fqToN(v);
  if (!n) return '-';
  return formatWithCommas(String(Math.round(n)));
}

export function fmtSignedPct(v, digits = 1) {
  return Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(digits)}%` : '-';
}

export function norm(v) {
  return String(v || '').trim().toLowerCase();
}

export function fitAt(fit, x) {
  if (!fit || !Number.isFinite(fit.a) || !Number.isFinite(fit.b) || x <= 0) return 0;
  const y = fit.a * Math.pow(x, fit.b);
  return Number.isFinite(y) && y > 0 ? y : 0;
}

export function weightedAvg(rows, selector) {
  const den = rows.reduce((s, r) => s + (r.limit > 0 ? r.limit : 0), 0);
  if (!den) return 0;
  return rows.reduce((s, r) => s + (r.limit > 0 ? r.limit * selector(r) : 0), 0) / den;
}

export function pointFromPortfolioRow(row) {
  return fqLayerToXY({
    limit: row.limit_layer,
    attachment: row.attachment,
    egnpi: row.egnpi_100,
    earnedPremium: row.premium_100,
    rol: row.rol_pct,
    rate: row.rate_pct,
  });
}

export function buildStructurePoints(structure, fallbackEgnpi) {
  return (structure?.layers || []).map((layer, idx) => {
    const derived = fqQuoteLayerDerived(layer);
    const egnpi = fqToN(layer.egnpi) || fallbackEgnpi;
    const point = fqLayerToXY({
      ...layer,
      egnpi,
      rol: fqToN(layer.uwPrice) || derived.totalRol,
    });
    return point ? {
      ...point,
      label: `L${idx + 1}`,
      layer: idx + 1,
      limit: fqToN(layer.limit),
      attachment: fqToN(layer.attachment) || fqToN(layer.deductible),
      egnpi,
      sourceLayer: layer,
      totalRol: derived.totalRol,
    } : null;
  }).filter(Boolean);
}

export function buildPortfolioPoints(rows) {
  return (rows || []).map((row, idx) => {
    const point = pointFromPortfolioRow(row);
    return point ? {
      ...point,
      label: row.layer_number ? `P${row.layer_number}` : `P${idx + 1}`,
      layer: row.layer_number || idx + 1,
      limit: fqToN(row.limit_layer),
      attachment: fqToN(row.attachment),
      egnpi: fqToN(row.egnpi_100),
      cedant: row.cedant || '',
      country: row.country || '',
    } : null;
  }).filter(Boolean);
}

export function fitSeries(points, allowDefault = false) {
  if (!points.length) return null;
  const fit = fqFitPowerLaw(points);
  if (fit.calibrated || allowDefault) return fit;
  return null;
}

export function moneyWithCurrency(v, currency) {
  const value = fmtMoney(v);
  return value === '-' ? value : `${currency ? `${currency} ` : ''}${value}`;
}

export function structureLayerRol(layer = {}) {
  const derived = fqQuoteLayerDerived(layer);
  return fqToN(layer.uwPrice) || fqToN(layer.uw_price) || derived.totalRol;
}

export function layerRateFromRol(layer = {}, fallbackEgnpi = 0) {
  const limit = fqToN(layer.limit);
  const egnpi = fqToN(layer.egnpi) || fqToN(fallbackEgnpi);
  const rolPct = structureLayerRol(layer);
  return rolPct > 0 && limit > 0 && egnpi > 0 ? (rolPct / 100) * limit / egnpi : 0;
}

export function marketRol(row = {}) {
  const rolPct = fqToN(row.rol_pct);
  if (rolPct > 0) return rolPct / 100;
  const premium = fqToN(row.premium_100);
  const limit = fqToN(row.limit_layer);
  return premium > 0 && limit > 0 ? premium / limit : 0;
}

export function marketRate(row = {}) {
  const ratePct = fqToN(row.rate_pct);
  if (ratePct > 0) return ratePct / 100;
  const premium = fqToN(row.premium_100);
  const egnpi = fqToN(row.egnpi_100);
  return premium > 0 && egnpi > 0 ? premium / egnpi : 0;
}

export const STRUCTURE_ANALYSIS_METRICS = [
  {
    key: 'deductible',
    label: 'Deductible',
    format: 'money',
    structure: (layer) => fqToN(layer.attachment) || fqToN(layer.deductible),
    market: (row) => fqToN(row.attachment),
  },
  {
    key: 'limit',
    label: 'Limit',
    format: 'money',
    structure: (layer) => fqToN(layer.limit),
    market: (row) => fqToN(row.limit_layer),
  },
  {
    key: 'egnpi',
    label: 'EGNPI',
    format: 'money',
    structure: (layer, fallbackEgnpi) => fqToN(layer.egnpi) || fqToN(fallbackEgnpi),
    market: (row) => fqToN(row.egnpi_100),
  },
  {
    key: 'rate',
    label: 'Rates',
    format: 'pct',
    structure: (layer, fallbackEgnpi) => layerRateFromRol(layer, fallbackEgnpi),
    market: marketRate,
  },
  {
    key: 'rol',
    label: 'ROL',
    format: 'pct',
    structure: (layer) => structureLayerRol(layer) / 100,
    market: marketRol,
  },
  {
    key: 'deductibleEgnpi',
    label: 'Deductible/EGNPI',
    format: 'pct',
    structure: (layer, fallbackEgnpi) => {
      const ded = fqToN(layer.attachment) || fqToN(layer.deductible);
      const egnpi = fqToN(layer.egnpi) || fqToN(fallbackEgnpi);
      return ded > 0 && egnpi > 0 ? ded / egnpi : 0;
    },
    market: (row) => {
      const ded = fqToN(row.attachment);
      const egnpi = fqToN(row.egnpi_100);
      return ded > 0 && egnpi > 0 ? ded / egnpi : 0;
    },
  },
  {
    key: 'deductibleLimit',
    label: 'Deductible/Limit',
    format: 'pct',
    structure: (layer) => {
      const ded = fqToN(layer.attachment) || fqToN(layer.deductible);
      const limit = fqToN(layer.limit);
      return ded > 0 && limit > 0 ? ded / limit : 0;
    },
    market: (row) => {
      const ded = fqToN(row.attachment);
      const limit = fqToN(row.limit_layer);
      return ded > 0 && limit > 0 ? ded / limit : 0;
    },
  },
  {
    key: 'limitEgnpi',
    label: 'Limit/EGNPI',
    format: 'pct',
    structure: (layer, fallbackEgnpi) => {
      const limit = fqToN(layer.limit);
      const egnpi = fqToN(layer.egnpi) || fqToN(fallbackEgnpi);
      return limit > 0 && egnpi > 0 ? limit / egnpi : 0;
    },
    market: (row) => {
      const limit = fqToN(row.limit_layer);
      const egnpi = fqToN(row.egnpi_100);
      return limit > 0 && egnpi > 0 ? limit / egnpi : 0;
    },
  },
];

export function avg(values) {
  const clean = values.filter(v => Number.isFinite(v) && v > 0);
  return clean.length ? clean.reduce((s, v) => s + v, 0) / clean.length : 0;
}

export function metricAverage(rows, layerNumber, metric) {
  const sameLayerRows = rows.filter(row => Number(row.layer_number) === Number(layerNumber));
  const pool = sameLayerRows.length ? sameLayerRows : rows;
  return avg(pool.map(metric.market));
}

export function formatStructureMetric(value, format, currency) {
  if (!(value > 0)) return '-';
  if (format === 'money') return moneyWithCurrency(value, currency);
  return fmtPct(value);
}

export function withinAverageLabel(value, average) {
  if (!(value > 0) || !(average > 0)) return { label: '-', color: 'rgba(148,163,184,0.55)' };
  const diff = value / average - 1;
  if (Math.abs(diff) <= 0.10) return { label: `Within ${fmtSignedPct(diff)}`, color: '#4ade80' };
  return {
    label: `${diff > 0 ? 'Above' : 'Below'} ${fmtSignedPct(diff)}`,
    color: diff > 0 ? '#f59e0b' : '#60a5fa',
  };
}

export function buildStructureAnalysisLayers({ structure, fallbackEgnpi, portfolioRows, npDetail }) {
  const countryName = norm(npDetail.countryName || npDetail.country);
  const explicitRegion = norm(npDetail.regionName || npDetail.region || npDetail.region_name);
  const matchedCountryRow = countryName
    ? (portfolioRows || []).find(row => norm(row.country) === countryName && norm(row.region))
    : null;
  const regionName = explicitRegion || norm(matchedCountryRow?.region);
  const countryRows = countryName ? (portfolioRows || []).filter(row => norm(row.country) === countryName) : [];
  const regionRows = regionName ? (portfolioRows || []).filter(row => norm(row.region) === regionName) : [];
  const globalRows = portfolioRows || [];

  return (structure?.layers || []).map((layer, idx) => {
    const layerNumber = idx + 1;
    const rows = STRUCTURE_ANALYSIS_METRICS.map((metric) => {
      const structureValue = metric.structure(layer, fallbackEgnpi);
      const countryAverage = metricAverage(countryRows, layerNumber, metric);
      const regionAverage = metricAverage(regionRows, layerNumber, metric);
      const globalAverage = metricAverage(globalRows, layerNumber, metric);
      return {
        key: metric.key,
        label: metric.label,
        format: metric.format,
        structureValue,
        countryAverage,
        regionAverage,
        globalAverage,
        withinCountry: withinAverageLabel(structureValue, countryAverage),
        withinRegion: withinAverageLabel(structureValue, regionAverage),
        withinGlobal: withinAverageLabel(structureValue, globalAverage),
      };
    });
    return { layerNumber, rows };
  });
}

export function solveAttachmentForCurve(fit, limit, egnpi, targetRol) {
  if (!fit || !Number.isFinite(fit.a) || !Number.isFinite(fit.b) || Math.abs(fit.b) < EPS) return 0;
  if (!(limit > 0) || !(egnpi > 0) || !(targetRol > 0)) return 0;
  const x = Math.pow(targetRol / fit.a, 1 / fit.b);
  if (!Number.isFinite(x) || x <= 0) return 0;
  const gm = x * egnpi;
  const disc = limit * limit + 4 * gm * gm;
  const attachment = (-limit + Math.sqrt(disc)) / 2;
  return Number.isFinite(attachment) && attachment > 0 ? attachment : 0;
}

export function solveLimitForCurve(fit, attachment, egnpi, targetRol) {
  if (!fit || !Number.isFinite(fit.a) || !Number.isFinite(fit.b) || Math.abs(fit.b) < EPS) return 0;
  if (!(attachment > 0) || !(egnpi > 0) || !(targetRol > 0)) return 0;
  const x = Math.pow(targetRol / fit.a, 1 / fit.b);
  if (!Number.isFinite(x) || x <= 0) return 0;
  const gm = x * egnpi;
  const limit = ((gm * gm) - (attachment * attachment)) / attachment;
  return Number.isFinite(limit) && limit > 0 ? limit : 0;
}

export function chooseTargetCurve({ countryFit, portfolioFit, expFit }) {
  if (countryFit) {
    return {
      key: 'country',
      label: 'Country curve',
      color: SERIES[3].color,
      fit: countryFit,
      reason: 'Country curve selected because it reflects local portfolio pricing for the treaty country.',
    };
  }
  if (portfolioFit) {
    return {
      key: 'portfolio',
      label: 'Portfolio curve',
      color: SERIES[2].color,
      fit: portfolioFit,
      reason: 'Portfolio curve selected because the country sample is not deep enough.',
    };
  }
  if (expFit?.calibrated) {
    return {
      key: 'expiring',
      label: 'Expiring implied curve',
      color: SERIES[0].color,
      fit: expFit,
      reason: 'Expiring implied curve selected because it is calibrated from the expiring structure.',
    };
  }
  return {
    key: 'market',
    label: 'Market default curve',
    color: 'rgba(148,163,184,0.95)',
    fit: expFit || { a: FQ_MARKET_A, b: FQ_MARKET_B, calibrated: false, n: 0, r2: null },
    reason: 'Market default selected because country, portfolio, and expiring curves do not have enough usable points.',
  };
}

export function layerAiReason(row, targetLabel) {
  if (!(row.aiRol > 0)) return 'Add limit, deductible, EGNPI, and pricing to generate a curve suggestion.';
  if (!(row.currentRol > 0)) return `Use ${targetLabel} at the current deductible until a structure price is entered.`;
  const gapAbs = Math.abs(row.gapVsAi || 0);
  if (gapAbs <= 0.08) return `Current price is within ${(gapAbs * 100).toFixed(1)}% of ${targetLabel}; hold deductible unless wording or exposure changes.`;
  if (row.gapVsAi > 0) {
    return `Current price is ${fmtSignedPct(row.gapVsAi)} above ${targetLabel}; higher deductible or stronger loss rationale is needed to support it.`;
  }
  return `Current price is ${fmtSignedPct(row.gapVsAi)} below ${targetLabel}; increase price or reduce deductible only if appetite allows.`;
}

export function buildAiAnalysis(layerRows, target) {
  const rows = (layerRows || []).map((r) => {
    const aiRol = fitAt(target.fit, r.x);
    const aiPremium = aiRol > 0 && r.limit > 0 ? aiRol * r.limit : 0;
    const aiRate = aiPremium > 0 && r.egnpi > 0 ? aiPremium / r.egnpi : 0;
    const suggestedDeductible = r.structure > 0
      ? solveAttachmentForCurve(target.fit, r.limit, r.egnpi, r.structure)
      : r.attachment;
    const suggestedLimit = r.structure > 0
      ? solveLimitForCurve(target.fit, r.attachment, r.egnpi, r.structure)
      : r.limit;
    const currentPremium = r.structure > 0 && r.limit > 0 ? r.structure * r.limit : 0;
    const gapVsAi = aiRol > 0 && r.structure > 0 ? (r.structure / aiRol) - 1 : null;
    const deductibleMove = suggestedDeductible > 0 && r.attachment > 0 ? (suggestedDeductible / r.attachment) - 1 : null;
    const limitMove = suggestedLimit > 0 && r.limit > 0 ? (suggestedLimit / r.limit) - 1 : null;
    return {
      ...r,
      currentRol: r.structure,
      currentPremium,
      aiRol,
      aiRate,
      aiPremium,
      suggestedDeductible,
      suggestedLimit,
      gapVsAi,
      deductibleMove,
      limitMove,
      reason: layerAiReason({ aiRol, currentRol: r.structure, gapVsAi }, target.label),
    };
  });

  const totalLimit = rows.reduce((s, r) => s + (r.limit || 0), 0);
  const currentPremium = rows.reduce((s, r) => s + r.currentPremium, 0);
  const aiPremium = rows.reduce((s, r) => s + r.aiPremium, 0);
  const currentRol = totalLimit > 0 ? currentPremium / totalLimit : 0;
  const aiRol = totalLimit > 0 ? aiPremium / totalLimit : 0;
  const premiumGap = aiPremium > 0 && currentPremium > 0 ? (currentPremium / aiPremium) - 1 : null;
  const firstCurrentDeductible = rows[0]?.attachment || 0;
  const firstSuggestedDeductible = rows[0]?.suggestedDeductible || firstCurrentDeductible;
  const firstCurrentLimit = rows[0]?.limit || 0;
  const firstSuggestedLimit = rows[0]?.suggestedLimit || firstCurrentLimit;
  const deductibleMove = firstCurrentDeductible > 0 && firstSuggestedDeductible > 0
    ? (firstSuggestedDeductible / firstCurrentDeductible) - 1
    : null;
  const limitMove = firstCurrentLimit > 0 && firstSuggestedLimit > 0
    ? (firstSuggestedLimit / firstCurrentLimit) - 1
    : null;

  const reasons = [target.reason];
  if (premiumGap == null) {
    reasons.push('Enter structure pricing to compare current premium against AI suggested pricing.');
  } else if (Math.abs(premiumGap) <= 0.08) {
    reasons.push(`Structure pricing is close to ${target.label}; focus review on deductible adequacy and layer shape.`);
  } else if (premiumGap > 0) {
    reasons.push(`Structure premium is ${fmtSignedPct(premiumGap)} above ${target.label}; keep only with a documented exposure, reinstatement, or coverage reason.`);
  } else {
    reasons.push(`Structure premium is ${fmtSignedPct(premiumGap)} below ${target.label}; consider lifting ROL toward the suggested curve.`);
  }
  if (deductibleMove != null && Math.abs(deductibleMove) > 0.08) {
    reasons.push(`Layer 1 curve-neutral deductible is ${fmtSignedPct(deductibleMove)} from current, which indicates deductible tension in the structure.`);
  }
  if (limitMove != null && Math.abs(limitMove) > 0.08) {
    reasons.push(`Layer 1 curve-neutral limit is ${fmtSignedPct(limitMove)} from current, giving an alternate way to align the layer with the selected curve.`);
  }

  return {
    target,
    rows,
    summary: {
      totalLimit,
      currentPremium,
      aiPremium,
      currentRol,
      aiRol,
      premiumGap,
      firstCurrentDeductible,
      firstSuggestedDeductible,
      firstCurrentLimit,
      firstSuggestedLimit,
      deductibleMove,
      limitMove,
      reasons,
    },
  };
}

