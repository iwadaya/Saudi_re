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
    // ── Serialized execution (TEMPORARY — keep local and CI identical) ───────
    // Run SINGLE-WORKER, one file at a time. Equivalent to the CLI flags
    // `--no-file-parallelism --maxWorkers=1`. WHY: several specs boot a real
    // HTTP server and/or mutate process.env (NODE_ENV, ALLOW_DEMO_AUTH,
    // ALLOW_OPEN_REGISTRATION, PRICING_STRICT, AUTH_JWT_SECRET, …). Under the
    // default file-parallel fork pool vitest reuses a few worker processes
    // across files, and process.env is process-global (NOT reset by module
    // isolation), so those mutations — plus HTTP/timing contention — leak
    // between files depending on non-deterministic file→worker scheduling: the
    // suite is green when serialized but intermittently RED in parallel (and in
    // CI). Serializing makes the gate deterministic so `npm run verify` and CI
    // (both run `npm run test:server`) behave identically.
    //
    // TODO: restore parallelism once every server-booting / env-mutating spec is
    // fully isolated (own ephemeral port + store; process.env saved and restored
    // per file) and the full PARALLEL suite is green 3× locally and in CI.
    fileParallelism: false,
    maxWorkers: 1,
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
    },
  },
});
