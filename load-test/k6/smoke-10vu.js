// load-test/k6/smoke-10vu.js
//
// Real operator smoke load: 5-10 concurrent users over the surfaces a
// pricing session actually touches. This complements portfolio.js,
// which is a stress/knee-finding profile at much higher VU counts.
//
// Auth: real production login (cookie + CSRF) — set LOAD_USER / LOAD_PASS.
// Run:
//   LOAD_USER=u LOAD_PASS=p k6 run load-test/k6/smoke-10vu.js
//   LOAD_USER=u LOAD_PASS=p k6 run -e BASE_URL=https://staging.example.com load-test/k6/smoke-10vu.js

import http from 'k6/http';
import { check, group, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';
import { login, authHeaders } from './lib/auth.js';

const BASE_URL = __ENV.BASE_URL || 'http://127.0.0.1:4000';

const lookupsTrend = new Trend('t_lookups', true);
const quoteListTrend = new Trend('t_quote_list', true);
const quoteCrudTrend = new Trend('t_quote_crud', true);
const dashboardTrend = new Trend('t_dashboard', true);
const healthTrend = new Trend('t_health', true);
const pgPoolWaiting = new Trend('pg_pool_waiting', false);
const rateLimited = new Counter('c_rate_limited');

export const options = {
  // Keep each VU's cookie jar across iterations — k6's default per-iteration
  // jar reset drops the auth_token cookie after the login iteration (see
  // capacity.js note).
  noCookiesReset: true,
  stages: [
    { duration: '30s', target: 5 },
    { duration: '2m', target: 5 },
    { duration: '30s', target: 10 },
    { duration: '2m', target: 10 },
    { duration: '30s', target: 0 },
  ],
  thresholds: {
    http_req_failed: ['rate<0.01'],
    'http_req_duration{endpoint:health}': ['p(95)<100'],
    'http_req_duration{endpoint:lookups}': ['p(95)<250'],
    'http_req_duration{endpoint:quote_list}': ['p(95)<450'],
    'http_req_duration{endpoint:quote_crud}': ['p(95)<750'],
    'http_req_duration{endpoint:dashboard}': ['p(95)<1200'],
    c_rate_limited: ['count==0'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'p(95)', 'p(99)', 'max'],
};

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

// Real production auth (cookie + CSRF). Each VU logs in once; the auth cookie
// rides k6's per-VU jar, the CSRF token goes in X-CSRF-Token on mutations.
let vuCsrf = null;
function headers() {
  if (!vuCsrf) vuCsrf = login(BASE_URL);
  return authHeaders(vuCsrf);
}

function tagged(res, trend) {
  trend.add(res.timings.duration);
  if (res.status === 429) rateLimited.add(1);
  return res;
}

function url(path) {
  return `${BASE_URL}${path}`;
}

// Sample pg_pool_waiting from /api/health/deep (X-Pool-Waiting header / pool stats).
function samplePoolWaiting(h) {
  const res = http.get(url('/api/health/deep'), { headers: h, tags: { endpoint: 'deep_health' } });
  const fromHeader = Number(res.headers['X-Pool-Waiting'] || res.headers['x-pool-waiting'] || 0);
  let fromBody = 0;
  try { fromBody = Number(res.json('db.pool.waitingCount') || 0); } catch { fromBody = 0; }
  const waiting = fromHeader > 0 ? fromHeader : fromBody;
  pgPoolWaiting.add(Number.isFinite(waiting) ? waiting : 0);
}

export function setup() {
  const r = http.get(url('/api/health'), { tags: { endpoint: 'health' } });
  if (r.status !== 200) {
    throw new Error(`App not reachable at ${BASE_URL}/api/health (status ${r.status})`);
  }
  return { startedAt: Date.now() };
}

export default function () {
  const h = headers();

  group('health', () => {
    const r = tagged(http.get(url('/api/health'), { headers: h, tags: { endpoint: 'health' } }), healthTrend);
    check(r, { 'health 200': (x) => x.status === 200 });
  });

  // Periodically sample DB pool pressure for the results table.
  if (__ITER % 5 === 0) samplePoolWaiting(h);

  group('lookups', () => {
    const endpoints = ['/api/brokers', '/api/reinsurers', '/api/treaty-types', '/api/class-of-business'];
    const r = tagged(http.get(url(endpoints[randInt(0, endpoints.length - 1)]), {
      headers: h,
      tags: { endpoint: 'lookups' },
    }), lookupsTrend);
    check(r, { 'lookup 200': (x) => x.status === 200 });
  });

  group('quote_list', () => {
    const r = tagged(http.get(url('/api/quotes?status=DRAFT&limit=10'), {
      headers: h,
      tags: { endpoint: 'quote_list' },
    }), quoteListTrend);
    check(r, { 'quote list 200': (x) => x.status === 200 });
  });

  if (Math.random() < 0.2) {
    group('quote_crud', () => {
      const started = Date.now();
      const create = http.post(url('/api/quotes'), JSON.stringify({ uw_year: 2026, status: 'DRAFT' }), {
        headers: h,
        tags: { endpoint: 'quote_crud', op: 'create' },
      });
      if (create.status === 429) rateLimited.add(1);
      const quoteId = create.json('quote_id') || create.json('id');
      if (!quoteId) {
        quoteCrudTrend.add(Date.now() - started);
        check(create, { 'quote create 201': (x) => x.status === 201 });
        return;
      }

      const patch = http.put(url(`/api/quotes/${quoteId}`), JSON.stringify({
        terms: { header: { uw_year: 2026, contract_description: '10vu-smoke' } },
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
    });
  }

  if (Math.random() < 0.25) {
    group('dashboard', () => {
      const r = tagged(http.get(url('/api/dashboard/page/portfolio-overview?uwYear=2026'), {
        headers: h,
        tags: { endpoint: 'dashboard' },
      }), dashboardTrend);
      check(r, { 'dashboard 200': (x) => x.status === 200 });
    });
  }

  sleep(randInt(300, 1200) / 1000);
}

export function teardown(data) {
  const secs = Math.round((Date.now() - data.startedAt) / 1000);
  console.log(`[loadtest:10vu] duration: ${secs}s against ${BASE_URL}`);
}
