// server/tests/integration/syncRefLists.integration.test.js
//
// DB-backed contract for server/scripts/syncRefLists.js — the tool that
// copies the reference LISTS (cedants, brokers, countries, …) from one
// environment's database into another (docs/seed-ref-lists.md).
//
// Covers the properties the migration story depends on:
//   • dry-run reports the work but writes nothing;
//   • rows matching an existing target row by natural key MERGE into it
//     (no duplicate 'Aon' next to the boot-seeded 'Aon') and updates land
//     in place, keeping the target's id;
//   • brand-new rows insert PRESERVING the source UUID;
//   • FK columns (companies.country_id, ref_list_item.list_id,
//     ref_country_inflation.country_id) are remapped to the TARGET parent id;
//   • a row whose parent didn't import is skipped, never inserted dangling;
//   • re-importing the same snapshot is a no-op;
//   • exportSnapshot round-trips what import wrote.
//
// Every fixture name carries a unique stamp and afterAll deletes them, so the
// suite is safe against the shared test database.

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { shouldSkipDb, closePools } from './helpers.js';
import { pool } from '../../src/db/pool.js';
import { exportSnapshot, importSnapshot, SNAPSHOT_FORMAT } from '../../scripts/syncRefLists.js';

const stamp = Date.now();

const names = {
  countryOld: `SyncT Country Old ${stamp}`,
  countryNew: `SyncT Country New ${stamp}`,
  countryCode: `SYNCT${stamp}`,
  brokerDup: `SyncT Broker Dup ${stamp}`,
  brokerNew: `SyncT Broker New ${stamp}`,
  cedant: `SyncT Cedant ${stamp}`,
  orphanCedant: `SyncT Orphan Cedant ${stamp}`,
  listKey: `synct_${stamp}`,
  listLabel: `SyncT List ${stamp}`,
  item: `SyncT Item ${stamp}`,
  fxCode: 'ZZS', // test-only ISO-ish code, cleaned up below
  fxDate: '2031-05-04',
};

// Source-side UUIDs, as if exported from the Render database.
const src = {
  countryId: randomUUID(),
  brokerDupId: randomUUID(),
  brokerNewId: randomUUID(),
  cedantId: randomUUID(),
  listId: randomUUID(),
  itemId: randomUUID(),
  rateId: randomUUID(),
};

function makeSnapshot() {
  return {
    format: SNAPSHOT_FORMAT,
    exportedAt: new Date().toISOString(),
    tables: {
      country: {
        rows: [{
          _id: src.countryId,
          country_name: names.countryNew, // renamed at the source
          country_code: names.countryCode,
          region: 'MENA',
          is_active: true,
        }],
      },
      brokers: {
        rows: [
          { _id: src.brokerDupId, broker_name: names.brokerDup, is_active: true },
          { _id: src.brokerNewId, broker_name: names.brokerNew, is_active: true },
        ],
      },
      companies: {
        rows: [{
          _id: src.cedantId,
          company_name: names.cedant,
          country_id: src.countryId, // must be remapped to the TARGET country
          is_active: true,
        }],
      },
      ref_list: {
        rows: [{ _id: src.listId, list_key: names.listKey, label: names.listLabel }],
      },
      ref_list_item: {
        rows: [{
          _id: src.itemId,
          list_id: src.listId, // must be remapped through ref_list
          code: 'X1',
          name: names.item,
          sort_order: 5,
          is_active: true,
        }],
      },
      ref_exchange_rate: {
        rows: [{
          _id: src.rateId,
          currency_code: names.fxCode,
          rate_to_usd: 4.5,
          effective_date: names.fxDate,
          source: 'MANUAL',
        }],
      },
      ref_country_inflation: {
        rows: [{
          country_id: src.countryId, // pk-less table, composite natural key
          uw_year: 2099,
          inflation_pct: 5.5,
          source: 'SYNCT',
        }],
      },
    },
  };
}

