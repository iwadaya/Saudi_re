import { describe, it, expect, vi } from 'vitest';

// The offer repo pulls in the pool + workflow/benchmark services at import
// time; stub them so importing the module never touches a real DB. The status
// machine is deliberately REAL: the F23 state guards under test are its edges.
vi.mock('../../../db/pool.js', () => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('../../../services/workflow.js', () => ({ changeUwStatus: vi.fn() }));
vi.mock('../../../services/ldf/benchmark.js', () => ({ refreshBenchmarks: vi.fn(() => Promise.resolve()) }));

const { replaceOffer, markDeclined } = await import('./pricingOfferRepository.js');

/**
 * A stand-in for a checked-out transaction client (has .query AND .release),
 * dispatching on SQL text so replaceOffer's state guards see a coherent
 * contract/offer. Defaults: a DRAFT contract with no existing offer row.
 */
const txClient = ({ uwStatus = 'DRAFT', offerRow = null } = {}) => {
  const client = {
    release: vi.fn(),
    query: vi.fn(async (sql) => {
      const s = String(sql);
      if (s.includes('SELECT uw_status FROM public.contract')) {
        return { rows: [{ uw_status: uwStatus }] };
      }
      if (s.includes('SELECT status, approval_step FROM public.contract_offer')) {
        return { rows: offerRow ? [offerRow] : [] };
      }
      if (s.includes('INSERT INTO public.contract_offer')) {
        return { rows: [{ offer_id: 'o-1', contract_id: 'c1' }] };
      }
      return { rows: [] };
    }),
  };
  return client;
};

describe('D3 — multi-write offer functions require a transaction client', () => {
  it('replaceOffer rejects when no client is supplied (would autocommit half-applied)', async () => {
    await expect(replaceOffer('c1', {})).rejects.toThrow(/transaction client/);
  });

  it('replaceOffer rejects when handed the pool (has .query but no .release)', async () => {
    const poolLike = { query: vi.fn() };
    await expect(replaceOffer('c1', {}, poolLike)).rejects.toThrow(/transaction client/);
  });

  it('markDeclined rejects when no client is supplied', async () => {
    await expect(markDeclined('c1', 'reason', undefined, { actorName: 'x' })).rejects.toThrow(/transaction client/);
  });

  it('replaceOffer proceeds on a real transaction client (has .query + .release)', async () => {
    const cl = txClient();
    await expect(replaceOffer('c1', { written_line_pct: 10 }, cl)).resolves.toBeDefined();
    expect(cl.query).toHaveBeenCalled();
  });
});

describe('F23 — replaceOffer state guards', () => {
  it('replaces a fresh PENDING offer on a DRAFT contract', async () => {
    const cl = txClient({ uwStatus: 'DRAFT', offerRow: { status: 'PENDING', approval_step: 0 } });
    await expect(replaceOffer('c1', { written_line_pct: 10 }, cl)).resolves.toBeDefined();
    const deletes = cl.query.mock.calls.filter(([sql]) => String(sql).includes('DELETE FROM public.contract_offer'));
    expect(deletes).toHaveLength(1);
  });

  it('replaces an offer the engine reset via return/recall (RETURNED, step 0)', async () => {
    const cl = txClient({ uwStatus: 'DRAFT', offerRow: { status: 'RETURNED', approval_step: 0 } });
    await expect(replaceOffer('c1', { written_line_pct: 10 }, cl)).resolves.toBeDefined();
  });

  it('refuses (409 APPROVAL_IN_FLIGHT) while an approval is in flight — the DELETE would erase peer decisions', async () => {
    const cl = txClient({
      uwStatus: 'AWAITING_APPROVAL',
      offerRow: { status: 'AWAITING_APPROVAL', approval_step: 2 },
    });
    await expect(replaceOffer('c1', { written_line_pct: 99 }, cl))
      .rejects.toMatchObject({ status: 409, code: 'APPROVAL_IN_FLIGHT' });
    // Nothing was deleted or written.
    const writes = cl.query.mock.calls.filter(([sql]) => /^\s*(DELETE|INSERT|UPDATE)/i.test(String(sql)));
    expect(writes).toHaveLength(0);
  });

  it('refuses a decided offer even at approval_step 0 (status beyond PENDING)', async () => {
    const cl = txClient({
      uwStatus: 'AWAITING_APPROVAL',
      offerRow: { status: 'DISPUTE_PENDING', approval_step: 0 },
    });
    await expect(replaceOffer('c1', {}, cl))
      .rejects.toMatchObject({ status: 409, code: 'APPROVAL_IN_FLIGHT' });
  });

  it('refuses (422 INVALID_TRANSITION) on a SIGNED contract — terminal states never take a new offer', async () => {
    const cl = txClient({ uwStatus: 'SIGNED' });
    await expect(replaceOffer('c1', {}, cl))
      .rejects.toMatchObject({ status: 422, code: 'INVALID_TRANSITION' });
    const writes = cl.query.mock.calls.filter(([sql]) => /^\s*(DELETE|INSERT|UPDATE)/i.test(String(sql)));
    expect(writes).toHaveLength(0);
  });

  it('refuses on an approved contract awaiting its signed line (recall it first)', async () => {
    const cl = txClient({ uwStatus: 'AWAITING_SIGNED_LINE' });
    await expect(replaceOffer('c1', {}, cl))
      .rejects.toMatchObject({ status: 422, code: 'INVALID_TRANSITION' });
  });
});
