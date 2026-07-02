import { describe, it, expect, vi } from 'vitest';
import { assertEntityUnchanged, ConflictError, optimisticLockOverrideRequested } from './optimisticLock.js';

// A fake pg client — only needs .query(). We stub it per test so we
// can assert the SQL shape without a real DB.
function mkDb(updatedAt) {
  return {
    query: vi.fn().mockResolvedValue({ rows: updatedAt === null ? [] : [{ updated_at: updatedAt }] }),
  };
}

describe('assertEntityUnchanged', () => {
  const id = 'abc-123';
  const base = { table: 'public.quote', idColumn: 'quote_id', id };

  it('is a no-op when no If-Unmodified-Since header', async () => {
    const db = mkDb('2026-01-01T00:00:00Z');
    await assertEntityUnchanged(db, base);
    expect(db.query).not.toHaveBeenCalled();
  });

  it('is a no-op when header is unparseable', async () => {
    const db = mkDb('2026-01-01T00:00:00Z');
    await assertEntityUnchanged(db, { ...base, ifUnmodifiedSince: 'not-a-date' });
    expect(db.query).not.toHaveBeenCalled();
  });

  it('skips when the row does not exist — caller handles 404', async () => {
    const db = mkDb(null);
    await expect(
      assertEntityUnchanged(db, { ...base, ifUnmodifiedSince: '2026-01-01T00:00:00Z' }),
    ).resolves.toBeUndefined();
  });

  it('allows the write when current updated_at equals expected', async () => {
    const ts = '2026-01-01T00:00:00Z';
    const db = mkDb(ts);
    await expect(
      assertEntityUnchanged(db, { ...base, ifUnmodifiedSince: ts }),
    ).resolves.toBeUndefined();
  });

  it('takes a FOR UPDATE row lock so a concurrent stale write blocks', async () => {
    // The lock is what closes the TOCTOU window: the read must be
    // SELECT ... FOR UPDATE so a second transaction with the same baseline
    // blocks on the first, then re-reads the fresh timestamp.
    const ts = '2026-01-01T00:00:00Z';
    const db = mkDb(ts);
    await assertEntityUnchanged(db, { ...base, ifUnmodifiedSince: ts });
    expect(db.query).toHaveBeenCalledTimes(1);
    const [sql] = db.query.mock.calls[0];
    expect(sql).toMatch(/FOR UPDATE\s*$/);
  });

  it('rejects when handed the pool instead of a transaction client', async () => {
    // A Pool exposes .connect(); FOR UPDATE would not hold across the caller's
    // transaction, so the helper must refuse it.
    const fakePool = { query: vi.fn(), connect: vi.fn() };
    await expect(
      assertEntityUnchanged(fakePool, { ...base, ifUnmodifiedSince: '2026-01-01T00:00:00Z' }),
    ).rejects.toThrow(/transaction client/);
    expect(fakePool.query).not.toHaveBeenCalled();
  });

  it('throws ConflictError on any forward delta — even 1ms', async () => {
    // Earlier versions had a 500ms grace window. That masked the realistic
    // case the integration suite exercises: GET → PUT (no header) → stale PUT,
    // all within tens of milliseconds. The check is now strict.
    const db = mkDb('2026-01-01T00:00:00.001Z');
    await expect(
      assertEntityUnchanged(db, { ...base, ifUnmodifiedSince: '2026-01-01T00:00:00.000Z' }),
    ).rejects.toThrow(ConflictError);
  });

  it('throws ConflictError when the row has been updated', async () => {
    const db = mkDb('2026-01-01T00:01:00Z'); // 1 minute newer
    await expect(
      assertEntityUnchanged(db, { ...base, ifUnmodifiedSince: '2026-01-01T00:00:00Z' }),
    ).rejects.toThrow(ConflictError);
  });

  it('populates current + expected on the error for client recovery', async () => {
    const db = mkDb('2026-01-02T00:00:00Z');
    let err;
    try {
      await assertEntityUnchanged(db, { ...base, ifUnmodifiedSince: '2026-01-01T00:00:00Z' });
    } catch (e) { err = e; }

    expect(err).toBeInstanceOf(ConflictError);
    expect(err.status).toBe(409);
    expect(err.code).toBe('STALE_WRITE');
    expect(err.current).toBeTruthy();
    expect(err.expected).toBeTruthy();
  });

  it('accepts header as an array (Express header quirks)', async () => {
    const ts = '2026-01-01T00:00:00Z';
    const db = mkDb(ts);
    await expect(
      assertEntityUnchanged(db, { ...base, ifUnmodifiedSince: [ts, 'duplicate'] }),
    ).resolves.toBeUndefined();
  });

  it('treats If-Unmodified-Since: * as an explicit stale-write override', async () => {
    const db = mkDb('2026-01-02T00:00:00Z');
    await expect(
      assertEntityUnchanged(db, { ...base, ifUnmodifiedSince: '*' }),
    ).resolves.toBeUndefined();
    expect(db.query).not.toHaveBeenCalled();
    expect(optimisticLockOverrideRequested(['*'])).toBe(true);
  });
});
