import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../../api';
import { useContractId } from '../../../hooks/useContractId';
import { useAppState } from '../../../context/AppContext';
import WizardLayout from '../../../components/WizardLayout';
import PctInput from '../../../components/PctInput';
import { formatWithCommas } from '../../../utils/format';
import { getNpTreatyTypeMode, isNpCatFlowDisabled, isNpRiskFlowDisabled, isNpAggregateXlTreaty } from '../../../utils/npTreatyType';
import NpAggregateXlStructure from '../structure/NpAggregateXlStructure';
import NpAggregateXlHero from './components/NpAggregateXlHero';
import { getRole, getUserDisplayName } from '../../../utils/auth';
import { useGlobalToast } from '../../../hooks/useToast';
import { handleStaleWrite } from '../../../utils/handleStaleWrite';
import { formatPricingDriftMessage } from '../../../utils/pricingErrors';
import { calcLayerPricing } from '../../../utils/npPricingEngine';
import LossSelectionScreen from '../../shared/LossSelectionScreen';
import ProfileScreen from '../../shared/ProfileScreen';
import NpCrestaAggregates from '../cresta_zones/NpCrestaAggregates';
import NpMarketAnalysis from './NpMarketAnalysis';

import { exportNpPricingToExcel } from './exportPricingToExcel.js';
// Quote-mode pricing screen reuses the QuickBenchmark visual language
// (bm-topbar, bm-card, bm-meta-grid) so a treaty quote feels like an
// extension of the benchmarking workflow. All bm-* classes are defined
// in the benchmark.css file imported below — keep that file as the
// single source of truth for those styles.
import '../../benchmark/benchmark.css';

// Extracted out of this file to trim it down. Keep this list tight;
// every symbol used below must be either imported here or defined
// locally. If you're adding a new helper, put it in formatters.js so
// it can be tested in isolation.
import { ROUTE_KEY } from './constants.js';
import { toN, fmtC, pct, emptyLayerPricing, deriveCombinedUwPrice, deriveComponentTotal } from './formatters.js';
import SaveStateIndicator from './components/SaveStateIndicator.jsx';
import NpBloombergHero from './components/NpBloombergHero.jsx';
import CedantSummaryTabs from '../../../components/cedant/CedantSummaryTabs';
import NpChecklistPanel from './components/NpChecklistPanel.jsx';
import NpReinsurerModal from './components/NpReinsurerModal.jsx';
import NpTechAnalysisModal from './components/NpTechAnalysisModal.jsx';
import NpLayerTable from './components/NpLayerTable.jsx';
import FQCobSelectModal from './components/FQCobSelectModal.jsx';
import { FQNumCell, FQPctCell, FQReadCell } from './components/FQCells.jsx';
import FQBenchmarkModal from './components/FQBenchmarkModal.jsx';
import FQPricingCurve from './components/FQPricingCurve.jsx';
import FQPricingGraphModal from './components/FQPricingGraphModal.jsx';
import { calcTechRatio } from './pricingHelpers.js';
import { FQ_STRUCTURE_COLORS, fqBuildPricingCurve, fqPriceLayerOnCurve, fqQuoteLayerDerived } from './fqHelpers.js';
import MarketIntelligenceModal from '../../../components/market/MarketIntelligenceModal.jsx';

const fmtAutoPct = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  return String(Math.round(n * 10000) / 10000);
};

const fmtAutoAmount = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  return String(Math.round(n));
};

const expLayerEarnedPremium = (layer = {}) => {
  const explicit = toN(layer.earnedPremium) || toN(layer.earned_premium);
  if (explicit > 0) return explicit;
  const egnpi = toN(layer.egnpi);
  const rate = toN(layer.rate);
  if (egnpi > 0 && rate > 0) return egnpi * rate / 100;
  const limit = toN(layer.limit);
  const rol = toN(layer.rol);
  if (limit > 0 && rol > 0) return limit * rol / 100;
  return 0;
};

const syncExpLayerPricing = (layer, editedField) => {
  const source = editedField === 'rol'
    ? 'rol'
    : editedField === 'rate'
      ? 'rate'
      : layer.pricingSource === 'rol'
        ? 'rol'
        : 'rate';
  const next = { ...layer };
  if (editedField === 'rate' || editedField === 'rol') next.pricingSource = source;

  const limit = toN(next.limit);
  const egnpi = toN(next.egnpi);
  const rate = toN(next.rate);
  const rol = toN(next.rol);

  if (source === 'rate') {
    next.earnedPremium = egnpi > 0 && rate > 0 ? fmtAutoAmount(egnpi * rate / 100) : '';
    next.rol = limit > 0 && egnpi > 0 && rate > 0 ? fmtAutoPct((rate * egnpi) / limit) : '';
    return next;
  }

  next.earnedPremium = limit > 0 && rol > 0 ? fmtAutoAmount(limit * rol / 100) : '';
  next.rate = limit > 0 && egnpi > 0 && rol > 0 ? fmtAutoPct((rol * limit) / egnpi) : '';
  return next;
};

const QUOTE_PRICING_INPUT_FIELDS = new Set(['pureBurn', 'pareto', 'exposure', 'wtBurn', 'wtPareto', 'loading']);

const QUOTE_COMPONENT_SCOPES = {
  risk: {
    label: 'Risk',
    color: '#38bdf8',
    fields: {
      pureBurn: 'riskPureBurn',
      pareto: 'riskPareto',
      exposure: 'riskExposure',
      wtBurn: 'riskWeightBurn',
      wtPareto: 'riskWeightPareto',
      loading: 'riskLoading',
      uwPrice: 'riskUwPrice',
    },
  },
  cat: {
    label: 'Cat',
    color: '#a78bfa',
    fields: {
      pureBurn: 'catPureBurn',
      pareto: 'catPareto',
      exposure: 'catExposure',
      wtBurn: 'catWeightBurn',
      wtPareto: 'catWeightPareto',
      loading: 'catLoading',
      uwPrice: 'catUwPrice',
    },
  },
};

const QUOTE_COMPONENT_INPUT_FIELDS = new Set(
  Object.values(QUOTE_COMPONENT_SCOPES).flatMap((scope) => [
    scope.fields.pureBurn,
    scope.fields.pareto,
    scope.fields.exposure,
    scope.fields.wtBurn,
    scope.fields.wtPareto,
    scope.fields.loading,
  ]),
);
const QUOTE_COMPONENT_UW_FIELDS = new Set(
  Object.values(QUOTE_COMPONENT_SCOPES).map((scope) => scope.fields.uwPrice),
);
const QUOTE_COMPONENT_FIELD_TO_SCOPE = Object.entries(QUOTE_COMPONENT_SCOPES).reduce((acc, [scopeKey, scope]) => {
  Object.values(scope.fields).forEach((field) => { acc[field] = scopeKey; });
  return acc;
}, {});

const pickQuoteField = (layer = {}, keys = [], fallback = '') => {
  for (const key of keys) {
    const value = layer[key];
    if (value != null && String(value).trim() !== '') return String(value);
  }
  return fallback;
};

const pickQuoteBool = (layer = {}, keys = [], fallback = false) => {
  for (const key of keys) {
    const value = layer[key];
    if (value == null || value === '') continue;
    if (typeof value === 'boolean') return value;
    const text = String(value).trim().toLowerCase();
    if (['true', '1', 'yes', 'y', 'risk', 'cat', 'both'].includes(text)) return true;
    if (['false', '0', 'no', 'n', 'none'].includes(text)) return false;
  }
  return fallback;
};

const fmtPctInput = (value, fallback = '') => {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return String(Math.round(n * 10000) / 10000);
};

const quoteActiveScopes = (layer = {}) => (
  Object.keys(QUOTE_COMPONENT_SCOPES).filter((scope) => !!layer[scope])
);

const quoteComponentBaseDerived = (layer = {}, scopeKey) => {
  const scope = QUOTE_COMPONENT_SCOPES[scopeKey];
  if (!scope) return fqQuoteLayerDerived(layer);
  const f = scope.fields;
  const pureBurn = toN(layer[f.pureBurn]);
  const pareto = toN(layer[f.pareto]);
  const exposure = toN(layer[f.exposure]);
  const wtBurn = toN(layer[f.wtBurn] || '50');
  const wtPareto = toN(layer[f.wtPareto] || '0');
  const loading = toN(layer[f.loading] || '15');
  const wtExp = Math.max(0, 100 - wtBurn - wtPareto);
  const burnPlusPareto = pureBurn + pareto;
  const weightTotal = wtBurn + wtPareto + wtExp;
  const blendedRol = weightTotal > 0
    ? ((wtBurn * pureBurn) + (wtPareto * pareto) + (wtExp * exposure)) / weightTotal
    : 0;
  const modeledRol = deriveComponentTotal(pureBurn, pareto, exposure, wtBurn, wtPareto, wtExp, loading);
  return {
    pureBurn,
    pareto,
    exposure,
    wtBurn,
    wtPareto,
    loading,
    wtExp,
    burnPlusPareto,
    blendedRol,
    modeledRol,
    totalRol: modeledRol,
  };
};

// Anything past this is almost certainly corrupted saved data — a real
// NP layer ROL is at most a few hundred %, never tens of thousands.
// Past values that landed in the wrong unit (premium-as-percent) read
// in the millions; clamp here so the displayed Total ROL falls back to
// the modeled value instead of carrying garbage through the structure
// rollup.
const QUOTE_UW_PRICE_SANITY_MAX_PCT = 10000;

const isUwPriceSane = (n) => Number.isFinite(n) && n > 0 && n <= QUOTE_UW_PRICE_SANITY_MAX_PCT;

const quoteComponentDerived = (layer = {}, scopeKey, opts = {}) => {
  const scope = QUOTE_COMPONENT_SCOPES[scopeKey];
  const base = quoteComponentBaseDerived(layer, scopeKey);
  if (!scope || opts.ignoreUw) return base;
  const explicitUw = toN(layer[scope.fields.uwPrice]);
  return { ...base, totalRol: isUwPriceSane(explicitUw) ? explicitUw : base.modeledRol };
};

const quoteComponentAutoTracksUw = (layer = {}, scopeKey) => {
  const scope = QUOTE_COMPONENT_SCOPES[scopeKey];
  if (!scope) return true;
  const raw = String(layer[scope.fields.uwPrice] ?? '').trim();
  if (!raw) return true;
  const modeledRol = quoteComponentDerived(layer, scopeKey, { ignoreUw: true }).modeledRol;
  return modeledRol > 0 && Math.abs(toN(raw) - modeledRol) <= 0.01;
};

const seedQuoteLayerComponents = (layer = {}) => {
  const next = { ...layer };
  quoteActiveScopes(next).forEach((scopeKey) => {
    const f = QUOTE_COMPONENT_SCOPES[scopeKey].fields;
    next[f.pureBurn] = pickQuoteField(next, [f.pureBurn], next.pureBurn || '');
    next[f.pareto] = pickQuoteField(next, [f.pareto], next.pareto || '0');
    next[f.exposure] = pickQuoteField(next, [f.exposure], next.exposure || '');
    next[f.wtBurn] = pickQuoteField(next, [f.wtBurn], next.wtBurn || '50');
    next[f.wtPareto] = pickQuoteField(next, [f.wtPareto], next.wtPareto || '0');
    next[f.loading] = pickQuoteField(next, [f.loading], next.loading || '15');
    next[f.uwPrice] = pickQuoteField(next, [f.uwPrice], next.uwPrice || '');
  });
  return next;
};

const quoteComponentSummary = (layer = {}) => {
  const activeScopes = quoteActiveScopes(layer);
  if (!activeScopes.length) {
    const d = fqQuoteLayerDerived(layer);
    return {
      activeScopes,
      components: [],
      pureBurn: d.pureBurn,
      pareto: d.pareto,
      exposure: d.exposure,
      wtBurn: d.wtBurn,
      wtPareto: d.wtPareto,
      loading: d.loading,
      wtExp: d.wtExp,
      burnPlusPareto: d.burnPlusPareto,
      totalRol: d.totalRol,
    };
  }
  const components = activeScopes.map((scopeKey) => ({
    scopeKey,
    ...quoteComponentDerived(layer, scopeKey),
  }));
  const sum = (key) => components.reduce((s, component) => s + (component[key] || 0), 0);
  const avg = (key, fallback = 0) => (
    components.length ? components.reduce((s, component) => s + (component[key] || 0), 0) / components.length : fallback
  );
  const wtBurn = avg('wtBurn', 50);
  const wtPareto = avg('wtPareto', 0);
  const wtExp = Math.max(0, 100 - wtBurn - wtPareto);
  const loading = avg('loading', 15);
  const pureBurn = sum('pureBurn');
  const pareto = sum('pareto');
  const exposure = sum('exposure');
  // Single weighted-average Total ROL using the row's displayed
  // (pureBurn, pareto, exposure) and the displayed (wtBurn, wtPareto,
  // wtExp, loading). Summing the per-component totalRols silently
  // diverged from this when per-component weights or loadings differed
  // from their averages — the user-facing row would say e.g. wtBurn=50%
  // while the Total ROL was computed against wtBurn=60% for risk and
  // 40% for cat.
  const totalRol = deriveComponentTotal(pureBurn, pareto, exposure, wtBurn, wtPareto, wtExp, loading);
  return {
    activeScopes,
    components,
    pureBurn,
    pareto,
    exposure,
    wtBurn,
    wtPareto,
    loading,
    wtExp,
    burnPlusPareto: sum('burnPlusPareto'),
    totalRol,
  };
};

const quoteLayerDerived = (layer = {}) => {
  const summary = quoteComponentSummary(layer);
  if (!summary.activeScopes.length) return fqQuoteLayerDerived(layer);
  return {
    pureBurn: summary.pureBurn,
    pareto: summary.pareto,
    exposure: summary.exposure,
    wtBurn: summary.wtBurn,
    wtPareto: summary.wtPareto,
    loading: summary.loading,
    wtExp: summary.wtExp,
    burnPlusPareto: summary.burnPlusPareto,
    totalRol: summary.totalRol,
  };
};

const syncQuoteLayerFromComponents = (layer = {}) => {
  const seeded = seedQuoteLayerComponents(layer);
  const summary = quoteComponentSummary(seeded);
  if (!summary.activeScopes.length) return seeded;
  return {
    ...seeded,
    pureBurn: summary.pureBurn > 0 ? fmtAutoPct(summary.pureBurn) : '',
    pareto: summary.pareto > 0 ? fmtAutoPct(summary.pareto) : '0',
    exposure: summary.exposure > 0 ? fmtAutoPct(summary.exposure) : '',
    wtBurn: fmtPctInput(summary.wtBurn, '50'),
    wtPareto: fmtPctInput(summary.wtPareto, '0'),
    loading: fmtPctInput(summary.loading, '15'),
    uwPrice: summary.totalRol > 0 ? fmtAutoPct(summary.totalRol) : '',
  };
};

const applyMainPricingToActiveComponents = (layer = {}, field, value, autoUw = true) => {
  const activeScopes = quoteActiveScopes(layer);
  if (!activeScopes.length) return layer;
  const metric = field === 'uwPrice' ? 'uwPrice' : field;
  const splitField = ['pureBurn', 'pareto', 'exposure', 'uwPrice'].includes(metric);
  const componentValue = splitField && activeScopes.length > 1 && toN(value) > 0
    ? fmtAutoPct(toN(value) / activeScopes.length)
    : value;
  const next = { ...layer };
  activeScopes.forEach((scopeKey) => {
    const scope = QUOTE_COMPONENT_SCOPES[scopeKey];
    const componentField = scope.fields[metric];
    if (!componentField) return;
    next[componentField] = componentValue;
    if (metric !== 'uwPrice' && autoUw && QUOTE_PRICING_INPUT_FIELDS.has(field)) {
      const modeledRol = quoteComponentDerived(next, scopeKey, { ignoreUw: true }).modeledRol;
      next[scope.fields.uwPrice] = modeledRol > 0 ? fmtAutoPct(modeledRol) : '';
    }
  });
  return next;
};

const quoteLayerHasManualPricing = (layer = {}) => (
  toN(layer.pureBurn) > 0 ||
  toN(layer.pareto) > 0 ||
  toN(layer.exposure) > 0 ||
  toN(layer.uwPrice) > 0 ||
  toN(layer.uw_price) > 0 ||
  toN(layer.reinsurerPricing) > 0 ||
  toN(layer.riskPureBurn) > 0 ||
  toN(layer.riskPareto) > 0 ||
  toN(layer.riskExposure) > 0 ||
  toN(layer.riskUwPrice) > 0 ||
  toN(layer.catPureBurn) > 0 ||
  toN(layer.catPareto) > 0 ||
  toN(layer.catExposure) > 0 ||
  toN(layer.catUwPrice) > 0
);

const applyCurvePricingToQuoteLayer = (layer = {}, curve = null) => {
  if (!curve?.fit || quoteLayerHasManualPricing(layer)) return layer;
  const priced = fqPriceLayerOnCurve(layer, curve.fit, curve.baseEgnpi);
  if (!priced) return layer;
  const rolPct = priced.y * 100;
  const loading = toN(layer.loading) || 15;
  // Invert the target-loss-ratio loading used in deriveComponentTotal:
  //   gross = pure / (1 - loading/100)  →  pure = gross * (1 - loading/100)
  // (was `gross / (1 + loading/100)`, which assumed a multiplicative
  // markup and diverged from the canonical loading formula — Total ROL
  // recomputed downstream would then differ from the seeded UW price.)
  const baseRol = rolPct * (1 - loading / 100);
  if (!Number.isFinite(baseRol) || baseRol <= 0) return layer;
  return {
    ...layer,
    egnpi: pickQuoteField(layer, ['egnpi'], fmtAutoAmount(priced.egnpi)),
    pureBurn: pickQuoteField(layer, ['pureBurn', 'pure_burning_cost', 'riskPureBurn', 'catPureBurn'], fmtAutoPct(baseRol)),
    pareto: pickQuoteField(layer, ['pareto', 'pareto_pricing', 'riskPareto', 'catPareto'], '0'),
    exposure: pickQuoteField(layer, ['exposure', 'exposure_rating', 'riskExposure', 'catExposure'], fmtAutoPct(baseRol)),
    uwPrice: pickQuoteField(layer, ['uwPrice', 'uw_price', 'reinsurerPricing', 'riskUwPrice', 'catUwPrice'], fmtAutoPct(rolPct)),
  };
};

const quoteLayerAutoTracksUw = (layer = {}) => {
  const raw = String(layer.uwPrice ?? layer.uw_price ?? '').trim();
  if (!raw) return true;
  const derived = quoteLayerDerived(layer).totalRol;
  return derived > 0 && Math.abs(toN(raw) - derived) <= 0.01;
};

// Treat a saved percent-field value as missing when it parses to something
// that can't represent a real rate (NaN, negative, or absurdly large).
// This catches legacy rows that landed in the wrong unit and would
// otherwise persist through the modeled-vs-explicit fallback.
const sanePctOrEmpty = (raw) => {
  if (raw == null || raw === '') return '';
  const n = toN(raw);
  return isUwPriceSane(n) ? String(raw) : '';
};

const normalizeQuotePricingLayer = (layer = {}, index = 0, opts = {}) => {
  const hasExplicitRiskFlag = layer.risk != null || layer.riskCover != null || layer.isRisk != null;
  const explicitCatFlag = pickQuoteBool(layer, ['cat', 'catCover', 'isCat'], false);
  const riskDefault = !hasExplicitRiskFlag && explicitCatFlag ? false : true;
  const normalized = {
    ...layer,
    id: layer.id ?? index,
    risk: pickQuoteBool(layer, ['risk', 'riskCover', 'isRisk'], riskDefault),
    cat: pickQuoteBool(layer, ['cat', 'catCover', 'isCat'], false),
    limit: pickQuoteField(layer, ['limit', 'layer_limit']),
    attachment: pickQuoteField(layer, ['attachment', 'deductible']),
    egnpi: pickQuoteField(layer, ['egnpi']),
    pureBurn: sanePctOrEmpty(pickQuoteField(layer, ['pureBurn', 'pure_burning_cost', 'riskPureBurn', 'catPureBurn'])),
    pareto: sanePctOrEmpty(pickQuoteField(layer, ['pareto', 'pareto_pricing', 'riskPareto', 'catPareto'])),
    exposure: sanePctOrEmpty(pickQuoteField(layer, ['exposure', 'exposure_rating', 'riskExposure', 'catExposure'])),
    wtBurn: pickQuoteField(layer, ['wtBurn', 'burn_weight_pct', 'riskWeightBurn', 'catWeightBurn'], '50'),
    wtPareto: pickQuoteField(layer, ['wtPareto', 'pareto_weight_pct', 'riskWeightPareto', 'catWeightPareto'], '0'),
    loading: pickQuoteField(layer, ['loading', 'pricing_loading_pct', 'riskLoading', 'catLoading'], '15'),
    uwPrice: sanePctOrEmpty(pickQuoteField(layer, ['uwPrice', 'uw_price', 'reinsurerPricing', 'riskUwPrice', 'catUwPrice'])),
    pAttach: pickQuoteField(layer, ['pAttach', 'prob_attach']),
    pExhaust: pickQuoteField(layer, ['pExhaust', 'prob_exhaust']),
    riskPureBurn: sanePctOrEmpty(pickQuoteField(layer, ['riskPureBurn'])),
    riskPareto: sanePctOrEmpty(pickQuoteField(layer, ['riskPareto'])),
    riskExposure: sanePctOrEmpty(pickQuoteField(layer, ['riskExposure'])),
    riskWeightBurn: pickQuoteField(layer, ['riskWeightBurn', 'riskWtBurn']),
    riskWeightPareto: pickQuoteField(layer, ['riskWeightPareto', 'riskWtPareto']),
    riskLoading: pickQuoteField(layer, ['riskLoading']),
    riskUwPrice: sanePctOrEmpty(pickQuoteField(layer, ['riskUwPrice', 'riskTotalPrice'])),
    catPureBurn: sanePctOrEmpty(pickQuoteField(layer, ['catPureBurn'])),
    catPareto: sanePctOrEmpty(pickQuoteField(layer, ['catPareto'])),
    catExposure: sanePctOrEmpty(pickQuoteField(layer, ['catExposure'])),
    catWeightBurn: pickQuoteField(layer, ['catWeightBurn', 'catWtBurn']),
    catWeightPareto: pickQuoteField(layer, ['catWeightPareto', 'catWtPareto']),
    catLoading: pickQuoteField(layer, ['catLoading']),
    catUwPrice: sanePctOrEmpty(pickQuoteField(layer, ['catUwPrice', 'catTotalPrice'])),
  };
  const priced = syncQuoteLayerFromComponents(applyCurvePricingToQuoteLayer(normalized, opts.curve));
  const derived = quoteLayerDerived(priced);
  if (!String(priced.uwPrice ?? '').trim() && derived.totalRol > 0) {
    return { ...priced, uwPrice: fmtAutoPct(derived.totalRol) };
  }
  return priced;
};

const cascadeQuoteAttachments = (layers = []) => {
  const out = [...layers];
  for (let i = 1; i < out.length; i += 1) {
    const prev = out[i - 1];
    const prevAtt = toN(prev.attachment);
    const prevLim = toN(prev.limit);
    if (prevAtt > 0 || prevLim > 0) {
      out[i] = { ...out[i], attachment: String(prevAtt + prevLim) };
    }
  }
  return out;
};

const normalizeQuoteStructure = (structure = {}, index = 0, opts = {}) => {
  const rawLayers = Array.isArray(structure.layers) ? structure.layers : [];
  const layers = rawLayers.length ? rawLayers : [{}];
  return {
    ...structure,
    id: structure.id || structure.structureId || `str-${index}`,
    layers: cascadeQuoteAttachments(layers.map((layer, layerIndex) => normalizeQuotePricingLayer(layer, layerIndex, opts))),
  };
};

const normalizeQuoteStructures = (structures = [], opts = {}) => (
  (Array.isArray(structures) ? structures : []).map((structure, index) => normalizeQuoteStructure(structure, index, opts))
);

const updateQuotePricingLayer = (layer = {}, field, value, opts = {}) => {
  const autoUw = quoteLayerAutoTracksUw(layer);
  let next = { ...layer, [field]: value };
  if (field === 'risk' || field === 'cat') {
    return syncQuoteLayerFromComponents(next);
  }
  if ((field === 'limit' || field === 'attachment') && !quoteLayerHasManualPricing(next)) {
    next = applyCurvePricingToQuoteLayer(next, opts.curve);
  }
  if (QUOTE_COMPONENT_INPUT_FIELDS.has(field) || QUOTE_COMPONENT_UW_FIELDS.has(field)) {
    const scopeKey = QUOTE_COMPONENT_FIELD_TO_SCOPE[field];
    const scope = QUOTE_COMPONENT_SCOPES[scopeKey];
    if (scope && QUOTE_COMPONENT_INPUT_FIELDS.has(field) && quoteComponentAutoTracksUw(layer, scopeKey)) {
      const modeledRol = quoteComponentDerived(next, scopeKey, { ignoreUw: true }).modeledRol;
      next[scope.fields.uwPrice] = modeledRol > 0 ? fmtAutoPct(modeledRol) : '';
    }
    return syncQuoteLayerFromComponents(next);
  }
  if ((QUOTE_PRICING_INPUT_FIELDS.has(field) || field === 'uwPrice') && quoteActiveScopes(next).length) {
    return syncQuoteLayerFromComponents(applyMainPricingToActiveComponents(next, field, value, autoUw));
  }
  if (QUOTE_PRICING_INPUT_FIELDS.has(field) && autoUw) {
    const derived = quoteLayerDerived(next).totalRol;
    next.uwPrice = derived > 0 ? fmtAutoPct(derived) : '';
  }
  if (quoteActiveScopes(next).length) return syncQuoteLayerFromComponents(next);
  return next;
};

const quoteEnginePct = (value, fallback = '') => {
  const n = toN(value);
  if (!Number.isFinite(n)) return fallback;
  return n > 0 ? fmtAutoPct(n) : '0';
};

const mergeQuoteEngineResult = (layer = {}, result = {}) => {
  const next = { ...layer };
  const applyScope = (scopeKey, component) => {
    const scope = QUOTE_COMPONENT_SCOPES[scopeKey];
    if (!scope || !component) return;
    const f = scope.fields;
    const uwWasAuto = quoteComponentAutoTracksUw(next, scopeKey);
    next[f.pureBurn] = quoteEnginePct(component.pureBurn, next[f.pureBurn]);
    next[f.pareto] = quoteEnginePct(component.pareto, next[f.pareto]);
    next[f.exposure] = quoteEnginePct(component.exposureRating, next[f.exposure]);
    const pAttachField = scopeKey === 'risk' ? 'riskPrAttach' : 'catPrAttach';
    const pExhaustField = scopeKey === 'risk' ? 'riskPrExhaust' : 'catPrExhaust';
    next[pAttachField] = quoteEnginePct(component.prAttach, next[pAttachField]);
    next[pExhaustField] = quoteEnginePct(component.prExhaust, next[pExhaustField]);
    const d = quoteComponentDerived(next, scopeKey, { ignoreUw: true });
    const total = d.modeledRol;
    next[scopeKey === 'risk' ? 'riskTotalPrice' : 'catTotalPrice'] = total > 0 ? fmtAutoPct(total) : '0';
    if (uwWasAuto) next[f.uwPrice] = total > 0 ? fmtAutoPct(total) : '0';
  };
  applyScope('risk', result.risk);
  applyScope('cat', result.cat);
  return syncQuoteLayerFromComponents(next);
};

