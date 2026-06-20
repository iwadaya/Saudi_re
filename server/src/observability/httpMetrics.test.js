// Unit tests for the HTTP metrics helpers + the no-op middleware path.
// The recording path only activates under OTel (enableHttpMetrics), which
// requires a live SDK; here we cover label derivation and the pass-through
// guarantee that holds when metrics are disabled (the default in tests).
import { describe, expect, it, vi } from 'vitest';
import { routeLabel, statusClass, httpMetricsMiddleware } from './httpMetrics.js';

describe('routeLabel', () => {
  it('joins the router mount path with the matched route template', () => {
    expect(routeLabel({ baseUrl: '/api/quotes', route: { path: '/:id' } })).toBe('/api/quotes/:id');
  });

  it('handles app-level routes with no baseUrl', () => {
    expect(routeLabel({ baseUrl: '', route: { path: '/api/health' } })).toBe('/api/health');
  });

  it('uses the first template when Express gives an array of paths', () => {
    expect(routeLabel({ baseUrl: '/api', route: { path: ['/a', '/b'] } })).toBe('/api/a');
  });

  it('buckets unmatched requests under the mount, not the concrete URL', () => {
    expect(routeLabel({ baseUrl: '/api/quotes', route: undefined })).toBe('/api/quotes/*');
  });

  it('collapses a fully unmatched request to a single label', () => {
    expect(routeLabel({ baseUrl: '', route: undefined })).toBe('unmatched');
    expect(routeLabel({})).toBe('unmatched');
  });
});

describe('statusClass', () => {
  it.each([
    [200, '2xx'],
    [204, '2xx'],
    [301, '3xx'],
    [404, '4xx'],
    [422, '4xx'],
    [500, '5xx'],
    [503, '5xx'],
  ])('maps %i → %s', (status, expected) => {
    expect(statusClass(status)).toBe(expected);
  });

  it('returns "unknown" for out-of-range or non-numeric input', () => {
    expect(statusClass(0)).toBe('unknown');
    expect(statusClass(700)).toBe('unknown');
    expect(statusClass(undefined)).toBe('unknown');
    expect(statusClass('nope')).toBe('unknown');
  });
});

describe('httpMetricsMiddleware (disabled / default)', () => {
  it('is a synchronous pass-through that does not touch the response', () => {
    const next = vi.fn();
    const res = { once: vi.fn() };
    httpMetricsMiddleware({ method: 'GET' }, res, next);
    expect(next).toHaveBeenCalledOnce();
    // No finish listener registered while metrics are off.
    expect(res.once).not.toHaveBeenCalled();
  });
});
