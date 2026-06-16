// Tests for diffAudit (services/audit.js) — the field-level diff audit used by
// the treaty/quote terms & financials routes.
//
// Covers: numeric/date normalisation so equal-but-cosmetically-different values
// aren't logged, the updated_at exclusion, "write nothing when nothing changed",
// raw from/to capture, CONTRACT vs QUOTE table routing, and the critical-rethrow
// guarantee that rolls a transaction back if the audit write fails.
import { describe, it, expect, vi } from 'vitest';

vi.mock('../db/pool.js', () => ({ pool: { query: vi.fn() } }));
vi.mock('../lib/logger.js', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

const { diffAudit } = await import('./audit.js');

const actor = { id: 'u1', name: 'Tester', role: 'TUW' };
const mockClient = () => ({ query: vi.fn(async () => ({ rows: [] })) });

describe('diffAudit', () => {
  it('writes nothing when no watched field changed (updated_at ignored)', async () => {
    const client = mockClient();
    const res = await diffAudit(client, {
      entityType: 'CONTRACT', entityId: 'c1', eventType: 'PROP_DETAILS_UPDATED', actor,
      before: { a: 1, b: 'x', updated_at: '2020-01-01' },
      after: { a: 1, b: 'x', updated_at: '2024-01-01' },
      fields: ['a', 'b', 'updated_at'], label: 'x',
    });
    expect(res).toBeNull();
    expect(client.query).not.toHaveBeenCalled();
  });

  it('normalises numeric strings / dates / empties so equal values are not changes', async () => {
    const client = mockClient();
    const res = await diffAudit(client, {
      entityType: 'CONTRACT', entityId: 'c1', eventType: 'PROP_DETAILS_UPDATED', actor,
      before: { pct: '10.00', when: new Date('2024-01-01T00:00:00Z'), empty: '' },
      after: { pct: 10, when: new Date('2024-01-01T00:00:00Z'), empty: null },
      fields: ['pct', 'when', 'empty'], label: 'x',
    });
    expect(res).toBeNull();
    expect(client.query).not.toHaveBeenCalled();
  });

  it('records raw from/to for changed fields and writes one CONTRACT event', async () => {
    const client = mockClient();
    const res = await diffAudit(client, {
      entityType: 'CONTRACT', entityId: 'c1', eventType: 'COMMISSIONS_UPDATED', actor,
      before: { rate: '10.00', mode: 'FIXED' },
      after: { rate: '12.50', mode: 'SLIDING' },
      fields: ['rate', 'mode'], label: 'commissions',
    });
    expect(res).toEqual({ rate: { from: '10.00', to: '12.50' }, mode: { from: 'FIXED', to: 'SLIDING' } });
    expect(client.query).toHaveBeenCalledTimes(1);
    const [sql, params] = client.query.mock.calls[0];
    expect(sql).toMatch(/contract_audit_event/);
    const payload = JSON.parse(params[3]);
    expect(payload.entity).toBe('commissions');
    expect(payload.changes.rate).toEqual({ from: '10.00', to: '12.50' });
  });

  it('treats an absent side as null (added/removed keys) and routes QUOTE to audit_log', async () => {
    const client = mockClient();
    const res = await diffAudit(client, {
      entityType: 'QUOTE', entityId: 'q1', eventType: 'NP_LAYER_UPDATED', actor,
      before: {}, after: { layer_1: { a: 1 } }, fields: ['layer_1'], label: 'layers',
    });
    expect(res.layer_1.from).toBeNull();
    expect(res.layer_1.to).toEqual({ a: 1 });
    expect(client.query.mock.calls[0][0]).toMatch(/audit_log/);
  });

  it('does not treat 0 as unset', async () => {
    const client = mockClient();
    const res = await diffAudit(client, {
      entityType: 'CONTRACT', entityId: 'c1', eventType: 'PROP_DETAILS_UPDATED', actor,
      before: { x: null }, after: { x: 0 }, fields: ['x'], label: 'x',
    });
    expect(res).toEqual({ x: { from: null, to: 0 } });
  });

  it('rethrows when the audit write fails (critical → rolls the txn back)', async () => {
    const client = { query: vi.fn(async () => { throw new Error('db down'); }) };
    await expect(diffAudit(client, {
      entityType: 'CONTRACT', entityId: 'c1', eventType: 'PROP_DETAILS_UPDATED', actor,
      before: { a: 1 }, after: { a: 2 }, fields: ['a'], label: 'x',
    })).rejects.toThrow('db down');
  });
});
