// server/src/db/seeds/run.js — reference-data seed.
//
//   npm run seed:reference              # from the repo root (or `npm run seed` in server/)
//   npm run seed:reference -- --check   # report row counts only, write nothing
//
// Seeds ONLY lookup / reference data: countries, currencies, brokers,
// reinsurers, cedants (companies), treaty types and classes of business. It
// NEVER writes contracts, quotes, claims or users. Test portfolios live in
// separate, explicit scripts (server/scripts/seedTestTreaties.js,
// seeds/seed_1000_test_contracts.js) that a production deploy must not run.
//
// Idempotent: ensureReferenceData() guards every insert with WHERE NOT EXISTS
// and 002_reference_data.sql upserts on the natural keys (migration 150), so
// it is safe to run on every deploy and against a database that already holds
// live data. The same ensureReferenceData() runs on each app boot; this script
// is the explicit, verifiable deploy-time step, and it additionally applies the
// canonical mirror + GCC market extras in 002_reference_data.sql.
//
// Test portfolios are a different switch entirely: server/scripts/seedOnDeploy.js
// (`npm run seed:deploy`, gated by SEED_ON_DEPLOY) — leave that unset in
// production.
//
// Safety net: the script counts the business tables before and after and
// exits non-zero if any of them changed — a regression here must never be
// silent on a production database.

import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pool, closePools } from '../pool.js';
import { logger } from '../../lib/logger.js';
import { ensureReferenceData } from '../../startup/ensureReferenceData.js';

const seedsDir = dirname(fileURLToPath(import.meta.url));
const SQL_FILES = ['002_reference_data.sql'];
const CHECK_ONLY = process.argv.includes('--check');

const REFERENCE_TABLES = {
  countries: 'country',
  currencies: 'currency',
  brokers: 'brokers',
  reinsurers: 'reinsurers',
  cedants: 'companies',
  treaty_types: 'treaty_type',
  classes_of_business: 'class_of_business',
  roles: 'uw_role',
};

// Must be untouched by this script. Users are listed for visibility only —
// they are owned by the migrations (see deploy/README.md → First login).
const BUSINESS_TABLES = {
  contracts: 'contract',
  quotes: 'quote',
  claims: 'claim',
  users: 'uw_user',
};

async function countRows(tables) {
  const out = {};
  for (const [label, table] of Object.entries(tables)) {
    try {
      const { rows } = await pool.query(`SELECT COUNT(*)::int AS n FROM public.${table}`);
      out[label] = rows[0].n;
    } catch (err) {
      out[label] = err.code === '42P01' ? 'missing' : `error: ${err.message.split('\n')[0]}`;
    }
  }
  return out;
}

function printCounts(title, counts) {
  const width = Math.max(...Object.keys(counts).map((k) => k.length));
  process.stdout.write(`${title}\n`);
  for (const [label, n] of Object.entries(counts)) {
    process.stdout.write(`  ${label.padEnd(width)}  ${n}\n`);
  }
}

(async () => {
  let exitCode = 0;
  try {
    const businessBefore = await countRows(BUSINESS_TABLES);

    if (CHECK_ONLY) {
      printCounts('Reference data (read-only check):', await countRows(REFERENCE_TABLES));
      printCounts('Business data (never written by this script):', businessBefore);
      return;
    }

    logger.info('seed:reference starting');
    await ensureReferenceData();

    for (const file of SQL_FILES) {
      const sql = await readFile(join(seedsDir, file), 'utf8');
      logger.info('seed running', { file });
      await pool.query(sql);
      logger.info('seed complete', { file });
    }

    const businessAfter = await countRows(BUSINESS_TABLES);
    for (const key of Object.keys(BUSINESS_TABLES)) {
      if (businessBefore[key] !== businessAfter[key]) {
        throw new Error(
          `seed:reference changed business table "${key}" (${businessBefore[key]} -> ${businessAfter[key]}). `
          + 'Reference seeding must never touch it — investigate before re-running.',
        );
      }
    }

    printCounts('Reference data after seeding:', await countRows(REFERENCE_TABLES));
    printCounts('Business data (unchanged):', businessAfter);
    logger.info('seed:reference complete');
  } catch (err) {
    logger.error('seed:reference failed', { error: err?.message, stack: err?.stack });
    exitCode = 1;
  } finally {
    await closePools().catch(() => {});
    process.exitCode = exitCode;
  }
})();
