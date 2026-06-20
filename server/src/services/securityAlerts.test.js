// server/src/services/securityAlerts.js unit tests.

import { describe, it, expect, vi, beforeEach } from 'vitest';

const warn = vi.fn();
vi.mock('../lib/logger.js', () => ({ logger: { warn: (...a) => warn(...a) } }));

const { emitSecurityAlert } = await import('./securityAlerts.js');

beforeEach(() => warn.mockClear());

describe('emitSecurityAlert', () => {
  it('logs a matchable, high-severity line with the type + detail', () => {
    emitSecurityAlert('BREAK_GLASS_LOGIN', { userId: 'u1', ip: '10.0.0.1' });
    expect(warn).toHaveBeenCalledTimes(1);
    const [msg, meta] = warn.mock.calls[0];
    expect(msg).toContain('BREAK_GLASS_LOGIN');
    expect(meta).toMatchObject({ securityAlert: true, alertType: 'BREAK_GLASS_LOGIN', userId: 'u1', ip: '10.0.0.1' });
  });

  it('never throws even if the logger blows up', () => {
    warn.mockImplementationOnce(() => { throw new Error('sink down'); });
    expect(() => emitSecurityAlert('X')).not.toThrow();
  });
});
