// POST /api/quotes/import-renewal-pack
//
// Accepts a single .xlsx workbook, runs it through the
// parser → extractor → wizardMapper pipeline, and persists a draft
// quote with the resulting wizard state hung on import_metadata so the
// reviewer screen can hydrate it.
//
// Auth: the global x-user-role middleware at app.js:268 already
// rejects unauthenticated calls (401, code 'UNAUTHORIZED'). req.user is
// populated by attachRequestContext at app.js:270 — we read userId from
// it for the audit log + assigned_to_user_id.
//
// Body parser: this is a multipart route — multer.single('file')
// consumes the request stream before express.json gets a chance, so
// the 1 MB JSON limit at app.js:262 doesn't apply. The 413 we hit
// previously was caused by routing the file through the JSON parser
// by accident; this route bypasses it cleanly.

import { Router } from 'express';
import multer from 'multer';
import { pool } from '../db/pool.js';
import { asyncHandler } from '../helpers.js';
import { logger } from '../lib/logger.js';
import { logAudit } from '../services/audit.js';
import { parseRenewalPack } from '../services/renewalPack/parser.js';
import { extractRenewalPack } from '../services/renewalPack/extractor.js';
import { mapExtractionToWizardState } from '../services/renewalPack/wizardMapper.js';

const router = Router();

const MAX_UPLOAD_BYTES = 25 * 1024 * 1024;
const ALLOWED_MIME_TYPES = new Set([
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', // .xlsx
  'application/vnd.ms-excel',                                          // some clients still send this for xlsx
  'application/octet-stream',                                          // some browsers / curl
]);

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
});

// Default CRESTA lookup: zone name → ref_cresta_zone row. Used by the
// wizard mapper; injected here so tests can replace it without DB.
// public.country (NOT ref_country — there is no such table) is joined
// optionally so a countryHint of "SA" or "Saudi Arabia" can disambiguate
// zones whose codes are shared across multiple countries.
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

/**
 * @typedef {object} ImportResult
 * @property {string} quoteId
 * @property {'proportional'|'non_proportional'} type
 * @property {Record<string, number>} fieldConfidence
 * @property {string[]} warnings
 * @property {string[]} unmatchedCresta
 */

router.post(
  '/quotes/import-renewal-pack',
  upload.single('file'),
  asyncHandler(async (req, res) => {
    // Validation: multer hands us req.file. Fail clearly when the
    // multipart envelope omits it or the client used the wrong field
    // name — multer.single() returns undefined silently otherwise.
    const file = req.file;
    if (!file) {
      return res.status(400).json({
        error: 'Field "file" with a single .xlsx attachment is required',
        code: 'MISSING_FILE',
      });
    }
    if (!file.originalname || !/\.xlsx$/i.test(file.originalname)) {
      return res.status(400).json({
        error: 'Only .xlsx files are supported',
        code: 'BAD_EXTENSION',
      });
    }
    if (!ALLOWED_MIME_TYPES.has(file.mimetype)) {
      return res.status(415).json({
        error: `Unsupported MIME type "${file.mimetype}"`,
        code: 'BAD_MIME',
      });
    }
    if (file.size > MAX_UPLOAD_BYTES) {
      // multer.limits should catch this first, but keep an explicit
      // guard in case the limit is bypassed by a streamed body.
      return res.status(413).json({
        error: `File exceeds the ${MAX_UPLOAD_BYTES} byte limit`,
        code: 'FILE_TOO_LARGE',
      });
    }

    const userId = req.user?.userId || req.headers['x-user-id'] || null;
    const actorName = req.user?.displayName || 'SYSTEM';

    let parsed;
    try {
      parsed = await parseRenewalPack(file.buffer);
    } catch (err) {
      logger.error('[renewal-pack-import] parse failed', { error: err?.message, filename: file.originalname });
      return res.status(400).json({
        error: `Failed to parse workbook: ${err?.message || err}`,
        code: 'PARSE_FAILED',
      });
    }

    let extraction;
    try {
      extraction = await extractRenewalPack(parsed);
    } catch (err) {
      logger.error('[renewal-pack-import] extraction failed', { error: err?.message, filename: file.originalname });
      return res.status(502).json({
        error: `LLM extraction failed: ${err?.message || err}`,
        code: 'EXTRACTION_FAILED',
      });
    }

    // The extractor returns the partial extraction even on second-attempt
    // failure; warnings[] carries the schema diagnostics. We persist
    // anyway so the reviewer can resolve manually, but flag it in the
    // response so the UI surfaces a banner.
    if (!extraction.extraction) {
      return res.status(502).json({
        error: 'LLM extraction returned no usable output',
        code: 'EXTRACTION_EMPTY',
        warnings: extraction.warnings,
      });
    }

    const { wizardState, fieldConfidence, warnings: mapperWarnings, unmatchedCresta } =
      await mapExtractionToWizardState(extraction.extraction, { crestaLookup: defaultCrestaLookup });

    const allWarnings = [...extraction.warnings, ...mapperWarnings];

    const client = await pool.connect();
    let quoteId;
    try {
      await client.query('BEGIN');

      const uwYear = wizardState.header.uw_year || new Date().getFullYear();
      const { rows: insertRows } = await client.query(
        `INSERT INTO public.quote
           (uw_year, status, experience_source, renewal_date, inception_date,
            contract_description, created_by_user_id, assigned_to_user_id,
            import_metadata)
         VALUES ($1, 'DRAFT', $2, $3, $4, $5, $6, $6, $7::jsonb)
         RETURNING quote_id`,
        [
          uwYear,
          wizardState.header.experience_source || 'TRIANGLE',
          wizardState.header.renewal_date || null,
          wizardState.header.inception_date || null,
          wizardState.header.contract_description || null,
          userId,
          JSON.stringify({
            source: 'renewal_pack_import',
            source_filename: file.originalname,
            imported_by: userId,
            imported_at: new Date().toISOString(),
            type: extraction.type,
            provider: extraction.provider,
            field_confidence: fieldConfidence,
            warnings: allWarnings,
            unmatched_cresta: unmatchedCresta,
            wizard_state: wizardState,
          }),
        ],
      );
      quoteId = insertRows[0].quote_id;

      // Mirror POST /api/quotes: auto-assign quote_ref = QT-YYYY-NNNN.
      const { rows: seqRows } = await client.query(`SELECT nextval('public.quote_ref_seq') AS n`);
      const qRef = `QT-${uwYear}-${String(seqRows[0].n).padStart(4, '0')}`;
      await client.query(`UPDATE public.quote SET quote_ref=$2 WHERE quote_id=$1`, [quoteId, qRef]);

      await logAudit(client, {
        entityType: 'QUOTE',
        entityId: quoteId,
        eventType: 'renewal_pack_imported',
        actor: actorName,
        payload: {
          quoteId,
          filename: file.originalname,
          type: extraction.type,
          warningCount: allWarnings.length,
        },
      });

      await client.query('COMMIT');
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      logger.error('[renewal-pack-import] DB persist failed', { error: err?.message, filename: file.originalname });
      return res.status(500).json({
        error: `Failed to persist draft quote: ${err?.message || err}`,
        code: 'PERSIST_FAILED',
      });
    } finally {
      client.release();
    }

    logger.info('[renewal-pack-import] success', {
      quoteId,
      filename: file.originalname,
      type: extraction.type,
      warnings: allWarnings.length,
      unmatchedCresta: unmatchedCresta.length,
    });

    return res.status(201).json({
      quoteId,
      type: extraction.type,
      fieldConfidence,
      warnings: allWarnings,
      unmatchedCresta,
    });
  }),
);

export default router;
