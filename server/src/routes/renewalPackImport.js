// Renewal-pack import endpoints.
//
// Documents are already classified on upload (doc_type='renewal_pack')
// and the quote's treaty type is already known once treaty detail is
// saved. This route is therefore one click for the underwriter:
//
//   POST /api/quotes/:quoteId/import-renewal-pack
//        body: { documentId }
//        → 202 { jobId }
//
//   GET  /api/quotes/:quoteId/import-renewal-pack/:jobId
//        → { status: 'processing' | 'done' | 'failed', ... }
//
//   POST /api/quotes/:quoteId/import-snapshots/:snapshotId/restore
//        → 200 { ok: true } | 410 (already restored / past retention)
//
//   GET  /api/quotes/:quoteId/import-snapshots
//        → [{ id, capturedAt, filename, filledPages, restorable }]
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
  listSnapshotsForQuote,
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

// ── POST /quotes/:quoteId/import-renewal-pack ─────────────────────────────

router.post(
  '/quotes/:quoteId/import-renewal-pack',
  asyncHandler(async (req, res) => {
    const { quoteId } = req.params;
    const { documentId } = req.body || {};

    if (!UUID_RE.test(quoteId) || !documentId || !UUID_RE.test(documentId)) {
      return res.status(404).json({ error: 'Quote or document not found', code: 'NOT_FOUND' });
    }

    // Existence checks — load quote + document in parallel.
    const [quoteR, docR] = await Promise.all([
      pool.query(
        `SELECT q.quote_id, q.treaty_type_id, tt.category AS treaty_category
           FROM public.quote q
           LEFT JOIN public.treaty_type tt ON tt.treaty_type_id = q.treaty_type_id
          WHERE q.quote_id = $1`,
        [quoteId],
      ),
      pool.query(
        `SELECT document_id, file_name, storage_path, doc_type, quote_id
           FROM public.contract_document
          WHERE document_id = $1`,
        [documentId],
      ),
    ]);

    if (!quoteR.rows.length) {
      return res.status(404).json({ error: 'Quote not found', code: 'QUOTE_NOT_FOUND' });
    }
    if (!docR.rows.length) {
      return res.status(404).json({ error: 'Document not found', code: 'DOCUMENT_NOT_FOUND' });
    }
    const quote = quoteR.rows[0];
    const document = docR.rows[0];

    // Document must be of type renewal_pack (the upload classifier
    // sets doc_type — we only accept docs that were uploaded as
    // renewal packs).
    if (!isRenewalPackDocType(document.doc_type)) {
      return res.status(409).json({
        error: 'Document is not a renewal pack',
        code: 'NOT_RENEWAL_PACK',
      });
    }

    // Treaty detail must be saved so we know which extraction prompt
    // to use. The category column on treaty_type drives proportional
    // vs non-proportional.
    if (!quote.treaty_type_id || !quote.treaty_category) {
      return res.status(409).json({
        error: 'Treaty detail must be saved before importing',
        code: 'TREATY_DETAIL_REQUIRED',
      });
    }
    const treatyCategory = String(quote.treaty_category).toUpperCase();

    // Insert the job row with status='processing'. The unique
    // partial index gives us free concurrency control — a second
    // concurrent POST trips the index and we surface 409.
    let jobId;
    try {
      const { rows } = await pool.query(
        `INSERT INTO public.import_jobs (quote_id, document_id, filename, status)
         VALUES ($1, $2, $3, 'processing')
         RETURNING job_id`,
        [quoteId, documentId, document.file_name || null],
      );
      jobId = rows[0].job_id;
    } catch (err) {
      if (err?.code === '23505') {
        return res.status(409).json({
          error: 'An import is already in progress for this quote',
          code: 'IMPORT_IN_PROGRESS',
        });
      }
      throw err;
    }

    const actor = req.user?.displayName || req.user?.userId || req.headers['x-user-id'] || 'SYSTEM';

    // Kick off the async work. setImmediate runs after the response
    // is flushed, so the underwriter sees the 202 promptly even on a
    // slow LLM.
    setImmediate(() => {
      runImportJob({
        jobId,
        quoteId,
        document,
        treatyCategory,
        actor,
      }).catch((err) => {
        // runImportJob already records failure on the job row; this
        // catch is purely to keep an unhandled rejection from
        // bubbling to the process default handler.
        logger.error('[renewalPackImport] background runImportJob threw', {
          jobId, quoteId, error: err?.message,
        });
      });
    });

    return res.status(202).json({ jobId });
  }),
);

