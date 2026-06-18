// GET /home/summary list scoping. The home lists (drafts/submitted/quotes AND
// upcoming renewals) default to the caller's own work; scope=all widens them to
// the whole book. Calculation queries (statusCounts, region_premiums) stay
// whole-portfolio. The pg pool is mocked so we can inspect the exact SQL + binds
// handed to each query.
import { describe, it, expect, vi, beforeEach } from 'vitest';

const { poolMock } = vi.hoisted(() => ({ poolMock: { query: vi.fn() } }));
vi.mock('../db/pool.js', () => ({ pool: poolMock }));

const { default: homeRouter } = await import('./home.js');

// Drive GET /home/summary through the router with a plain req/res, resolving
// once the handler responds (res.json) or errors (next).
function getSummary({ query = {}, user = null } = {}) {
  return new Promise((resolve, reject) => {
    const req = { method: 'GET', url: '/home/summary', query, user, headers: {} };
    const res = {
      statusCode: 200,
      status(c) { this.statusCode = c; return this; },
      json(payload) { resolve({ status: this.statusCode, body: payload }); },
      setHeader() { return this; },
    };
    homeRouter(req, res, (err) => (err ? reject(err) : resolve({ status: 404, body: null })));
  });
}

// Find the upcoming-renewals query among the captured pool.query calls.
function renewalsCall() {
  const call = poolMock.query.mock.calls.find(([sql]) => /renewal_date BETWEEN/.test(sql));
  if (!call) throw new Error('renewals query not issued');
  return { sql: call[0], params: call[1] };
}

beforeEach(() => {
  poolMock.query.mockReset();
  // Every query resolves to an empty result set — enough for the handler to
  // assemble a response; we only assert on the SQL/binds it sends.
  poolMock.query.mockResolvedValue({ rows: [] });
});

describe('GET /home/summary — upcoming renewals scoping', () => {
  it('default "mine" view scopes renewals to the caller (incl. unassigned)', async () => {
    const res = await getSummary({ user: { userId: 'me-123' } });
    expect(res.status).toBe(200);
    const { sql, params } = renewalsCall();
    expect(sql).toContain('c.assigned_to_user_id = $1');
    expect(sql).toContain('c.assigned_to_user_id IS NULL');
    expect(params).toEqual(['me-123']);
  });

  it('scope=all leaves renewals whole-portfolio (no owner filter, no binds)', async () => {
    const res = await getSummary({ query: { scope: 'all' }, user: { userId: 'me-123' } });
    expect(res.status).toBe(200);
    const { sql, params } = renewalsCall();
    expect(sql).not.toContain('assigned_to_user_id = $1');
    expect(params).toEqual([]);
  });

  it('legacy user_id=all also leaves renewals whole-portfolio', async () => {
    const res = await getSummary({ query: { user_id: 'all' }, user: { userId: 'me-123' } });
    expect(res.status).toBe(200);
    const { sql, params } = renewalsCall();
    expect(sql).not.toContain('assigned_to_user_id = $1');
    expect(params).toEqual([]);
  });

  it('renewals reuse the same owner filter as the drafts list', async () => {
    await getSummary({ user: { userId: 'me-123' } });
    const draftsCall = poolMock.query.mock.calls.find(([sql]) => /uw_status='DRAFT'/.test(sql));
    const { sql: renewalsSql, params: renewalsParams } = renewalsCall();
    // Same parameterised owner clause + same single bind on both list queries.
    expect(draftsCall[0]).toContain('c.assigned_to_user_id = $1');
    expect(draftsCall[1]).toEqual(['me-123']);
    expect(renewalsSql).toContain('c.assigned_to_user_id = $1');
    expect(renewalsParams).toEqual(['me-123']);
  });
});
