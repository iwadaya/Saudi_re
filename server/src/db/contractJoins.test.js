import { describe, it, expect } from 'vitest';
import { contractContextJoins } from './contractJoins.js';

describe('contractContextJoins', () => {
  it('produces the canonical 5-table LEFT JOIN chain for contract', () => {
    const sql = contractContextJoins('c');
    expect(sql).toContain('LEFT JOIN public.companies   ced ON ced.company_id    = c.cedant_id');
    expect(sql).toContain('LEFT JOIN public.brokers     bk  ON bk.broker_id      = c.broker_id');
    expect(sql).toContain('LEFT JOIN public.country     cnt ON cnt.country_id    = c.country_id');
    expect(sql).toContain('LEFT JOIN public.treaty_type tt  ON tt.treaty_type_id = c.treaty_type_id');
    expect(sql).toContain('LEFT JOIN public.currency    cur ON cur.currency_id   = c.currency_id');
  });

  it('substitutes the base alias correctly for quote', () => {
    const sql = contractContextJoins('q');
    expect(sql).toMatch(/= q\.cedant_id/);
    expect(sql).toMatch(/= q\.broker_id/);
    expect(sql).toMatch(/= q\.currency_id/);
    expect(sql).not.toMatch(/= c\./);
  });
});
