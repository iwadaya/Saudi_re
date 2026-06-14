// Renewal-pack import endpoints — symmetric across quotes and contracts.
//
// Documents are already classified on upload (doc_type='renewal_pack')
// and the entity's treaty type is already known once treaty detail is
// saved, so this route is one click for the underwriter. The same
// runner targets either entity; the route layer is responsible only
// for resolving the entity from the URL, validating the document, and
// kicking off the job.
//
//   POST /api/quotes/:quoteId/import-renewal-pack
//   POST /api/treaties/:contractId/import-renewal-pack
//        body: { documentId } → 202 { jobId }
//
//   GET  /api/quotes/:quoteId/import-renewal-pack
//   GET  /api/treaties/:contractId/import-renewal-pack
//        → { activeJob: { jobId, documentId, startedAt } | null }
//
//   GET  /api/quotes/:quoteId/import-renewal-pack/:jobId
//   GET  /api/treaties/:contractId/import-renewal-pack/:jobId
//        → { status: 'processing' | 'done' | 'failed', ... }
//
//   GET  /api/quotes/:quoteId/import-snapshots
//   GET  /api/treaties/:contractId/import-snapshots
//        → [{ id, capturedAt, filename, filledPages, restorable }]
//
//   POST /api/quotes/:quoteId/import-snapshots/:snapshotId/restore
//   POST /api/treaties/:contractId/import-snapshots/:snapshotId/restore
//        → 200 { ok: true } | 410 (already restored / past retention)
//
// The actual extraction work runs asynchronously via setImmediate so
// the LLM call doesn't keep the request handler tied up. No external
// job queue is needed — the import_jobs table holds the state and the
// polling GET reads from it.

import { Router } from 'express';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../helpers.js';
import { logger } from '../lib/logger.js';
import { logAudit } from '../services/audit.js';
import { runImportJob } from '../services/renewalPack/importJob.js';
import {
  loadSnapshot,
  markSnapshotRestored,
  restoreSnapshot,
  listSnapshotsForEntity,
} from '../services/renewalPack/snapshots.js';

const router = Router();

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

// The Documents UI uses display-cased "Renewal Pack" in the upload
// form (see DocumentsScreen DOC_TYPES list); the prompt and server
// API talk about "renewal_pack". Normalize both to one canonical
// form so either upload path is accepted as authoritative.
function isRenewalPackDocType(value) {
  return String(value || '').toLowerCase().replace(/\s+/g, '_') === 'renewal_pack';
}

// ── entity resolution ──────────────────────────────────────────────────────
//
// Each route picks the entity type from the URL prefix, then this
// helper loads the row + treaty-type category for the import. Quotes
// and contracts have isomorphic-enough shapes (treaty_type_id + a
// join to treaty_type.category) that one resolver covers both.

async function resolveEntity({ type, id }) {
  if (type === 'quote') {
    const { rows } = await pool.query(
      `SELECT q.quote_id AS id, q.treaty_type_id, tt.category AS treaty_category
         FROM public.quote q
         LEFT JOIN public.treaty_type tt ON tt.treaty_type_id = q.treaty_type_id
        WHERE q.quote_id = $1`,
      [id],
    );
    return rows[0] || null;
  }
  const { rows } = await pool.query(
    `SELECT c.contract_id AS id, c.treaty_type_id, tt.category AS treaty_category
       FROM public.contract c
       LEFT JOIN public.treaty_type tt ON tt.treaty_type_id = c.treaty_type_id
      WHERE c.contract_id = $1`,
    [id],
  );
  return rows[0] || null;
}

// ── start import (POST) ────────────────────────────────────────────────────

