// load-test/k6/lib/quoteTemplate.js
//
// The quote table requires real reference ids on insert (cedant_id, broker_id,
// country_id, currency_id, treaty_type_id are all NOT NULL, plus
// inception_date is validated in the route) — a bare {uw_year, status} create
// 400s/500s. Discover a valid combination once in setup() by copying the
// header of an existing quote, and reuse it for every synthetic CRUD create.

import http from 'k6/http';

/** Fetch one existing quote and return {cedant_id, broker_id, country_id,
 *  currency_id, treaty_type_id} from its header, or null when the target has
 *  no quotes / any id is missing (callers should then skip the CRUD flow). */
export function discoverQuoteTemplate(baseUrl, headers) {
  const list = http.get(`${baseUrl}/api/quotes?limit=1&page=1`, { headers, tags: { endpoint: 'seed_discovery' } });
  if (list.status !== 200) return null;
  let rows;
  try { rows = list.json(); } catch { return null; }
  const id = Array.isArray(rows) && rows[0] && (rows[0].quote_id || rows[0].id);
  if (!id) return null;
  const detail = http.get(`${baseUrl}/api/quotes/${id}`, { headers, tags: { endpoint: 'seed_discovery' } });
  if (detail.status !== 200) return null;
  let quote;
  try { quote = detail.json(); } catch { return null; }
  const header = quote.header || quote;
  const template = {
    cedant_id: header.cedant_id,
    broker_id: header.broker_id,
    country_id: header.country_id,
    currency_id: header.currency_id,
    treaty_type_id: header.treaty_type_id,
  };
  return Object.values(template).every(Boolean) ? template : null;
}

/** JSON body for a synthetic load-test quote create. */
export function quoteCreateBody(template) {
  return JSON.stringify({
    uw_year: 2026,
    status: 'DRAFT',
    inception_date: '2026-01-01',
    ...template,
  });
}
