// Orchestrates a single renewal-pack import job.
//
// Lifecycle:
//   1. The POST endpoint creates a row in import_jobs with
//      status='processing'. The unique partial indexes — one per
//      quote_id, one per contract_id, both partial on status — gives
//      us free concurrency control. A second concurrent POST trips
//      the index and the route maps to 409 IMPORT_IN_PROGRESS.
//   2. The endpoint returns 202 + jobId and kicks off this runner
//      via setImmediate (in-process; no external job queue exists
//      in this codebase yet).
//   3. This runner: reads file from disk → parses → extracts (LLM)
//      → maps to per-page state → snapshots existing state → writes
//      new state → marks the job done. Failures flip the job to
//      status='failed' with error_message and DO NOT write any
//      partial state.
//   4. The polling GET reads the result column off the job row and
//      surfaces filledPages / warnings / unmatchedCresta / restorePointId.
//
// Entity-aware: the same runner targets quotes and contracts. Tables
// + audit entity-types fork on entity.type — everything else is
// shared. Failure mode is identical: if extraction returns null the
// job is recorded failed, no partial state is written.

import fs from 'node:fs/promises';
import { parseRenewalPack } from './parser.js';
import { extractRenewalPack } from './extractor.js';
import { mapExtractionToPages, userVisibleFilledPages } from './wizardMapper.js';
import { capturePages, persistSnapshot } from './snapshots.js';
import { logAudit } from '../audit.js';
import { logger } from '../../lib/logger.js';
import { writePage } from './pageRegistry.js';
import { pool } from '../../db/pool.js';
import { isRemoteStoragePath, resolveLocalStoragePath } from '../../lib/uploadStorage.js';

/**
 * @param {object} args
 * @param {string} args.jobId
 * @param {{ type: 'quote'|'contract', id: string }} args.entity
 * @param {object} args.document - { document_id, file_name, storage_path }
 * @param {'PROPORTIONAL'|'NON_PROPORTIONAL'} args.treatyCategory
 * @param {object} args.actor - audit actor (actorFromReq shape) for the audit row + provenance
 * @param {Function} [args.crestaLookup] - injected for tests; falls back to defaultCrestaLookup
 */