// ── GET /quotes/:quoteId/import-renewal-pack ──────────────────────────────
// Read the currently-active import job for a quote, if any. The
// Documents tab calls this on mount so it can disable the "Fill from
// renewal pack" button while another import is running.
router.get(
  '/quotes/:quoteId/import-renewal-pack',
  asyncHandler(async (req, res) => {
    const { quoteId } = req.params;
    if (!UUID_RE.test(quoteId)) {
      return res.json({ activeJob: null });
    }
    const { rows } = await pool.query(
      `SELECT job_id, document_id, started_at
         FROM public.import_jobs
        WHERE quote_id = $1 AND status = 'processing'
        ORDER BY started_at DESC
        LIMIT 1`,
      [quoteId],
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
  }),
);

// ── GET /quotes/:quoteId/import-renewal-pack/:jobId ───────────────────────

router.get(
  '/quotes/:quoteId/import-renewal-pack/:jobId',
  asyncHandler(async (req, res) => {
    const { quoteId, jobId } = req.params;
    if (!UUID_RE.test(quoteId) || !UUID_RE.test(jobId)) {
      return res.status(404).json({ error: 'Job not found', code: 'JOB_NOT_FOUND' });
    }
    const { rows } = await pool.query(
      `SELECT job_id, status, result, error_message, started_at, finished_at
         FROM public.import_jobs
        WHERE job_id = $1 AND quote_id = $2`,
      [jobId, quoteId],
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
  }),
);

// ── GET /quotes/:quoteId/import-snapshots ─────────────────────────────────

router.get(
  '/quotes/:quoteId/import-snapshots',
  asyncHandler(async (req, res) => {
    const { quoteId } = req.params;
    if (!UUID_RE.test(quoteId)) {
      return res.status(404).json({ error: 'Quote not found', code: 'QUOTE_NOT_FOUND' });
    }
    const { rows: qr } = await pool.query(
      `SELECT 1 FROM public.quote WHERE quote_id=$1`,
      [quoteId],
    );
    if (!qr.length) {
      return res.status(404).json({ error: 'Quote not found', code: 'QUOTE_NOT_FOUND' });
    }
    const snapshots = await listSnapshotsForQuote(pool, quoteId);
    return res.json(snapshots);
  }),
);

// ── POST /quotes/:quoteId/import-snapshots/:snapshotId/restore ────────────

router.post(
  '/quotes/:quoteId/import-snapshots/:snapshotId/restore',
  asyncHandler(async (req, res) => {
    const { quoteId, snapshotId } = req.params;
    if (!UUID_RE.test(quoteId) || !UUID_RE.test(snapshotId)) {
      return res.status(404).json({ error: 'Snapshot not found', code: 'SNAPSHOT_NOT_FOUND' });
    }

    // Pre-check inside a short-lived read. A second client could
    // race the restore between this read and the transaction below;
    // if that happens, the transaction's lookup catches it and we
    // either succeed (consumed flag still false) or 410 (consumed
    // flag flipped). The pre-check is just to short-circuit the
    // obvious cases without acquiring a write transaction.
    const preview = await loadSnapshot(pool, snapshotId, quoteId);
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

    const actor = req.user?.displayName || req.user?.userId || req.headers['x-user-id'] || 'SYSTEM';
    const client = await pool.connect();
    try {
      await client.query('BEGIN');

      // Re-read inside the transaction so a concurrent restore (or
      // cleanup) can't slip past the pre-check.
      const fresh = await loadSnapshot(client, snapshotId, quoteId);
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

      await restoreSnapshot(client, quoteId, fresh.row.payload);
      await markSnapshotRestored(client, snapshotId);
      await client.query(
        `UPDATE public.quote SET updated_at = now() WHERE quote_id = $1`,
        [quoteId],
      );
      await logAudit(client, {
        entityType: 'QUOTE',
        entityId: quoteId,
        eventType: 'import_restored',
        actor,
        payload: {
          quoteId,
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
  }),
);

export default router;
