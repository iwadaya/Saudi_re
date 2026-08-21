import { getAuthHeaders, getCsrfToken } from './utils/auth';
import { requirePasswordChange } from './utils/passwordGate';
import { httpFetch, HttpError } from './utils/httpClient.js';
import type {
  ContractBundle,
  CobLinkRow,
  CurvePoint,
  DevFactorSet,
  EgnpiYearRow,
  FacPricing,
  FacRisk,
  JsonValue,
  LossReportBundle,
  LossSaveResult,
  LossSelectionBundle,
  LossSelectionSaveResult,
  LossType,
  MarketAverageResult,
  NpExpiringBundle,
  NpHistoricalRow,
  NpPricingBundle,
  PricingBundle,
  PricingOutputs,
  PricingYearlyRow,
  ProfileBundle,
  QuoteStructure,
  SaveResult,
  StopLossPricingBundle,
  TriangleResponse,
  TriangleWithExclusions,
  Uuid,
} from './types/pricing';

// src/api.ts — Centralized API client for React app.
//
// Typed incrementally (docs/frontend-hardening.md Phase 1): the money path
// returns the canonical interfaces from types/pricing.ts, derived from the
// actual server responses. Endpoints whose shape has not been verified
// against server/src yet return `unknown` — that is deliberate honesty, not
// laziness: a typed lie in a pricing engine is worse than a forced narrow.
// When you need one of those shapes, verify it against the server route and
// promote it into types/pricing.ts.

/**
 * Options accepted by every api.* method. Deliberately a closed set —
 * unknown keys are usually typos (`ifUnmodifedSince`) that would silently
 * disable optimistic locking or quote routing.
 */
export interface RequestOpts {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
  signal?: AbortSignal | null;
  timeoutMs?: number;
  retry?: { attempts?: number; baseMs?: number; methods?: Set<string> };
  cache?: RequestCache;
  /** Standard fetch init pass-throughs. */
  credentials?: RequestCredentials;
  mode?: RequestMode;
  keepalive?: boolean;
  /** Route the call to the /api/quotes/... endpoint family. */
  quote?: boolean | string;
  /** Optimistic-lock guard; sent as the If-Unmodified-Since header. */
  ifUnmodifiedSince?: string;
  /** Internal: bypass the client-side ref-data cache. */
  _skipCache?: boolean;
}

type QueryParams = Record<string, string | number | boolean | null | undefined>;

// ── Client-side ref data cache (5-min TTL, LRU-bounded) ─────────────────────
// Prevents repeated identical fetches when navigating between wizard screens.
// Brokers, treaty types, COBs, countries, currencies are static — no need to
// re-fetch on every screen mount. Cache is cleared on logout.
//
// Map iteration order is insertion order, so the oldest key is always the
// first one yielded by .keys(). The cap is defensive — without it, a long
// session that fans out to many parameterised cacheable URLs (e.g.
// per-cedant fac references) could grow the map without bound.
const _clientCache = new Map<string, { promise: Promise<unknown>; expiresAt: number }>();
const CLIENT_CACHE_TTL = 5 * 60 * 1000; // 5 minutes
const CLIENT_CACHE_MAX = 500;

function clientCacheGet(key: string): Promise<unknown> | null {
  const entry = _clientCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) { _clientCache.delete(key); return null; }
  // Refresh LRU order: re-insert so this key is now the most recent.
  _clientCache.delete(key);
  _clientCache.set(key, entry);
  return entry.promise; // return the promise so concurrent callers share it
}
function clientCacheSet(key: string, promise: Promise<unknown>): Promise<unknown> {
  if (_clientCache.has(key)) _clientCache.delete(key);
  _clientCache.set(key, { promise, expiresAt: Date.now() + CLIENT_CACHE_TTL });
  while (_clientCache.size > CLIENT_CACHE_MAX) {
    const oldest = _clientCache.keys().next().value;
    if (oldest === undefined) break;
    _clientCache.delete(oldest);
  }
  return promise;
}
export function clearClientRefCache(): void { _clientCache.clear(); }

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
  // The rating-family registry is code, not data — it only changes on deploy.
  '/api/fac/reference/families',
]);

const API_BASE = (() => {
  try {
    const loc = window.location;
    const host = loc.hostname;
    const port = String(loc.port || '');
    if ((host === 'localhost' || host === '127.0.0.1') && port && port !== '4000') {
      return `http://${host}:4000`;
    }
  } catch { /* non-browser environment */ }
  return '';
})();

const PATHS = {
  homeSummary: '/api/home/summary',
  cedants: '/api/cedants',
  cedantSummary: (cedantId: string, uwYear?: string | number) => `/api/cedants/${enc(cedantId)}/cedant-summary${uwYear ? `?uw_year=${enc(uwYear)}` : ''}`,
  cedantNpLayers: (cedantId: string) => `/api/cedants/${enc(cedantId)}/np-layers`,
  cedantPortfolioRecs: (cedantId: string) => `/api/ai/cedant/${enc(cedantId)}/portfolio-recommendations`,
  cedantPortfolioRecsLatest: (cedantId: string) => `/api/ai/cedant/${enc(cedantId)}/portfolio-recommendations/latest`,
  cedantPortfolioRecReject: (recId: string) => `/api/ai/cedant/recommendation/${enc(recId)}/reject`,
  cedantStaging: (cedantId: string) => `/api/cedants/${enc(cedantId)}/staging`,
  cedantStagingDiscard: (cedantId: string, stagingId: string) => `/api/cedants/${enc(cedantId)}/staging/${enc(stagingId)}/discard`,
  cedantStagingCommitAll: (cedantId: string) => `/api/cedants/${enc(cedantId)}/staging/commit-all`,
  cedantStagingImpact: (cedantId: string) => `/api/cedants/${enc(cedantId)}/staging/portfolio-impact`,
  aiMarketGenerate: '/api/ai/market/generate-report',
  aiMarketLatest: (countryId: string, cobId: string, targetYear: string | number) =>
    `/api/ai/market/latest-report?country_id=${enc(countryId)}&class_of_business_id=${enc(cobId)}&target_year=${enc(targetYear)}`,
  aiMarketTreatyBenchmarks: (contractId: string, reportId?: string) =>
    `/api/ai/market/treaty-benchmarks/${enc(contractId)}${reportId ? `?report_id=${enc(reportId)}` : ''}`,
  aiMarketTreatyRecsGenerate: '/api/ai/market/treaty-recommendations',
  aiMarketTreatyRecsList: (contractId: string) => `/api/ai/market/treaty-recommendations/${enc(contractId)}`,
  aiMarketRecStage: (recId: string) => `/api/ai/market/recommendation/${enc(recId)}/stage`,
  aiMarketRecReject: (recId: string) => `/api/ai/market/recommendation/${enc(recId)}/reject`,
  aiMarketLogView: '/api/ai/market/log-view',
  aiMarketMacro: (countryId: string, opts?: { forceRefresh?: boolean }) => {
    const force = opts?.forceRefresh ? '?force_refresh=true' : '';
    return `/api/ai/market/macro/${enc(countryId)}${force}`;
  },
  reinsurers: '/api/reinsurers',
  brokers: '/api/brokers',
  classOfBusiness: '/api/class-of-business',
  treatyTypes: '/api/treaty-types',
  refListItems: (key: string) => `/api/ref/lists/${enc(key)}/items`,
  refCrestaZones: (countryId: string) => `/api/ref/cresta-zones/${enc(countryId)}`,
  refInflation: (countryId: string, startYear?: string | number, endYear?: string | number) => {
    const qs: string[] = [];
    if (startYear) qs.push(`start_year=${enc(startYear)}`);
    if (endYear) qs.push(`end_year=${enc(endYear)}`);
    return `/api/ref/inflation/${enc(countryId)}${qs.length ? `?${qs.join('&')}` : ''}`;
  },
  refBenchmarkLdf: (countryId: string) => `/api/ref/benchmark-ldf/${enc(countryId)}`,
  exchangeRates: '/api/ref/exchange-rates',
  exchangeRate: (code: string) => `/api/ref/exchange-rates/${enc(code)}`,
  swissReCurves: '/api/ref/swiss-re-curves',
  swissReCurve: (name: string) => `/api/ref/swiss-re-curves/${enc(name)}`,
  treaties: '/api/treaties',
  treaty: (id: string) => `/api/treaties/${enc(id)}`,
  treatyRenew: (id: string) => `/api/treaties/${enc(id)}/renew`,
  nonPropTreaty: (id: string) => `/api/treaties/${enc(id)}/non-prop`,
  nonPropTreatySave: (id: string) => `/api/treaties/${enc(id)}/non-prop/save`,
  npEgnpiYear: (id: string) => `/api/treaties/${enc(id)}/np/egnpi-year`,
  npHistoricalPerformance: (id: string) => `/api/treaties/${enc(id)}/np/historical-performance`,
  npStopLossPricing: (id: string) => `/api/treaties/${enc(id)}/np/stop-loss-pricing`,
  npLargeLossLdfs: (id: string) => `/api/treaties/${enc(id)}/np/large-loss-ldfs`,
  npCatLossLdfs: (id: string) => `/api/treaties/${enc(id)}/np/cat-loss-ldfs`,
  triangle: (id: string, type: string) => `/api/treaties/${enc(id)}/triangles/${enc(type)}`,
  triangleWithExclusions: (id: string, type: string) => `/api/treaties/${enc(id)}/triangles/${enc(type)}/with-exclusions`,
  treatyDocuments: (id: string) => `/api/treaties/${enc(id)}/documents`,
  wordingChecklist: (id: string) => `/api/treaties/${enc(id)}/wording-checklist`,
  wordingChecklistAi: (id: string) => `/api/treaties/${enc(id)}/wording-checklist/ai-check`,
  documentDownload: (docId: string) => `/api/documents/${enc(docId)}/download`,
  documentView: (docId: string) => `/api/documents/${enc(docId)}/view`,
  deleteDocument: (docId: string) => `/api/documents/${enc(docId)}`,
  largeLosses: (id: string) => `/api/treaties/${enc(id)}/large-losses`,
  catLosses: (id: string) => `/api/treaties/${enc(id)}/cat-losses`,
  stripLargeCat: (id: string) => `/api/treaties/${enc(id)}/strip-large-cat`,
  portfolioLosses: (id: string, lossType: string) => `/api/treaties/${enc(id)}/portfolio-losses/${enc(lossType)}`,
  suggestLossQuarters: (id: string) => `/api/treaties/${enc(id)}/losses/suggest-quarters`,
  treatyCobs: (id: string) => `/api/treaties/${enc(id)}/cobs`,
  riskProfile: (id: string, cobId: string) => `/api/treaties/${enc(id)}/risk-profiles/${enc(cobId)}`,
  claimsProfile: (id: string, cobId: string) => `/api/treaties/${enc(id)}/claims-profiles/${enc(cobId)}`,
  crestaData: (id: string) => `/api/treaties/${enc(id)}/cresta`,
  cedantExposure: (id: string) => `/api/treaties/${enc(id)}/cedant-exposure`,
  devFactors: (id: string, type: string) => `/api/treaties/${enc(id)}/dev-factors/${enc(type)}`,
  devFactorStaleness: (id: string, type: string) => `/api/treaties/${enc(id)}/dev-factors/${enc(type)}/staleness`,
  lossesStaleness: (id: string) => `/api/treaties/${enc(id)}/losses/staleness`,
  pricingSave: '/api/pricing/save',
  pricing: (id: string) => `/api/treaties/${enc(id)}/pricing`,
  pricingOutputs: (id: string) => `/api/treaties/${enc(id)}/pricing-outputs`,
  pricingYearly: (id: string) => `/api/treaties/${enc(id)}/pricing-yearly`,
  countryAggregates: (countryId: string) => `/api/aggregates/country/${enc(countryId)}`,
  marketAverage: (countryId: string, excludeId?: string) => `/api/pricing/market-average/${enc(countryId)}${excludeId ? `?exclude=${enc(excludeId)}` : ''}`,
  componentSnapshot: (id: string) => `/api/pricing/${enc(id)}/component-snapshot`,
  componentSnapshots: (id: string) => `/api/pricing/${enc(id)}/component-snapshots`,
  deleteComponentSnapshot: (snapId: string) => `/api/pricing/component-snapshot/${enc(snapId)}`,
  straightStatsSave: '/api/straight-stats/save',
  straightStatsLoad: (id: string) => `/api/straight-stats/load/${enc(id)}`,
  decline: (id: string) => `/api/treaties/${enc(id)}/decline`,
  offer: (id: string) => `/api/treaties/${enc(id)}/offer`,
  offerSubmit: (id: string) => `/api/treaties/${enc(id)}/offer/submit-for-approval`,
  offerApproved: (id: string) => `/api/treaties/${enc(id)}/offer/mark-approved`,
  offerReturn: (id: string) => `/api/treaties/${enc(id)}/offer/return-to-underwriter`,
  offerSigned: (id: string) => `/api/treaties/${enc(id)}/offer/mark-signed`,
  offerNtu: (id: string) => `/api/treaties/${enc(id)}/offer/ntu`,
  npPricing: (id: string) => `/api/treaties/${enc(id)}/np-pricing`,
  npExpiring: (id: string) => `/api/treaties/${enc(id)}/np/expiring`,
  // Claims module
  claims: '/api/claims',
  claimsSummary: '/api/claims/summary',
  claimsEligibleContracts: '/api/claims/eligible-contracts',
  claim: (id: string) => `/api/claims/${enc(id)}`,
  claimMovements: (id: string) => `/api/claims/${enc(id)}/movements`,
  claimClose: (id: string) => `/api/claims/${enc(id)}/close`,
  claimDecline: (id: string) => `/api/claims/${enc(id)}/decline`,
  claimReopen: (id: string) => `/api/claims/${enc(id)}/reopen`,
  claimSubmit: (id: string) => `/api/claims/${enc(id)}/submit`,
  claimApprove: (id: string) => `/api/claims/${enc(id)}/approve`,
  claimReject: (id: string) => `/api/claims/${enc(id)}/reject`,
  claimNotes: (id: string) => `/api/claims/${enc(id)}/notes`,
  claimDocuments: (id: string) => `/api/claims/${enc(id)}/documents`,
  claimDocumentDownload: (docId: string) => `/api/claims/documents/${enc(docId)}/download`,
  claimDocumentView: (docId: string) => `/api/claims/documents/${enc(docId)}/view`,
  claimDocumentDelete: (docId: string) => `/api/claims/documents/${enc(docId)}`,
  // Finance module
  financeTreaties: '/api/finance/treaties',
  financeSummary: '/api/finance/summary',
  financeEntry: (id: string) => `/api/finance/entries/${enc(id)}`,
  financeAcknowledge: (id: string) => `/api/finance/entries/${enc(id)}/acknowledge`,
  financeStatus: (id: string) => `/api/finance/entries/${enc(id)}/status`,
  mandateCheck: '/api/auth/mandate-check',
  authLogin: '/api/auth/login',
  authNameLogin: '/api/auth/name-login',
  authNameLoginStatus: '/api/auth/name-login/status',
  authLogout: '/api/auth/logout',
  authChangePassword: '/api/auth/change-password',
  authMe: '/api/auth/me',
  authSsoStatus: '/api/auth/sso/status',
  authUsers: '/api/auth/users',
  authRoles: '/api/auth/roles',
  dashboardFilters: '/api/dashboard/filters',
  dashboardOverview: (qs = '') => `/api/dashboard/overview${qs ? `?${qs}` : ''}`,
  dashboardPage: (tab?: string, qs = '') => `/api/dashboard/page/${enc(tab || 'portfolio-overview')}${qs ? `?${qs}` : ''}`,
  lossSelectionLatest: (id: string, lossType: string) => `/api/treaties/${enc(id)}/loss-selection/${enc(lossType)}/latest`,
  saveLossSelectionSnapshot: (id: string, lossType: string) => `/api/treaties/${enc(id)}/loss-selection/${enc(lossType)}/snapshot`,
};

