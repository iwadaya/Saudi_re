// load-test/k6/portfolio.js
//
// Realistic mixed workload against the reinsurance tool. Exercises the
// four surfaces most sensitive to concurrency:
//   1. Cached lookups      (brokers, reinsurers)  — ref cache + ETag path
//   2. Quotes list          (/api/quotes)          — indexed filter + pagination
//   3. Quotes CRUD          (POST/PUT/GET/DELETE)  — write path + pool usage
//   4. Dashboard aggregates (/api/dashboard/page)  — heavy GROUP BY
//
// Ramp profile: 0 → 30 → 100 → 300 → 0 virtual users. Each stage holds
// long enough for Postgres autovacuum/JIT to warm. Thresholds fail the
// run if error rate > 1% or p95 latency blows past the numbers we quote
// as the demo's capacity ceiling.
//
// Run:
//   k6 run load-test/k6/portfolio.js                    # default http://127.0.0.1:3001
//   k6 run -e BASE_URL=https://staging... load-test/k6/portfolio.js
//   k6 run --summary-export=load-test/out/$(date +%F).json load-test/k6/portfolio.js
//
// Notes on auth/rate-limit:
//   Auth is the real production flow (cookie + CSRF) — set LOAD_USER/LOAD_PASS.
//   The server rate-limits per AUTHENTICATED user id, so all VUs sharing one
//   load account share that limit; bypass the limiter on staging
//   (LOAD_TEST=true) when measuring raw capacity at high VU counts.

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Trend, Counter } from 'k6/metrics';
import { randomIntBetween } from 'https://jslib.k6.io/k6-utils/1.2.0/index.js';
import { login, authHeaders } from './lib/auth.js';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:3001';

// Per-endpoint trend metrics so the summary can show which surface is
// the bottleneck, rather than one global p95 that hides everything.
const lookupsTrend   = new Trend('t_lookups', true);
const listTrend      = new Trend('t_quote_list', true);
const crudTrend      = new Trend('t_quote_crud', true);
const dashboardTrend = new Trend('t_dashboard', true);
const rateLimited    = new Counter('c_rate_limited');

export const options = {
  // Three ramping stages matched to a "real" traffic pattern. Each
  // stage is held long enough (1 min) for p95 to stabilise.
  stages: [
    { duration: '30s', target: 30  },  // warm-up to expected concurrency
    { duration: '1m',  target: 30  },  // steady state — should be comfortable
    { duration: '30s', target: 100 },  // spike (3x planned load)
    { duration: '1m',  target: 100 },  // hold the spike
    { duration: '30s', target: 300 },  // stress (10x planned load)
    { duration: '1m',  target: 300 },  // hold the stress — find the knee
    { duration: '30s', target: 0   },  // cool-down
  ],
  thresholds: {
    // Pass/fail gates. Keep these aggressive enough to notice regressions
    // but realistic for a single-process baseline.
    http_req_failed:   ['rate<0.01'],    // < 1% errors across the whole run
    'http_req_duration{endpoint:health}':    ['p(95)<100'],
    'http_req_duration{endpoint:lookups}':   ['p(95)<300'],
    'http_req_duration{endpoint:quote_list}':['p(95)<500'],
    'http_req_duration{endpoint:quote_crud}':['p(95)<800'],
    'http_req_duration{endpoint:dashboard}': ['p(95)<1500'],
  },
  // Drop the default summary trends in favour of our per-endpoint ones
  summaryTrendStats: ['avg', 'min', 'med', 'p(95)', 'p(99)', 'max'],
};

// A synthetic user id per VU keeps each VU in its own rate-limit
// bucket. Without this, 300 concurrent VUs would share one bucket and
// start getting 429s inside 3 seconds.
// Real production auth (cookie + CSRF). Each VU logs in once; the auth cookie
// rides k6's per-VU jar; the CSRF token goes in X-CSRF-Token on mutations. The
// server now rate-limits per authenticated user id (the real account), so a
// single shared load-test account concentrates the per-user limit — bypass the
// limiter on staging (LOAD_TEST=true) when measuring raw capacity.
let vuCsrf = null;
function userHeaders() {
  if (!vuCsrf) vuCsrf = login(BASE_URL);
  return authHeaders(vuCsrf);
}