function makeStartImportHandler(entityType) {
  return asyncHandler(async (req, res) => {
    const paramKey = entityType === 'quote' ? 'quoteId' : 'contractId';
    const entityId = req.params[paramKey];
    const { documentId } = req.body || {};

    if (!UUID_RE.test(entityId) || !documentId || !UUID_RE.test(documentId)) {
      return res.status(404).json({ error: 'Entity or document not found', code: 'NOT_FOUND' });
    }

    const [resolved, docR] = await Promise.all([
      resolveEntity({ type: entityType, id: entityId }),
      pool.query(
        `SELECT document_id, file_name, storage_path, doc_type, contract_id, quote_id
           FROM public.contract_document
          WHERE document_id = $1`,
        [documentId],
      ),
    ]);

    if (!resolved) {
      return res.status(404).json({
        error: entityType === 'quote' ? 'Quote not found' : 'Treaty not found',
        code: entityType === 'quote' ? 'QUOTE_NOT_FOUND' : 'TREATY_NOT_FOUND',
      });
    }
    if (!docR.rows.length) {
      return res.status(404).json({ error: 'Document not found', code: 'DOCUMENT_NOT_FOUND' });
    }
    const document = docR.rows[0];

    if (!isRenewalPackDocType(document.doc_type)) {
      return res.status(409).json({
        error: 'Document is not a renewal pack',
        code: 'NOT_RENEWAL_PACK',
      });
    }

    // The document must belong to the same entity we're importing into —
    // otherwise we'd be silently moving data across the wall between a
    // contract and an unrelated quote. The relocate script is the
    // explicit path for cross-entity moves.
    const ownerCol = entityType === 'quote' ? 'quote_id' : 'contract_id';
    if (document[ownerCol] !== entityId) {
      return res.status(409).json({
        error: 'Document does not belong to this ' + (entityType === 'quote' ? 'quote' : 'treaty'),
        code: 'DOCUMENT_OWNER_MISMATCH',
      });
    }

    // Treaty detail must be saved so we know which extraction prompt
    // to use. The category column on treaty_type drives proportional
    // vs non-proportional.
    if (!resolved.treaty_type_id || !resolved.treaty_category) {
      return res.status(409).json({
        error: 'Treaty detail must be saved before importing',
        code: 'TREATY_DETAIL_REQUIRED',
      });
    }
    const treatyCategory = String(resolved.treaty_category).toUpperCase();

    // Insert the job row with status='processing'. The unique partial
    // indexes (per quote_id, per contract_id) give us free concurrency
    // control — a second concurrent POST trips the index and we
    // surface 409.
    const fkCol = entityType === 'quote' ? 'quote_id' : 'contract_id';
    let jobId;
    try {
      const { rows } = await pool.query(
        `INSERT INTO public.import_jobs (${fkCol}, document_id, filename, status)
         VALUES ($1, $2, $3, 'processing')
         RETURNING job_id`,
        [entityId, documentId, document.file_name || null],
      );
      jobId = rows[0].job_id;
    } catch (err) {
      if (err?.code === '23505') {
        return res.status(409).json({
          error: 'An import is already in progress for this ' + (entityType === 'quote' ? 'quote' : 'treaty'),
          code: 'IMPORT_IN_PROGRESS',
        });
      }
      throw err;
    }

    const actor = req.user?.displayName || req.user?.userId || 'SYSTEM';

    // Kick off the async work. setImmediate runs after the response
    // is flushed, so the underwriter sees the 202 promptly even on a
    // slow LLM.
    setImmediate(() => {
      runImportJob({
        jobId,
        entity: { type: entityType, id: entityId },
        document,
        treatyCategory,
        actor,
      }).catch((err) => {
        // runImportJob already records failure on the job row; this
        // catch is purely to keep an unhandled rejection from
        // bubbling to the process default handler.
        logger.error('[renewalPackImport] background runImportJob threw', {
          jobId, entityType, entityId, error: err?.message,
        });
      });
    });

    return res.status(202).json({ jobId });
  });
}

router.post('/quotes/:quoteId/import-renewal-pack',     makeStartImportHandler('quote'));
router.post('/treaties/:contractId/import-renewal-pack', makeStartImportHandler('contract'));

