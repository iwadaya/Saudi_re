// src/screens/non_proportional/final_pricing/fqQuoteMath.js
//
// Quote-mode (Final Quote) layer math lifted verbatim out of
// NpFinalPricing.jsx during the Phase 4.1 decomposition. Every function
// here is pure — same inputs, same outputs, no React, no API — and the
// bodies are byte-for-byte the module-scope helpers the screen carried
// inline. The golden-master test pins their observable behaviour;
// change anything here and that suite must still pass unchanged.
//
// Exported names are consumed by NpFinalPricing.jsx, its hooks/ and its
// components/. Internal helpers stay module-private on purpose.

import { toN, deriveComponentTotal } from './formatters.js';
import { fqQuoteLayerDerived, fqPriceLayerOnCurve } from './fqHelpers.js';

// Client-side scaffolding caps for the quote-pricing redesign (mimics
// QuickBenchmark) — an "expiring structure" with a configurable layer
// count, plus structures the user appends with the Add Structure button.
export const QM_MAX_LAYERS = 8;
export const QM_MAX_STRUCTURES = 5;

/** A fresh blank expiring-structure layer at position `i`. */
export const emptyExpLayer = (i) => ({
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

/**
 * A fresh blank quote-structure layer at position `i`. Risk/cat default
 * from the treaty-type mode flags (risk-only treaties default cat off,
 * and vice versa) — pass the screen's `riskDisabled`/`catDisabled`.
 */
export const emptyStrLayer = (i, { riskDisabled = false, catDisabled = false } = {}) => {
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
    wtPareto: '25',
    loading: '15',
    uwPrice: '',
    riskPureBurn: '',
    riskPareto: '',
    riskExposure: '',
    riskWeightBurn: '50',
    riskWeightPareto: '25',
    riskWeightExp: '25',
    riskLoading: '15',
    riskUwPrice: '',
    catPureBurn: '',
    catPareto: '',
    catExposure: '',
    catWeightBurn: '50',
    catWeightPareto: '25',
    catWeightExp: '25',
    catLoading: '15',
    catUwPrice: '',
    pAttach: '',
    pExhaust: '',
    // Layer-level reinstatement terms (same value shown in the Risk and Cat
    // Pricing Analysis tables). Default '' so they round-trip through the save
    // path (normalize spreads ...layer, so these persist).
    reinstatements: '',
    pctReinst: '',
    // Per-scope manual MDP (minimum deposit premium) %, entered in the Final
    // Price modal. Default '' so they round-trip through the save path.
    riskMdpPct: '',
    catMdpPct: '',
    // Per-layer, per-scope free-text note shown in the Pricing Analysis
    // modal's "Note" column. Defaults to '' so it round-trips through the
    // save path (normalize spreads ...layer, so these persist).
    riskLayerNote: '',
    catLayerNote: '',
  };
};

export const fmtAutoPct = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  return String(Math.round(n * 10000) / 10000);
};

export const fmtAutoAmount = (value) => {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return '';
  return String(Math.round(n));
};