const QUOTE_PATHS = {
  quotes: '/api/quotes',
  quote: (id: string) => `/api/quotes/${enc(id)}`,
  quoteRenew: (id: string) => `/api/quotes/${enc(id)}/renew`,
  nonPropQuote: (id: string) => `/api/quotes/${enc(id)}/non-prop`,
  nonPropQuoteSave: (id: string) => `/api/quotes/${enc(id)}/non-prop/save`,
  npEgnpiYear: (id: string) => `/api/quotes/${enc(id)}/np/egnpi-year`,
  npHistoricalPerformance: (id: string) => `/api/quotes/${enc(id)}/np/historical-performance`,
  npStopLossPricing: (id: string) => `/api/quotes/${enc(id)}/np/stop-loss-pricing`,
  npLargeLossLdfs: (id: string) => `/api/quotes/${enc(id)}/np/large-loss-ldfs`,
  npCatLossLdfs: (id: string) => `/api/quotes/${enc(id)}/np/cat-loss-ldfs`,
  triangle: (id: string, type: string) => `/api/quotes/${enc(id)}/triangles/${enc(type)}`,
  triangleWithExclusions: (id: string, type: string) => `/api/quotes/${enc(id)}/triangles/${enc(type)}/with-exclusions`,
  quoteDocuments: (id: string) => `/api/quotes/${enc(id)}/documents`,
  quoteWordingChecklist: (id: string) => `/api/quotes/${enc(id)}/wording-checklist`,
  quoteWordingChecklistAi: (id: string) => `/api/quotes/${enc(id)}/wording-checklist/ai-check`,
  largeLosses: (id: string) => `/api/quotes/${enc(id)}/large-losses`,
  catLosses: (id: string) => `/api/quotes/${enc(id)}/cat-losses`,
  stripLargeCat: (id: string) => `/api/quotes/${enc(id)}/strip-large-cat`,
  suggestLossQuarters: (id: string) => `/api/quotes/${enc(id)}/losses/suggest-quarters`,
  quoteCobs: (id: string) => `/api/quotes/${enc(id)}/cobs`,
  riskProfile: (id: string, cobId: string) => `/api/quotes/${enc(id)}/risk-profiles/${enc(cobId)}`,
  claimsProfile: (id: string, cobId: string) => `/api/quotes/${enc(id)}/claims-profiles/${enc(cobId)}`,
  crestaData: (id: string) => `/api/quotes/${enc(id)}/cresta`,
  cedantExposure: (id: string) => `/api/quotes/${enc(id)}/cedant-exposure`,
  devFactors: (id: string, type: string) => `/api/quotes/${enc(id)}/dev-factors/${enc(type)}`,
  devFactorStaleness: (id: string, type: string) => `/api/quotes/${enc(id)}/dev-factors/${enc(type)}/staleness`,
  lossesStaleness: (id: string) => `/api/quotes/${enc(id)}/losses/staleness`,
  pricing: (id: string) => `/api/quotes/${enc(id)}/pricing`,
  pricingOutputs: (id: string) => `/api/quotes/${enc(id)}/pricing-outputs`,
  pricingYearly: (id: string) => `/api/quotes/${enc(id)}/pricing-yearly`,
  npPricing: (id: string) => `/api/quotes/${enc(id)}/np-pricing`,
  npExpiring: (id: string) => `/api/quotes/${enc(id)}/np/expiring`,
  lossSelectionLatest: (id: string, lossType: string) => `/api/quotes/${enc(id)}/loss-selection/${enc(lossType)}/latest`,
  saveLossSelectionSnapshot: (id: string, lossType: string) => `/api/quotes/${enc(id)}/loss-selection/${enc(lossType)}/snapshot`,
  decline: (id: string) => `/api/quotes/${enc(id)}/decline`,
  offerSubmit: (id: string) => `/api/quotes/${enc(id)}/offer/submit-for-approval`,
  offerApproved: (id: string) => `/api/quotes/${enc(id)}/offer/mark-approved`,
  offerReturn: (id: string) => `/api/quotes/${enc(id)}/offer/return-to-underwriter`,
  offerSigned: (id: string) => `/api/quotes/${enc(id)}/offer/mark-signed`,
  offerNtu: (id: string) => `/api/quotes/${enc(id)}/offer/ntu`,
};

function enc(v: string | number | boolean): string { return encodeURIComponent(v); }

function isQuoteMode(opts?: RequestOpts): boolean {
  return opts?.quote === true || opts?.quote === 'true' || opts?.quote === '1';
}

