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

function isSkippableMigrationError(err) {
  return SKIPPABLE_PG_CODES.has(err?.code);
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

    let appliedCount = 0;
    let skippedCount = 0;

    for (const stmt of stmts) {
      try {
        await pool.query(stmt);
        appliedCount++;
      } catch (err) {
        if (isSkippableMigrationError(err)) {
          skippedCount++;
          if (process.env.NODE_ENV !== 'production') {
            logger.debug('migration stmt skipped', { file, code: err.code, error: err.message.split('\n')[0].slice(0, 120) });
          }
          continue;
        }
        logger.error('migration fatal error', { file, code: err.code, error: err.message.split('\n')[0] });
        throw err;
      }
    }

    // Record as applied so it never runs again
    try {
      await pool.query(`INSERT INTO public._migrations (filename) VALUES ($1) ON CONFLICT DO NOTHING`, [file]);
    } catch (e) {
      logger.warn('migration: could not record in _migrations', { file, error: e.message });
    }

    logger.info('migration completed', { file, applied: appliedCount, skipped: skippedCount });
    results.push({ file, applied: appliedCount, skipped: skippedCount, status: 'ran' });
  }

  return results;
}
