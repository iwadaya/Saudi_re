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
