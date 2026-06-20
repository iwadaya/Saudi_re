// Unit test: bindQuoteToContract rolls the WHOLE transaction back on any
// mid-copy failure (so a partial bind never leaves orphan contract rows), and
// rejects double-bind / unsigned quotes before doing any work.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('./audit.js', () => ({
  logAudit: vi.fn(async () => undefined),
  SYSTEM_ACTOR: { id: null, name: 'SYSTEM', system: true },
}));

const { bindQuoteToContract } = await import('./quoteBind.js');

// A fake client that returns canned results until a chosen query throws.
function makeClient({ quote, failOn }) {
  const calls = [];
  const client = {
    calls,
    released: false,
    query: vi.fn(async (sql) => {
      calls.push(sql);
      if (failOn && failOn(sql)) throw new Error('boom: copy failed mid-transaction');
      if (/^BEGIN/.test(sql)) return { rows: [] };
      if (/ROLLBACK/.test(sql)) return { rows: [] };
      if (/COMMIT/.test(sql)) return { rows: [] };
      if (/FROM public\.quote WHERE quote_id/.test(sql)) return { rows: quote ? [quote] : [] };
      if (/INSERT INTO public\.contract\s*\(/.test(sql)) return { rows: [{ contract_id: 'new-contract-1' }] };
      if (/information_schema/.test(sql)) return { rows: [] }; // no extra columns → trivial copies
      return { rows: [] };
    }),
    release: vi.fn(function r() { client.released = true; }),
  };
  return client;
}
const poolOf = (client) => ({ connect: vi.fn(async () => client) });
const SIGNED = { quote_id: 'q1', status: 'SIGNED', bound_contract_id: null };

beforeEach(() => vi.clearAllMocks());

describe('bindQuoteToContract', () => {
  it('rolls back the whole transaction (no COMMIT) when a copy fails mid-way', async () => {
    // Fail on the first sub-table copy INSERT (after header insert).
    const client = makeClient({
      quote: SIGNED,
      failOn: (sql) => /INSERT INTO public\.contract_prop_details/.test(sql),
    });
    await expect(bindQuoteToContract(poolOf(client), { quoteId: 'q1', actor: { id: 'u1' } }))
      .rejects.toThrow(/copy failed/);
    const issued = client.calls.map((s) => s.trim().split(/\s+/).slice(0, 1)[0]);
    expect(issued).toContain('BEGIN');
    expect(client.calls.some((s) => /ROLLBACK/.test(s))).toBe(true);
    expect(client.calls.some((s) => /COMMIT/.test(s))).toBe(false); // never committed
    expect(client.released).toBe(true);
  });

  it('rejects a double-bind before copying anything (409 ALREADY_BOUND)', async () => {
    const client = makeClient({ quote: { ...SIGNED, bound_contract_id: 'already' } });
    await expect(bindQuoteToContract(poolOf(client), { quoteId: 'q1', actor: {} }))
      .rejects.toMatchObject({ status: 409, code: 'ALREADY_BOUND' });
    expect(client.calls.some((s) => /INSERT INTO public\.contract\s*\(/.test(s))).toBe(false);
    expect(client.calls.some((s) => /ROLLBACK/.test(s))).toBe(true);
  });

  it('rejects an unsigned quote (422 QUOTE_NOT_SIGNED) and creates no contract', async () => {
    const client = makeClient({ quote: { ...SIGNED, status: 'DRAFT' } });
    await expect(bindQuoteToContract(poolOf(client), { quoteId: 'q1', actor: {} }))
      .rejects.toMatchObject({ status: 422, code: 'QUOTE_NOT_SIGNED' });
    expect(client.calls.some((s) => /INSERT INTO public\.contract\s*\(/.test(s))).toBe(false);
  });

  it('404s when the quote does not exist', async () => {
    const client = makeClient({ quote: null });
    await expect(bindQuoteToContract(poolOf(client), { quoteId: 'nope', actor: {} }))
      .rejects.toMatchObject({ status: 404, code: 'NOT_FOUND' });
  });
});
