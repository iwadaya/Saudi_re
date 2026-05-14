import { getAuthHeaders } from './utils/auth';
import { httpFetch, HttpError } from './utils/httpClient.js';

// src/api.js — Centralized API client for React app

// ── Client-side ref data cache (5-min TTL) ───────────────────────────────────
// Prevents repeated identical fetches when navigating between wizard screens.
// Brokers, treaty types, COBs, countries, currencies are static — no need to
// re-fetch on every screen mount. Cache is cleared on logout.
const _clientCache = new Map();
const CLIENT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

function clientCacheGet(key) {
  const entry = _clientCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _clientCache.delete(key); return null; }
  return entry.promise; // return the promise so concurrent callers share it
}
function clientCacheSet(key, promise) {
  _clientCache.set(key, { promise, expiresAt: Date.now() + CLIENT_CACHE_TTL });
  return promise;
}
export function clearClientRefCache() { _clientCache.clear(); }

// Keys that are safe to cache (static/slow-changing)
const CACHEABLE_PATHS = new Set([
  '/api/brokers', '/api/reinsurers', '/api/treaty-types', '/api/class-of-business',
  '/api/ref/lists/country/items', '/api/ref/lists/currency/items',
  '/api/fac/reference/occupancies',
  '/api/fac/reference/factors',
  '/api/fac/reference/factor-weights',
  '/api/fac/reference/scoring-tables',
  '/api/fac/reference/bi-indemnity',
  '/api/fac/reference/natcat-rates',
  '/api/fac/reference/clauses',
]);

const API_BASE = (() => {
  try {
    const loc = window.location;
    const host = loc.hostname;
    const port = String(loc.port || '');
    if ((host === 'localhost' || host === '127.0.0.1') && port && port !== '4000') {
      return `http://${host}:4000`;
    }
  } catch {}
  return '';
})();

const PATHS = {
  homeSummary: '/api/home/summary',
  cedants: '/api/cedants',
  cedantSummary: (cedantId, uwYear) => `/api/cedants/${enc(cedantId)}/cedant-summary${uwYear ? `?uw_year=${enc(uwYear)}` : ''}`,
  cedantNpLayers: (cedantId) => `/api/cedants/${enc(cedantId)}/np-layers`,
  cedantPortfolioRecs: (cedantId) => `/api/ai/cedant/${enc(cedantId)}/portfolio-recommendations`,
  cedantPortfolioRecsLatest: (cedantId) => `/api/ai/cedant/${enc(cedantId)}/portfolio-recommendations/latest`,
  cedantPortfolioRecReject: (recId) => `/api/ai/cedant/recommendation/${enc(recId)}/reject`,
  cedantStaging: (cedantId) => `/api/cedants/${enc(cedantId)}/staging`,
  cedantStagingDiscard: (cedantId, stagingId) => `/api/cedants/${enc(cedantId)}/staging/${enc(stagingId)}/discard`,
  cedantStagingCommitAll: (cedantId) => `/api/cedants/${enc(cedantId)}/staging/commit-all`,
  cedantStagingImpact: (cedantId) => `/api/cedants/${enc(cedantId)}/staging/portfolio-impact`,
  reinsurers: '/api/reinsurers',
  brokers: '/api/brokers',
  classOfBusiness: '/api/class-of-business',
  treatyTypes: '/api/treaty-types',
  refListItems: (key) => `/api/ref/lists/${enc(key)}/items`,
  refCrestaZones: (countryId) => `/api/ref/cresta-zones/${enc(countryId)}`,
  refInflation: (countryId, startYear, endYear) => {
    const qs = [];
    if (startYear) qs.push(`start_year=${enc(startYear)}`);
    if (endYear) qs.push(`end_year=${enc(endYear)}`);
    return `/api/ref/inflation/${enc(countryId)}${qs.length ? `?${qs.join('&')}` : ''}`;
  },
  refBenchmarkLdf: (countryId) => `/api/ref/benchmark-ldf/${enc(countryId)}`,
  exchangeRates: '/api/ref/exchange-rates',
  exchangeRate: (code) => `/api/ref/exchange-rates/${enc(code)}`,
  swissReCurves: '/api/ref/swiss-re-curves',
  swissReCurve: (name) => `/api/ref/swiss-re-curves/${enc(name)}`,
  treaties: '/api/treaties',
  treaty: (id) => `/api/treaties/${enc(id)}`,
  treatyRenew: (id) => `/api/treaties/${enc(id)}/renew`,
  nonPropTreaty: (id) => `/api/treaties/${enc(id)}/non-prop`,
  nonPropTreatySave: (id) => `/api/treaties/${enc(id)}/non-prop/save`,
  npEgnpiYear: (id) => `/api/treaties/${enc(id)}/np/egnpi-year`,
  npHistoricalPerformance: (id) => `/api/treaties/${enc(id)}/np/historical-performance`,
  npLargeLossLdfs: (id) => `/api/treaties/${enc(id)}/np/large-loss-ldfs`,
  npCatLossLdfs: (id) => `/api/treaties/${enc(id)}/np/cat-loss-ldfs`,
  triangle: (id, type) => `/api/treaties/${enc(id)}/triangles/${enc(type)}`,
  treatyDocuments: (id) => `/api/treaties/${enc(id)}/documents`,
  wordingChecklist: (id) => `/api/treaties/${enc(id)}/wording-checklist`,
  wordingChecklistAi: (id) => `/api/treaties/${enc(id)}/wording-checklist/ai-check`,
  documentDownload: (docId) => `/api/documents/${enc(docId)}/download`,
  documentView: (docId) => `/api/documents/${enc(docId)}/view`,
  deleteDocument: (docId) => `/api/documents/${enc(docId)}`,
  largeLosses: (id) => `/api/treaties/${enc(id)}/large-losses`,
  catLosses: (id) => `/api/treaties/${enc(id)}/cat-losses`,
  treatyCobs: (id) => `/api/treaties/${enc(id)}/cobs`,
  riskProfile: (id, cobId) => `/api/treaties/${enc(id)}/risk-profiles/${enc(cobId)}`,
  claimsProfile: (id, cobId) => `/api/treaties/${enc(id)}/claims-profiles/${enc(cobId)}`,
  crestaData: (id) => `/api/treaties/${enc(id)}/cresta`,
  cedantExposure: (id) => `/api/treaties/${enc(id)}/cedant-exposure`,
  devFactors: (id, type) => `/api/treaties/${enc(id)}/dev-factors/${enc(type)}`,
  pricingSave: '/api/pricing/save',
  pricing: (id) => `/api/treaties/${enc(id)}/pricing`,
  pricingOutputs: (id) => `/api/treaties/${enc(id)}/pricing-outputs`,
  pricingYearly: (id) => `/api/treaties/${enc(id)}/pricing-yearly`,
  countryAggregates: (countryId) => `/api/aggregates/country/${enc(countryId)}`,
  marketAverage: (countryId, excludeId) => `/api/pricing/market-average/${enc(countryId)}${excludeId ? `?exclude=${enc(excludeId)}` : ''}`,
  componentSnapshot: (id) => `/api/pricing/${enc(id)}/component-snapshot`,
  componentSnapshots: (id) => `/api/pricing/${enc(id)}/component-snapshots`,
  deleteComponentSnapshot: (snapId) => `/api/pricing/component-snapshot/${enc(snapId)}`,
  straightStatsSave: '/api/straight-stats/save',
  straightStatsLoad: (id) => `/api/straight-stats/load/${enc(id)}`,
  decline: (id) => `/api/treaties/${enc(id)}/decline`,
  offer: (id) => `/api/treaties/${enc(id)}/offer`,
  offerSubmit: (id) => `/api/treaties/${enc(id)}/offer/submit-for-approval`,
  offerApproved: (id) => `/api/treaties/${enc(id)}/offer/mark-approved`,
  offerReturn: (id) => `/api/treaties/${enc(id)}/offer/return-to-underwriter`,
  offerSigned: (id) => `/api/treaties/${enc(id)}/offer/mark-signed`,
  offerNtu: (id) => `/api/treaties/${enc(id)}/offer/ntu`,
  npPricing: (id) => `/api/treaties/${enc(id)}/np-pricing`,
  npExpiring: (id) => `/api/treaties/${enc(id)}/np/expiring`,
  mandateCheck: '/api/auth/mandate-check',
  authLogin: '/api/auth/login',
  authMe: '/api/auth/me',
  authUsers: '/api/auth/users',
  authRoles: '/api/auth/roles',
  dashboardFilters: '/api/dashboard/filters',
  dashboardOverview: (qs = '') => `/api/dashboard/overview${qs ? `?${qs}` : ''}`,
  dashboardPage: (tab, qs = '') => `/api/dashboard/page/${enc(tab || 'portfolio-overview')}${qs ? `?${qs}` : ''}`,
  lossSelectionLatest: (id, lossType) => `/api/treaties/${enc(id)}/loss-selection/${enc(lossType)}/latest`,
  saveLossSelectionSnapshot: (id, lossType) => `/api/treaties/${enc(id)}/loss-selection/${enc(lossType)}/snapshot`,
};

