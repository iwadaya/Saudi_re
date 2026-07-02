import { describe, it, expect } from 'vitest';
import { buildBatchInsert } from './batchInsert.js';

describe('buildBatchInsert', () => {
  it('returns null when there are no rows', () => {
    const result = buildBatchInsert({
      table: 'public.t',
      columns: ['parent_id', 'col_a'],
      rows: [],
      leadingId: 'p-1',
    });
    expect(result).toBeNull();
  });

  it('builds a single-row INSERT with one trailing column', () => {
    const result = buildBatchInsert({
      table: 'public.foo',
      columns: ['parent_id', 'cob_id'],
      rows: [['cob-uuid']],
      leadingId: 'p-1',
    });
    expect(result).toEqual({
      sql: 'INSERT INTO public.foo (parent_id,cob_id) VALUES ($1,$2)',
      params: ['p-1', 'cob-uuid'],
    });
  });

  it('builds a multi-row INSERT that shares $1 across every row', () => {
    const result = buildBatchInsert({
      table: 'public.foo',
      columns: ['parent_id', 'cob_id', 'premium'],
      rows: [
        ['cob-a', 100],
        ['cob-b', 200],
        ['cob-c', 300],
      ],
      leadingId: 'p-1',
    });
    expect(result.sql).toBe(
      'INSERT INTO public.foo (parent_id,cob_id,premium) VALUES ($1,$2,$3),($1,$4,$5),($1,$6,$7)',
    );
    expect(result.params).toEqual(['p-1', 'cob-a', 100, 'cob-b', 200, 'cob-c', 300]);
  });

  it('appends an ON CONFLICT clause when provided', () => {
    const result = buildBatchInsert({
      table: 'public.foo',
      columns: ['parent_id', 'k'],
      rows: [['v1'], ['v2']],
      leadingId: 'p-1',
      conflict: 'ON CONFLICT DO NOTHING',
    });
    expect(result.sql).toBe(
      'INSERT INTO public.foo (parent_id,k) VALUES ($1,$2),($1,$3) ON CONFLICT DO NOTHING',
    );
  });

  it('passes nulls through unchanged', () => {
    const result = buildBatchInsert({
      table: 'public.foo',
      columns: ['parent_id', 'a', 'b'],
      rows: [[null, 1]],
      leadingId: 'p-1',
    });
    expect(result.params).toEqual(['p-1', null, 1]);
  });

  it('accepts a schema-qualified table and plain columns', () => {
    expect(() =>
      buildBatchInsert({
        table: 'public.pricing_components',
        columns: ['contract_id', 'component_name'],
        rows: [['x']],
        leadingId: 'p-1',
      }),
    ).not.toThrow();
  });

  it('throws on an invalid table identifier', () => {
    expect(() =>
      buildBatchInsert({
        table: 'public.foo; DROP TABLE bar',
        columns: ['parent_id', 'a'],
        rows: [['v']],
        leadingId: 'p-1',
      }),
    ).toThrow(/Invalid table identifier/);
  });

  it('throws on an invalid column identifier', () => {
    expect(() =>
      buildBatchInsert({
        table: 'public.foo',
        columns: ['parent_id', 'a); DROP TABLE bar; --'],
        rows: [['v']],
        leadingId: 'p-1',
      }),
    ).toThrow(/Invalid column identifier/);
  });

  it('validates before short-circuiting is bypassed — empty rows still returns null', () => {
    // No rows means no query is built at all, so validation is moot.
    expect(
      buildBatchInsert({ table: 'bad name', columns: ['x'], rows: [], leadingId: 'p-1' }),
    ).toBeNull();
  });
});
