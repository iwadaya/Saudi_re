// Pre-write snapshot + restore for renewal-pack imports.
//
// The import overwrites whatever's currently on the affected wizard
// pages. To make that recoverable, we snapshot the existing state of
// every page the mapper is about to touch BEFORE we write — captured
// into public.import_snapshots, restorable for 30 days via the
// /restore endpoint.
//
// Why per-page (and not the entire quote): a 12-year premium triangle
// plus five CRESTA blocks plus profiles is already meaningful payload
// size. Snapshotting the full quote on every import would bloat the
// table without value — pages the mapper didn't touch can't be
// restored differently to how they already are.

import { snapshotPage, writePage, isKnownPage } from './pageRegistry.js';
import { logger } from '../../lib/logger.js';

const RETENTION_DAYS = 30;

/**
 * Read the current state of every named page so it can be restored.
 *
 * @returns {Promise<{capturedAt: string, pages: Record<string, object>}>}
 */
export async function capturePages(client, quoteId, pageNames) {
  const pages = {};
  for (const name of pageNames) {
    if (!isKnownPage(name)) {
      logger.warn('[snapshots] capturePages: skipping unknown page', { name, quoteId });
      continue;
    }
    pages[name] = await snapshotPage(client, quoteId, name);
  }
  return { capturedAt: new Date().toISOString(), pages };
}

/**
 * Persist a captured snapshot. Returns the snapshot row id.
 *
 * filename + jobId are stored alongside so the listing endpoint can
 * render meaningful rows without re-joining audit_log.
 */
export async function persistSnapshot(client, { quoteId, jobId, filename, payload, filledPages }) {
  const { rows } = await client.query(
    `INSERT INTO public.import_snapshots
       (quote_id, job_id, filename, filled_pages, payload)
     VALUES ($1, $2, $3, $4::text[], $5::jsonb)
     RETURNING snapshot_id, captured_at`,
    [quoteId, jobId || null, filename || null, filledPages || [], JSON.stringify(payload)],
  );
  return rows[0];
}

/**
 * Write the snapshot back. Used by the restore endpoint. Caller is
 * expected to be inside a transaction and to have already verified
 * the snapshot is restorable (not previously restored, not past
 * retention).
 */
export async function restoreSnapshot(client, quoteId, snapshotPayload) {
  const pages = snapshotPayload?.pages || {};
  for (const [name, state] of Object.entries(pages)) {
    if (!isKnownPage(name)) {
      logger.warn('[snapshots] restoreSnapshot: skipping unknown page', { name, quoteId });
      continue;
    }
    await writePage(client, quoteId, name, state);
  }
}

/**
 * Single-row lookup. Returns the row, an "expired" / "consumed" /
 * "missing" status discriminator, or null if missing.
 */
export async function loadSnapshot(client, snapshotId, quoteId) {
  const { rows } = await client.query(
    `SELECT snapshot_id, quote_id, job_id, filename, filled_pages, captured_at, payload, restored_at,
            (captured_at < (now() - ($2 || ' days')::interval)) AS expired
       FROM public.import_snapshots
      WHERE snapshot_id=$1`,
    [snapshotId, String(RETENTION_DAYS)],
  );
  if (!rows.length) return { status: 'missing' };
  const row = rows[0];
  if (quoteId && row.quote_id !== quoteId) return { status: 'missing' }; // belongs to a different quote → treat as 404
  if (row.restored_at) return { status: 'consumed', row };
  if (row.expired)    return { status: 'expired',  row };
  return { status: 'restorable', row };
}

/**
 * Mark a snapshot consumed. The single-use flag is on restored_at —
 * once set, the row is no longer restorable. Cleanup may later
 * delete the row entirely (30-day retention also applies to
 * restored rows).
 */
export async function markSnapshotRestored(client, snapshotId) {
  await client.query(
    `UPDATE public.import_snapshots SET restored_at = now() WHERE snapshot_id=$1`,
    [snapshotId],
  );
}

/**
 * List snapshots for a quote. Used by GET /import-snapshots.
 * `restorable` is computed at read time from restored_at + age.
 */
export async function listSnapshotsForQuote(client, quoteId) {
  const { rows } = await client.query(
    `SELECT snapshot_id, filename, filled_pages, captured_at, restored_at,
            (captured_at < (now() - ($2 || ' days')::interval)) AS expired
       FROM public.import_snapshots
      WHERE quote_id=$1
      ORDER BY captured_at DESC`,
    [quoteId, String(RETENTION_DAYS)],
  );
  return rows.map((r) => ({
    id: r.snapshot_id,
    capturedAt: r.captured_at,
    filename: r.filename,
    filledPages: r.filled_pages || [],
    restorable: !r.restored_at && !r.expired,
    restoredAt: r.restored_at || null,
  }));
}

/**
 * Delete snapshots older than the retention window. Returns the
 * row count for logging.
 */
export async function cleanupExpiredSnapshots(client) {
  const { rowCount } = await client.query(
    `DELETE FROM public.import_snapshots
      WHERE captured_at < (now() - ($1 || ' days')::interval)`,
    [String(RETENTION_DAYS)],
  );
  return rowCount || 0;
}

export const RETENTION_DAYS_EXPORTED = RETENTION_DAYS;
