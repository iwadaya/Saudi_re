import { describe, it, expect } from 'vitest';
import { buildPartialUpdate } from './partialUpdate.js';

describe('buildPartialUpdate', () => {
  it('builds a parameterised UPDATE from the patch + allow-list', () => {
    const r = buildPartialUpdate({
      table: 'public.quote',
      allowed: ['cedant_id', 'broker_id', 'uw_year'],
      patch: { cedant_id: 'c-1', uw_year: 2026 },
      where: 'quote_id = $?',
      whereParams: ['q-1'],
    });
    expect(r.sql).toBe(
      'UPDATE public.quote SET cedant_id = $1, uw_year = $2, updated_at = now() WHERE quote_id = $3'
    );
    expect(r.params).toEqual(['c-1', 2026, 'q-1']);
  });

  it('silently drops keys not on the allow-list', () => {
    const r = buildPartialUpdate({
      table: 'public.quote',
      allowed: ['cedant_id'],
      patch: { cedant_id: 'c-1', status: 'SIGNED', DROP: 'TABLE users' },
      where: 'quote_id = $?',
      whereParams: ['q-1'],
    });
    expect(r.sql).not.toContain('status');
    expect(r.sql).not.toContain('DROP');
    expect(r.sql).toContain('cedant_id = $1');
  });

  it('treats explicit null as "set to NULL", not "leave alone"', () => {
    const r = buildPartialUpdate({
      table: 'public.quote',
      allowed: ['broker_id'],
      patch: { broker_id: null },
      where: 'quote_id = $?',
      whereParams: ['q-1'],
    });
    expect(r.params[0]).toBe(null);
    expect(r.sql).toContain('broker_id = $1');
  });

  it('returns null when nothing in patch hits the allow-list and touchUpdatedAt is off', () => {
    const r = buildPartialUpdate({
      table: 'public.quote',
      allowed: ['cedant_id'],
      patch: { foo: 1 },
      where: 'quote_id = $?',
      whereParams: ['q-1'],
      touchUpdatedAt: false,
    });
    expect(r).toBeNull();
  });

  it('supports RETURNING', () => {
    const r = buildPartialUpdate({
      table: 'public.quote',
      allowed: ['uw_year'],
      patch: { uw_year: 2026 },
      where: 'quote_id = $?',
      whereParams: ['q-1'],
      returning: 'quote_id, updated_at',
    });
    expect(r.sql).toMatch(/RETURNING quote_id, updated_at$/);
  });

  it('renumbers multiple $? placeholders in WHERE', () => {
    const r = buildPartialUpdate({
      table: 'public.quote',
      allowed: ['uw_year'],
      patch: { uw_year: 2026 },
      where: 'quote_id = $? AND cedant_id = $?',
      whereParams: ['q-1', 'c-1'],
    });
    expect(r.sql).toContain('WHERE quote_id = $2 AND cedant_id = $3');
    expect(r.params).toEqual([2026, 'q-1', 'c-1']);
  });

  it('rejects invalid table identifiers (defence in depth)', () => {
    expect(() => buildPartialUpdate({
      table: 'public.evil; DROP TABLE users; --',
      allowed: ['x'],
      patch: { x: 1 },
      where: 'id = $?',
      whereParams: [1],
    })).toThrow(/Invalid table identifier/);
  });

  it('ignores invalid column names in the allow-list', () => {
    const r = buildPartialUpdate({
      table: 'public.quote',
      allowed: ['cedant_id', 'evil"; DROP TABLE x; --'],
      patch: { cedant_id: 'c-1', 'evil"; DROP TABLE x; --': 'hax' },
      where: 'id = $?',
      whereParams: ['q-1'],
    });
    expect(r.sql).not.toContain('DROP');
    expect(r.sql).toContain('cedant_id = $1');
    expect(r.params).toEqual(['c-1', 'q-1']);
  });
});
