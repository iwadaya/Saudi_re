// server/src/lib/imfClient.js
//
// IMF Datamapper API — open data, no key required. Source for the
// World Economic Outlook (WEO) projections, which include forecasts
// 2-3 years ahead beyond the World Bank's mostly-historical series.
//
// Endpoint shape:
//   https://www.imf.org/external/datamapper/api/v1/{INDICATOR}/{ISO3}
// returns { values: { INDICATOR: { ISO3: { '2024': value, '2025': value } } } }
//
// Country code MUST be ISO-3 alpha-3 — see lib/iso3166.js. When the
// alpha-2 we hold doesn't map (rare territory codes), we skip IMF
// for that country and the route returns just the World Bank slice.

import { logger } from './logger.js';

const BASE_URL = 'https://www.imf.org/external/datamapper/api/v1';
const REQUEST_TIMEOUT_MS = 10_000;

const INDICATORS = [
  { key: 'gdp_usd_imf',        code: 'NGDPD',     label: 'GDP, current prices (USD bn) — IMF',     unit: 'USD_BILLIONS' },
  { key: 'gdp_per_capita_imf', code: 'NGDPDPC',   label: 'GDP per capita (USD) — IMF',             unit: 'USD' },
  { key: 'inflation_imf',      code: 'PCPIPCH',   label: 'Inflation, end of period (%) — IMF',     unit: '%' },
  { key: 'population_imf',     code: 'LP',        label: 'Population (millions) — IMF',            unit: 'PERSONS_MILLIONS' },
  { key: 'unemployment_imf',   code: 'LUR',       label: 'Unemployment rate (%) — IMF',            unit: '%' },
  { key: 'gov_debt_imf',       code: 'GGXWDG_NGDP', label: 'General gov gross debt (% of GDP) — IMF', unit: '%' },
];

/**
 * @typedef {Object} ImfIndicatorV1
 * @property {string} key
 * @property {string} label
 * @property {string} unit
 * @property {?number} latest_value
 * @property {?number} latest_year
 * @property {?number} forecast_value     Year ahead of `latest_year` if IMF projects one.
 * @property {?number} forecast_year
 * @property {Array<{year:number, value:?number}>} series
 */

/**
 * @typedef {Object} ImfSnapshotV1
 * @property {string} source            Always 'IMF'.
 * @property {string} country_code      The ISO-3 we queried with.
 * @property {string} fetched_at
 * @property {Object<string, ImfIndicatorV1>} indicators
 */

/**
 * @param {{ countryCodeIso3: string }} args
 * @returns {Promise<ImfSnapshotV1|null>}
 */
export async function fetchImfSnapshot({ countryCodeIso3 } = {}) {
  if (!countryCodeIso3) return null;
  const code = String(countryCodeIso3).trim().toUpperCase();
  const indicators = {};
  await Promise.all(INDICATORS.map(async (ind) => {
    indicators[ind.key] = await fetchOneIndicator({ countryCode: code, indicator: ind });
  }));
  return {
    source:       'IMF',
    country_code: code,
    fetched_at:   new Date().toISOString(),
    indicators,
  };
}

async function fetchOneIndicator({ countryCode, indicator }) {
  const empty = {
    key: indicator.key, label: indicator.label, unit: indicator.unit,
    latest_value: null, latest_year: null,
    forecast_value: null, forecast_year: null, series: [],
  };
  const url = `${BASE_URL}/${encodeURIComponent(indicator.code)}/${encodeURIComponent(countryCode)}`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(url, { method: 'GET', headers: { Accept: 'application/json' }, signal: ctrl.signal });
  } catch (e) {
    logger.warn('[imf] request failed', { error: e?.message, indicator: indicator.code });
    return empty;
  } finally {
    clearTimeout(timer);
  }
  if (!resp.ok) {
    logger.warn('[imf] non-2xx', { status: resp.status, indicator: indicator.code });
    return empty;
  }
  const body = await resp.json().catch(() => null);
  // Expected: { values: { INDICATOR_CODE: { ISO3: { '2020': v, '2024': v, ... } } } }
  const yearMap = body?.values?.[indicator.code]?.[countryCode] || null;
  if (!yearMap || typeof yearMap !== 'object') return empty;
  const series = Object.entries(yearMap)
    .map(([y, v]) => ({ year: Number(y), value: numOrNull(v) }))
    .filter(r => Number.isFinite(r.year))
    .sort((a, b) => a.year - b.year);
  const withVal = series.filter(r => r.value != null);
  // IMF marks future years with 'F' or 'E' in the WEO sometimes —
  // here we just compare against current year to split historic vs
  // forecast. The most recent past observation is `latest_*`; the
  // closest future projection (if any) is `forecast_*`.
  const cy = currentYear();
  const past   = withVal.filter(r => r.year <= cy);
  const future = withVal.filter(r => r.year >  cy).sort((a, b) => a.year - b.year);
  const latest   = past.length ? past[past.length - 1] : null;
  const forecast = future.length ? future[0] : null;
  return {
    key: indicator.key, label: indicator.label, unit: indicator.unit,
    latest_value: latest?.value ?? null,
    latest_year:  latest?.year  ?? null,
    forecast_value: forecast?.value ?? null,
    forecast_year:  forecast?.year  ?? null,
    series,
  };
}

function currentYear() { return new Date().getUTCFullYear(); }
function numOrNull(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
