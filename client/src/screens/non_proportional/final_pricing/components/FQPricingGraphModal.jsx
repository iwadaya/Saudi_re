import { useMemo } from 'react';
import { formatWithCommas } from '../../../../utils/format';
import {
  FQ_MARKET_A,
  FQ_MARKET_B,
  FQ_STRUCTURE_COLORS,
  fqBuildPricingCurve,
  fqCurveBaseEgnpi,
  fqFitPowerLaw,
  fqLayerToXY,
  fqQuoteLayerDerived,
  fqToN,
} from '../fqHelpers.js';

const EPS = 1e-9;
const SERIES = [
  { key: 'expiring', label: 'Expiring implied', color: 'rgba(167,139,250,0.95)', dash: '7 4' },
  { key: 'structure', label: 'Structure pricing', color: '#00d4ff', dash: '' },
  { key: 'portfolio', label: 'Portfolio curve', color: '#4ade80', dash: '5 4' },
  { key: 'country', label: 'Country curve', color: '#f59e0b', dash: '3 5' },
];

function fmtPct(v, digits = 2) {
  return Number.isFinite(v) && v > 0 ? `${(v * 100).toFixed(digits)}%` : '-';
}

function fmtMoney(v) {
  const n = fqToN(v);
  if (!n) return '-';
  return formatWithCommas(String(Math.round(n)));
}

function fmtSignedPct(v, digits = 1) {
  return Number.isFinite(v) ? `${v >= 0 ? '+' : ''}${(v * 100).toFixed(digits)}%` : '-';
}

function norm(v) {
  return String(v || '').trim().toLowerCase();
}

function fitAt(fit, x) {
  if (!fit || !Number.isFinite(fit.a) || !Number.isFinite(fit.b) || x <= 0) return 0;
  const y = fit.a * Math.pow(x, fit.b);
  return Number.isFinite(y) && y > 0 ? y : 0;
}

function weightedAvg(rows, selector) {
  const den = rows.reduce((s, r) => s + (r.limit > 0 ? r.limit : 0), 0);
  if (!den) return 0;
  return rows.reduce((s, r) => s + (r.limit > 0 ? r.limit * selector(r) : 0), 0) / den;
}

function pointFromPortfolioRow(row) {
  return fqLayerToXY({
    limit: row.limit_layer,
    attachment: row.attachment,
    egnpi: row.egnpi_100,
    earnedPremium: row.premium_100,
    rol: row.rol_pct,
    rate: row.rate_pct,
  });
}