const QUOTE_PATHS = {
  quotes: '/api/quotes',
  quote: (id) => `/api/quotes/${enc(id)}`,
  quoteRenew: (id) => `/api/quotes/${enc(id)}/renew`,
  nonPropQuote: (id) => `/api/quotes/${enc(id)}/non-prop`,
  nonPropQuoteSave: (id) => `/api/quotes/${enc(id)}/non-prop/save`,
  npEgnpiYear: (id) => `/api/quotes/${enc(id)}/np/egnpi-year`,
  npHistoricalPerformance: (id) => `/api/quotes/${enc(id)}/np/historical-performance`,
  npLargeLossLdfs: (id) => `/api/quotes/${enc(id)}/np/large-loss-ldfs`,
  npCatLossLdfs: (id) => `/api/quotes/${enc(id)}/np/cat-loss-ldfs`,
  triangle: (id, type) => `/api/quotes/${enc(id)}/triangles/${enc(type)}`,
  quoteDocuments: (id) => `/api/quotes/${enc(id)}/documents`,
  quoteWordingChecklist: (id) => `/api/quotes/${enc(id)}/wording-checklist`,
  quoteWordingChecklistAi: (id) => `/api/quotes/${enc(id)}/wording-checklist/ai-check`,
  largeLosses: (id) => `/api/quotes/${enc(id)}/large-losses`,
  catLosses: (id) => `/api/quotes/${enc(id)}/cat-losses`,
  quoteCobs: (id) => `/api/quotes/${enc(id)}/cobs`,
  riskProfile: (id, cobId) => `/api/quotes/${enc(id)}/risk-profiles/${enc(cobId)}`,
  claimsProfile: (id, cobId) => `/api/quotes/${enc(id)}/claims-profiles/${enc(cobId)}`,
  crestaData: (id) => `/api/quotes/${enc(id)}/cresta`,
  cedantExposure: (id) => `/api/quotes/${enc(id)}/cedant-exposure`,
  devFactors: (id, type) => `/api/quotes/${enc(id)}/dev-factors/${enc(type)}`,
  pricing: (id) => `/api/quotes/${enc(id)}/pricing`,
  pricingOutputs: (id) => `/api/quotes/${enc(id)}/pricing-outputs`,
  pricingYearly: (id) => `/api/quotes/${enc(id)}/pricing-yearly`,
  npPricing: (id) => `/api/quotes/${enc(id)}/np-pricing`,
  npExpiring: (id) => `/api/quotes/${enc(id)}/np/expiring`,
  lossSelectionLatest: (id, lossType) => `/api/quotes/${enc(id)}/loss-selection/${enc(lossType)}/latest`,
  saveLossSelectionSnapshot: (id, lossType) => `/api/quotes/${enc(id)}/loss-selection/${enc(lossType)}/snapshot`,
  decline: (id) => `/api/quotes/${enc(id)}/decline`,
  offerSubmit: (id) => `/api/quotes/${enc(id)}/offer/submit-for-approval`,
  offerApproved: (id) => `/api/quotes/${enc(id)}/offer/mark-approved`,
  offerReturn: (id) => `/api/quotes/${enc(id)}/offer/return-to-underwriter`,
  offerSigned: (id) => `/api/quotes/${enc(id)}/offer/mark-signed`,
  offerNtu: (id) => `/api/quotes/${enc(id)}/offer/ntu`,
};