export default function NpFinalPricing() {
  const contractId = useContractId();
  const { state: appState, structRefsMap } = useAppState();
  const navigate = useNavigate();
  const quoteMode = !!appState.quoteMode;
  const isQuote = quoteMode || ROUTE_KEY === 'NP_FINAL_QUOTE';

  const npDetail = useMemo(() => appState.npTreatyDetail || {}, [appState.npTreatyDetail]);
  const mode = getNpTreatyTypeMode(appState);
  const catDisabled = isNpCatFlowDisabled(appState);
  const riskDisabled = isNpRiskFlowDisabled(appState);
  const currency = npDetail.currencyCode || npDetail.currency || 'SAR';
  // Structure layers synced from NpStructure screen via AppContext
  const structureLayers = useMemo(
    () => (Array.isArray(appState.npStructureLayers) ? appState.npStructureLayers : []),
    [appState.npStructureLayers],
  );

  const [layers, setLayers] = useState([]);
  const [treatyMetrics, setTreatyMetrics] = useState({});
  const [cobUwLimits, setCobUwLimits] = useState([]);   // [{cob_id, cob_name, limit_amount, layers:[bool]}]
  const [expiringEgnpi, setExpiringEgnpi] = useState(0);
  const [reinsurers, setReinsurers] = useState([]);
  const [leadSetup, setLeadSetup] = useState([]);
  const [localStructureLayers, setLocalStructureLayers] = useState([]); // loaded from server, not just AppContext
  const [loading, setLoading] = useState(false);
  const [calcEngineRunning, setCalcEngineRunning] = useState(false);
  const [calcEngineError, setCalcEngineError]   = useState('');
  const [offerStatus, setOfferStatus] = useState('');
  const [showDeclineModal, setShowDeclineModal] = useState(false);
  const [declineReason, setDeclineReason] = useState('');
  const [showOfferModal, setShowOfferModal] = useState(false);
  const [marketModalOpen, setMarketModalOpen] = useState(false);
  // Per-layer written line — keyed by layer index (0-based)
  const [layerWrittenLines, setLayerWrittenLines] = useState({});
  const [offerComment, setOfferComment] = useState('');
  const [offerApprover, setOfferApprover] = useState('');
  const [eligibleApprovers, setEligibleApprovers] = useState([]);
  const [returnReason, setReturnReason] = useState('');
  const [approvalTrail, setApprovalTrail] = useState([]);
  const [signedLinePcts, setSignedLinePcts] = useState({}); // per-layer signed lines
  const isCU = getRole() === 'CU' || getRole() === 'CE'; // only CU/CE see approver panel
  const actorName = useMemo(() => getUserDisplayName(), []);
  const showToast = useGlobalToast();
  const [showReinsurerModal, setShowReinsurerModal] = useState(false);
  const [showTechAnalysisModal, setShowTechAnalysisModal] = useState(false);
  const [insightOpen, setInsightOpen] = useState(false);
  const [progLimView, setProgLimView] = useState('limits'); // 'limits' | 'optimal'
  const [cedantProgLimit, setCedantProgLimit] = useState(0);
  const [contractAgg100, setContractAgg100] = useState(0);   // this contract's CRESTA agg (100%)
  const [otherCountryAgg, setOtherCountryAgg] = useState(0); // other contracts' agg, same country
  const [insightKey, setInsightKey] = useState('');
  const [quoteStructures, setQuoteStructures] = useState([]);
  // Client-side scaffolding for the quote-pricing redesign (mimics
  // QuickBenchmark): an "expiring structure" with a configurable layer
  // count, plus a list of additional structures the user appends with
  // the Add Structure button. Local-only for now — persistence wires
  // up in a follow-up.
  const QM_MAX_LAYERS = 8;
  const QM_MAX_STRUCTURES = 5;
  const emptyExpLayer = (i) => ({
    id: i,
    limit: '',
    attachment: '',
    egnpi: '',
    rate: '',
    earnedPremium: '',
    rol: '',
    mdp: '',
    reinstatements: '',
    pctReinst: '',
    risk: false,
    cat: false,
    pAttach: '',
    pExhaust: '',
  });
  const emptyStrLayer = useCallback((i) => {
    const defaultRisk = !riskDisabled || (riskDisabled && catDisabled);
    const defaultCat = !catDisabled;
    return {
      id: i,
      risk: defaultRisk,
      cat: defaultCat,
      limit: '',
      attachment: '',
      egnpi: '',
      pureBurn: '',
      pareto: '',
      exposure: '',
      wtBurn: '50',
      wtPareto: '0',
      loading: '15',
      uwPrice: '',
      riskPureBurn: '',
      riskPareto: '',
      riskExposure: '',
      riskWeightBurn: '50',
      riskWeightPareto: '0',
      riskLoading: '15',
      riskUwPrice: '',
      catPureBurn: '',
      catPareto: '',
      catExposure: '',
      catWeightBurn: '50',
      catWeightPareto: '0',
      catLoading: '15',
      catUwPrice: '',
      pAttach: '',
      pExhaust: '',
    };
  }, [riskDisabled, catDisabled]);
  // Derived per-layer values for the quote-pricing columns —
  // mirrors NpLayerTable's display logic but stays string-safe for
  // fields the user hasn't typed yet.
  const computeLayerDerived = quoteLayerDerived;
  const [numExpLayers, setNumExpLayers] = useState(3);
  const [expLayers, setExpLayers] = useState(() => Array.from({ length: 3 }, (_, i) => emptyExpLayer(i)));
  const [clientStructures, setClientStructures] = useState([]); // [{ id, layers: [...] }]
  // Cascade attachments: layer[i].attachment = layer[i-1].attachment + layer[i-1].limit.
  // Only the first layer's attachment is editable — every subsequent
  // layer attaches at the top of the previous one. The shared helper
  // (cascadeQuoteAttachments) is used directly below; defined at module
  // scope so it stays stable across renders.
  // COB picker — same shape as QuickBenchmark. selectedCobs carries
  // {id, name}. UW limits are per-structure (scope), so the Expiring
  // Structure and each quoted Structure can size their book of risks
  // independently while sharing the same COB selection.
  // quoteCobUwLimits[scope][cobId] → string (raw digits, no commas).
  // Named with the "quote" prefix to avoid collision with the
  // contract-mode `cobUwLimits` array (loaded from the server) that
  // already lives higher up in this file.
  // cobToggles is keyed by structure scope ('exp' for the expiring
  // structure, structure.id for added ones) → cobId → bool[] indexed
  // by layer. cobManual marks cells where the user explicitly toggled
  // — those bypass the auto-calc (UW limit > layer attachment),
  // mirroring NpStructure.jsx's recomputeCobCoverage rule.
  const [cobList, setCobList] = useState([]);
  const [selectedCobs, setSelectedCobs] = useState([]);
  const [showCobModal, setShowCobModal] = useState(false);
  // Analysis modal — opened from each structure header. The modal owns
  // the Country / Regional / Global scope tabs internally.
  const [benchmarkModal, setBenchmarkModal] = useState({ open: false, scope: 'country', sourceLabel: '', sourceLayers: [] });
  const openBenchmark = (scope, sourceLabel, sourceLayers) =>
    setBenchmarkModal({ open: true, scope, sourceLabel, sourceLayers });
  const [quoteCobUwLimits, setQuoteCobUwLimits] = useState({}); // {scope: {cobId: string}}
  const [cobToggles, setCobToggles] = useState({});
  const [cobManual, setCobManual] = useState({});
  const getCobUwLimit = (scope, cobId) => (quoteCobUwLimits[scope] && quoteCobUwLimits[scope][cobId]) || '';
  const getCobFlags = useCallback((scope, cobId, layers) => {
    const stored = (cobToggles[scope] && cobToggles[scope][cobId]) || [];
    const manual = (cobManual[scope] && cobManual[scope][cobId]) || [];
    const ul = toN((quoteCobUwLimits[scope] && quoteCobUwLimits[scope][cobId]) || '');
    return layers.map((l, i) => {
      if (manual[i]) return !!stored[i];
      return ul > toN(l.attachment);
    });
  }, [cobToggles, cobManual, quoteCobUwLimits]);
  const setCobToggle = (scope, cobId, lIdx, currentFlag) => {
    setCobManual((prev) => {
      const scopeMap = { ...(prev[scope] || {}) };
      const arr = [...(scopeMap[cobId] || [])];
      arr[lIdx] = true;
      scopeMap[cobId] = arr;
      return { ...prev, [scope]: scopeMap };
    });
    setCobToggles((prev) => {
      const scopeMap = { ...(prev[scope] || {}) };
      const flags = [...(scopeMap[cobId] || [])];
      flags[lIdx] = !currentFlag;
      scopeMap[cobId] = flags;
      return { ...prev, [scope]: scopeMap };
    });
  };
  const updateUwLimit = (scope, cobId, val) =>
    setQuoteCobUwLimits((prev) => ({ ...prev, [scope]: { ...(prev[scope] || {}), [cobId]: val } }));
  const [approvedStructures, setApprovedStructures] = useState([]);
  const [quotePricing, setQuotePricing] = useState({});
  const [portfolioTreaties, setPortfolioTreaties] = useState([]);   // similar NP treaties in portfolio
  const [portfolioExportRows, setPortfolioExportRows] = useState([]);
  const [saveState, setSaveState] = useState({ status: 'idle', at: null, error: null }); // idle | saving | saved | error
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);
  const [pricingGraphModal, setPricingGraphModal] = useState({ open: false, sourceLabel: '', structure: null });
  const [pricingAnalysisModal, setPricingAnalysisModal] = useState({ open: false, structureIndex: null });
  const quoteCurve = useMemo(
    () => fqBuildPricingCurve({ expLayers, structures: clientStructures, npDetail }),
    [expLayers, clientStructures, npDetail],
  );

  const updateClientStructureLayer = useCallback((sIdx, lIdx, field, val) => {
    setClientStructures((prev) => prev.map((s, i) => {
      if (i !== sIdx) return s;
      const updated = s.layers.map((row, j) => (
        j === lIdx ? updateQuotePricingLayer(row, field, val, { curve: quoteCurve }) : row
      ));
      const cascaded = (field === 'limit' || (field === 'attachment' && lIdx === 0))
        ? cascadeQuoteAttachments(updated)
        : updated;
      return { ...s, layers: cascaded };
    }));
  }, [quoteCurve]);

  const runQuoteCalcEngine = useCallback(async () => {
    if (!contractId || !clientStructures.length) return;
    const pricingLayers = [];
    const refs = [];
    clientStructures.forEach((structure, sIdx) => {
      const scope = structure.id || `str-${sIdx}`;
      (structure.layers || []).forEach((layer, lIdx) => {
        const classOfBusinessIds = selectedCobs
          .filter((cob) => !!getCobFlags(scope, cob.id, structure.layers)[lIdx])
          .map((cob) => cob.id);
        const layerKey = `${scope}:${layer.id ?? lIdx}`;
        refs.push(layerKey);
        pricingLayers.push({
          ...layer,
          layer: `S${sIdx + 1}L${lIdx + 1}`,
          deductible: layer.attachment || layer.deductible,
          egnpi: layer.egnpi || quoteCurve.baseEgnpi || npDetail.estGnpi || npDetail.egnpi || '',
          riskCover: !!layer.risk,
          catCover: !!layer.cat,
          classOfBusinessIds,
        });
      });
    });
    if (!pricingLayers.length) return;

    setCalcEngineRunning(true);
    setCalcEngineError('');
    try {
      const results = await calcLayerPricing(
        api,
        contractId,
        pricingLayers,
        { ...npDetail, estGnpi: quoteCurve.baseEgnpi || npDetail.estGnpi || npDetail.egnpi },
        mode,
        quoteMode,
      );
      const byKey = new Map();
      results.forEach((result) => {
        const key = refs[result.idx];
        if (key) byKey.set(key, result);
      });
      setClientStructures((prev) => prev.map((structure, sIdx) => {
        const scope = structure.id || `str-${sIdx}`;
        return {
          ...structure,
          layers: (structure.layers || []).map((layer, lIdx) => {
            const result = byKey.get(`${scope}:${layer.id ?? lIdx}`);
            return result ? mergeQuoteEngineResult(layer, result) : layer;
          }),
        };
      }));
    } catch (e) {
      console.error('[NP Quote Calc Engine]', e);
      setCalcEngineError('Quote calculation failed: ' + (e.message || 'unknown error'));
    } finally {
      setCalcEngineRunning(false);
    }
  }, [
    contractId,
    clientStructures,
    selectedCobs,
    getCobFlags,
    quoteCurve.baseEgnpi,
    npDetail,
    mode,
    quoteMode,
  ]);

  const setApprovedQuoteStructure = useCallback((sIdx, checked) => {
    setApprovedStructures((prev) => clientStructures.map((_, i) => (
      i === sIdx ? checked : !!prev[i]
    )));
  }, [clientStructures]);

  const addQuoteStructure = useCallback(() => {
    setClientStructures((prev) => [
      ...prev,
      { id: `str-${Date.now()}-${prev.length}`, layers: [emptyStrLayer(0)] },
    ]);
    setApprovedStructures((prev) => [...prev, false]);
  }, [emptyStrLayer]);

  const addClientStructureLayer = useCallback((sIdx) => {
    setClientStructures((prev) => prev.map((s, i) => {
      if (i !== sIdx) return s;
      return { ...s, layers: cascadeQuoteAttachments([...s.layers, emptyStrLayer(s.layers.length)]) };
    }));
  }, [emptyStrLayer]);

  const removeClientStructureLayer = useCallback((sIdx, lIdx) => {
    setClientStructures((prev) => prev.map((s, i) => {
      if (i !== sIdx) return s;
      return { ...s, layers: cascadeQuoteAttachments(s.layers.filter((_, j) => j !== lIdx)) };
    }));
  }, []);

  const removeClientStructure = useCallback((sIdx) => {
    setClientStructures((prev) => prev.filter((_, i) => i !== sIdx));
    setApprovedStructures((prev) => prev.filter((_, i) => i !== sIdx));
    setPricingAnalysisModal((prev) => {
      if (prev.structureIndex === sIdx) return { open: false, structureIndex: null };
      if (Number.isInteger(prev.structureIndex) && prev.structureIndex > sIdx) {
        return { ...prev, structureIndex: prev.structureIndex - 1 };
      }
      return prev;
    });
  }, []);

  // ── Reset local state when contract changes ──
  const prevCidRef = React.useRef(contractId);
  React.useEffect(() => {
    if (prevCidRef.current !== contractId) {
      prevCidRef.current = contractId;
      setLayers([]);
      setLeadSetup([]);
      setLoading(true);
      setOfferStatus('');
      setShowDeclineModal(false);
      setShowOfferModal(false);
      setQuoteStructures([]);
      setApprovedStructures([]);
      setQuotePricing({});
      // Quote-mode scaffolding state — must reset on contract switch
      // or values from the previous quote leak into the new one.
      setExpLayers(Array.from({ length: 3 }, (_, i) => emptyExpLayer(i)));
      setNumExpLayers(3);
      setClientStructures([]);
      setSelectedCobs([]);
      setQuoteCobUwLimits({});
      setCobToggles({});
      setCobManual({});
      setPricingGraphModal({ open: false, sourceLabel: '', structure: null });
      setPricingAnalysisModal({ open: false, structureIndex: null });
    }
  }, [contractId]);

  // Load class-of-business master list (one-shot) and seed selectedCobs
  // from npDetail.classIds when the user lands on this screen with COBs
  // already picked at the Treaty Detail step.
  React.useEffect(() => {
    let cancelled = false;
    api.listClassOfBusiness().then((rows) => {
      if (cancelled) return;
      const list = Array.isArray(rows) ? rows : [];
      setCobList(list);
      const seedIds = Array.isArray(npDetail.classIds) ? npDetail.classIds : [];
      const map = new Map(list.map((c) => [c.id, c.name]));
      setSelectedCobs(prev => (
        seedIds.length && prev.length === 0
          ? seedIds.map((id) => ({ id, name: map.get(id) || id, uwLimit: '' }))
          : prev
      ));
    }).catch(() => {});
    return () => { cancelled = true; };
    // selectedCobs intentionally not a dep — we only seed once on mount.
  }, [npDetail.classIds]);

  // ── Load quote-mode scaffolding from server when landing on the
  //    Final Quote page. Three sources:
  //      1) /np/expiring  → expLayers + numExpLayers
  //      2) /non-prop      → JSONB scaffolding (clientStructures,
  //                          quoteCobUwLimits, cobToggles, cobManual)
  //      3) /cobs          → selectedCobs (already seeded above from
  //                          npDetail.classIds; this refresh covers
  //                          the case where the server has a more
  //                          recent selection)
  React.useEffect(() => {
    if (!isQuote || !contractId) return undefined;
    let cancelled = false;
    const qm = { quote: true };
    Promise.all([
      api.getNpExpiring(contractId, qm).catch(() => null),
      api.getNonPropTreaty(contractId, qm).catch(() => null),
      api.getContractCobs(contractId, qm).catch(() => []),
    ]).then(([expData, treatyData, quoteCobs]) => {
      if (cancelled) return;

      // 1) Expiring layers from the relational endpoint
      let hydratedExpLayers = null;
      const serverExpLayers = Array.isArray(expData?.layers) ? expData.layers : [];
      if (serverExpLayers.length > 0) {
        const hydrated = serverExpLayers.map((sl, i) => {
          const rawLayer = {
            id: sl.layer_number || i + 1,
            limit:          sl.layer_limit          != null ? String(sl.layer_limit)          : '',
            attachment:     sl.attachment           != null ? String(sl.attachment)           : '',
            egnpi:          sl.egnpi                != null ? String(sl.egnpi)                : '',
            rate:           sl.rate                 != null ? String(sl.rate)                 : '',
            earnedPremium:  sl.earned_premium       != null ? String(sl.earned_premium)       : '',
            rol:            sl.rol                  != null ? String(sl.rol)                  : '',
            mdp:            sl.mdp                  != null ? String(sl.mdp)                  : '',
            reinstatements: sl.num_reinstatements   != null ? String(sl.num_reinstatements)   : '',
            pctReinst:      sl.reinstatement_pct    != null ? String(sl.reinstatement_pct)    : '',
            risk:  sl.peril_scope === 'RISK' || sl.peril_scope === 'BOTH',
            cat:   sl.peril_scope === 'CAT'  || sl.peril_scope === 'BOTH',
            pAttach: '', pExhaust: '',
          };
          if (rawLayer.rate || rawLayer.rol) {
            return syncExpLayerPricing(rawLayer, rawLayer.rate ? 'rate' : 'rol');
          }
          return { ...rawLayer, earnedPremium: rawLayer.earnedPremium || fmtAutoAmount(expLayerEarnedPremium(rawLayer)) };
        });
        hydratedExpLayers = hydrated;
        setExpLayers(hydrated);
        setNumExpLayers(hydrated.length);
      }

      // 2) JSONB scaffolding from the treaty endpoint
      const savedPricing = treatyData?.terms?.np_final_pricing || {};
      const scaffold = savedPricing?.fqScaffolding;
      const curveForHydration = fqBuildPricingCurve({
        expLayers: hydratedExpLayers || [],
        structures: [],
        npDetail,
      });
      if (scaffold && typeof scaffold === 'object') {
        if (Array.isArray(scaffold.clientStructures))   setClientStructures(normalizeQuoteStructures(scaffold.clientStructures, { curve: curveForHydration }));
        if (Array.isArray(scaffold.approvedStructures)) setApprovedStructures(scaffold.approvedStructures.map(Boolean));
        else if (Array.isArray(savedPricing.approvedStructures)) setApprovedStructures(savedPricing.approvedStructures.map(Boolean));
        if (scaffold.quoteCobUwLimits && typeof scaffold.quoteCobUwLimits === 'object') setQuoteCobUwLimits(scaffold.quoteCobUwLimits);
        if (scaffold.cobToggles       && typeof scaffold.cobToggles       === 'object') setCobToggles(scaffold.cobToggles);
        if (scaffold.cobManual        && typeof scaffold.cobManual        === 'object') setCobManual(scaffold.cobManual);
        // Probability fields for expiring layers — stored separately
        // because the relational table has no columns for them yet.
        const expProb = scaffold.expProbabilities;
        if (Array.isArray(expProb) && expProb.length > 0) {
          setExpLayers((prev) => prev.map((l, i) => ({
            ...l,
            pAttach:  expProb[i]?.pAttach  != null ? String(expProb[i].pAttach)  : (l.pAttach  || ''),
            pExhaust: expProb[i]?.pExhaust != null ? String(expProb[i].pExhaust) : (l.pExhaust || ''),
          })));
        }
      } else if (Array.isArray(savedPricing.quoteStructures) && savedPricing.quoteStructures.length > 0) {
        setClientStructures(normalizeQuoteStructures(savedPricing.quoteStructures, { curve: curveForHydration }));
      }

      const serverCobs = Array.isArray(quoteCobs) ? quoteCobs : [];
      if (serverCobs.length > 0) {
        setSelectedCobs(serverCobs.map((c, i) => ({
          id: c.id || c.class_of_business_id || c.cob_id || `quote-cob-${i}`,
          name: c.name || c.cob_name || c.class_of_business || c.label || c.code || `Class ${i + 1}`,
          uwLimit: '',
        })));
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [isQuote, contractId, npDetail]);

  // Programme snapshot
  const snap = useMemo(() => ({
    cedant: npDetail.cedantName || npDetail.cedant || '–',
    treatyType: npDetail.treatyTypeName || npDetail.treatyType || '–',
    cob: selectedCobs.map((c) => c.name).filter(Boolean).join(', ')
      || (npDetail.lineOfBusinessLabels || []).join(', ')
      || npDetail.classOfBusiness
      || '–',
    xlType: npDetail.xlType || npDetail.xl_type || npDetail.typeOfXl || '–',
    renewal: npDetail.renewalDate || npDetail.renewal_date || npDetail.inceptionDate || '–',
  }), [npDetail, selectedCobs]);

  // Load data
  useEffect(() => {
    if (!contractId) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api.getNonPropTreaty(contractId, quoteMode ? { quote: true } : undefined).catch(() => ({})),
      api.getNpPricing(contractId, quoteMode ? { quote: true } : undefined).catch(() => ({})),
      api.listReinsurers().catch(() => []),
    ]).then(([npData, pricing, reins]) => {
      setReinsurers(Array.isArray(reins) ? reins : []);
      setLastUpdatedAt(npData?.updated_at || null);
      const npTerms = npData?.terms || {};
      const savedPricing = npTerms.np_final_pricing || {};
      const struct = npTerms.np_structure || npTerms.structure || npData?.structure || {};
      const structLayers = struct.layers || (npData?.layers || []).map((rl, i) => ({
        layer: `L${i + 1}`, limit: rl.layer_limit || '', deductible: rl.attachment || '',
        egnpi: rl.egnpi || '', earnedPremium: rl.earned_premium || '', rate: rl.rate || '',
        noReinst: rl.num_reinstatements || '',
        reinstPct: String(rl.reinstatement_pct ?? ''),
        risk: rl.peril_scope === 'RISK' || rl.peril_scope === 'BOTH',
        cat: rl.peril_scope === 'CAT' || rl.peril_scope === 'BOTH',
        classOfBusinessIds: Array.isArray(rl.class_of_business_ids) ? rl.class_of_business_ids : [],
      }));
      const pricingLayers = pricing?.layer_inputs || pricing?.layers || [];

      const savedLayers = savedPricing.layers || [];
      const numLayers = savedLayers.length || structLayers.length || parseInt(npDetail.numberOfLayers || npDetail.number_of_layers || '0', 10) || 0;
      const merged = [];
      for (let i = 0; i < numLayers; i++) {
        const sl = structLayers[i] || {};
        const pl = pricingLayers[i] || {};
        const sv = savedLayers[i] || {};
        merged.push({
          ...emptyLayerPricing(i),
          layer: sl.layer || `L${i + 1}`,
          limit: sl.limit || pl.limit || '',
          deductible: sl.deductible || pl.deductible || '',
          risk: sl.riskCover ?? sl.risk ?? pl.risk ?? false,
          cat: sl.catCover ?? sl.cat ?? pl.cat ?? false,
          egnpi: sl.egnpi || '',
          earnedPremium: sl.earnedPremium || '',
          rate: sl.rate || '',
          noReinst: sl.noReinst || sl.reinstatements || '',
          reinstPct: sl.reinstPct || sl.reinstatementPct || '',
          classOfBusinessIds: sl.classOfBusinessIds || [],
          ...pl,
          ...sv,
        });
      }
      setLayers(merged);

      // Always build serverStructLayers from relational layer data (has layer_limit, earned_premium, rol).
      // JSONB structLayers is only a fallback when no relational rows exist (e.g. quote mode).
      const relLayers = Array.isArray(npData?.layers) ? npData.layers : [];
      const serverStructLayers = relLayers.length
        ? relLayers.map((rl, i) => {
            const lim = parseFloat(rl.layer_limit) || 0;
            const ep  = parseFloat(rl.earned_premium) || 0;
            const rolStored = parseFloat(rl.rol) || 0;
            // Use stored rol if present, else derive from earned_premium / layer_limit
            const rolPct = rolStored > 0 ? rolStored : (lim > 0 && ep > 0 ? (ep / lim) * 100 : 0);
            return {
              layer: rl.layer_number || (i + 1),
              limit: lim || '',
              deductible: parseFloat(rl.attachment) || '',
              egnpi: rl.egnpi || '',
              rate: rl.rate || '',
              earnedPremium: ep || '',
              rol: rolPct ? String(rolPct.toFixed(4)) : '',
              riskCover: rl.peril_scope === 'RISK' || rl.peril_scope === 'BOTH',
              catCover:  rl.peril_scope === 'CAT'  || rl.peril_scope === 'BOTH',
              classOfBusinessIds: Array.isArray(rl.class_of_business_ids) ? rl.class_of_business_ids : [],
            };
          })
        : structLayers.map(sl => ({
            ...sl,
            riskCover: sl.riskCover ?? sl.risk ?? false,
            catCover:  sl.catCover  ?? sl.cat  ?? false,
          }));
      setLocalStructureLayers(serverStructLayers);

      // Build COB underwriting limits — combine relational UW limits with JSONB cobRows for names + layer flags
      const rawUwLimits = Array.isArray(npData?.cob_underwriting_limits) ? npData.cob_underwriting_limits : [];
      const jsonbCobRows = struct.cobRows || struct.cob_rows || [];
      if (rawUwLimits.length) {
        const cobRowsMap = new Map(jsonbCobRows.map(r => [String(r.cobId || r.cob_id), r]));
        setCobUwLimits(rawUwLimits.map(r => {
          const row = cobRowsMap.get(String(r.cob_id)) || {};
          return {
            cob_id: r.cob_id,
            cob_name: row.name || r.cob_name || r.cob_id,
            limit_amount: r.limit_amount,
            layers: row.layers || [],   // array of booleans per layer
          };
        }));
      } else if (jsonbCobRows.length) {
        setCobUwLimits(jsonbCobRows.map(r => ({
          cob_id: r.cobId || r.cob_id,
          cob_name: r.name || '',
          limit_amount: r.underwritingLimit || r.limit_amount || '',
          layers: r.layers || [],
        })));
      }
      const ls = savedPricing.leadSetup || pricing?.leadSetup || [];
      setLeadSetup(merged.map((l, i) => ({
        leader: ls[i]?.leader || '',
        expiringReinsurer: ls[i]?.expiringReinsurer || '',
        rol: ls[i]?.rol || '',
        leadShare: ls[i]?.leadShare || '',
      })));

      // ── Offer / approval status — always drive from live DB, never from JSONB ──
      // contract_offer.status (offer_status) is authoritative; uw_status is secondary fallback.
      // JSONB savedPricing.offerStatus is only used if DB has NO offer row at all (very old contracts).
      const UW_STATUS_MAP = {
        WAITING_APPROVAL: 'AWAITING_APPROVAL',
        OFFERED: 'DRAFT', PENDING: 'DRAFT', RETURNED: 'DRAFT', APPROVED: 'AWAITING_SIGNED_LINE',
      };
      const dbOfferStatus = npData?.offer_status || null;
      const dbUwStatus    = npData?.uw_status    || null;
      const dbStatus = dbOfferStatus || (dbUwStatus ? (UW_STATUS_MAP[dbUwStatus] || dbUwStatus) : null);
      setOfferStatus(dbStatus || savedPricing.offerStatus || '');
      // Approver: prefer DB offer row, fall back to JSONB
      setOfferApprover(npData?.offer_approver || savedPricing.offerApprover || '');
      if (savedPricing.offerComment)   setOfferComment(savedPricing.offerComment);
      if (savedPricing.layerWrittenLines) setLayerWrittenLines(savedPricing.layerWrittenLines);
      if (savedPricing.signedLinePcts) setSignedLinePcts(savedPricing.signedLinePcts);
      if (savedPricing.treatyMetrics) setTreatyMetrics(savedPricing.treatyMetrics);

      // ── Auto-open offer modal based on role + resolved status (mirrors PropPricing) ──
      const resolvedStatus = dbStatus || savedPricing.offerStatus || '';
      const role = getRole(); // roleCode e.g. CE, CU, TD, TM, TUW
      if ((role === 'CU' || role === 'CE') && resolvedStatus === 'AWAITING_APPROVAL') setShowOfferModal(true);
      if (role !== 'CU' && role !== 'CE' && (resolvedStatus === 'AWAITING_SIGNED_LINE' || resolvedStatus === 'APPROVED')) setShowOfferModal(true);

      // Load approval trail — pass quoteMode so it hits the correct endpoint
      if (contractId) {
        api.getApprovalTrail(contractId, quoteMode ? { quote: true } : undefined).then(trail => { setApprovalTrail(trail); }).catch(() => {});
        api.getEligibleApprovers(contractId, {}, quoteMode ? { quote: true } : undefined).then(rows => { setEligibleApprovers(Array.isArray(rows) ? rows : []); }).catch(() => {});
      }

      // Cedant programme limits + country aggregates
      if (contractId && !isQuote) {
        api.getCedantProgrammeLimits(contractId).then(data => {
          setCedantProgLimit(parseFloat(data?.totalLimit) || 0);
        }).catch(() => {});

        // Country aggregates: same as proportional
        // contractAgg100 = sum of this contract's CRESTA zones
        // otherCountryAgg = other contracts' agg for same country (excluding this one)
        const countryId = appState.npTreatyDetail?.countryId || null;
        // This branch only runs in treaty mode (gated above on !isQuote),
        // so no quote-mode flag is needed on getCrestaData here.
        api.getCrestaData(contractId).then(rows => {
          const arr = Array.isArray(rows) ? rows : (Array.isArray(rows?.rows) ? rows.rows : []);
          const total = arr.reduce((s, r) =>
            s + (parseFloat(r.eq_agg||0)||0) + (parseFloat(r.ws_agg||0)||0) +
                (parseFloat(r.flood_agg||0)||0) + (parseFloat(r.srcc_agg||0)||0) + (parseFloat(r.others_agg||0)||0), 0);
          setContractAgg100(total);
        }).catch(() => {});
        if (countryId) {
          api.getCountryAggregates(countryId, { excludeContractId: contractId }).then(cd => {
            setOtherCountryAgg(parseFloat(cd?.total_country_agg ?? cd?.total_agg ?? 0) || 0);
          }).catch(() => {});
        }
      }

      // Quote mode hydration
      if (isQuote) {
        // Match prototype getQuoteStructuresFromState() — try structures[], fallback to single structure from layers
        // Priority: JSONB savedPricing.quoteStructures (our live-edit save) > struct.structures > structLayers > relational layers
        let qs = (savedPricing.quoteStructures?.length ? savedPricing.quoteStructures : null)
               || (struct.structures || []);
        if (!qs.length && structLayers.length) {
          qs = [{ layers: structLayers, cobRows: struct.cobRows || [] }];
        }
        // Also try npData.layers (relational) if still empty — map all columns
        if (!qs.length && Array.isArray(npData?.layers) && npData.layers.length) {
          qs = [{ layers: npData.layers.map((rl, i) => ({
            layer: i + 1,
            limit:          rl.layer_limit        || '',
            deductible:     rl.attachment          || '',
            annualAggLimit: rl.aggregate_limit     || '',
            egnpi:          rl.egnpi               || '',
            earnedPremium:  rl.earned_premium      || '',
            reinstatements:    rl.num_reinstatements != null ? String(rl.num_reinstatements) : '',
            reinstatementPct:  rl.reinstatement_pct != null ? String(rl.reinstatement_pct)  : '',
            aad:               !!(rl.annual_agg_deductible),
            aadAmount:         rl.annual_agg_deductible || '',
            riskCover: rl.peril_scope === 'RISK' || rl.peril_scope === 'BOTH',
            catCover:  rl.peril_scope === 'CAT'  || rl.peril_scope === 'BOTH',
          })), cobRows: [] }];
        }
        setQuoteStructures(qs);
        const savedApproved = Array.isArray(savedPricing.fqScaffolding?.approvedStructures)
          ? savedPricing.fqScaffolding.approvedStructures
          : (savedPricing.approvedStructures || []);
        if (qs.length) {
          setApprovedStructures(qs.map((_, i) => !!savedApproved[i]));
        } else if (Array.isArray(savedApproved)) {
          setApprovedStructures(savedApproved.map(Boolean));
        }
        setQuotePricing(savedPricing.quotePricing || {});
      }
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [contractId, quoteMode, npDetail, isQuote, appState.npTreatyDetail?.countryId]);

  // ── Auto-calculate treaty metrics from expiring + current structure ──
  useEffect(() => {
    if (!contractId) return;
    let cancelled = false;
    const qm = quoteMode ? { quote: true } : undefined;
    api.getNpExpiring(contractId, qm).then(exp => {
      if (cancelled) return;
      if (!exp || (!exp.terms && !exp.layers?.length)) return;
      const et = exp.terms || {};
      const expLayers = exp.layers || [];
      const expEgnpi     = parseFloat(et.egnpi) || 0;
      if (expEgnpi) setExpiringEgnpi(expEgnpi);

      // ── Expiring (previous year) calculations ──
      const expFirstDed = expLayers.length ? (parseFloat(expLayers[0].attachment) || 0) : (parseFloat(et.deductible) || 0);
      const expTotalLimit = expLayers.reduce((s, l) => s + (parseFloat(l.layer_limit) || 0), 0);
      const expTotalAgg = expLayers.reduce((s, l) => s + (parseFloat(l.aggregate_limit) || 0), 0);
      const expTotalEP  = expLayers.reduce((s, l) => s + (parseFloat(l.earned_premium) || 0), 0);
      // Rate = total earned premium / EGNPI (overall programme rate)
      const expRate = expEgnpi > 0 ? (expTotalEP / expEgnpi * 100) : 0;

      // ── Current year calculations ──
      const curEgnpi = parseFloat(npDetail.estGnpi) || 0;
      const curLayers = localStructureLayers.length ? localStructureLayers : [];
      const curFirstDed = curLayers.length ? (parseFloat(curLayers[0].deductible ?? curLayers[0].attachment) || 0) : (parseFloat(npDetail.deductible) || 0);
      const curTotalLimit = curLayers.reduce((s, l) => s + (parseFloat(l.limit) || 0), 0);
      const curTotalAgg = curLayers.reduce((s, l) => s + (parseFloat(l.annualAggLimit ?? l.aggregate_limit) || 0), 0);
      const curTotalEP  = curLayers.reduce((s, l) => s + (parseFloat(l.earnedPremium ?? l.earned_premium) || 0), 0);
      const curRate = curEgnpi > 0 ? (curTotalEP / curEgnpi * 100) : 0;

      setTreatyMetrics(prev => {
        const next = { ...prev };
        const autoPrev = (k, val) => { if (!next[k + '_prev'] && val) next[k + '_prev'] = String(val); };
        const autoCurr = (k, val) => { if (val) next[k + '_curr'] = String(val); };

        // Deductible as % of Cover = first layer deductible / total limit of all layers
        if (expFirstDed && expTotalLimit) autoPrev('ded_pct_cover', ((expFirstDed / expTotalLimit) * 100).toFixed(2) + '%');
        if (curFirstDed && curTotalLimit) autoCurr('ded_pct_cover', ((curFirstDed / curTotalLimit) * 100).toFixed(2) + '%');

        // Deductible as % EGNPI
        if (expFirstDed && expEgnpi) autoPrev('ded_pct_egnpi', ((expFirstDed / expEgnpi) * 100).toFixed(2) + '%');
        if (curFirstDed && curEgnpi) autoCurr('ded_pct_egnpi', ((curFirstDed / curEgnpi) * 100).toFixed(2) + '%');

        // % Change EGNPI — show absolute values, % change auto-computed in render
        if (expEgnpi) autoPrev('chg_egnpi', expEgnpi.toLocaleString());
        if (curEgnpi) autoCurr('chg_egnpi', curEgnpi.toLocaleString());

        // % Change Aggregates — sum of all aggregate limits per year
        if (expTotalAgg) autoPrev('chg_aggregates', expTotalAgg.toLocaleString());
        if (curTotalAgg) autoCurr('chg_aggregates', curTotalAgg.toLocaleString());

        // % Change in Rates — total earned premium / EGNPI (programme rate)
        if (expRate) autoPrev('chg_rates', expRate.toFixed(4) + '%');
        if (curRate) autoCurr('chg_rates', curRate.toFixed(4) + '%');

        // % Change in Risk Profile — weighted average ROL across layers
        // ROL = earned premium / limit per layer, weighted by limit
        if (expTotalLimit > 0 && expLayers.length) {
          const wtdRol = expLayers.reduce((s, l) => {
            const lim = parseFloat(l.layer_limit) || 0;
            const ep = parseFloat(l.earned_premium) || 0;
            return s + (lim > 0 ? (ep / lim) * lim : 0);
          }, 0) / expTotalLimit * 100;
          if (wtdRol) autoPrev('chg_risk_profile', wtdRol.toFixed(4) + '%');
        }
        if (curTotalLimit > 0 && curLayers.length) {
          const wtdRol = curLayers.reduce((s, l) => {
            const lim = parseFloat(l.limit) || 0;
            const ep = parseFloat(l.earnedPremium ?? l.earned_premium) || 0;
            return s + (lim > 0 ? (ep / lim) * lim : 0);
          }, 0) / curTotalLimit * 100;
          if (wtdRol) autoCurr('chg_risk_profile', wtdRol.toFixed(4) + '%');
        }

        return next;
      });
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [contractId, quoteMode, npDetail, localStructureLayers]);

  // ── Load portfolio treaties for analysis comparison (quote mode only) ──
  useEffect(() => {
    if (!isQuote || !contractId) return;
    let cancelled = false;
    Promise.all([
      api.listContracts({ limit: 200 }).catch(() => []),
      typeof api.getPortfolioExport === 'function'
        ? api.getPortfolioExport().catch(() => null)
        : Promise.resolve(null),
    ]).then(([treaties, portfolioExport]) => {
      if (cancelled) return;
      // Filter to NP treaties (same treaty category), exclude current contract
      const npTreaties = (Array.isArray(treaties) ? treaties : []).filter(t =>
        String(t.contract_id || t.id) !== String(contractId) &&
        (String(t.treaty_category || '').toUpperCase().includes('NON') ||
         String(t.treaty_type_name || '').toUpperCase().includes('XL') ||
         String(t.treaty_type_name || '').toUpperCase().includes('EXCESS'))
      );
      const treatyMap = new Map(npTreaties.map(t => [String(t.contract_id || t.id), t]));
      const npRows = Array.isArray(portfolioExport?.np)
        ? portfolioExport.np.filter(r => String(r.contract_id || '') !== String(contractId))
        : [];
      setPortfolioExportRows(npRows);

      if (npRows.length) {
        const grouped = new Map();
        npRows.forEach((row) => {
          const cid = String(row.contract_id || '');
          if (!cid) return;
          const treaty = treatyMap.get(cid) || {};
          const existing = grouped.get(cid) || {
            id: cid,
            contract_id: cid,
            country_id: treaty.country_id || '',
            countryId: treaty.country_id || '',
            country: row.country || treaty.country_name || '',
            region: row.region || treaty.region || treaty.region_name || '',
            treaty_type_name: row.treaty_type || treaty.treaty_type_name || '',
            layers: [],
          };
          existing.layers.push({
            layer_number: row.layer_number,
            attachment: row.attachment,
            layer_limit: row.limit_layer,
            limit: row.limit_layer,
            egnpi: row.egnpi_100,
            earnedPremium: row.premium_100,
            rol: row.rol_pct,
            rate: row.rate_pct,
          });
          grouped.set(cid, existing);
        });
        setPortfolioTreaties([...grouped.values()]);
      } else {
        setPortfolioTreaties(npTreaties);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [contractId, isQuote]);

  const uwPriceSum   = layers.reduce((s, l) => s + (parseFloat(String(l.uwPrice).replace(/%/g,'')) || 0), 0);
  const pureBurnSum  = layers.reduce((s, l) => s + (parseFloat(String(l.riskPureBurn || l.catPureBurn || '').replace(/%/g,'')) || 0), 0);
  // techRatioAvg: EP-weighted average = SUMPRODUCT(ep_i × techRatio_i) / SUM(ep_i)
  const techRatioAvg = useMemo(() => {
    let num = 0, denom = 0;
    layers.forEach(l => {
      const tr  = parseFloat(String(l.technicalRatio || '').replace(/%/g, '')) || 0;
      const ep  = toN(l.earnedPremium) || (toN(l.reinsurerPricing) > 0 && toN(l.limit) > 0
                    ? toN(l.limit) * toN(l.reinsurerPricing) / 100 : 0);
      if (tr > 0 && ep > 0) { num += ep * tr; denom += ep; }
    });
    return denom > 0 ? num / denom : 0;
  }, [layers]);

  // ── Auto-populate Pricing table columns ──────────────────────────────────
  // Runs whenever layers load or structureLayers sync from Structure screen.
  //
  // REINSURER = UW Price (or Total ROL) per layer.
  //   • Pure CAT XL  → skip risk-only layers
  //   • Pure Risk XL → skip cat-only layers
  //   • All others   → use each layer as-is
  //
  // LEAD = ROL from NP Structure screen (AppContext npStructureLayers, set on structure save/load)
  //
  // EXPIRING = prototype interpolation logic:
  //   Build expKnown = sorted list of [layerIndex, rolPct] from expiring layers that have a ROL.
  //   For each current layer i:
  //     a. Direct index match → use that ROL
  //     b. i < first known index  → clamp to first value
  //     c. i > last  known index  → clamp to last  value
  //     d. Otherwise              → linear interpolation between surrounding points

  // Stable content hash for the structure-layer ROL lookups consumed by
  // the effect below. Without this, the deps array ended at
  // `structureLayers.length` — which never changes when only the ROL
  // values mutate (e.g. user edits NpStructure and bounces back to
  // NpFinalPricing before the relational fetch refills
  // `localStructureLayers`). The result was stale LEAD prices on the
  // pricing screen until a full reload.
  const structLayersHash = useMemo(() => {
    const src = (localStructureLayers && localStructureLayers.length) ? localStructureLayers : structureLayers;
    if (!Array.isArray(src)) return '';
    return src.map(s => `${s?.layer ?? ''}:${s?.rol ?? ''}`).join('|');
  }, [localStructureLayers, structureLayers]);

  const autoColumnInputsRef = React.useRef({
    layers,
    localStructureLayers,
    structureLayers,
    brokeragePct: npDetail.brokeragePct,
    taxesPct: npDetail.taxesPct,
  });
  useEffect(() => {
    autoColumnInputsRef.current = {
      layers,
      localStructureLayers,
      structureLayers,
      brokeragePct: npDetail.brokeragePct,
      taxesPct: npDetail.taxesPct,
    };
  }, [layers, localStructureLayers, structureLayers, npDetail.brokeragePct, npDetail.taxesPct]);
  const layerCount = layers.length;

  useEffect(() => {
    const {
      layers: currentLayers,
      localStructureLayers: localLayers,
      structureLayers: contextStructureLayers,
      brokeragePct,
      taxesPct,
    } = autoColumnInputsRef.current;
    if (!layerCount || !currentLayers.length) return;

    const num = v => { const x = parseFloat(String(v ?? '').replace(/[^0-9.-]/g, '')); return Number.isFinite(x) ? x : 0; };
    const fmtPct = v => { const x = Number(v); return Number.isFinite(x) && x > 0 ? x.toFixed(2) + '%' : ''; };
    // Layer index: strip non-numeric prefix (e.g. "L1"→1, "Layer 2"→2, 3→3)
    const layerIdx = v => { const x = parseInt(String(v ?? '').replace(/[^0-9]/g, ''), 10); return Number.isFinite(x) ? x : NaN; };

    // Shared: structure layers for ROL lookups (used by LEAD column below).
    const srcStructLayers = localLayers.length ? localLayers : contextStructureLayers;
    const structRolFor = (l, i) => {
      const lIdx = layerIdx(l.layer) || (i + 1);
      const sl = srcStructLayers.find(s => (layerIdx(s.layer) || 0) === lIdx) || srcStructLayers[i];
      return sl ? num(sl.rol) : 0;
    };

    // ── REINSURER per layer ──
    // Source the price from the component that matches the treaty type:
    // CAT XL → cat UW only, RISK XL → risk UW only, anything else → sum.
    const reinsurerByLayer = currentLayers.map(l => {
      if (mode === 'CAT'  && l.risk && !l.cat) return '';
      if (mode === 'RISK' && l.cat  && !l.risk) return '';
      const riskUw = num(l.riskUwPrice) || num(l.riskTotalPrice);
      const catUw  = num(l.catUwPrice)  || num(l.catTotalPrice);
      const uw =
        mode === 'CAT'  ? catUw  :
        mode === 'RISK' ? riskUw :
                          riskUw + catUw;
      return uw > 0 ? fmtPct(uw) : '';
    });


    // ── LEAD per layer — ROL directly from the Structure screen's ROL column.
    const leadByLayer = currentLayers.map((l, i) => {
      const rol = structRolFor(l, i);
      return rol > 0 ? fmtPct(rol) : '';
    });

    // Helper invoked inside setLayers(prev => ...) to resolve a layer's expiring ROL
    // against server-provided expKnown points (sorted [[idx, rolPct], ...]).
    const computeExpiringFor = (l, i, expKnown) => {
      if (!expKnown.length) return '';
      const curIdx = layerIdx(l.layer) || (i + 1);
      const direct = expKnown.find(([idx]) => idx === curIdx);
      if (direct) return fmtPct(direct[1]);
      if (curIdx <= expKnown[0][0]) return fmtPct(expKnown[0][1]);
      if (curIdx >= expKnown[expKnown.length - 1][0]) return fmtPct(expKnown[expKnown.length - 1][1]);
      for (let j = 0; j < expKnown.length - 1; j++) {
        const [i1, v1] = expKnown[j];
        const [i2, v2] = expKnown[j + 1];
        if (curIdx >= i1 && curIdx <= i2) {
          const t = (curIdx - i1) / (i2 - i1);
          return fmtPct(v1 + (v2 - v1) * t);
        }
      }
      return '';
    };

    // Inner function that applies all three columns + recalculates margins.
    // `expKnown` comes from the server; we derive per-layer ROL inside the
    // functional updater so a layer add/remove during the async gap doesn't
    // mis-align array positions.
    const applyColumns = (snap, expKnown) => {
      setLayers(prev => prev.map((l, i) => {
        // If the layer count changed during the async gap (user added/removed a
        // layer), snap.reinsurer/lead are indexed to the old list — skip them
        // to avoid writing one layer's ROL onto another.
        const snapAligned = snap.reinsurer.length === prev.length;
        const reins = (snapAligned && snap.reinsurer[i] !== undefined ? snap.reinsurer[i] : '') || '';
        const lead  = (snapAligned && snap.lead[i]      !== undefined ? snap.lead[i]      : '') || '';
        const exp   = expKnown ? computeExpiringFor(l, i, expKnown) : '';

        const next = { ...l };
        // Always write — these are computed display columns, not user-entry fields
        if (reins) next.reinsurerPricing = reins;
        if (lead)  next.leadPricing = lead;
        if (exp)   next.expiringPricing  = exp;

        // Recalc margin columns (historicalMargin computed by loss-based async effect)
        const rp  = num(next.reinsurerPricing);
        const ep  = num(next.expiringPricing);
        if (rp && ep) next.reinsurerMargin = fmtPct(((ep - rp) / ep) * 100);
        // Technical Ratio — single source of truth in pricingHelpers
        const techRatio = calcTechRatio(
          num(next.historicalMargin),
          num(brokeragePct),
          num(taxesPct),
        );
        if (techRatio !== 0) next.technicalRatio = fmtPct(techRatio);
        return next;
      }));
    };

    // Capture computed arrays before async gap
    const snap = { reinsurer: reinsurerByLayer, lead: leadByLayer };

    if (!contractId) { applyColumns(snap, null); return; }

    const qm = quoteMode ? { quote: true } : undefined;
    api.getNpExpiring(contractId, qm).then(exp => {
      const expLayers = exp?.layers || [];
      // Build expKnown sorted by layer index: [[idx, rolPct], ...]
      const expKnown = [];
      expLayers.forEach((el, i) => {
        const idx = layerIdx(el.layer_number ?? el.layer) || (i + 1);
        const rol = num(el.rol ?? el.rate);
        if (rol > 0) expKnown.push([idx, rol]);
      });
      expKnown.sort((a, b) => a[0] - b[0]);
      applyColumns(snap, expKnown);
    }).catch(e => {
      console.warn('[NpFinalPricing] getNpExpiring failed', e);
      applyColumns(snap, null);
    });
  }, [layerCount, uwPriceSum, pureBurnSum, structLayersHash, mode, contractId, quoteMode]);

  const updateLayer = useCallback((idx, field, value) => {
    // Defence in depth: refuse to mutate layer state once the offer is in
    // a terminal status (SIGNED / NTU / DECLINED). The NpLayerTable
    // already disables its inputs via the `disabled` prop, but a stale
    // browser tab + devtools or a programmatic call could still hit this
    // path. The backend would reject the eventual save anyway, but we
    // shouldn't put the local state in a divergent shape.
    if (['SIGNED', 'NTU', 'DECLINED'].includes(offerStatus)) return;
    // All currently-editable layer fields are percentages or numeric weights.
    // Strip characters that can't appear in a valid percentage so users can't
    // enter letters or negative values — which previously silently flowed into
    // pricing calculations as 0 (letters) or wrong-sign results (negatives).
    const sanitized = typeof value === 'string'
      ? value.replace(/[^0-9.%]/g, '')
      : value;
    setLayers(prev => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: sanitized };

      // ── Auto-calc exposure weight as complement of (burn + pareto) ──
      // User edits Wt Burn % and Wt Pareto %; Wt Exp % auto-fills to keep
      // the three weights summing to 100 (clamped at 0 if burn+pareto ≥ 100).
      const balanceWeights = (prefix) => {
        const b = Math.min(100, Math.max(0, parseFloat(next[idx][`${prefix}WeightBurn`]) || 0));
        const p = Math.min(100, Math.max(0, parseFloat(next[idx][`${prefix}WeightPareto`]) || 0));
        next[idx][`${prefix}WeightExposure`] = String(Math.max(0, Math.round(100 - b - p)));
      };
      if (field === 'riskWeightBurn' || field === 'riskWeightPareto') balanceWeights('risk');
      if (field === 'catWeightBurn'  || field === 'catWeightPareto')  balanceWeights('cat');

      const l = next[idx];

      // ── Recalc risk component ──
      if (l.risk) {
        const prevRiskTotal = l.riskTotalPrice; // before this update
        const riskTotal = deriveComponentTotal(
          l.riskPureBurn, l.riskPareto, l.riskExposure,
          l.riskWeightBurn, l.riskWeightPareto, l.riskWeightExposure, l.riskLoading,
        );
        next[idx].riskAvgBurnPareto = pct((toN(l.riskPureBurn) + toN(l.riskPareto)) || 0);
        next[idx].riskTotalPrice    = pct(riskTotal || 0);
        if (field !== 'riskUwPrice') {
          // Sync UW price to total unless user has manually overridden it
          const uwMatchedPrev = !l.riskUwPrice || l.riskUwPrice === '0.00%' || l.riskUwPrice === prevRiskTotal;
          if (uwMatchedPrev) next[idx].riskUwPrice = pct(riskTotal || 0);
        }
      }

      // ── Recalc cat component ──
      if (l.cat) {
        const prevCatTotal = l.catTotalPrice;
        const catTotal = deriveComponentTotal(
          l.catPureBurn, l.catPareto, l.catExposure,
          l.catWeightBurn, l.catWeightPareto, l.catWeightExposure, l.catLoading,
        );
        next[idx].catAvgBurnPareto = pct((toN(l.catPureBurn) + toN(l.catPareto)) || 0);
        next[idx].catTotalPrice    = pct(catTotal || 0);
        if (field !== 'catUwPrice') {
          const uwMatchedPrev = !l.catUwPrice || l.catUwPrice === '0.00%' || l.catUwPrice === prevCatTotal;
          if (uwMatchedPrev) next[idx].catUwPrice = pct(catTotal || 0);
        }
      }

      // ── Combined uwPrice = sum of active component UW prices ──
      const combined = deriveCombinedUwPrice(next[idx]);
      next[idx].totalPrice = pct(combined || 0);
      if (field !== 'uwPrice') {
        next[idx].uwPrice = next[idx].uwPrice || pct(combined || 0);
      }

      // ── Margins / ratios ──
      const rp = toN(l.reinsurerPricing);
      const ep = toN(l.expiringPricing);
      if (rp && ep) next[idx].reinsurerMargin = pct(((ep - rp) / ep) * 100);
      const techRatio = calcTechRatio(
        toN(l.historicalMargin),
        toN(npDetail.brokeragePct),
        toN(npDetail.taxesPct),
      );
      if (techRatio !== 0) next[idx].technicalRatio = pct(techRatio);

      return next;
    });
  }, [npDetail, offerStatus]);

  const updateLeadSetup = useCallback((idx, field, value) => {
    setLeadSetup(prev => { const next = [...prev]; next[idx] = { ...next[idx], [field]: value }; return next; });
  }, []);

  // ── Historical Margin: losses-into-structure with sequential per-loss reinstatements ──────────
  // Dep key: structure terms + pricing (so effect reruns when UW price is entered).
  // Runs immediately on load using leadPricing as fallback if reinsurer not yet set.
  const histMarginDepKey = layers.map(l =>
    `${l.limit}|${l.deductible}|${l.noReinst}|${l.reinstPct}|${l.reinsurerPricing}|${l.leadPricing}`
  ).join(',');
  useEffect(() => {
    if (!contractId || !layers.length) return;
    const cancelled = false;
    const qm = quoteMode ? { quote: true } : undefined;
    Promise.all([
      api.getLargeLosses(contractId, qm).catch(() => ({ losses: [] })),
      api.getCatLosses(contractId, qm).catch(() => ({ losses: [] })),
    ]).then(([rawLarge, rawCat]) => {
      if (cancelled) return;
      // API returns { report, losses: [...] } — unwrap
      const extractRows = r => Array.isArray(r) ? r : (r?.losses ?? []);
      const norm = r => ({
        uwYear:   String(r.uw_year ?? r.uwYear ?? ''),
        incurred: (parseFloat(r.incurred ?? 0) || 0) * (parseFloat(r.inflation_factor ?? 1) || 1),
        selected: (r.is_selected ?? r.isSelected) !== false,
      });
      const largeLosses = extractRows(rawLarge).map(norm).filter(r => r.selected && r.uwYear && r.incurred > 0);
      const catLosses   = extractRows(rawCat).map(norm).filter(r => r.selected && r.uwYear && r.incurred > 0);

      const buildByYear = (losses) => {
        const byYear = new Map();
        for (const r of losses) {
          if (!byYear.has(r.uwYear)) byYear.set(r.uwYear, []);
          byYear.get(r.uwYear).push(r.incurred);
        }
        return byYear;
      };

      const largeByYear = buildByYear(largeLosses);
      const catByYear   = buildByYear(catLosses);
      const bothByYear  = buildByYear([...largeLosses, ...catLosses]);

      if (!largeByYear.size && !catByYear.size) return;

      setLayers(prev => prev.map(l => {
        const lim = toN(l.limit);
        const ded = toN(l.deductible);
        if (!lim) return l;

        // basePrem: use reinsurer pricing if set, fall back to lead pricing
        const pricingPct = toN(l.reinsurerPricing) || toN(l.leadPricing);
        if (!pricingPct) return l;

        // Choose correct loss pool for this layer's peril cover
        const byYear = (l.risk && l.cat) ? bothByYear : l.cat ? catByYear : largeByYear;
        const years  = [...byYear.keys()];
        if (!years.length) return l;

        const basePrem     = (pricingPct / 100) * lim;
        const noReinst     = parseInt(String(l.noReinst ?? l.reinstatements ?? '').replace(/[^0-9]/g, ''), 10) || 0;
        const reinstPctRaw = parseFloat(String(l.reinstPct ?? l.reinstatementPct ?? '').replace(/%/g, '')) || 0;
        const reinstPct01  = reinstPctRaw / 100;

        // Maximum total capacity this layer can absorb in one year:
        //   original cover (1 × limit) + noReinst reinstatements
        const maxCapacity = lim * (1 + noReinst);

        let totalLoss = 0, totalIncome = 0;
        for (const incurreds of byYear.values()) {
          // Process losses sequentially within the year.
          // Track remaining capacity: starts at maxCapacity, decrements as losses hit the layer.
          // Each unit of capacity used above the first 'lim' triggers a reinstatement premium.
          let remainingCapacity = maxCapacity;
          let annualLayerLoss   = 0;
          let reinstPrem        = 0;

          for (const inc of incurreds) {
            if (remainingCapacity <= 0) break; // layer fully exhausted for the year
            const lossHit = Math.max(0, Math.min(inc - ded, remainingCapacity));
            if (lossHit <= 0) continue;

            annualLayerLoss   += lossHit;
            remainingCapacity -= lossHit;

            // Reinstatement premium: charged for each unit of reinstatement capacity used.
            // Reinstatement capacity starts after the first 'lim' is consumed.
            // Units used beyond first lim = how much of reinstatement cover this loss consumed.
            const usedBeforeThisLoss = maxCapacity - (remainingCapacity + lossHit);
            const firstLimRemaining  = Math.max(0, lim - usedBeforeThisLoss);
            // portion of this loss that consumed reinstatement capacity (beyond first lim)
            const reinstUsed = Math.max(0, lossHit - firstLimRemaining);
            if (noReinst > 0 && reinstPct01 > 0 && reinstUsed > 0) {
              reinstPrem += (reinstUsed / lim) * reinstPct01 * basePrem;
            }
          }

          totalLoss   += annualLayerLoss;
          totalIncome += basePrem + reinstPrem;
        }

        const avgLoss   = totalLoss   / years.length;
        const avgIncome = totalIncome / years.length;
        if (!avgIncome) return l;

        const brok  = toN(npDetail.brokeragePct);
        const taxes = toN(npDetail.taxesPct);
        const lossRatio = (avgLoss / avgIncome) * 100;
        const histMarginPct = 100 - lossRatio - brok - taxes;
        return { ...l, historicalMargin: Number.isFinite(histMarginPct) ? pct(histMarginPct) : l.historicalMargin };
      }));
    }).catch(() => {});
  }, [contractId, quoteMode, histMarginDepKey, layers.length, npDetail.brokeragePct, npDetail.taxesPct]);

  // ── Tech Ratio: recompute whenever historicalMargin changes ──────────
  // historicalMargin is set asynchronously by the effect above, so we need
  // a separate effect to propagate it into technicalRatio.
  const histMarginValKey = layers.map(l => l.historicalMargin || '').join(',');
  useEffect(() => {
    if (!layers.length) return;
    setLayers(prev => prev.map(l => {
      const histM = toN(l.historicalMargin);
      if (!histM) return l;
      const techRatio = calcTechRatio(histM, toN(npDetail.brokeragePct), toN(npDetail.taxesPct));
      return { ...l, technicalRatio: pct(techRatio) };
    }));
  }, [histMarginValKey, layers.length, npDetail.brokeragePct, npDetail.taxesPct]);

  // ── Actuarial Engine: run all three methods for all layers ────────
  const runCalcEngine = useCallback(async () => {
    if (!contractId || !layers.length) return;
    setCalcEngineRunning(true);
    setCalcEngineError('');
    try {
      const results = await calcLayerPricing(api, contractId, layers, npDetail, mode, quoteMode);
      setLayers(prev => {
        const next = prev.map((l, i) => {
          const r = results.find(res => res.idx === i);
          if (!r) return l;

          const merged = { ...l };

          // ── Apply RISK component results ──
          if (r.risk) {
            merged.riskPureBurn = r.risk.pureBurn      || l.riskPureBurn;
            merged.riskPareto   = r.risk.pareto        || l.riskPareto;
            merged.riskExposure = r.risk.exposureRating|| l.riskExposure;
            merged.riskPrAttach  = r.risk.prAttach     || l.riskPrAttach;
            merged.riskPrExhaust = r.risk.prExhaust    || l.riskPrExhaust;
            const riskBP = toN(merged.riskPureBurn) + toN(merged.riskPareto);
            merged.riskAvgBurnPareto = pct(riskBP || 0);
            const riskTotal = deriveComponentTotal(
              merged.riskPureBurn, merged.riskPareto, merged.riskExposure,
              merged.riskWeightBurn || '50', merged.riskWeightPareto || '0',
              merged.riskWeightExposure || '50', merged.riskLoading || '15',
            );
            merged.riskTotalPrice = pct(riskTotal || 0);
            // Seed UW price = total ROL unless user has manually diverged them
            const riskUwWasDefault = !merged.riskUwPrice || merged.riskUwPrice === '0.00%' || merged.riskUwPrice === l.riskTotalPrice;
            if (riskUwWasDefault) merged.riskUwPrice = merged.riskTotalPrice;
          }

          // ── Apply CAT component results ──
          if (r.cat) {
            merged.catPureBurn = r.cat.pureBurn      || l.catPureBurn;
            merged.catPareto   = r.cat.pareto        || l.catPareto;
            merged.catExposure = r.cat.exposureRating|| l.catExposure;
            merged.catPrAttach  = r.cat.prAttach     || l.catPrAttach;
            merged.catPrExhaust = r.cat.prExhaust    || l.catPrExhaust;
            const catBP = toN(merged.catPureBurn) + toN(merged.catPareto);
            merged.catAvgBurnPareto = pct(catBP || 0);
            const catTotal = deriveComponentTotal(
              merged.catPureBurn, merged.catPareto, merged.catExposure,
              merged.catWeightBurn || '50', merged.catWeightPareto || '0',
              merged.catWeightExposure || '50', merged.catLoading || '15',
            );
            merged.catTotalPrice = pct(catTotal || 0);
            const catUwWasDefault = !merged.catUwPrice || merged.catUwPrice === '0.00%' || merged.catUwPrice === l.catTotalPrice;
            if (catUwWasDefault) merged.catUwPrice = merged.catTotalPrice;
          }

          // ── Combined uwPrice ──
          const combined = deriveCombinedUwPrice(merged);
          merged.totalPrice = pct(combined || 0);
          if (!merged.uwPrice) merged.uwPrice = merged.totalPrice;

          return merged;
        });
        return next;
      });
    } catch (e) {
      console.error('[NP Calc Engine]', e);
      setCalcEngineError('Calculation failed: ' + (e.message || 'unknown error'));
    } finally {
      setCalcEngineRunning(false);
    }
  }, [contractId, layers, npDetail, mode, quoteMode]);

  // Save — dual: relational pricing tables + JSONB terms for full UI state
  // Returns true on success, false on failure. Updates saveState so the UI
  // can show "Saved HH:MM:SS" or a failure banner instead of silently losing data.
  const save = useCallback(async (options = {}) => {
    if (!contractId) return true;
    const lockOverride = options?.ifUnmodifiedSince;
    let activeLock = lockOverride || lastUpdatedAt;
    const requestOptions = () => (
      quoteMode
        ? { quote: true, ...(activeLock ? { ifUnmodifiedSince: activeLock } : {}) }
        : (activeLock ? { ifUnmodifiedSince: activeLock } : undefined)
    );
    const noteSaved = (response) => {
      if (!response?.updated_at) return;
      activeLock = response.updated_at;
      setLastUpdatedAt(response.updated_at);
    };
    setSaveState(s => ({ ...s, status: 'saving', error: null }));
    try {
      // 1. Relational pricing (inputs + per-layer outputs)
      const firstLayer = layers[0] || {};
      const inputs = {
        burn_weight_pct:     firstLayer.riskWeightBurn  || firstLayer.catWeightBurn  || 50,
        exposure_weight_pct: firstLayer.riskWeightExposure || firstLayer.catWeightExposure || 50,
        pareto_weight_pct:   firstLayer.riskWeightPareto || firstLayer.catWeightPareto || 0,
        pricing_loading_pct: firstLayer.riskLoading     || firstLayer.catLoading     || 15,
      };
      const layer_inputs = layers.map((l, i) => ({
        layer_number: i + 1,
        expiring_pricing_pct: l.expiringPricing || null,
      }));
      const outputs = [];
      layers.forEach((l, i) => {
        // contract_np_pricing_outputs.section has a DB CHECK of
        // ('RISK', 'CAT') — one row per peril component. No summary
        // 'BOTH' row: the combined total is derivable from the two
        // component rows (sum of total_price per layer_number) and
        // used to force every PUT for a BOTH-covered layer to 400
        // (Zod) / 23514 (DB).
        //
        // uw_price is deliberately NOT in the outputs payload — the
        // contract_np_pricing_outputs table has no uw_price column,
        // so the server silently dropped the field. The real uw_price
        // persistence goes through `layer_margins` (below), which
        // updates contract_np_layers.uw_price.
        if (l.risk) {
          outputs.push({
            layer_number: i + 1, section: 'RISK',
            pure_burning_cost: l.riskPureBurn, pareto_pricing: l.riskPareto,
            burn_plus_pareto: l.riskAvgBurnPareto, exposure_rating: l.riskExposure,
            burn_weight_pct: l.riskWeightBurn, exposure_weight_pct: l.riskWeightExposure,
            pareto_weight_pct: l.riskWeightPareto,
            pricing_loading_pct: l.riskLoading, total_price: l.riskTotalPrice,
            prob_attach: l.riskPrAttach, prob_exhaust: l.riskPrExhaust,
          });
        }
        if (l.cat) {
          outputs.push({
            layer_number: i + 1, section: 'CAT',
            pure_burning_cost: l.catPureBurn, pareto_pricing: l.catPareto,
            burn_plus_pareto: l.catAvgBurnPareto, exposure_rating: l.catExposure,
            burn_weight_pct: l.catWeightBurn, exposure_weight_pct: l.catWeightExposure,
            pareto_weight_pct: l.catWeightPareto,
            pricing_loading_pct: l.catLoading, total_price: l.catTotalPrice,
            prob_attach: l.catPrAttach, prob_exhaust: l.catPrExhaust,
          });
        }
      });

      // layer_margins: persist per-layer margin columns to contract_np_layers
      // Mapping to NP Final Pricing screen columns:
      //   hist_margin     ← historicalMargin (HIST. MARGIN) → actual_margin in cedant summary
      //   modelled_margin ← reinsurerMargin  (MARGIN)       → actuarial_margin in cedant summary
      //   tech_ratio      ← technicalRatio   (TECH RATIO)
      //   uw_price        ← reinsurerPricing (REINSURER ROL)
      //   expiring_price  ← expiringPricing  (EXPIRING ROL)
      //   lead_price      ← leadPricing      (LEAD ROL)
      const pctToNum = v => {
        const x = parseFloat(String(v ?? '').replace(/%/g, '').trim());
        return Number.isFinite(x) ? x : null;
      };
      const layer_margins = layers.map((l, i) => ({
        layer_number:    i + 1,
        hist_margin:     pctToNum(l.historicalMargin),
        modelled_margin: pctToNum(l.reinsurerMargin),
        tech_ratio:      pctToNum(l.technicalRatio),
        uw_price:        pctToNum(l.reinsurerPricing) || pctToNum(l.uwPrice),
        expiring_price:  pctToNum(l.expiringPricing),
        lead_price:      pctToNum(l.leadPricing),
      })).filter(m => m.hist_margin != null || m.modelled_margin != null || m.uw_price != null);

      noteSaved(await api.saveNpPricing(contractId, { inputs, layer_inputs, outputs, layer_margins }, requestOptions()));

      // 2. JSONB terms for full UI state (lead setup, all layer fields)
      // NOTE: offerStatus and offerApprover are NOT saved to JSONB — they come from the DB
      // (contract_offer.status / next_approver) to prevent stale status leaking across cycles.

      // Collect live structure data from QuoteStructureSection refs before saving
      let liveQuoteStructures = quoteStructures;
      if (isQuote && structRefsMap.current) {
        const live = [];
        Object.keys(structRefsMap.current).sort().forEach(idx => {
          const ref = structRefsMap.current[idx];
          if (ref?.current) {
            try { live.push(ref.current()); } catch {}
          }
        });
        if (live.length > 0) liveQuoteStructures = live;
      }
      const normalizedClientStructures = isQuote
        ? normalizeQuoteStructures(clientStructures, { curve: quoteCurve })
        : clientStructures;

      // 2a. Quote-mode scaffolding — relational where the schema has
      //     columns (expiring layers), JSONB for everything else.
      //     Field mapping mirrors NpExpiringStructure.localLayerToServer
      //     so the same quote_np_expiring_layers row shape works.
      if (isQuote) {
        const peril = (l) => (l.risk && l.cat ? 'BOTH' : l.risk ? 'RISK' : l.cat ? 'CAT' : 'BOTH');
        const expPayload = {
          layers: expLayers.map((l, i) => ({
            layer_number:          i + 1,
            attachment:            toN(l.attachment),
            layer_limit:           toN(l.limit),
            aggregate_limit:       0,
            egnpi:                 toN(l.egnpi),
            earned_premium:        expLayerEarnedPremium(l),
            rate:                  toN(l.rate),
            rol:                   toN(l.rol),
            num_reinstatements:    toN(l.reinstatements),
            reinstatement_pct:     toN(l.pctReinst),
            annual_agg_deductible: null,
            peril_scope:           peril(l),
            mdp:                   toN(l.mdp),
            mdp_pct:               0,
          })),
          terms: { brokerage_pct: toN(npDetail.brokeragePct), no_claims_bonus_pct: 0, profit_commission_pct: 0 },
          // Covered props are owned by NpStructure; NpFinalPricing has no UI for them and must not overwrite.
        };
        noteSaved(await api.saveNpExpiring(contractId, expPayload, requestOptions()));
        // COB selection — keep the relational class_of_business
        // junction in sync with selectedCobs so other screens see it.
        try {
          await api.saveContractCobs(contractId, { class_ids: selectedCobs.map((c) => c.id) }, requestOptions());
        } catch (cobErr) {
          // Non-fatal: COB junction sync is best-effort here; the
          // canonical store is npTreatyDetail.classIds set on the
          // Treaty Detail step. Log but don't block the save.
          console.warn('[NP Final Pricing save] cob sync failed', cobErr);
        }
      }

      // Probability fields for expiring layers — kept in JSONB until
      // the relational table grows columns for them.
      const expProbabilities = isQuote
        ? expLayers.map((l) => ({ pAttach: l.pAttach || '', pExhaust: l.pExhaust || '' }))
        : undefined;

      noteSaved(await api.saveNonPropTreaty(contractId, {
        terms: {
          np_final_pricing: {
            layers: layers.map(l => ({ ...l })),
            treatyMetrics,
            leadSetup,
            offerComment,          // comment is UI-only, ok to cache
            layerWrittenLines,
            signedLinePcts,
            approvedStructures: isQuote ? approvedStructures : undefined,
            quotePricing: isQuote ? quotePricing : undefined,
            quoteStructures: isQuote ? (normalizedClientStructures.length ? normalizedClientStructures : liveQuoteStructures) : undefined,
            // Final Quote scaffolding — single JSONB key so loads
            // can treat it as one object and we don't pollute the
            // top-level np_final_pricing namespace.
            fqScaffolding: isQuote ? {
              clientStructures: normalizedClientStructures,
              approvedStructures,
              quoteCobUwLimits,
              cobToggles,
              cobManual,
              expProbabilities,
            } : undefined,
          },
        },
      }, requestOptions()));
      setSaveState({ status: 'saved', at: Date.now(), error: null });
      return true;
    } catch (e) {
      console.error('[NP Final Pricing save]', e);
      if (lockOverride !== '*') {
        const stale = await handleStaleWrite(e, {
          entityType: isQuote ? 'quote pricing' : 'pricing',
          onRefresh: () => window.location.reload(),
          onOverwrite: () => save({ ifUnmodifiedSince: '*' }),
        });
        if (stale.handled) return stale.action === 'overwrite' ? !!stale.result : false;
      }
      setSaveState({ status: 'error', at: Date.now(), error: formatPricingDriftMessage(e) || e?.message || 'Save failed' });
      return false;
    }
  }, [contractId, quoteMode, lastUpdatedAt, layers, quoteStructures, isQuote, structRefsMap, expLayers, treatyMetrics, leadSetup, offerComment, layerWrittenLines, signedLinePcts, approvedStructures, quotePricing, clientStructures, quoteCurve, quoteCobUwLimits, cobToggles, cobManual, npDetail.brokeragePct, selectedCobs]);

  // ── Workflow ──────────────────────────────────────────────────────────────
  const isTerminal = ['SIGNED', 'NTU', 'DECLINED'].includes(offerStatus);

  const doSubmitForApproval = useCallback(async () => {
    if (!offerApprover) { showToast('Please select who to send the offer to.'); return; }
    const approvedStructureIndices = approvedStructures
      .map((selected, index) => (selected ? index : null))
      .filter((index) => index != null);
    if (isQuote && approvedStructureIndices.length === 0) {
      showToast('Select at least one structure for Chief Underwriter approval.');
      return;
    }
    // Compute aggregate written_line_pct = average of non-zero lead share entries
    const shareVals = Object.entries(layerWrittenLines)
      .filter(([k]) => k.includes('_'))   // sIdx_li format = quote mode
      .map(([, v]) => parseFloat(String(v).replace(/%/g, '')) || 0)
      .filter(v => v > 0);
    const aggWrittenPct = shareVals.length ? (shareVals.reduce((a, b) => a + b, 0) / shareVals.length) : null;
    const hasAnyLine = layers.some((_, i) => parseFloat(String(layerWrittenLines[i] || '').replace(/%/g, '').trim()) > 0);
    if (!isQuote && !hasAnyLine) { showToast('Please enter a written line % for at least one layer before submitting.'); return; }
    const ok = await save();
    if (!ok) { showToast('Cannot submit: the latest pricing failed to save. Retry save first.'); return; }
    try {
      await api.submitOfferForApproval(contractId, {
        line_pct: JSON.stringify(layerWrittenLines), peer1_user_id: offerApprover, comment: offerComment, _actor: actorName,
        written_line_pct: aggWrittenPct,
        selected_structure_index: isQuote ? approvedStructureIndices[0] : undefined,
        selected_structure_id: isQuote ? clientStructures[approvedStructureIndices[0]]?.id : undefined,
        selected_structure_indices: isQuote ? approvedStructureIndices : undefined,
        selected_structure_ids: isQuote ? approvedStructureIndices.map((index) => clientStructures[index]?.id).filter(Boolean) : undefined,
        approved_structures: isQuote ? JSON.stringify(approvedStructures) : undefined,
      }, quoteMode ? { quote: true } : undefined);
      setOfferStatus('AWAITING_APPROVAL');
      api.getApprovalTrail(contractId, quoteMode ? { quote: true } : undefined).then(setApprovalTrail).catch(() => {});
    } catch(e) { showToast('Submission failed: ' + (e?.message || 'Server error')); }
  }, [offerApprover, approvedStructures, isQuote, layerWrittenLines, layers, save, showToast, contractId, offerComment, actorName, clientStructures, quoteMode]);

  const doMarkApproved = useCallback(async () => {
    const ok = await save();
    if (!ok) { showToast('Cannot approve: the latest pricing failed to save. Retry save first.'); return; }
    try {
      await api.markOfferApproved(contractId, { _actor: actorName, comment: returnReason || offerComment, line_pct: JSON.stringify(layerWrittenLines) }, quoteMode ? { quote: true } : undefined);
      setOfferStatus('AWAITING_SIGNED_LINE');
      api.getApprovalTrail(contractId, quoteMode ? { quote: true } : undefined).then(setApprovalTrail).catch(() => {});
    } catch(e) { showToast('Approval failed: ' + (e?.message || 'Server error')); }
  }, [save, showToast, contractId, actorName, returnReason, offerComment, layerWrittenLines, quoteMode]);

  const doMarkSigned = useCallback(async () => {
    try {
      // Hard guard: don't let a caller mark SIGNED when every
      // signed_line_pct is 0/missing. The inline click-site already
      // checks this but we re-check here so any future code path
      // that invokes doMarkSigned can't bypass the validation.
      const hasAnySignedCheck = Object.values(signedLinePcts || {}).some(v => {
        const n = parseFloat(String(v || '').replace(/%/g, '').trim());
        return Number.isFinite(n) && n > 0;
      });
      if (!hasAnySignedCheck) {
        showToast('Cannot mark signed: enter at least one non-zero signed line %.');
        return;
      }
      // Save signed line pcts to JSONB first so they persist on reload
      const ok = await save();
      if (!ok) { showToast('Cannot mark signed: the latest pricing failed to save. Retry save first.'); return; }
      await api.markOfferSigned(contractId, {
        signed_line_pct: JSON.stringify(signedLinePcts),
        _actor: actorName,
      }, quoteMode ? { quote: true } : undefined);
      setOfferStatus('SIGNED');
      api.getApprovalTrail(contractId, quoteMode ? { quote: true } : undefined).then(setApprovalTrail).catch(() => {});
    } catch(e) { showToast('Failed to mark signed: ' + (e?.message || 'Server error')); }
  }, [signedLinePcts, save, contractId, actorName, quoteMode, showToast]);

  const doMarkNTU = useCallback(async () => {
    try {
      await api.markOfferNTU(contractId, { reason: returnReason || offerComment || '', _actor: actorName }, quoteMode ? { quote: true } : undefined);
      setOfferStatus('NTU');
      api.getApprovalTrail(contractId, quoteMode ? { quote: true } : undefined).then(setApprovalTrail).catch(() => {});
    } catch(e) { showToast('Failed to mark NTU: ' + (e?.message || 'Server error')); }
  }, [contractId, returnReason, offerComment, actorName, quoteMode, showToast]);

  const doReturnToUW = useCallback(async () => {
    if (!returnReason.trim()) { showToast('Please enter a reason for returning to the underwriter.'); return; }
    try {
      await api.returnToUnderwriter(contractId, { reason: returnReason, _actor: actorName }, quoteMode ? { quote: true } : undefined);
      setReturnReason('');
      setOfferStatus('DRAFT');
      api.getApprovalTrail(contractId, quoteMode ? { quote: true } : undefined).then(setApprovalTrail).catch(() => {});
    } catch(e) { showToast('Failed to return: ' + (e?.message || 'Server error')); }
  }, [returnReason, showToast, contractId, actorName, quoteMode]);

  const doDecline = useCallback(async () => {
    if (!window.confirm('Decline this treaty? This cannot be undone.')) return;
    const reason = returnReason.trim() || offerComment.trim() || 'Declined by Chief Underwriter';
    try {
      await api.declineContract(contractId, reason, { ...(quoteMode ? { quote: true } : {}), body: { reason, _actor: actorName } });
      setOfferStatus('DECLINED');
      api.getApprovalTrail(contractId, quoteMode ? { quote: true } : undefined).then(setApprovalTrail).catch(() => {});
    } catch(e) { showToast('Failed to decline: ' + (e?.message || 'Server error')); }
  }, [returnReason, offerComment, contractId, quoteMode, actorName, showToast]);

  const riskLayers = layers.filter(l => l.risk);
  const catLayers = layers.filter(l => l.cat);
  const quoteInsightButtonStyle = {
    width: 'auto',
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    flex: '0 0 auto',
    padding: '9px 14px',
    borderRadius: 10,
    lineHeight: 1,
  };

  const renderQuoteCobParticipationTable = (scope, tableLayers, options = {}) => {
    const safeLayers = Array.isArray(tableLayers) ? tableLayers : [];
    const colSpan = 2 + safeLayers.length;
    const title = options.title || 'Underwriting Limits & Layer Participation';
    const hint = options.hint || 'Underwriting limits are entered per class. Tick layers that participate for each class.';

    return (
      <section className="bm-card bm-cob-section" style={{ marginBottom: 12 }}>
        <div className="bm-cob-section-header">
          <div className="bm-cob-section-title">{title}</div>
          <div className="bm-cob-section-hint">{hint}</div>
        </div>
        <div className="bm-np-table-wrap">
          <table className="bm-np-table">
            <thead>
              <tr>
                <th className="bm-np-th--cob" style={{ minWidth: 230, width: 253 }}>CLASS OF BUSINESS</th>
                <th className="bm-np-th--limit" style={{ minWidth: 299, width: 322 }}>UNDERWRITING LIMIT</th>
                {safeLayers.map((_, lIdx) => (
                  <th key={lIdx} className="bm-np-th--layer" style={{ minWidth: 115, width: 138 }}>LAYER {lIdx + 1}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {selectedCobs.length > 0 ? selectedCobs.map((cob) => {
                const flags = getCobFlags(scope, cob.id, safeLayers);
                return (
                  <tr key={cob.id} className="bm-np-row">
                    <td className="bm-np-td--cob" style={{ minWidth: 230, width: 253 }}>{cob.name}</td>
                    <td className="bm-np-td--limit" style={{ minWidth: 299, width: 322 }}>
                      <div className="bm-np-limit-cell">
                        <FQNumCell
                          className="bm-np-limit-input"
                          value={getCobUwLimit(scope, cob.id)}
                          onChange={(v) => updateUwLimit(scope, cob.id, v)}
                        />
                        <span className="bm-np-limit-suffix">{currency || ''}</span>
                      </div>
                    </td>
                    {safeLayers.map((_, lIdx) => (
                      <td key={lIdx} className="bm-np-td--check" style={{ minWidth: 115, width: 138 }}>
                        <input
                          type="checkbox"
                          className="np-check"
                          checked={!!flags[lIdx]}
                          onChange={() => setCobToggle(scope, cob.id, lIdx, !!flags[lIdx])}
                        />
                      </td>
                    ))}
                  </tr>
                );
              }) : (
                <tr className="bm-np-row">
                  <td colSpan={colSpan} className="bm-np-td--cob" style={{ textAlign: 'center', padding: 20, color: 'rgba(148,163,184,0.65)' }}>
                    Select classes of business above.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </section>
    );
  };

  const renderPricingAnalysisModal = () => {
    const sIdx = pricingAnalysisModal.structureIndex;
    const structure = Number.isInteger(sIdx) ? clientStructures[sIdx] : null;
    if (!pricingAnalysisModal.open || !structure) return null;

    const fmtMoney = (value) => {
      const n = toN(value);
      return n > 0 ? `${currency ? `${currency} ` : ''}${formatWithCommas(String(Math.round(n)))}` : '—';
    };
    const componentTotals = (scopeKey) => {
      const activeLayers = (structure.layers || []).filter((layer) => !!layer[scopeKey]);
      const totalLimit = activeLayers.reduce((s, layer) => s + toN(layer.limit), 0);
      const premium = activeLayers.reduce((s, layer) => {
        const limit = toN(layer.limit);
        const rol = quoteComponentDerived(layer, scopeKey).totalRol;
        return s + (limit > 0 && rol > 0 ? limit * rol / 100 : 0);
      }, 0);
      return {
        activeCount: activeLayers.length,
        totalLimit,
        premium,
        wtdRol: totalLimit > 0 ? (premium / totalLimit) * 100 : 0,
      };
    };
    const riskTotal = componentTotals('risk');
    const catTotal = componentTotals('cat');
    const grandLimit = riskTotal.totalLimit + catTotal.totalLimit;
    const grandPremium = riskTotal.premium + catTotal.premium;
    const grandTotal = {
      activeCount: riskTotal.activeCount + catTotal.activeCount,
      totalLimit: grandLimit,
      premium: grandPremium,
      wtdRol: grandLimit > 0 ? (grandPremium / grandLimit) * 100 : 0,
    };

    const th = {
      padding: '8px 10px',
      textAlign: 'right',
      fontSize: 9,
      fontWeight: 850,
      letterSpacing: '.11em',
      color: 'rgba(148,163,184,0.68)',
      textTransform: 'uppercase',
      borderBottom: '1px solid rgba(255,255,255,0.08)',
      whiteSpace: 'nowrap',
    };
    const td = { padding: '7px 8px', textAlign: 'right', verticalAlign: 'middle' };

    const renderScopeSection = (scopeKey) => {
      const scope = QUOTE_COMPONENT_SCOPES[scopeKey];
      const f = scope.fields;
      const disabledByMode = scopeKey === 'risk' ? riskDisabled : catDisabled;
      return (
        <section key={scopeKey} style={{ background: 'rgba(8,14,30,0.72)', border: `1px solid ${scope.color}35`, borderRadius: 12, overflow: 'hidden' }}>
          <div style={{ padding: '12px 14px', borderBottom: '1px solid rgba(255,255,255,0.07)', display: 'flex', justifyContent: 'space-between', gap: 12, alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: 12, fontWeight: 850, letterSpacing: '.12em', textTransform: 'uppercase', color: scope.color }}>
                {scope.label} Pricing Analysis
              </div>
              <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.58)', marginTop: 2 }}>
                Edit component metrics here; the main structure table updates from these totals.
              </div>
            </div>
            <div style={{ fontSize: 11, color: 'rgba(226,232,240,0.75)', fontWeight: 750 }}>
              Wtd ROL {componentTotals(scopeKey).wtdRol > 0 ? `${componentTotals(scopeKey).wtdRol.toFixed(2)}%` : '—'}
            </div>
          </div>
          <div style={{ overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 1180, fontSize: 11 }}>
              <thead style={{ background: '#050810' }}>
                <tr>
                  {['Layer', 'Active', 'Limit', 'Deductible', 'Pure Burn', 'Pareto', 'Exposure', 'Wt Burn %', 'Wt Pareto %', 'Wt Exp %', 'Loading %', 'Total ROL', 'UW Price'].map((h, i) => (
                    <th key={`${scopeKey}-${h}`} style={{ ...th, textAlign: i < 2 ? 'center' : 'right' }}>{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(structure.layers || []).map((layer, lIdx) => {
                  const active = !!layer[scopeKey];
                  const d = quoteComponentDerived(layer, scopeKey);
                  const editorWrap = (node) => (
                    <div style={{ opacity: active ? 1 : 0.36, pointerEvents: active ? 'auto' : 'none' }}>{node}</div>
                  );
                  return (
                    <tr key={`${scopeKey}-${layer.id || lIdx}`} style={{ borderBottom: '1px solid rgba(255,255,255,0.045)', background: lIdx % 2 ? 'rgba(255,255,255,0.012)' : 'transparent' }}>
                      <td style={{ ...td, textAlign: 'center' }}>
                        <span className="bm-badge" style={{ background: `${scope.color}14`, borderColor: `${scope.color}35`, color: scope.color }}>{lIdx + 1}</span>
                      </td>
                      <td style={{ ...td, textAlign: 'center' }}>
                        <input
                          type="checkbox"
                          className="np-check"
                          aria-label={`${scope.label} Pricing Structure ${sIdx + 1} Layer ${lIdx + 1}`}
                          checked={active}
                          disabled={disabledByMode}
                          onChange={(e) => updateClientStructureLayer(sIdx, lIdx, scopeKey, e.target.checked)}
                        />
                      </td>
                      <td style={td}><FQReadCell value={fmtMoney(layer.limit)} className="bm-cell bm-cell--display bm-cell--foot" /></td>
                      <td style={td}><FQReadCell value={fmtMoney(layer.attachment)} className="bm-cell bm-cell--display bm-cell--foot" /></td>
                      <td style={td}>{editorWrap(<FQPctCell value={layer[f.pureBurn]} onChange={(v) => updateClientStructureLayer(sIdx, lIdx, f.pureBurn, v)} />)}</td>
                      <td style={td}>{editorWrap(<FQPctCell value={layer[f.pareto]} onChange={(v) => updateClientStructureLayer(sIdx, lIdx, f.pareto, v)} />)}</td>
                      <td style={td}>{editorWrap(<FQPctCell value={layer[f.exposure]} onChange={(v) => updateClientStructureLayer(sIdx, lIdx, f.exposure, v)} />)}</td>
                      <td style={td}>{editorWrap(<FQPctCell value={layer[f.wtBurn]} onChange={(v) => updateClientStructureLayer(sIdx, lIdx, f.wtBurn, v)} />)}</td>
                      <td style={td}>{editorWrap(<FQPctCell value={layer[f.wtPareto]} onChange={(v) => updateClientStructureLayer(sIdx, lIdx, f.wtPareto, v)} />)}</td>
                      <td style={td}><FQReadCell value={`${d.wtExp.toFixed(0)}%`} className="bm-cell bm-cell--sm bm-cell--display bm-cell--muted bm-calc" /></td>
                      <td style={td}>{editorWrap(<FQPctCell value={layer[f.loading]} onChange={(v) => updateClientStructureLayer(sIdx, lIdx, f.loading, v)} />)}</td>
                      <td style={td}><FQReadCell value={d.totalRol > 0 ? `${d.totalRol.toFixed(2)}%` : '—'} className="bm-cell bm-cell--sm bm-cell--display bm-cell--accent bm-calc" /></td>
                      <td style={td}>{editorWrap(<FQPctCell value={layer[f.uwPrice]} onChange={(v) => updateClientStructureLayer(sIdx, lIdx, f.uwPrice, v)} placeholder={d.totalRol > 0 ? `${d.totalRol.toFixed(2)}%` : '—%'} />)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>
      );
    };

    return (
      <div className="bm-modal-backdrop" onClick={(e) => e.target === e.currentTarget && setPricingAnalysisModal({ open: false, structureIndex: null })}>
        <div
          className="bm-modal"
          style={isQuote
            ? { width: '100vw', height: '100vh', maxWidth: 'none', maxHeight: 'none', borderRadius: 0, display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)' }
            : { width: '96vw', maxWidth: '1500px', maxHeight: '92vh', display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)' }}
        >
          <div className="bm-modal-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
            <div>
              <div>Pricing Analysis · Structure {sIdx + 1}</div>
              <div style={{ fontSize: 11, fontWeight: 500, color: 'rgba(148,163,184,0.55)', marginTop: 2 }}>
                Risk and cat layer pricing are analysed separately, then reconciled into the structure totals.
              </div>
            </div>
            <button className="bm-pill" onClick={() => setPricingAnalysisModal({ open: false, structureIndex: null })}>Close</button>
          </div>
          <div className="bm-modal-body" style={{ minHeight: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 12, padding: '18px 20px' }}>
            {renderScopeSection('risk')}
            {renderScopeSection('cat')}
            <section style={{ background: 'rgba(8,14,30,0.72)', border: '1px solid rgba(35,209,139,0.28)', borderRadius: 12, overflow: 'hidden' }}>
              <div style={{ padding: '12px 14px', borderBottom: '1px solid rgba(255,255,255,0.07)' }}>
                <div style={{ fontSize: 12, fontWeight: 850, letterSpacing: '.12em', textTransform: 'uppercase', color: '#23d18b' }}>Total Section</div>
                <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.58)', marginTop: 2 }}>Combined component premium and weighted ROL used by the main structure table.</div>
              </div>
              <div style={{ overflowX: 'auto' }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 760, fontSize: 11 }}>
                  <thead style={{ background: '#050810' }}>
                    <tr>
                      {['Component', 'Active Layers', 'Limit', 'Premium', 'Weighted ROL'].map((h, i) => (
                        <th key={`total-${h}`} style={{ ...th, textAlign: i === 0 ? 'left' : 'right' }}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      { label: 'Risk', color: QUOTE_COMPONENT_SCOPES.risk.color, ...riskTotal },
                      { label: 'Cat', color: QUOTE_COMPONENT_SCOPES.cat.color, ...catTotal },
                      { label: 'Total', color: '#23d18b', ...grandTotal },
                    ].map((row) => (
                      <tr key={`total-${row.label}`} style={{ borderBottom: '1px solid rgba(255,255,255,0.045)' }}>
                        <td style={{ padding: '8px 10px', color: row.color, fontWeight: 850 }}>{row.label}</td>
                        <td style={{ padding: '8px 10px', textAlign: 'right' }}>{row.activeCount || '—'}</td>
                        <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtMoney(row.totalLimit)}</td>
                        <td style={{ padding: '8px 10px', textAlign: 'right' }}>{fmtMoney(row.premium)}</td>
                        <td style={{ padding: '8px 10px', textAlign: 'right', color: row.color, fontWeight: 850 }}>{row.wtdRol > 0 ? `${row.wtdRol.toFixed(2)}%` : '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          </div>
        </div>
      </div>
    );
  };

  return (
    <WizardLayout routeKey={ROUTE_KEY} title={isQuote ? 'Final Quote' : 'Final Pricing'} headerPill={isQuote ? 'NON-PROPORTIONAL FINAL QUOTE' : 'NON-PROPORTIONAL TREATY: FINAL PRICING'} onBeforeNext={save} onBeforeBack={save}
      /* Own SaveStateIndicator covers workflow-button saves (Submit
         for Approval, Mark Signed, etc) that don't flow through
         wizard nav; suppress the WizardLayout one to avoid a double
         banner on Back/Next. */
      suppressSaveIndicator>
      {({ showToast }) => (
        <div className={`np-final-shell${isQuote ? ' np-final-shell--quote' : ''}`}>
          <SaveStateIndicator saveState={saveState} onRetry={save} />
          {loading ? <div className="df-card df-card--notice"><div className="df-note">Loading...</div></div> : (
            <>
              {isNpAggregateXlTreaty(appState) && (
                /* Aggregate XL treaties get the Bloomberg-style hero
                   at the top (populated from the structure slice)
                   followed by the structure read-only — edits
                   happen on the Structure page. */
                <>
                  <NpAggregateXlHero
                    npDetail={npDetail}
                    aggXlInputs={appState.npAggregateXlInputs}
                    offerStatus={offerStatus}
                    currency={currency}
                    techRatio={techRatioAvg}
                  />
                  <NpAggregateXlStructure currency={currency} readOnly />
                </>
              )}
              {isQuote ? (
                /* ═══════ QUOTE PRICING — QuickBenchmark-style topbar ═══════
                   Mirrors /np/benchmark visually: sticky bm-topbar with
                   logo + title + status pill, then a bm-card--meta grid
                   surfacing the four treaty-detail fields. Read-only
                   here — values come from npTreatyDetail (set on the
                   Treaty Detail step). */
                <>
                  <header className="bm-topbar" style={{ position: 'static', borderRadius: 14, marginBottom: 12 }}>
                    <div className="bm-topbar-left">
                      <div className="bm-logo">QT</div>
                      <div>
                        <div className="bm-topbar-title">QUOTE PRICING</div>
                        <div className="bm-topbar-sub">
                          Treaty Quote Workflow
                          {snap.cedant && snap.cedant !== '–' && (
                            <span className="bm-topbar-context"> · {snap.cedant}</span>
                          )}
                          {npDetail.quoteRef && (
                            <span className="bm-topbar-context"> · {npDetail.quoteRef}</span>
                          )}
                        </div>
                      </div>
                    </div>
                    <div className="bm-topbar-right">
                      <button
                        className="bm-pill"
                        onClick={runQuoteCalcEngine}
                        disabled={calcEngineRunning || !clientStructures.length}
                        style={{ borderColor: 'rgba(56,189,248,0.45)', color: '#38bdf8', background: 'rgba(56,189,248,0.08)' }}
                        title="Calculate quote structure pure burn, Pareto, and exposure with the NP actuarial engine"
                      >
                        {calcEngineRunning ? 'Calculating...' : 'Run Actuarial Engine'}
                      </button>
                      {/* Explicit Save — saves expiring layers, structures,
                          COB selection + UW limits + toggles in one shot.
                          Reuses the same save() the wizard nav already
                          calls so we have one code path. */}
                      <button
                        className="bm-pill"
                        onClick={async () => { const ok = await save(); if (ok) showToast?.('Saved'); else showToast?.('Save failed'); }}
                        disabled={saveState.status === 'saving'}
                        style={{ borderColor: 'rgba(35,209,139,0.45)', color: '#23d18b', background: 'rgba(35,209,139,0.08)' }}
                        title="Save expiring layers, structures, COB selection, and underwriting limits"
                      >
                        {saveState.status === 'saving' ? '⏳ Saving…'
                          : saveState.status === 'error' ? '⚠ Retry Save'
                          : saveState.status === 'saved' ? '✓ Saved'
                          : '💾 Save'}
                      </button>
                      <span className="bm-pill" style={{ cursor: 'default' }}>
                        {(offerStatus || 'DRAFT').replace(/_/g, ' ')}
                      </span>
                    </div>
                  </header>

                  {/* Treaty Details — read-only, sourced from earlier wizard steps */}
                  <section className="bm-card bm-card--meta" style={{ marginBottom: 12 }}>
                    <div className="bm-card-header" style={{ borderBottom: 'none' }}>
                      <div className="bm-card-title">Treaty Details</div>
                    </div>
                    <div className="bm-meta-grid">
                      <div className="bm-field">
                        <label className="bm-label">Cedant</label>
                        <div className="bm-input" style={{ background: 'rgba(255,255,255,0.02)' }}>
                          {snap.cedant && snap.cedant !== '–' ? snap.cedant : '—'}
                        </div>
                      </div>
                      <div className="bm-field">
                        <label className="bm-label">Class of Business</label>
                        <button className="bm-input bm-input--btn" onClick={() => setShowCobModal(true)} type="button">
                          <span style={{ color: selectedCobs.length ? 'rgba(226,232,240,0.90)' : 'rgba(255,255,255,0.30)' }}>
                            {selectedCobs.length ? selectedCobs.map((c) => c.name).join(', ') : '— Select COB —'}
                          </span>
                          <span className="bm-input-chevron">▾</span>
                        </button>
                      </div>
                      <div className="bm-field">
                        <label className="bm-label">Currency</label>
                        <div className="bm-input" style={{ background: 'rgba(255,255,255,0.02)' }}>
                          {currency || '—'}
                        </div>
                      </div>
                      <div className="bm-field">
                        <label className="bm-label">Country</label>
                        <div className="bm-input" style={{ background: 'rgba(255,255,255,0.02)' }}>
                          {npDetail.countryName || npDetail.country || '—'}
                        </div>
                      </div>
                    </div>
                  </section>

                  {/* ── Calibration badge (mirrors QuickBenchmark's curve calibration row). */}
                  <div className="bm-curve-badge-row" style={{ marginBottom: 12 }}>
                    <div className={`bm-curve-badge ${quoteCurve.fit.calibrated ? 'bm-curve-badge--live' : 'bm-curve-badge--market'}`}>
                      {quoteCurve.fit.calibrated ? 'Calibrated from expiring' : 'Market default (a=0.108, b=-1.074)'}
                      <span>a={quoteCurve.fit.a.toFixed(5)}</span>
                      <span>b={quoteCurve.fit.b.toFixed(4)}</span>
                      {quoteCurve.fit.r2 != null && <span>R2={quoteCurve.fit.r2.toFixed(3)}</span>}
                      {!quoteCurve.fit.calibrated && <span style={{ opacity: 0.55 }}>Add &gt;=2 expiring layers with rates to calibrate</span>}
                    </div>
                  </div>

                  {/* ── Expiring Structure (first structure) ── */}
                  <section className="bm-card" style={{ marginBottom: 12 }}>
                    <div className="bm-card-header">
                      <div>
                        <div className="bm-card-title">Expiring Structure</div>
                        <div className="bm-card-hint">Known market terms — first structure on the quote.</div>
                      </div>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                        <button
                          className="bbg-ib bbg-ib--blue"
                          style={quoteInsightButtonStyle}
                          onClick={() => openBenchmark('country', 'Expiring Structure', expLayers)}
                        >
                          Analysis
                        </button>
                        <label className="bm-label" style={{ margin: 0 }}>Number of Layers</label>
                        <select
                          className="bm-input"
                          style={{ width: 90 }}
                          value={numExpLayers}
                          onChange={(e) => {
                            const n = Math.max(1, Math.min(QM_MAX_LAYERS, parseInt(e.target.value, 10) || 1));
                            setNumExpLayers(n);
                            setExpLayers((prev) => {
                              if (n === prev.length) return prev;
                              if (n < prev.length) return prev.slice(0, n);
                              const grown = prev.slice();
                              for (let i = prev.length; i < n; i += 1) grown.push(emptyExpLayer(i));
                              return cascadeQuoteAttachments(grown);
                            });
                          }}
                        >
                          {Array.from({ length: QM_MAX_LAYERS }, (_, i) => i + 1).map((n) => (
                            <option key={n} value={n}>{n}</option>
                          ))}
                        </select>
                      </div>
                    </div>
                    <div className="bm-table-wrap">
                      <table className="bm-table" style={{ minWidth: 1600, tableLayout: 'fixed' }}>
                        <colgroup>{[
                          <col key="layer" style={{ width: 58 }} />,
                          <col key="limit" style={{ width: 127 }} />,
                          <col key="attachment" style={{ width: 127 }} />,
                          <col key="egnpi" style={{ width: 127 }} />,
                          <col key="rate" style={{ width: 81 }} />,
                          <col key="earnedPremium" style={{ width: 127 }} />,
                          <col key="rol" style={{ width: 81 }} />,
                          <col key="mdp" style={{ width: 81 }} />,
                          <col key="reinstatements" style={{ width: 81 }} />,
                          <col key="pctReinst" style={{ width: 81 }} />,
                          <col key="risk" style={{ width: 64 }} />,
                          <col key="cat" style={{ width: 64 }} />,
                          <col key="pAttach" style={{ width: 104 }} />,
                          <col key="pExhaust" style={{ width: 104 }} />,
                        ]}</colgroup>
                        <thead>
                          <tr>
                            <th>Layer</th>
                            <th>Limit</th>
                            <th>Attachment</th>
                            <th>EGNPI</th>
                            <th>Rate %</th>
                            <th>Earned Premium</th>
                            <th>ROL</th>
                            <th>MDP</th>
                            <th>Reinst</th>
                            <th>Reinst %</th>
                            <th>Risk</th>
                            <th>Cat</th>
                            <th>P(Attach)</th>
                            <th>P(Exh)</th>
                          </tr>
                        </thead>
                        <tbody>
                          {expLayers.map((l, i) => {
                            const setField = (field, val) => {
                              setExpLayers((prev) => {
                                const next = prev.map((row, idx) => {
                                  if (idx !== i) return row;
                                  const updated = { ...row, [field]: val };
                                  return ['rate', 'rol', 'limit', 'egnpi'].includes(field)
                                    ? syncExpLayerPricing(updated, field)
                                    : updated;
                                });
                                // Limit on any layer or attachment on layer 0 cascades the rest.
                                if (field === 'limit' || (field === 'attachment' && i === 0)) {
                                  return cascadeQuoteAttachments(next);
                                }
                                return next;
                              });
                            };
                            const attachmentLocked = i > 0;
                            return (
                              <tr key={l.id}>
                                <td style={{ textAlign: 'center' }}><span className="bm-badge bm-badge--exp">{i + 1}</span></td>
                                <td><FQNumCell value={l.limit}          onChange={(v) => setField('limit', v)} /></td>
                                <td>
                                  {attachmentLocked
                                    ? <FQNumCell value={l.attachment} onChange={() => {}} className="bm-cell" style={{ opacity: 0.6, pointerEvents: 'none' }} />
                                    : <FQNumCell value={l.attachment} onChange={(v) => setField('attachment', v)} />}
                                </td>
                                <td><FQNumCell value={l.egnpi}          onChange={(v) => setField('egnpi', v)} /></td>
                                <td><FQPctCell value={l.rate}           onChange={(v) => setField('rate', v)} /></td>
                                <td>
                                  <FQReadCell
                                    value={l.earnedPremium ? formatWithCommas(String(Math.round(toN(l.earnedPremium)))) : ''}
                                    className="bm-cell bm-cell--display bm-cell--muted"
                                  />
                                </td>
                                <td><FQPctCell value={l.rol}            onChange={(v) => setField('rol', v)} /></td>
                                <td><FQNumCell value={l.mdp}            onChange={(v) => setField('mdp', v)} className="bm-cell bm-cell--sm" /></td>
                                <td><input className="bm-cell bm-cell--sm" value={l.reinstatements} onChange={(e) => setField('reinstatements', e.target.value)} placeholder="—" /></td>
                                <td><FQPctCell value={l.pctReinst}      onChange={(v) => setField('pctReinst', v)} /></td>
                                <td style={{ textAlign: 'center' }}><input type="checkbox" className="np-check" checked={!!l.risk} onChange={() => setField('risk', !l.risk)} /></td>
                                <td style={{ textAlign: 'center' }}><input type="checkbox" className="np-check" checked={!!l.cat}  onChange={() => setField('cat', !l.cat)} /></td>
                                <td><FQPctCell value={l.pAttach}        onChange={(v) => setField('pAttach', v)} /></td>
                                <td><FQPctCell value={l.pExhaust}       onChange={(v) => setField('pExhaust', v)} /></td>
                              </tr>
                            );
                          })}
                        </tbody>
                        {(() => {
                          const totLim   = expLayers.reduce((s, l) => s + toN(l.limit), 0);
                          const totAtt   = expLayers.reduce((s, l) => s + toN(l.attachment), 0);
                          const totEgnpi = expLayers.reduce((s, l) => s + toN(l.egnpi), 0);
                          const totEp    = expLayers.reduce((s, l) => s + expLayerEarnedPremium(l), 0);
                          const wRate    = totEgnpi > 0 ? (totEp / totEgnpi) * 100 : 0;
                          const wRol     = totLim > 0 ? (totEp / totLim) * 100 : 0;
                          if (totLim <= 0 && totEgnpi <= 0) return null;
                          return (
                            <tfoot>
                              <tr className="bm-foot">
                                <td><FQReadCell value="TOTAL" className="bm-cell bm-cell--display bm-cell--foot" /></td>
                                <td><FQReadCell value={totLim   > 0 ? formatWithCommas(String(Math.round(totLim)))   : '—'} className="bm-cell bm-cell--display bm-cell--foot" /></td>
                                <td><FQReadCell value={totAtt   > 0 ? formatWithCommas(String(Math.round(totAtt)))   : '—'} className="bm-cell bm-cell--display bm-cell--foot" /></td>
                                <td><FQReadCell value={totEgnpi > 0 ? formatWithCommas(String(Math.round(totEgnpi))) : '—'} className="bm-cell bm-cell--display bm-cell--foot" /></td>
                                <td><FQReadCell value={wRate > 0 ? `${wRate.toFixed(2)}%` : '—'} className="bm-cell bm-cell--sm bm-cell--display bm-cell--foot" /></td>
                                <td><FQReadCell value={totEp > 0 ? formatWithCommas(String(Math.round(totEp))) : '—'} className="bm-cell bm-cell--display bm-cell--foot" /></td>
                                <td><FQReadCell value={wRol  > 0 ? `${wRol.toFixed(2)}%`  : '—'} className="bm-cell bm-cell--sm bm-cell--display bm-cell--foot" /></td>
                                <td colSpan={7}></td>
                              </tr>
                            </tfoot>
                          );
                        })()}
                      </table>
                    </div>
                  </section>

                  {/* ── Implied Pricing Curve ── */}
                  <section className="bm-card bm-card--curve" style={{ marginBottom: 12 }}>
                    <div className="bm-card-header">
                      <div>
                        <div className="bm-card-title">Implied Pricing Curve</div>
                        <div className="bm-card-hint">Violet = expiring · Coloured dots = new structure layers priced on curve</div>
                      </div>
                    </div>
                    <div className="bm-curve-svg-wrap">
                      <FQPricingCurve curve={quoteCurve} />
                    </div>
                  </section>

                  {renderQuoteCobParticipationTable('exp', expLayers, { title: 'Expiring Underwriting Limits' })}

                  {/* ── Additional structures (dynamic) ── */}
                  {clientStructures.map((str, sIdx) => {
                    const color = FQ_STRUCTURE_COLORS[sIdx % FQ_STRUCTURE_COLORS.length];
                    const setStrLayer = (lIdx, field, val) => updateClientStructureLayer(sIdx, lIdx, field, val);
                    const addLayer = () => addClientStructureLayer(sIdx);
                    const removeLayer = (lIdx) => removeClientStructureLayer(sIdx, lIdx);
                    const removeStructure = () => removeClientStructure(sIdx);
                    const isApprovedStructure = !!approvedStructures[sIdx];
                    return (
                      <React.Fragment key={str.id}>
                        <section className="bm-card" style={{ marginBottom: 12, borderColor: `${color}22` }}>
                        <div className="bm-card-header">
                          <div>
                            <div className="bm-card-title" style={{ color }}>Structure {sIdx + 1}</div>
                            <div className="bm-card-hint">Layers for pricing.</div>
                          </div>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                              <button
                                className="bbg-ib bbg-ib--blue"
                                onClick={() => setPricingGraphModal({ open: true, sourceLabel: `Structure ${sIdx + 1}`, structure: str })}
                                style={quoteInsightButtonStyle}
                              >
                                Pricing Graph
                              </button>
                              <button
                                className="bbg-ib bbg-ib--cyan"
                                onClick={() => setPricingAnalysisModal({ open: true, structureIndex: sIdx })}
                                style={quoteInsightButtonStyle}
                              >
                                Pricing Analysis
                              </button>
                              <button
                                className="bbg-ib bbg-ib--violet"
                                onClick={() => openBenchmark('country', `Structure ${sIdx + 1}`, str.layers)}
                                style={quoteInsightButtonStyle}
                              >
                                Market Analysis
                              </button>
                              <label
                                className={`bbg-ib ${isApprovedStructure ? 'bbg-ib--green' : 'bbg-ib--ghost'}`}
                                style={{ ...quoteInsightButtonStyle, gap: 7, cursor: 'pointer' }}
                                title="Include this structure in the Chief Underwriter approval submission"
                              >
                                <input
                                  type="checkbox"
                                  className="np-check"
                                  aria-label={`Send Structure ${sIdx + 1} for Approval`}
                                  checked={isApprovedStructure}
                                  onChange={(e) => setApprovedQuoteStructure(sIdx, e.target.checked)}
                                  style={{ margin: 0 }}
                                />
                                Send for Approval
                              </label>
                            </div>
                            <button
                              className="bbg-ib bbg-ib--green"
                              style={quoteInsightButtonStyle}
                              onClick={addLayer}
                              disabled={str.layers.length >= QM_MAX_LAYERS}
                            >
                              + Layer
                            </button>
                            <button
                              className="bbg-ib bbg-ib--pink"
                              style={{ ...quoteInsightButtonStyle, padding: '9px 12px' }}
                              onClick={removeStructure}
                              title="Remove structure"
                            >
                              ✕
                            </button>
                          </div>
                        </div>
                        <div className="bm-table-wrap">
                          <table className="bm-table" style={{ minWidth: 1853, tableLayout: 'fixed' }}>
                            <colgroup>{[
                              <col key="layer" style={{ width: 58 }} />,
                              <col key="limit" style={{ width: 127 }} />,
                              <col key="deductible" style={{ width: 127 }} />,
                              <col key="risk" style={{ width: 64 }} />,
                              <col key="cat" style={{ width: 64 }} />,
                              <col key="pureBurn" style={{ width: 92 }} />,
                              <col key="pareto" style={{ width: 92 }} />,
                              <col key="burnPareto" style={{ width: 104 }} />,
                              <col key="exposure" style={{ width: 104 }} />,
                              <col key="wtBurn" style={{ width: 92 }} />,
                              <col key="wtPareto" style={{ width: 92 }} />,
                              <col key="wtExp" style={{ width: 92 }} />,
                              <col key="loading" style={{ width: 92 }} />,
                              <col key="totalRol" style={{ width: 104 }} />,
                              <col key="uwPrice" style={{ width: 104 }} />,
                              <col key="pAttach" style={{ width: 104 }} />,
                              <col key="pExhaust" style={{ width: 104 }} />,
                              <col key="delete" style={{ width: 41 }} />,
                            ]}</colgroup>
                            <thead>
                              <tr>
                                <th>Layer</th>
                                <th>Limit</th>
                                <th>Deductible</th>
                                <th>Risk</th>
                                <th>Cat</th>
                                <th>Pure Burn</th>
                                <th>Pareto</th>
                                <th>Burn+Pareto</th>
                                <th>Exposure</th>
                                <th>Wt Burn %</th>
                                <th>Wt Pareto %</th>
                                <th>Wt Exp %</th>
                                <th>Loading %</th>
                                <th>Total ROL</th>
                                <th style={{ color: '#00d4ff' }}>UW Price</th>
                                <th>P(Attach)</th>
                                <th>P(Exh)</th>
                                <th></th>
                              </tr>
                            </thead>
                            <tbody>
                              {str.layers.map((l, lIdx) => {
                                const d = computeLayerDerived(l);
                                return (
                                  <tr key={l.id}>
                                    <td style={{ textAlign: 'center' }}>
                                      <span className="bm-badge" style={{ background: `${color}14`, borderColor: `${color}35`, color }}>{lIdx + 1}</span>
                                    </td>
                                    <td><FQNumCell value={l.limit}      onChange={(v) => setStrLayer(lIdx, 'limit', v)} /></td>
                                    <td>
                                      {lIdx > 0
                                        ? <FQNumCell value={l.attachment} onChange={() => {}} className="bm-cell" style={{ opacity: 0.6, pointerEvents: 'none' }} />
                                        : <FQNumCell value={l.attachment} onChange={(v) => setStrLayer(lIdx, 'attachment', v)} />}
                                    </td>
                                    <td style={{ textAlign: 'center' }}>
                                      <input
                                        type="checkbox"
                                        className="np-check"
                                        aria-label={`Structure ${sIdx + 1} Layer ${lIdx + 1} Risk`}
                                        checked={!!l.risk}
                                        disabled={riskDisabled}
                                        onChange={(e) => setStrLayer(lIdx, 'risk', e.target.checked)}
                                      />
                                    </td>
                                    <td style={{ textAlign: 'center' }}>
                                      <input
                                        type="checkbox"
                                        className="np-check"
                                        aria-label={`Structure ${sIdx + 1} Layer ${lIdx + 1} Cat`}
                                        checked={!!l.cat}
                                        disabled={catDisabled}
                                        onChange={(e) => setStrLayer(lIdx, 'cat', e.target.checked)}
                                      />
                                    </td>
                                    <td><FQPctCell value={l.pureBurn}    onChange={(v) => setStrLayer(lIdx, 'pureBurn', v)} /></td>
                                    <td><FQPctCell value={l.pareto}      onChange={(v) => setStrLayer(lIdx, 'pareto', v)} /></td>
                                    <td>
                                      <FQReadCell
                                        value={d.burnPlusPareto > 0 ? `${d.burnPlusPareto.toFixed(2)}%` : '—'}
                                        className="bm-cell bm-cell--sm bm-cell--display bm-cell--muted bm-calc"
                                      />
                                    </td>
                                    <td><FQPctCell value={l.exposure}    onChange={(v) => setStrLayer(lIdx, 'exposure', v)} /></td>
                                    <td><FQPctCell value={l.wtBurn}      onChange={(v) => setStrLayer(lIdx, 'wtBurn', v)} /></td>
                                    <td><FQPctCell value={l.wtPareto}    onChange={(v) => setStrLayer(lIdx, 'wtPareto', v)} /></td>
                                    <td>
                                      <FQReadCell
                                        value={`${d.wtExp.toFixed(0)}%`}
                                        className="bm-cell bm-cell--sm bm-cell--display bm-cell--muted bm-calc"
                                      />
                                    </td>
                                    <td><FQPctCell value={l.loading}     onChange={(v) => setStrLayer(lIdx, 'loading', v)} /></td>
                                    <td>
                                      <FQReadCell
                                        value={d.totalRol > 0 ? `${d.totalRol.toFixed(2)}%` : '—'}
                                        className="bm-cell bm-cell--sm bm-cell--display bm-cell--accent bm-calc"
                                      />
                                    </td>
                                    <td><FQPctCell value={l.uwPrice}     onChange={(v) => setStrLayer(lIdx, 'uwPrice', v)} placeholder={d.totalRol > 0 ? `${d.totalRol.toFixed(2)}%` : '—%'} /></td>
                                    <td><FQPctCell value={l.pAttach}     onChange={(v) => setStrLayer(lIdx, 'pAttach', v)} /></td>
                                    <td><FQPctCell value={l.pExhaust}    onChange={(v) => setStrLayer(lIdx, 'pExhaust', v)} /></td>
                                    <td><button className="bm-del" onClick={() => removeLayer(lIdx)}>✕</button></td>
                                  </tr>
                                );
                              })}
                            </tbody>
                            {(() => {
                              const totLim = str.layers.reduce((s, l) => s + toN(l.limit), 0);
                              if (totLim <= 0) return null;
                              // Limit-weighted averages for the percentage columns
                              const wAvg = (key) => {
                                const num = str.layers.reduce((s, l) => s + toN(l.limit) * toN(l[key]), 0);
                                return totLim > 0 ? num / totLim : 0;
                              };
                              const wAvgDerived = (selector) => {
                                const num = str.layers.reduce((s, l) => s + toN(l.limit) * selector(computeLayerDerived(l)), 0);
                                return totLim > 0 ? num / totLim : 0;
                              };
                              const wPureBurn  = wAvg('pureBurn');
                              const wPareto    = wAvg('pareto');
                              const wExposure  = wAvg('exposure');
                              const wTotalRol  = wAvgDerived((d) => d.totalRol);
                              const wUwPrice   = wAvg('uwPrice');
                              const avg = (key, dflt) => {
                                const vals = str.layers.map((l) => toN(l[key]) || toN(dflt));
                                if (!vals.length) return 0;
                                return vals.reduce((s, v) => s + v, 0) / vals.length;
                              };
                              return (
                                <tfoot>
                                  <tr className="bm-foot" style={{ borderTopColor: `${color}25` }}>
                                    <td><FQReadCell value="TOTAL" className="bm-cell bm-cell--display bm-cell--foot" /></td>
                                    <td><FQReadCell value={formatWithCommas(String(Math.round(totLim)))} className="bm-cell bm-cell--display bm-cell--foot" /></td>
                                    <td></td>
                                    <td></td>
                                    <td></td>
                                    <td><FQReadCell value={wPureBurn  > 0 ? `${wPureBurn.toFixed(2)}%`  : '—'} className="bm-cell bm-cell--sm bm-cell--display bm-cell--foot" /></td>
                                    <td><FQReadCell value={wPareto    > 0 ? `${wPareto.toFixed(2)}%`    : '—'} className="bm-cell bm-cell--sm bm-cell--display bm-cell--foot" /></td>
                                    <td><FQReadCell value={(wPureBurn + wPareto) > 0 ? `${(wPureBurn + wPareto).toFixed(2)}%` : '—'} className="bm-cell bm-cell--sm bm-cell--display bm-cell--foot" /></td>
                                    <td><FQReadCell value={wExposure  > 0 ? `${wExposure.toFixed(2)}%`  : '—'} className="bm-cell bm-cell--sm bm-cell--display bm-cell--foot" /></td>
                                    <td><FQReadCell value={`${avg('wtBurn', '50').toFixed(0)}%`} className="bm-cell bm-cell--sm bm-cell--display bm-cell--foot" /></td>
                                    <td><FQReadCell value={`${avg('wtPareto', '0').toFixed(0)}%`} className="bm-cell bm-cell--sm bm-cell--display bm-cell--foot" /></td>
                                    <td><FQReadCell value={`${(100 - avg('wtBurn', '50') - avg('wtPareto', '0')).toFixed(0)}%`} className="bm-cell bm-cell--sm bm-cell--display bm-cell--foot" /></td>
                                    <td><FQReadCell value={`${avg('loading', '15').toFixed(0)}%`} className="bm-cell bm-cell--sm bm-cell--display bm-cell--foot" /></td>
                                    <td><FQReadCell value={wTotalRol > 0 ? `${wTotalRol.toFixed(2)}%` : '—'} className="bm-cell bm-cell--sm bm-cell--display bm-cell--accent" /></td>
                                    <td><FQReadCell value={wUwPrice  > 0 ? `${wUwPrice.toFixed(2)}%`  : '—'} className="bm-cell bm-cell--sm bm-cell--display bm-cell--accent" /></td>
                                    <td></td>
                                    <td></td>
                                    <td></td>
                                  </tr>
                                </tfoot>
                              );
                            })()}
                          </table>
                        </div>
                        </section>
                        {renderQuoteCobParticipationTable(str.id, str.layers, { title: 'Underwriting Limits' })}
                      </React.Fragment>
                    );
                  })}

                  {/* ── Add Structure button ── */}
                  <div style={{ display: 'flex', justifyContent: 'center', margin: '8px 0 16px' }}>
                    <button
                      className="bm-pill"
                      onClick={addQuoteStructure}
                      disabled={clientStructures.length >= QM_MAX_STRUCTURES}
                      style={{ padding: '10px 22px', borderColor: 'rgba(35,209,139,0.35)', color: '#23d18b', background: 'rgba(35,209,139,0.06)' }}
                    >
                      + Add Structure
                    </button>
                  </div>

                  {showCobModal && (
                    <FQCobSelectModal
                      selected={selectedCobs.map((c) => c.id)}
                      cobList={cobList}
                      onSave={(ids) => {
                        const map = new Map(cobList.map((c) => [c.id, c.name]));
                        setSelectedCobs((prev) => {
                          const prevMap = new Map(prev.map((c) => [c.id, c]));
                          return ids.map((id) => prevMap.get(id) || { id, name: map.get(id) || id, uwLimit: '' });
                        });
                        setShowCobModal(false);
                      }}
                      onClose={() => setShowCobModal(false)}
                    />
                  )}
                </>
              ) : (
                <>
                  {/* ═══════ BLOOMBERG HERO ═══════ */}
                  <NpBloombergHero
                    npDetail={npDetail}
                    structureLayers={localStructureLayers.length ? localStructureLayers : structureLayers}
                    mode={mode}
                    offerStatus={offerStatus}
                    currency={currency}
                    techRatio={techRatioAvg}
                  />

                  {/* ── Insight row ── */}
                  <div className="np-bbg-insight-row">
                    {[
                      { k:'LARGE_LOSSES',   label:'Large Losses',       color:'pink',    disabled: mode === 'CAT' },
                      { k:'CAT_LOSSES',     label:'CAT Losses',         color:'amber',   disabled: mode === 'RISK' },
                      { k:'AGGREGATES',     label:'Aggregates',         color:'teal',    disabled: mode === 'RISK' },
                      { k:'RISK_PROFILE',   label:'Risk Profile',       color:'cyan' },
                      { k:'CEDANT',         label:'Cedant Summary',     color:'violet' },
                      { k:'REINSURER',      label:'Reinsurer Analysis', color:'green',   onClick: () => setShowReinsurerModal(true) },
                      { k:'TECH_ANALYSIS',  label:'Technical Analysis', color:'emerald', onClick: () => setShowTechAnalysisModal(true) },
                      { k:'HIST_PERF',      label:'Hist. Performance',  color:'blue',    onClick: () => navigate('/np/historical-performance') },
                      { k:'MKT_ANALYSIS',   label:'Market Analysis',    color:'slate',
                        // Same analysis modal as the quote pricing screen.
                        // It opens on Country and lets the user switch scope inside.
                        onClick: () => openBenchmark('country', 'Layer Pricing', layers) },
                      { k:'CHECKLIST',      label:'Checklist',          color:'ghost' },
                    ].map(b => (
                      <button key={b.k}
                        className={`bbg-ib bbg-ib--${b.color}`}
                        disabled={!!b.disabled}
                        title={b.disabled ? 'Not applicable for this treaty type' : undefined}
                        onClick={() => { if (b.onClick) { b.onClick(); } else { setInsightKey(b.k); setInsightOpen(true); } }}>
                        {b.label}
                      </button>
                    ))}
                  </div>

                  {/* Top Grid: Lead Setup (Snapshot removed — fields shown in topbar) */}
                  <div className="np-final-top-grid">
{/* Lead Reinsurer Setup moved to Reinsurer Analysis modal */}
                  </div>
                </>
              )}

              {/* Country / Regional / Global analysis modal —
                  shared across quote + contract Final Pricing. */}
              <FQBenchmarkModal
                open={benchmarkModal.open}
                scope={benchmarkModal.scope}
                sourceLabel={benchmarkModal.sourceLabel}
                sourceLayers={benchmarkModal.sourceLayers}
                currency={currency}
                cobNames={selectedCobs.map((c) => c.name)}
                contractId={contractId}
                cobIds={selectedCobs.map((c) => c.id).filter(Boolean)}
                onClose={() => setBenchmarkModal((prev) => ({ ...prev, open: false }))}
              />
              <FQPricingGraphModal
                open={pricingGraphModal.open}
                sourceLabel={pricingGraphModal.sourceLabel}
                structure={pricingGraphModal.structure}
                expLayers={expLayers}
                npDetail={npDetail}
                portfolioRows={portfolioExportRows}
                currency={currency}
                onClose={() => setPricingGraphModal({ open: false, sourceLabel: '', structure: null })}
              />
              {renderPricingAnalysisModal()}


              {isQuote && quoteStructures.length === 0 && (
                <section className="np-final-section">
                  <div className="np-final-card" style={{ padding: 24, textAlign: 'center' }}>
                    <p className="muted">No quote structures found. Define structures on the NP Structure screen.</p>
                  </div>
                </section>
              )}



              {/* ── Actuarial Engine bar ── */}
              {!isQuote && layers.length === 0 && (
                <div className="df-card df-card--notice" style={{ margin: '16px 0', padding: '20px 24px', borderRadius: 10, background: 'rgba(0,212,255,0.07)', border: '1px solid rgba(0,212,255,0.25)', display: 'flex', alignItems: 'center', gap: 14 }}>
                  <span style={{ fontSize: 22 }}>⚠️</span>
                  <div>
                    <div style={{ fontWeight: 600, color: '#00d4ff', marginBottom: 4 }}>No structure defined yet</div>
                    <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.6)' }}>
                      Please complete the <strong style={{ color: 'rgba(255,255,255,0.8)' }}>NP Structure</strong> screen first to define layers before pricing can be calculated.
                    </div>
                  </div>
                </div>
              )}

              {!isQuote && layers.length > 0 && (
                <div style={{ display:'flex', alignItems:'center', gap:12, padding:'10px 2px', marginBottom:4 }}>
                  <button
                    className="np-btn np-btn--primary"
                    style={{ minWidth:160, fontWeight:700 }}
                    disabled={calcEngineRunning || !layers.length}
                    onClick={runCalcEngine}>
                    {calcEngineRunning ? '⟳ Calculating…' : '⚡ Run Actuarial Engine'}
                  </button>
                  <span style={{ fontSize:12, color:'rgba(226,232,240,0.55)' }}>
                    {mode === 'RISK' ? 'Pure Burn · Pareto · MBBEFD Exposure Rating'
                      : mode === 'CAT' ? 'Pure Burn · Pareto · CRESTA Exposure Rating'
                      : 'Pure Burn · Pareto · MBBEFD + CRESTA Exposure Rating'}
                  </span>
                  {calcEngineError && (
                    <span style={{ fontSize:12, color:'#f87171', marginLeft:'auto' }}>{calcEngineError}</span>
                  )}
                </div>
              )}

              {/* Risk XL Layers — pure burn & pareto use large losses; exposure uses MBBEFD risk profile */}
              {!isQuote && layers.length > 0 && !riskDisabled && <NpLayerTable section="RISK" rows={riskLayers} layers={layers} updateLayer={updateLayer} disabled={isTerminal} />}

              {/* Cat XL Layers — pure burn & pareto use cat losses; exposure uses damage ratio / CRESTA */}
              {!isQuote && layers.length > 0 && !catDisabled && <NpLayerTable section="CAT" rows={catLayers} layers={layers} updateLayer={updateLayer} disabled={isTerminal} />}

              {/* Combined Pricing + Programme Limits (standard only) */}
              {!isQuote && layers.length > 0 && (<>
              <section className="np-final-section">
                <div className="np-final-section-head" style={{ display:'flex', alignItems:'center', gap:8 }}>
                  <div className="np-final-section-title">Pricing</div>
                  <span className="np-badge">Combined</span>
                  <div style={{ flex:1 }} />
                  {/* Market intelligence trigger. Same call as the
                      pricing screen header used to host inside the
                      offer modal — now reachable without entering
                      the offer flow. */}
                  {(() => {
                    const npCountryId = appState.npTreatyDetail?.countryId || null;
                    const npCobIds = Array.isArray(appState.npTreatyDetail?.classOfBusinessIds)
                      ? appState.npTreatyDetail.classOfBusinessIds : [];
                    const npPrimaryCobId = npCobIds[0]
                      || appState.npTreatyDetail?.primaryClassOfBusinessId || null;
                    const npTargetYear = Number(npDetail?.startYear) || Number(npDetail?.uwYear) || null;
                    const marketAvailable = !!(npCountryId && npPrimaryCobId && npTargetYear);
                    return (
                      <button
                        type="button"
                        className="bbg-btn bbg-btn--outline"
                        disabled={!marketAvailable}
                        title={marketAvailable
                          ? 'Open the cached market intelligence report for this treaty'
                          : 'Country and class of business required for market intelligence.'}
                        onClick={() => marketAvailable && setMarketModalOpen(true)}
                        style={{
                          borderColor: marketAvailable ? 'rgba(103,232,249,0.45)' : 'rgba(255,255,255,0.14)',
                          color: marketAvailable ? '#67e8f9' : 'rgba(255,255,255,0.30)',
                          cursor: marketAvailable ? 'pointer' : 'not-allowed',
                        }}
                      >📊 Market Intelligence</button>
                    );
                  })()}
                </div>
                <div className="np-final-card np-final-card--flush">
                  <div className="np-final-table-wrap np-final-table-wrap--wide">
                    <table className="np-final-table np-final-table--pricing">
                      <thead><tr>
                        <th className="col-layer">Layer</th><th className="col-limit">Limit</th><th className="col-deductible">Deductible</th>
                        <th className="col-reinst">Reinstatements</th>
                        <th className="col-pct col-reinsurer">Reinsurer</th><th className="col-pct col-lead">Lead</th><th className="col-pct col-expiring">Expiring</th>
                        <th className="col-pct">Hist. Margin</th>
                        <th className="col-pct">Margin</th><th className="col-pct">Tech Ratio</th><th className="col-pct">% Diff</th>
                      </tr></thead>
                      <tbody>
                        {layers.map((l, i) => (
                          <tr key={i}>
                            <td className="col-layer"><span className={`np-layer-num-badge np-layer-num-badge--${l.layer}`}>{l.layer}</span></td><td className="col-limit">{fmtC(l.limit)}</td><td className="col-deductible">{fmtC(l.deductible)}</td>
                            <td>{(() => {
                              // Concatenate: numReinstatements @ reinstatementPct%
                              // e.g. "2@100%" means 2 reinstatements each at 100% of original premium
                              const n = String(l.noReinst ?? l.num_reinstatements ?? '').trim();
                              const pRaw = l.reinstPct ?? l.reinstatement_pct ?? '';
                              const p = String(pRaw ?? '').replace(/%/g, '').trim();
                              const nNum = parseInt(n, 10);
                              if (!n || !nNum || nNum <= 0) return '–';
                              const pNum = parseFloat(p);
                              if (!Number.isFinite(pNum)) return n;  // just show count if no %
                              return `${nNum}@${pNum.toFixed(0)}%`;
                            })()}</td>
                            <td className="col-reinsurer"><input className="np-mini-input np-mini-input--reinsurer" value={l.reinsurerPricing} onChange={e => updateLayer(i, 'reinsurerPricing', e.target.value)} /></td>
                            <td className="col-lead"><input className="np-mini-input np-mini-input--lead" value={l.leadPricing} onChange={e => updateLayer(i, 'leadPricing', e.target.value)} /></td>
                            <td className="col-expiring"><input className="np-mini-input np-mini-input--expiring" value={l.expiringPricing} onChange={e => updateLayer(i, 'expiringPricing', e.target.value)} /></td>
                            <td className="muted">{l.historicalMargin || '–'}</td>
                            <td className="muted">{l.reinsurerMargin || '–'}</td>
                            <td className="muted">{l.technicalRatio || '–'}</td>
                            <td>{(() => {
                              const rp = toN(l.reinsurerPricing);
                              const lp = toN(l.leadPricing);
                              if (!rp || !lp) return <span className="muted">–</span>;
                              const diff = ((rp / lp) - 1) * 100;
                              const sign = diff >= 0 ? '+' : '';
                              const cls = diff > 0 ? 'np-pct-diff--pos' : 'np-pct-diff--neg';
                              return <span className={cls}>{`${sign}${diff.toFixed(2)}%`}</span>;
                            })()}</td>
                          </tr>
                        ))}
                        <tr className="np-struct-total">
                          <td className="col-layer"><span className="np-layer-num-badge np-layer-num-badge--total">TOTAL</span></td>
                          <td className="col-limit"><b>{fmtC(layers.reduce((s, l) => s + toN(l.limit), 0))}</b></td>
                          <td className="col-deductible"></td>
                          <td></td>
                          {(() => {
                            const totalLim = layers.reduce((s, l) => s + toN(l.limit), 0);
                            if (!totalLim) return <><td></td><td></td><td></td><td></td><td></td><td></td><td></td></>;
                            const sp = f => layers.reduce((s, l) => s + toN(l.limit) * toN(l[f]), 0) / totalLim;
                            const wtdReins = sp('reinsurerPricing');
                            const wtdLead  = sp('leadPricing');
                            const wtdExp   = sp('expiringPricing');
                            // Hist margin weighted by premium (reinsurerPricing × limit)
                            const totalPrem = layers.reduce((s, l) => s + toN(l.limit) * toN(l.reinsurerPricing), 0);
                            const wtdHist  = totalPrem > 0
                              ? layers.reduce((s, l) => s + toN(l.limit) * toN(l.reinsurerPricing) * toN(l.historicalMargin), 0) / totalPrem
                              : 0;
                            // Tech ratio total = 1 − wtdHist − brokerage − taxes
                            const brokN  = toN(npDetail.brokeragePct);
                            const taxesN = toN(npDetail.taxesPct);
                            const wtdTech  = wtdHist !== 0 ? Math.max(0, 100 - wtdHist - brokN - taxesN) : 0;
                            const pctDiff  = wtdReins > 0 && wtdLead > 0 ? ((wtdReins / wtdLead) - 1) * 100 : null;
                            const fmt1 = v => v.toFixed(2) + '%';
                            const diffCls = pctDiff > 0 ? 'np-pct-diff--pos' : 'np-pct-diff--neg';
                            return (<>
                              <td className="col-pct col-reinsurer"><b>{wtdReins > 0 ? fmt1(wtdReins) : '–'}</b></td>
                              <td className="col-pct col-lead"><b>{wtdLead  > 0 ? fmt1(wtdLead)  : '–'}</b></td>
                              <td className="col-pct col-expiring"><b>{wtdExp   > 0 ? fmt1(wtdExp)   : '–'}</b></td>
                              <td><b>{wtdHist  !== 0 ? fmt1(wtdHist)  : '–'}</b></td>
                              <td><b>{(() => {
                                const wtdMargin = totalPrem > 0
                                  ? layers.reduce((s, l) => s + toN(l.limit) * toN(l.reinsurerPricing) * toN(l.reinsurerMargin), 0) / totalPrem
                                  : 0;
                                return wtdMargin !== 0 ? fmt1(wtdMargin) : '–';
                              })()}</b></td>
                              <td><b>{wtdTech  !== 0 ? fmt1(wtdTech)  : '–'}</b></td>
                              <td>{pctDiff !== null ? <span className={diffCls}><b>{`${pctDiff >= 0 ? '+' : ''}${pctDiff.toFixed(2)}%`}</b></span> : '–'}</td>
                            </>);
                          })()}
                        </tr>
                      </tbody>
                    </table>
                  </div>
                </div>
              </section>

              {/* ═══════ PROGRAMME LIMITS ═══════ */}
              {!isQuote && (() => {
                // Source structure layers for per-layer earned premium, reinstatements, peril
                const srcLayers = localStructureLayers.length ? localStructureLayers : structureLayers;
                // cedantProgLimit = server-computed: sum of effective limits across all
                // same-cedant same-COB NP contracts. Loaded on mount.

                // Pre-compute programme totals from the pricing layers[] which have merged
                // structure data (egnpi, rate, earnedPremium, limit, risk, cat) already applied.
                // Using layers[] avoids srcLayers index-mismatch when structure and pricing
                // have different layer counts.

                // Layer EP: earned_premium if set, else EGNPI × rate / 100
                const layerEP = (l, sl) => {
                  const ep = toN(l.earnedPremium) || toN(sl.earnedPremium) || toN(sl.earned_premium) || 0;
                  if (ep > 0) return ep;
                  const egnpi = toN(l.egnpi) || toN(sl.egnpi) || 0;
                  const rate  = toN(l.rate)  || toN(sl.rate)  || 0;
                  return (egnpi > 0 && rate > 0) ? Math.round(egnpi * rate / 100) : 0;
                };

                // Total earned premium across ALL layers (share × this = premium per row)
                const totalEP = layers.reduce((s, l, i) => {
                  const sl = srcLayers[i] || {};
                  return s + layerEP(l, sl);
                }, 0);

                // Total limit for all Risk-covering layers
                const totalRiskLimit = layers.reduce((s, l, i) => {
                  const sl  = srcLayers[i] || {};
                  const isR = sl.riskCover ?? sl.risk ?? l.riskCover ?? l.risk ?? true;
                  return s + (isR ? (toN(sl.limit) || toN(l.limit) || 0) : 0);
                }, 0);

                // Total limit for all Cat-covering layers
                const totalCatLimit = layers.reduce((s, l, i) => {
                  const sl  = srcLayers[i] || {};
                  const isC = sl.catCover ?? sl.cat ?? l.catCover ?? l.cat ?? true;
                  return s + (isC ? (toN(sl.limit) || toN(l.limit) || 0) : 0);
                }, 0);

                const rowCalc = (l, i) => {
                  const sl       = srcLayers[i] || {};
                  const sharePct = toN(l.share);   // e.g. 10.00 means 10%
                  const shareFrac= sharePct / 100;
                  // Prefer layers[] (merged) for limit, then srcLayers
                  const lim      = toN(l.limit) || toN(sl.limit) || toN(sl.layer_limit) || 0;

                  // Premium: share × total programme earned premium (all layers)
                  const prem = shareFrac > 0 && totalEP > 0 ? Math.round(totalEP * shareFrac) : 0;

                  // Per Risk Limit: share × total limit of ALL risk-covering layers
                  const perRisk = shareFrac > 0 && totalRiskLimit > 0 ? Math.round(totalRiskLimit * shareFrac) : 0;

                  // Cat Limit: share × total limit of ALL cat-covering layers
                  const catLim = shareFrac > 0 && totalCatLimit > 0 ? Math.round(totalCatLimit * shareFrac) : 0;

                  // Cedant Total Limit:
                  // Server returns totalLimit = sum of (effective_line_pct/100 × structure_limit)
                  // across ALL contracts for this cedant with overlapping COBs.
                  // Per row: share% × totalLimit (same formula as premium/perRisk/catLim)
                  const cedantTot = shareFrac > 0 && cedantProgLimit > 0
                    ? Math.round(cedantProgLimit * shareFrac) : 0;

                  // Annual Aggregate Limit: from structure if set, else limit×(1+reinstatements)×share
                  const structAAL = toN(l.annualAggLimit) || toN(sl.annualAggLimit) || toN(sl.aggregate_limit) || 0;
                  const noReinst  = toN(l.noReinst) || toN(sl.noReinst) || toN(sl.reinstatements) || toN(sl.num_reinstatements) || 0;
                  const aal = shareFrac > 0
                    ? (structAAL > 0
                        ? Math.round(structAAL * shareFrac)
                        : Math.round(lim * (1 + noReinst) * shareFrac))
                    : 0;

                  // Expected Shortfall: standard XL ES = ROL% × Limit × (1 + 0.5×noReinst) × share
                  // Approximates average loss given exhaustion (50% chance of using reinstatements)
                  const rolPct = toN(l.reinsurerPricing) || toN(l.leadPricing);
                  const es = shareFrac > 0 && rolPct > 0 && lim > 0
                    ? Math.round(lim * (rolPct / 100) * (1 + 0.5 * noReinst) * shareFrac) : 0;

                  return { prem, perRisk, catLim, cedantTot, aal, es, shareFrac };
                };

                const totals = layers.reduce((acc, l, i) => {
                  const r = rowCalc(l, i);
                  return {
                    prem:      acc.prem      + r.prem,
                    perRisk:   acc.perRisk   + r.perRisk,
                    catLim:    acc.catLim    + r.catLim,
                    cedantTot: acc.cedantTot + r.cedantTot,
                    aal:       acc.aal       + r.aal,
                  };
                }, { prem: 0, perRisk: 0, catLim: 0, cedantTot: 0, aal: 0 });

                const fmtV = v => v > 0 ? v.toLocaleString() : '–';
                const cTd  = { textAlign: 'center', fontVariantNumeric: 'tabular-nums' };
                const roInp = (val, placeholder) => (
                  <input className="np-mini-input np-mini-input--center np-mini-input--readonly"
                    style={{ width: '100%', minWidth: 90 }} readOnly
                    value={val > 0 ? val.toLocaleString() : ''} placeholder={placeholder || '–'} />
                );
                const shareInp = (val, idx) => (
                  <PctInput
                    key={`share-${idx}`}
                    className="np-mini-input np-mini-input--center"
                    style={{ width: '100%', minWidth: 60, maxWidth: 80 }}
                    value={val}
                    placeholder="0%"
                    readOnly={isTerminal}
                    onChange={v => updateLayer(idx, 'share', v)}
                  />
                );

                return (
                  <section className="np-final-section">
                    <div className="np-final-section-head" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
                      <div className="np-final-section-title">Programme Limits</div>
                      <div className="view-tabs" role="tablist" aria-label="Programme limits view">
                        {[['limits','LIMITS'],['optimal','OPTIMAL SHARES']].map(([k,label]) => (
                          <button
                            key={k}
                            type="button"
                            className={`view-tab${progLimView === k ? ' is-active' : ''}`}
                            role="tab"
                            aria-selected={progLimView === k}
                            onClick={() => setProgLimView(k)}
                          >
                            {label}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div className="np-final-card np-final-card--flush">
                      <div style={{ padding: '7px 14px', fontSize: 10, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: 'rgba(226,232,240,0.35)', borderBottom: '1px solid rgba(148,163,184,0.08)' }}>
                        Programme Limits &amp; Downside
                      </div>
                      <div className="np-final-table-wrap np-final-table-wrap--wide">
                        <table className="np-final-wide-table--programme">
                          <thead><tr>
                            <th className="col-layer"    style={{ textAlign: 'center' }}>Layer</th>
                            <th style={{ textAlign: 'center', minWidth: 70, maxWidth: 80 }}>Share</th>
                            <th className="col-compact"  style={{ textAlign: 'center' }}>Premium</th>
                            <th className="col-compact"  style={{ textAlign: 'center' }}>Per Risk Limit</th>
                            <th className="col-compact"  style={{ textAlign: 'center' }}>Cat Limit</th>
                            <th className="col-compact"  style={{ textAlign: 'center' }}>Cedant Total Limit</th>
                            <th className="col-compact"  style={{ textAlign: 'center' }}>Agg Contribution</th>
                            <th className="col-compact"  style={{ textAlign: 'center' }}>Total Country Agg</th>
                            <th className="col-compact"  style={{ textAlign: 'center' }}>Annual Aggregate Limit</th>
                            <th className="col-compact"  style={{ textAlign: 'center' }}>Expected Shortfall</th>
                          </tr></thead>
                          <tbody>
                            {layers.map((l, i) => {
                              const r = rowCalc(l, i);
                              return (
                                <tr key={i}>
                                  <td className="col-layer" style={{ textAlign: 'center' }}>{l.layer || `L${i+1}`}</td>
                                  <td style={{ ...cTd, padding: '4px 6px' }}>{shareInp(l.share, i)}</td>
                                  <td style={cTd}>{roInp(r.prem)}</td>
                                  <td style={cTd}>{roInp(r.perRisk)}</td>
                                  <td style={cTd}>{roInp(r.catLim)}</td>
                                  <td style={cTd}>{roInp(r.cedantTot)}</td>
                                  <td style={cTd}>{roInp(r.shareFrac > 0 && contractAgg100 > 0 ? Math.round(contractAgg100 * r.shareFrac) : 0)}</td>
                                  <td style={cTd}>{roInp(r.shareFrac > 0 ? Math.round(otherCountryAgg + contractAgg100 * r.shareFrac) : 0)}</td>
                                  <td style={cTd}>{roInp(r.aal)}</td>
                                  <td style={cTd}>{roInp(r.es)}</td>
                                </tr>
                              );
                            })}
                          </tbody>
                          <tfoot>
                            <tr className="np-struct-total">
                              <td style={{ textAlign: 'center' }}><b>Total</b></td>
                              <td></td>
                              <td style={{ textAlign: 'center' }}><b>{fmtV(totals.prem)}</b></td>
                              <td style={{ textAlign: 'center' }}><b>{fmtV(totals.perRisk)}</b></td>
                              <td style={{ textAlign: 'center' }}><b>{fmtV(totals.catLim)}</b></td>
                              <td style={{ textAlign: 'center' }}><b>{fmtV(totals.cedantTot)}</b></td>
                              <td></td>
                              <td></td>
                              <td style={{ textAlign: 'center' }}><b>{fmtV(totals.aal)}</b></td>
                              <td></td>
                            </tr>
                          </tfoot>
                        </table>
                      </div>
                    </div>
                  </section>
                );
              })()}

              </>)}

              {/* ═══════ OFFER / DECLINE BAR ═══════ */}
              <div className="np-bbg-decision-bar">
                <div className="np-bbg-decision-left">
                  <button
                    className="bbg-btn bbg-btn--save"
                    type="button"
                    onClick={async () => { const ok = await save(); showToast?.(ok ? 'Saved' : 'Save failed'); }}
                    disabled={saveState.status === 'saving'}
                  >
                    {saveState.status === 'saving' ? 'Saving...' : 'Save'}
                  </button>
                  <button
                    className="bbg-btn"
                    style={{ borderColor: 'rgba(34,197,94,0.5)', color: '#4ade80', display: 'flex', alignItems: 'center', gap: 6 }}
                    title="Export all pricing data to Excel"
                    onClick={() => {
                      const progRows = layers.map((l) => {
                        const r = (() => {
                          try {
                            const shareFrac = toN(l.share) / 100 || 0;
                            const prem = shareFrac > 0 ? Math.round(toN(l.egnpi) * toN(l.riskTotalPrice || l.catTotalPrice || '0') / 100 * shareFrac) : 0;
                            const perRisk = shareFrac > 0 ? Math.round(toN(l.limit) * shareFrac) : 0;
                            return { prem, perRisk, catLim: 0, cedantTot: 0, aggContrib: 0, totalCountryAgg: 0, aal: 0, es: 0 };
                          } catch { return {}; }
                        })();
                        return r;
                      });
                      exportNpPricingToExcel({
                        layers,
                        quoteStructures,
                        mode,
                        treatyTypeStr: npDetail?.treatyTypeName || npDetail?.treatyType || '',
                        cedantName: npDetail?.cedantName || '',
                        countryName: npDetail?.countryName || '',
                        uwYear: npDetail?.startYear || '',
                        currency,
                        isQuote,
                        totalROL: (() => {
                          const ep = layers.reduce((s,l) => s + (toN(l.earnedPremium)||0), 0);
                          const lim = layers.reduce((s,l) => s + (toN(l.limit)||0), 0);
                          return (ep > 0 && lim > 0) ? (ep / lim) * 100 : 0;
                        })(),
                        egnpi: npDetail?.estGnpi || npDetail?.est_gnpi || 0,
                        totalLimit: layers.reduce((s, l) => s + (toN(l.limit) || 0), 0),
                        programmeRows: progRows,
                      }).catch(e => console.error('Export failed:', e));
                    }}
                  >
                    ↓ Export Excel
                  </button>
                  {offerStatus && offerStatus !== 'DRAFT' && (
                    <span className={`bbg-status bbg-status--${offerStatus.toLowerCase()}`}>{offerStatus.replace(/_/g, ' ')}</span>
                  )}
                  {isTerminal && (
                    <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.4)', marginLeft: 8 }}>
                      Pricing locked — open offer modal to review.
                    </span>
                  )}
                </div>
                <div className="np-bbg-decision-right">
                  <button className="bbg-btn bbg-btn--offer"
                    onClick={() => setShowOfferModal(true)}>
                    {isTerminal ? 'View Offer' : offerStatus === 'AWAITING_APPROVAL' ? '⏳ Awaiting Approval' : offerStatus === 'AWAITING_SIGNED_LINE' ? '✍ Sign / NTU' : isQuote ? 'Submit Quotes' : 'Offer Treaty'}
                  </button>
                  {!isTerminal && (
                    <button className="bbg-btn bbg-btn--decline"
                      onClick={() => setShowDeclineModal(true)}>Decline</button>
                  )}
                </div>
              </div>

              {/* ═══════ TECHNICAL ANALYSIS MODAL ═══════ */}
              <NpTechAnalysisModal
                open={showTechAnalysisModal}
                onClose={() => setShowTechAnalysisModal(false)}
                treatyMetrics={treatyMetrics}
                setTreatyMetrics={setTreatyMetrics}
                expiringEgnpi={expiringEgnpi}
                npDetail={npDetail}
                cobUwLimits={cobUwLimits}
              />


              <NpReinsurerModal
                open={showReinsurerModal}
                onClose={() => setShowReinsurerModal(false)}
                layers={layers}
                leadSetup={leadSetup}
                updateLeadSetup={updateLeadSetup}
                reinsurers={reinsurers}
                onSave={save}
              />

              {/* ═══════════════════════════════════════════
                   FULL OFFER MODAL — LAYER LINES + WORKFLOW
                  ═══════════════════════════════════════════ */}
              {showOfferModal && (() => {
                const toN = v => { const x = parseFloat(String(v ?? '').replace(/[^0-9.-]/g, '')); return Number.isFinite(x) ? x : 0; };
                const money = n => n > 0 ? `${currency} ${Math.round(n).toLocaleString()}` : '—';
                const stepIndex = offerStatus === 'DRAFT' ? 0 : offerStatus === 'AWAITING_APPROVAL' ? 1 : offerStatus === 'AWAITING_SIGNED_LINE' ? 2 : 3;
                const steps = [
                  { k: 'Draft' }, { k: 'Awaiting Approval' },
                  { k: 'Awaiting Signed Line' },
                  { k: offerStatus === 'NTU' ? 'NTU' : 'Signed / Complete' },
                ];

                // Per-layer computations
                const layerData = layers.map((l, i) => {
                  const limit   = toN(l.limit);
                  const attach  = toN(l.deductible ?? l.attachment);
                  const egnpi   = toN(l.egnpi);
                  const rolPct  = toN(l.uwPrice) || toN(l.totalPrice);
                  const ep100   = rolPct > 0 && limit > 0 ? limit * rolPct / 100 : toN(l.earnedPremium) || toN(l.ep);
                  const wlRaw   = String(layerWrittenLines[i] || '').replace(/%/g, '').trim();
                  const wlNum   = parseFloat(wlRaw); // e.g. 2.5 means 2.5%
                  const wlFrac  = Number.isFinite(wlNum) ? wlNum / 100 : 0;
                  const linePrem = wlFrac > 0 ? Math.round(ep100 * wlFrac)   : 0;
                  const lineLimit = wlFrac > 0 ? Math.round(limit  * wlFrac)  : 0;
                  const isRisk  = l.riskCover || l.risk;
                  const isCat   = l.catCover  || l.cat;
                  const peril   = isRisk && isCat ? 'BOTH' : isRisk ? 'RISK' : isCat ? 'CAT' : '—';
                  const perilColor = isRisk && isCat ? '#a78bfa' : isRisk ? '#38bdf8' : isCat ? '#00d4ff' : 'rgba(255,255,255,0.3)';
                  // Signed line
                  const slRaw   = String(signedLinePcts[i] || '').replace(/%/g, '').trim();
                  const slNum   = parseFloat(slRaw);
                  const slFrac  = Number.isFinite(slNum) ? slNum / 100 : 0;
                  const sLinePrem  = slFrac > 0 ? Math.round(ep100  * slFrac) : 0;
                  const sLineLimit = slFrac > 0 ? Math.round(limit * slFrac)  : 0;
                  const sOver   = slFrac > 0 && wlFrac > 0 && slFrac > wlFrac;
                  return { layer: l.layer || `L${i+1}`, limit, attach, egnpi, ep100, rolPct, wlRaw, wlNum, wlFrac, linePrem, lineLimit, peril, perilColor, slRaw, slNum, slFrac, sLinePrem, sLineLimit, sOver, isRisk, isCat };
                });

                const hasApprovedQuoteStructure = isQuote && approvedStructures.some(Boolean);
                const hasAnyWritten  = isQuote
                  ? hasApprovedQuoteStructure
                  : layerData.some(r => r.wlFrac > 0);
                const hasAnySigned   = layerData.some(r => r.slFrac > 0);
                const anyOverSigned  = layerData.some(r => r.sOver);
                const totalLinePrem  = layerData.reduce((s, r) => s + r.linePrem, 0);

                return (
                  <div className="bbg-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setShowOfferModal(false); }}>
                    <div className="bbg-modal bbg-modal--fullscreen off-modal">

                      {/* ── HEADER ── */}
                      <div className="bbg-modal-head" style={{ flexShrink: 0 }}>
                        <span className="bbg-modal-title">
                          {isCU && offerStatus === 'AWAITING_APPROVAL' ? '🔐 Chief Underwriter Review' : 'Offer Treaty'}
                        </span>
                        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                          <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)' }}>
                            Viewing as <b style={{ color: 'rgba(255,255,255,0.65)' }}>{actorName}</b>
                          </span>
                          <span className={`bbg-status bbg-status--${(offerStatus || 'draft').toLowerCase()}`}>
                            {(offerStatus || 'DRAFT').replace(/_/g, ' ')}
                          </span>
                          <button className="bbg-modal-x" onClick={() => setShowOfferModal(false)}>✕</button>
                        </div>
                      </div>

                      <div className="bbg-modal-body" style={{ overflowY: 'auto', flex: '1 1 0', minHeight: 0, padding: '20px 24px' }}>

                        {/* ── STEPPER ── */}
                        <div className="off-steps" style={{ marginBottom: 20 }}>
                          {steps.map((s, i) => {
                            const isDone = i < stepIndex, isActive = i === stepIndex;
                            return (
                              <div key={i} className={`off-step${isDone ? ' done-line' : ''}`}>
                                <div className={`off-step-dot ${isDone ? 'done' : isActive ? 'active' : ''}`}>{isDone ? '✓' : i + 1}</div>
                                <div className={`off-step-label ${isActive ? 'active' : ''}`}>{s.k}</div>
                              </div>
                            );
                          })}
                        </div>

                        {/* ── TREATY SUMMARY STRIP ── */}
                        <div style={{
                          display: 'flex', alignItems: 'stretch', gap: 0,
                          background: 'rgba(255,255,255,0.025)', border: '1px solid rgba(255,255,255,0.07)',
                          borderRadius: 10, overflow: 'hidden', marginBottom: 20,
                        }}>
                          {[
                            { k: 'Cedant',      v: snap.cedant     },
                            { k: 'Treaty Type', v: snap.treatyType  },
                            { k: 'COB',         v: snap.cob        },
                            { k: 'XL Type',     v: snap.xlType     },
                            { k: 'Layers',      v: layers.length   },
                            { k: 'EGNPI',       v: money(toN(npDetail.estGnpi)) },
                          ].map((item, idx, arr) => (
                            <div key={item.k} style={{
                              flex: 1, padding: '10px 16px',
                              borderRight: idx < arr.length - 1 ? '1px solid rgba(255,255,255,0.06)' : 'none',
                            }}>
                              <div style={{ fontSize: 9, fontWeight: 700, letterSpacing: '.12em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.32)', marginBottom: 4 }}>{item.k}</div>
                              <div style={{ fontSize: 13, fontWeight: 700, color: '#e2e8f0', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{item.v || '—'}</div>
                            </div>
                          ))}
                        </div>


                        {/* ── AI + CLASSIFIER ── */}
                        <div style={{ marginBottom: 20 }}>
                        {(() => {
                          const egnpiBlock = toN(npDetail.estGnpi);
                          const totLimB    = layerData.reduce((s,r) => s+r.limit, 0);
                          const rolLayersB = layerData.filter(r => r.rolPct > 0);
                          const avgRolB    = rolLayersB.length ? rolLayersB.reduce((s,r) => s+r.rolPct,0)/rolLayersB.length : 0;
                          const techRB     = techRatioAvg / 100;
                          const mActB      = avgRolB > 0 && techRB > 0 ? Math.max(0,(avgRolB/100)-techRB) : 0;
                          const balRatioB  = egnpiBlock > 0 ? totLimB/egnpiBlock : 0;
                          const premScoreB = Math.min(100,Math.round((Math.min(balRatioB,80)/80)*50+(totLimB>0?Math.min(totLimB/5_000_000_000,1)*50:0)));
                          const margScoreB = Math.min(100,Math.round((Math.max(0,Math.min(mActB,0.5))/0.5)*60+(Math.max(0,0.7-techRB)/0.7)*40));
                          const heatLabel  = premScoreB>65&&margScoreB>65?'Premium & Margin Driver':premScoreB>65?'Premium Driver':margScoreB>65?'Margin Driver':'Balanced';
                          const heatColor  = premScoreB>65&&margScoreB>65?'#a78bfa':premScoreB>65?'#38bdf8':margScoreB>65?'#4ade80':'#94a3b8';
                          const mQB = Math.max(0,Math.min(1,mActB/0.3));
                          const bQB = Math.max(0,Math.min(1,balRatioB/60));
                          const aiLinePctB = Math.max(1,Math.min(20,Math.round((mQB*0.6+bQB*0.4)*20*10)/10||10));
                          const aiReasonB  = mActB>=0.15?`Strong margin (${(mActB*100).toFixed(1)}%) — full line supportable.`:mActB>=0.08?`Acceptable margin (${(mActB*100).toFixed(1)}%) — moderate line.`:techRB>0?`Thin margin (${(mActB*100).toFixed(1)}%) — conservative line advised.`:'Run pricing engine to generate suggestion.';
                          return (
                            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:12, flexShrink:0 }}>
                              <div className="off-ai">
                                <div className="off-ai-head">
                                  <div className="off-ai-label">✦ AI Suggested Line Size</div>
                                  {!isTerminal&&<button className="off-ai-apply" type="button" onClick={()=>{const n={};layers.forEach((_,i)=>n[i]=String(aiLinePctB));setLayerWrittenLines(n);}}>Apply to all →</button>}
                                </div>
                                <div className="off-ai-number">
                                  <div className="off-ai-pct">{aiLinePctB.toFixed(1)}</div>
                                  <div className="off-ai-unit">%</div>
                                </div>
                                <div className="off-ai-reason" style={{margin:'6px 0',fontSize:11}}>{aiReasonB}</div>
                                <div className="off-ai-econ">
                                  <div className="off-ai-econ-item"><span className="off-ai-econ-k">Avg ROL</span><span className="off-ai-econ-v">{avgRolB>0?avgRolB.toFixed(2)+'%':'—'}</span></div>
                                  <div className="off-ai-econ-item"><span className="off-ai-econ-k">Tech Ratio</span><span className="off-ai-econ-v">{techRatioAvg>0?techRatioAvg.toFixed(2)+'%':'—'}</span></div>
                                  <div className="off-ai-econ-item"><span className="off-ai-econ-k">Margin</span><span className="off-ai-econ-v" style={{color:mActB>=0.08?'#4ade80':mActB>0?'#00d4ff':'#f87171'}}>{mActB>0?(mActB*100).toFixed(1)+'%':'—'}</span></div>
                                </div>
                              </div>
                              <div className="off-hm-wrap">
                                <div className="off-hm-title">Treaty Classification</div>
                                <div className="off-hm-matrix">
                                  <div className="off-hm-axlabel"></div>
                                  <div className="off-hm-axlabel">LOW MARGIN</div>
                                  <div className="off-hm-axlabel">HIGH MARGIN</div>
                                  <div className="off-hm-axlabel vert">HIGH PREM</div>
                                  <div className={`off-hm-cell off-hm-c-blue ${premScoreB>65&&margScoreB<=65?'off-hm-active':''}`}><span className="off-hm-cell-name">Premium<br/>Driver</span><span className="off-hm-cell-sub">Bulk volume,<br/>thin margin</span></div>
                                  <div className={`off-hm-cell off-hm-c-purple ${premScoreB>65&&margScoreB>65?'off-hm-active':''}`}><span className="off-hm-cell-name">Premium &amp;<br/>Margin Driver</span><span className="off-hm-cell-sub">Best of both</span></div>
                                  <div className="off-hm-axlabel vert">LOW PREM</div>
                                  <div className={`off-hm-cell off-hm-c-slate ${premScoreB<=65&&margScoreB<=65?'off-hm-active':''}`}><span className="off-hm-cell-name">Balanced</span><span className="off-hm-cell-sub">Average<br/>profile</span></div>
                                  <div className={`off-hm-cell off-hm-c-green ${premScoreB<=65&&margScoreB>65?'off-hm-active':''}`}><span className="off-hm-cell-name">Margin<br/>Driver</span><span className="off-hm-cell-sub">High quality,<br/>lower volume</span></div>
                                </div>
                                <div className="off-hm-scores">
                                  <div className="off-hm-score-item">Premium Score <b style={{color:'#38bdf8'}}>{premScoreB}/100</b></div>
                                  <div className="off-hm-score-item">Margin Score <b style={{color:'#4ade80'}}>{margScoreB}/100</b></div>
                                  <div className="off-hm-score-item">Classification <b style={{color:heatColor}}>{heatLabel}</b></div>
                                </div>
                              </div>
                            </div>
                          );
                        })()}
                        </div>

                        {/* ── PER-LAYER TABLE ── */}
                        <div style={{ marginBottom: 20 }}>
                        {(() => {
                          const egnpiTotal = toN(npDetail.estGnpi);
                          const totLim     = layerData.reduce((s,r) => s + r.limit, 0);
                          const rolLayers  = layerData.filter(r => r.rolPct > 0);
                          const avgRol     = rolLayers.length ? rolLayers.reduce((s,r) => s+r.rolPct,0)/rolLayers.length : 0;
                          const techR      = techRatioAvg / 100;
                          const mAct       = avgRol > 0 && techR > 0 ? Math.max(0,(avgRol/100)-techR) : 0;
                          const balRatio   = egnpiTotal > 0 ? totLim/egnpiTotal : 0;
                          const mQ = Math.max(0,Math.min(1,mAct/0.3));
                          const bQ = Math.max(0,Math.min(1,balRatio/60));
                          const aiLinePct  = Math.max(1,Math.min(20,Math.round((mQ*0.6+bQ*0.4)*20*10)/10 || 10));
                          const isApproved = offerStatus === 'AWAITING_SIGNED_LINE';
                          const th = { padding:'7px 10px', fontSize:9, fontWeight:700, letterSpacing:'.10em',
                            textTransform:'uppercase', color:'rgba(255,255,255,0.35)', whiteSpace:'nowrap',
                            borderBottom:'1px solid rgba(255,255,255,0.08)', textAlign:'right' };
                          const thC = {...th, textAlign:'center'};
                          return (
                            <div className="off-card" style={{ padding:0, overflow:'hidden' }}>
                              <div style={{ overflowX:'auto' }}>
                                <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                                  <thead>
                                    <tr>
                                      <th style={{...thC}}>Layer</th>
                                      <th style={{...th,color:'#00d4ff',textAlign:'center',minWidth:88}}>Written %</th>
                                      <th style={{...th}}>Limit</th>
                                      <th style={{...th}}>Premium</th>
                                      <th style={{...th,color:'#00d4ff'}}>ROL %</th>
                                      <th style={{...th,color:'#a78bfa'}}>Tech Ratio</th>
                                      <th style={{...th,color:'rgba(0,232,184,0.8)',textAlign:'center'}}>
                                        <div>✦ AI Line</div>
                                        {!isTerminal&&<button onClick={()=>{const n={};layerData.forEach((_,i)=>n[i]=String(aiLinePct));setLayerWrittenLines(n);}} style={{fontSize:8,padding:'1px 6px',borderRadius:8,border:'1px solid rgba(0,232,184,0.3)',background:'rgba(0,232,184,0.07)',color:'rgba(0,232,184,0.7)',cursor:'pointer',fontWeight:700,marginTop:2}}>apply all</button>}
                                      </th>
                                      <th style={{...th,color: isApproved?'#60a5fa':'rgba(255,255,255,0.2)',textAlign:'center',minWidth:90}}>
                                        Signed %{!isApproved&&<span style={{fontSize:8,display:'block',color:'rgba(255,255,255,0.2)',fontWeight:400,letterSpacing:0}}>unlocks on approval</span>}
                                      </th>
                                    </tr>
                                  </thead>
                                  <tbody>
                                    {layerData.map((r,i) => {
                                      const techPct = parseFloat(String(layers[i]?.technicalRatio||layers[i]?.techRatio||'').replace(/%/g,'')) || 0;
                                      const wlVal   = String(layerWrittenLines[i]||'').replace(/%/g,'').trim();
                                      const slVal   = String(signedLinePcts[i]||'').replace(/%/g,'').trim();
                                      const inpBase = { width:'100%', boxSizing:'border-box', borderRadius:6,
                                        border:'1px solid rgba(255,255,255,0.14)', background:'rgba(255,255,255,0.05)',
                                        color:'#fff', padding:'5px 8px', fontSize:12, fontWeight:700,
                                        fontFamily:'inherit', textAlign:'center', outline:'none' };
                                      return (
                                        <tr key={i} style={{ borderBottom:'1px solid rgba(255,255,255,0.05)', background: i%2?'rgba(255,255,255,0.01)':'transparent' }}>
                                          <td style={{ padding:'8px 10px', textAlign:'center', fontWeight:800, color:'#00d4ff' }}>{r.layer}</td>
                                          <td style={{ padding:'4px 6px', textAlign:'center' }}>
                                            <PctInput
                                              className=""
                                              style={{...inpBase, border:`1px solid ${wlVal?'rgba(0,212,255,0.4)':'rgba(255,255,255,0.10)'}`, width:72, opacity:isTerminal?0.5:1}}
                                              value={wlVal} readOnly={isTerminal} placeholder="0%"
                                              onChange={v=>setLayerWrittenLines(p=>({...p,[i]:v}))}
                                              onBlur={()=>{const n=parseFloat(String(layerWrittenLines[i]||'').replace(/%/g,'').trim());const v=Number.isFinite(n)?Math.min(100,Math.max(0,n)):'';setLayerWrittenLines(p=>({...p,[i]:v===''?'':String(v)}));}}
                                            />
                                          </td>
                                          <td style={{ padding:'8px 10px', textAlign:'right', color:'rgba(255,255,255,0.7)', fontVariantNumeric:'tabular-nums' }}>{r.limit>0?fmtC(r.limit):'—'}</td>
                                          <td style={{ padding:'8px 10px', textAlign:'right', color:'rgba(255,255,255,0.7)', fontVariantNumeric:'tabular-nums' }}>{r.ep100>0?fmtC(Math.round(r.ep100)):'—'}</td>
                                          <td style={{ padding:'8px 10px', textAlign:'right', color:'#00d4ff', fontWeight:700 }}>{r.rolPct>0?r.rolPct.toFixed(2)+'%':'—'}</td>
                                          <td style={{ padding:'8px 10px', textAlign:'right', color: techPct>0?(techPct<=r.rolPct?'#4ade80':'#f87171'):'rgba(255,255,255,0.4)', fontWeight:700 }}>{techPct>0?techPct.toFixed(2)+'%':'—'}</td>
                                          <td style={{ padding:'8px 10px', textAlign:'right', color:'rgba(0,232,184,0.85)', fontWeight:800 }}>
                                            {!isTerminal && (
                                              <button onClick={()=>setLayerWrittenLines(p=>({...p,[i]:String(aiLinePct)}))}
                                                style={{ fontSize:10, padding:'2px 8px', borderRadius:10, border:'1px solid rgba(0,232,184,0.35)', background:'rgba(0,232,184,0.08)', color:'rgba(0,232,184,0.85)', cursor:'pointer', fontWeight:700, whiteSpace:'nowrap' }}>
                                                {aiLinePct.toFixed(1)}% →
                                              </button>
                                            )}
                                            {isTerminal && <span>{aiLinePct.toFixed(1)}%</span>}
                                          </td>
                                          <td style={{ padding:'4px 6px' }}>
                                            <PctInput
                                              className=""
                                              style={{...inpBase,
                                                border:`1px solid ${isApproved?(slVal?(r.sOver?'rgba(248,113,113,0.6)':'rgba(96,165,250,0.5)'):'rgba(96,165,250,0.25)'):'rgba(255,255,255,0.07)'}`,
                                                background: isApproved?'rgba(96,165,250,0.07)':'rgba(255,255,255,0.02)',
                                                opacity: isApproved?1:0.35, cursor: isApproved?'text':'not-allowed'}}
                                              value={slVal} readOnly={!isApproved||isTerminal}
                                              placeholder={isApproved?'0.0%':'—'}
                                              onChange={v=>{if(isApproved)setSignedLinePcts(p=>({...p,[i]:v}));}}
                                            />
                                            {r.sOver && isApproved && <div style={{fontSize:9,color:'#f87171',textAlign:'center'}}>exceeds written</div>}
                                          </td>
                                        </tr>
                                      );
                                    })}
                                  </tbody>
                                  {layerData.length > 1 && (
                                    <tfoot>
                                      <tr style={{ borderTop:'2px solid rgba(255,255,255,0.12)', background:'rgba(255,255,255,0.04)' }}>
                                        <td colSpan={3} style={{ padding:'8px 10px', fontWeight:800, fontSize:11, color:'rgba(255,255,255,0.5)', letterSpacing:'.06em', textTransform:'uppercase' }}>TOTAL</td>
                                        <td style={{ padding:'8px 10px', textAlign:'right', fontWeight:700, color:'rgba(255,255,255,0.7)', fontVariantNumeric:'tabular-nums' }}>{totalLinePrem>0?fmtC(totalLinePrem):'—'}</td>
                                        <td colSpan={4}/>
                                      </tr>
                                    </tfoot>
                                  )}
                                </table>
                              </div>
                            </div>
                          );
                        })()}
                        </div>

                        {/* ── WORKFLOW CARDS ── */}
                        <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr', gap:14, alignItems:'start' }}>

                          {/* ── DRAFT: Submit for Approval ── */}
                          {!isCU && !isTerminal && offerStatus === 'DRAFT' && (
                            <div className="off-card" style={{ border:'1px solid rgba(0,212,255,0.22)', background:'rgba(0,212,255,0.03)' }}>
                              <div className="off-card-title" style={{ color:'rgba(0,212,255,0.85)' }}>Submit For Approval</div>
                              <div style={{ marginBottom:12 }}>
                                <div style={{ fontSize:10, fontWeight:700, letterSpacing:'.10em', textTransform:'uppercase', color:'rgba(255,255,255,0.32)', marginBottom:6 }}>Send to</div>
                                <select value={offerApprover} onChange={e=>setOfferApprover(e.target.value)}
                                  style={{ width:'100%', boxSizing:'border-box', background:'rgba(255,255,255,0.05)', border:'1px solid rgba(0,212,255,0.32)', borderRadius:8, color:offerApprover?'#fff':'rgba(255,255,255,0.32)', padding:'9px 12px', fontSize:13, fontFamily:'inherit', outline:'none', cursor:'pointer' }}>
                                  <option value="">Select approver…</option>
                                  {(eligibleApprovers||[]).map(a=><option key={a.user_id} value={a.user_id} style={{background:'#0b1526'}}>{a.role_name}</option>)}
                                </select>
                              </div>
                              <div style={{ marginBottom:14 }}>
                                <div style={{ fontSize:10, fontWeight:700, letterSpacing:'.10em', textTransform:'uppercase', color:'rgba(255,255,255,0.32)', marginBottom:6 }}>Offer Note</div>
                                <textarea className="bbg-textarea" rows={2} value={offerComment} onChange={e=>setOfferComment(e.target.value)}
                                  placeholder="Optional note to the approver…" style={{ width:'100%', boxSizing:'border-box', resize:'vertical' }}/>
                              </div>
                              <button className="bbg-btn bbg-btn--offer" style={{ width:'100%', justifyContent:'center', opacity:(!offerApprover||!hasAnyWritten)?0.42:1 }} onClick={doSubmitForApproval}>
                                Submit for Approval →
                              </button>
                              {!offerApprover && <div style={{ fontSize:11, color:'rgba(255,255,255,0.32)', marginTop:6, textAlign:'center' }}>Select an approver to proceed</div>}
                              {offerApprover && !hasAnyWritten && (
                                <div style={{ fontSize:11, color:'#00d4ff', marginTop:6, textAlign:'center' }}>
                                  {isQuote ? 'Select at least one structure for approval first' : '⚠ Enter at least one written line first'}
                                </div>
                              )}
                            </div>
                          )}

                          {/* ── AWAITING APPROVAL: UW waiting view + Recall ── */}
                          {!isCU && !isTerminal && offerStatus === 'AWAITING_APPROVAL' && (
                            <div className="off-card" style={{ border:'1px solid rgba(96,165,250,0.22)', background:'rgba(96,165,250,0.04)', textAlign:'center', padding:'20px 16px' }}>
                              <div style={{ fontSize:24, marginBottom:8 }}>⏳</div>
                              <div style={{ fontSize:13, fontWeight:700, color:'#60a5fa', marginBottom:5 }}>Awaiting CU Review</div>
                              <div style={{ fontSize:11, color:'rgba(255,255,255,0.38)', marginBottom:14 }}>
                                Submitted to <b style={{ color:'rgba(255,255,255,0.6)' }}>{(eligibleApprovers.find(a=>a.user_id===offerApprover)?.role_name)||'approver'}</b>
                              </div>
                              <button className="bbg-btn" style={{ borderColor:'rgba(0,212,255,0.45)', color:'#00d4ff' }}
                                onClick={async ()=>{if(window.confirm('Recall this submission? The contract will return to Draft.')){try{await api.recallOffer(contractId,{reason:'Recalled by underwriter',_actor:actorName},quoteMode?{quote:true}:undefined);}catch(e){showToast('Recall failed: '+(e?.message||'Server error'));return;}setOfferStatus('DRAFT');}}}>
                                ↩ Recall
                              </button>
                            </div>
                          )}

                          {/* ── CU: Decision card ── */}
                          {isCU && offerStatus === 'AWAITING_APPROVAL' && (
                            <div className="off-card" style={{ border:'1px solid rgba(0,212,255,0.28)', background:'rgba(0,212,255,0.04)' }}>
                              <div className="off-card-title" style={{ color:'#00d4ff' }}>🔐 Chief Underwriter Decision</div>
                              <div style={{ fontSize:12, color:'rgba(255,255,255,0.42)', marginBottom:10 }}>Review per-layer written lines above. You may adjust them before approving.</div>
                              <textarea className="bbg-textarea" rows={2} value={returnReason} onChange={e=>setReturnReason(e.target.value)}
                                placeholder="Decision note / reason for returning or declining…" style={{ width:'100%', boxSizing:'border-box', marginBottom:10 }}/>
                              <div style={{ display:'flex', flexDirection:'column', gap:7 }}>
                                <button className="bbg-btn bbg-btn--offer" style={{ justifyContent:'center' }} onClick={doMarkApproved}>✓ Approve</button>
                                <button className="bbg-btn" style={{ justifyContent:'center', borderColor:'rgba(0,212,255,0.42)', color:'#00d4ff' }} onClick={doReturnToUW}>↩ Return to Underwriter</button>
                                <button className="bbg-btn bbg-btn--decline" style={{ justifyContent:'center' }} onClick={doDecline}>✗ Decline</button>
                              </div>
                            </div>
                          )}

                          {/* ── AWAITING SIGNED LINE: Mark Signed / NTU ── */}
                          {/* Quote sign-off is disabled in this build — quotes terminate at APPROVED.
                              Treaties (isQuote=false) keep the full Mark Signed / NTU flow. */}
                          {!isCU && !isQuote && offerStatus === 'AWAITING_SIGNED_LINE' && (
                            <div className="off-card" style={{ border:'1px solid rgba(96,165,250,0.25)', background:'rgba(96,165,250,0.04)' }}>
                              <div className="off-card-title" style={{ color:'#60a5fa' }}>✍ Record Signed Lines</div>
                              <div style={{ fontSize:12, color:'rgba(255,255,255,0.42)', marginBottom:10 }}>Offer approved. Enter signed line % per layer above. Then confirm below.</div>
                              {anyOverSigned && <div style={{ fontSize:11, color:'#f87171', padding:'6px 10px', borderRadius:6, background:'rgba(248,113,113,0.08)', marginBottom:8 }}>⚠ One or more signed lines exceed the written line</div>}
                              <div style={{ display:'flex', gap:8 }}>
                                <button className="bbg-btn bbg-btn--offer" style={{ flex:2, justifyContent:'center', opacity:(!hasAnySigned||anyOverSigned)?0.45:1 }}
                                  onClick={()=>{ if(!hasAnySigned){showToast('Enter at least one signed line first.');return;} if(anyOverSigned){showToast('Signed line cannot exceed written line on any layer.');return;} doMarkSigned(); }}>
                                  ✓ Mark Signed
                                </button>
                                <button className="bbg-btn bbg-btn--decline" style={{ flex:1, justifyContent:'center' }}
                                  onClick={()=>{ if(hasAnySigned&&!window.confirm('A signed line is entered. Mark as NTU anyway?'))return; doMarkNTU(); }}>
                                  🚫 NTU
                                </button>
                              </div>
                            </div>
                          )}

                          {/* Quote-mode terminal: APPROVED is the end of the road for quotes
                              in this build. Make the standalone state explicit so testers
                              don't look for a Sign / Bind button that isn't there. */}
                          {isQuote && (offerStatus === 'APPROVED' || offerStatus === 'AWAITING_SIGNED_LINE') && (
                            <div className="off-card" style={{ border:'1px solid rgba(35,209,139,0.30)', background:'rgba(35,209,139,0.04)' }}>
                              <div className="off-card-title" style={{ color:'#23d18b' }}>✅ Quote Approved</div>
                              <div style={{ fontSize:12, color:'rgba(255,255,255,0.55)', marginTop:6 }}>
                                Quotes run as standalone artefacts in this build — no Sign or Bind.
                                Use Request Amendment if the cedant comes back with changes.
                              </div>
                            </div>
                          )}

                          {/* ── TERMINAL state ── */}
                          {isTerminal && (
                            <div className="off-card" style={{ border:`1px solid ${offerStatus==='SIGNED'?'rgba(74,222,128,0.3)':offerStatus==='DECLINED'?'rgba(248,113,113,0.3)':'rgba(0,212,255,0.3)'}`, background:offerStatus==='SIGNED'?'rgba(74,222,128,0.04)':offerStatus==='DECLINED'?'rgba(248,113,113,0.04)':'rgba(0,212,255,0.04)' }}>
                              <div className="off-card-title" style={{ color:offerStatus==='SIGNED'?'#4ade80':offerStatus==='DECLINED'?'#f87171':'#fb923c' }}>
                                {offerStatus==='SIGNED'?'✅ Signed':offerStatus==='DECLINED'?'❌ Declined':'🚫 NTU'}
                              </div>
                              <div style={{ fontSize:11, color:'rgba(255,255,255,0.35)', marginTop:6 }}>This {isQuote ? 'quote' : 'contract'} is now read-only.</div>

                              {/* Quote-to-contract binding is disabled in this build (the
                                  server returns 410). Amendments stay available so cedant
                                  changes can still spawn a new quote version. */}
                              {isQuote && offerStatus === 'SIGNED' && (
                                <div style={{ marginTop:10, display:'flex', flexDirection:'column', gap:6 }}>
                                  <button className="bbg-btn"
                                    style={{ justifyContent:'center', borderColor:'rgba(0,212,255,0.35)', color:'#00d4ff', fontSize:11 }}
                                    onClick={async () => {
                                      const reason = window.prompt('Reason for amendment (cedant requested changes):');
                                      if (reason === null) return; // cancelled
                                      try {
                                        const res = await api.amendQuote(contractId, { reason, _actor: actorName });
                                        showToast(`✅ Amendment created!\n\nNew quote version ${res.version}: ${res.new_quote_id.slice(0,8)}…\n\nThe new version is now DRAFT and ready for editing.`);
                                        setShowOfferModal(false);
                                      } catch(e) { showToast('Amendment failed: ' + (e?.message || 'Server error')); }
                                    }}>
                                    ✏ Request Amendment
                                  </button>
                                </div>
                              )}

                              {/* Amendment also available from APPROVED (before signing) */}
                              {isQuote && (offerStatus === 'AWAITING_SIGNED_LINE' || offerStatus === 'APPROVED') && (
                                <button className="bbg-btn" style={{ width:'100%', justifyContent:'center', marginTop:8, borderColor:'rgba(0,212,255,0.35)', color:'#00d4ff', fontSize:11 }}
                                  onClick={async () => {
                                    const reason = window.prompt('Reason for amendment (cedant requested changes):');
                                    if (reason === null) return;
                                    try {
                                      const res = await api.amendQuote(contractId, { reason, _actor: actorName });
                                      showToast(`Amendment v${res.version} created. New quote ID: ${res.new_quote_id.slice(0,8)}…`);
                                      setShowOfferModal(false);
                                    } catch(e) { showToast('Amendment failed: ' + (e?.message || 'Server error')); }
                                  }}>
                                  ✏ Request Amendment
                                </button>
                              )}
                            </div>
                          )}

                          {/* ── APPROVAL TRAIL ── */}
                          {approvalTrail.length > 0 && (
                            <div style={{ display:'flex', flexDirection:'column', gap:5 }}>
                              <div style={{ fontSize:10, fontWeight:700, letterSpacing:'.10em', textTransform:'uppercase', color:'rgba(255,255,255,0.35)', marginBottom:4 }}>Approval Trail</div>
                              {approvalTrail.slice(0,5).map((ev,i) => {
                                const evC = { SUBMITTED:{bg:'rgba(96,165,250,0.08)',border:'rgba(96,165,250,0.25)',label:'#60a5fa',icon:'📤'}, SUBMITTED_FOR_APPROVAL:{bg:'rgba(96,165,250,0.08)',border:'rgba(96,165,250,0.25)',label:'#60a5fa',icon:'📤'}, APPROVED:{bg:'rgba(74,222,128,0.08)',border:'rgba(74,222,128,0.25)',label:'#4ade80',icon:'✅'}, RETURNED_TO_UW:{bg:'rgba(0,212,255,0.08)',border:'rgba(0,212,255,0.25)',label:'#00d4ff',icon:'↩'}, RETURNED:{bg:'rgba(0,212,255,0.08)',border:'rgba(0,212,255,0.25)',label:'#00d4ff',icon:'↩'}, RECALLED:{bg:'rgba(0,212,255,0.08)',border:'rgba(0,212,255,0.25)',label:'#00d4ff',icon:'↩'}, DECLINED:{bg:'rgba(248,113,113,0.08)',border:'rgba(248,113,113,0.25)',label:'#f87171',icon:'❌'}, SIGNED:{bg:'rgba(74,222,128,0.06)',border:'rgba(74,222,128,0.20)',label:'#4ade80',icon:'✍'}, NTU:{bg:'rgba(0,212,255,0.08)',border:'rgba(0,212,255,0.25)',label:'#fb923c',icon:'🚫'} };
                                const c = evC[ev.event_type] || {bg:'rgba(255,255,255,0.04)',border:'rgba(255,255,255,0.12)',label:'rgba(255,255,255,0.6)',icon:'•'};
                                return (
                                  <div key={i} style={{ display:'flex', gap:8, padding:'7px 10px', borderRadius:7, background:c.bg, border:`1px solid ${c.border}` }}>
                                    <span style={{ fontSize:13, flexShrink:0 }}>{c.icon}</span>
                                    <div style={{ flex:1, minWidth:0 }}>
                                      <div style={{ display:'flex', gap:8, alignItems:'baseline', flexWrap:'wrap' }}>
                                        <span style={{ fontWeight:700, fontSize:11, color:c.label }}>{(ev.event_type||'').replace(/_/g,' ')}</span>
                                        <span style={{ fontSize:10, color:'rgba(255,255,255,0.4)' }}>by {ev.actor||ev.actor_name}</span>
                                        <span style={{ fontSize:10, color:'rgba(255,255,255,0.28)', marginLeft:'auto' }}>{ev.created_at?new Date(ev.created_at).toLocaleString('en-GB',{day:'2-digit',month:'short',hour:'2-digit',minute:'2-digit'}):''}</span>
                                      </div>
                                      {(ev.payload?.reason||ev.comment) && <div style={{ fontSize:10, color:'rgba(255,255,255,0.45)', marginTop:2, fontStyle:'italic' }}>"{ev.payload?.reason||ev.comment}"</div>}
                                    </div>
                                  </div>
                                );
                              })}
                            </div>
                          )}
                        </div>

                        {/* ── FOOTER ── */}
                        <div className="off-footer">
                          <div className="off-footer-left"/>
                          <button className="bbg-btn" style={{ minWidth:90 }} onClick={() => setShowOfferModal(false)}>
                            {isTerminal ? 'Close' : 'Cancel'}
                          </button>
                        </div>

                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* Market-intelligence child modal — sibling to the
                  offer modal so closing it returns to the offer
                  modal with state intact (layer lines, comments etc.
                  all live on this NpFinalPricing component, not
                  inside the offer modal IIFE). */}
              <MarketIntelligenceModal
                show={marketModalOpen}
                onClose={() => setMarketModalOpen(false)}
                contractId={contractId}
                countryId={appState.npTreatyDetail?.countryId || null}
                classOfBusinessId={
                  (Array.isArray(appState.npTreatyDetail?.classOfBusinessIds)
                    && appState.npTreatyDetail.classOfBusinessIds[0])
                    || appState.npTreatyDetail?.primaryClassOfBusinessId
                    || null
                }
                countryName={npDetail?.countryName || npDetail?.country || ''}
                cobName={(() => {
                  const list = appState.npTreatyDetail?.cobNames
                    || appState.npTreatyDetail?.classOfBusinessNames
                    || [];
                  return Array.isArray(list) ? (list[0] || '') : '';
                })()}
                targetYear={Number(npDetail?.startYear) || Number(npDetail?.uwYear) || null}
                currency={currency}
                treatyMetrics={{
                  loss_ratio_pct: null,
                  commission_pct: Number.isFinite(Number(npDetail?.brokeragePct))
                    ? Number(npDetail.brokeragePct) : null,
                  retention_pct: null,
                  margin_pct: null,
                }}
              />

                            {/* Decline Modal */}
              {showDeclineModal && (
                <div className="screen-modal-backdrop" style={{ display: 'flex' }} onClick={e => { if (e.target === e.currentTarget) setShowDeclineModal(false); }}>
                  <div className="screen-modal" role="dialog">
                    <div className="screen-modal-header">
                      <div className="screen-modal-title">Decline Treaty</div>
                      <button className="screen-modal-close" onClick={() => setShowDeclineModal(false)}>✕</button>
                    </div>
                    <div className="screen-modal-body" style={{ padding: 20 }}>
                      <p>Reason for declining:</p>
                      <textarea className="np-mini-input" rows={3} value={declineReason} onChange={e => setDeclineReason(e.target.value)} style={{ width: '100%', marginTop: 8 }} />
                      <div style={{ marginTop: 16, display: 'flex', gap: 8 }}>
                        <button className="np-btn np-btn--danger" onClick={async () => { try { await api.declineContract(contractId, declineReason, quoteMode ? { quote: true } : undefined); } catch(e) { showToast('Decline failed: '+(e?.message||'Server error')); return; } setOfferStatus('DECLINED'); setShowDeclineModal(false); }}>Decline</button>
                        <button className="np-btn" onClick={() => setShowDeclineModal(false)}>Cancel</button>
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {/* ═══ Insight Modal (Large Losses, CAT Losses, Aggregates, Cedant Summary, etc.) ═══ */}
              {insightOpen && (
                <div className="bbg-modal-backdrop" onClick={e => { if (e.target === e.currentTarget) setInsightOpen(false); }}>
                  <div className={`bbg-modal ${['LARGE_LOSSES','CAT_LOSSES','AGGREGATES','CEDANT','RISK_PROFILE','MKT_ANALYSIS','CHECKLIST'].includes(insightKey) ? 'bbg-modal--fullscreen' : 'bbg-modal--wide'}`}>
                    <div className="bbg-modal-head">
                      <span className="bbg-modal-title">
                        { insightKey === 'LARGE_LOSSES' ? 'Large Loss Selection'
                        : insightKey === 'CAT_LOSSES'   ? 'CAT Loss Selection'
                        : insightKey === 'AGGREGATES'   ? 'Cresta Aggregates'
                        : insightKey === 'MKT_ANALYSIS' ? 'Market Analysis'
                        : insightKey === 'RISK_PROFILE' ? 'Risk Profile'
                        : insightKey === 'CHECKLIST'    ? 'Underwriting Checklist'
                        : insightKey === 'CEDANT'       ? 'Cedant Summary'
                        : insightKey }
                      </span>
                      <button className="bbg-modal-x" onClick={() => setInsightOpen(false)}>✕</button>
                    </div>
                    <div className="bbg-modal-body bbg-modal-body--embed">
                      {insightKey === 'LARGE_LOSSES' && (
                        <div className="bbg-embed-screen">
                          <LossSelectionScreen routeKey="NP_LARGE_LOSS_SELECTION" title="Large Loss Selection" headerPill="" lossType="large" embedded />
                        </div>
                      )}
                      {insightKey === 'CAT_LOSSES' && (
                        <div className="bbg-embed-screen">
                          <LossSelectionScreen routeKey="NP_CAT_LOSS_SELECTION" title="CAT Loss Selection" headerPill="" lossType="cat" embedded />
                        </div>
                      )}
                      {insightKey === 'AGGREGATES' && (
                        <div className="bbg-embed-screen">
                          <NpCrestaAggregates embedded />
                        </div>
                      )}
                      {insightKey === 'RISK_PROFILE' && (
                        <div className="bbg-embed-screen">
                          <ProfileScreen routeKey="NP_RISK_PROFILE" title="Risk Profile" headerPill="" profileType="risk" embedded />
                        </div>
                      )}
                      {insightKey === 'CHECKLIST' && <NpChecklistPanel contractId={contractId} isQuote={isQuote} />}
                      {insightKey === 'MKT_ANALYSIS' && (
                        <NpMarketAnalysis
                          layers={layers}
                          treatyMetrics={treatyMetrics}
                          quotePricing={quotePricing}
                          npDetail={npDetail}
                          portfolioTreaties={portfolioTreaties}
                        />
                      )}
                      {insightKey === 'CEDANT' && (
                        <CedantSummaryTabs
                          contractId={contractId}
                          currency={currency}
                          layers={layers}
                          isQuote={isQuote}
                          mode="NP"
                        />
                      )}
                    </div>
                  </div>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </WizardLayout>
  );
}
