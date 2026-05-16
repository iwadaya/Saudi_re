// Regression coverage for the tx-control filter in the migration
// runner. Eight legacy migration files (001, 002, 003, 004, 012, 013,
// 014, 074) wrap their body in `BEGIN; ... COMMIT;`. The runner already
// opens an outer transaction, so the migration's COMMIT would end the
// runner's tx and the next SAVEPOINT release throws 25P01 — which is
// exactly what integration CI surfaced on a fresh DB. The filter
// strips those statements; this test pins the regex down.

import { describe, it, expect } from 'vitest';
import { isTxControl } from './runMigrations.js';

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
});