// ── active-job lookup (GET, no jobId) ──────────────────────────────────────

function makeActiveImportHandler(entityType) {
  return asyncHandler(async (req, res) => {
    const paramKey = entityType === 'quote' ? 'quoteId' : 'contractId';
    const entityId = req.params[paramKey];
    if (!UUID_RE.test(entityId)) {
      return res.json({ activeJob: null });
    }
    const fkCol = entityType === 'quote' ? 'quote_id' : 'contract_id';
    const { rows } = await pool.query(
      `SELECT job_id, document_id, started_at
         FROM public.import_jobs
        WHERE ${fkCol} = $1 AND status = 'processing'
        ORDER BY started_at DESC
        LIMIT 1`,
      [entityId],
    );
    if (!rows.length) return res.json({ activeJob: null });
    const job = rows[0];
    return res.json({
      activeJob: {
        jobId: job.job_id,
        documentId: job.document_id,
        startedAt: job.started_at,
      },
    });
  });
}

router.get('/quotes/:quoteId/import-renewal-pack',     makeActiveImportHandler('quote'));
router.get('/treaties/:contractId/import-renewal-pack', makeActiveImportHandler('contract'));

// ── job-state poll (GET with jobId) ────────────────────────────────────────

function makeJobLookupHandler(entityType) {
  return asyncHandler(async (req, res) => {
    const paramKey = entityType === 'quote' ? 'quoteId' : 'contractId';
    const entityId = req.params[paramKey];
    const { jobId } = req.params;
    if (!UUID_RE.test(entityId) || !UUID_RE.test(jobId)) {
      return res.status(404).json({ error: 'Job not found', code: 'JOB_NOT_FOUND' });
    }
    const fkCol = entityType === 'quote' ? 'quote_id' : 'contract_id';
    const { rows } = await pool.query(
      `SELECT job_id, status, result, error_message, started_at, finished_at
         FROM public.import_jobs
        WHERE job_id = $1 AND ${fkCol} = $2`,
      [jobId, entityId],
    );
    if (!rows.length) {
      return res.status(404).json({ error: 'Job not found', code: 'JOB_NOT_FOUND' });
    }
    const job = rows[0];
    if (job.status === 'processing') {
      return res.json({ status: 'processing', startedAt: job.started_at });
    }
    if (job.status === 'failed') {
      return res.json({ status: 'failed', error: job.error_message, finishedAt: job.finished_at });
    }
    // Status is 'done' — surface the cached result payload as-is.
    return res.json({ ...job.result, finishedAt: job.finished_at });
  });
}

router.get('/quotes/:quoteId/import-renewal-pack/:jobId',     makeJobLookupHandler('quote'));
router.get('/treaties/:contractId/import-renewal-pack/:jobId', makeJobLookupHandler('contract'));

// ── snapshot listing (GET) ─────────────────────────────────────────────────

function makeListSnapshotsHandler(entityType) {
  return asyncHandler(async (req, res) => {
    const paramKey = entityType === 'quote' ? 'quoteId' : 'contractId';
    const entityId = req.params[paramKey];
    if (!UUID_RE.test(entityId)) {
      return res.status(404).json({
        error: entityType === 'quote' ? 'Quote not found' : 'Treaty not found',
        code: entityType === 'quote' ? 'QUOTE_NOT_FOUND' : 'TREATY_NOT_FOUND',
      });
    }
    const table = entityType === 'quote' ? 'public.quote' : 'public.contract';
    const idCol = entityType === 'quote' ? 'quote_id' : 'contract_id';
    const { rows: qr } = await pool.query(
      `SELECT 1 FROM ${table} WHERE ${idCol}=$1`,
      [entityId],
    );
    if (!qr.length) {
      return res.status(404).json({
        error: entityType === 'quote' ? 'Quote not found' : 'Treaty not found',
        code: entityType === 'quote' ? 'QUOTE_NOT_FOUND' : 'TREATY_NOT_FOUND',
      });
    }
    const snapshots = await listSnapshotsForEntity(pool, { type: entityType, id: entityId });
    return res.json(snapshots);
  });
}