function enc(v) { return encodeURIComponent(v); }

function isQuoteMode(opts) {
  return opts?.quote === true || opts?.quote === 'true' || opts?.quote === '1';
}

function withOptimisticLockHeader(opts) {
  if (!opts?.ifUnmodifiedSince) return opts;
  const { ifUnmodifiedSince, ...rest } = opts;
  return {
    ...rest,
    headers: {
      ...(rest.headers || {}),
      'If-Unmodified-Since': ifUnmodifiedSince,
    },
  };
}

function toQuery(params) {
  const entries = Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return entries.length ? entries.map(([k, v]) => `${enc(k)}=${enc(v)}`).join('&') : '';
}

/**
 * Internal request primitive. All public api.* methods funnel through
 * here. Behaviour:
 *   • GETs on cacheable paths share an in-flight promise (dedup).
 *   • All requests get a 30s timeout via httpFetch.
 *   • GETs (idempotent) auto-retry on transient server errors with
 *     exponential backoff. Mutations do NOT retry by default — caller
 *     can opt in via opts.retry when they know the call is idempotent.
 *   • Caller's AbortSignal is forwarded if provided.
 */
async function request(path, opts = {}) {
  const {
    method = 'GET', body, headers: extraHeaders, _skipCache,
    signal, timeoutMs, retry, cache,
    ...rest
  } = opts;

  // GET dedup + cache for static reference data
  if (method === 'GET' && !_skipCache && CACHEABLE_PATHS.has(path)) {
    const cached = clientCacheGet(path);
    if (cached) return cached;
    const promise = request(path, { method, body, headers: extraHeaders, _skipCache: true, signal, timeoutMs, retry, ...rest });
    return clientCacheSet(path, promise);
  }

  const url = `${API_BASE}${path}`;
  const headers = { ...getAuthHeaders(), ...extraHeaders };
  const upperMethod = String(method).toUpperCase();
  const bypassBrowserCache = cache === undefined && upperMethod === 'GET';
  if (bypassBrowserCache) {
    headers['Cache-Control'] = headers['Cache-Control'] || 'no-cache';
    headers.Pragma = headers.Pragma || 'no-cache';
  }
  const init = {
    method,
    headers,
    signal,
    timeoutMs,
    retry,
    ...(bypassBrowserCache ? { cache: 'no-store' } : cache ? { cache } : {}),
    ...rest,
  };

  if (body !== undefined && upperMethod !== 'GET') {
    if (body instanceof FormData) {
      init.body = body;
    } else {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(body);
    }
  }

  const res = await httpFetch(url, init);
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json();
  return res.text();
}

// Re-export for callers that want to discriminate on error.status
export { HttpError };

