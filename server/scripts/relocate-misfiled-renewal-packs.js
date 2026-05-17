// One-off migration for renewal_pack documents that ended up on the
// wrong owner. Background:
//
//   PropDocuments used to hardcode quoteMode=false, which routed every
//   prop-side upload through /api/treaties/:id/documents and set
//   contract_document.contract_id. If the underwriter was actually
//   working on a quote derived from that contract (quote.parent_contract_id
//   = contract_id), the renewal-pack importer — which only knows how
//   to read from quote_id — couldn't find the pack.
//
// What this script does:
//   1. Find every renewal_pack document attached to a contract that
//      has exactly one corresponding active quote (parent_contract_id
//      = contract_id, uw_status NOT IN ('SIGNED','NTU','DECLINED')).
//   2. Move the document to that quote by swapping contract_id → NULL
//      and setting quote_id. The contract_document CHECK constraint
//      (num_nonnulls(contract_id, quote_id) = 1) makes this an atomic
//      hand-off — either both columns flip or neither does.
//   3. Skip ambiguous rows (no active quote, multiple active quotes,
//      or both columns somehow already populated) and report them.
//
// Dry-run by default. Pass --apply to actually move rows.
//
// The reverse direction (quote → contract) is intentionally NOT
// handled here. We don't currently have a real-world case where a
// renewal pack uploaded to a quote should be moved back to the parent
// contract — quotes own renewal_packs in the new model, and the
// underwriter's editing entity is the source of truth. If that case
// arises, add a second pass to this script with the same dry-run /
// --apply ergonomics.

import { pool, closePools } from '../src/db/pool.js';
import { logger } from '../src/lib/logger.js';

const APPLY = process.argv.includes('--apply');

// Quote statuses that mean "this quote is still being worked on, so
// renewal packs uploaded against its parent contract probably belong
// to it." Anything terminal (SIGNED / NTU / DECLINED) is treated as
// not-active — we don't want to silently relocate a pack to a quote
// the underwriter has already moved past.
const ACTIVE_QUOTE_STATUSES = ['DRAFT', 'AWAITING_APPROVAL', 'WAITING_APPROVAL', 'AWAITING_SIGNED_LINE', 'APPROVED'];

async function findCandidates(client) {
  // Pull every renewal-pack document attached to a contract along with
  // its corresponding active quotes (linked via parent_contract_id).
  // doc_type lands in the DB as either 'Renewal Pack' (display case,
  // from the upload form) or 'renewal_pack' (snake case, from the
  // import API normaliser). Folding case + whitespace at the SQL level
  // catches both without pulling unrelated docs into memory.
  const { rows } = await client.query(
    `
    SELECT
      d.document_id,
      d.contract_id,
      d.quote_id,
      d.file_name,
      d.doc_type,
      d.uploaded_at,
      COALESCE(
        (
          SELECT json_agg(json_build_object(
            'quote_id', q.quote_id,
            'uw_status', q.uw_status,
            'status',    q.status,
            'uw_year',   q.uw_year
          ) ORDER BY q.created_at DESC)
            FROM public.quote q
           WHERE q.parent_contract_id = d.contract_id
             AND COALESCE(q.uw_status, q.status) = ANY($1::text[])
        ),
        '[]'::json
      ) AS active_quotes
    FROM public.contract_document d
    WHERE d.contract_id IS NOT NULL
      AND d.quote_id    IS NULL
      AND replace(lower(d.doc_type), ' ', '_') = 'renewal_pack'
    ORDER BY d.uploaded_at DESC
    `,
    [ACTIVE_QUOTE_STATUSES],
  );

  return rows.map((r) => ({
    documentId: r.document_id,
    contractId: r.contract_id,
    filename: r.file_name,
    uploadedAt: r.uploaded_at,
    activeQuotes: Array.isArray(r.active_quotes) ? r.active_quotes : [],
  }));
}

