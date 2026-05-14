// server/src/lib/axcoClient.js
//
// Thin wrapper around Axco Insurance Intelligence. The Axco API is
// proprietary and gated behind a subscription — the exact endpoint
// surface depends on which Axco product (Insight, Country Reports,
// Market Statistics) the account is provisioned for.
//
// This file ships as a STUB:
//   • When env.axcoApiKey is unset, fetchMarketSnapshot returns null
//     and aiMarket.js falls back to its web-search-only generation
//     path. Existing flow keeps working.
//   • When env.axcoApiKey IS set but env.axcoBaseUrl is unset, we
//     throw a clear "not configured" error so deploys notice.
//   • When both env vars are set, the actual fetch logic at the
//     bottom of this file needs to be filled in against the real
//     Axco endpoint shape (see TODO).
//
// The expected snapshot shape (SnapshotV1 below) is what the AI
// route consumes. Whatever the real Axco endpoint returns must be
// normalised into this shape — the rest of the system doesn't care
// where the data came from.

import { env } from '../config/env.js';
import { logger } from './logger.js';

const REQUEST_TIMEOUT_MS = 8_000;

/**
 * @typedef {Object} AxcoSnapshotV1
 * @property {string} source                    Always 'AXCO' for trace/audit.
 * @property {string} axco_country_code         Country code echoed back.
 * @property {string} axco_class_code           COB code echoed back.
 * @property {string} fetched_at                ISO timestamp of fetch.
 * @property {Object} regulator                 { name, recent_actions }
 * @property {Array<Object>} top_carriers       [{ name, market_share_pct?, am_best_rating? }]
 * @property {Object|null} market_size_premium  { value, currency, year } | null
 * @property {number|null} market_growth_pct
 * @property {Object} benchmarks                { loss_ratio_pct, commission_pct, retention_pct, roe_pct, year }
 * @property {string|null} commentary           Free-form narrative if Axco supplies one.
 */

/**
 * Fetch the Axco market snapshot for a given country + class of business.
 * Returns null when Axco is unconfigured or the lookup codes are missing.
 *
 * @param {{ countryCode: ?string, cobCode: ?string }} args
 * @returns {Promise<AxcoSnapshotV1|null>}
 */
export async function fetchMarketSnapshot({ countryCode, cobCode } = {}) {
  if (!countryCode || !cobCode) {
    return null;
  }
  if (!env.axcoApiKey) {
    return null;
  }
  if (!env.axcoBaseUrl) {
    const err = new Error('AXCO_API_KEY set but AXCO_BASE_URL is missing');
    err.code = 'AXCO_BASE_URL_MISSING';
    throw err;
  }

  const url = buildSnapshotUrl({
    baseUrl: env.axcoBaseUrl,
    countryCode,
    cobCode,
  });

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);
  let resp;
  try {
    resp = await fetch(url, {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${env.axcoApiKey}`,
        'Accept': 'application/json',
      },
      signal: ctrl.signal,
    });
  } catch (e) {
    if (e?.name === 'AbortError') {
      logger.warn('[axco] request timed out', { url });
      return null;
    }
    logger.warn('[axco] request failed', { error: e?.message, url });
    return null;
  } finally {
    clearTimeout(timer);
  }

  if (!resp.ok) {
    logger.warn('[axco] non-2xx response', { status: resp.status, url });
    return null;
  }

  const raw = await resp.json().catch(() => null);
  if (!raw) return null;
  return normaliseSnapshot({ raw, countryCode, cobCode });
}

// Internal — kept top-level so it can be exercised in unit tests
// against any Axco response shape we eventually see.
//
// TODO(axco-real-endpoint): once we have a sample real response from
// Axco, walk the actual JSON paths here. For now we accept either:
//   1. A response that already matches SnapshotV1 (echo through), or
//   2. A response that looks like Axco's typical document structure
//      (regulator: {...}, leaders: [...], statistics: {...}).
// The route doesn't care which — both end up as SnapshotV1.
export function normaliseSnapshot({ raw, countryCode, cobCode }) {
  if (raw && raw.source === 'AXCO' && raw.benchmarks) {
    // Already V1 — passthrough, but stamp fresh metadata.
    return {
      ...raw,
      axco_country_code: countryCode,
      axco_class_code:   cobCode,
      fetched_at:        new Date().toISOString(),
    };
  }
  const r = raw || {};
  return {
    source:             'AXCO',
    axco_country_code:  countryCode,
    axco_class_code:    cobCode,
    fetched_at:         new Date().toISOString(),
    regulator: {
      name:            r.regulator?.name        || r.regulator || null,
      recent_actions:  Array.isArray(r.regulator?.recent_actions) ? r.regulator.recent_actions
                       : Array.isArray(r.recent_actions) ? r.recent_actions : [],
    },
    top_carriers: Array.isArray(r.top_carriers) ? r.top_carriers
                  : Array.isArray(r.leaders)    ? r.leaders.map(l => ({
                      name: l.name || l.company_name || null,
                      market_share_pct: numOrNull(l.market_share_pct ?? l.share_pct),
                      am_best_rating:   l.am_best_rating || l.rating || null,
                    }))
                  : [],
    market_size_premium: r.market_size_premium
      ? {
          value:    numOrNull(r.market_size_premium.value),
          currency: r.market_size_premium.currency || null,
          year:     numOrNull(r.market_size_premium.year),
        }
      : (r.statistics?.gross_written_premium != null
          ? {
              value:    numOrNull(r.statistics.gross_written_premium),
              currency: r.statistics.currency || null,
              year:     numOrNull(r.statistics.year),
            }
          : null),
    market_growth_pct: numOrNull(r.market_growth_pct ?? r.statistics?.growth_pct),
    benchmarks: {
      loss_ratio_pct:  numOrNull(r.benchmarks?.loss_ratio_pct  ?? r.statistics?.loss_ratio_pct),
      commission_pct:  numOrNull(r.benchmarks?.commission_pct  ?? r.statistics?.commission_pct),
      retention_pct:   numOrNull(r.benchmarks?.retention_pct   ?? r.statistics?.retention_pct),
      roe_pct:         numOrNull(r.benchmarks?.roe_pct         ?? r.statistics?.roe_pct),
      year:            numOrNull(r.benchmarks?.year            ?? r.statistics?.year),
    },
    commentary: typeof r.commentary === 'string' ? r.commentary : null,
  };
}

// URL builder kept separate so a future change to query string layout
// (e.g. POST vs GET, path params) is a one-line edit.
//
// TODO(axco-real-endpoint): the path/query parameters below are a
// reasonable guess. Replace with the real Axco endpoint shape once
// confirmed against the API docs.
export function buildSnapshotUrl({ baseUrl, countryCode, cobCode }) {
  const root = String(baseUrl || '').replace(/\/$/, '');
  const c = encodeURIComponent(countryCode);
  const b = encodeURIComponent(cobCode);
  return `${root}/markets/${c}/classes/${b}/snapshot`;
}

function numOrNull(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}