function buildStructurePoints(structure, fallbackEgnpi) {
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

function buildPortfolioPoints(rows) {
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

function fitSeries(points, allowDefault = false) {
  if (!points.length) return null;
  const fit = fqFitPowerLaw(points);
  if (fit.calibrated || allowDefault) return fit;
  return null;
}

function moneyWithCurrency(v, currency) {
  const value = fmtMoney(v);
  return value === '-' ? value : `${currency ? `${currency} ` : ''}${value}`;
}

function structureLayerRol(layer = {}) {
  const derived = fqQuoteLayerDerived(layer);
  return fqToN(layer.uwPrice) || fqToN(layer.uw_price) || derived.totalRol;
}

function layerRateFromRol(layer = {}, fallbackEgnpi = 0) {
  const limit = fqToN(layer.limit);
  const egnpi = fqToN(layer.egnpi) || fqToN(fallbackEgnpi);
  const rolPct = structureLayerRol(layer);
  return rolPct > 0 && limit > 0 && egnpi > 0 ? (rolPct / 100) * limit / egnpi : 0;
}

function marketRol(row = {}) {
  const rolPct = fqToN(row.rol_pct);
  if (rolPct > 0) return rolPct / 100;
  const premium = fqToN(row.premium_100);
  const limit = fqToN(row.limit_layer);
  return premium > 0 && limit > 0 ? premium / limit : 0;
}

function marketRate(row = {}) {
  const ratePct = fqToN(row.rate_pct);
  if (ratePct > 0) return ratePct / 100;
  const premium = fqToN(row.premium_100);
  const egnpi = fqToN(row.egnpi_100);
  return premium > 0 && egnpi > 0 ? premium / egnpi : 0;
}

const STRUCTURE_ANALYSIS_METRICS = [
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

function avg(values) {
  const clean = values.filter(v => Number.isFinite(v) && v > 0);
  return clean.length ? clean.reduce((s, v) => s + v, 0) / clean.length : 0;
}

function metricAverage(rows, layerNumber, metric) {
  const sameLayerRows = rows.filter(row => Number(row.layer_number) === Number(layerNumber));
  const pool = sameLayerRows.length ? sameLayerRows : rows;
  return avg(pool.map(metric.market));
}

function formatStructureMetric(value, format, currency) {
  if (!(value > 0)) return '-';
  if (format === 'money') return moneyWithCurrency(value, currency);
  return fmtPct(value);
}

function withinAverageLabel(value, average) {
  if (!(value > 0) || !(average > 0)) return { label: '-', color: 'rgba(148,163,184,0.55)' };
  const diff = value / average - 1;
  if (Math.abs(diff) <= 0.10) return { label: `Within ${fmtSignedPct(diff)}`, color: '#4ade80' };
  return {
    label: `${diff > 0 ? 'Above' : 'Below'} ${fmtSignedPct(diff)}`,
    color: diff > 0 ? '#f59e0b' : '#60a5fa',
  };
}

function buildStructureAnalysisLayers({ structure, fallbackEgnpi, portfolioRows, npDetail }) {
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

function solveAttachmentForCurve(fit, limit, egnpi, targetRol) {
  if (!fit || !Number.isFinite(fit.a) || !Number.isFinite(fit.b) || Math.abs(fit.b) < EPS) return 0;
  if (!(limit > 0) || !(egnpi > 0) || !(targetRol > 0)) return 0;
  const x = Math.pow(targetRol / fit.a, 1 / fit.b);
  if (!Number.isFinite(x) || x <= 0) return 0;
  const gm = x * egnpi;
  const disc = limit * limit + 4 * gm * gm;
  const attachment = (-limit + Math.sqrt(disc)) / 2;
  return Number.isFinite(attachment) && attachment > 0 ? attachment : 0;
}

function solveLimitForCurve(fit, attachment, egnpi, targetRol) {
  if (!fit || !Number.isFinite(fit.a) || !Number.isFinite(fit.b) || Math.abs(fit.b) < EPS) return 0;
  if (!(attachment > 0) || !(egnpi > 0) || !(targetRol > 0)) return 0;
  const x = Math.pow(targetRol / fit.a, 1 / fit.b);
  if (!Number.isFinite(x) || x <= 0) return 0;
  const gm = x * egnpi;
  const limit = ((gm * gm) - (attachment * attachment)) / attachment;
  return Number.isFinite(limit) && limit > 0 ? limit : 0;
}

function chooseTargetCurve({ countryFit, portfolioFit, expFit }) {
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

function layerAiReason(row, targetLabel) {
  if (!(row.aiRol > 0)) return 'Add limit, deductible, EGNPI, and pricing to generate a curve suggestion.';
  if (!(row.currentRol > 0)) return `Use ${targetLabel} at the current deductible until a structure price is entered.`;
  const gapAbs = Math.abs(row.gapVsAi || 0);
  if (gapAbs <= 0.08) return `Current price is within ${(gapAbs * 100).toFixed(1)}% of ${targetLabel}; hold deductible unless wording or exposure changes.`;
  if (row.gapVsAi > 0) {
    return `Current price is ${fmtSignedPct(row.gapVsAi)} above ${targetLabel}; higher deductible or stronger loss rationale is needed to support it.`;
  }
  return `Current price is ${fmtSignedPct(row.gapVsAi)} below ${targetLabel}; increase price or reduce deductible only if appetite allows.`;
}

function buildAiAnalysis(layerRows, target) {
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

export default function FQPricingGraphModal({
  open,
  sourceLabel,
  structure,
  expLayers = [],
  npDetail = {},
  portfolioRows = [],
  currency,
  onClose,
}) {
  const data = useMemo(() => {
    const baseEgnpi = fqCurveBaseEgnpi(expLayers, npDetail);
    const expCurve = fqBuildPricingCurve({ expLayers, structures: [], npDetail });
    const structurePts = buildStructurePoints(structure, baseEgnpi);

    const countryName = norm(npDetail.countryName || npDetail.country);
    const portfolioPts = buildPortfolioPoints(portfolioRows);
    const countryPts = buildPortfolioPoints(
      countryName
        ? portfolioRows.filter(row => norm(row.country) === countryName)
        : [],
    );

    const expFit = fitSeries(expCurve.expPts, true);
    const structureFit = fitSeries(structurePts, false);
    const portfolioFit = fitSeries(portfolioPts, false);
    const countryFit = fitSeries(countryPts, false);

    const series = [
      { ...SERIES[0], points: expCurve.expPts, fit: expFit },
      { ...SERIES[1], points: structurePts, fit: structureFit },
      { ...SERIES[2], points: portfolioPts, fit: portfolioFit },
      { ...SERIES[3], points: countryPts, fit: countryFit },
    ];

    const layerRows = structurePts.map((p) => {
      const expiring = fitAt(expFit, p.x);
      const portfolio = fitAt(portfolioFit, p.x);
      const country = fitAt(countryFit, p.x);
      return {
        ...p,
        structure: p.y,
        expiring,
        portfolio,
        country,
        vsExpiring: expiring > 0 ? (p.y / expiring - 1) : null,
        vsCountry: country > 0 ? (p.y / country - 1) : null,
      };
    });
    const targetCurve = chooseTargetCurve({ countryFit, portfolioFit, expFit });
    const aiAnalysis = buildAiAnalysis(layerRows, targetCurve);
    const structureAnalysisLayers = buildStructureAnalysisLayers({
      structure,
      fallbackEgnpi: baseEgnpi,
      portfolioRows,
      npDetail,
    });

    return { baseEgnpi, series, layerRows, expFit, portfolioFit, countryFit, aiAnalysis, structureAnalysisLayers };
  }, [expLayers, npDetail, portfolioRows, structure]);

  if (!open) return null;

  const actualPts = data.series.flatMap(s => s.points.map(p => ({ ...p, series: s.key })));
  const hasPoints = actualPts.length > 0;
  const W = 920;
  const H = 390;
  const pad = { t: 34, r: 28, b: 48, l: 64 };
  const actualXs = actualPts.map(p => p.x).filter(Number.isFinite);
  const actualYs = actualPts.map(p => p.y).filter(Number.isFinite);
  const minXRaw = actualXs.length ? Math.min(...actualXs) : 0.01;
  const maxXRaw = actualXs.length ? Math.max(...actualXs) : 0.2;
  const rawMaxY = Math.max(...actualYs, 0.05);
  let x0 = Math.max(EPS, minXRaw * 0.82);
  let x1 = Math.max(maxXRaw * 1.18, x0 * 1.2);
  if (Math.abs(x1 - x0) < EPS) { x0 *= 0.8; x1 *= 1.2; }

  const sampled = data.series.flatMap((series) => {
    if (!series.fit) return [];
    const out = [];
    for (let i = 0; i <= 90; i += 1) {
      const x = x0 + (x1 - x0) * (i / 90);
      const y = fitAt(series.fit, x);
      if (y > 0 && y <= rawMaxY * 4) out.push({ x, y, series: series.key });
    }
    return out;
  });
  const yVals = [...actualYs, ...sampled.map(p => p.y)].filter(v => Number.isFinite(v) && v > 0);
  const y0 = Math.max(0, (yVals.length ? Math.min(...yVals) : 0.01) * 0.75);
  const y1 = Math.max((yVals.length ? Math.max(...yVals) : 0.12) * 1.25, y0 + 0.05);
  const cw = W - pad.l - pad.r;
  const ch = H - pad.t - pad.b;
  const sx = x => pad.l + ((x - x0) / (x1 - x0 || 1)) * cw;
  const sy = y => pad.t + ch - ((y - y0) / (y1 - y0 || 1)) * ch;
  const yGrid = Array.from({ length: 5 }, (_, i) => y0 + ((y1 - y0) * i) / 4);
  const xGrid = Array.from({ length: 4 }, (_, i) => x0 + ((x1 - x0) * i) / 3);
  const seriesByKey = new Map(data.series.map(s => [s.key, s]));
  const totals = {
    structure: weightedAvg(data.layerRows, r => r.structure),
    expiring: weightedAvg(data.layerRows, r => r.expiring),
    portfolio: weightedAvg(data.layerRows, r => r.portfolio),
    country: weightedAvg(data.layerRows, r => r.country),
  };
  const expiringStatus = data.expFit?.calibrated ? `${data.expFit.n} layers` : 'market default';
  const portfolioStatus = data.portfolioFit ? `${data.portfolioFit.n} layers` : 'insufficient data';
  const countryStatus = data.countryFit ? `${data.countryFit.n} layers` : 'insufficient data';

  return (
    <div className="bm-modal-backdrop" role="presentation" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bm-modal" style={{ width: '100vw', maxWidth: '100vw', height: '100dvh', maxHeight: '100dvh', borderRadius: 0, display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)' }}>
        <div className="bm-modal-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div>Pricing Graph Analysis · {sourceLabel}</div>
            <div style={{ fontSize: 11, fontWeight: 500, color: 'rgba(148,163,184,0.55)', marginTop: 2 }}>
              Expiring implied vs selected structure, portfolio curve, and country curve
            </div>
          </div>
          <button className="bm-pill" onClick={onClose}>Close</button>
        </div>

        <div className="bm-modal-body" style={{ minHeight: 0, height: '100%', maxHeight: 'none', overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 14, padding: '20px 28px' }}>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(180px, 1fr))', gap: 8 }}>
            {[
              { label: 'Structure Wtd ROL', value: fmtPct(totals.structure), color: SERIES[1].color, sub: `${data.layerRows.length} quoted layers` },
              { label: 'Expiring Implied', value: fmtPct(totals.expiring), color: SERIES[0].color, sub: expiringStatus },
              { label: 'Portfolio Curve', value: fmtPct(totals.portfolio), color: SERIES[2].color, sub: portfolioStatus },
              { label: 'Country Curve', value: fmtPct(totals.country), color: SERIES[3].color, sub: countryStatus },
            ].map(card => (
              <div key={card.label} style={{ background: 'rgba(8,14,30,0.72)', border: `1px solid ${card.color}33`, borderRadius: 10, padding: '10px 12px' }}>
                <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.14em', color: card.color, textTransform: 'uppercase' }}>{card.label}</div>
                <div style={{ fontSize: 18, fontWeight: 800, color: 'rgba(226,232,240,0.95)', marginTop: 4 }}>{card.value}</div>
                <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.55)', marginTop: 2 }}>{card.sub}</div>
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, fontSize: 10, color: 'rgba(148,163,184,0.65)' }}>
            {data.series.map(s => (
              <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 18, height: 2, borderTop: `2px ${s.dash ? 'dashed' : 'solid'} ${s.color}` }} />
                <b style={{ color: s.color }}>{s.label}</b>
                <span>{s.points.length} pts</span>
              </span>
            ))}
          </div>

          <div style={{ background: '#070d1c', borderRadius: 12, border: '1px solid rgba(255,255,255,0.07)', padding: '12px 8px' }}>
            {!hasPoints ? (
              <div style={{ padding: 44, textAlign: 'center', color: 'rgba(148,163,184,0.38)', fontSize: 13 }}>
                Enter expiring layers and structure pricing to render the graph.
              </div>
            ) : (
              <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="xMidYMid meet" className="crisp-grid" style={{ display: 'block', fontFamily: 'inherit', fontVariantNumeric: 'tabular-nums' }}>
                {yGrid.map((v, i) => (
                  <g key={`gy${i}`}>
                    <line x1={pad.l} x2={W - pad.r} y1={sy(v)} y2={sy(v)} stroke="rgba(255,255,255,0.07)" vectorEffect="non-scaling-stroke" />
                    <text x={pad.l - 8} y={sy(v) + 4} textAnchor="end" fill="rgba(148,163,184,0.75)" fontSize={10}>{fmtPct(v, 1)}</text>
                  </g>
                ))}
                {xGrid.map((v, i) => (
                  <g key={`gx${i}`}>
                    <line x1={sx(v)} x2={sx(v)} y1={pad.t} y2={H - pad.b} stroke="rgba(255,255,255,0.05)" vectorEffect="non-scaling-stroke" />
                    <text x={sx(v)} y={H - 16} textAnchor="middle" fill="rgba(148,163,184,0.60)" fontSize={9}>{v.toFixed(3)}</text>
                  </g>
                ))}
                <line x1={pad.l} y1={pad.t} x2={pad.l} y2={H - pad.b} stroke="rgba(255,255,255,0.30)" vectorEffect="non-scaling-stroke" />
                <line x1={pad.l} y1={H - pad.b} x2={W - pad.r} y2={H - pad.b} stroke="rgba(255,255,255,0.30)" vectorEffect="non-scaling-stroke" />
                <text x={pad.l - 8} y={pad.t - 12} textAnchor="end" fill="rgba(148,163,184,0.65)" fontSize={10} fontWeight="700">ROL</text>
                <text x={W / 2} y={H - 4} textAnchor="middle" fill="rgba(148,163,184,0.65)" fontSize={10} fontWeight="700">x = sqrt((limit + attachment) * attachment) / EGNPI</text>

                {data.series.map((s) => {
                  if (!s.fit) return null;
                  const pts = [];
                  for (let i = 0; i <= 90; i += 1) {
                    const x = x0 + (x1 - x0) * (i / 90);
                    const y = fitAt(s.fit, x);
                    if (y > 0 && y <= rawMaxY * 4) pts.push(`${sx(x).toFixed(1)},${sy(y).toFixed(1)}`);
                  }
                  return pts.length > 1 ? (
                    <polyline key={s.key} points={pts.join(' ')} fill="none" stroke={s.color} strokeWidth={s.key === 'structure' ? 2.8 : 2} strokeDasharray={s.dash} strokeLinejoin="round" strokeLinecap="round" opacity={s.key === 'portfolio' ? 0.72 : 0.92} vectorEffect="non-scaling-stroke" />
                  ) : null;
                })}

                {actualPts.map((p, idx) => {
                  const s = seriesByKey.get(p.series);
                  const isMarket = p.series === 'portfolio' || p.series === 'country';
                  return (
                    <g key={`${p.series}-${idx}`}>
                      <circle cx={sx(p.x)} cy={sy(p.y)} r={isMarket ? 3.2 : 5.5} fill={s?.color || '#fff'} opacity={isMarket ? 0.36 : 0.95} />
                      {!isMarket && <text x={sx(p.x) + 8} y={sy(p.y) + 4} fontSize={10} fill={s?.color || '#fff'} fontWeight={800}>{p.label}</text>}
                    </g>
                  );
                })}
              </svg>
            )}
          </div>

          <div style={{ overflowX: 'auto', borderRadius: 10, border: '1px solid rgba(255,255,255,0.07)' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 820, fontSize: 11 }}>
              <thead style={{ background: '#050810' }}>
                <tr>
                  {['Layer', 'Limit', 'Attachment', 'Structure ROL', 'Expiring implied', 'Portfolio', 'Country', 'Vs Expiring', 'Vs Country'].map((h, i) => (
                    <th key={h} style={{ padding: '8px 10px', textAlign: i === 0 ? 'left' : 'right', fontSize: 10, fontWeight: 800, letterSpacing: '.12em', color: 'rgba(148,163,184,0.65)', textTransform: 'uppercase', borderBottom: '1px solid rgba(255,255,255,0.10)' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {data.layerRows.map(r => {
                  const diff = v => v == null ? '-' : `${v >= 0 ? '+' : ''}${(v * 100).toFixed(1)}%`;
                  const diffColor = v => v == null ? 'rgba(148,163,184,0.55)' : v > 0 ? '#f87171' : '#4ade80';
                  return (
                    <tr key={r.label} style={{ background: '#080f23' }}>
                      <td style={{ padding: '8px 10px', color: FQ_STRUCTURE_COLORS[0], fontWeight: 800 }}>{r.label}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right' }}>{currency ? `${currency} ` : ''}{fmtMoney(r.limit)}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right' }}>{currency ? `${currency} ` : ''}{fmtMoney(r.attachment)}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', color: SERIES[1].color, fontWeight: 800 }}>{fmtPct(r.structure)}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', color: SERIES[0].color }}>{fmtPct(r.expiring)}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', color: SERIES[2].color }}>{fmtPct(r.portfolio)}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', color: SERIES[3].color }}>{fmtPct(r.country)}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', color: diffColor(r.vsExpiring), fontWeight: 800 }}>{diff(r.vsExpiring)}</td>
                      <td style={{ padding: '8px 10px', textAlign: 'right', color: diffColor(r.vsCountry), fontWeight: 800 }}>{diff(r.vsCountry)}</td>
                    </tr>
                  );
                })}
                {data.layerRows.length === 0 && (
                  <tr>
                    <td colSpan={9} style={{ padding: 24, textAlign: 'center', color: 'rgba(148,163,184,0.38)' }}>
                      This structure needs limit, attachment, and pricing before graph analysis is available.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 12, alignItems: 'stretch' }}>
            <section style={{ background: 'rgba(8,14,30,0.72)', border: `1px solid ${data.aiAnalysis.target.color}`, borderRadius: 12, overflow: 'hidden' }}>
              <div style={{ padding: '12px 14px', borderBottom: '1px solid rgba(255,255,255,0.07)', display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
                <div>
                  <div style={{ fontSize: 12, fontWeight: 850, letterSpacing: '.12em', textTransform: 'uppercase', color: data.aiAnalysis.target.color }}>
                    AI Suggested Deductible Pricing
                  </div>
                  <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.58)', marginTop: 2 }}>
                    Anchor curve: {data.aiAnalysis.target.label}
                  </div>
                </div>
                <div style={{ fontSize: 11, color: 'rgba(226,232,240,0.78)', fontWeight: 750 }}>
                  Suggested Wtd ROL {fmtPct(data.aiAnalysis.summary.aiRol)}
                </div>
              </div>

              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1260, fontSize: 11 }}>
                  <thead style={{ background: '#050810' }}>
                    <tr>
                      {['Layer', 'Current Limit', 'AI Limit', 'Current Deductible', 'AI Deductible', 'Current ROL', 'AI ROL', 'AI Rate', 'AI Premium', 'Reason'].map((h, i) => (
                        <th key={h} style={{ padding: '8px 10px', textAlign: i === 0 || i === 9 ? 'left' : 'right', fontSize: 10, fontWeight: 800, letterSpacing: '.12em', color: 'rgba(148,163,184,0.65)', textTransform: 'uppercase', borderBottom: '1px solid rgba(255,255,255,0.10)' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {data.aiAnalysis.rows.map(r => (
                      <tr key={`ai-${r.label}`} style={{ background: '#080f23' }}>
                        <td style={{ padding: '8px 10px', color: FQ_STRUCTURE_COLORS[0], fontWeight: 850 }}>{r.label}</td>
                        <td style={{ padding: '8px 10px', textAlign: 'right' }}>{moneyWithCurrency(r.limit, currency)}</td>
                        <td style={{ padding: '8px 10px', textAlign: 'right', color: data.aiAnalysis.target.color, fontWeight: 850 }}>
                          {moneyWithCurrency(r.suggestedLimit, currency)}
                          {r.limitMove != null && (
                            <span style={{ marginLeft: 6, color: r.limitMove > 0 ? '#f59e0b' : '#4ade80', fontSize: 10 }}>
                              {fmtSignedPct(r.limitMove)}
                            </span>
                          )}
                        </td>
                        <td style={{ padding: '8px 10px', textAlign: 'right' }}>{moneyWithCurrency(r.attachment, currency)}</td>
                        <td style={{ padding: '8px 10px', textAlign: 'right', color: data.aiAnalysis.target.color, fontWeight: 850 }}>
                          {moneyWithCurrency(r.suggestedDeductible, currency)}
                          {r.deductibleMove != null && (
                            <span style={{ marginLeft: 6, color: r.deductibleMove > 0 ? '#f59e0b' : '#4ade80', fontSize: 10 }}>
                              {fmtSignedPct(r.deductibleMove)}
                            </span>
                          )}
                        </td>
                        <td style={{ padding: '8px 10px', textAlign: 'right', color: SERIES[1].color, fontWeight: 800 }}>{fmtPct(r.currentRol)}</td>
                        <td style={{ padding: '8px 10px', textAlign: 'right', color: data.aiAnalysis.target.color, fontWeight: 850 }}>{fmtPct(r.aiRol)}</td>
                        <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtPct(r.aiRate)}</td>
                        <td style={{ padding: '8px 10px', textAlign: 'right' }}>{moneyWithCurrency(r.aiPremium, currency)}</td>
                        <td style={{ padding: '8px 10px', color: 'rgba(226,232,240,0.72)', minWidth: 280 }}>{r.reason}</td>
                      </tr>
                    ))}
                    {data.aiAnalysis.rows.length === 0 && (
                      <tr>
                        <td colSpan={10} style={{ padding: 22, textAlign: 'center', color: 'rgba(148,163,184,0.38)' }}>
                          Add quoted structure layers to generate deductible pricing suggestions.
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </section>

            <section style={{ background: 'rgba(8,14,30,0.72)', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 12, padding: 14 }}>
              <div style={{ fontSize: 12, fontWeight: 850, letterSpacing: '.12em', textTransform: 'uppercase', color: 'rgba(226,232,240,0.86)' }}>
                Structure Analysis
              </div>
              <div style={{ marginTop: 12, display: 'grid', gap: 12 }}>
                {data.structureAnalysisLayers.map(layer => (
                  <div key={`structure-analysis-layer-${layer.layerNumber}`} style={{ border: '1px solid rgba(255,255,255,0.07)', borderRadius: 10, overflow: 'hidden', background: 'rgba(5,8,16,0.32)' }}>
                    <div style={{ padding: '9px 11px', borderBottom: '1px solid rgba(255,255,255,0.07)', display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10 }}>
                      <div style={{ fontSize: 11, fontWeight: 850, letterSpacing: '.12em', textTransform: 'uppercase', color: FQ_STRUCTURE_COLORS[(layer.layerNumber - 1) % FQ_STRUCTURE_COLORS.length] }}>
                        Layer {layer.layerNumber}
                      </div>
                      <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.55)' }}>
                        Structure metrics vs same-layer market averages
                      </div>
                    </div>
                    <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1120, fontSize: 11 }}>
                        <thead style={{ background: '#050810' }}>
                          <tr>
                            {[
                              'Metric',
                              'Structure Metric',
                              'Country Average',
                              'Region Average',
                              'Global Average',
                              'Within Country Average',
                              'Within Region Average',
                              'Within Global Average',
                            ].map((h, i) => (
                              <th key={h} style={{ padding: '8px 10px', textAlign: i === 0 ? 'left' : 'right', fontSize: 9, fontWeight: 850, letterSpacing: '.11em', color: 'rgba(148,163,184,0.68)', textTransform: 'uppercase', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                                {h}
                              </th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {layer.rows.map(row => (
                            <tr key={`${layer.layerNumber}-${row.key}`} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                              <td style={{ padding: '7px 10px', color: 'rgba(226,232,240,0.82)', fontWeight: 800 }}>{row.label}</td>
                              <td style={{ padding: '7px 10px', textAlign: 'right', color: SERIES[1].color, fontWeight: 850 }}>{formatStructureMetric(row.structureValue, row.format, currency)}</td>
                              <td style={{ padding: '7px 10px', textAlign: 'right' }}>{formatStructureMetric(row.countryAverage, row.format, currency)}</td>
                              <td style={{ padding: '7px 10px', textAlign: 'right' }}>{formatStructureMetric(row.regionAverage, row.format, currency)}</td>
                              <td style={{ padding: '7px 10px', textAlign: 'right' }}>{formatStructureMetric(row.globalAverage, row.format, currency)}</td>
                              <td style={{ padding: '7px 10px', textAlign: 'right', color: row.withinCountry.color, fontWeight: 800 }}>{row.withinCountry.label}</td>
                              <td style={{ padding: '7px 10px', textAlign: 'right', color: row.withinRegion.color, fontWeight: 800 }}>{row.withinRegion.label}</td>
                              <td style={{ padding: '7px 10px', textAlign: 'right', color: row.withinGlobal.color, fontWeight: 800 }}>{row.withinGlobal.label}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  </div>
                ))}
                {data.structureAnalysisLayers.length === 0 && (
                  <div style={{ padding: 18, textAlign: 'center', border: '1px solid rgba(255,255,255,0.07)', borderRadius: 10, color: 'rgba(148,163,184,0.42)', fontSize: 12 }}>
                    Add structure layers to compare layer metrics against country, region, and global averages.
                  </div>
                )}
              </div>
            </section>
          </div>

          <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.45)' }}>
            Default coefficients are a={FQ_MARKET_A.toFixed(3)}, b={FQ_MARKET_B.toFixed(3)} when expiring terms are not sufficient. Portfolio and country curves only render when at least two valid portfolio layer points are available.
          </div>
        </div>
      </div>
    </div>
  );
}
