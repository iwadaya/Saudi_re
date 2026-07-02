import { describe, it, expect, vi } from 'vitest';

// The offer repo pulls in the pool + workflow/status/benchmark services at import
// time; stub them so importing the module never touches a real DB. The D3 guard
// under test throws BEFORE any of these are used, so empty stubs are enough.
vi.mock('../../../db/pool.js', () => ({ pool: { query: vi.fn(), connect: vi.fn() } }));
vi.mock('../../../lib/statusMachine.js', () => ({ assertLegalTransition: vi.fn() }));
vi.mock('../../../services/workflow.js', () => ({ changeUwStatus: vi.fn() }));
vi.mock('../../../services/ldf/benchmark.js', () => ({ refreshBenchmarks: vi.fn(() => Promise.resolve()) }));

const { replaceOffer, markDeclined } = await import('./pricingOfferRepository.js');

// A stand-in for a checked-out transaction client (has .query AND .release).
const txClient = () => ({ query: vi.fn(() => Promise.resolve({ rows: [{}] })), release: vi.fn() });

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
