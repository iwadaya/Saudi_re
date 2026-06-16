import { pool } from './pool.js';

/**
 * Run `fn` inside a single transaction on a dedicated pooled client; COMMIT on
 * success, ROLLBACK + rethrow on any error, always release the client.
 *
 * Use this whenever several writes (and their audit row) must commit together or
 * not at all — pass the supplied `client` to every query in `fn` AND to logAudit
 * (with { critical: true }) so a failed audit write rolls the whole action back
 * instead of leaving a mutation with no trail. Genuinely best-effort side writes
 * (denormalised mirrors, background refreshes) should run OUTSIDE this, on the
 * pool, so their failure never rolls back the primary action.
 *
 * @template T
 * @param {(client: import('pg').PoolClient) => Promise<T>} fn
 * @returns {Promise<T>}
 */
export async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (e) {
    await client.query('ROLLBACK').catch(() => {});
    throw e;
  } finally {
    client.release();
  }
}
