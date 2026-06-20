// Unit tests for the business-metrics helpers + the no-op record paths.
// Recording activates only under OTel (enableBusinessMetrics, needs a live
// SDK); here we cover the folder-category derivation and the guarantee that
// the record* functions are inert (and never throw) when metrics are off.
import { describe, expect, it } from 'vitest';
import { folderType, recordPricingDrift, recordUpload } from './businessMetrics.js';

describe('folderType', () => {
  it('takes the leading path segment as the category', () => {
    expect(folderType('quotes/abc-123')).toBe('quotes');
    expect(folderType('fac/9')).toBe('fac');
    expect(folderType('universe3/x/y')).toBe('universe3');
  });

  it('handles a bare folder with no slash', () => {
    expect(folderType('misc')).toBe('misc');
  });

  it('falls back to "unknown" for empty/nullish input', () => {
    expect(folderType('')).toBe('unknown');
    expect(folderType(undefined)).toBe('unknown');
    expect(folderType(null)).toBe('unknown');
  });
});

describe('record* (disabled / default)', () => {
  it('recordPricingDrift is inert and never throws when metrics are off', () => {
    expect(() => recordPricingDrift({
      endpoint: 'quote_pricing',
      stats: { pricingDriftCount: 3, maxAbsDiff: 0.02, driftMagnitudeBucket: '<0.1' },
      strict: true,
    })).not.toThrow();
    expect(() => recordPricingDrift({})).not.toThrow();
  });

  it('recordUpload is inert and never throws when metrics are off', () => {
    expect(() => recordUpload({ folderType: 'quotes', sink: 'cloudinary', outcome: 'success' })).not.toThrow();
    expect(() => recordUpload({})).not.toThrow();
  });
});
