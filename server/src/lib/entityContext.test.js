import { describe, it, expect } from 'vitest';
import { entityContext } from './entityContext.js';

// Keep this in lock-step with the dozens of route handlers that rely
// on the shape returned here. If the schema ever splits (e.g. a
// separate `fac_quote` table), the contract lives here and the
// handlers follow — instead of the current pattern where it lives
// nowhere and gets rewritten in every route.

describe('entityContext', () => {
  const mkReq = (quote) => ({ query: quote === undefined ? {} : { quote } });

  it('defaults to contract mode when no quote flag', () => {
    const ctx = entityContext(mkReq());
    expect(ctx.isQuote).toBe(false);
    expect(ctx.parentTable).toBe('contract');
    expect(ctx.idColumn).toBe('contract_id');
    expect(ctx.prefix).toBe('contract_');
    expect(ctx.apiOpts).toBeUndefined();
  });

  it('flips to quote mode on query string ?quote=true', () => {
    const ctx = entityContext(mkReq('true'));
    expect(ctx.isQuote).toBe(true);
    expect(ctx.parentTable).toBe('quote');
    expect(ctx.idColumn).toBe('quote_id');
    expect(ctx.prefix).toBe('quote_');
    expect(ctx.apiOpts).toEqual({ quote: true });
  });

  it('flips on boolean true as well', () => {
    const ctx = entityContext(mkReq(true));
    expect(ctx.isQuote).toBe(true);
  });

  it('does not flip on string "false"', () => {
    const ctx = entityContext(mkReq('false'));
    expect(ctx.isQuote).toBe(false);
  });

  it('flips on the same string forms the client treats as quote mode', () => {
    expect(entityContext(mkReq('1')).isQuote).toBe(true);
  });

  it('does not flip on unrelated truthy strings like "yes"', () => {
    expect(entityContext(mkReq('yes')).isQuote).toBe(false);
  });

  describe('subTable / npTable', () => {
    it('builds correct table names in contract mode', () => {
      const ctx = entityContext(mkReq());
      expect(ctx.subTable('triangle_cells')).toBe('contract_triangle_cells');
      expect(ctx.npTable('expiring')).toBe('contract_np_expiring');
      expect(ctx.npTable('layers')).toBe('contract_np_layers');
    });

    it('builds correct table names in quote mode', () => {
      const ctx = entityContext(mkReq('true'));
      expect(ctx.subTable('triangle_cells')).toBe('quote_triangle_cells');
      expect(ctx.npTable('expiring')).toBe('quote_np_expiring');
      expect(ctx.npTable('layers')).toBe('quote_np_layers');
    });
  });

  it('tolerates a request object without req.query', () => {
    // Defensive — shouldn't crash if upstream middleware hasn't
    // parsed the query yet. express-req always has query, but unit
    // tests and edge cases might not.
    expect(() => entityContext({})).not.toThrow();
    expect(entityContext({}).isQuote).toBe(false);
  });
});