router.get('/quotes/:quoteId/import-snapshots',     makeListSnapshotsHandler('quote'));
router.get('/treaties/:contractId/import-snapshots', makeListSnapshotsHandler('contract'));

// ── snapshot restore (POST) ────────────────────────────────────────────────

function makeRestoreSnapshotHandler(entityType) {
  return asyncHandler(async (req, res) => {
    const paramKey = entityType === 'quote' ? 'quoteId' : 'contractId';
    const entityId = req.params[paramKey];
    const { snapshotId } = req.params;
    if (!UUID_RE.test(entityId) || !UUID_RE.test(snapshotId)) {
      return res.status(404).json({ error: 'Snapshot not found', code: 'SNAPSHOT_NOT_FOUND' });
    }

    const entity = { type: entityType, id: entityId };

    // Pre-check inside a short-lived read. A second client could
    // race the restore between this read and the transaction below;
    // if that happens, the transaction's lookup catches it and we
    // either succeed (consumed flag still false) or 410 (consumed
    // flag flipped). The pre-check is just to short-circuit the
    // obvious cases without acquiring a write transaction.
    const preview = await loadSnapshot(pool, snapshotId, entity);
    if (preview.status === 'missing') {
      return res.status(404).json({ error: 'Snapshot not found', code: 'SNAPSHOT_NOT_FOUND' });
    }
    if (preview.status === 'consumed') {
      return res.status(410).json({
        error: 'Snapshot has already been restored',
        code: 'SNAPSHOT_ALREADY_RESTORED',
      });
    }
    if (preview.status === 'expired') {
      return res.status(410).json({
        error: 'Snapshot is past the 30-day retention window',
        code: 'SNAPSHOT_EXPIRED',
      });
    }

    const actor = req.user?.displayName || req.user?.userId || 'SYSTEM';
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Re-read inside the transaction so a concurrent restore (or
      // cleanup) can't slip past the pre-check.
      const fresh = await loadSnapshot(client, snapshotId, entity);
      if (fresh.status === 'missing') {
        await client.query('ROLLBACK');
        return res.status(404).json({ error: 'Snapshot not found', code: 'SNAPSHOT_NOT_FOUND' });
      }
      if (fresh.status === 'consumed') {
        await client.query('ROLLBACK');
        return res.status(410).json({
          error: 'Snapshot has already been restored',
          code: 'SNAPSHOT_ALREADY_RESTORED',
        });
      }
      if (fresh.status === 'expired') {
        await client.query('ROLLBACK');
        return res.status(410).json({
          error: 'Snapshot is past the 30-day retention window',
          code: 'SNAPSHOT_EXPIRED',
        });
      }

      await restoreSnapshot(client, entity, fresh.row.payload);
      await markSnapshotRestored(client, snapshotId);
      if (entityType === 'quote') {
        await client.query(
          `UPDATE public.quote SET updated_at = now() WHERE quote_id = $1`,
          [entityId],
        );
      } else {
        await client.query(
          `UPDATE public.contract SET updated_at = now() WHERE contract_id = $1`,
          [entityId],
        );
      }
      await logAudit(client, {
        entityType: entityType === 'quote' ? 'QUOTE' : 'CONTRACT',
        entityId,
        eventType: 'import_restored',
        actor,
        payload: {
          entityType,
          entityId,
          snapshotId,
          restoredPages: Object.keys(fresh.row.payload?.pages || {}),
        },
      });
      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }

    return res.json({ ok: true, snapshotId });
  });
}

router.post('/quotes/:quoteId/import-snapshots/:snapshotId/restore',     makeRestoreSnapshotHandler('quote'));
router.post('/treaties/:contractId/import-snapshots/:snapshotId/restore', makeRestoreSnapshotHandler('contract'));

export default router;
