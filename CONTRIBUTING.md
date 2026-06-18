# Contributing

Universe 3 is a monorepo with two workspaces: `client/` (React + Vite) and
`server/` (Express + Postgres). The root `package.json` orchestrates both.

## Prerequisites

- Node ≥ 20.18.0 (`.nvmrc`)
- Postgres 14+ accessible via `DATABASE_URL`

## Daily commands

```bash
npm run install:all   # install root + client + server deps
npm run dev           # vite + express in parallel (3000 + 4000)
npm run build         # production client bundle into client/dist
npm start             # serve client/dist via the express server
```

## Quality gates

| Command | What it does |
|---|---|
| `npm run lint`        | ESLint on the whole tree, fails on errors only |
| `npm run lint:fix`    | Auto-fix the easy ones |
| `npm test`            | Both vitest suites (server + client) |
| `npm run test:server` | Server suite only (DB integration tests skip unless `TEST_WITH_DB=1`) |
| `npm run test:client` | Client suite only — **build the client first** (see below) |
| `npm run test:watch`  | Server suite in watch mode |
| `scripts/test-db.sh`  | Stand up a local Postgres test DB, migrate, and run the server suite with `TEST_WITH_DB=1` |
| `npm run verify`      | lint + typecheck + budget + server tests + build + client coverage — what CI runs |

> `npm run verify` runs the **default** server suite, which skips the DB
> integration tests. Run `scripts/test-db.sh` (or the manual steps under
> _Database integration tests_ below) separately to exercise them — CI runs
> them in a dedicated `integration` job against a `postgres:16` service.

## Where things live

```
client/
  src/
    api.js                    central HTTP client (uses utils/httpClient)
    components/               cross-screen UI (Topbar, Toast, ThemeSwitcher, ...)
    hooks/                    shared React hooks (useScreenSave, useToast, ...)
    screens/                  one folder per workflow tier
    styles/                   token-driven CSS (tokens.css → themes.css → numbers.css)
    utils/                    pure, testable helpers (theme, auth, format, npPricingEngine)
    types/                    JSDoc typedefs surfaced to IDEs via jsconfig.json
server/
  src/
    app.js                    express composition root
    db/                       pool, optimistic locking, partial-update helper, migrations
    lib/                      logger, validate (zod), entityContext
    middleware/               requestId, requestContext, requestTimeout, httpCache, errorHandler
    modules/pricing/          repository + controller pattern (the new layout we're growing toward)
    routes/                   one file per HTTP feature
    services/                 audit, approvals, assignments
    startup/                  bootstrap, gracefulShutdown, runMigrations, ensureReferenceData
    types/                    JSDoc typedefs for server-side domain
    validation/               zod schemas — composed of common.js primitives
```

## Conventions

### Code style
- 2-space indent and LF line endings (enforced by `.editorconfig`); single quotes and trailing commas by convention.
- Prefer named exports for utilities; default exports for React components.
- Keep React components small; if a screen exceeds ~600 lines, split by concern (see `final_pricing/` for the pattern).

### State + saves
- Wizard screens use `useScreenSave` (`client/src/hooks/useScreenSave.js`) — handles load/dirty/save/skip.
- Save handlers must return `true` on success, `false` on failure. WizardLayout uses the bool to gate navigation.
- Mutations use the centralized `request()` in `client/src/api.js`. POST/PUT/DELETE do NOT auto-retry; opt in via `retry: { methods: new Set(['POST']) }` only when the operation is genuinely idempotent.

### Server routes
- New route files live in `server/src/routes/`. Add them to `registerApiRoutes.js`.
- Validate request bodies with `validateBody(schema)` from `server/src/lib/validate.js`. Schemas live under `server/src/validation/` and compose primitives from `validation/common.js`.
- Resolve quote-vs-treaty mode with `entityContext(req)` from `server/src/lib/entityContext.js` instead of branching inline.
- Build the standard FK joins with `contractContextJoins(alias)` from `server/src/db/contractJoins.js`.
- Patch updates with `buildPartialUpdate()` from `server/src/db/partialUpdate.js` — it enforces the column allow-list and translates absent vs explicit-null correctly.

### Database
- Schema changes go in `server/src/db/migrations/NNN_description.sql`. They run automatically on boot (`RUN_MIGRATIONS_ON_BOOT=true`, on by default).
- Use `IF NOT EXISTS` and idempotent statements where possible — migrations re-run is safe.
- Reference data seeds live in `server/src/startup/ensureReferenceData.js`.

### Tests
- Unit tests live next to the code as `*.test.js` (or `*.test.jsx` for components).
- Server smoke tests are in `server/tests/` — they catch import-time errors across every route module.
- Use Vitest's `describe`/`it`/`expect`/`vi`. Don't add jest.
- Pure helpers should have golden-file tests with hand-computed expected values.
- Components that own form state should be tested via `@testing-library/react` for accessibility (roles + labels) more than for visual regression.

#### Database integration tests
Integration tests that hit a real Postgres live in `server/tests/integration/*.integration.test.js`.
They are gated by `TEST_WITH_DB=1` (via `shouldSkipDb` in `helpers.js`) so the
default `npm test` stays zero-infra — without the flag they **skip**, they do not
fail. To run them:

```bash
# One command — creates the DB if needed, migrates, runs the suite:
scripts/test-db.sh

# …or manually, against any disposable Postgres:
createdb reinsurance_tool_test
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/reinsurance_tool_test \
  npm run migrate --prefix server
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/reinsurance_tool_test \
  TEST_WITH_DB=1 npm run test:server
```

New integration tests should: gate with `describe.skipIf(shouldSkipDb)`, seed
their own FK targets with `seedRefs()` from `helpers.js` (each call seeds fresh
uniquely-named rows so parallel files never collide), boot the app with
`bootApp()`, and `closePools()` in the last file's `afterAll`. Prefer asserting
through the HTTP routes (round-trip a PUT then a GET) over poking tables directly.

#### Build the client before running client tests
`npm run test:client` includes `bundleBudget.test.js`, which asserts on the real
`client/dist` bundle and **fails (not skips)** when `dist/` is absent. Always
`npm run build --prefix client` first (this is exactly what `npm run verify` and
the CI `lint + unit` job do).

### Logging
- Server: import `logger` from `server/src/lib/logger.js`. Don't `console.log` in production code (lint warns).
- Client: in production builds, `console.log/info/debug` are muted (see `main.jsx`); errors and warnings still print.

### Themes + UI
- Colours flow from `client/src/styles/tokens.css` → `themes.css` (5 themes). Use `var(--accent)`, `var(--text-strong)`, etc. — avoid hardcoding hex.
- Use `rgba(var(--accent-rgb), .XX)` for alpha-blended accent colours.
- Numeric tables follow the dev-factors look — see `client/src/styles/numbers.css`.

## Pull request checklist

- [ ] `npm run verify` passes locally
- [ ] New behaviour has at least one test
- [ ] No new `console.log` in committed code (server routes use the logger)
- [ ] Migrations are idempotent
- [ ] Bumps to `--app-max-content` or theme tokens are intentional and tested at common widths