export const expLayerEarnedPremium = (layer = {}) => {
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

export const syncExpLayerPricing = (layer, editedField) => {
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

// Pure burn / Pareto / exposure are MODEL outputs (engine-calculated) and are
// rendered read-only in the pricing analysis — only the weights and loading are
// underwriter-editable here, so only those remain typeable pricing inputs.
export const QUOTE_PRICING_INPUT_FIELDS = new Set(['wtBurn', 'wtPareto', 'loading']);

export const QUOTE_COMPONENT_SCOPES = {
  risk: {
    label: 'Risk',
    color: '#38bdf8',
    fields: {
      pureBurn: 'riskPureBurn',
      pareto: 'riskPareto',
      exposure: 'riskExposure',
      wtBurn: 'riskWeightBurn',
      wtPareto: 'riskWeightPareto',
      wtExp: 'riskWeightExp',
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
      wtExp: 'catWeightExp',
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

// The per-scope component ROL% fields (risk/cat × pure burn / Pareto / exposure)
// that the actuarial engine SEEDS. Editing one marks it `${field}Manual` so a
// recompute won't clobber the underwriter's override (see updateQuotePricingLayer
// + mergeQuoteEngineResult).
const QUOTE_COMPONENT_ROL_FIELDS = new Set(
  Object.values(QUOTE_COMPONENT_SCOPES).flatMap((scope) => [scope.fields.pureBurn, scope.fields.pareto, scope.fields.exposure]),
);

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

export const quoteActiveScopes = (layer = {}) => (
  Object.keys(QUOTE_COMPONENT_SCOPES).filter((scope) => !!layer[scope])
);

// Active layers whose component weights (Burn + Pareto + Exposure) don't total
// 100% — returned as display strings ("Layer 2: 105%") for the warning banner.
// The default split is Burn 50 / Pareto 25 / Exposure 25; this flags any layer
// an underwriter has knocked off 100%.
export const quoteWeightIssues = (layers = [], scopeKey, fields) => {
  if (!fields) return [];
  const out = [];
  (Array.isArray(layers) ? layers : []).forEach((l, i) => {
    if (!l || !l[scopeKey]) return;
    const sum = toN(l[fields.wtBurn]) + toN(l[fields.wtPareto]) + toN(l[fields.wtExp]);
    if (Math.abs(sum - 100) > 0.01) out.push(`Layer ${i + 1}: ${sum.toFixed(0)}%`);
  });
  return out;
};

const quoteComponentBaseDerived = (layer = {}, scopeKey) => {
  const scope = QUOTE_COMPONENT_SCOPES[scopeKey];
  if (!scope) return fqQuoteLayerDerived(layer);
  const f = scope.fields;
  const pureBurn = toN(layer[f.pureBurn]);
  const pareto = toN(layer[f.pareto]);
  const exposure = toN(layer[f.exposure]);
  const wtBurn = toN(layer[f.wtBurn] || '50');
  const wtPareto = toN(layer[f.wtPareto] || '25');
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

export const quoteComponentDerived = (layer = {}, scopeKey, opts = {}) => {
  const scope = QUOTE_COMPONENT_SCOPES[scopeKey];
  const base = quoteComponentBaseDerived(layer, scopeKey);
  if (!scope || opts.ignoreUw) return base;
  const explicitUw = toN(layer[scope.fields.uwPrice]);
  return { ...base, totalRol: isUwPriceSane(explicitUw) ? explicitUw : base.modeledRol };
};

export const quoteComponentAutoTracksUw = (layer = {}, scopeKey) => {
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
    next[f.wtPareto] = pickQuoteField(next, [f.wtPareto], next.wtPareto || '25');
    next[f.loading] = pickQuoteField(next, [f.loading], next.loading || '15');
    next[f.uwPrice] = pickQuoteField(next, [f.uwPrice], next.uwPrice || '');
  });
  return next;
};

export const quoteComponentSummary = (layer = {}) => {
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
  const wtPareto = avg('wtPareto', 25);
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

export const quoteLayerDerived = (layer = {}) => {
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

// Stricter guard for the component ROL% fields (pure burn / Pareto / exposure):
// a component ROL above 100% is almost certainly NOT a rate-on-line — it's a
// stale raw value (e.g. an expected-layer-loss amount, or a rate written into
// the wrong field). Treat it as unset so the engine recompute reseeds it rather
// than the screen rendering the raw number (e.g. Pareto "82.822").
const ROL_PCT_MAX = 100;
const saneRolOrEmpty = (raw) => {
  if (raw == null || raw === '') return '';
  const n = toN(raw);
  return n > 0 && n <= ROL_PCT_MAX ? String(raw) : '';
};

export const normalizeQuotePricingLayer = (layer = {}, index = 0, opts = {}) => {
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
    pureBurn: saneRolOrEmpty(pickQuoteField(layer, ['pureBurn', 'pure_burning_cost', 'riskPureBurn', 'catPureBurn'])),
    pareto: saneRolOrEmpty(pickQuoteField(layer, ['pareto', 'pareto_pricing', 'riskPareto', 'catPareto'])),
    exposure: saneRolOrEmpty(pickQuoteField(layer, ['exposure', 'exposure_rating', 'riskExposure', 'catExposure'])),
    wtBurn: pickQuoteField(layer, ['wtBurn', 'burn_weight_pct', 'riskWeightBurn', 'catWeightBurn'], '50'),
    wtPareto: pickQuoteField(layer, ['wtPareto', 'pareto_weight_pct', 'riskWeightPareto', 'catWeightPareto'], '25'),
    loading: pickQuoteField(layer, ['loading', 'pricing_loading_pct', 'riskLoading', 'catLoading'], '15'),
    uwPrice: sanePctOrEmpty(pickQuoteField(layer, ['uwPrice', 'uw_price', 'reinsurerPricing', 'riskUwPrice', 'catUwPrice'])),
    pAttach: pickQuoteField(layer, ['pAttach', 'prob_attach']),
    pExhaust: pickQuoteField(layer, ['pExhaust', 'prob_exhaust']),
    riskPureBurn: saneRolOrEmpty(pickQuoteField(layer, ['riskPureBurn'])),
    riskPareto: saneRolOrEmpty(pickQuoteField(layer, ['riskPareto'])),
    riskExposure: saneRolOrEmpty(pickQuoteField(layer, ['riskExposure'])),
    riskWeightBurn: pickQuoteField(layer, ['riskWeightBurn', 'riskWtBurn'], '50'),
    riskWeightPareto: pickQuoteField(layer, ['riskWeightPareto', 'riskWtPareto'], '25'),
    riskWeightExp: pickQuoteField(layer, ['riskWeightExp', 'riskWtExp'], '25'),
    riskLoading: pickQuoteField(layer, ['riskLoading']),
    riskUwPrice: sanePctOrEmpty(pickQuoteField(layer, ['riskUwPrice', 'riskTotalPrice'])),
    catPureBurn: saneRolOrEmpty(pickQuoteField(layer, ['catPureBurn'])),
    catPareto: saneRolOrEmpty(pickQuoteField(layer, ['catPareto'])),
    catExposure: saneRolOrEmpty(pickQuoteField(layer, ['catExposure'])),
    catWeightBurn: pickQuoteField(layer, ['catWeightBurn', 'catWtBurn'], '50'),
    catWeightPareto: pickQuoteField(layer, ['catWeightPareto', 'catWtPareto'], '25'),
    catWeightExp: pickQuoteField(layer, ['catWeightExp', 'catWtExp'], '25'),
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

export const cascadeQuoteAttachments = (layers = []) => {
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

export const normalizeQuoteStructure = (structure = {}, index = 0, opts = {}) => {
  const rawLayers = Array.isArray(structure.layers) ? structure.layers : [];
  const layers = rawLayers.length ? rawLayers : [{}];
  return {
    ...structure,
    id: structure.id || structure.structureId || `str-${index}`,
    // Per-structure quote type (LEAD/INDICATIVE) + a single lead/follow line
    // "across" the structure (not per layer). Defaults keep legacy/loaded
    // structures consistent; they round-trip via the save path.
    quoteType: structure.quoteType === 'INDICATIVE' ? 'INDICATIVE' : 'LEAD',
    leadLinePct: structure.leadLinePct ?? '',
    followLinePct: structure.followLinePct ?? '',
    layers: cascadeQuoteAttachments(layers.map((layer, layerIndex) => normalizeQuotePricingLayer(layer, layerIndex, opts))),
  };
};

export const normalizeQuoteStructures = (structures = [], opts = {}) => (
  (Array.isArray(structures) ? structures : []).map((structure, index) => normalizeQuoteStructure(structure, index, opts))
);

// "{count}@{pct}%" (e.g. "1@100%"); "Unlimited" for the UNLIMITED sentinel;
// "—" when there are no reinstatements.
export const reinstLabel = (count, pct) => {
  if (String(count ?? '').trim().toUpperCase() === 'UNLIMITED') return 'Unlimited';
  const n = toN(count);
  if (!(n > 0)) return '—';
  const p = toN(pct);
  return `${Math.round(n)}@${Number.isInteger(p) ? p : Number(p.toFixed(2))}%`;
};

// Combined per-layer pricing — fuse the risk + cat components of ONE layer:
// ADD the active components' ROLs (risk-only → risk, cat-only → cat, both →
// sum), then derive premium and rate. Reuses quoteComponentDerived — no pricing
// is recomputed. Returns null for layers with no active component so callers can
// skip them. Shared by the Pricing Analysis Total Section and the Send-for-
// Approval review so both fuse risk+cat identically.
export const layerCombinedPricing = (layer = {}) => {
  const riskActive = !!layer.risk;
  const catActive = !!layer.cat;
  if (!riskActive && !catActive) return null;
  const riskRol = riskActive ? quoteComponentDerived(layer, 'risk').totalRol : 0;
  const catRol = catActive ? quoteComponentDerived(layer, 'cat').totalRol : 0;
  const uwRol = riskRol + catRol;
  const limit = toN(layer.limit);
  const egnpi = toN(layer.egnpi);
  const earnedPremium = limit * uwRol / 100;
  const rate = egnpi > 0 ? (earnedPremium / egnpi) * 100 : 0;
  // MDP (minimum deposit premium): mdp_pct defaults to 85 when unset; the amount
  // is EP x mdp_pct / 100 (so mdp_pct = mdp / EP, matching LayerTableCard).
  const mdpPctRaw = layer.mdpPct;
  const mdpPct = (mdpPctRaw == null || String(mdpPctRaw).trim() === '') ? 85 : toN(mdpPctRaw);
  const mdpAmount = earnedPremium * mdpPct / 100;
  return {
    limit,
    deductible: layer.deductible ?? layer.attachment,
    egnpi,
    rate,
    earnedPremium,
    uwRol,
    mdpPct,
    mdpAmount,
    reinst: reinstLabel(layer.reinstatements, layer.pctReinst),
  };
};

// Structure-level combined totals (risk + cat fused), summed over active layers:
// total limit, total premium (sum of earned premium), and limit-weighted UW ROL
// (sum premium / sum limit). Used by the Submit-Quotes summary so structure
// totals match the per-layer combined pricing shown elsewhere.
export const structureCombinedTotals = (structure = {}) => {
  const layers = Array.isArray(structure.layers) ? structure.layers : [];
  let totalLimit = 0;
  let totalPremium = 0;
  let activeCount = 0;
  for (const layer of layers) {
    const c = layerCombinedPricing(layer);
    if (!c) continue;
    activeCount += 1;
    totalLimit += c.limit;
    totalPremium += c.earnedPremium;
  }
  return { totalLimit, totalPremium, activeCount, wtdRol: totalLimit > 0 ? (totalPremium / totalLimit) * 100 : 0 };
};

// Pareto pricing FROM the Monte-Carlo aggregate-loss simulation. The pure
// premium is the simulated mean ceded loss expressed as a ROL% — mean / limit
// × 100 — i.e. the SAME base the riskPareto/catPareto blend component already
// uses (expected annual layer loss / limit), so it slots straight into the
// Pure-Burn/Pareto/Exposure blend. The technical (loaded) ROL adds an
// underwriter-driven risk load: θ·SD, or a multiple of the TVaR excess over
// the mean. Returns both pure and loaded so the UI can show the markup.
// @param {{ mean?:number, sd?:number, tail?:Array<{rp:number,tvar:number}> }} aggregate
// @param {number|string} limit
// @param {{ method?:string, factor?:number|string, tvarRp?:number }} load
export const paretoTechnicalRol = (aggregate, limit, load = {}) => {
  const lim = toN(limit);
  if (!aggregate || !(lim > 0)) return { purePremium: 0, riskLoad: 0, pureRol: 0, loadedRol: 0 };
  const mean = toN(aggregate.mean);
  const sd = toN(aggregate.sd);
  const factor = toN(load.factor);
  let riskLoad;
  if (String(load.method || '').toUpperCase() === 'TVAR') {
    const rp = load.tvarRp || 100;
    const row = (Array.isArray(aggregate.tail) ? aggregate.tail : []).find((t) => t.rp === rp);
    const tvar = row ? toN(row.tvar) : mean;
    riskLoad = factor * Math.max(0, tvar - mean);   // multiple × expected shortfall over the mean
  } else {
    riskLoad = factor * sd;                          // θ · SD
  }
  const loadedPremium = mean + riskLoad;
  return {
    purePremium: mean,
    riskLoad,
    pureRol: (mean / lim) * 100,
    loadedRol: (loadedPremium / lim) * 100,
  };
};

export const updateQuotePricingLayer = (layer = {}, field, value, opts = {}) => {
  const autoUw = quoteLayerAutoTracksUw(layer);
  let next = { ...layer, [field]: value };
  // Editing a component ROL% (pure burn / Pareto / exposure) is an underwriter
  // override: flag it so an engine recompute won't clobber the manual value.
  if (QUOTE_COMPONENT_ROL_FIELDS.has(field)) next[`${field}Manual`] = true;
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
  // The engine returning 0 means "nothing to price from" (e.g. no selected
  // losses / profile) — keep the existing value rather than wiping it to 0, so
  // a recompute with missing data never blanks a previously-priced cell. A real
  // (> 0) engine value still overwrites a stale one.
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return fmtAutoPct(n);
};

// Pure-burn formatter for the "losses were loaded for this scope" path: a
// computed 0 is a REAL result (the covered class simply had no losses) and must
// render as "0" → "0.00%", not blank. fmtAutoPct collapses 0 → '' (it is meant
// for the "nothing to price" case), which would otherwise leave the cell empty
// and read as "not calculated" — notably on a layer whose class carries no
// losses (often the first layer).
const engineBurnWithLosses = (value) => {
  const n = toN(value);
  return Number.isFinite(n) && n > 0 ? fmtAutoPct(n) : '0';
};

export const mergeQuoteEngineResult = (layer = {}, result = {}) => {
  const next = { ...layer };
  const applyScope = (scopeKey, component) => {
    const scope = QUOTE_COMPONENT_SCOPES[scopeKey];
    if (!scope || !component) return;
    const f = scope.fields;
    const uwWasAuto = quoteComponentAutoTracksUw(next, scopeKey);
    // Seed each component from the engine UNLESS the underwriter has overridden
    // it (`${field}Manual`) — a manual value must survive recompute.
    // Pure burn: when the engine had losses for this scope, the burn (0 included)
    // is a real result → write it, so a layer covering a class with zero losses
    // reads 0%, not blank. With NO losses loaded at all it's "no data" → keep the
    // existing/seeded value (don't wipe a previously-priced cell).
    if (!next[`${f.pureBurn}Manual`]) {
      next[f.pureBurn] = Number(component.scopeLossCount) > 0
        ? engineBurnWithLosses(component.pureBurn)
        : quoteEnginePct(component.pureBurn, next[f.pureBurn]);
    }
    if (!next[`${f.pareto}Manual`]) next[f.pareto] = quoteEnginePct(component.pareto, next[f.pareto]);
    if (!next[`${f.exposure}Manual`]) next[f.exposure] = quoteEnginePct(component.exposureRating, next[f.exposure]);
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
