// server/vitest.config.js — Node-side unit + integration tests.
// Pure-logic tests live next to the code as *.test.js files.
// Integration tests that hit the DB live in tests/integration/*.test.js
// and are skipped by default — run them with DATABASE_URL pointed at a
// disposable test DB:
//   DATABASE_URL=postgres://... TEST_WITH_DB=1 npm run test:server
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    root: 'server',
    environment: 'node',
    globals: true,
    // Dev/test convenience: lets header-based (x-user-*) fixtures authenticate.
    // Production never sets this — identity must come from a verified token.
    env: { ALLOW_DEMO_AUTH: 'true' },
    // Per-test process.env snapshot/restore so env-mutating specs are hermetic
    // and the suite is order-independent by construction (not just because of the
    // runner's default isolation). Keeps the DEFAULT parallel run green with no
    // serialization and no special flags.
    setupFiles: ['./tests/setup/env-isolation.js'],
    include: [
      'src/**/*.test.js',
      'tests/**/*.test.js',
      'tests/**/*.integration.test.js',
      '../shared/**/*.test.js',
    ],
    // Unit tests only by default. Integration tests read env flags
    // to decide whether to boot a DB, spin up an app, etc.
    testTimeout: 10_000,
    hookTimeout: 10_000,
    coverage: {
      provider: 'v8',
      include: ['src/**/*.js'],
      exclude: [
        'src/**/*.test.js',
        'src/db/migrations/**',
        'src/db/seeds/**',
        'src/index.js',            // tiny bootstrap wrapper
        'src/types/**',            // JSDoc only, no runtime
      ],
      reporter: ['text', 'html'],
      // Coverage ratchets (P1-validation). Enforced by `npm run test:server:coverage`
      // — which MUST run with TEST_WITH_DB=1 so the integration suite executes and
      // these DB-backed paths are actually exercised (the CI `integration` job does
      // this). A bare `npm run test:server` does not compute coverage, so unit-only
      // runs are unaffected.
      //
      // Floors sit a few points BELOW current coverage so they catch regressions
      // without being brittle. The four named areas (auth / workflow / pricing /
      // documents) get dedicated globs on top of the global floor; raise these
      // numbers as coverage improves — never lower them to make a red gate pass.
      thresholds: {
        // Whole-server floor (current ≈ 65/55/62/67).
        statements: 62,
        branches: 52,
        functions: 58,
        lines: 64,

        // auth — token/cookie/CSRF verification + the request-context identity load.
        '**/{requestContext,authToken,authCookies,csrf}.js': {
          statements: 78, branches: 74, functions: 95, lines: 90,
        },
        // workflow — the approval engine + quote workflow/bind lifecycle.
        '**/{workflow,approvals,quoteWorkflow,quoteBind}.js': {
          statements: 64, branches: 52, functions: 67, lines: 67,
        },
        // pricing — the server-side NP pricing authority (drift verifier).
        '**/pricingVerifier.js': {
          statements: 90, branches: 82, functions: 95, lines: 95,
        },
        // documents — upload storage + the document/entity read-access guard.
        '**/{uploadStorage,permissions}.js': {
          statements: 85, branches: 77, functions: 95, lines: 92,
        },
      },
    },
  },
});