// Public API object
export const api = {
  // Home
  getHomeSummary(opts) { return request(PATHS.homeSummary, opts); },

  // Lookups
  listCedants(opts = {}) {
    const params = new URLSearchParams();
    if (opts.countryId) params.set('country_id', opts.countryId);
    const qs = params.toString();
    return request(`${PATHS.cedants}${qs ? '?' + qs : ''}`);
  },
  getCedantSummary(cedantId, uwYear, opts) { return request(PATHS.cedantSummary(cedantId, uwYear), opts); },
  getCedantNpLayers(cedantId, opts) { return request(PATHS.cedantNpLayers(cedantId), opts); },
  generateCedantPortfolioRecs(cedantId, body, opts) {
    return request(PATHS.cedantPortfolioRecs(cedantId), { ...opts, method: 'POST', body });
  },
  getCedantPortfolioRecsLatest(cedantId, opts) {
    return request(PATHS.cedantPortfolioRecsLatest(cedantId), opts);
  },
  rejectCedantPortfolioRec(recId, body, opts) {
    return request(PATHS.cedantPortfolioRecReject(recId), { ...opts, method: 'POST', body: body || {} });
  },
  stageLineChange(cedantId, body, opts) {
    return request(PATHS.cedantStaging(cedantId), { ...opts, method: 'POST', body });
  },
  discardStagedChange(cedantId, stagingId, body, opts) {
    return request(PATHS.cedantStagingDiscard(cedantId, stagingId), { ...opts, method: 'POST', body: body || {} });
  },
  commitStagedChanges(cedantId, body, opts) {
    return request(PATHS.cedantStagingCommitAll(cedantId), { ...opts, method: 'POST', body: body || {} });
  },
  getStaging(cedantId, includeOpts, opts) {
    const include = Array.isArray(includeOpts?.include) ? `?include=${enc(includeOpts.include.join(','))}` : '';
    return request(`${PATHS.cedantStaging(cedantId)}${include}`, opts);
  },
  getStagingImpact(cedantId, opts) {
    return request(PATHS.cedantStagingImpact(cedantId), opts);
  },
  listBrokers(opts) { return request(PATHS.brokers, opts); },
  listReinsurers(opts) { return request(PATHS.reinsurers, opts); },
  listTreatyTypes(opts) { return request(PATHS.treatyTypes, opts); },
  listClassOfBusiness(opts) { return request(PATHS.classOfBusiness, opts); },
  getRefListItems(key, opts) { return request(PATHS.refListItems(key), opts); },
  listRefItems(key, opts) { return request(PATHS.refListItems(key), opts); },
  getRefCrestaZones(countryId, opts) { return request(PATHS.refCrestaZones(countryId), opts); },
  getRefInflation(countryId, startYear, endYear, opts) { return request(PATHS.refInflation(countryId, startYear, endYear), opts); },
  getRefBenchmarkLdf(countryId, opts) { return request(PATHS.refBenchmarkLdf(countryId), opts); },
  getExchangeRates(opts) { return request(PATHS.exchangeRates, opts); },
  getExchangeRate(code, opts) { return request(PATHS.exchangeRate(code), opts); },
  saveExchangeRate(code, payload, opts) { return request(PATHS.exchangeRate(code), { method: 'PUT', body: payload, ...opts }); },
  getSwissReCurves(opts) { return request(PATHS.swissReCurves, opts); },
  getSwissReCurve(name, opts) { return request(PATHS.swissReCurve(name), opts); },

  // Contracts
  createContract(payload, opts) { return request(PATHS.treaties, { method: 'POST', body: payload, ...opts }); },
  listContracts(params, opts) {
    const qs = toQuery(params);
    return request(`${PATHS.treaties}${qs ? `?${qs}` : ''}`, opts);
  },
  getContract(id, opts) { return request(isQuoteMode(opts) ? QUOTE_PATHS.quote(id) : PATHS.treaty(id), opts); },
  saveContract(id, payload, opts) {
    const requestOpts = withOptimisticLockHeader(opts);
    return request(isQuoteMode(opts) ? QUOTE_PATHS.quote(id) : PATHS.treaty(id), { method: 'PUT', body: payload, ...requestOpts });
  },
  deleteContract(id, opts) { return request(isQuoteMode(opts) ? QUOTE_PATHS.quote(id) : PATHS.treaty(id), { method: 'DELETE', ...opts }); },
  renewContract(id, opts) { return request(isQuoteMode(opts) ? QUOTE_PATHS.quoteRenew(id) : PATHS.treatyRenew(id), { method: 'POST', ...opts }); },

  // Quotes
  createQuote(payload, opts) { return request(QUOTE_PATHS.quotes, { method: 'POST', body: payload, ...opts }); },
  // Quote lifecycle
  amendQuote(id, payload, opts)   { return request(`/api/quotes/${enc(id)}/amend`,    { method: 'POST', body: payload || {}, ...opts }); },
  bindQuote(id, payload, opts)    { return request(`/api/quotes/${enc(id)}/bind`,     { method: 'POST', body: payload || {}, ...opts }); },
  getQuoteVersions(id, opts)      { return request(`/api/quotes/${enc(id)}/versions`, opts); },
  getQuoteNegotiationHistory(id, opts) { return request(`/api/quotes/${enc(id)}/negotiation-history`, opts); },
  listQuotes(params, opts) {
    const qs = toQuery(params);
    return request(`${QUOTE_PATHS.quotes}${qs ? `?${qs}` : ''}`, opts);
  },

  // Triangles
  getTriangle(id, type, opts) { return request(isQuoteMode(opts) ? QUOTE_PATHS.triangle(id, type) : PATHS.triangle(id, type), opts); },
  saveTriangle(id, type, payload, opts) { return request(isQuoteMode(opts) ? QUOTE_PATHS.triangle(id, type) : PATHS.triangle(id, type), { method: 'POST', body: payload, ...opts }); },

  // Dev factors
  getDevFactors(id, type, opts) { return request(isQuoteMode(opts) ? QUOTE_PATHS.devFactors(id, type) : PATHS.devFactors(id, type), opts); },
  saveDevFactors(id, type, payload, opts) { return request(isQuoteMode(opts) ? QUOTE_PATHS.devFactors(id, type) : PATHS.devFactors(id, type), { method: 'PUT', body: payload, ...opts }); },
  getBenchmarks(countryId, triangleType) { return request(`/api/benchmarks/${enc(countryId)}/${enc(triangleType)}`); },
  getPricingPattern(id, type) { return request(`/api/treaties/${enc(id)}/pricing-pattern/${enc(type)}`); },
  savePricingPattern(id, type, payload) { return request(`/api/treaties/${enc(id)}/pricing-pattern/${enc(type)}`, { method: 'PUT', body: payload }); },

  // Losses
  getLargeLosses(id, opts) { return request(isQuoteMode(opts) ? QUOTE_PATHS.largeLosses(id) : PATHS.largeLosses(id), opts); },
  saveLargeLosses(id, payload, opts) { return request(isQuoteMode(opts) ? QUOTE_PATHS.largeLosses(id) : PATHS.largeLosses(id), { method: 'PUT', body: payload, ...opts }); },
  getCatLosses(id, opts) { return request(isQuoteMode(opts) ? QUOTE_PATHS.catLosses(id) : PATHS.catLosses(id), opts); },
  saveCatLosses(id, payload, opts) { return request(isQuoteMode(opts) ? QUOTE_PATHS.catLosses(id) : PATHS.catLosses(id), { method: 'PUT', body: payload, ...opts }); },
  getLossSelectionLatest(id, lossType, opts) {
    return request(isQuoteMode(opts) ? QUOTE_PATHS.lossSelectionLatest(id, lossType) : PATHS.lossSelectionLatest(id, lossType), opts);
  },
  saveLossSelectionSnapshot(id, lossType, payload, opts) {
    return request(isQuoteMode(opts) ? QUOTE_PATHS.saveLossSelectionSnapshot(id, lossType) : PATHS.saveLossSelectionSnapshot(id, lossType), { method: 'PUT', body: payload, ...opts });
  },


  // COBs
  getContractCobs(id, opts) { return request(isQuoteMode(opts) ? QUOTE_PATHS.quoteCobs(id) : PATHS.treatyCobs(id), opts); },
  saveContractCobs(id, payload, opts) { return request(isQuoteMode(opts) ? QUOTE_PATHS.quoteCobs(id) : PATHS.treatyCobs(id), { method: 'PUT', body: payload, ...opts }); },

  // Profiles
  getRiskProfile(id, cobId, opts) { return request(isQuoteMode(opts) ? QUOTE_PATHS.riskProfile(id, cobId) : PATHS.riskProfile(id, cobId), opts); },
  saveRiskProfile(id, cobId, payload, opts) { return request(isQuoteMode(opts) ? QUOTE_PATHS.riskProfile(id, cobId) : PATHS.riskProfile(id, cobId), { method: 'PUT', body: payload, ...opts }); },
  getClaimsProfile(id, cobId, opts) { return request(isQuoteMode(opts) ? QUOTE_PATHS.claimsProfile(id, cobId) : PATHS.claimsProfile(id, cobId), opts); },
  saveClaimsProfile(id, cobId, payload, opts) { return request(isQuoteMode(opts) ? QUOTE_PATHS.claimsProfile(id, cobId) : PATHS.claimsProfile(id, cobId), { method: 'PUT', body: payload, ...opts }); },

  // CRESTA
  getCrestaData(id, opts) { return request(isQuoteMode(opts) ? QUOTE_PATHS.crestaData(id) : PATHS.crestaData(id), opts); },
  saveCrestaData(id, payload, opts) { return request(isQuoteMode(opts) ? QUOTE_PATHS.crestaData(id) : PATHS.crestaData(id), { method: 'PUT', body: payload, ...opts }); },
  getCedantExposure(id, opts) { return request(isQuoteMode(opts) ? QUOTE_PATHS.cedantExposure(id) : PATHS.cedantExposure(id), opts); },

  // Documents
  getDocuments(id, opts) { return request(isQuoteMode(opts) ? QUOTE_PATHS.quoteDocuments(id) : PATHS.treatyDocuments(id), opts); },
  uploadDocument(id, formData, opts) {
    // formData should be a FormData instance with 'file' + optional metadata fields
    return request(isQuoteMode(opts) ? QUOTE_PATHS.quoteDocuments(id) : PATHS.treatyDocuments(id), { method: 'POST', body: formData, ...opts });
  },
  deleteDocument(docId, opts) { return request(PATHS.deleteDocument(docId), { method: 'DELETE', ...opts }); },
  getDocumentDownloadUrl(docId) { return `${API_BASE}${PATHS.documentDownload(docId)}`; },
  getDocumentViewUrl(docId) { return `${API_BASE}${PATHS.documentView(docId)}`; },
  getWordingChecklist(id, opts) {
    return request(isQuoteMode(opts) ? QUOTE_PATHS.quoteWordingChecklist(id) : PATHS.wordingChecklist(id), opts);
  },
  saveWordingChecklist(id, payload, opts) {
    return request(isQuoteMode(opts) ? QUOTE_PATHS.quoteWordingChecklist(id) : PATHS.wordingChecklist(id), { method: 'PUT', body: payload, ...opts });
  },
  runWordingChecklistAi(id, opts) {
    return request(isQuoteMode(opts) ? QUOTE_PATHS.quoteWordingChecklistAi(id) : PATHS.wordingChecklistAi(id), { method: 'POST', body: {}, timeoutMs: 120000, ...opts });
  },

  // Pricing
  getPricing(id, opts) { return request(isQuoteMode(opts) ? QUOTE_PATHS.pricing(id) : PATHS.pricing(id), opts); },
  getPricingOutputs(id, opts) { return request(isQuoteMode(opts) ? QUOTE_PATHS.pricingOutputs(id) : PATHS.pricingOutputs(id), opts); },
  savePricingOutputs(id, payload, opts) { return request(isQuoteMode(opts) ? QUOTE_PATHS.pricingOutputs(id) : PATHS.pricingOutputs(id), { method: 'PUT', body: payload, ...opts }); },
  getPricingYearly(id, opts) { return request(isQuoteMode(opts) ? QUOTE_PATHS.pricingYearly(id) : PATHS.pricingYearly(id), opts); },
  savePricingYearly(id, payload, opts) { return request(isQuoteMode(opts) ? QUOTE_PATHS.pricingYearly(id) : PATHS.pricingYearly(id), { method: 'PUT', body: payload, ...opts }); },
  savePricingComposite(payload, opts) {
    const requestOpts = withOptimisticLockHeader(opts);
    return request(PATHS.pricingSave, { method: 'POST', body: payload, ...requestOpts });
  },

  // Straight stats
  saveStraightStats(contractId, tailType, stats, opts) { return request(PATHS.straightStatsSave, { method: 'POST', body: { contractId, tailType, stats: stats.map(s => ({ underwriting_year: s.year ?? s.underwriting_year, premium: s.premium, paid_claims: s.paid, os_claims: s.os })) }, ...opts }); },
  loadStraightStats(id, opts) { return request(PATHS.straightStatsLoad(id), opts); },
  getStraightStats(id, opts) { return request(PATHS.straightStatsLoad(id), opts); },

  // Country aggregates
  getCountryAggregates(countryId, opts) {
    const { excludeContractId, ...fetchOpts } = opts || {};
    const qs = excludeContractId ? `?excludeContractId=${encodeURIComponent(excludeContractId)}` : '';
    return request(PATHS.countryAggregates(countryId) + qs, fetchOpts);
  },
  getAggCobBreakdown(contractId, opts) { return request(`/api/pricing/agg-cob-breakdown/${encodeURIComponent(contractId)}`, opts); },
  getAggDrilldown(contractId, opts) { return request(`/api/pricing/agg-drilldown/${encodeURIComponent(contractId)}`, opts); },
  getApprovalTrail(contractId, opts) {
    const isQuote = isQuoteMode(opts);
    return request(isQuote ? `/api/quotes/${enc(contractId)}/approval-trail` : `/api/treaties/${enc(contractId)}/approval-trail`, opts);
  },
  getMarketAverage(countryId, excludeId, opts) { return request(PATHS.marketAverage(countryId, excludeId), opts); },
  saveComponentSnapshot(id, payload, opts) { return request(PATHS.componentSnapshot(id), { method: 'POST', body: payload, ...opts }); },
  getComponentSnapshots(id, opts) { return request(PATHS.componentSnapshots(id), opts); },
  deleteComponentSnapshot(snapId, opts) { return request(PATHS.deleteComponentSnapshot(snapId), { method: 'DELETE', ...opts }); },

  // Workflow
  declineContract(id, reason, opts) { return request(isQuoteMode(opts) ? QUOTE_PATHS.decline(id) : PATHS.decline(id), { method: 'POST', body: { reason }, ...opts }); },
  submitOfferForApproval(id, payload, opts) { return request(isQuoteMode(opts) ? QUOTE_PATHS.offerSubmit(id) : PATHS.offerSubmit(id), { method: 'POST', body: payload || {}, ...opts }); },
  markOfferApproved(id, payload, opts) { return request(isQuoteMode(opts) ? QUOTE_PATHS.offerApproved(id) : PATHS.offerApproved(id), { method: 'POST', body: payload || {}, ...opts }); },
  returnToUnderwriter(id, payload, opts) { return request(isQuoteMode(opts) ? QUOTE_PATHS.offerReturn(id) : PATHS.offerReturn(id), { method: 'POST', body: payload || {}, ...opts }); },
  recallOffer(id, payload, opts) {
    const base = isQuoteMode(opts) ? `/api/quotes/${enc(id)}/offer/recall` : `/api/treaties/${enc(id)}/offer/recall`;
    return request(base, { method: 'POST', body: payload || {}, ...opts });
  },
  markOfferSigned(id, payload, opts) { return request(isQuoteMode(opts) ? QUOTE_PATHS.offerSigned(id) : PATHS.offerSigned(id), { method: 'POST', body: payload || {}, ...opts }); },
  markOfferNTU(id, payload, opts) { return request(isQuoteMode(opts) ? QUOTE_PATHS.offerNtu(id) : PATHS.offerNtu(id), { method: 'POST', body: payload || {}, ...opts }); },

  // NP
  getNonPropTreaty(id, opts) { return request(isQuoteMode(opts) ? QUOTE_PATHS.nonPropQuote(id) : PATHS.nonPropTreaty(id), opts); },
  saveNonPropTreaty(id, payload, opts) {
    const requestOpts = withOptimisticLockHeader(opts);
    return request(isQuoteMode(opts) ? QUOTE_PATHS.nonPropQuoteSave(id) : PATHS.nonPropTreatySave(id), { method: 'POST', body: payload, ...requestOpts });
  },
  getNpEgnpiYear(id, opts) { return request(isQuoteMode(opts) ? QUOTE_PATHS.npEgnpiYear(id) : PATHS.npEgnpiYear(id), opts); },
  saveNpEgnpiYear(id, payload, opts) { return request(isQuoteMode(opts) ? QUOTE_PATHS.npEgnpiYear(id) : PATHS.npEgnpiYear(id), { method: 'PUT', body: payload, ...opts }); },
  getNpPricing(id, opts) { return request(isQuoteMode(opts) ? QUOTE_PATHS.npPricing(id) : PATHS.npPricing(id), opts); },
  saveNpPricing(id, payload, opts) {
    const requestOpts = withOptimisticLockHeader(opts);
    return request(isQuoteMode(opts) ? QUOTE_PATHS.npPricing(id) : PATHS.npPricing(id), { method: 'PUT', body: payload, ...requestOpts });
  },
  getNpExpiring(id, opts) { return request(isQuoteMode(opts) ? QUOTE_PATHS.npExpiring(id) : PATHS.npExpiring(id), opts); },
  saveNpExpiring(id, payload, opts) {
    const requestOpts = withOptimisticLockHeader(opts);
    return request(isQuoteMode(opts) ? QUOTE_PATHS.npExpiring(id) : PATHS.npExpiring(id), { method: 'PUT', body: payload, ...requestOpts });
  },
  getNpHistoricalPerformance(id, opts) {
    return request(isQuoteMode(opts) ? QUOTE_PATHS.npHistoricalPerformance(id) : PATHS.npHistoricalPerformance(id), opts);
  },
  saveNpHistoricalPerformance(id, rows, opts) {
    return request(isQuoteMode(opts) ? QUOTE_PATHS.npHistoricalPerformance(id) : PATHS.npHistoricalPerformance(id), { method: 'PUT', body: { rows }, ...opts });
  },
  getNpLargeLossLdfs(id, opts) { return request(isQuoteMode(opts) ? QUOTE_PATHS.npLargeLossLdfs(id) : PATHS.npLargeLossLdfs(id), opts); },
  saveNpLargeLossLdfs(id, payload, opts) { return request(isQuoteMode(opts) ? QUOTE_PATHS.npLargeLossLdfs(id) : PATHS.npLargeLossLdfs(id), { method: 'PUT', body: payload, ...opts }); },
  getNpCatLossLdfs(id, opts) { return request(isQuoteMode(opts) ? QUOTE_PATHS.npCatLossLdfs(id) : PATHS.npCatLossLdfs(id), opts); },
  saveNpCatLossLdfs(id, payload, opts) { return request(isQuoteMode(opts) ? QUOTE_PATHS.npCatLossLdfs(id) : PATHS.npCatLossLdfs(id), { method: 'PUT', body: payload, ...opts }); },
  getCedantProgrammeLimits(id, opts) { return request(`/api/treaties/${enc(id)}/cedant-programme-limits`, opts); },
  listTreaties(params = {}) {
    const qs = toQuery(params);
    return request(`/api/treaties${qs ? '?' + qs : ''}`);
  },

  // Aliases
  createTreaty(p, o) { return api.createContract(p, o); },
  getTreaty(i, o) { return api.getContract(i, o); },
  deleteTreaty(i, o) { return api.deleteContract(i, o); },
  getTreatyCobs(i, o) { return api.getContractCobs(i, o); },
  saveTreatyCobs(i, p, o) { return api.saveContractCobs(i, p, o); },
  markSignedLine(id, p, o) { return api.markOfferSigned(id, p, o); },
  markNTU(id, p, o) { return api.markOfferNTU(id, p, o); },
  submitNpOfferForApproval(id, p, o) { return api.submitOfferForApproval(id, p, o); },
  markNpOfferApproved(id, p, o) { return api.markOfferApproved(id, p, o); },
  markNpOfferSigned(id, p, o) { return api.markOfferSigned(id, p, o); },
  markNpOfferNtu(id, p, o) { return api.markOfferNTU(id, p, o); },

  // Auth & mandates
  // Approval workflow — new engine
  getApprovalState(contractId, opts) { return request(`/api/treaties/${enc(contractId)}/offer/approval-state`, opts); },
  getEligibleApprovers(contractId, { breach_type, epi_usd } = {}, opts) {
    const qs = new URLSearchParams();
    if (breach_type) qs.set('breach_type', breach_type);
    if (epi_usd)     qs.set('epi_usd', epi_usd);
    const base = isQuoteMode(opts)
      ? `/api/quotes/${enc(contractId)}/offer/eligible-approvers`
      : `/api/treaties/${enc(contractId)}/offer/eligible-approvers`;
    return request(`${base}?${qs}`, opts);
  },
  getArbiterOptions(contractId, opts) { return request(`/api/treaties/${enc(contractId)}/offer/arbiter-options`, opts); },
  peerDecision(contractId, payload, opts) { return request(`/api/treaties/${enc(contractId)}/offer/peer-decision`, { method:'POST', body:payload, ...opts }); },
  arbiterDecision(contractId, payload, opts) { return request(`/api/treaties/${enc(contractId)}/offer/arbiter-decision`, { method:'POST', body:payload, ...opts }); },

  checkMandate({ contract_id, quote_id, epi_usd, country_id, cob_ids } = {}, opts) {
    const qs = new URLSearchParams();
    if (contract_id) qs.set('contract_id', contract_id);
    if (quote_id)    qs.set('quote_id', quote_id);
    if (epi_usd)     qs.set('epi_usd', epi_usd);
    if (country_id)  qs.set('country_id', country_id);
    if (cob_ids)     qs.set('cob_ids', Array.isArray(cob_ids) ? cob_ids.join(',') : cob_ids);
    return request(`${PATHS.mandateCheck}?${qs.toString()}`, opts);
  },
  getUsers(opts) { return request(PATHS.authUsers, opts); },
  createUser(payload, opts) { return request(PATHS.authUsers, { method: 'POST', body: payload, ...opts }); },
  loginUser(payload, opts) { return request(PATHS.authLogin, { method: 'POST', body: payload, ...opts }); },
  getViewableUsers(opts) { return request('/api/users/viewable', opts); },
  getUserContracts(userId, opts) { return request(`/api/contracts/by-user/${enc(userId)}`, opts); },
  allocateContract(contractId, comment, opts) { return request(`/api/contracts/${enc(contractId)}/allocate`, { method:'POST', body:{ comment }, ...opts }); },
  allocateQuote(quoteId, comment, opts) { return request(`/api/quotes/${enc(quoteId)}/allocate`, { method:'POST', body:{ comment }, ...opts }); },
  getHomeSummaryFor(userId, opts) { return request(userId ? `/api/home/summary?user_id=${enc(userId)}` : '/api/home/summary', opts); },
  getPortfolioExport(opts) { return request('/api/home/portfolio-export', opts); },
  getRoles(opts) { return request(PATHS.authRoles, opts); },
  getUserMandate(userId, opts) { return request(`/api/auth/mandates/${enc(userId)}`, opts); },
  setUserMandate(userId, payload, opts) { return request(`/api/auth/mandates/${enc(userId)}`, { method: 'PUT', body: payload, ...opts }); },

  // AI / document text extraction
  aiComplete(payload, opts) { return request('/api/ai/complete', { method: 'POST', body: payload, ...opts }); },
  aiSlipIngest(payload, opts) { return request('/api/ai/slip-ingest', { method: 'POST', body: payload, ...opts }); },
  getDocumentText(docId, opts) { return request(`/api/documents/${enc(docId)}/text`, opts); },

  // Dashboard
  dashboardFilters(opts) { return request(PATHS.dashboardFilters, opts); },
  dashboardOverview(params = {}, opts) { return request(PATHS.dashboardOverview(toQuery(params)), opts); },
  dashboardPage(tab, params = {}, opts) { return request(PATHS.dashboardPage(tab, toQuery(params)), opts); },

  // ── Facultative ──────────────────────────────────────────────────────────
  facListClasses(opts) { return request('/api/fac/lookups/classes', opts); },
  facListMarketRates(params, opts) {
    const qs = toQuery(params);
    return request(`/api/fac/lookups/market-rates${qs ? '?' + qs : ''}`, opts);
  },
  facGetKpis(opts) { return request('/api/fac/kpis', opts); },
  facListRisks(params, opts) {
    const qs = toQuery(params);
    return request(`/api/fac/risks${qs ? '?' + qs : ''}`, opts);
  },
  facGetRisk(id, opts) { return request(`/api/fac/risks/${enc(id)}`, opts); },
  facCreateRisk(payload, opts) { return request('/api/fac/risks', { method: 'POST', body: payload, ...opts }); },
  facUpdateRisk(id, payload, opts) { return request(`/api/fac/risks/${enc(id)}`, { method: 'PUT', body: payload, ...opts }); },
  facDeleteRisk(id, opts) { return request(`/api/fac/risks/${enc(id)}`, { method: 'DELETE', ...opts }); },
  facGetLocations(id, opts) { return request(`/api/fac/risks/${enc(id)}/locations`, opts); },
  facSaveLocations(id, locations, opts) { return request(`/api/fac/risks/${enc(id)}/locations`, { method: 'PUT', body: { locations }, ...opts }); },
  facGetCope(id, opts) { return request(`/api/fac/risks/${enc(id)}/cope`, opts); },
  facSaveCope(id, payload, opts) { return request(`/api/fac/risks/${enc(id)}/cope`, { method: 'PUT', body: payload, ...opts }); },
  facGetLosses(id, opts) { return request(`/api/fac/risks/${enc(id)}/losses`, opts); },
  facSaveLosses(id, losses, opts) { return request(`/api/fac/risks/${enc(id)}/losses`, { method: 'PUT', body: { losses }, ...opts }); },
  facGetPricing(id, opts) { return request(`/api/fac/risks/${enc(id)}/pricing`, opts); },
  facSavePricing(id, payload, opts) { return request(`/api/fac/risks/${enc(id)}/pricing`, { method: 'PUT', body: payload, ...opts }); },
  facGetDocuments(id, opts) { return request(`/api/fac/risks/${enc(id)}/documents`, opts); },
  facUploadDocument(id, payload, opts) { return request(`/api/fac/risks/${enc(id)}/documents`, { method: 'POST', body: payload, ...opts }); },
  facDeleteDocument(docId, opts) { return request(`/api/fac/documents/${enc(docId)}`, { method: 'DELETE', ...opts }); },
  facGetLinkedTreaties(id, opts) { return request(`/api/fac/risks/${enc(id)}/linked-treaties`, opts); },

  // ── Facultative ↔ treaty links (per risk) ────────────────────────────────
  facGetEligibleTreaties(id, opts) {
    return request(`/api/fac/risks/${enc(id)}/eligible-treaties`, opts);
  },
  facGetTreatyLinks(id, opts) {
    return request(`/api/fac/risks/${enc(id)}/treaty-links`, opts);
  },
  facCreateTreatyLink(id, payload, opts) {
    return request(`/api/fac/risks/${enc(id)}/treaty-links`, { method: 'POST', body: payload, ...opts });
  },
  facDeleteTreatyLink(id, linkId, opts) {
    return request(`/api/fac/risks/${enc(id)}/treaty-links/${enc(linkId)}`, { method: 'DELETE', ...opts });
  },

  // ── Facultative underwriting factor selections (per risk) ────────────────
  facGetUwFactors(id, opts) { return request(`/api/fac/risks/${enc(id)}/uw-factors`, opts); },
  facSaveUwFactors(id, payload, opts) {
    return request(`/api/fac/risks/${enc(id)}/uw-factors`, { method: 'POST', body: payload, ...opts });
  },

  // ── Facultative clauses & exclusions checklist (per risk) ────────────────
  facGetClausesChecklist(id, opts) {
    return request(`/api/fac/risks/${enc(id)}/clauses-checklist`, opts);
  },
  facSaveClausesChecklist(id, payload, opts) {
    return request(`/api/fac/risks/${enc(id)}/clauses-checklist`, { method: 'POST', body: payload, ...opts });
  },

  // ── Facultative summary / approval workflow ──────────────────────────────
  facSubmitForApproval(id, payload, opts) {
    return request(`/api/fac/risks/${enc(id)}/submit-for-approval`, { method: 'POST', body: payload || {}, ...opts });
  },
  facDecline(id, payload, opts) {
    return request(`/api/fac/risks/${enc(id)}/decline`, { method: 'POST', body: payload, ...opts });
  },
  facBind(id, payload, opts) {
    return request(`/api/fac/risks/${enc(id)}/bind`, { method: 'POST', body: payload || {}, ...opts });
  },
  facGetAuditEvents(id, opts) {
    return request(`/api/fac/risks/${enc(id)}/audit-events`, opts);
  },

  // ── Facultative document AI ──────────────────────────────────────────────
  facAnalyseDocument(payload, opts) {
    return request('/api/ai/fac/analyse-document', { method: 'POST', body: payload, ...opts });
  },
  /**
   * Multipart upload (bytes + document_kind). The legacy facUploadDocument
   * only saves metadata — this variant actually stores the file so the
   * AI runner can read it back.
   * @param {string} id          fac_risk_id
   * @param {File}   file        DOM File object
   * @param {string} documentKind PLACEMENT_SLIP / SURVEY_REPORT / …
   */
  facUploadDocumentMultipart(id, file, documentKind, opts) {
    const form = new FormData();
    form.append('file', file);
    form.append('document_kind', documentKind || 'OTHER');
    // request() sends FormData as-is (no JSON body) when method=POST
    // and body is a FormData instance.
    return request(`/api/fac/risks/${enc(id)}/documents/upload`, {
      method: 'POST', body: form, ...opts,
    });
  },
  facGetAnalyses(id, opts) {
    return request(`/api/fac/risks/${enc(id)}/analyses`, opts);
  },
  facGetAnalysis(analysisId, opts) {
    return request(`/api/fac/analysis/${enc(analysisId)}`, opts);
  },
  facAcceptRecommendation(recId, payload, opts) {
    return request(`/api/fac/recommendation/${enc(recId)}/accept`, { method: 'POST', body: payload || {}, ...opts });
  },
  facRejectRecommendation(recId, payload, opts) {
    return request(`/api/fac/recommendation/${enc(recId)}/reject`, { method: 'POST', body: payload || {}, ...opts });
  },

  // ── Facultative reference data (cached via CACHEABLE_PATHS) ──────────────
  facGetOccupancies(opts)    { return request('/api/fac/reference/occupancies', opts); },
  facGetFactors(opts)        { return request('/api/fac/reference/factors', opts); },
  facGetFactorWeights(opts)  { return request('/api/fac/reference/factor-weights', opts); },
  facGetScoringTables(opts)  { return request('/api/fac/reference/scoring-tables', opts); },
  facGetBiIndemnity(opts)    { return request('/api/fac/reference/bi-indemnity', opts); },
  facGetNatcatRates(opts)    { return request('/api/fac/reference/natcat-rates', opts); },
  facGetClauses(opts)        { return request('/api/fac/reference/clauses', opts); },

  // ── Workbench (Actuarial Formula Workbench) ──────────────────────────────
  workbenchListFormulas(opts) { return request('/api/workbench/formulas', opts); },
  workbenchGetFormula(module, name, opts) {
    return request(`/api/workbench/formulas/${enc(module)}/${enc(name)}`, opts);
  },
  workbenchSubmitParameter(payload, opts) {
    return request('/api/workbench/parameters', { method: 'POST', body: payload, ...opts });
  },
  workbenchApproveParameter(id, comment, opts) {
    return request(`/api/workbench/parameters/${enc(id)}/approve`, { method: 'PUT', body: { comment }, ...opts });
  },
  workbenchRejectParameter(id, comment, opts) {
    return request(`/api/workbench/parameters/${enc(id)}/reject`, { method: 'PUT', body: { comment }, ...opts });
  },
  workbenchPostComment(payload, opts) {
    return request('/api/workbench/comments', { method: 'POST', body: payload, ...opts });
  },
};

export default api;