function tag429(res) {
  if (res.status === 429) rateLimited.add(1);
}

export function setup() {
  // Sanity ping — if the app isn't up, fail fast with a clear message
  const r = http.get(`${BASE_URL}/api/health`);
  if (r.status !== 200) {
    throw new Error(`App not reachable at ${BASE_URL}/api/health (status ${r.status})`);
  }
  return { baseUrl: BASE_URL, startedAt: Date.now() };
}

export default function (data) {
  const headers = userHeaders();
  const url = (p) => `${data.baseUrl}${p}`;

  // ── 1. Cached lookups (25% of iterations hit these first — mimics
  //     the app's own behaviour of warming refs on screen load).
  group('lookups', () => {
    const endpoints = ['/api/brokers', '/api/reinsurers', '/api/treaty-types', '/api/class-of-business'];
    const path = endpoints[randomIntBetween(0, endpoints.length - 1)];
    const r = http.get(url(path), { headers, tags: { endpoint: 'lookups' } });
    lookupsTrend.add(r.timings.duration);
    tag429(r);
    check(r, { 'lookup 200': (x) => x.status === 200 });
  });

  // ── 2. Quote list — indexed filter (status + uw_year) + pagination
  group('quote_list', () => {
    const r = http.get(url('/api/quotes?status=DRAFT&limit=10'), {
      headers, tags: { endpoint: 'quote_list' },
    });
    listTrend.add(r.timings.duration);
    tag429(r);
    check(r, { 'list 200': (x) => x.status === 200 });
  });

  // ── 3. Quote CRUD — only ~30% of iterations. A real underwriter
  //     doesn't create-patch-delete every second; this matches a
  //     realistic 3:1 read/write mix without over-inflating write load.
  if (Math.random() < 0.30) {
    group('quote_crud', () => {
      const t0 = Date.now();

      const create = http.post(url('/api/quotes'), JSON.stringify({
        uw_year: 2026, status: 'DRAFT',
      }), { headers, tags: { endpoint: 'quote_crud', op: 'create' } });
      tag429(create);
      if (create.status !== 201) {
        crudTrend.add(Date.now() - t0);
        return;
      }
      const quoteId = create.json('quote_id') || create.json('id');
      if (!quoteId) return;

      const patch = http.put(url(`/api/quotes/${quoteId}`), JSON.stringify({
        terms: { header: { uw_year: 2027, contract_description: 'loadtest' } },
      }), { headers, tags: { endpoint: 'quote_crud', op: 'patch' } });
      tag429(patch);

      const read = http.get(url(`/api/quotes/${quoteId}`), {
        headers, tags: { endpoint: 'quote_crud', op: 'read' },
      });
      tag429(read);

      // Always clean up — we don't want a 10-min run to leave 100k rows
      http.del(url(`/api/quotes/${quoteId}`), null, {
        headers, tags: { endpoint: 'quote_crud', op: 'delete' },
      });

      crudTrend.add(Date.now() - t0);
      check({ c: create.status, p: patch.status, r: read.status }, {
        'crud flow ok': (s) => s.c === 201 && s.p === 200 && s.r === 200,
      });
    });
  }

  // ── 4. Dashboard aggregate — the heaviest read. Only hit on 20% of
  //     iterations (a single dashboard view emits one of these, not
  //     one per interaction).
  if (Math.random() < 0.20) {
    group('dashboard', () => {
      const r = http.get(url('/api/dashboard/page/portfolio-overview?uwYear=2026'), {
        headers, tags: { endpoint: 'dashboard' },
      });
      dashboardTrend.add(r.timings.duration);
      tag429(r);
      check(r, { 'dashboard 200': (x) => x.status === 200 });
    });
  }

  // A short think-time between iterations so each VU doesn't
  // hammer at zero latency. 200–800ms is typical "human scrolling".
  sleep(randomIntBetween(200, 800) / 1000);
}

export function teardown(data) {
  const secs = Math.round((Date.now() - data.startedAt) / 1000);
  console.log(`[loadtest] total duration: ${secs}s against ${data.baseUrl}`);
}