describe.skipIf(shouldSkipDb)('integration: syncRefLists export/import', () => {
  let targetCountryId; // pre-existing target row the snapshot must merge into
  let targetBrokerDupId;

  beforeAll(async () => {
    const country = await pool.query(
      `INSERT INTO public.country (country_name, country_code, is_active)
       VALUES ($1, $2, true) RETURNING country_id`,
      [names.countryOld, names.countryCode],
    );
    targetCountryId = country.rows[0].country_id;

    const broker = await pool.query(
      `INSERT INTO public.brokers (broker_name, is_active)
       VALUES ($1, true) RETURNING broker_id`,
      [names.brokerDup],
    );
    targetBrokerDupId = broker.rows[0].broker_id;
  });

  afterAll(async () => {
    // FK-safe order: children before parents. Best-effort — the suite may
    // have failed before some rows existed.
    const run = (sql, params) => pool.query(sql, params).catch(() => {});
    await run(`DELETE FROM public.ref_list_item WHERE name = $1`, [names.item]);
    await run(`DELETE FROM public.ref_list WHERE list_key = $1`, [names.listKey]);
    await run(`DELETE FROM public.companies WHERE company_name IN ($1, $2)`, [names.cedant, names.orphanCedant]);
    await run(`DELETE FROM public.ref_country_inflation WHERE source = 'SYNCT' AND uw_year = 2099`);
    await run(`DELETE FROM public.ref_exchange_rate WHERE currency_code = $1`, [names.fxCode]);
    await run(`DELETE FROM public.brokers WHERE broker_name IN ($1, $2)`, [names.brokerDup, names.brokerNew]);
    await run(`DELETE FROM public.country WHERE country_code = $1`, [names.countryCode]);
    await closePools();
  });

  it('dry-run reports the pending work but writes nothing', async () => {
    const summary = await importSnapshot(pool, makeSnapshot(), { dryRun: true });

    expect(summary.country.updated).toBe(1); // rename merges onto the existing row
    expect(summary.brokers).toMatchObject({ inserted: 1, unchanged: 1 });
    expect(summary.companies.inserted).toBe(1);
    expect(summary.ref_list.inserted).toBe(1);
    expect(summary.ref_list_item.inserted).toBe(1);

    const broker = await pool.query(
      `SELECT 1 FROM public.brokers WHERE broker_name = $1`, [names.brokerNew],
    );
    expect(broker.rowCount).toBe(0); // rolled back
    const country = await pool.query(
      `SELECT country_name FROM public.country WHERE country_id = $1`, [targetCountryId],
    );
    expect(country.rows[0].country_name).toBe(names.countryOld);
  });

  it('imports: merges by natural key, preserves source ids on inserts, remaps FKs', async () => {
    const summary = await importSnapshot(pool, makeSnapshot());

    // Country: matched by country_code → renamed IN PLACE, same target id.
    expect(summary.country.updated).toBe(1);
    const country = await pool.query(
      `SELECT country_id, country_name, region FROM public.country WHERE country_code = $1 AND is_active IS NOT FALSE`,
      [names.countryCode],
    );
    expect(country.rowCount).toBe(1);
    expect(country.rows[0].country_id).toBe(targetCountryId);
    expect(country.rows[0].country_name).toBe(names.countryNew);
    expect(country.rows[0].region).toBe('MENA');

    // Duplicate-named broker merged (still exactly one row, target's id);
    // new broker inserted with the SOURCE uuid.
    const dup = await pool.query(
      `SELECT broker_id FROM public.brokers WHERE broker_name = $1`, [names.brokerDup],
    );
    expect(dup.rowCount).toBe(1);
    expect(dup.rows[0].broker_id).toBe(targetBrokerDupId);
    const fresh = await pool.query(
      `SELECT broker_id FROM public.brokers WHERE broker_name = $1`, [names.brokerNew],
    );
    expect(fresh.rows[0].broker_id).toBe(src.brokerNewId);

    // Cedant FK remapped: source country uuid → the target country's uuid.
    const cedant = await pool.query(
      `SELECT country_id FROM public.companies WHERE company_name = $1`, [names.cedant],
    );
    expect(cedant.rows[0].country_id).toBe(targetCountryId);

    // ref_list_item remapped through ref_list (inserted with source ids).
    const item = await pool.query(
      `SELECT i.list_id, i.sort_order, l.list_key
         FROM public.ref_list_item i JOIN public.ref_list l ON l.list_id = i.list_id
        WHERE i.name = $1`,
      [names.item],
    );
    expect(item.rows[0].list_key).toBe(names.listKey);
    expect(item.rows[0].list_id).toBe(src.listId);
    expect(item.rows[0].sort_order).toBe(5);

    // FX rate and the pk-less inflation table landed, inflation remapped.
    const fx = await pool.query(
      `SELECT rate_to_usd, effective_date::text AS d FROM public.ref_exchange_rate WHERE currency_code = $1`,
      [names.fxCode],
    );
    expect(fx.rows[0].d).toBe(names.fxDate);
    expect(Number(fx.rows[0].rate_to_usd)).toBeCloseTo(4.5, 8);
    const infl = await pool.query(
      `SELECT country_id, inflation_pct FROM public.ref_country_inflation WHERE uw_year = 2099 AND source = 'SYNCT'`,
    );
    expect(infl.rows[0].country_id).toBe(targetCountryId);
    expect(Number(infl.rows[0].inflation_pct)).toBeCloseTo(5.5, 4);
  });

  it('re-importing the same snapshot is a no-op', async () => {
    const summary = await importSnapshot(pool, makeSnapshot());
    for (const table of ['country', 'brokers', 'companies', 'ref_list', 'ref_list_item', 'ref_exchange_rate', 'ref_country_inflation']) {
      expect(summary[table].inserted, `${table} inserted`).toBe(0);
      expect(summary[table].updated, `${table} updated`).toBe(0);
      expect(summary[table].skipped, `${table} skipped`).toBe(0);
    }
  });

  it('skips rows whose parent did not import, instead of inserting dangling FKs', async () => {
    const orphanSnapshot = {
      format: SNAPSHOT_FORMAT,
      exportedAt: new Date().toISOString(),
      tables: {
        companies: {
          rows: [{
            _id: randomUUID(),
            company_name: names.orphanCedant,
            country_id: randomUUID(), // country not present in this snapshot
            is_active: true,
          }],
        },
      },
    };
    const summary = await importSnapshot(pool, orphanSnapshot, { log: { warn: () => {} } });
    expect(summary.companies).toMatchObject({ inserted: 0, skipped: 1 });
    const row = await pool.query(
      `SELECT 1 FROM public.companies WHERE company_name = $1`, [names.orphanCedant],
    );
    expect(row.rowCount).toBe(0);
  });

  it('exportSnapshot round-trips what import wrote', async () => {
    const snapshot = await exportSnapshot(pool);
    expect(snapshot.format).toBe(SNAPSHOT_FORMAT);

    const broker = snapshot.tables.brokers.rows.find((r) => r.broker_name === names.brokerNew);
    expect(broker).toMatchObject({ _id: src.brokerNewId, is_active: true });

    const country = snapshot.tables.country.rows.find(
      (r) => r.country_code === names.countryCode && r.is_active !== false,
    );
    expect(country).toMatchObject({ _id: targetCountryId, country_name: names.countryNew });

    // Date columns export as plain YYYY-MM-DD strings (timezone-proof).
    const fx = snapshot.tables.ref_exchange_rate.rows.find((r) => r.currency_code === names.fxCode);
    expect(fx.effective_date).toBe(names.fxDate);

    // And feeding the export straight back in changes nothing for our rows.
    const summary = await importSnapshot(pool, snapshot, { dryRun: true, log: { warn: () => {} } });
    expect(summary.brokers.inserted).toBe(0);
  });
});
