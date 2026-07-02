import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({ poolQuery: vi.fn(), warn: vi.fn() }));

vi.mock('../../../db/pool.js', () => ({ pool: { query: h.poolQuery } }));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: h.warn, error: vi.fn() },
}));

const { getMarketAverage } = await import('./pricingAggregateRepository.js');

beforeEach(() => {
  vi.clearAllMocks();
});

describe('getMarketAverage — swallowed tier errors are logged (D5)', () => {
  it('warns per failed tier and still returns the empty fallback', async () => {
    h.poolQuery.mockRejectedValue(new Error('relation does not exist'));

    const result = await getMarketAverage('country-1', null, {});

    // Fallback behaviour preserved: no throw, empty components.
    expect(result).toEqual({ components: {}, tier: null, contractCount: 0 });
    // ...but the DB error is now visible rather than silently swallowed.
    expect(h.warn).toHaveBeenCalled();
    const [msg, meta] = h.warn.mock.calls[0];
    expect(msg).toMatch(/tier query failed/);
    expect(meta.error).toBe('relation does not exist');
  });

  it('returns the first tier that meets the contract threshold', async () => {
    h.poolQuery.mockResolvedValue({
      rows: [{ component_name: 'Attritional', avg_value: 0.05, contract_count: 5 }],
    });

    const result = await getMarketAverage('country-1', null, {});

    expect(result.components).toEqual({ Attritional: 0.05 });
    expect(result.contractCount).toBe(5);
    expect(h.warn).not.toHaveBeenCalled();
  });
});
