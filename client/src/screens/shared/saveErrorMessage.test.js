// saveErrorMessage.test.js — mapping of rejected saves to banner messages.
import { describe, expect, it } from 'vitest';
import { saveRejectionMessage } from './saveErrorMessage.js';

function httpError(status, body, message = `API POST /x → ${status}`) {
  const e = new Error(message);
  e.status = status;
  e.body = body;
  return e;
}

describe('saveRejectionMessage', () => {
  it('names the offending fields for a 400 VALIDATION_FAILED body', () => {
    const e = httpError(400, {
      error: 'Request body failed validation',
      code: 'VALIDATION_FAILED',
      fields: [{ path: 'detail.brokerage_pct', message: 'Number must be less than or equal to 100' }],
    });
    expect(saveRejectionMessage(e)).toBe(
      'Save rejected — detail.brokerage_pct: Number must be less than or equal to 100',
    );
  });

  it('falls back to the body error for a 422 without fields (e.g. NUMERIC_OVERFLOW)', () => {
    const e = httpError(422, { error: 'A numeric value is too large for its field', code: 'NUMERIC_OVERFLOW' });
    expect(saveRejectionMessage(e)).toBe('Save rejected — A numeric value is too large for its field');
  });

  it('caps the field list at three entries', () => {
    const fields = ['a', 'b', 'c', 'd'].map((p) => ({ path: p, message: 'bad' }));
    const msg = saveRejectionMessage(httpError(400, { fields }));
    expect(msg).toContain('a: bad');
    expect(msg).toContain('c: bad');
    expect(msg).not.toContain('d: bad');
  });

  it('returns null for transient/server faults so the generic Retry path is kept', () => {
    expect(saveRejectionMessage(httpError(500, { error: 'boom' }))).toBeNull();
    expect(saveRejectionMessage(httpError(503, {}))).toBeNull();
    expect(saveRejectionMessage(new TypeError('Failed to fetch'))).toBeNull();
    expect(saveRejectionMessage(null)).toBeNull();
  });
});
