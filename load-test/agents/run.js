#!/usr/bin/env node
// load-test/agents/run.js
//
// Orchestrator for the underwriter-agent simulation ("agents modelling
// treaties"). Boots N authenticated underwriter agents against a running
// server and has them model a portfolio concurrently:
//
//   • each agent: create treaties -> save terms slice-by-slice -> triangles,
//     dev factors, losses -> verify EVERY PUT with a GET field-by-field
//   • workflow to SIGNED, then renew (renewals count toward the portfolio)
//   • quote-side flows: create, save, renew, amend / submit / decline / delete
//   • adversarial probes: stale-baseline 409s, same-baseline write races,
//     peer + anonymous write rejection, illegal workflow jumps, bad payloads
//
// Usage:
//   node load-test/agents/run.js \
//     [--agents 40] [--treaties 100] [--base-url http://127.0.0.1:4600] \
//     [--seed 20260823] [--out load-test/out/agents-run.json]
//
// The server must run with ALLOW_NAME_AUTH=true (real cookie sessions for
// every agent) and ideally LOAD_TEST=true (lifts the shared-IP API rate
// limiter so 40 agents on one host measure the server, not the limiter).

import { writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import { AgentSession } from './lib/http.js';
import { Checker } from './lib/check.js';
import { Rng, underwriterName } from './lib/gen.js';
import { Underwriter } from './underwriter.js';

// ── CLI ─────────────────────────────────────────────────────────────────────
function arg(name, dflt) {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] !== undefined) return process.argv[i + 1];
  return dflt;
}
const BASE_URL = arg('base-url', process.env.BASE_URL || 'http://127.0.0.1:4600');
const N_AGENTS = Number(arg('agents', process.env.AGENTS || 40));
const N_TREATIES = Number(arg('treaties', process.env.TREATIES || 100));
const SEED = Number(arg('seed', process.env.SEED || 20260823));
const OUT = arg('out', process.env.OUT || `load-test/out/agents-run-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
const UW_YEAR = Number(arg('uw-year', new Date().getFullYear() + 1));

// ── quota split ─────────────────────────────────────────────────────────────
// Contract count = base creates + renewals. Renewals ~40% of the portfolio
// (a renewal book), spread one per agent first, remainder round-robin.
function planQuotas(nAgents, nTreaties) {
  const renewTarget = Math.min(nAgents, Math.round(nTreaties * 0.4));
  const baseTarget = nTreaties - renewTarget;
  const quotas = Array.from({ length: nAgents }, (_, i) => ({
    baseTreaties: 0, renewals: 0,
    kinds: i % 2 === 0 ? ['PROP', 'NP'] : ['NP', 'PROP'],
  }));
  for (let t = 0; t < baseTarget; t += 1) quotas[t % nAgents].baseTreaties += 1;
  for (let r = 0; r < renewTarget; r += 1) quotas[r % nAgents].renewals += 1;
  // A renewal needs a base treaty to renew from.
  for (const q of quotas) if (q.renewals > 0 && q.baseTreaties === 0) { q.baseTreaties += 1; q.renewals -= 1; }
  return quotas;
}

// ── latency aggregation ─────────────────────────────────────────────────────
function quantile(sorted, q) {
  if (!sorted.length) return null;
  const pos = (sorted.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
}
function aggregate(metrics) {
  const byLabel = new Map();
  for (const m of metrics) {
    const b = byLabel.get(m.label) || { label: m.label, count: 0, errors: 0, statuses: {}, ms: [] };
    b.count += 1;
    if (m.status >= 500 || m.status === 0) b.errors += 1;
    b.statuses[m.status] = (b.statuses[m.status] || 0) + 1;
    b.ms.push(m.ms);
    byLabel.set(m.label, b);
  }
  const rows = [...byLabel.values()].map((b) => {
    const sorted = [...b.ms].sort((x, y) => x - y);
    return {
      label: b.label,
      count: b.count,
      errors: b.errors,
      statuses: b.statuses,
      p50: Math.round(quantile(sorted, 0.5)),
      p95: Math.round(quantile(sorted, 0.95)),
      p99: Math.round(quantile(sorted, 0.99)),
      max: Math.round(sorted[sorted.length - 1] || 0),
    };
  });
  rows.sort((a, b) => b.count - a.count);
  return rows;
}

// ── main ────────────────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  console.log(`agents-modelling-treaties — ${N_AGENTS} underwriters, ${N_TREATIES} treaties, base ${BASE_URL}, seed ${SEED}, uw year ${UW_YEAR}`);

  // 0. Server up?
  const probe = new AgentSession({ baseUrl: BASE_URL, name: 'Sim Probe' });
  const health = await probe.get('/api/health', { label: 'GET /health' });
  if (health.status !== 200) {
    console.error(`server not healthy at ${BASE_URL}: HTTP ${health.status} ${health.error || ''}`);
    process.exit(2);
  }

  // 1. Reference data (once, shared by all agents). Lookups sit behind
  //    requireAuth, so the probe signs in like any other user.
  await probe.login().catch((e) => { console.error(`probe login failed: ${e.message}`); process.exit(2); });
  const [cedants, brokers, types, cobs, countries, currencies] = await Promise.all([
    probe.get('/api/cedants', { label: 'GET /cedants' }),
    probe.get('/api/brokers', { label: 'GET /brokers' }),
    probe.get('/api/treaty-types', { label: 'GET /treaty-types' }),
    probe.get('/api/class-of-business', { label: 'GET /class-of-business' }),
    probe.get('/api/ref/lists/country/items', { label: 'GET /ref/lists/:key/items' }),
    probe.get('/api/ref/lists/currency/items', { label: 'GET /ref/lists/:key/items' }),
  ]);
  const refs = {
    cedants: cedants.json || [],
    brokers: brokers.json || [],
    treatyTypes: types.json || [],
    cobs: (cobs.json || []).map((c) => ({ id: c.id ?? c.class_of_business_id, name: c.name ?? c.class_of_business })),
    countries: countries.json || [],
    currencies: currencies.json || [],
  };
  for (const [k, v] of Object.entries(refs)) {
    if (!v.length) {
      console.error(`reference data "${k}" is empty — is the DB migrated/seeded?`);
      process.exit(2);
    }
  }
  console.log(`refs: ${refs.cedants.length} cedants, ${refs.brokers.length} brokers, ${refs.treatyTypes.length} treaty types, ${refs.cobs.length} COBs, ${refs.countries.length} countries, ${refs.currencies.length} currencies`);

  // 2. Login all agents (staggered mildly — the login limiter is per identity,
  //    but account creation contends on username dedup).
  const checker = new Checker();
  const metrics = [];
  const agents = [];
  const loginStart = Date.now();
  const loginResults = await Promise.allSettled(
    Array.from({ length: N_AGENTS }, async (_, i) => {
      await new Promise((r) => setTimeout(r, i * 25));
      const session = new AgentSession({ baseUrl: BASE_URL, name: underwriterName(i), metrics });
      await session.login();
      return { i, session };
    }),
  );
  for (const lr of loginResults) {
    if (lr.status === 'fulfilled') {
      const { i, session } = lr.value;
      agents[i] = new Underwriter({
        session,
        checker,
        rng: new Rng(SEED + i * 7919),
        refs,
        uwYear: UW_YEAR,
        index: i,
      });
      checker.add({ agent: session.name, category: 'auth', name: 'name-login session established', pass: true });
    } else {
      checker.add({ agent: '(login)', category: 'auth', name: 'name-login session established', pass: false, detail: String(lr.reason).slice(0, 300) });
    }
  }
  const live = agents.filter(Boolean);
  console.log(`${live.length}/${N_AGENTS} agents authenticated in ${Date.now() - loginStart}ms`);
  if (live.length < N_AGENTS) console.warn('some agents failed to authenticate — see report');

  // Distinct-identity sanity: every agent must be its own uw_user.
  const ids = new Set(live.map((a) => a.s.userId));
  checker.add({
    agent: '(orchestrator)', category: 'auth',
    name: `all ${live.length} agents have distinct user ids`,
    pass: ids.size === live.length,
    detail: `${ids.size} distinct ids for ${live.length} agents`,
  });

  // 3. Wire peers (ring) + one anonymous session for negative auth probes.
  for (let i = 0; i < live.length; i += 1) {
    live[i].peer = live[(i + 1) % live.length].s;
    live[i].anonSession = new AgentSession({ baseUrl: BASE_URL, name: 'anonymous', metrics });
  }

  // 4. Health/pool sampler during the run.
  const poolSamples = [];
  const sampler = setInterval(async () => {
    try {
      const r = await probe.get('/api/health/deep', { label: 'GET /health/deep' });
      if (r.status === 200 && r.json) {
        const pool = r.json.db?.pool || r.json.pool || null;
        poolSamples.push({
          t: Date.now() - t0,
          pool,
          waiting: pool?.waitingCount ?? pool?.waiting ?? null,
        });
      }
    } catch { /* sampler must never kill the run */ }
  }, 2000);
  sampler.unref?.();

  // 5. Run all workbooks CONCURRENTLY — this is the 40-underwriters-at-once test.
  const quotas = planQuotas(live.length, N_TREATIES);
  const workStart = Date.now();
  const outcomes = await Promise.allSettled(live.map((a, i) => a.run(quotas[i])));
  const workMs = Date.now() - workStart;
  clearInterval(sampler);
  outcomes.forEach((o, i) => {
    if (o.status === 'rejected') {
      checker.add({
        agent: live[i].name, category: 'harness',
        name: 'workbook completed without throwing', pass: false,
        detail: String(o.reason?.stack || o.reason).slice(0, 500),
      });
    }
  });

  // 6. Portfolio-level integrity: count what the API now reports.
  // Renewals roll into UW_YEAR+1, so the portfolio count reads unfiltered.
  const admin = live[0]?.s || probe;
  const [listAll, listQuotes] = await Promise.all([
    admin.get(`/api/treaties?limit=500`, { label: 'GET /treaties (list)' }),
    admin.get(`/api/quotes?limit=500`, { label: 'GET /quotes (list)' }),
  ]);
  const createdTreaties = live.reduce((s, a) => s + a.treaties.length, 0);
  const renewalCount = live.reduce((s, a) => s + a.treaties.filter((x) => x.isRenewal).length, 0);
  const totalFromHeader = Number(listAll.headers.get?.('x-total-count'));
  checker.add({
    agent: '(orchestrator)', category: 'portfolio',
    name: `portfolio holds the planned ${N_TREATIES} contracts`,
    pass: createdTreaties === N_TREATIES,
    detail: `created ${createdTreaties} (${createdTreaties - renewalCount} base + ${renewalCount} renewals)`,
  });
  checker.add({
    agent: '(orchestrator)', category: 'portfolio',
    name: 'treaty list X-Total-Count sees every contract of the run',
    pass: Number.isFinite(totalFromHeader) && totalFromHeader >= createdTreaties,
    detail: `X-Total-Count=${totalFromHeader} vs created ${createdTreaties} (renewals carry next uw_year)`,
  });

  // Cross-check: every agent-held treaty id resolves via GET.
  let ghost = 0;
  for (const a of live) {
    for (const t of a.treaties) {
      const g = await a.s.get(`/api/treaties/${t.id}`, { label: 'GET /treaties/:id' });
      if (g.status !== 200) ghost += 1;
    }
  }
  checker.add({
    agent: '(orchestrator)', category: 'portfolio',
    name: 'every created contract independently readable at the end',
    pass: ghost === 0,
    detail: `${ghost} contracts unreadable`,
  });

  // 7. Report.
  const summary = checker.summary();
  const latency = aggregate(metrics);
  const statuses = {};
  for (const m of metrics) statuses[m.status] = (statuses[m.status] || 0) + 1;
  const raceRows = checker.results.filter((r) => r.category === 'lock-race');
  const maxWaiting = poolSamples.reduce((mx, s) => Math.max(mx, Number(s.waiting) || 0), 0);

  const report = {
    startedAt: new Date(t0).toISOString(),
    baseUrl: BASE_URL,
    seed: SEED,
    uwYear: UW_YEAR,
    agents: { requested: N_AGENTS, authenticated: live.length },
    portfolio: {
      contractsPlanned: N_TREATIES,
      contractsCreated: createdTreaties,
      baseContracts: createdTreaties - renewalCount,
      renewals: renewalCount,
      quotes: live.reduce((s, a) => s + a.quotes.length, 0),
      quoteListTotal: Number(listQuotes.headers.get?.('x-total-count')) || null,
    },
    durations: { totalMs: Date.now() - t0, concurrentWorkMs: workMs },
    http: { calls: metrics.length, byStatus: statuses },
    latency,
    pool: { samples: poolSamples.length, maxWaiting },
    checks: {
      total: summary.total,
      passed: summary.passed,
      failed: summary.failed,
      byCategory: summary.byCategory,
    },
    lockRace: raceRows.map((r) => ({ pass: r.pass, detail: r.detail })),
    failures: summary.failures.slice(0, 400),
  };
  mkdirSync(path.dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2));

  // Console summary.
  console.log('\n════════ agents-modelling-treaties — run summary ════════');
  console.log(`wall clock            ${(report.durations.totalMs / 1000).toFixed(1)}s (concurrent modelling phase ${(workMs / 1000).toFixed(1)}s)`);
  console.log(`agents                ${live.length}/${N_AGENTS} authenticated, all concurrent`);
  console.log(`portfolio             ${report.portfolio.contractsCreated} contracts (${report.portfolio.baseContracts} base + ${report.portfolio.renewals} renewals), ${report.portfolio.quotes} quotes held by agents`);
  console.log(`http                  ${metrics.length} calls — statuses ${JSON.stringify(statuses)}`);
  console.log(`pg pool               max waiting ${maxWaiting} across ${poolSamples.length} samples`);
  console.log(`checks                ${summary.passed}/${summary.total} passed, ${summary.failed} failed`);
  console.log('\nper-category checks:');
  for (const [cat, v] of Object.entries(summary.byCategory).sort()) {
    console.log(`  ${cat.padEnd(22)} ${String(v.total - v.failed).padStart(5)}/${String(v.total).padEnd(5)} ${v.failed ? `✗ ${v.failed} FAILED` : '✓'}`);
  }
  console.log('\nlatency by endpoint (ms):');
  console.log(`  ${'endpoint'.padEnd(46)} ${'count'.padStart(6)} ${'p50'.padStart(6)} ${'p95'.padStart(6)} ${'p99'.padStart(6)} ${'max'.padStart(6)} ${'5xx/0'.padStart(6)}`);
  for (const row of latency) {
    console.log(`  ${row.label.padEnd(46)} ${String(row.count).padStart(6)} ${String(row.p50).padStart(6)} ${String(row.p95).padStart(6)} ${String(row.p99).padStart(6)} ${String(row.max).padStart(6)} ${String(row.errors).padStart(6)}`);
  }
  if (summary.failed) {
    console.log(`\nfirst failures (${Math.min(summary.failed, 25)} of ${summary.failed}):`);
    for (const f of summary.failures.slice(0, 25)) {
      console.log(`  ✗ [${f.category}] ${f.agent} — ${f.name}${f.entity ? ` (${f.entity})` : ''}\n      ${f.detail}`);
    }
  }
  console.log(`\nfull report: ${OUT}`);
  process.exit(summary.failed ? 1 : 0);
}

main().catch((e) => {
  console.error('orchestrator crashed:', e);
  process.exit(3);
});
