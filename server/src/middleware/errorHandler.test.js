import { describe, it, expect } from 'vitest';
import { errorHandler } from './errorHandler.js';

function mockRes() {
  return {
    statusCode: null,
    body: null,
    locals: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
const req = { method: 'PUT', originalUrl: '/api/treaties/x/large-losses' };
function run(err) {
  const res = mockRes();
  errorHandler(err, req, res, () => {});
  return res;
}

describe('errorHandler — pg error mapping (Finding 2)', () => {
  it('maps FK violation (23503) to 400', () => {
    const res = run({ code: '23503', message: 'insert violates foreign key' });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('FK_VIOLATION');
    expect(res.body.error).toBe('Referenced record does not exist');
  });

  it('maps invalid-UUID (22P02) to 400', () => {
    const res = run({ code: '22P02', message: 'invalid input syntax for type uuid' });
    expect(res.statusCode).toBe(400);
    expect(res.body.code).toBe('INVALID_ID');
    expect(res.body.error).toBe('Invalid identifier format');
  });

  it('maps unique violation (23505) to 409', () => {
    const res = run({ code: '23505', message: 'duplicate key' });
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('DUPLICATE');
  });

  it('maps trigger raise_exception (P0001) to 422 but keeps the trigger message', () => {
    const res = run({ code: 'P0001', message: 'cannot delete a bound treaty' });
    expect(res.statusCode).toBe(422);
    expect(res.body.code).toBe('CHECK_VIOLATION');
    expect(res.body.error).toBe('cannot delete a bound treaty');
  });

  it('leaves unknown errors as 500', () => {
    const res = run(new Error('boom'));
    expect(res.statusCode).toBe(500);
    expect(res.body.code).toBe('INTERNAL_SERVER_ERROR');
  });

  it('does not override an app error that sets its own status (e.g. STALE_WRITE)', () => {
    const res = run({ status: 409, code: 'STALE_WRITE', message: 'changed since you loaded' });
    expect(res.statusCode).toBe(409);
    expect(res.body.code).toBe('STALE_WRITE');
    expect(res.body.error).toBe('changed since you loaded');
  });

  it('honours an explicit 404 from the existence-check helper', () => {
    const res = run({ status: 404, code: 'NOT_FOUND', message: 'Treaty not found' });
    expect(res.statusCode).toBe(404);
    expect(res.body.code).toBe('NOT_FOUND');
  });
});