export async function runImportJob({ jobId, entity, document, treatyCategory, actor, crestaLookup }) {
  const filename = document.file_name;
  const startedAt = Date.now();
  logger.info('[importJob] starting', {
    jobId, entityType: entity.type, entityId: entity.id,
    documentId: document.document_id, filename,
  });

  try {
    const fileBuffer = await loadDocumentBuffer(document);

    const parsed = await parseRenewalPack(fileBuffer);

    const extractionResult = await extractRenewalPack(parsed, {
      forceType: treatyCategory === 'NON_PROPORTIONAL' ? 'non_proportional' : 'proportional',
    });
    if (!extractionResult.extraction) {
      throw new Error(`LLM extraction returned no usable output (warnings: ${extractionResult.warnings.join('; ')})`);
    }

    const mapped = await mapExtractionToPages(extractionResult.extraction, {
      treatyCategory,
      crestaLookup: crestaLookup || defaultCrestaLookup,
    });
    const allWarnings = [...extractionResult.warnings, ...mapped.warnings];
    const writePageNames = Object.keys(mapped.pages);
    const visibleFilledPages = userVisibleFilledPages(writePageNames);

    // Single transaction: capture snapshot of existing state on the
    // pages we're about to touch, persist the snapshot row, then
    // overwrite each page with the mapped data. Rolling back on any
    // failure guarantees the snapshot and the writes either both
    // happen or neither does.
    const client = await pool.connect();
    let snapshotId = null;
    try {
      await client.query('BEGIN');

      const snapshotPayload = writePageNames.length
        ? await capturePages(client, entity, writePageNames)
        : { capturedAt: new Date().toISOString(), pages: {} };

      const snapRow = await persistSnapshot(client, {
        entity,
        jobId,
        filename,
        payload: snapshotPayload,
        filledPages: visibleFilledPages,
      });
      snapshotId = snapRow.snapshot_id;

      for (const [name, state] of Object.entries(mapped.pages)) {
        await writePage(client, entity, name, state);
      }

      const provenance = {
        source: 'renewal_pack_import',
        source_filename: filename,
        imported_by: actor?.name ?? actor?.id ?? 'SYSTEM',
        imported_at: new Date().toISOString(),
        type: treatyCategory === 'NON_PROPORTIONAL' ? 'non_proportional' : 'proportional',
        provider: extractionResult.provider,
        field_confidence: mapped.fieldConfidence,
        warnings: allWarnings,
        unmatched_cresta: mapped.unmatchedCresta,
        filled_pages: visibleFilledPages,
        snapshot_id: snapshotId,
      };
      // Provenance on the owning row — the actual values are in the
      // wizard tables now. quote.import_metadata and contract.import_metadata
      // share the same JSONB shape (see migration 098 / 100).
      if (entity.type === 'quote') {
        await client.query(
          `UPDATE public.quote SET import_metadata=$2::jsonb, updated_at=now() WHERE quote_id=$1`,
          [entity.id, JSON.stringify(provenance)],
        );
      } else {
        await client.query(
          `UPDATE public.contract SET import_metadata=$2::jsonb, updated_at=now() WHERE contract_id=$1`,
          [entity.id, JSON.stringify(provenance)],
        );
      }

      await logAudit(client, {
        entityType: entity.type === 'quote' ? 'QUOTE' : 'CONTRACT',
        entityId: entity.id,
        eventType: 'renewal_pack_imported',
        actor,
        payload: {
          entityType: entity.type,
          entityId: entity.id,
          documentId: document.document_id,
          filename,
          filledPages: visibleFilledPages,
          filledPagesCount: visibleFilledPages.length,
          warningCount: allWarnings.length,
          snapshotId,
        },
      });

      const result = {
        status: 'done',
        filledPages: visibleFilledPages,
        warnings: allWarnings,
        unmatchedCresta: mapped.unmatchedCresta,
        restorePointId: snapshotId,
      };

      await client.query(
        `UPDATE public.import_jobs
            SET status='done', result=$2::jsonb, snapshot_id=$3, finished_at=now()
          WHERE job_id=$1`,
        [jobId, JSON.stringify(result), snapshotId],
      );

      await client.query('COMMIT');
      logger.info('[importJob] done', {
        jobId, entityType: entity.type, entityId: entity.id, filename,
        filledPages: visibleFilledPages.length,
        warnings: allWarnings.length,
        durationMs: Date.now() - startedAt,
      });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  } catch (err) {
    logger.error('[importJob] failed', {
      jobId, entityType: entity.type, entityId: entity.id, filename,
      error: err?.message, stack: err?.stack?.split('\n').slice(0, 5).join(' | '),
    });
    // Best-effort failure write — don't let an audit/log failure
    // mask the original error.
    try {
      await pool.query(
        `UPDATE public.import_jobs
            SET status='failed', error_message=$2, finished_at=now()
          WHERE job_id=$1`,
        [jobId, String(err?.message || err).slice(0, 4000)],
      );
    } catch (writeErr) {
      logger.error('[importJob] failed to record failure', { jobId, error: writeErr?.message });
    }
  }
}

/**
 * Load the renewal-pack file from whichever storage sink the
 * document row points at. Cloudinary URLs are fetched; local paths
 * are read via fs.
 */
export async function loadDocumentBuffer(document) {
  const storagePath = document.storage_path;
  if (!storagePath) throw new Error(`Document ${document.document_id} has no storage_path`);
  if (isRemoteStoragePath(storagePath)) {
    const res = await fetch(storagePath);
    if (!res.ok) throw new Error(`Failed to fetch remote document (HTTP ${res.status})`);
    const arr = await res.arrayBuffer();
    return Buffer.from(arr);
  }
  const abs = resolveLocalStoragePath(storagePath);
  return fs.readFile(abs);
}

// Default CRESTA lookup — pulled into this file so the runImportJob
// signature can default it. Tests inject their own to avoid the DB
// dependency.
async function defaultCrestaLookup({ zoneName, zoneCode, countryHint }) {
  if (!zoneName && !zoneCode) return null;
  const { rows } = await pool.query(
    `SELECT z.zone_db_id, z.country_id, z.zone_id, z.zone_name
       FROM public.ref_cresta_zone z
       LEFT JOIN public.country c ON c.country_id = z.country_id
      WHERE ( LOWER(z.zone_name) = LOWER($1)
              OR LOWER(z.zone_id)   = LOWER($1)
              OR ($2::text IS NOT NULL AND LOWER(z.zone_id) = LOWER($2)) )
        AND ($3::text IS NULL
             OR LOWER(c.country_code) = LOWER($3)
             OR LOWER(c.country_name) = LOWER($3))
      ORDER BY z.sort_order, z.zone_id
      LIMIT 1`,
    [zoneName || zoneCode, zoneCode || null, countryHint || null],
  );
  return rows[0] || null;
}
