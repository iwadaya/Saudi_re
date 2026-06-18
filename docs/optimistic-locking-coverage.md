# Optimistic Locking Coverage

Audit date: 2026-05-01

Scope: every server `PUT`/`POST` that calls `assertEntityUnchanged`.

| Endpoint | Server guard | Client call site | Handles 409? |
| --- | --- | --- | --- |
| `PUT /api/treaties/:id` | `server/src/routes/treaties.js:142-172` | `client/src/screens/proportional/treaty_detail/PropTreatyDetail.jsx:558-586` | yes |
| `PUT /api/treaties/:id` | `server/src/routes/treaties.js:142-172` | `client/src/screens/non_proportional/treaty_detail/NpTreatyDetail.jsx:340-406` | yes |
| `PUT /api/treaties/:id` | `server/src/routes/treaties.js:142-172` | `client/src/screens/proportional/event_loss_tables/PropEventLossTables.jsx:49-73` | yes |
| `PUT /api/quotes/:id` | `server/src/routes/quotes.js:191-217` | `client/src/screens/proportional/treaty_detail/PropTreatyDetail.jsx:554-586` when `quoteMode` is true | yes |
| `PUT /api/quotes/:id` | `server/src/routes/quotes.js:191-217` | `client/src/screens/non_proportional/treaty_detail/NpTreatyDetail.jsx:309-406` when `quoteMode` is true | yes |

No `POST` endpoint currently calls `assertEntityUnchanged`.

### Subresource coverage (added 2026-06-18)

High-value quote subresource saves now run the **opt-in** parent stale check
(`assertParentEntityUnchanged`) **inside their transaction** and bump the parent
quote's `updated_at` via `touchParentEntity`, returning it as `updated_at` so the
client can carry a fresh token. The guard is dormant unless the client sends
`If-Unmodified-Since`, so existing callers are unaffected; when sent, a
concurrent parent edit yields `409 STALE_WRITE` (or honours the `*` override).

| Endpoint | Server guard |
| --- | --- |
| `PUT /api/quotes/:id/np-pricing`   | `quotes.js` (pre-existing) |
| `PUT /api/quotes/:id` NP structure | `quotes.js` (pre-existing) |
| `PUT /api/quotes/:id/large-losses`    | `quotes.js` — assert + touch in txn |
| `PUT /api/quotes/:id/cat-losses`      | `quotes.js` — assert + touch in txn |
| `PUT /api/quotes/:id/pricing-outputs` | `quotes.js` — wrapped in txn; assert + touch |
| `PUT /api/quotes/:id/pricing-yearly`  | `quotes.js` — assert + touch in txn |

Covered by `server/tests/integration/quoteSubresourceLocking.integration.test.js`
(opt-in no-op, 409 on a stale token, `*` override, fresh-token save).

Remaining quote subresources (`risk-profiles`, `claims-profiles`, `cresta`,
`cobs`, `dev-factors`, `loss-selection/snapshot`, `np/egnpi-year`) and the treaty
twins are lower-frequency edits and can adopt the same pattern incrementally.

## Handling Contract

- `api.saveContract` accepts `opts.ifUnmodifiedSince` and sends it as `If-Unmodified-Since`.
- Normal saves send the `updated_at` value loaded from `GET /api/treaties/:id` or `GET /api/quotes/:id`.
- `handleStaleWrite(error, { entityType, onRefresh, onOverwrite })` handles `409 STALE_WRITE` by showing the explicit modal. The refresh path calls `onRefresh`; the overwrite path calls `onOverwrite`.
- The overwrite path sends `If-Unmodified-Since: *`. The server treats this as an explicit user override, allows the save, and records `STALE_WRITE_OVERRIDE`.
- `PUT /api/treaties/:id` and `PUT /api/quotes/:id` return the new `updated_at`, and the wired screens store it for the next optimistic-lock token.

## Audit Event

`STALE_WRITE_OVERRIDE` records:

- the user who chose the overwrite (`actor` and `payload.overwrittenBy`)
- the overwritten entity timestamp (`payload.overwrittenUpdatedAt`)
- the previous audit actor/event if available (`payload.previousActor`, `payload.previousEventType`, `payload.previousEventAt`)
- the explicit override marker (`payload.overrideHeader = "If-Unmodified-Since: *"`)

This means the compliance trail captures that user X knowingly overwrote the most recently known save by user Y when user Y is available from audit history.
