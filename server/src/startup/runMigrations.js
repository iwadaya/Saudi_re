import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { pool } from '../db/pool.js';
import { logger } from '../lib/logger.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const migrationsDir = path.resolve(__dirname, '../db/migrations');

// Errors safe to swallow per-statement: idempotency-related "already exists"
// or "doesn't exist" cases that legitimately re-occur when a migration is
// partially applied or a CREATE / DROP isn't gated with IF [NOT] EXISTS.
//
// Anything else — undefined_column, syntax_error, undefined_function,
// type mismatches, FK / NOT NULL / CHECK violations — is a programming
// error that must surface, not get silently recorded as applied. The
// previous "allow-everything-except-four-codes" approach silently swallowed
// 064's "a.id < b.id" typo (42703 undefined_column) and marked it applied,
// which is what 068_cresta_contract_dedup_fix.sql had to repair.
const SKIPPABLE_PG_CODES = new Set([
  '42P07', // duplicate_table
  '42710', // duplicate_object (constraint, index, trigger, type, ...)
  '42701', // duplicate_column
  '42P06', // duplicate_schema
  '42P03', // duplicate_cursor
  '23505', // unique_violation (idempotent seed inserts)
  '42704', // undefined_object (legacy DROP without IF EXISTS)
  '42P01', // undefined_table (legacy DROP TABLE without IF EXISTS)
]);

// 42P01/42704 are only legitimately idempotent when the statement was trying
// to REMOVE the missing thing — a legacy `DROP ...` / `ALTER ... DROP ...`
// without IF EXISTS. On any other statement kind (UPDATE, CREATE INDEX,
// COMMENT, INSERT..SELECT against a typo'd name, ...) "does not exist" is a
// programming error that must fail the migration, not be recorded as applied
// — the mechanism that let 064's typo slip through and silently dropped
// 012's and 036's intended shapes. Matches:
//   DROP TABLE/VIEW/TRIGGER/FUNCTION/... x
//   ALTER TABLE x DROP CONSTRAINT/COLUMN y   (and ALTER ... ALTER ... DROP
//   DEFAULT / DROP NOT NULL on a missing table — still drop-shaped intent)
const DROP_SHAPED_RE = /^(?:DROP\b|ALTER\b[\s\S]*?\bDROP\b)/i;

export function isSkippableMigrationError(err, stmt = '') {
  const code = err?.code;
  if (!SKIPPABLE_PG_CODES.has(code)) return false;
  // 23505 (unique_violation) is only legitimately idempotent for seed INSERTs
  // re-running against already-seeded data. On any OTHER statement a unique
  // violation is an unexpected data-integrity failure that must surface (and
  // roll the migration back), not be silently recorded as applied.
  if (code === '23505') {
    return /^\s*(?:WITH\b[\s\S]*?\b)?INSERT\b/i.test(stripComments(stmt));
  }
  // 42P01/42704 (undefined table/object): skip only for DROP-shaped
  // statements — see DROP_SHAPED_RE above.
  if (code === '42P01' || code === '42704') {
    return DROP_SHAPED_RE.test(stripComments(stmt));
  }
  return true;
}

