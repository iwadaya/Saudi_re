// Regression coverage for the tx-control filter in the migration
// runner. Eight legacy migration files (001, 002, 003, 004, 012, 013,
// 014, 074) wrap their body in `BEGIN; ... COMMIT;`. The runner already
// opens an outer transaction, so the migration's COMMIT would end the
// runner's tx and the next SAVEPOINT release throws 25P01 — which is
// exactly what integration CI surfaced on a fresh DB. The filter
// strips those statements; this test pins the regex down.

import { describe, it, expect } from 'vitest';
import { isTxControl, stripComments, isSkippableMigrationError } from './runMigrations.js';

describe('isTxControl', () => {
  it.each([
    'BEGIN;',
    'BEGIN',
    'begin;',
    '  BEGIN ;',
    'COMMIT;',
    'COMMIT',
    'commit;',
    'END;',
    'ROLLBACK;',
    'START TRANSACTION;',
    'start transaction;',
    'BEGIN WORK;',
    'COMMIT WORK;',
    'COMMIT TRANSACTION;',
  ])('matches transaction-control statement %j', (stmt) => {
    expect(isTxControl(stmt)).toBe(true);
  });

  it.each([
    'CREATE TABLE foo (id int);',
    'INSERT INTO foo VALUES (1);',
    'BEGIN; SELECT 1;',                          // multiple statements — split should have separated these
    'SELECT * FROM begins;',                     // table named "begins"
    'COMMIT INTO foo VALUES (1);',               // not actually valid SQL, but starts with COMMIT and is not just a tx-control
    "INSERT INTO foo VALUES ('BEGIN');",
    'SAVEPOINT my_sp;',
    'RELEASE SAVEPOINT my_sp;',
    '',
  ])('does NOT match non-tx-control statement %j', (stmt) => {
    expect(isTxControl(stmt)).toBe(false);
  });

  // Migration 004 wraps its trailing COMMIT with a block of `-- ...`
  // line comments. splitStatements keeps the comments in the statement,
  // so the tx-control filter has to strip them first.
  it('matches COMMIT preceded by line comments', () => {
    const stmt = `
-- Uncomment if you want to enable ON CONFLICT upserts on contract_offer:
-- ALTER TABLE public.contract_offer ADD CONSTRAINT contract_offer_contract_id_key UNIQUE (contract_id);

COMMIT;`;
    expect(isTxControl(stmt)).toBe(true);
  });

  it('matches BEGIN preceded by block comments', () => {
    const stmt = `/* migration 004 — fix constraints */\nBEGIN;`;
    expect(isTxControl(stmt)).toBe(true);
  });

  it('stripComments removes line and block comments', () => {
    expect(stripComments('-- leading\nBEGIN;')).toBe('BEGIN;');
    expect(stripComments('/* block */ BEGIN;')).toBe('BEGIN;');
    expect(stripComments('CREATE TABLE foo (id int); -- trailing')).toBe('CREATE TABLE foo (id int);');
  });
});

describe('isSkippableMigrationError — 23505 scoped to seed INSERTs', () => {
  const dup = { code: '23505' };

  it('skips a unique_violation on a seed INSERT (idempotent re-run)', () => {
    expect(isSkippableMigrationError(dup, "INSERT INTO public.country (code) VALUES ('US')")).toBe(true);
    expect(isSkippableMigrationError(dup, '  insert into foo values (1)')).toBe(true);
    expect(isSkippableMigrationError(dup, '-- seed\nINSERT INTO foo VALUES (1)')).toBe(true);
    expect(isSkippableMigrationError(dup, 'WITH x AS (SELECT 1) INSERT INTO foo SELECT * FROM x')).toBe(true);
  });

  it('does NOT skip a unique_violation on a non-INSERT statement (must surface)', () => {
    expect(isSkippableMigrationError(dup, 'ALTER TABLE foo ADD CONSTRAINT u UNIQUE (id)')).toBe(false);
    expect(isSkippableMigrationError(dup, 'CREATE UNIQUE INDEX ix ON foo (id)')).toBe(false);
    expect(isSkippableMigrationError(dup, 'UPDATE foo SET id = 1')).toBe(false);
  });

  it('still skips the pure idempotency codes regardless of statement', () => {
    expect(isSkippableMigrationError({ code: '42P07' }, 'CREATE TABLE foo (id int)')).toBe(true); // duplicate_table
    expect(isSkippableMigrationError({ code: '42701' }, 'ALTER TABLE foo ADD COLUMN id int')).toBe(true); // duplicate_column
  });

  it('never skips a genuine programming error (e.g. undefined_column)', () => {
    expect(isSkippableMigrationError({ code: '42703' }, 'SELECT bogus FROM foo')).toBe(false);
  });
});
