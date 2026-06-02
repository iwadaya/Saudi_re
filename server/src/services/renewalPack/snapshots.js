// Pre-write snapshot + restore for renewal-pack imports.
//
// The import overwrites whatever's currently on the affected wizard
// pages. To make that recoverable, we snapshot the existing state of
// every page the mapper is about to touch BEFORE we write — captured
// into public.import_snapshots, restorable for 30 days via the
// /restore endpoint.
//
// import_snapshots is a single table polymorphic on its owner — every
// row carries either a quote_id or a contract_id (CHECK constraint
// keeps exactly one set). All exported functions take an `entity`
// argument of the shape { type: 'quote' | 'contract', id } so the
// callers don't need to know which column to write.
//
// Why per-page (and not the entire treaty / quote): a 12-year premium
// triangle plus five CRESTA blocks plus profiles is already meaningful
// payload size. Snapshotting the full entity on every import would
// bloat the table without value — pages the mapper didn't touch can't
// be restored differently to how they already are.

import { snapshotPage, writePage, isKnownPage } from './pageRegistry.js';
import { logger } from '../../lib/logger.js';

const RETENTION_DAYS = 30;

function entityFkColumn(entity) {
  return entity.type === 'quote' ? 'quote_id' : 'contract_id';
}

function entityMatches(row, entity) {
  const col = entityFkColumn(entity);
  return row[col] === entity.id;
}

/**
 * Read the current state of every named page so it can be restored.
 *
 * @returns {Promise<{capturedAt: string, pages: Record<string, object>}>}
 */
export async function capturePages(client, entity, pageNames) {
  const pages = {};
  for (const name of pageNames) {
    if (!isKnownPage(name)) {
      logger.warn('[snapshots] capturePages: skipping unknown page', { name, entity });
      continue;
    }
    pages[name] = await snapshotPage(client, entity, name);
  }
  return { capturedAt: new Date().toISOString(), pages };
}

/**
 * Persist a captured snapshot. Returns the snapshot row id.
 *
 * filename + jobId are stored alongside so the listing endpoint can
 * render meaningful rows without re-joining audit_log.
 */
export async function persistSnapshot(client, { entity, jobId, filename, payload, filledPages }) {
  const col = entityFkColumn(entity);
  // contract_id / quote_id is the only column whose name depends on
  // the entity — interpolate it directly. The CHECK constraint on
  // import_snapshots guarantees the other column stays NULL.
  const { rows } = await client.query(
    `INSERT INTO public.import_snapshots
       (${col}, job_id, filename, filled_pages, payload)
     VALUES ($1, $2, $3, $4::text[], $5::jsonb)
     RETURNING snapshot_id, captured_at`,
    [entity.id, jobId || null, filename || null, filledPages || [], JSON.stringify(payload)],
  );
  return rows[0];
}

/**
 * Write the snapshot back. Used by the restore endpoint. Caller is
 * expected to be inside a transaction and to have already verified
 * the snapshot is restorable (not previously restored, not past
 * retention).
 */
export async function restoreSnapshot(client, entity, snapshotPayload) {
  const pages = snapshotPayload?.pages || {};
  for (const [name, state] of Object.entries(pages)) {
    if (!isKnownPage(name)) {
      logger.warn('[snapshots] restoreSnapshot: skipping unknown page', { name, entity });
      continue;
    }
    await writePage(client, entity, name, state);
  }
}

/**
 * Single-row lookup. Returns the row, an "expired" / "consumed" /
 * "missing" status discriminator, or null if missing.
 *
 * `entity` is used to assert ownership — a snapshot belonging to a
 * different entity (whether quote→contract or vice versa) is treated
 * as 404, same as not existing at all.
 */
export async function loadSnapshot(client, snapshotId, entity) {
  const { rows } = await client.query(
    `SELECT snapshot_id, quote_id, contract_id, job_id, filename, filled_pages,
            captured_at, payload, restored_at,
            (captured_at < (now() - ($2 || ' days')::interval)) AS expired
       FROM public.import_snapshots
      WHERE snapshot_id=$1`,
    [snapshotId, String(RETENTION_DAYS)],
  );
  if (!rows.length) return { status: 'missing' };
  const row = rows[0];
  if (entity && !entityMatches(row, entity)) return { status: 'missing' };
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
 * List snapshots for an entity. Used by the GET /import-snapshots
 * endpoints (one per entity type). `restorable` is computed at read
 * time from restored_at + age. `documentId` comes from the originating
 * job so the UI can match a snapshot to its source document row.
 */
export async function listSnapshotsForEntity(client, entity) {
  const col = entityFkColumn(entity);
  const { rows } = await client.query(
    `SELECT s.snapshot_id, s.filename, s.filled_pages, s.captured_at, s.restored_at,
            j.document_id,
            (s.captured_at < (now() - ($2 || ' days')::interval)) AS expired
       FROM public.import_snapshots s
       LEFT JOIN public.import_jobs j ON j.job_id = s.job_id
      WHERE s.${col}=$1
      ORDER BY s.captured_at DESC`,
    [entity.id, String(RETENTION_DAYS)],
  );
  return rows.map((r) => ({
    id: r.snapshot_id,
    capturedAt: r.captured_at,
    filename: r.filename,
    filledPages: r.filled_pages || [],
    documentId: r.document_id || null,
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