function splitStatements(sql) {
  const stmts = [];
  let current = '';
  let inDollarQuote = false;
  let dollarTag = '';
  let inLineComment = false;
  let inBlockComment = false;
  let inStringLiteral = false;
  let i = 0;

  while (i < sql.length) {
    const ch = sql[i];
    const next = sql[i + 1];

    // Inside a dollar-quoted block: only the matching tag ends it.
    // Comments/strings inside are just data and must not be parsed.
    if (inDollarQuote) {
      if (sql.slice(i).startsWith(dollarTag)) {
        current += dollarTag;
        i += dollarTag.length;
        inDollarQuote = false;
        dollarTag = '';
        continue;
      }
      current += ch;
      i++;
      continue;
    }

    // Inside a line comment: skip until newline (consume the newline).
    if (inLineComment) {
      current += ch;
      if (ch === '\n') inLineComment = false;
      i++;
      continue;
    }

    // Inside a block comment: skip until closing */.
    if (inBlockComment) {
      if (ch === '*' && next === '/') {
        current += '*/';
        i += 2;
        inBlockComment = false;
        continue;
      }
      current += ch;
      i++;
      continue;
    }

    // Inside a string literal: skip until closing ', handling '' as escape.
    if (inStringLiteral) {
      if (ch === "'" && next === "'") {
        current += "''";
        i += 2;
        continue;
      }
      if (ch === "'") {
        current += "'";
        i++;
        inStringLiteral = false;
        continue;
      }
      current += ch;
      i++;
      continue;
    }

    // Default state: detect start of any special region.
    const dollarMatch = sql.slice(i).match(/^(\$[A-Za-z0-9_]*\$)/);
    if (dollarMatch) {
      dollarTag = dollarMatch[1];
      inDollarQuote = true;
      current += dollarTag;
      i += dollarTag.length;
      continue;
    }
    if (ch === '-' && next === '-') {
      inLineComment = true;
      current += '--';
      i += 2;
      continue;
    }
    if (ch === '/' && next === '*') {
      inBlockComment = true;
      current += '/*';
      i += 2;
      continue;
    }
    if (ch === "'") {
      inStringLiteral = true;
      current += "'";
      i++;
      continue;
    }
    if (ch === ';') {
      const trimmed = current.trim();
      if (trimmed) stmts.push(trimmed);
      current = '';
      i++;
      continue;
    }

    current += ch;
    i++;
  }

  const trimmed = current.trim();
  if (trimmed) stmts.push(trimmed);

  return stmts;
}

// Ensure the migrations tracking table exists
async function ensureMigrationsTable() {
  await pool.query(`
    CREATE TABLE IF NOT EXISTS public._migrations (
      filename   TEXT PRIMARY KEY,
      applied_at TIMESTAMPTZ DEFAULT now() NOT NULL
    )
  `);
}

// Return set of already-applied migration filenames
async function getAppliedMigrations() {
  try {
    const { rows } = await pool.query(`SELECT filename FROM public._migrations`);
    return new Set(rows.map(r => r.filename));
  } catch {
    return new Set();
  }
}

// Postgres advisory lock id — arbitrary 64-bit int, unique to this app.
// When cluster-mode spins up N workers, every worker runs bootstrap()
// in parallel. Without a lock they'd all read _migrations, all decide
// the same pending file needs to run, and race each other — usually
// benign (CREATE IF NOT EXISTS) but occasionally catastrophic (double
// ALTER TABLE or duplicate seed inserts). The lock serialises the
// whole migration run to one worker; the rest block briefly, then
// find everything already applied and skip.
const MIGRATION_LOCK_ID = 8675309; // "universe3 migrations"

export async function runMigrations() {
  if (!fs.existsSync(migrationsDir)) return [];

  // Block until we hold the lock. Session-scoped — released on
  // disconnect or explicit unlock. Keep the connection alive until we
  // unlock, otherwise the lock drops early.
  const lockClient = await pool.connect();
  try {
    await lockClient.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    logger.info('migration lock acquired', { lockId: MIGRATION_LOCK_ID });
    return await runMigrationsLocked();
  } finally {
    try {
      await lockClient.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    } catch (e) {
      logger.warn('migration unlock failed (lock will drop on disconnect)', { error: e.message });
    }
    lockClient.release();
  }
}

// Return { applied, pending } so callers (CLI status reporter, ops
// scripts) can render the state without running anything.
export async function migrationStatus() {
  if (!fs.existsSync(migrationsDir)) return { applied: [], pending: [] };
  await ensureMigrationsTable();
  const appliedSet = await getAppliedMigrations();
  const files = fs.readdirSync(migrationsDir).filter((f) => f.endsWith('.sql')).sort();
  const applied = files.filter((f) => appliedSet.has(f));
  const pending = files.filter((f) => !appliedSet.has(f));
  return { applied, pending };
}

