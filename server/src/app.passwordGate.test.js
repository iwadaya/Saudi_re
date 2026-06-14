// Unit tests for the hard forced-change gate (app.passwordChangeGate). Pure
// middleware — exercised directly with fake req/res/next, no app/DB needed.
import { describe, it, expect, vi } from 'vitest';
import { passwordChangeGate } from './app.js';

function mockRes() {
  return {
    statusCode: 200, body: null,
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
  };
}
const run = (req) => { const res = mockRes(); const next = vi.fn(); passwordChangeGate(req, res, next); return { res, next }; };

describe('passwordChangeGate', () => {
  it('passes through when the user is not flagged must-change', () => {
    const { next } = run({ user: { mustChangePassword: false }, method: 'POST', path: '/treaties' });
    expect(next).toHaveBeenCalledOnce();
  });

  it('passes through for an anonymous request (no req.user)', () => {
    const { next } = run({ method: 'POST', path: '/treaties' });
    expect(next).toHaveBeenCalledOnce();
  });

  it('423s a mutating request for a must-change user', () => {
    const { res, next } = run({ user: { mustChangePassword: true }, method: 'POST', path: '/treaties' });
    expect(next).not.toHaveBeenCalled();
    expect(res.statusCode).toBe(423);
    expect(res.body).toEqual({ error: 'Password change required', code: 'PWD_CHANGE_REQUIRED' });
  });

  it('423s PUT/PATCH/DELETE too', () => {
    for (const method of ['PUT', 'PATCH', 'DELETE']) {
      const { res } = run({ user: { mustChangePassword: true }, method, path: '/quotes/x' });
      expect(res.statusCode).toBe(423);
    }
  });

  it('allows reads (GET/HEAD/OPTIONS) for a must-change user', () => {
    for (const method of ['GET', 'HEAD', 'OPTIONS']) {
      const { next } = run({ user: { mustChangePassword: true }, method, path: '/treaties' });
      expect(next).toHaveBeenCalledOnce();
    }
  });

  it('exempts the change-password route and login', () => {
    const cp = run({ user: { mustChangePassword: true }, method: 'POST', path: '/auth/change-password' });
    expect(cp.next).toHaveBeenCalledOnce();
    const login = run({ user: { mustChangePassword: true }, method: 'POST', path: '/auth/login' });
    expect(login.next).toHaveBeenCalledOnce();
  });
});
