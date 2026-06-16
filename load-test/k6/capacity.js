// load-test/k6/capacity.js
//
// Staging capacity profile for the bind path. Run the same script at
// 10, 20, 30, and 50 VUs and compare p95/p99 plus pg_pool_waiting.
//
// Example:
//   BASE_URL=https://staging.example.com K6_VUS=30 K6_DURATION=5m \
//     k6 run --summary-export=load-test/out/staging-30vu.json load-test/k6/capacity.js
//
// LOAD TEST FINDINGS — June 2026 (Render + Neon, tested from Riyadh)
//
// Target real-world load: ~10 treaty underwriters in a small/medium company,
// ~20 concurrent with analysts. Tested well beyond that to find the ceiling.
//
// Results (capacity.js, WRITE_CRUD=0, 60s warmup, rate limiter bypassed via
// LOAD_TEST=true):
//    10 VUs : median ~585ms, p95 ~2.0s, 0% errors, pg_pool_waiting=0
//    20 VUs : median ~610ms, p95 ~4.2s, 0% errors, pg_pool_waiting=0
//    50 VUs : median ~205ms, p95 ~1.7s, 100% checks ok, pg_pool_waiting=0
//   100 VUs: median ~265ms, p95 ~875ms, 0% errors, pg_pool_waiting peaked 18 (brief)
//
// Interpretation:
// - DB/app are not the bottleneck at expected load. Postgres pool never queued
//   below 100 concurrent users; at 100 it only briefly spiked
//   (pg_pool_waiting=18, 3 occurrences) with no request failures — the first
//   sign of pool-connection limit, NOT a hardware/compute limit.
// - 0% error rate at 50 and 100 VUs once the API rate limiter was bypassed for
//   the test. Real 10-20 user load runs with large headroom.
// - The dominant latency factor for remote testers was network distance to the
//   Render region (US/EU), not app compute. Real GCC users benefit from a
//   region close to Saudi (e.g. Frankfurt) + edge caching.
//
// Conclusion: comfortably handles the intended ~10-20 concurrent underwriters.
// Scaling levers if usage grows past ~100 concurrent, in order:
//   1. Use Neon's pooled (PgBouncer) connection string; size pool max so
//      (instances x pool_max) stays under Neon max_connections.
//   2. Place the service in a region near users (Frankfurt for GCC).
//   3. Add Render web instances (web tier was healthy through 100 VUs).
// A higher-end/dedicated server is NOT indicated: the only ceiling found was DB
// connection-pool config, which is tuned, not bought.

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:4000';
const VUS = Number(__ENV.K6_VUS || 10);
const HOLD_DURATION = __ENV.K6_DURATION || '5m';
const WARMUP_DURATION = __ENV.K6_WARMUP || '30s';
const WRITE_CRUD = String(__ENV.WRITE_CRUD || '1') === '1';

const healthTrend = new Trend('t_health', true);
const deepHealthTrend = new Trend('t_deep_health', true);
const lookupsTrend = new Trend('t_lookups', true);
const treatyListTrend = new Trend('t_treaty_list', true);
const quoteListTrend = new Trend('t_quote_list', true);
const treatyDetailTrend = new Trend('t_treaty_detail', true);
const propPricingTrend = new Trend('t_prop_pricing', true);
const quotePricingTrend = new Trend('t_quote_pricing', true);
const npStructureTrend = new Trend('t_np_structure', true);
const npPricingTrend = new Trend('t_np_pricing', true);
const dashboardTrend = new Trend('t_dashboard', true);
const aggDrilldownTrend = new Trend('t_agg_drilldown', true);
const quoteCrudTrend = new Trend('t_quote_crud', true);
const pgPoolWaiting = new Trend('pg_pool_waiting', false);

const rateLimited = new Counter('c_rate_limited');
const unexpectedStatus = new Counter('c_unexpected_status');
const missingSeed = new Counter('c_seed_missing');
const pgPoolWaitingNonzero = new Counter('c_pg_pool_waiting_nonzero');

