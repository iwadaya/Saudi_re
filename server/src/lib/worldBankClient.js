// server/src/lib/worldBankClient.js
//
// Open-source macro indicators from the World Bank Open Data API.
// No API key, no rate-limit credentials, no upfront agreement —
// hits https://api.worldbank.org/v2/country/{ISO}/indicator/{CODE}.
//
// Indicators we surface:
//   SP.POP.TOTL      Population, total
//   SP.POP.GROW      Population growth (annual %)
//   NY.GDP.MKTP.CD   GDP (current US$)
//   NY.GDP.MKTP.KD.ZG GDP growth (annual %)
//   NY.GDP.PCAP.CD   GDP per capita (current US$)
//   FP.CPI.TOTL.ZG   Inflation, consumer prices (annual %)
//   SL.UEM.TOTL.ZS   Unemployment, total (% of total labor force)
//   GC.DOD.TOTL.GD.ZS Central gov't debt, total (% of GDP)
//
// Returns a normalised snapshot keyed by indicator with the latest
// non-null observation per metric. Older observations are kept on
// `series` for sparkline/trend rendering on the client.

import { logger } from './logger.js';

const BASE_URL = 'https://api.worldbank.org/v2';
const REQUEST_TIMEOUT_MS = 10_000;
const RECENT_YEARS = 10;     // depth of the trend series

const INDICATORS = [
  { key: 'population',          code: 'SP.POP.TOTL',       label: 'Population',                     unit: 'count' },
  { key: 'population_growth',   code: 'SP.POP.GROW',       label: 'Population growth',              unit: '%' },
  { key: 'gdp_usd',             code: 'NY.GDP.MKTP.CD',    label: 'GDP (USD)',                      unit: 'USD' },
  { key: 'gdp_growth',          code: 'NY.GDP.MKTP.KD.ZG', label: 'GDP growth',                     unit: '%' },
  { key: 'gdp_per_capita_usd',  code: 'NY.GDP.PCAP.CD',    label: 'GDP per capita (USD)',           unit: 'USD' },
  { key: 'inflation_cpi',       code: 'FP.CPI.TOTL.ZG',    label: 'Inflation (CPI)',                unit: '%' },
  { key: 'unemployment',        code: 'SL.UEM.TOTL.ZS',    label: 'Unemployment',                   unit: '%' },
  { key: 'gov_debt_pct_gdp',    code: 'GC.DOD.TOTL.GD.ZS', label: 'Government debt (% of GDP)',     unit: '%' },
];

/**
 * @typedef {Object} MacroIndicatorV1
 * @property {string} key
 * @property {string} label
 * @property {string} unit
 * @property {?number} latest_value
 * @property {?number} latest_year
 * @property {Array<{year: number, value: ?number}>} series
 */

/**
 * @typedef {Object} WorldBankSnapshotV1
 * @property {string} source              Always 'WORLD_BANK'.
 * @property {string} country_code        Echoed country code we queried with.
 * @property {string} fetched_at          ISO timestamp.
 * @property {Object<string, MacroIndicatorV1>} indicators
 */

/**
 * Fetch the macro snapshot for a country from World Bank.
 *
 * @param {{ countryCode: string }} args  Country code (ISO-2 or ISO-3, the API accepts both).
 * @returns {Promise<WorldBankSnapshotV1|null>}
 */
export async function fetchWorldBankSnapshot({ countryCode } = {}) {
  if (!countryCode) return null;
  const code = String(countryCode).trim().toUpperCase();
  const indicators = {};
  await Promise.all(INDICATORS.map(async (ind) => {
    const series = await fetchOneIndicator({ countryCode: code, indicator: ind });
    indicators[ind.key] = series;
  }));
  return {
    source:       'WORLD_BANK',
    country_code: code,
    fetched_at:   new Date().toISOString(),
    indicators,
  };
}

async function fetchOneIndicator({ countryCode, indicator }) {
  const empty = {
    key: indicator.key, label: indicator.label, unit: indicator.unit,
    latest_value: null, latest_year: null, series: [],
  };
  const url = `${BASE_URL}/country/${encodeURIComponent(countryCode)}/indicator/${encodeURIComponent(indicator.code)}?format=json&per_page=${RECENT_YEARS}&date=${currentYear() - (RECENT_YEARS - 1)}:${currentYear()}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' }, signal: ctrl.signal });
  } catch (e) {
    logger.warn('[worldbank] request failed', { error: e?.message, indicator: indicator.code });
    return empty;
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    logger.warn('[worldbank] non-2xx', { status: resp.status, indicator: indicator.code });
    return empty;
  }
  const body = await resp.json().catch(() => null);
  // World Bank returns [{...meta}, [{date, value}, ...]] — defend
  // against either shape variation.
  const rows = Array.isArray(body) && Array.isArray(body[1]) ? body[1] : [];
  const series = rows
    .map(r => ({ year: Number(r?.date), value: numOrNull(r?.value) }))
    .filter(r => Number.isFinite(r.year))
    .sort((a, b) => a.year - b.year);
  const withVal = series.filter(r => r.value != null);
  const latest = withVal.length ? withVal[withVal.length - 1] : null;
  return {
    key: indicator.key, label: indicator.label, unit: indicator.unit,
    latest_value: latest?.value ?? null,
    latest_year:  latest?.year  ?? null,
    series,
  };
}

function currentYear() { return new Date().getUTCFullYear(); }
function numOrNull(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
