# Database Design Audit

Audit date: 2026-05-01.

## Fresh-Schema Result

The full migration chain was applied from an empty Postgres database
through `server/src/db/migrate.js`.

Post-migration shape:

| Metric | Count |
| --- | ---: |
| Tables | 137 |
| Indexes | 323 |
| Foreign keys | 117 |
| NOT VALID foreign keys | 84 |
| Check constraints | 21 |
| Primary/unique constraints | 190 |

The remaining duplicate-index report has one intentional survivor:
`ref_exchange_rate(currency_code, effective_date)` has both an ascending
unique constraint and a descending lookup index for latest-rate reads.

## Alignment Changes

Migration `072_database_alignment_and_index_cleanup.sql` fixed the
main schema alignment gaps found in the audit:

* `contract_document.contract_id` is now nullable so quote-only document
  uploads match the existing `/api/quotes/:id/documents` route.
* Shared owner tables now enforce one owner for new rows:
  `contract_document`, `contract_large_loss_report`,
  `contract_cat_loss_report`, and `contract_loss_selection_snapshot`.
* Shared quote-owned rows now have FKs to `quote`.
* Contract-owned pricing tables now have cascade FKs to `contract`.
* Every FK has a child-side support index.
* Exact duplicate indexes and duplicate uniqueness constraints were
  removed to reduce write amplification.

Migration `073_pricing_component_persistence_alignment.sql` fixed the
contract pricing persistence gaps surfaced by full save/rehydrate
coverage:

* `pricing_components` now has the route-backed `selected`,
  `underwriter_value`, and `display_order` columns.
* `pricing_component_snapshots.id` now has a default sequence, so
  component snapshots can be created through the API.
* `contract_pricing_outputs.technical_result` is widened to
  `numeric(20,8)` for realistic treaty-sized monetary values.

## Quote/Treaty Duality

Most business entities have paired `contract_*` and `quote_*` tables.
The audit confirmed that the exceptions are intentional or legacy:

| Shared/post-bind table | Why it is not a simple pair |
| --- | --- |
| `contract_document` | Shared document table with either `contract_id` or `quote_id`. |
| `contract_large_loss_report`, `contract_cat_loss_report` | Shared report containers with either `contract_id` or `quote_id`; child loss rows hang from `report_id`. |
| `contract_loss_selection_snapshot` | Shared selected-loss snapshots with either `contract_id` or `quote_id`. |
| `contract_audit_event`, `audit_log`, `offer_approval_event` | Event history can outlive the entity row and is intentionally not fully FK-bound. |
| `contract_terms_snapshot`, `contract_workflow_event` | Post-bind treaty workflow history only. |
| `quote_cedant_exposure` | Quote-specific exposure capture. |

## Constraints To Validate Later

Most retrofitted FKs are `NOT VALID` by design. They protect new writes,
but production should still run orphan checks before validating them
during a quiet maintenance window.

Recommended validation sequence:

1. Restore a production snapshot.
2. Run orphan checks for each `NOT VALID` FK.
3. Clean or archive orphan rows.
4. Run `ALTER TABLE ... VALIDATE CONSTRAINT ...` in batches.
5. Re-run the 10 VU load test against quote, treaty, dashboard, and
   pricing paths.
