-- server/src/db/maintenance/fk_validation_emit.sql
--
-- READ-ONLY GENERATOR for the NOT VALID foreign-key validation runbook (P0-7).
--
-- This file runs ONLY SELECTs. It EMITS the SQL the operator will review and run
-- by hand, in staging, against a restored production snapshot. It never validates,
-- archives, or deletes anything itself. See docs/runbooks/validate-not-valid-fks.md.
--
-- ⚠️  STAGING ONLY — connect to a RESTORED SNAPSHOT, never to live production.
--
-- Run with:  psql "$STAGING_URL" -f server/src/db/maintenance/fk_validation_emit.sql

\echo '======================================================================'
\echo ' NOT VALID foreign keys (inventory)'
\echo '======================================================================'
SELECT child.relname  AS child_table,
       ca.attname      AS child_col,
       parent.relname  AS parent_table,
       pa.attname      AS parent_col,
       CASE con.confdeltype WHEN 'c' THEN 'CASCADE' WHEN 'r' THEN 'NO ACTION'
            WHEN 'n' THEN 'SET NULL' WHEN 'd' THEN 'SET DEFAULT' ELSE con.confdeltype END AS on_delete,
       con.conname     AS constraint_name
  FROM pg_constraint con
  JOIN pg_class child   ON child.oid  = con.conrelid
  JOIN pg_class parent  ON parent.oid = con.confrelid
  JOIN pg_namespace ns  ON ns.oid     = con.connamespace
  JOIN pg_attribute ca  ON ca.attrelid = con.conrelid  AND ca.attnum = con.conkey[1]
  JOIN pg_attribute pa  ON pa.attrelid = con.confrelid AND pa.attnum = con.confkey[1]
 WHERE con.contype = 'f' AND con.convalidated = false AND ns.nspname = 'public'
 ORDER BY child.relname, con.conname;

\echo ''
\echo '======================================================================'
\echo ' STEP A — orphan counts (read-only). Run these; any count > 0 must be'
\echo '          archived+cleaned (STEP B) before VALIDATE (STEP C).'
\echo '======================================================================'
SELECT format(
  'SELECT %L AS constraint_name, count(*) AS orphans FROM public.%I c '
  'WHERE c.%I IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.%I p WHERE p.%I = c.%I);',
  con.conname, child.relname, ca.attname, parent.relname, pa.attname, ca.attname) AS orphan_check_sql
  FROM pg_constraint con
  JOIN pg_class child   ON child.oid  = con.conrelid
  JOIN pg_class parent  ON parent.oid = con.confrelid
  JOIN pg_namespace ns  ON ns.oid     = con.connamespace
  JOIN pg_attribute ca  ON ca.attrelid = con.conrelid  AND ca.attnum = con.conkey[1]
  JOIN pg_attribute pa  ON pa.attrelid = con.confrelid AND pa.attnum = con.confkey[1]
 WHERE con.contype = 'f' AND con.convalidated = false AND ns.nspname = 'public'
   AND array_length(con.conkey, 1) = 1
 ORDER BY child.relname, con.conname;

\echo ''
\echo '======================================================================'
\echo ' STEP B — archive-then-clean (EMIT ONLY). Run the emitted block ONLY for'
\echo '          constraints whose STEP A count was > 0, after review. It copies'
\echo '          the orphan rows into schema fk_archive (timestamped) and THEN'
\echo '          deletes them from the live table. Review every block first.'
\echo '======================================================================'
SELECT string_agg(block, E'\n\n' ORDER BY child_table, constraint_name) AS archive_then_clean_sql
FROM (
  SELECT child.relname AS child_table, con.conname AS constraint_name,
    format(
      'CREATE SCHEMA IF NOT EXISTS fk_archive;' || E'\n' ||
      '-- %1$s: orphan %2$s.%3$s with no %4$s.%5$s' || E'\n' ||
      'CREATE TABLE IF NOT EXISTS fk_archive.%2$s_%1$s AS TABLE public.%2$s WITH NO DATA;' || E'\n' ||
      'INSERT INTO fk_archive.%2$s_%1$s SELECT c.* FROM public.%2$s c ' ||
        'WHERE c.%3$I IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.%4$s p WHERE p.%5$I = c.%3$I);' || E'\n' ||
      'DELETE FROM public.%2$s c ' ||
        'WHERE c.%3$I IS NOT NULL AND NOT EXISTS (SELECT 1 FROM public.%4$s p WHERE p.%5$I = c.%3$I);',
      con.conname, child.relname, ca.attname, parent.relname, pa.attname) AS block
    FROM pg_constraint con
    JOIN pg_class child   ON child.oid  = con.conrelid
    JOIN pg_class parent  ON parent.oid = con.confrelid
    JOIN pg_namespace ns  ON ns.oid     = con.connamespace
    JOIN pg_attribute ca  ON ca.attrelid = con.conrelid  AND ca.attnum = con.conkey[1]
    JOIN pg_attribute pa  ON pa.attrelid = con.confrelid AND pa.attnum = con.confkey[1]
   WHERE con.contype = 'f' AND con.convalidated = false AND ns.nspname = 'public'
     AND array_length(con.conkey, 1) = 1
) blocks;

\echo ''
\echo '======================================================================'
\echo ' STEP C — batched VALIDATE (EMIT ONLY). One ALTER per constraint; each'
\echo '          takes a SHARE UPDATE EXCLUSIVE lock (concurrent reads/writes OK)'
\echo '          and scans the child table once. Run a batch per table group in a'
\echo '          quiet window; re-run STEP A first if any data changed.'
\echo '======================================================================'
SELECT format('ALTER TABLE public.%I VALIDATE CONSTRAINT %I;', child.relname, con.conname) AS validate_sql,
       child.relname AS batch_group
  FROM pg_constraint con
  JOIN pg_class child  ON child.oid = con.conrelid
  JOIN pg_namespace ns ON ns.oid    = con.connamespace
 WHERE con.contype = 'f' AND con.convalidated = false AND ns.nspname = 'public'
 ORDER BY child.relname, con.conname;
