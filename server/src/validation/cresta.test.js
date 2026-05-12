import { describe, it, expect } from 'vitest';
import { crestaSaveSchema } from './cresta.js';

const VALID_UUID = '11111111-2222-3333-4444-555555555555';

describe('crestaSaveSchema', () => {
  it('accepts a typical UI payload', () => {
    const parsed = crestaSaveSchema.parse({
      country_id: VALID_UUID,
      cob_id: VALID_UUID,
      cob_name: 'Fire',
      treaty_type: 'Quota Share',
      rows: [
        { country_id: VALID_UUID, zone_id: '01', zone_name: 'Tokyo',
          eq_agg: '1,000,000', ws_agg: 0, flood_agg: '', srcc_agg: null, others_agg: 25,
          residential_bldg_pct: '30', commercial_bldg_pct: 25, commercial_cont_pct: '15',
          industrial_bldg_pct: 20, industrial_cont_pct: '10' },
      ],
    });
    expect(parsed.rows).toHaveLength(1);
    expect(parsed.rows[0].eq_agg).toBe(1_000_000);
    expect(parsed.treaty_type).toBe('Quota Share');
  });

  it('accepts an empty payload (server defaults treaty_type to Both)', () => {
    const parsed = crestaSaveSchema.parse({});
    expect(parsed.rows).toEqual([]);
    expect(parsed.treaty_type).toBeUndefined();
  });

  it('rejects a non-UUID country_id', () => {
    expect(() => crestaSaveSchema.parse({ country_id: 'NOT-A-UUID' })).toThrow();
  });

  it('rejects a percentage > 100', () => {
    expect(() =>
      crestaSaveSchema.parse({
        rows: [{ residential_bldg_pct: 150 }],
      }),
    ).toThrow();
  });

  it('rejects a negative aggregate', () => {
    expect(() =>
      crestaSaveSchema.parse({
        rows: [{ eq_agg: -1 }],
      }),
    ).toThrow();
  });

  it('caps row count at 500 to prevent fat-body DoS', () => {
    const rows = Array.from({ length: 501 }, (_, i) => ({ zone_id: String(i) }));
    expect(() => crestaSaveSchema.parse({ rows })).toThrow();
  });

  it('strips empty optional fields without throwing', () => {
    const parsed = crestaSaveSchema.parse({
      country_id: '',  // optionalUuid coerces '' → undefined
      cob_id: null,
      treaty_type: '',
      rows: [{ zone_id: 'A' }],
    });
    expect(parsed.country_id).toBeUndefined();
    expect(parsed.cob_id).toBeUndefined();
  });
});