async function runMigrationsLocked() {
  await ensureMigrationsTable();
  const applied = await getAppliedMigrations();

  const files = fs
    .readdirSync(migrationsDir)
    .filter((f) => f.endsWith('.sql'))
    .sort();

  const results = [];

  for (const file of files) {
    // Skip migrations already applied — this prevents DROP TABLE from re-running
    if (applied.has(file)) {
      logger.info('migration already applied, skipping', { file });
      results.push({ file, applied: 0, skipped: 0, status: 'skipped' });
      continue;
    }

    const sql   = fs.readFileSync(path.join(migrationsDir, file), 'utf-8');
    const stmts = splitStatements(sql);

    const result = await runOneMigration(file, stmts);
    logger.info('migration completed', { file, applied: result.applied, skipped: result.skipped });
    results.push(result);
  }

  return results;
}

// Run a single migration atomically: every statement happens inside one
// transaction, and the _migrations row is inserted in the same
// transaction. A non-skippable failure ROLLBACKs both the schema
// changes and the applied-marker, so a half-applied migration never
// gets recorded. Skippable errors (duplicate table/column/etc.) are
// trapped per-statement via SAVEPOINT so they don't poison the outer
// transaction — they preserve the idempotent re-run behaviour the
// original loop relied on.
// Eight legacy migration files (001, 002, 003, 004, 012, 013, 014, 074)
// wrap their body in a `BEGIN; ... COMMIT;` of their own. The runner
// already opens an outer transaction around every migration, so the
// migration's own COMMIT would end the runner's tx — making the
// subsequent `RELEASE SAVEPOINT migration_stmt` throw 25P01 (which
// integration CI surfaced for the first time on a fresh DB). Strip
// these tx-control statements at run time so we don't have to edit
// the eight files (which would also re-apply on existing prod DBs).
//
// `splitStatements` preserves comments inside each statement string, so
// a `COMMIT` that follows a block of `-- ...` line comments arrives
// with the comments still attached. Strip comments before testing the
// tx-control shape so we don't miss those.
const LINE_COMMENT_RE = /--[^\n]*\n?/g;
const BLOCK_COMMENT_RE = /\/\*[\s\S]*?\*\//g;
const TX_CONTROL_RE = /^\s*(?:BEGIN|START\s+TRANSACTION|COMMIT|END|ROLLBACK)\s*(?:WORK|TRANSACTION)?\s*;?\s*$/i;

export function stripComments(stmt) {
  return String(stmt || '')
    .replace(BLOCK_COMMENT_RE, '')
    .replace(LINE_COMMENT_RE, '\n')
    .trim();
}

export function isTxControl(stmt) {
  return TX_CONTROL_RE.test(stripComments(stmt));
}

async function runOneMigration(file, stmts) {
  const client = await pool.connect();
  let appliedCount = 0;
  let skippedCount = 0;
  try {
    await client.query('BEGIN');
    for (const stmt of stmts) {
      if (isTxControl(stmt)) {
        skippedCount++;
        continue;
      }
      await client.query('SAVEPOINT migration_stmt');
      try {
        await client.query(stmt);
        await client.query('RELEASE SAVEPOINT migration_stmt');
        appliedCount++;
      } catch (err) {
        if (isSkippableMigrationError(err, stmt)) {
          await client.query('ROLLBACK TO SAVEPOINT migration_stmt');
          await client.query('RELEASE SAVEPOINT migration_stmt');
          skippedCount++;
          // Warn (all environments): a skipped statement means the migration's
          // literal text did NOT apply — usually a benign idempotent re-run,
          // but it must leave a signal (see the 064 incident above).
          logger.warn('migration stmt skipped', { file, code: err.code, error: err.message.split('\n')[0].slice(0, 120) });
          continue;
        }
        logger.error('migration fatal error', { file, code: err.code, error: err.message.split('\n')[0] });
        throw err;
      }
    }
    await client.query(
      `INSERT INTO public._migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`,
      [file],
    );
    await client.query('COMMIT');
    return { file, applied: appliedCount, skipped: skippedCount, status: 'ran' };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}
