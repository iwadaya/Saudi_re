// server/src/db/optimisticLock.js
// Lightweight optimistic-locking helper for entity updates.
//
// Problem: in a small team using the same treaty, two underwriters can
// open the same quote, one saves, the other saves over the top without
// realising their view was stale. This helper closes that window using
// an "expected updated_at" check — the client sends the timestamp it
// last read, the server only commits if the stored timestamp is the
// same or older. No schema change required; works against any table
// with an updated_at column.
//
// Usage in a route:
//   await assertEntityUnchanged(client, {
//     table: 'public.quote', idColumn: 'quote_id', id,
//     ifUnmodifiedSince: req.headers['if-unmodified-since'],
//   });
// Throws ConflictError (status 409) if the row has been updated since.

/** Error thrown when optimistic locking detects concurrent modification. */
export class ConflictError extends Error {
  constructor(message, { current, expected } = {}) {
    super(message);
    this.name = 'ConflictError';
    this.status = 409;
    this.code = 'STALE_WRITE';
    this.current = current;
    this.expected = expected;
  }
}

function firstHeaderValue(value) {
  return Array.isArray(value) ? value[0] : value;
}

export function optimisticLockOverrideRequested(ifUnmodifiedSince) {
  const header = firstHeaderValue(ifUnmodifiedSince);
  return typeof header === 'string' && header.trim() === '*';
}

/**
 * Assert the entity hasn't been modified since the caller last read it.
 * If `ifUnmodifiedSince` is not supplied or not parseable, this is a
 * no-op (backwards-compatible with clients that don't send the header).
 *
 * @param {import('pg').PoolClient|import('pg').Pool} db
 * @param {{table:string, idColumn:string, id:string|number, ifUnmodifiedSince?:string|string[]}} opts
 */
export async function assertEntityUnchanged(db, { table, idColumn, id, ifUnmodifiedSince }) {
  if (!ifUnmodifiedSince) return; // opt-in
  if (optimisticLockOverrideRequested(ifUnmodifiedSince)) return; // explicit user override
  const header = firstHeaderValue(ifUnmodifiedSince);
  const expected = new Date(header);
  if (Number.isNaN(expected.getTime())) return; // unparseable — skip

  const { rows } = await db.query(
    `SELECT updated_at FROM ${table} WHERE ${idColumn} = $1`,
    [id],
  );
  if (!rows.length) return; // let the caller's own existence check handle 404

  const current = new Date(rows[0].updated_at);
  // Strict: even a 1ms diff is a real concurrent write — the column has
  // millisecond precision and ISO strings round-trip exactly through JSON.
  // Earlier versions had a 500ms grace, which masked back-to-back saves
  // that the test suite specifically checks for.
  if (current.getTime() > expected.getTime()) {
    throw new ConflictError(
      `${table.split('.').pop()} ${id} has been modified since ${expected.toISOString()}`,
      { current: current.toISOString(), expected: expected.toISOString() },
    );
  }
}