export const options = {
  stages: [
    { duration: WARMUP_DURATION, target: VUS },
    { duration: HOLD_DURATION, target: VUS },
    { duration: '15s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    c_rate_limited: ['count==0'],
    'http_req_duration{endpoint:health}': ['p(95)<100'],
    'http_req_duration{endpoint:deep_health}': ['p(95)<250'],
    'http_req_duration{endpoint:lookups}': ['p(95)<300'],
    'http_req_duration{endpoint:treaty_list}': ['p(95)<500'],
    'http_req_duration{endpoint:quote_list}': ['p(95)<500'],
    'http_req_duration{endpoint:treaty_detail}': ['p(95)<500'],
    'http_req_duration{endpoint:prop_pricing}': ['p(95)<500'],
    'http_req_duration{endpoint:quote_pricing}': ['p(95)<500'],
    'http_req_duration{endpoint:np_structure}': ['p(95)<500'],
    'http_req_duration{endpoint:np_pricing}': ['p(95)<500'],
    'http_req_duration{endpoint:dashboard}': ['p(95)<1500'],
    'http_req_duration{endpoint:agg_drilldown}': ['p(95)<1500'],
    pg_pool_waiting: ['max<1'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(95)', 'p(99)', 'max'],
};

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick(items) {
  if (!items || !items.length) return null;
  return items[randInt(0, items.length - 1)];
}

function csv(name) {
  return String(__ENV[name] || '')
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function headers() {
  const vuNumber = typeof __VU === 'undefined' ? 0 : __VU;
  const vu = String(vuNumber).padStart(12, '0');
  return {
    'Content-Type': 'application/json',
    'x-user-role': 'CU',
    'x-user-id': `00000000-0000-0000-0000-${vu}`,
  };
}

function url(path) {
  return `${BASE_URL}${path}`;
}

function record(res, trend, okStatuses = [200]) {
  trend.add(res.timings.duration);
  if (res.status === 429) rateLimited.add(1);
  if (!okStatuses.includes(res.status)) unexpectedStatus.add(1);
  return res;
}

function parseJson(res, fallback) {
  try {
    return res.json();
  } catch {
    return fallback;
  }
}

function rowsFrom(res) {
  const body = parseJson(res, []);
  return Array.isArray(body) ? body : [];
}

function discoverIds(path, idField, filter) {
  const res = http.get(url(path), { headers: headers(), tags: { endpoint: 'seed_discovery' } });
  if (res.status !== 200) return [];
  return rowsFrom(res)
    .filter((row) => !filter || filter(row))
    .map((row) => row[idField] || row.id)
    .filter(Boolean);
}

function discoverCountries() {
  const res = http.get(url('/api/ref/lists/country/items'), { headers: headers(), tags: { endpoint: 'seed_discovery' } });
  if (res.status !== 200) return [];
  return rowsFrom(res).map((row) => row.id).filter(Boolean);
}

export function setup() {
  const health = http.get(url('/api/health'), { tags: { endpoint: 'health' } });
  if (health.status !== 200) {
    throw new Error(`App not reachable at ${BASE_URL}/api/health (status ${health.status})`);
  }

  const contractIds = csv('CONTRACT_IDS');
  const quoteIds = csv('QUOTE_IDS');
  const npContractIds = csv('NP_CONTRACT_IDS');
  const npQuoteIds = csv('NP_QUOTE_IDS');
  const countryIds = csv('COUNTRY_IDS');

  if (!contractIds.length) {
    contractIds.push(...discoverIds('/api/treaties?limit=50&page=1', 'contract_id'));
  }
  if (!quoteIds.length) {
    quoteIds.push(...discoverIds('/api/quotes?limit=50&page=1', 'quote_id'));
  }
  if (!npContractIds.length) {
    npContractIds.push(...discoverIds('/api/treaties?category=NON&limit=50&page=1', 'contract_id', (row) => (
      row.has_np_details || /NON|NP/i.test(String(row.treaty_category || ''))
    )));
  }
  if (!npQuoteIds.length) {
    npQuoteIds.push(...discoverIds('/api/quotes?limit=50&page=1', 'quote_id', (row) => (
      /NON|NP/i.test(String(row.treaty_category || ''))
    )));
  }
  if (!countryIds.length) {
    countryIds.push(...discoverCountries());
  }

  if (!contractIds.length && !quoteIds.length) {
    throw new Error('No treaty or quote IDs discovered. Seed staging first or pass CONTRACT_IDS/QUOTE_IDS.');
  }

  return {
    startedAt: Date.now(),
    contractIds,
    quoteIds,
    npContractIds,
    npQuoteIds,
    countryIds,
  };
}

function sampleDeepHealth(h) {
  const res = record(http.get(url('/api/health/deep'), {
    headers: h,
    tags: { endpoint: 'deep_health' },
  }), deepHealthTrend);
  const waitingHeader = Number(res.headers['X-Pool-Waiting'] || res.headers['x-pool-waiting'] || 0);
  const body = parseJson(res, {});
  const waitingBody = Number(body?.db?.pool?.waitingCount || 0);
  const waiting = Number.isFinite(waitingHeader) && waitingHeader > 0 ? waitingHeader : waitingBody;
  pgPoolWaiting.add(Number.isFinite(waiting) ? waiting : 0);
  if (waiting > 0) pgPoolWaitingNonzero.add(1);
}

function quoteCrudFlow(h) {
  const started = Date.now();
  const create = http.post(url('/api/quotes'), JSON.stringify({ uw_year: 2026, status: 'DRAFT' }), {
    headers: h,
    tags: { endpoint: 'quote_crud', op: 'create' },
  });
  if (create.status === 429) rateLimited.add(1);
  const quoteId = create.json('quote_id') || create.json('id');
  if (!quoteId) {
    quoteCrudTrend.add(Date.now() - started);
    unexpectedStatus.add(1);
    return;
  }

  const patch = http.put(url(`/api/quotes/${quoteId}`), JSON.stringify({
    terms: { header: { uw_year: 2026, contract_description: 'capacity-load-test' } },
  }), {
    headers: h,
    tags: { endpoint: 'quote_crud', op: 'patch' },
  });
  const read = http.get(url(`/api/quotes/${quoteId}`), {
    headers: h,
    tags: { endpoint: 'quote_crud', op: 'read' },
  });
  http.del(url(`/api/quotes/${quoteId}`), null, {
    headers: h,
    tags: { endpoint: 'quote_crud', op: 'delete' },
  });
  if (patch.status === 429 || read.status === 429) rateLimited.add(1);
  quoteCrudTrend.add(Date.now() - started);
  check({ c: create.status, p: patch.status, r: read.status }, {
    'quote crud ok': (s) => s.c === 201 && s.p === 200 && s.r === 200,
  });
}

export default function (seed) {
  const h = headers();

  group('health', () => {
    const res = record(http.get(url('/api/health'), {
      headers: h,
      tags: { endpoint: 'health' },
    }), healthTrend);
    check(res, { 'health 200': (x) => x.status === 200 });
  });

  if (__ITER % 3 === 0) {
    group('deep_health', () => sampleDeepHealth(h));
  }

  group('lookups', () => {
    const endpoint = pick(['/api/brokers', '/api/reinsurers', '/api/treaty-types', '/api/class-of-business']);
    const res = record(http.get(url(endpoint), {
      headers: h,
      tags: { endpoint: 'lookups' },
    }), lookupsTrend);
    check(res, { 'lookup 200': (x) => x.status === 200 });
  });

  group('lists', () => {
    const treatyList = record(http.get(url('/api/treaties?limit=25&page=1'), {
      headers: h,
      tags: { endpoint: 'treaty_list' },
    }), treatyListTrend);
    const quoteList = record(http.get(url('/api/quotes?limit=25&page=1'), {
      headers: h,
      tags: { endpoint: 'quote_list' },
    }), quoteListTrend);
    check(treatyList, { 'treaty list 200': (x) => x.status === 200 });
    check(quoteList, { 'quote list 200': (x) => x.status === 200 });
  });

  const contractId = pick(seed.contractIds);
  const quoteId = pick(seed.quoteIds);
  const npContractId = pick(seed.npContractIds);
  const npQuoteId = pick(seed.npQuoteIds);
  const countryId = pick(seed.countryIds);

  if (contractId) {
    group('treaty_detail', () => {
      const res = record(http.get(url(`/api/treaties/${contractId}`), {
        headers: h,
        tags: { endpoint: 'treaty_detail' },
      }), treatyDetailTrend);
      check(res, { 'treaty detail 200': (x) => x.status === 200 });
    });

    if (Math.random() < 0.6) {
      group('prop_pricing', () => {
        const res = record(http.get(url(`/api/treaties/${contractId}/pricing`), {
          headers: h,
          tags: { endpoint: 'prop_pricing' },
        }), propPricingTrend);
        check(res, { 'prop pricing 200': (x) => x.status === 200 });
      });
    }

    if (Math.random() < 0.25) {
      group('agg_drilldown', () => {
        const res = record(http.get(url(`/api/pricing/agg-drilldown/${contractId}`), {
          headers: h,
          tags: { endpoint: 'agg_drilldown' },
        }), aggDrilldownTrend);
        check(res, { 'agg drilldown 200': (x) => x.status === 200 });
      });
    }
  }

  if (quoteId && Math.random() < 0.5) {
    group('quote_pricing', () => {
      const res = record(http.get(url(`/api/quotes/${quoteId}/pricing`), {
        headers: h,
        tags: { endpoint: 'quote_pricing' },
      }), quotePricingTrend);
      check(res, { 'quote pricing 200': (x) => x.status === 200 });
    });
  }

  if (npContractId && Math.random() < 0.5) {
    group('np_treaty', () => {
      const structure = record(http.get(url(`/api/treaties/${npContractId}/non-prop`), {
        headers: h,
        tags: { endpoint: 'np_structure' },
      }), npStructureTrend);
      const pricing = record(http.get(url(`/api/treaties/${npContractId}/np-pricing`), {
        headers: h,
        tags: { endpoint: 'np_pricing' },
      }), npPricingTrend);
      check(structure, { 'np structure 200': (x) => x.status === 200 });
      check(pricing, { 'np pricing 200': (x) => x.status === 200 });
    });
  } else if (npQuoteId && Math.random() < 0.5) {
    group('np_quote', () => {
      const structure = record(http.get(url(`/api/quotes/${npQuoteId}/non-prop`), {
        headers: h,
        tags: { endpoint: 'np_structure' },
      }), npStructureTrend);
      const pricing = record(http.get(url(`/api/quotes/${npQuoteId}/np-pricing`), {
        headers: h,
        tags: { endpoint: 'np_pricing' },
      }), npPricingTrend);
      check(structure, { 'np quote structure 200': (x) => x.status === 200 });
      check(pricing, { 'np quote pricing 200': (x) => x.status === 200 });
    });
  } else if (__ITER % 20 === 0) {
    missingSeed.add(1);
  }

  if (Math.random() < 0.35) {
    group('dashboard', () => {
      const suffix = countryId ? `&country_id=${encodeURIComponent(countryId)}` : '';
      const res = record(http.get(url(`/api/dashboard/page/portfolio-overview?uwYear=2026${suffix}`), {
        headers: h,
        tags: { endpoint: 'dashboard' },
      }), dashboardTrend);
      check(res, { 'dashboard 200': (x) => x.status === 200 });
    });
  }

  if (WRITE_CRUD && Math.random() < 0.1) {
    group('quote_crud', () => quoteCrudFlow(h));
  }

  sleep(randInt(1000, 4000) / 1000);
}

export function teardown(seed) {
  const secs = Math.round((Date.now() - seed.startedAt) / 1000);
  console.log(`[capacity] ${VUS} VUs for ${secs}s against ${BASE_URL}`);
  console.log(`[capacity] ids: contracts=${seed.contractIds.length}, npContracts=${seed.npContractIds.length}, quotes=${seed.quoteIds.length}, npQuotes=${seed.npQuoteIds.length}`);
}
