import { describe, it, expect, vi, beforeEach } from 'vitest';

// Shared mock state (hoisted so the vi.mock factories can reference it).
const h = vi.hoisted(() => ({
  poolQuery: vi.fn(),
  clientQuery: vi.fn(),
  connect: vi.fn(),
  getPricingSchemaFlags: vi.fn(),
  upsertPricingOutputsWithClient: vi.fn(),
  assertParentEntityUnchanged: vi.fn(),
  touchParentEntity: vi.fn(),
  logAudit: vi.fn(),
  warn: vi.fn(),
}));

vi.mock('../../../db/pool.js', () => ({
  pool: { query: h.poolQuery, connect: h.connect },
}));
vi.mock('../../../lib/logger.js', () => ({
  logger: { info: vi.fn(), warn: h.warn, error: vi.fn() },
}));
vi.mock('../../../lib/parentEntityPersistence.js', () => ({
  assertParentEntityUnchanged: h.assertParentEntityUnchanged,
  touchParentEntity: h.touchParentEntity,
}));
vi.mock('../../../services/audit.js', () => ({
  logAudit: h.logAudit,
  SYSTEM_ACTOR: 'system',
}));
// Keep the real numOrNull + withTransaction; only stub the schema probe and the
// legacy-schema writer.
vi.mock('./repositoryUtils.js', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getPricingSchemaFlags: h.getPricingSchemaFlags,
    upsertPricingOutputsWithClient: h.upsertPricingOutputsWithClient,
  };
});

const { saveCompositePricing } = await import('./pricingOutputsRepository.js');

beforeEach(() => {
  vi.clearAllMocks();
  h.connect.mockResolvedValue({ query: h.clientQuery, release: vi.fn() });
  h.clientQuery.mockResolvedValue({ rows: [] });
  h.getPricingSchemaFlags.mockResolvedValue({
    hasOfferCols: true,
    componentColumns: new Set(['selected', 'comment']),
  });
  h.assertParentEntityUnchanged.mockResolvedValue(undefined);
  h.touchParentEntity.mockResolvedValue('2026-07-02T00:00:00.000Z');
  h.logAudit.mockResolvedValue(undefined);
  h.poolQuery.mockImplementation((sql) => {
    if (sql.includes('contract_pricing_outputs')) return Promise.resolve({ rows: [{ epi: 100 }] });
    if (sql.includes('FROM public.contract ')) return Promise.resolve({ rows: [{ contract_id: 'c1' }] });
    return Promise.resolve({ rows: [] });
  });
});

describe('saveCompositePricing — money null handling (B1)', () => {
  it('overwrites a blanked money field to NULL instead of retaining the prior value', async () => {
    await saveCompositePricing({ contractId: 'c1', outputs: { epi: '', attritional_ratio: 0.1 } });

    const upsert = h.clientQuery.mock.calls.find(
      ([sql]) => typeof sql === 'string' && sql.includes('INSERT INTO public.contract_pricing_outputs'),
    );
    expect(upsert).toBeTruthy();
    const [sql, params] = upsert;
    // No COALESCE() call in the upsert — the full snapshot always wins so blanks
    // clear. (Match the function call, not the word, so the explanatory SQL
    // comment that names COALESCE doesn't trip this.)
    expect(sql).not.toMatch(/COALESCE\s*\(/i);
    // params[0] is contract_id, params[1] is epi (numOrNull('') === null).
    expect(params[1]).toBeNull();
  });

  it('commits the whole save when components succeed', async () => {
    const result = await saveCompositePricing({
      contractId: 'c1',
      outputs: { epi: 1 },
      components: [{ component_name: 'Attritional', selected: true }],
    });
    const stmts = h.clientQuery.mock.calls.map(([sql]) => sql);
    expect(stmts).toContain('COMMIT');
    expect(stmts).not.toContain('ROLLBACK');
    expect(result).toEqual({ updated_at: '2026-07-02T00:00:00.000Z' });
  });
});

describe('saveCompositePricing — component failure is no longer swallowed (B2)', () => {
  it('rolls back the whole save and rethrows when the components insert fails', async () => {
    h.clientQuery.mockImplementation((sql) => {
      if (typeof sql === 'string' && sql.includes('INSERT INTO public.pricing_components')) {
        return Promise.reject(new Error('components boom'));
      }
      return Promise.resolve({ rows: [] });
    });

    await expect(
      saveCompositePricing({
        contractId: 'c1',
        outputs: { epi: 1 },
        components: [{ component_name: 'Attritional' }],
      }),
    ).rejects.toThrow('components boom');

    const stmts = h.clientQuery.mock.calls.map(([sql]) => sql);
    expect(stmts).toContain('ROLLBACK');
    expect(stmts).not.toContain('COMMIT');
  });
});