function withOptimisticLockHeader(opts?: RequestOpts): RequestOpts | undefined {
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

function toQuery(params?: QueryParams): string {
  const entries = Object.entries(params || {}).filter(([, v]) => v !== undefined && v !== null && v !== '');
  return entries.length ? entries.map(([k, v]) => `${enc(k)}=${enc(v as string | number | boolean)}`).join('&') : '';
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
 *
 * The generic T is a caller-asserted shape: the server is trusted to return
 * what the route contract says (see types/pricing.ts). Non-JSON responses
 * resolve to the raw text.
 */
async function request<T = unknown>(path: string, opts: RequestOpts = {}): Promise<T> {
  const {
    method = 'GET', body, headers: extraHeaders, _skipCache,
    signal, timeoutMs, retry, cache,
    ...rest
  } = opts;

  // GET dedup + cache for static reference data
  if (method === 'GET' && !_skipCache && CACHEABLE_PATHS.has(path)) {
    const cached = clientCacheGet(path);
    if (cached) return cached as Promise<T>;
    const promise = request<T>(path, { method, body, headers: extraHeaders, _skipCache: true, signal, timeoutMs, retry, ...rest });
    return clientCacheSet(path, promise) as Promise<T>;
  }

  const url = `${API_BASE}${path}`;
  const headers: Record<string, string> = { ...getAuthHeaders(), ...extraHeaders };
  const upperMethod = String(method).toUpperCase();
  const bypassBrowserCache = cache === undefined && upperMethod === 'GET';
  if (bypassBrowserCache) {
    headers['Cache-Control'] = headers['Cache-Control'] || 'no-cache';
    headers.Pragma = headers.Pragma || 'no-cache';
  }
  // CSRF double-submit: echo the readable csrf cookie on state-changing requests
  // (GETs are exempt server-side). A caller-supplied header wins.
  if (upperMethod !== 'GET' && upperMethod !== 'HEAD'
      && !('X-CSRF-Token' in headers) && !('x-csrf-token' in headers)) {
    const csrf = getCsrfToken();
    if (csrf) headers['X-CSRF-Token'] = csrf;
  }
  const init: Record<string, unknown> = {
    method,
    headers,
    signal,
    timeoutMs,
    retry,
    // Send the httpOnly auth cookie on every request (same-origin in prod,
    // CORS-credentialed cross-origin in dev). A caller can override via opts.
    credentials: 'include',
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

  let res: Response;
  try {
    res = await httpFetch(url, init);
  } catch (err) {
    // 423 PWD_CHANGE_REQUIRED → the server's forced-change gate. Flip the client
    // gate so the mandatory "Set your password" modal appears (covers a stale
    // session whose token still carries the flag), then rethrow for the caller.
    if ((err as { status?: number })?.status === 423) {
      try { requirePasswordChange(); } catch { /* non-React/test context */ }
    }
    throw err;
  }
  const ct = res.headers.get('content-type') || '';
  if (ct.includes('application/json')) return res.json() as Promise<T>;
  return res.text() as Promise<T>;
}

// Re-export for callers that want to discriminate on error.status
export { HttpError };

// ── Shapes for the async renewal-pack import flow ───────────────────────────

/** The outward retro contract for one underwriting year and currency. */
export interface RetroProgramme {
  retro_programme_id: string;
  uw_year: number;
  currency: string;
  label: string | null;
  reinsurer: string | null;
  inception_date: string | null;
  expiry_date: string | null;
  retention_amt: number;
  limit_amt: number;
  rol_pct: number;
  used_limit_amt: number;
  cession_pct: number;
  commission_pct: number;
  max_line_pct: number;
  notes: string | null;
  is_active: boolean;
  created_at?: string;
  updated_at?: string;
  created_by?: string | null;
  updated_by?: string | null;
}

/** Lookup result — an exact (year, currency) match, or null plus what does exist. */
export interface RetroProgrammeLookup {
  programme: RetroProgramme | null;
  year: number;
  currency: string;
  availableCurrencies: string[];
}

export interface RenewalImportStarted { jobId: string }
export type RenewalImportJobStatus =
  | { status: 'processing' }
  | { status: 'done'; filledPages?: number; warnings?: unknown[]; unmatchedCresta?: unknown[]; restorePointId?: string }
  | { status: 'failed'; error?: string };
export interface ActiveRenewalImport {
  activeJob: { jobId: string; documentId: string; startedAt: string } | null;
}
export interface ImportSnapshot {
  id: string;
  capturedAt: string;
  filename?: string | null;
  filledPages?: number | null;
  documentId?: string | null;
  restorable?: boolean;
  restoredAt?: string | null;
}

// Public API object
export const api = {
  // ── Claims module ──────────────────────────────────────────────────────────
  listClaims(filters: { status?: string; approvalStatus?: string; contractId?: string; lossType?: string; q?: string } = {}, opts?: RequestOpts): Promise<unknown> {
    const params = new URLSearchParams();
    if (filters.status) params.set('status', filters.status);
    if (filters.approvalStatus) params.set('approval_status', filters.approvalStatus);
    if (filters.contractId) params.set('contract_id', filters.contractId);
    if (filters.lossType) params.set('loss_type', filters.lossType);
    if (filters.q) params.set('q', filters.q);
    const qs = params.toString();
    return request(`${PATHS.claims}${qs ? '?' + qs : ''}`, opts);
  },
  getClaimsSummary(opts?: RequestOpts): Promise<unknown> { return request(PATHS.claimsSummary, opts); },
  getClaimsEligibleContracts(filters: { countryId?: string; cedantId?: string; uwYear?: string | number; q?: string } = {}, opts?: RequestOpts): Promise<unknown> {
    const params = new URLSearchParams();
    if (filters.countryId) params.set('country_id', filters.countryId);
    if (filters.cedantId) params.set('cedant_id', filters.cedantId);
    if (filters.uwYear != null && filters.uwYear !== '') params.set('uw_year', String(filters.uwYear));
    if (filters.q) params.set('q', filters.q);
    const qs = params.toString();
    return request(`${PATHS.claimsEligibleContracts}${qs ? '?' + qs : ''}`, opts);
  },
  getClaim(id: string, opts?: RequestOpts): Promise<unknown> { return request(PATHS.claim(id), opts); },
  createClaim(body: unknown, opts?: RequestOpts): Promise<unknown> { return request(PATHS.claims, { ...opts, method: 'POST', body }); },
  updateClaim(id: string, body: unknown, opts?: RequestOpts): Promise<unknown> { return request(PATHS.claim(id), { ...opts, method: 'PUT', body }); },
  bookClaimMovement(id: string, body: unknown, opts?: RequestOpts): Promise<unknown> { return request(PATHS.claimMovements(id), { ...opts, method: 'POST', body }); },
  closeClaim(id: string, reason?: string, opts?: RequestOpts): Promise<unknown> { return request(PATHS.claimClose(id), { ...opts, method: 'POST', body: { reason } }); },
  declineClaim(id: string, reason?: string, opts?: RequestOpts): Promise<unknown> { return request(PATHS.claimDecline(id), { ...opts, method: 'POST', body: { reason } }); },
  reopenClaim(id: string, reason?: string, opts?: RequestOpts): Promise<unknown> { return request(PATHS.claimReopen(id), { ...opts, method: 'POST', body: { reason } }); },
  submitClaim(id: string, reason?: string, opts?: RequestOpts): Promise<unknown> { return request(PATHS.claimSubmit(id), { ...opts, method: 'POST', body: { reason } }); },
  approveClaim(id: string, reason?: string, opts?: RequestOpts): Promise<unknown> { return request(PATHS.claimApprove(id), { ...opts, method: 'POST', body: { reason } }); },
  rejectClaim(id: string, reason?: string, opts?: RequestOpts): Promise<unknown> { return request(PATHS.claimReject(id), { ...opts, method: 'POST', body: { reason } }); },
  addClaimNote(id: string, note: string, opts?: RequestOpts): Promise<unknown> { return request(PATHS.claimNotes(id), { ...opts, method: 'POST', body: { note } }); },
  uploadClaimDocument(id: string, formData: FormData, opts?: RequestOpts): Promise<unknown> { return request(PATHS.claimDocuments(id), { ...opts, method: 'POST', body: formData }); },
  deleteClaimDocument(docId: string, opts?: RequestOpts): Promise<unknown> { return request(PATHS.claimDocumentDelete(docId), { ...opts, method: 'DELETE' }); },
  getClaimDocumentDownloadUrl(docId: string): string { return `${API_BASE}${PATHS.claimDocumentDownload(docId)}`; },
  getClaimDocumentViewUrl(docId: string): string { return `${API_BASE}${PATHS.claimDocumentView(docId)}`; },

  // ── Finance module ─────────────────────────────────────────────────────────
  listFinanceTreaties(status?: string, opts?: RequestOpts): Promise<unknown> {
    return request(status ? `${PATHS.financeTreaties}?status=${enc(status)}` : PATHS.financeTreaties, opts);
  },
  getFinanceSummary(opts?: RequestOpts): Promise<unknown> { return request(PATHS.financeSummary, opts); },
  getFinanceEntry(id: string, opts?: RequestOpts): Promise<unknown> { return request(PATHS.financeEntry(id), opts); },
  acknowledgeFinanceEntry(id: string, opts?: RequestOpts): Promise<unknown> { return request(PATHS.financeAcknowledge(id), { ...opts, method: 'POST', body: {} }); },
  setFinanceEntryStatus(id: string, status: string, notes?: string, opts?: RequestOpts): Promise<unknown> { return request(PATHS.financeStatus(id), { ...opts, method: 'POST', body: { status, notes } }); },

  // Home
  getHomeSummary(opts?: RequestOpts & { scope?: 'mine' | 'all' }): Promise<unknown> {
    const { scope, ...rest } = opts || {};
    return request(scope ? `${PATHS.homeSummary}?scope=${enc(scope)}` : PATHS.homeSummary, rest);
  },

  // Lookups
  listCedants(opts: RequestOpts & { countryId?: string } = {}): Promise<unknown> {
    const params = new URLSearchParams();
    if (opts.countryId) params.set('country_id', opts.countryId);
    const qs = params.toString();
    return request(`${PATHS.cedants}${qs ? '?' + qs : ''}`);
  },
  getCedantSummary(cedantId: string, uwYear?: string | number, opts?: RequestOpts): Promise<unknown> { return request(PATHS.cedantSummary(cedantId, uwYear), opts); },
  getCedantNpLayers(cedantId: string, opts?: RequestOpts): Promise<unknown> { return request(PATHS.cedantNpLayers(cedantId), opts); },
  generateCedantPortfolioRecs(cedantId: string, body?: unknown, opts?: RequestOpts): Promise<unknown> {
    return request(PATHS.cedantPortfolioRecs(cedantId), { ...opts, method: 'POST', body });
  },
  getCedantPortfolioRecsLatest(cedantId: string, opts?: RequestOpts): Promise<unknown> {
    return request(PATHS.cedantPortfolioRecsLatest(cedantId), opts);
  },
  rejectCedantPortfolioRec(recId: string, body?: unknown, opts?: RequestOpts): Promise<unknown> {
    return request(PATHS.cedantPortfolioRecReject(recId), { ...opts, method: 'POST', body: body || {} });
  },
  stageLineChange(cedantId: string, body?: unknown, opts?: RequestOpts): Promise<unknown> {
    return request(PATHS.cedantStaging(cedantId), { ...opts, method: 'POST', body });
  },
  discardStagedChange(cedantId: string, stagingId: string, body?: unknown, opts?: RequestOpts): Promise<unknown> {
    return request(PATHS.cedantStagingDiscard(cedantId, stagingId), { ...opts, method: 'POST', body: body || {} });
  },
  commitStagedChanges(cedantId: string, body?: unknown, opts?: RequestOpts): Promise<unknown> {
    return request(PATHS.cedantStagingCommitAll(cedantId), { ...opts, method: 'POST', body: body || {} });
  },
  getStaging(cedantId: string, includeOpts?: { include?: string[] }, opts?: RequestOpts): Promise<unknown> {
    const include = Array.isArray(includeOpts?.include) ? `?include=${enc(includeOpts.include.join(','))}` : '';
    return request(`${PATHS.cedantStaging(cedantId)}${include}`, opts);
  },
  getStagingImpact(cedantId: string, opts?: RequestOpts): Promise<unknown> {
    return request(PATHS.cedantStagingImpact(cedantId), opts);
  },
  generateMarketReport(body?: unknown, opts?: RequestOpts): Promise<unknown> {
    return request(PATHS.aiMarketGenerate, { ...opts, method: 'POST', body });
  },
  getLatestMarketReport(countryId: string, cobId: string, targetYear: string | number, opts?: RequestOpts): Promise<unknown> {
    return request(PATHS.aiMarketLatest(countryId, cobId, targetYear), opts);
  },
  getTreatyBenchmarks(contractId: string, reportId?: string, opts?: RequestOpts): Promise<unknown> {
    return request(PATHS.aiMarketTreatyBenchmarks(contractId, reportId), opts);
  },
  generateTreatyRecommendations(body?: unknown, opts?: RequestOpts): Promise<unknown> {
    return request(PATHS.aiMarketTreatyRecsGenerate, { ...opts, method: 'POST', body });
  },
  getTreatyRecommendations(contractId: string, opts?: RequestOpts): Promise<unknown> {
    return request(PATHS.aiMarketTreatyRecsList(contractId), opts);
  },
  stageMarketRec(recId: string, body?: unknown, opts?: RequestOpts): Promise<unknown> {
    return request(PATHS.aiMarketRecStage(recId), { ...opts, method: 'POST', body: body || {} });
  },
  rejectMarketRec(recId: string, body?: unknown, opts?: RequestOpts): Promise<unknown> {
    return request(PATHS.aiMarketRecReject(recId), { ...opts, method: 'POST', body: body || {} });
  },
  logMarketReportView(body?: unknown, opts?: RequestOpts): Promise<unknown> {
    return request(PATHS.aiMarketLogView, { ...opts, method: 'POST', body });
  },
  // Open-source macro snapshot (World Bank + IMF). Cached server-side
  // for 30 days; { forceRefresh: true } bypasses.
  getCountryMacro(countryId: string, opts?: RequestOpts & { forceRefresh?: boolean }): Promise<unknown> {
    return request(PATHS.aiMarketMacro(countryId, opts), opts);
  },
  // Per-structure peer benchmark pool (real portfolio treaties scoped
  // by country/region/global, optionally filtered to a COB overlap).
  // Feeds FQBenchmarkModal's medians, percentiles, and scatter plots.
  getPeerStructures(contractId: string, { scope = 'country', cobIds = [] }: { scope?: string; cobIds?: string[] } = {}, opts?: RequestOpts): Promise<unknown> {
    const qs = new URLSearchParams({ scope });
    if (Array.isArray(cobIds) && cobIds.length) qs.set('cobIds', cobIds.join(','));
    return request(`/api/treaties/${enc(contractId)}/peer-structures?${qs.toString()}`, opts);
  },
  // Portfolio-wide reinsurer pricing cloud (one point per NP layer, attributed
  // to the treaty's lead reinsurer). Feeds the reinsurer power-law analysis.
  getReinsurerAnalysis(opts?: RequestOpts): Promise<unknown> {
    return request('/api/reinsurer-analysis', opts);
  },
  // Decisioned-book feature feed for the Portfolio Intelligence module
  // (driver ranking + unsupervised segmentation, computed client-side).
  getPortfolioInsights(opts?: RequestOpts): Promise<unknown> {
    return request('/api/portfolio-insights', opts);
  },
  // Optional AI commentary on a single structure's positioning vs the
  // peer pool. The peer fetch above must succeed first; this endpoint
  // is fire-on-demand so we don't burn OpenAI tokens on every modal open.
  generateStructureCommentary(payload?: unknown, opts?: RequestOpts): Promise<unknown> {
    return request('/api/ai/market/structure-commentary', { method: 'POST', body: payload, timeoutMs: 60000, ...opts });
  },
  listBrokers(opts?: RequestOpts): Promise<unknown> { return request(PATHS.brokers, opts); },
  listReinsurers(opts?: RequestOpts): Promise<unknown> { return request(PATHS.reinsurers, opts); },
  listTreatyTypes(opts?: RequestOpts): Promise<unknown> { return request(PATHS.treatyTypes, opts); },
  listClassOfBusiness(opts?: RequestOpts): Promise<unknown> { return request(PATHS.classOfBusiness, opts); },
  getRefListItems(key: string, opts?: RequestOpts): Promise<unknown> { return request(PATHS.refListItems(key), opts); },
  getRefCrestaZones(countryId: string, opts?: RequestOpts): Promise<unknown> { return request(PATHS.refCrestaZones(countryId), opts); },
  getRefInflation(countryId: string, startYear?: string | number, endYear?: string | number, opts?: RequestOpts): Promise<unknown> { return request(PATHS.refInflation(countryId, startYear, endYear), opts); },
  getRefBenchmarkLdf(countryId: string, opts?: RequestOpts): Promise<unknown> { return request(PATHS.refBenchmarkLdf(countryId), opts); },
  getExchangeRates(opts?: RequestOpts): Promise<unknown> { return request(PATHS.exchangeRates, opts); },
  getExchangeRate(code: string, opts?: RequestOpts): Promise<unknown> { return request(PATHS.exchangeRate(code), opts); },
  saveExchangeRate(code: string, payload?: unknown, opts?: RequestOpts): Promise<unknown> { return request(PATHS.exchangeRate(code), { method: 'PUT', body: payload, ...opts }); },
  getSwissReCurves(opts?: RequestOpts): Promise<string[]> { return request<string[]>(PATHS.swissReCurves, opts); },
  getSwissReCurve(name: string, opts?: RequestOpts): Promise<CurvePoint[]> { return request<CurvePoint[]>(PATHS.swissReCurve(name), opts); },

  // Contracts
  createContract(payload?: unknown, opts?: RequestOpts): Promise<unknown> { return request(PATHS.treaties, { method: 'POST', body: payload, ...opts }); },
  listContracts(params?: QueryParams, opts?: RequestOpts): Promise<unknown> {
    const qs = toQuery(params);
    return request(`${PATHS.treaties}${qs ? `?${qs}` : ''}`, opts);
  },
  getContract(id: string, opts?: RequestOpts): Promise<ContractBundle> { return request<ContractBundle>(isQuoteMode(opts) ? QUOTE_PATHS.quote(id) : PATHS.treaty(id), opts); },
  saveContract(id: string, payload?: unknown, opts?: RequestOpts): Promise<SaveResult & { contract_id?: Uuid }> {
    const requestOpts = withOptimisticLockHeader(opts);
    return request(isQuoteMode(opts) ? QUOTE_PATHS.quote(id) : PATHS.treaty(id), { method: 'PUT', body: payload, ...requestOpts });
  },
  deleteContract(id: string, opts?: RequestOpts): Promise<{ ok: boolean; deleted?: Uuid }> { return request(isQuoteMode(opts) ? QUOTE_PATHS.quote(id) : PATHS.treaty(id), { method: 'DELETE', ...opts }); },
  renewContract(id: string, opts?: RequestOpts): Promise<unknown> { return request(isQuoteMode(opts) ? QUOTE_PATHS.quoteRenew(id) : PATHS.treatyRenew(id), { method: 'POST', ...opts }); },

  // Quotes
  createQuote(payload?: unknown, opts?: RequestOpts): Promise<unknown> { return request(QUOTE_PATHS.quotes, { method: 'POST', body: payload, ...opts }); },
  // Quote lifecycle
  amendQuote(id: string, payload?: unknown, opts?: RequestOpts): Promise<unknown>   { return request(`/api/quotes/${enc(id)}/amend`,    { method: 'POST', body: payload || {}, ...opts }); },
  bindQuote(id: string, payload?: unknown, opts?: RequestOpts): Promise<unknown>    { return request(`/api/quotes/${enc(id)}/bind`,     { method: 'POST', body: payload || {}, ...opts }); },
  getQuoteVersions(id: string, opts?: RequestOpts): Promise<unknown>      { return request(`/api/quotes/${enc(id)}/versions`, opts); },
  getQuoteNegotiationHistory(id: string, opts?: RequestOpts): Promise<unknown> { return request(`/api/quotes/${enc(id)}/negotiation-history`, opts); },
  listQuotes(params?: QueryParams, opts?: RequestOpts): Promise<unknown> {
    const qs = toQuery(params);
    return request(`${QUOTE_PATHS.quotes}${qs ? `?${qs}` : ''}`, opts);
  },

  // Triangles
  getTriangle(id: string, type: string, opts?: RequestOpts & { variant?: 'ACTUAL' | 'MODIFIED' | (string & {}) }): Promise<TriangleResponse> {
    // `variant` (ACTUAL/MODIFIED) is optional — when absent the server defaults
    // to MODIFIED (no client-side default). Strip it from opts so it rides the
    // URL, not the fetch init.
    const { variant, ...rest } = opts || {};
    const base = isQuoteMode(rest) ? QUOTE_PATHS.triangle(id, type) : PATHS.triangle(id, type);
    return request<TriangleResponse>(variant ? `${base}?variant=${enc(variant)}` : base, rest);
  },
  getTriangleWithExclusions(id: string, type: string, opts?: RequestOpts): Promise<TriangleWithExclusions> { return request<TriangleWithExclusions>(isQuoteMode(opts) ? QUOTE_PATHS.triangleWithExclusions(id, type) : PATHS.triangleWithExclusions(id, type), opts); },
  saveTriangle(id: string, type: string, payload?: unknown, opts?: RequestOpts & { variant?: 'ACTUAL' | 'MODIFIED' | (string & {}) }): Promise<unknown> {
    // `variant` goes in the POST body (server reads req.body.variant); absent =
    // MODIFIED server-side. Strip it from opts so it isn't spread into fetch init.
    const { variant, ...rest } = opts || {};
    const path = isQuoteMode(rest) ? QUOTE_PATHS.triangle(id, type) : PATHS.triangle(id, type);
    const body = variant ? { ...(payload as Record<string, unknown>), variant } : payload;
    return request(path, { method: 'POST', body, ...rest });
  },

  // Dev factors
  getDevFactors(id: string, type: string, opts?: RequestOpts): Promise<DevFactorSet> { return request<DevFactorSet>(isQuoteMode(opts) ? QUOTE_PATHS.devFactors(id, type) : PATHS.devFactors(id, type), opts); },
  saveDevFactors(id: string, type: string, payload?: unknown, opts?: RequestOpts): Promise<SaveResult> { return request<SaveResult>(isQuoteMode(opts) ? QUOTE_PATHS.devFactors(id, type) : PATHS.devFactors(id, type), { method: 'PUT', body: payload, ...opts }); },
  getDevFactorStaleness(id: string, type: string, opts?: RequestOpts): Promise<unknown> { return request(isQuoteMode(opts) ? QUOTE_PATHS.devFactorStaleness(id, type) : PATHS.devFactorStaleness(id, type), opts); },
  getLossSelectionStaleness(id: string, opts?: RequestOpts): Promise<unknown> { return request(isQuoteMode(opts) ? QUOTE_PATHS.lossesStaleness(id) : PATHS.lossesStaleness(id), opts); },
  getBenchmarks(countryId: string, triangleType: string): Promise<unknown> { return request(`/api/benchmarks/${enc(countryId)}/${enc(triangleType)}`); },
  getPricingPattern(id: string, type: string): Promise<unknown> { return request(`/api/treaties/${enc(id)}/pricing-pattern/${enc(type)}`); },
  savePricingPattern(id: string, type: string, payload?: unknown): Promise<unknown> { return request(`/api/treaties/${enc(id)}/pricing-pattern/${enc(type)}`, { method: 'PUT', body: payload }); },

  // Losses
  getLargeLosses(id: string, opts?: RequestOpts): Promise<LossReportBundle> { return request<LossReportBundle>(isQuoteMode(opts) ? QUOTE_PATHS.largeLosses(id) : PATHS.largeLosses(id), opts); },
  saveLargeLosses(id: string, payload?: unknown, opts?: RequestOpts): Promise<LossSaveResult> { return request<LossSaveResult>(isQuoteMode(opts) ? QUOTE_PATHS.largeLosses(id) : PATHS.largeLosses(id), { method: 'PUT', body: payload, ...opts }); },
  getCatLosses(id: string, opts?: RequestOpts): Promise<LossReportBundle> { return request<LossReportBundle>(isQuoteMode(opts) ? QUOTE_PATHS.catLosses(id) : PATHS.catLosses(id), opts); },
  getPortfolioLosses(id: string, lossType: string, opts?: RequestOpts): Promise<unknown> { return request(PATHS.portfolioLosses(id, lossType), opts); },
  setStripLargeCat(id: string, value: boolean, opts?: RequestOpts): Promise<unknown> { return request(isQuoteMode(opts) ? QUOTE_PATHS.stripLargeCat(id) : PATHS.stripLargeCat(id), { method: 'PUT', body: { strip_large_cat_losses: value }, ...opts }); },
  saveCatLosses(id: string, payload?: unknown, opts?: RequestOpts): Promise<LossSaveResult> { return request<LossSaveResult>(isQuoteMode(opts) ? QUOTE_PATHS.catLosses(id) : PATHS.catLosses(id), { method: 'PUT', body: payload, ...opts }); },
  suggestLossQuarters(id: string, opts?: RequestOpts): Promise<unknown> { return request(isQuoteMode(opts) ? QUOTE_PATHS.suggestLossQuarters(id) : PATHS.suggestLossQuarters(id), { method: 'POST', body: {}, ...opts }); },
  getLossSelectionLatest(id: string, lossType: LossType, opts?: RequestOpts): Promise<LossSelectionBundle> {
    return request<LossSelectionBundle>(isQuoteMode(opts) ? QUOTE_PATHS.lossSelectionLatest(id, lossType) : PATHS.lossSelectionLatest(id, lossType), opts);
  },
  saveLossSelectionSnapshot(id: string, lossType: LossType, payload?: unknown, opts?: RequestOpts): Promise<LossSelectionSaveResult> {
    return request<LossSelectionSaveResult>(isQuoteMode(opts) ? QUOTE_PATHS.saveLossSelectionSnapshot(id, lossType) : PATHS.saveLossSelectionSnapshot(id, lossType), { method: 'PUT', body: payload, ...opts });
  },


  // COBs
  getContractCobs(id: string, opts?: RequestOpts): Promise<CobLinkRow[]> { return request<CobLinkRow[]>(isQuoteMode(opts) ? QUOTE_PATHS.quoteCobs(id) : PATHS.treatyCobs(id), opts); },
  saveContractCobs(id: string, payload?: unknown, opts?: RequestOpts): Promise<unknown> { return request(isQuoteMode(opts) ? QUOTE_PATHS.quoteCobs(id) : PATHS.treatyCobs(id), { method: 'PUT', body: payload, ...opts }); },

  // Profiles
  getRiskProfile(id: string, cobId: string, opts?: RequestOpts): Promise<ProfileBundle> { return request<ProfileBundle>(isQuoteMode(opts) ? QUOTE_PATHS.riskProfile(id, cobId) : PATHS.riskProfile(id, cobId), opts); },
  saveRiskProfile(id: string, cobId: string, payload?: unknown, opts?: RequestOpts): Promise<unknown> { return request(isQuoteMode(opts) ? QUOTE_PATHS.riskProfile(id, cobId) : PATHS.riskProfile(id, cobId), { method: 'PUT', body: payload, ...opts }); },
  getClaimsProfile(id: string, cobId: string, opts?: RequestOpts): Promise<ProfileBundle> { return request<ProfileBundle>(isQuoteMode(opts) ? QUOTE_PATHS.claimsProfile(id, cobId) : PATHS.claimsProfile(id, cobId), opts); },
  saveClaimsProfile(id: string, cobId: string, payload?: unknown, opts?: RequestOpts): Promise<unknown> { return request(isQuoteMode(opts) ? QUOTE_PATHS.claimsProfile(id, cobId) : PATHS.claimsProfile(id, cobId), { method: 'PUT', body: payload, ...opts }); },

  // CRESTA
  getCrestaData(id: string, opts?: RequestOpts): Promise<unknown> { return request(isQuoteMode(opts) ? QUOTE_PATHS.crestaData(id) : PATHS.crestaData(id), opts); },
  saveCrestaData(id: string, payload?: unknown, opts?: RequestOpts): Promise<unknown> { return request(isQuoteMode(opts) ? QUOTE_PATHS.crestaData(id) : PATHS.crestaData(id), { method: 'PUT', body: payload, ...opts }); },
  getCedantExposure(id: string, opts?: RequestOpts): Promise<unknown> { return request(isQuoteMode(opts) ? QUOTE_PATHS.cedantExposure(id) : PATHS.cedantExposure(id), opts); },

  // Documents
  getDocuments(id: string, opts?: RequestOpts): Promise<unknown> { return request(isQuoteMode(opts) ? QUOTE_PATHS.quoteDocuments(id) : PATHS.treatyDocuments(id), opts); },
  uploadDocument(id: string, formData: FormData, opts?: RequestOpts): Promise<unknown> {
    // formData should be a FormData instance with 'file' + optional metadata fields
    return request(isQuoteMode(opts) ? QUOTE_PATHS.quoteDocuments(id) : PATHS.treatyDocuments(id), { method: 'POST', body: formData, ...opts });
  },
  deleteDocument(docId: string, opts?: RequestOpts): Promise<unknown> { return request(PATHS.deleteDocument(docId), { method: 'DELETE', ...opts }); },
  getDocumentDownloadUrl(docId: string): string { return `${API_BASE}${PATHS.documentDownload(docId)}`; },
  getDocumentViewUrl(docId: string): string { return `${API_BASE}${PATHS.documentView(docId)}`; },
  // Fetched as a blob (not an <a href>) so we can surface a clean error. Auth
  // rides in the httpOnly cookie, so credentials must be included.
  async getRenewalPackBlob(): Promise<Blob> {
    const res = await fetch(`${API_BASE}/api/renewal-pack/export`, { headers: getAuthHeaders(), credentials: 'include' });
    if (!res.ok) throw new Error(`Renewal pack export failed (${res.status})`);
    return res.blob();
  },
  getWordingChecklist(id: string, opts?: RequestOpts): Promise<unknown> {
    return request(isQuoteMode(opts) ? QUOTE_PATHS.quoteWordingChecklist(id) : PATHS.wordingChecklist(id), opts);
  },
  saveWordingChecklist(id: string, payload?: unknown, opts?: RequestOpts): Promise<unknown> {
    return request(isQuoteMode(opts) ? QUOTE_PATHS.quoteWordingChecklist(id) : PATHS.wordingChecklist(id), { method: 'PUT', body: payload, ...opts });
  },
  runWordingChecklistAi(id: string, opts?: RequestOpts): Promise<unknown> {
    return request(isQuoteMode(opts) ? QUOTE_PATHS.quoteWordingChecklistAi(id) : PATHS.wordingChecklistAi(id), { method: 'POST', body: {}, timeoutMs: 120000, ...opts });
  },

  // Pricing
  getPricing(id: string, opts?: RequestOpts): Promise<PricingBundle> { return request<PricingBundle>(isQuoteMode(opts) ? QUOTE_PATHS.pricing(id) : PATHS.pricing(id), opts); },
  getPricingOutputs(id: string, opts?: RequestOpts): Promise<PricingOutputs | null> { return request<PricingOutputs | null>(isQuoteMode(opts) ? QUOTE_PATHS.pricingOutputs(id) : PATHS.pricingOutputs(id), opts); },
  savePricingOutputs(id: string, payload?: unknown, opts?: RequestOpts): Promise<unknown> { return request(isQuoteMode(opts) ? QUOTE_PATHS.pricingOutputs(id) : PATHS.pricingOutputs(id), { method: 'PUT', body: payload, ...opts }); },
  getPricingYearly(id: string, opts?: RequestOpts): Promise<PricingYearlyRow[]> { return request<PricingYearlyRow[]>(isQuoteMode(opts) ? QUOTE_PATHS.pricingYearly(id) : PATHS.pricingYearly(id), opts); },
  savePricingYearly(id: string, payload?: unknown, opts?: RequestOpts): Promise<unknown> { return request(isQuoteMode(opts) ? QUOTE_PATHS.pricingYearly(id) : PATHS.pricingYearly(id), { method: 'PUT', body: payload, ...opts }); },
  savePricingComposite(payload?: unknown, opts?: RequestOpts): Promise<SaveResult> {
    const requestOpts = withOptimisticLockHeader(opts);
    return request<SaveResult>(PATHS.pricingSave, { method: 'POST', body: payload, ...requestOpts });
  },

  // Straight stats
  saveStraightStats(contractId: string, tailType: string, stats: Array<{ year?: number; underwriting_year?: number; premium?: unknown; paid?: unknown; os?: unknown }>, opts?: RequestOpts): Promise<unknown> { return request(PATHS.straightStatsSave, { method: 'POST', body: { contractId, tailType, stats: stats.map(s => ({ underwriting_year: s.year ?? s.underwriting_year, premium: s.premium, paid_claims: s.paid, os_claims: s.os })) }, ...opts }); },
  getStraightStats(id: string, opts?: RequestOpts): Promise<unknown> { return request(PATHS.straightStatsLoad(id), opts); },

  // Country aggregates
  getCountryAggregates(countryId: string, opts?: RequestOpts & { excludeContractId?: string }): Promise<unknown> {
    const { excludeContractId, ...fetchOpts } = opts || {};
    const qs = excludeContractId ? `?excludeContractId=${encodeURIComponent(excludeContractId)}` : '';
    return request(PATHS.countryAggregates(countryId) + qs, fetchOpts);
  },
  getAggCobBreakdown(contractId: string, opts?: RequestOpts): Promise<unknown> { return request(`/api/pricing/agg-cob-breakdown/${encodeURIComponent(contractId)}`, opts); },
  getAggDrilldown(contractId: string, opts?: RequestOpts): Promise<unknown> { return request(`/api/pricing/agg-drilldown/${encodeURIComponent(contractId)}`, opts); },

  // GEM deterministic EQ exposure rating (Tier-B damage ratios).
  getGemCurves(params: { country?: string; lossCategory?: string; occupancy?: string; source?: string } = {}, opts?: RequestOpts): Promise<unknown> {
    const qs = new URLSearchParams(Object.entries(params).filter(([, v]) => v != null) as [string, string][]).toString();
    return request(`/api/pricing/gem/curves${qs ? `?${qs}` : ''}`, opts);
  },
  getGemScenario(contractId: string, opts?: RequestOpts): Promise<unknown> { return request(`/api/pricing/gem/${encodeURIComponent(contractId)}/scenario`, opts); },
  computeGemEqLoss(contractId: string, body: unknown, opts?: RequestOpts): Promise<unknown> {
    return request(`/api/pricing/gem/${encodeURIComponent(contractId)}/compute`, { ...opts, method: 'POST', body });
  },

  getApprovalTrail(contractId: string, opts?: RequestOpts): Promise<unknown> {
    const isQuote = isQuoteMode(opts);
    return request(isQuote ? `/api/quotes/${enc(contractId)}/approval-trail` : `/api/treaties/${enc(contractId)}/approval-trail`, opts);
  },
  getMarketAverage(countryId: string, exclude?: string | null, { treatyTypeId, cobIds = [], region }: { treatyTypeId?: string | null; cobIds?: string[]; region?: string | null } = {}, opts?: RequestOpts): Promise<MarketAverageResult> {
    const params = new URLSearchParams();
    if (exclude) params.set('exclude', exclude);
    if (treatyTypeId) params.set('treatyTypeId', treatyTypeId);
    if (cobIds.length) params.set('cobIds', cobIds.join(','));
    if (region) params.set('region', region);
    const qs = params.toString();
    return request<MarketAverageResult>(`/api/pricing/market-average/${enc(countryId)}${qs ? `?${qs}` : ''}`, opts);
  },
  getCountry(id: string, opts?: RequestOpts): Promise<unknown> { return request(`/api/countries/${enc(id)}`, opts); },
  saveComponentSnapshot(id: string, payload?: unknown, opts?: RequestOpts): Promise<unknown> { return request(PATHS.componentSnapshot(id), { method: 'POST', body: payload, ...opts }); },
  getComponentSnapshots(id: string, opts?: RequestOpts): Promise<unknown> { return request(PATHS.componentSnapshots(id), opts); },
  deleteComponentSnapshot(snapId: string, opts?: RequestOpts): Promise<unknown> { return request(PATHS.deleteComponentSnapshot(snapId), { method: 'DELETE', ...opts }); },

  // Workflow
  declineContract(id: string, reason?: string, opts?: RequestOpts): Promise<unknown> { return request(isQuoteMode(opts) ? QUOTE_PATHS.decline(id) : PATHS.decline(id), { method: 'POST', body: { reason }, ...opts }); },
  submitOfferForApproval(id: string, payload?: unknown, opts?: RequestOpts): Promise<unknown> { return request(isQuoteMode(opts) ? QUOTE_PATHS.offerSubmit(id) : PATHS.offerSubmit(id), { method: 'POST', body: payload || {}, ...opts }); },
  markOfferApproved(id: string, payload?: unknown, opts?: RequestOpts): Promise<unknown> { return request(isQuoteMode(opts) ? QUOTE_PATHS.offerApproved(id) : PATHS.offerApproved(id), { method: 'POST', body: payload || {}, ...opts }); },
  returnToUnderwriter(id: string, payload?: unknown, opts?: RequestOpts): Promise<unknown> { return request(isQuoteMode(opts) ? QUOTE_PATHS.offerReturn(id) : PATHS.offerReturn(id), { method: 'POST', body: payload || {}, ...opts }); },
  recallOffer(id: string, payload?: unknown, opts?: RequestOpts): Promise<unknown> {
    const base = isQuoteMode(opts) ? `/api/quotes/${enc(id)}/offer/recall` : `/api/treaties/${enc(id)}/offer/recall`;
    return request(base, { method: 'POST', body: payload || {}, ...opts });
  },
  markOfferSigned(id: string, payload?: unknown, opts?: RequestOpts): Promise<unknown> { return request(isQuoteMode(opts) ? QUOTE_PATHS.offerSigned(id) : PATHS.offerSigned(id), { method: 'POST', body: payload || {}, ...opts }); },
  markOfferNTU(id: string, payload?: unknown, opts?: RequestOpts): Promise<unknown> { return request(isQuoteMode(opts) ? QUOTE_PATHS.offerNtu(id) : PATHS.offerNtu(id), { method: 'POST', body: payload || {}, ...opts }); },

  // NP
  getNonPropTreaty(id: string, opts?: RequestOpts): Promise<QuoteStructure> { return request<QuoteStructure>(isQuoteMode(opts) ? QUOTE_PATHS.nonPropQuote(id) : PATHS.nonPropTreaty(id), opts); },
  saveNonPropTreaty(id: string, payload?: unknown, opts?: RequestOpts): Promise<SaveResult> {
    const requestOpts = withOptimisticLockHeader(opts);
    return request<SaveResult>(isQuoteMode(opts) ? QUOTE_PATHS.nonPropQuoteSave(id) : PATHS.nonPropTreatySave(id), { method: 'POST', body: payload, ...requestOpts });
  },
  getNpEgnpiYear(id: string, opts?: RequestOpts): Promise<EgnpiYearRow[]> { return request<EgnpiYearRow[]>(isQuoteMode(opts) ? QUOTE_PATHS.npEgnpiYear(id) : PATHS.npEgnpiYear(id), opts); },
  saveNpEgnpiYear(id: string, payload?: unknown, opts?: RequestOpts): Promise<SaveResult> { return request<SaveResult>(isQuoteMode(opts) ? QUOTE_PATHS.npEgnpiYear(id) : PATHS.npEgnpiYear(id), { method: 'PUT', body: payload, ...opts }); },
  getNpPricing(id: string, opts?: RequestOpts): Promise<NpPricingBundle> { return request<NpPricingBundle>(isQuoteMode(opts) ? QUOTE_PATHS.npPricing(id) : PATHS.npPricing(id), opts); },
  saveNpPricing(id: string, payload?: unknown, opts?: RequestOpts): Promise<SaveResult> {
    const requestOpts = withOptimisticLockHeader(opts);
    return request<SaveResult>(isQuoteMode(opts) ? QUOTE_PATHS.npPricing(id) : PATHS.npPricing(id), { method: 'PUT', body: payload, ...requestOpts });
  },
  getNpExpiring(id: string, opts?: RequestOpts): Promise<NpExpiringBundle> { return request<NpExpiringBundle>(isQuoteMode(opts) ? QUOTE_PATHS.npExpiring(id) : PATHS.npExpiring(id), opts); },
  saveNpExpiring(id: string, payload?: unknown, opts?: RequestOpts): Promise<SaveResult> {
    const requestOpts = withOptimisticLockHeader(opts);
    return request<SaveResult>(isQuoteMode(opts) ? QUOTE_PATHS.npExpiring(id) : PATHS.npExpiring(id), { method: 'PUT', body: payload, ...requestOpts });
  },
  getNpHistoricalPerformance(id: string, opts?: RequestOpts): Promise<NpHistoricalRow[]> {
    return request<NpHistoricalRow[]>(isQuoteMode(opts) ? QUOTE_PATHS.npHistoricalPerformance(id) : PATHS.npHistoricalPerformance(id), opts);
  },
  saveNpHistoricalPerformance(id: string, rows?: unknown[], opts?: RequestOpts): Promise<SaveResult> {
    return request<SaveResult>(isQuoteMode(opts) ? QUOTE_PATHS.npHistoricalPerformance(id) : PATHS.npHistoricalPerformance(id), { method: 'PUT', body: { rows }, ...opts });
  },
  getNpStopLossPricing(id: string, opts?: RequestOpts): Promise<StopLossPricingBundle> {
    return request<StopLossPricingBundle>(isQuoteMode(opts) ? QUOTE_PATHS.npStopLossPricing(id) : PATHS.npStopLossPricing(id), opts);
  },
  saveNpStopLossPricing(id: string, payload?: unknown, opts?: RequestOpts): Promise<SaveResult> {
    return request<SaveResult>(isQuoteMode(opts) ? QUOTE_PATHS.npStopLossPricing(id) : PATHS.npStopLossPricing(id), { method: 'PUT', body: payload, ...opts });
  },
  getNpLargeLossLdfs(id: string, opts?: RequestOpts): Promise<unknown> { return request(isQuoteMode(opts) ? QUOTE_PATHS.npLargeLossLdfs(id) : PATHS.npLargeLossLdfs(id), opts); },
  saveNpLargeLossLdfs(id: string, payload?: unknown, opts?: RequestOpts): Promise<unknown> { return request(isQuoteMode(opts) ? QUOTE_PATHS.npLargeLossLdfs(id) : PATHS.npLargeLossLdfs(id), { method: 'PUT', body: payload, ...opts }); },
  getNpCatLossLdfs(id: string, opts?: RequestOpts): Promise<unknown> { return request(isQuoteMode(opts) ? QUOTE_PATHS.npCatLossLdfs(id) : PATHS.npCatLossLdfs(id), opts); },
  saveNpCatLossLdfs(id: string, payload?: unknown, opts?: RequestOpts): Promise<unknown> { return request(isQuoteMode(opts) ? QUOTE_PATHS.npCatLossLdfs(id) : PATHS.npCatLossLdfs(id), { method: 'PUT', body: payload, ...opts }); },
  getCedantProgrammeLimits(id: string, opts?: RequestOpts): Promise<unknown> { return request(`/api/treaties/${enc(id)}/cedant-programme-limits`, opts); },
  listTreaties(params: QueryParams = {}): Promise<unknown> {
    const qs = toQuery(params);
    return request(`/api/treaties${qs ? '?' + qs : ''}`);
  },

  // Aliases
  createTreaty(p?: unknown, o?: RequestOpts): Promise<unknown> { return api.createContract(p, o); },
  getTreaty(i: string, o?: RequestOpts): Promise<ContractBundle> { return api.getContract(i, o); },
  deleteTreaty(i: string, o?: RequestOpts): Promise<{ ok: boolean; deleted?: Uuid }> { return api.deleteContract(i, o); },
  getTreatyCobs(i: string, o?: RequestOpts): Promise<CobLinkRow[]> { return api.getContractCobs(i, o); },
  saveTreatyCobs(i: string, p?: unknown, o?: RequestOpts): Promise<unknown> { return api.saveContractCobs(i, p, o); },
  markSignedLine(id: string, p?: unknown, o?: RequestOpts): Promise<unknown> { return api.markOfferSigned(id, p, o); },
  markNTU(id: string, p?: unknown, o?: RequestOpts): Promise<unknown> { return api.markOfferNTU(id, p, o); },
  submitNpOfferForApproval(id: string, p?: unknown, o?: RequestOpts): Promise<unknown> { return api.submitOfferForApproval(id, p, o); },
  markNpOfferApproved(id: string, p?: unknown, o?: RequestOpts): Promise<unknown> { return api.markOfferApproved(id, p, o); },
  markNpOfferSigned(id: string, p?: unknown, o?: RequestOpts): Promise<unknown> { return api.markOfferSigned(id, p, o); },
  markNpOfferNtu(id: string, p?: unknown, o?: RequestOpts): Promise<unknown> { return api.markOfferNTU(id, p, o); },

  // Auth & mandates
  // Approval workflow — new engine
  getApprovalState(contractId: string, opts?: RequestOpts): Promise<unknown> { return request(`/api/treaties/${enc(contractId)}/offer/approval-state`, opts); },
  getEligibleApprovers(contractId: string, { breach_type, epi_usd }: { breach_type?: string; epi_usd?: string | number } = {}, opts?: RequestOpts): Promise<unknown> {
    const qs = new URLSearchParams();
    if (breach_type) qs.set('breach_type', breach_type);
    if (epi_usd)     qs.set('epi_usd', String(epi_usd));
    const base = isQuoteMode(opts)
      ? `/api/quotes/${enc(contractId)}/offer/eligible-approvers`
      : `/api/treaties/${enc(contractId)}/offer/eligible-approvers`;
    return request(`${base}?${qs}`, opts);
  },
  getArbiterOptions(contractId: string, opts?: RequestOpts): Promise<unknown> { return request(`/api/treaties/${enc(contractId)}/offer/arbiter-options`, opts); },
  peerDecision(contractId: string, payload?: unknown, opts?: RequestOpts): Promise<unknown> { return request(`/api/treaties/${enc(contractId)}/offer/peer-decision`, { method: 'POST', body: payload, ...opts }); },
  arbiterDecision(contractId: string, payload?: unknown, opts?: RequestOpts): Promise<unknown> { return request(`/api/treaties/${enc(contractId)}/offer/arbiter-decision`, { method: 'POST', body: payload, ...opts }); },

  checkMandate({ contract_id, quote_id, epi_usd, country_id, cob_ids }: { contract_id?: string; quote_id?: string; epi_usd?: string | number; country_id?: string; cob_ids?: string | string[] } = {}, opts?: RequestOpts): Promise<unknown> {
    const qs = new URLSearchParams();
    if (contract_id) qs.set('contract_id', contract_id);
    if (quote_id)    qs.set('quote_id', quote_id);
    if (epi_usd)     qs.set('epi_usd', String(epi_usd));
    if (country_id)  qs.set('country_id', country_id);
    if (cob_ids)     qs.set('cob_ids', Array.isArray(cob_ids) ? cob_ids.join(',') : cob_ids);
    return request(`${PATHS.mandateCheck}?${qs.toString()}`, opts);
  },
  getUsers(opts?: RequestOpts): Promise<unknown> { return request(PATHS.authUsers, opts); },
  createUser(payload?: unknown, opts?: RequestOpts): Promise<unknown> { return request(PATHS.authUsers, { method: 'POST', body: payload, ...opts }); },
  loginUser(payload?: unknown, opts?: RequestOpts): Promise<unknown> { return request(PATHS.authLogin, { method: 'POST', body: payload, ...opts }); },
  // Public passwordless (name) sign-in posture probe — mirrors getSsoStatus and
  // drives whether the login screen shows the name form instead of a password.
  getNameLoginStatus(opts?: RequestOpts): Promise<{ enabled: boolean }> { return request(PATHS.authNameLoginStatus, opts); },
  // Passwordless name sign-in (pilot): first name + surname → real cookie session.
  nameLogin(payload: { first_name: string; surname: string }, opts?: RequestOpts): Promise<unknown> { return request(PATHS.authNameLogin, { method: 'POST', body: payload, ...opts }); },
  // Clears the server's httpOnly auth + CSRF cookies. Best-effort on sign-out.
  logout(opts?: RequestOpts): Promise<unknown> { return request(PATHS.authLogout, { method: 'POST', body: {}, ...opts }); },
  // Verify the session via the httpOnly auth cookie and refresh from server truth.
  // Used by the boot-time AuthBootstrap check; 401 ⇒ invalid/expired token.
  getMe(opts?: RequestOpts): Promise<{ session?: Record<string, unknown> }> { return request(PATHS.authMe, opts); },
  // Public SSO posture probe — drives whether the login screen shows the SSO
  // button. Always answers ({ enabled:false } when SSO is off), never 404s.
  getSsoStatus(opts?: RequestOpts): Promise<{ enabled: boolean; provider: string | null }> { return request(PATHS.authSsoStatus, opts); },
  // Self-service password change for the logged-in user. The httpOnly auth cookie
  // is the identity; the server ignores any body user id.
  changePassword(payload: { currentPassword: string; newPassword: string; confirmPassword: string }, opts?: RequestOpts): Promise<unknown> { return request(PATHS.authChangePassword, { method: 'POST', body: payload, ...opts }); },
  getViewableUsers(opts?: RequestOpts): Promise<unknown> { return request('/api/users/viewable', opts); },
  getUserContracts(userId: string, opts?: RequestOpts): Promise<unknown> { return request(`/api/contracts/by-user/${enc(userId)}`, opts); },
  allocateContract(contractId: string, comment?: string, opts?: RequestOpts): Promise<unknown> { return request(`/api/contracts/${enc(contractId)}/allocate`, { method: 'POST', body: { comment }, ...opts }); },
  allocateQuote(quoteId: string, comment?: string, opts?: RequestOpts): Promise<unknown> { return request(`/api/quotes/${enc(quoteId)}/allocate`, { method: 'POST', body: { comment }, ...opts }); },
  reassignContract(contractId: string, payload: { reassigned_by?: string; new_owner_id: string; comment?: string }, opts?: RequestOpts): Promise<unknown> { return request(`/api/contracts/${enc(contractId)}/reassign`, { method: 'POST', body: payload, ...opts }); },
  reassignQuote(quoteId: string, payload: { reassigned_by?: string; new_owner_id: string; comment?: string }, opts?: RequestOpts): Promise<unknown> { return request(`/api/quotes/${enc(quoteId)}/reassign`, { method: 'POST', body: payload, ...opts }); },
  getAssignmentHistory(contractId: string, opts?: RequestOpts): Promise<unknown> { return request(`/api/contracts/${enc(contractId)}/assignment-history`, opts); },
  getContractHistory(contractId: string, opts?: RequestOpts): Promise<unknown> { return request(`/api/contracts/${enc(contractId)}/history`, opts); },
  getEditPermission(contractId: string, opts?: RequestOpts): Promise<unknown> { return request(`/api/contracts/${enc(contractId)}/edit-permission`, opts); },
  getQuoteEditPermission(quoteId: string, opts?: RequestOpts): Promise<unknown> { return request(`/api/quotes/${enc(quoteId)}/edit-permission`, opts); },
  getFacEditPermission(riskId: string, opts?: RequestOpts): Promise<unknown> { return request(`/api/fac/risks/${enc(riskId)}/edit-permission`, opts); },
  getContractsAll(params: { scope?: string; assigned_to?: string; status?: string; uw_year?: string | number; limit?: number } = {}, opts?: RequestOpts): Promise<unknown> {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) { if (v != null && v !== '') qs.set(k, String(v)); }
    const q = qs.toString();
    return request(`/api/contracts/all${q ? `?${q}` : ''}`, opts);
  },
  getHomeSummaryFor(userId?: string, opts?: RequestOpts): Promise<unknown> { return request(userId ? `/api/home/summary?user_id=${enc(userId)}` : '/api/home/summary', opts); },
  getPortfolioExport(opts?: RequestOpts): Promise<unknown> { return request('/api/home/portfolio-export', opts); },
  getRoles(opts?: RequestOpts): Promise<unknown> { return request(PATHS.authRoles, opts); },
  getUserMandate(userId: string, opts?: RequestOpts): Promise<unknown> { return request(`/api/auth/mandates/${enc(userId)}`, opts); },
  setUserMandate(userId: string, payload?: unknown, opts?: RequestOpts): Promise<unknown> { return request(`/api/auth/mandates/${enc(userId)}`, { method: 'PUT', body: payload, ...opts }); },

  // Retro programme — the outward retro contract an admin captures per
  // underwriting year (read by the offer modal's retro cover analysis).
  getRetroProgrammes(year?: number | string, opts?: RequestOpts): Promise<{ programmes: RetroProgramme[] }> {
    return request(year ? `/api/retro-programmes?year=${enc(String(year))}` : '/api/retro-programmes', opts);
  },
  lookupRetroProgramme(year: number | string, currency: string, opts?: RequestOpts): Promise<RetroProgrammeLookup> {
    return request(`/api/retro-programmes/lookup?year=${enc(String(year))}&currency=${enc(currency)}`, opts);
  },
  saveRetroProgramme(payload: Partial<RetroProgramme>, opts?: RequestOpts): Promise<{ programme: RetroProgramme }> {
    return request('/api/retro-programmes', { method: 'POST', body: payload, ...opts });
  },
  deleteRetroProgramme(id: string, opts?: RequestOpts): Promise<{ ok: boolean }> {
    return request(`/api/retro-programmes/${enc(id)}`, { method: 'DELETE', ...opts });
  },

  // AI / document text extraction
  aiComplete(payload?: unknown, opts?: RequestOpts): Promise<unknown> { return request('/api/ai/complete', { method: 'POST', body: payload, ...opts }); },
  aiAnalyseJson(payload?: unknown, opts?: RequestOpts): Promise<unknown> { return request('/api/ai/analyse-json', { method: 'POST', body: payload, ...opts }); },
  aiSlipIngest(payload?: unknown, opts?: RequestOpts): Promise<unknown> { return request('/api/ai/slip-ingest', { method: 'POST', body: payload, ...opts }); },
  getDocumentText(docId: string, opts?: RequestOpts): Promise<unknown> { return request(`/api/documents/${enc(docId)}/text`, opts); },

  // Dashboard
  dashboardFilters(opts?: RequestOpts): Promise<unknown> { return request(PATHS.dashboardFilters, opts); },
  dashboardOverview(params: QueryParams = {}, opts?: RequestOpts): Promise<unknown> { return request(PATHS.dashboardOverview(toQuery(params)), opts); },
  dashboardPage(tab?: string, params: QueryParams = {}, opts?: RequestOpts): Promise<unknown> { return request(PATHS.dashboardPage(tab, toQuery(params)), opts); },

  // ── Facultative ──────────────────────────────────────────────────────────
  facListClasses(opts?: RequestOpts): Promise<unknown> { return request('/api/fac/lookups/classes', opts); },
  facListMarketRates(params?: QueryParams, opts?: RequestOpts): Promise<unknown> {
    const qs = toQuery(params);
    return request(`/api/fac/lookups/market-rates${qs ? '?' + qs : ''}`, opts);
  },
  facGetKpis(opts?: RequestOpts): Promise<unknown> { return request('/api/fac/kpis', opts); },
  facListRisks(params?: QueryParams, opts?: RequestOpts): Promise<unknown> {
    const qs = toQuery(params);
    return request(`/api/fac/risks${qs ? '?' + qs : ''}`, opts);
  },
  facGetRisk(id: string, opts?: RequestOpts): Promise<FacRisk> { return request<FacRisk>(`/api/fac/risks/${enc(id)}`, opts); },
  facCreateRisk(payload?: unknown, opts?: RequestOpts): Promise<unknown> { return request('/api/fac/risks', { method: 'POST', body: payload, ...opts }); },
  facUpdateRisk(id: string, payload?: unknown, opts?: RequestOpts): Promise<unknown> { return request(`/api/fac/risks/${enc(id)}`, { method: 'PUT', body: payload, ...opts }); },
  facDeleteRisk(id: string, opts?: RequestOpts): Promise<unknown> { return request(`/api/fac/risks/${enc(id)}`, { method: 'DELETE', ...opts }); },
  /** Classes of business on the risk, each with its own sum insured. */
  facGetSections(id: string, opts?: RequestOpts): Promise<unknown> { return request(`/api/fac/risks/${enc(id)}/sections`, opts); },
  /** The per-year exposure a burning cost divides by. */
  facGetExperience(id: string, opts?: RequestOpts): Promise<unknown> { return request(`/api/fac/risks/${enc(id)}/experience`, opts); },
  facSaveExperience(id: string, payload?: unknown, opts?: RequestOpts): Promise<unknown> {
    return request(`/api/fac/risks/${enc(id)}/experience`, { method: 'PUT', body: payload, ...opts });
  },
  /** The per-method audit trail behind the last priced row. */
  facGetPricingMethods(id: string, opts?: RequestOpts): Promise<unknown> {
    return request(`/api/fac/risks/${enc(id)}/pricing-methods`, opts);
  },
  facSaveSections(id: string, sections?: unknown[], opts?: RequestOpts): Promise<unknown> {
    return request(`/api/fac/risks/${enc(id)}/sections`, { method: 'PUT', body: { sections }, ...opts });
  },
  /** Last year's terms beside this year's, and why the price moved. */
  facGetRenewalDifference(id: string, opts?: RequestOpts): Promise<unknown> {
    return request(`/api/fac/risks/${enc(id)}/renewal-difference`, opts);
  },
  /** Committed capacity in this risk's zones, plus the systemic checks. */
  facGetAccumulation(id: string, opts?: RequestOpts): Promise<unknown> {
    return request(`/api/fac/risks/${enc(id)}/accumulation`, opts);
  },
  /** The excess tower: one row per layer, with its own share and price. */
  facGetLayers(id: string, opts?: RequestOpts): Promise<unknown> { return request(`/api/fac/risks/${enc(id)}/layers`, opts); },
  facSaveLayers(id: string, layers?: unknown[], opts?: RequestOpts): Promise<unknown> {
    return request(`/api/fac/risks/${enc(id)}/layers`, { method: 'PUT', body: { layers }, ...opts });
  },
  /**
   * Server-side price. Returns either the authoritative result or a blocker
   * explaining why this class cannot be priced yet — both are states the
   * screen renders, neither is an error.
   */
  facPriceRisk(id: string, payload?: unknown, opts?: RequestOpts): Promise<unknown> {
    return request(`/api/fac/risks/${enc(id)}/price`, { method: 'POST', body: payload ?? {}, ...opts });
  },
  facGetLocations(id: string, opts?: RequestOpts): Promise<unknown> { return request(`/api/fac/risks/${enc(id)}/locations`, opts); },
  facSaveLocations(id: string, locations?: unknown[], opts?: RequestOpts): Promise<unknown> { return request(`/api/fac/risks/${enc(id)}/locations`, { method: 'PUT', body: { locations }, ...opts }); },
  facGetCope(id: string, opts?: RequestOpts): Promise<unknown> { return request(`/api/fac/risks/${enc(id)}/cope`, opts); },
  facSaveCope(id: string, payload?: unknown, opts?: RequestOpts): Promise<unknown> { return request(`/api/fac/risks/${enc(id)}/cope`, { method: 'PUT', body: payload, ...opts }); },
  facGetLosses(id: string, opts?: RequestOpts): Promise<unknown> { return request(`/api/fac/risks/${enc(id)}/losses`, opts); },
  facSaveLosses(id: string, losses?: unknown[], opts?: RequestOpts): Promise<unknown> { return request(`/api/fac/risks/${enc(id)}/losses`, { method: 'PUT', body: { losses }, ...opts }); },
  facGetPricing(id: string, opts?: RequestOpts): Promise<FacPricing | null> { return request<FacPricing | null>(`/api/fac/risks/${enc(id)}/pricing`, opts); },
  facSavePricing(id: string, payload?: unknown, opts?: RequestOpts): Promise<unknown> { return request(`/api/fac/risks/${enc(id)}/pricing`, { method: 'PUT', body: payload, ...opts }); },
  facGetDocuments(id: string, opts?: RequestOpts): Promise<unknown> { return request(`/api/fac/risks/${enc(id)}/documents`, opts); },
  facUploadDocument(id: string, payload?: unknown, opts?: RequestOpts): Promise<unknown> { return request(`/api/fac/risks/${enc(id)}/documents`, { method: 'POST', body: payload, ...opts }); },
  facDeleteDocument(docId: string, opts?: RequestOpts): Promise<unknown> { return request(`/api/fac/documents/${enc(docId)}`, { method: 'DELETE', ...opts }); },
  facGetLinkedTreaties(id: string, opts?: RequestOpts): Promise<unknown> { return request(`/api/fac/risks/${enc(id)}/linked-treaties`, opts); },

  // ── Facultative ↔ treaty links (per risk) ────────────────────────────────
  facGetEligibleTreaties(id: string, opts?: RequestOpts): Promise<unknown> {
    return request(`/api/fac/risks/${enc(id)}/eligible-treaties`, opts);
  },
  facGetTreatyLinks(id: string, opts?: RequestOpts): Promise<unknown> {
    return request(`/api/fac/risks/${enc(id)}/treaty-links`, opts);
  },
  facCreateTreatyLink(id: string, payload?: unknown, opts?: RequestOpts): Promise<unknown> {
    return request(`/api/fac/risks/${enc(id)}/treaty-links`, { method: 'POST', body: payload, ...opts });
  },
  facDeleteTreatyLink(id: string, linkId: string, opts?: RequestOpts): Promise<unknown> {
    return request(`/api/fac/risks/${enc(id)}/treaty-links/${enc(linkId)}`, { method: 'DELETE', ...opts });
  },

  // ── Facultative underwriting factor selections (per risk) ────────────────
  facGetUwFactors(id: string, opts?: RequestOpts): Promise<unknown> { return request(`/api/fac/risks/${enc(id)}/uw-factors`, opts); },
  facSaveUwFactors(id: string, payload?: unknown, opts?: RequestOpts): Promise<unknown> {
    return request(`/api/fac/risks/${enc(id)}/uw-factors`, { method: 'POST', body: payload, ...opts });
  },

  // ── Facultative clauses & exclusions checklist (per risk) ────────────────
  facGetClausesChecklist(id: string, opts?: RequestOpts): Promise<unknown> {
    return request(`/api/fac/risks/${enc(id)}/clauses-checklist`, opts);
  },
  facSaveClausesChecklist(id: string, payload?: unknown, opts?: RequestOpts): Promise<unknown> {
    return request(`/api/fac/risks/${enc(id)}/clauses-checklist`, { method: 'POST', body: payload, ...opts });
  },

  // ── Facultative summary / approval workflow ──────────────────────────────
  facSubmitForApproval(id: string, payload?: unknown, opts?: RequestOpts): Promise<unknown> {
    return request(`/api/fac/risks/${enc(id)}/submit-for-approval`, { method: 'POST', body: payload || {}, ...opts });
  },
  facDecline(id: string, payload?: unknown, opts?: RequestOpts): Promise<unknown> {
    return request(`/api/fac/risks/${enc(id)}/decline`, { method: 'POST', body: payload, ...opts });
  },
  facBind(id: string, payload?: unknown, opts?: RequestOpts): Promise<unknown> {
    return request(`/api/fac/risks/${enc(id)}/bind`, { method: 'POST', body: payload || {}, ...opts });
  },
  facGetAuditEvents(id: string, opts?: RequestOpts): Promise<unknown> {
    return request(`/api/fac/risks/${enc(id)}/audit-events`, opts);
  },

  // ── Facultative document AI ──────────────────────────────────────────────
  facAnalyseDocument(payload?: unknown, opts?: RequestOpts): Promise<unknown> {
    return request('/api/ai/fac/analyse-document', { method: 'POST', body: payload, ...opts });
  },
  /**
   * Multipart upload (bytes + document_kind). The legacy facUploadDocument
   * only saves metadata — this variant actually stores the file so the
   * AI runner can read it back.
   *
   * @param id           fac_risk_id
   * @param file         DOM File object
   * @param documentKind PLACEMENT_SLIP / SURVEY_REPORT / …
   */
  facUploadDocumentMultipart(
    id: string,
    file: File,
    meta?: { documentKind?: string; title?: string; description?: string },
    opts?: RequestOpts,
  ): Promise<unknown> {
    const form = new FormData();
    form.append('file', file);
    form.append('document_kind', meta?.documentKind || 'OTHER');
    if (meta?.title) form.append('title', meta.title);
    if (meta?.description) form.append('description', meta.description);
    // request() sends FormData as-is (no JSON body) when method=POST
    // and body is a FormData instance.
    return request(`/api/fac/risks/${enc(id)}/documents/upload`, {
      method: 'POST', body: form, ...opts,
    });
  },
  // Stored-file view / download URLs (mirror the treaty getDocument*Url
  // helpers). Auth rides the httpOnly cookie, so these resolve as plain
  // <a href> / new-tab links.
  facGetDocumentViewUrl(docId: string): string { return `${API_BASE}/api/fac/documents/${enc(docId)}/view`; },
  facGetDocumentDownloadUrl(docId: string): string { return `${API_BASE}/api/fac/documents/${enc(docId)}/download`; },

  /**
   * Renewal-pack import endpoints — entity-polymorphic via opts.quote.
   *
   * The flow is async: POST kicks off a background job and returns
   * 202 { jobId }; the caller polls GET .../import-renewal-pack/:jobId
   * until status is 'done' or 'failed'. Snapshots taken before each
   * import are restorable for 30 days via the snapshots endpoints.
   *
   * Pass `opts.quote === true` to hit the quote-side endpoint family
   * (/api/quotes/...); omit it (or pass false) for the treaty-side
   * family (/api/treaties/...). The `id` argument is the quote_id or
   * contract_id accordingly — DocumentsScreen wires its existing
   * `apiOpts` here so the request lands on whichever entity the
   * underwriter is currently editing.
   */
  importRenewalPack(id: string, documentId: string, opts: RequestOpts = {}): Promise<RenewalImportStarted> {
    const base = isQuoteMode(opts) ? `/api/quotes/${enc(id)}` : `/api/treaties/${enc(id)}`;
    return request<RenewalImportStarted>(`${base}/import-renewal-pack`, {
      method: 'POST',
      body: { documentId },
      ...opts,
    });
  },
  getRenewalPackImportJob(id: string, jobId: string, opts: RequestOpts = {}): Promise<RenewalImportJobStatus> {
    const base = isQuoteMode(opts) ? `/api/quotes/${enc(id)}` : `/api/treaties/${enc(id)}`;
    return request<RenewalImportJobStatus>(`${base}/import-renewal-pack/${enc(jobId)}`, opts);
  },
  getActiveRenewalPackImport(id: string, opts: RequestOpts = {}): Promise<ActiveRenewalImport> {
    const base = isQuoteMode(opts) ? `/api/quotes/${enc(id)}` : `/api/treaties/${enc(id)}`;
    return request<ActiveRenewalImport>(`${base}/import-renewal-pack`, opts);
  },
  listImportSnapshots(id: string, opts: RequestOpts = {}): Promise<ImportSnapshot[]> {
    const base = isQuoteMode(opts) ? `/api/quotes/${enc(id)}` : `/api/treaties/${enc(id)}`;
    return request<ImportSnapshot[]>(`${base}/import-snapshots`, opts);
  },
  restoreImportSnapshot(id: string, snapshotId: string, opts: RequestOpts = {}): Promise<{ ok: boolean; snapshotId?: string }> {
    const base = isQuoteMode(opts) ? `/api/quotes/${enc(id)}` : `/api/treaties/${enc(id)}`;
    return request(`${base}/import-snapshots/${enc(snapshotId)}/restore`, {
      method: 'POST',
      ...opts,
    });
  },
  facGetAnalyses(id: string, opts?: RequestOpts): Promise<unknown> {
    return request(`/api/fac/risks/${enc(id)}/analyses`, opts);
  },
  facGetAnalysis(analysisId: string, opts?: RequestOpts): Promise<unknown> {
    return request(`/api/fac/analysis/${enc(analysisId)}`, opts);
  },
  facAcceptRecommendation(recId: string, payload?: unknown, opts?: RequestOpts): Promise<unknown> {
    return request(`/api/fac/recommendation/${enc(recId)}/accept`, { method: 'POST', body: payload || {}, ...opts });
  },
  facRejectRecommendation(recId: string, payload?: unknown, opts?: RequestOpts): Promise<unknown> {
    return request(`/api/fac/recommendation/${enc(recId)}/reject`, { method: 'POST', body: payload || {}, ...opts });
  },

  // ── Facultative reference data (cached via CACHEABLE_PATHS) ──────────────
  facGetOccupancies(opts?: RequestOpts): Promise<unknown>    { return request('/api/fac/reference/occupancies', opts); },
  facGetFactors(opts?: RequestOpts): Promise<unknown>        { return request('/api/fac/reference/factors', opts); },
  facGetFactorWeights(opts?: RequestOpts): Promise<unknown>  { return request('/api/fac/reference/factor-weights', opts); },
  facGetScoringTables(opts?: RequestOpts): Promise<unknown>  { return request('/api/fac/reference/scoring-tables', opts); },
  facGetBiIndemnity(opts?: RequestOpts): Promise<unknown>    { return request('/api/fac/reference/bi-indemnity', opts); },
  facGetNatcatRates(opts?: RequestOpts): Promise<unknown>    { return request('/api/fac/reference/natcat-rates', opts); },
  facGetClauses(opts?: RequestOpts): Promise<unknown>        { return request('/api/fac/reference/clauses', opts); },
  facGetFamilies(opts?: RequestOpts): Promise<unknown>       { return request('/api/fac/reference/families', opts); },
  facGetRateVersion(opts?: RequestOpts): Promise<unknown>    { return request('/api/fac/reference/rate-version', opts); },
  facGetCurves(family?: string, opts?: RequestOpts): Promise<unknown> {
    return request(`/api/fac/reference/curves${family ? `?family=${enc(family)}` : ''}`, opts);
  },
  /** How the book is priced, not how one risk is. */
  facGetPortfolioAdequacy(query?: Record<string, string | number | undefined>, opts?: RequestOpts): Promise<unknown> {
    return request(`/api/fac/portfolio/adequacy${toQuery(query) ? `?${toQuery(query)}` : ''}`, opts);
  },
  facGetPortfolioHitRatio(query?: Record<string, string | number | undefined>, opts?: RequestOpts): Promise<unknown> {
    return request(`/api/fac/portfolio/hit-ratio${toQuery(query) ? `?${toQuery(query)}` : ''}`, opts);
  },
  facGetPortfolioCapacity(query?: Record<string, string | number | undefined>, opts?: RequestOpts): Promise<unknown> {
    return request(`/api/fac/portfolio/capacity${toQuery(query) ? `?${toQuery(query)}` : ''}`, opts);
  },
  /** Client-vs-server pricing agreement, and whether strict mode is safe yet. */
  facGetPortfolioDrift(query?: Record<string, string | number | undefined>, opts?: RequestOpts): Promise<unknown> {
    return request(`/api/fac/portfolio/drift${toQuery(query) ? `?${toQuery(query)}` : ''}`, opts);
  },
  /** ILF curves and the base-rate tables the Phase 3 families rate off. */
  facGetRateTables(family?: string, opts?: RequestOpts): Promise<unknown> {
    return request(`/api/fac/reference/rate-tables${family ? `?family=${enc(family)}` : ''}`, opts);
  },

  // ── Workbench (Actuarial Formula Workbench) ──────────────────────────────
  workbenchListFormulas(opts?: RequestOpts): Promise<unknown> { return request('/api/workbench/formulas', opts); },
  workbenchGetFormula(module: string, name: string, opts?: RequestOpts): Promise<unknown> {
    return request(`/api/workbench/formulas/${enc(module)}/${enc(name)}`, opts);
  },
  workbenchSubmitParameter(payload?: unknown, opts?: RequestOpts): Promise<unknown> {
    return request('/api/workbench/parameters', { method: 'POST', body: payload, ...opts });
  },
  workbenchApproveParameter(id: string, comment?: string, opts?: RequestOpts): Promise<unknown> {
    return request(`/api/workbench/parameters/${enc(id)}/approve`, { method: 'PUT', body: { comment }, ...opts });
  },
  workbenchRejectParameter(id: string, comment?: string, opts?: RequestOpts): Promise<unknown> {
    return request(`/api/workbench/parameters/${enc(id)}/reject`, { method: 'PUT', body: { comment }, ...opts });
  },
  workbenchPostComment(payload?: unknown, opts?: RequestOpts): Promise<unknown> {
    return request('/api/workbench/comments', { method: 'POST', body: payload, ...opts });
  },

  // LDF blend modal — fetch saved/fresh blend, preview overrides, persist.
  getLdfBlend:     (contractId: string, triangleType: string, opts?: RequestOpts): Promise<unknown> =>
    request(`/api/contracts/${enc(contractId)}/ldf-blend/${enc(triangleType)}`, opts),
  previewLdfBlend: (contractId: string, triangleType: string, overrideWeights?: unknown, opts?: RequestOpts): Promise<unknown> =>
    request(`/api/contracts/${enc(contractId)}/ldf-blend/${enc(triangleType)}`,
      { method: 'POST', body: { overrideWeights }, ...opts }),
  saveLdfBlend:    (contractId: string, triangleType: string, payload?: unknown, opts?: RequestOpts): Promise<unknown> =>
    request(`/api/contracts/${enc(contractId)}/ldf-blend/${enc(triangleType)}`,
      { method: 'PUT', body: payload, ...opts }),
};

export type Api = typeof api;
export type { JsonValue };

export default api;