function classify(candidate) {
  if (candidate.activeQuotes.length === 0) {
    return { action: 'skip', reason: 'no active quote linked to this contract' };
  }
  if (candidate.activeQuotes.length > 1) {
    return { action: 'skip', reason: `ambiguous — ${candidate.activeQuotes.length} active quotes` };
  }
  return { action: 'move', targetQuoteId: candidate.activeQuotes[0].quote_id };
}

async function applyMove(client, documentId, targetQuoteId) {
  // The CHECK constraint requires exactly one of (contract_id, quote_id)
  // — a single UPDATE that swaps both columns satisfies it atomically.
  // The WHERE clause re-asserts the pre-move state so a concurrent edit
  // (eg. a second relocate run) can't double-move a row.
  const { rowCount } = await client.query(
    `UPDATE public.contract_document
        SET contract_id = NULL,
            quote_id    = $2
      WHERE document_id = $1
        AND contract_id IS NOT NULL
        AND quote_id IS NULL`,
    [documentId, targetQuoteId],
  );
  return rowCount === 1;
}

async function main() {
  const summary = { scanned: 0, moved: 0, skipped: 0, errors: 0 };
  const skips = [];
  const moves = [];

  const client = await pool.connect();
  try {
    const candidates = await findCandidates(client);
    summary.scanned = candidates.length;

    for (const candidate of candidates) {
      const decision = classify(candidate);
      const row = {
        documentId: candidate.documentId,
        filename: candidate.filename,
        contractId: candidate.contractId,
        uploadedAt: candidate.uploadedAt,
      };
      if (decision.action === 'skip') {
        summary.skipped += 1;
        skips.push({ ...row, reason: decision.reason });
        continue;
      }
      // Action = move.
      if (!APPLY) {
        summary.moved += 1; // counted as "would-move" in dry run
        moves.push({ ...row, targetQuoteId: decision.targetQuoteId, applied: false });
        continue;
      }
      try {
        const ok = await applyMove(client, candidate.documentId, decision.targetQuoteId);
        if (ok) {
          summary.moved += 1;
          moves.push({ ...row, targetQuoteId: decision.targetQuoteId, applied: true });
        } else {
          summary.skipped += 1;
          skips.push({ ...row, reason: 'row state changed under us (already moved?)' });
        }
      } catch (err) {
        summary.errors += 1;
        logger.error('[relocate-misfiled-renewal-packs] move failed', {
          documentId: candidate.documentId,
          targetQuoteId: decision.targetQuoteId,
          error: err?.message,
        });
      }
    }
  } finally {
    client.release();
  }

  const verb = APPLY ? 'moved' : 'would move';
  console.log(`[relocate-misfiled-renewal-packs] mode: ${APPLY ? 'APPLY' : 'DRY-RUN'}`);
  console.log(`[relocate-misfiled-renewal-packs] scanned: ${summary.scanned}`);
  console.log(`[relocate-misfiled-renewal-packs] ${verb}: ${summary.moved}`);
  console.log(`[relocate-misfiled-renewal-packs] skipped: ${summary.skipped}`);
  if (summary.errors) console.log(`[relocate-misfiled-renewal-packs] errors: ${summary.errors}`);

  if (moves.length) {
    console.log('\n--- moves ---');
    for (const m of moves) {
      console.log(`  ${m.applied ? 'MOVED   ' : 'WOULD MOVE'}  ${m.documentId}  ${m.filename}  contract=${m.contractId} → quote=${m.targetQuoteId}`);
    }
  }
  if (skips.length) {
    console.log('\n--- skips ---');
    for (const s of skips) {
      console.log(`  SKIP  ${s.documentId}  ${s.filename}  contract=${s.contractId}  reason=${s.reason}`);
    }
  }
  if (!APPLY && summary.moved > 0) {
    console.log('\nRe-run with --apply to perform the moves.');
  }

  return summary.errors === 0;
}

main()
  .then((ok) => { process.exitCode = ok ? 0 : 1; })
  .catch((err) => {
    logger.error('[relocate-misfiled-renewal-packs] crashed', { error: err?.message, stack: err?.stack });
    process.exitCode = 1;
  })
  .finally(() => closePools().catch(() => {}));
