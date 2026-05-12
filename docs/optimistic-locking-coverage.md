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
