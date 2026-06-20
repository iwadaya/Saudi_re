// server/scripts/audit-public-documents.js
//
// Report-only audit of PUBLICLY-delivered document assets (prior exposure).
//
// Background:
//   Before P0-3, lib/uploadStorage.js uploaded Cloudinary assets with
//   access_mode:'public' / type:'upload' and stored the permanent secure_url on
//   the document row. Those URLs are world-readable forever — anyone who ever
//   saw one keeps access regardless of the in-app ACL. New uploads are now
//   'authenticated' (private, served via short-lived signed URLs), but assets
//   uploaded BEFORE the fix remain public.
//
// What this script does:
//   Lists every contract_document whose storage_path is a remote Cloudinary URL
//   using public 'upload' delivery, so prior exposure can be assessed and
//   remediated deliberately. It is STRICTLY report-only: it never mutates the
//   database and never touches stored assets — there is no --apply mode. Mass
//   re-delivery of existing assets is a deliberate, out-of-band decision.
//
// Usage: node scripts/audit-public-documents.js   (or: npm run audit:public-docs)

import { pool, closePools } from '../src/db/pool.js';
import { logger } from '../src/lib/logger.js';

async function main() {
  const { rows } = await pool.query(
    `SELECT document_id, contract_id, quote_id, file_name, storage_path, uploaded_at
       FROM public.contract_document
      WHERE storage_path ~ '^https?://'
        AND storage_path LIKE '%/upload/%'
        AND storage_path NOT LIKE '%/authenticated/%'
        AND storage_path NOT LIKE '%/private/%'
      ORDER BY uploaded_at NULLS LAST`,
  );

  console.log('[audit-public-docs] REPORT-ONLY — no database or storage changes are made.');
  console.log(`[audit-public-docs] public-delivery document assets found: ${rows.length}`);
  for (const r of rows) {
    const owner = r.contract_id
      ? `contract ${r.contract_id}`
      : (r.quote_id ? `quote ${r.quote_id}` : 'ORPHAN');
    console.log(`  - ${r.document_id} (${owner}) ${r.file_name || ''} :: ${r.storage_path}`);
  }
  if (rows.length) {
    console.log(`\n[audit-public-docs] ${rows.length} asset(s) use public 'upload' delivery and remain world-readable.`);
    console.log('[audit-public-docs] Remediate deliberately (e.g. migrate delivery type to authenticated or re-upload);');
    console.log('[audit-public-docs] this script intentionally does NOT mutate anything.');
  } else {
    console.log('[audit-public-docs] No public-delivery assets found.');
  }
  return rows.length;
}

main()
  .then((count) => { process.exitCode = 0; void count; })
  .catch((err) => {
    logger.error('[audit-public-docs] crashed', { error: err?.message, stack: err?.stack });
    process.exitCode = 1;
  })
  .finally(() => closePools().catch(() => {}));
