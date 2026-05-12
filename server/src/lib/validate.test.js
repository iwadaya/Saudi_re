import { describe, it, expect, vi } from 'vitest';
import { z } from 'zod';
import { validateBody, validateQuery } from './validate.js';

function mkRes() {
  return {
    locals: { requestId: 'req-1' },
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b)   { this.body = b; return this; },
  };
}

describe('validateBody', () => {
  const schema = z.object({
    name: z.string(),
    age:  z.number().int().nonnegative(),
  });

  it('replaces req.body with the parsed value on success', () => {
    const req = { body: { name: 'Pat', age: 42, extra: 'stripped' } };
    const res = mkRes();
    const next = vi.fn();
    validateBody(schema)(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(req.body).toEqual({ name: 'Pat', age: 42 });
  });

  it('returns 400 + structured error on validation failure', () => {
    const req = { body: { name: 'Pat', age: -5 } };
    const res = mkRes();
    const next = vi.fn();
    validateBody(schema)(req, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
    expect(res.body.fields).toContainEqual(expect.objectContaining({ path: 'age' }));
    expect(res.body.requestId).toBe('req-1');
  });

  it('treats missing body as {}', () => {
    const req = { body: undefined };
    const res = mkRes();
    const next = vi.fn();
    validateBody(z.object({}).default({}))(req, res, next);
    expect(next).toHaveBeenCalled();
  });

  it('forwards non-Zod errors to next()', () => {
    const breaker = z.object({}).transform(() => { throw new Error('boom'); });
    const req = { body: {} };
    const res = mkRes();
    const next = vi.fn();
    validateBody(breaker)(req, res, next);
    // error handler middleware should pick it up
    expect(next).toHaveBeenCalled();
    expect(next.mock.calls[0][0]).toBeInstanceOf(Error);
  });
});

describe('validateQuery', () => {
  it('parses query into res.locals.query without mutating req.query', () => {
    const schema = z.object({ page: z.coerce.number().int().min(1) });
    const req = { query: { page: '3' } };
    const res = mkRes();
    const next = vi.fn();
    validateQuery(schema)(req, res, next);
    expect(next).toHaveBeenCalled();
    expect(res.locals.query).toEqual({ page: 3 });
    expect(req.query).toEqual({ page: '3' });
  });

  it('400s on bad query', () => {
    const schema = z.object({ page: z.coerce.number().int().min(1) });
    const req = { query: { page: 'banana' } };
    const res = mkRes();
    validateQuery(schema)(req, res, vi.fn());
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('VALIDATION_FAILED');
  });
});
