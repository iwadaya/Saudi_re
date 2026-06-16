# Architecture: Data Model And Quote/Treaty Duality

Universe 3 is a React/Vite client with an Express API over PostgreSQL.
The product model is deliberately dual-track: a live bound treaty is a
`contract`, while a working/offered version is a `quote`. Most screens
operate on the same business concept in either mode.

## Core Model

The central identity tables are:

| Area | Treaty mode | Quote mode | Notes |
| --- | --- | --- | --- |
| Header | `contract` | `quote` | Cedant, broker, country, treaty type, currency, UW year, status, assignment |
| Proportional details | `contract_prop_details` | `quote_prop_details` | QS/surplus terms, EPI, event limits, brokerage/taxes |
| NP details | `contract_np_details` | `quote_np_details` | XL metadata and terms |
| COBs | `contract_class_of_business` | `quote_class_of_business` | Many-to-many selected classes |
| Triangles | `contract_triangle_cells` | `quote_triangle_cells` | Premium, paid, OS and dev-factor inputs |
| Dev factors | `contract_dev_factor` | `quote_dev_factor` | Underwriter-selected LDF/CDF patterns |
| Pricing yearly | `contract_pricing_yearly` | `quote_pricing_yearly` | Proportional pricing history/projections |
| NP pricing | `contract_np_pricing_*` | `quote_np_pricing_*` | Inputs, layer inputs, outputs |
| CRESTA | `contract_cresta_data` | `quote_cresta_data` | Property aggregate exposure |
| Offer state | `contract_offer` | `quote_offer` | Approval/offer workflow state |
| Documents/loss reports | Shared `contract_*` tables | Shared `contract_*` tables | Owner is exactly one of `contract_id` or `quote_id` |

Reference/display context is shared through cedant/company, broker,
country, treaty type, and currency joins. Server code centralizes those
joins in `server/src/db/contractJoins.js`.

## Quote Versus Treaty

Quotes are pre-bind working records. They can be amended or approved,
and the schema is designed for them to bind into a contract (binding
itself is currently out of scope — see "Quote binding scope" below).
Migration `044_quote_lifecycle.sql` adds the versioning and binding
columns:

| Column | Meaning |
| --- | --- |
| `quote.quote_ref` | Human-readable `QT-YYYY-NNNN` reference |
| `quote.quote_version` | Version number for amendments |
| `quote.quote_version_of` | Original quote for an amendment chain |
| `quote.bound_contract_id` | Contract produced by binding |
| `contract.source_quote_id` | Reverse link from bound contract to quote |

Some tables are shared instead of duplicated: `contract_document`,
`contract_large_loss_report`, `contract_cat_loss_report`, and
`contract_loss_selection_snapshot`. They carry either `contract_id` or
`quote_id`, enforced for new rows by migration
`072_database_alignment_and_index_cleanup.sql`.

### Quote binding scope (intentionally out of scope)

Although the schema carries the binding columns above, quote → contract
binding is **intentionally disabled** in this build: `POST
/api/quotes/:id/bind` returns `410 QUOTE_BIND_DISABLED` (see
`server/src/routes/quoteLifecycle.js`). Quotes run as a standalone
artefact — a SIGNED/bound quote does **not** create a contract and does
**not** contribute to portfolio exposure. Portfolio metrics
(`/api/dashboard/*`) aggregate `public.contract` only; there is no read
path from quotes into accumulation or the dashboard. The disabled
transactional copy is preserved in git history and can be restored when
binding is re-wired, so treat `quote.bound_contract_id` and
`contract.source_quote_id` as forward-looking schema for now.

**Decision (2026-06):** reviewed and kept out of scope. Wiring bound
quotes into portfolio exposure is a deliberate future feature, not a
defect — when it lands it must create/feed a `contract` row so the
existing dashboard aggregation picks it up automatically.

On the client, quote mode is passed as `{ quote: true }`. API methods
then select `/api/quotes/...` paths instead of `/api/treaties/...`.
On the server, `server/src/lib/entityContext.js` resolves the mode once
from the URL/query and exposes `parentTable`, `idColumn`, `subTable()`,
and `npTable()` helpers. New shared routes should use that helper
instead of manually branching on table names.

## Save Pattern

Treaty and quote PUT routes are partial-save safe: only sections present
in `terms` are updated. This is important because wizard screens save
their own slice and must not wipe unrelated sections. Writes that touch
multiple child tables use a transaction, and header updates support
optimistic locking through `If-Unmodified-Since`.

## Pricing Model

Pricing is split between durable relational outputs and JSON/UI state:

| Flow | Main durable outputs | UI/state payloads |
| --- | --- | --- |
| Proportional | `contract_pricing_outputs`, `contract_pricing_yearly`, component snapshots | Screen state in component tables and share grids |
| Non-proportional | `*_np_pricing_inputs`, `*_np_pricing_layer_inputs`, `*_np_pricing_outputs` | Full final-pricing UI state in NP terms JSON |

Shared actuarial primitives live in `shared/pricingMath.js` and are used
by both client and server verification. Client-only display/parsing
helpers should come from `client/src/utils/format.js`.
Migration `073_pricing_component_persistence_alignment.sql` keeps the
route-backed proportional component UI fields and component-snapshot IDs
aligned with this pricing model.

## Guardrails

When adding a new quote/treaty feature:

1. Add both `contract_*` and `quote_*` storage unless the feature is
   explicitly post-bind only.
2. Extend `entityContext()` if routes need dynamic table names.
3. Keep validation schemas in `server/src/validation/` permissive only
   where existing callers require passthrough.
4. Add migration indexes for list/detail access paths before adding a
   screen that queries them repeatedly.
