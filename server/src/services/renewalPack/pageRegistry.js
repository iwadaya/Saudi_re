// Registry of wizard pages the renewal-pack import can populate.
//
// Each entry is a small triple:
//   • snapshot(client, entity)        — read the current DB state for this page
//   • write(client, entity, state)    — overwrite the page with the given
//                                       state (also used for restore — capture
//                                       and restore are symmetric)
//   • applies(treatyCategory)         — guards pages that only make sense for
//                                       one treaty category. Pages that apply
//                                       to both treaty types return true for
//                                       either.
//
// Entity shape: { type: 'quote' | 'contract', id }. Each page knows
// which of the parallel quote_* / contract_* tables to read or write
// based on entity.type — most pages just swap a column name; the
// large-losses page does a JSONB-blob ↔ relational-row translation
// because quote_large_loss_report stores a single blob while
// contract_large_loss_report + contract_large_losses are normalised.
//
// The mapper produces a `state` per page from the LLM extraction; the
// orchestrator (importJob.js) drives snapshot → write per page that
// the mapper actually populated. The orchestrator never touches a
// page the mapper omitted, so an empty extraction never erases
// existing data.

import { randomUUID } from 'node:crypto';
import { logger } from '../../lib/logger.js';
import { buildBatchInserts } from '../../db/batchInsert.js';

function assertEntity(entity) {
  if (!entity || (entity.type !== 'quote' && entity.type !== 'contract') || !entity.id) {
    throw new Error(`pageRegistry: invalid entity ${JSON.stringify(entity)}`);
  }
}

// ── triangle pages (PREMIUM, CLAIMS_PAID, CLAIMS_OS) ────────────────────────

function makeTrianglePage(triangleType) {
  return {
    async snapshot(client, entity) {
      assertEntity(entity);
      const table = entity.type === 'quote' ? 'public.quote_triangle_cells' : 'public.contract_triangle_cells';
      const fk = entity.type === 'quote' ? 'quote_id' : 'contract_id';
      const { rows } = await client.query(
        `SELECT origin_year, dev_months, cum_value
           FROM ${table}
          WHERE ${fk}=$1 AND type=$2::public.triangle_type AND variant='MODIFIED'::public.triangle_variant
          ORDER BY origin_year, dev_months`,
        [entity.id, triangleType],
      );
      return { cells: rows.map((r) => ({
        origin_year: r.origin_year,
        dev_months: r.dev_months,
        cum_value: r.cum_value == null ? null : Number(r.cum_value),
      })) };
    },
    async write(client, entity, state) {
      assertEntity(entity);
      const table = entity.type === 'quote' ? 'public.quote_triangle_cells' : 'public.contract_triangle_cells';
      const fk = entity.type === 'quote' ? 'quote_id' : 'contract_id';
      // Renewal-pack import targets the projected (MODIFIED) triangle only;
      // scope the delete + set the variant so it never touches/collides with
      // ACTUAL cells under the (id,type,variant,...) UNIQUE constraint.
      await client.query(
        `DELETE FROM ${table} WHERE ${fk}=$1 AND type=$2::public.triangle_type AND variant='MODIFIED'::public.triangle_variant`,
        [entity.id, triangleType],
      );
      const cells = state?.cells || [];
      if (!cells.length) return;
      await client.query(
        `INSERT INTO ${table} (${fk}, type, variant, origin_year, dev_months, cum_value)
         SELECT $1, $2::public.triangle_type, 'MODIFIED'::public.triangle_variant, oy, dm, cv
           FROM unnest($3::int[], $4::int[], $5::numeric[]) AS u(oy, dm, cv)`,
        [
          entity.id, triangleType,
          cells.map((c) => Number(c.origin_year)),
          cells.map((c) => Number(c.dev_months)),
          cells.map((c) => (c.cum_value == null ? null : Number(c.cum_value))),
        ],
      );
    },
    applies: (cat) => cat === 'PROPORTIONAL',
  };
}

// ── CRESTA ──────────────────────────────────────────────────────────────────

const crestaPage = {
  async snapshot(client, entity) {
    assertEntity(entity);
    const table = entity.type === 'quote' ? 'public.quote_cresta_data' : 'public.contract_cresta_data';
    const fk = entity.type === 'quote' ? 'quote_id' : 'contract_id';
    const { rows } = await client.query(
      `SELECT country_id, zone_id, zone_name, eq_agg, ws_agg, flood_agg, srcc_agg, others_agg,
              treaty_type, cob_id, cob_name,
              residential_bldg_pct, commercial_bldg_pct, commercial_cont_pct,
              industrial_bldg_pct, industrial_cont_pct
         FROM ${table}
        WHERE ${fk}=$1
        ORDER BY country_id, zone_id`,
      [entity.id],
    );
    return { rows: rows.map(normaliseCrestaRow) };
  },
  async write(client, entity, state) {
    assertEntity(entity);
    const table = entity.type === 'quote' ? 'public.quote_cresta_data' : 'public.contract_cresta_data';
    const fk = entity.type === 'quote' ? 'quote_id' : 'contract_id';
    await client.query(`DELETE FROM ${table} WHERE ${fk}=$1`, [entity.id]);
    const rows = (state?.rows || []).filter((r) => r && r.zone_id);
    // CRESTA imports can carry hundreds of zones — one batched INSERT
    // instead of a round-trip per zone (same rationale as the triangle
    // page's unnest write above).
    const crestaInsert = buildBatchInserts({
      table,
      columns: [
        fk, 'country_id', 'zone_id', 'zone_name',
        'eq_agg', 'ws_agg', 'flood_agg', 'srcc_agg', 'others_agg',
        'treaty_type', 'cob_id', 'cob_name',
        'residential_bldg_pct', 'commercial_bldg_pct', 'commercial_cont_pct',
        'industrial_bldg_pct', 'industrial_cont_pct',
      ],
      rows: rows.map((r) => [
        r.country_id || null, r.zone_id, r.zone_name || null,
        numOrZero(r.eq_agg), numOrZero(r.ws_agg), numOrZero(r.flood_agg),
        numOrZero(r.srcc_agg), numOrZero(r.others_agg),
        r.treaty_type || 'Both', r.cob_id || null, r.cob_name || null,
        numOrNullPct(r.residential_bldg_pct, 30),
        numOrNullPct(r.commercial_bldg_pct, 25),
        numOrNullPct(r.commercial_cont_pct, 15),
        numOrNullPct(r.industrial_bldg_pct, 20),
        numOrNullPct(r.industrial_cont_pct, 10),
      ]),
      leadingId: entity.id,
    });
    for (const stmt of crestaInsert) await client.query(stmt.sql, stmt.params);
  },
  applies: () => true,
};

// ── large losses ────────────────────────────────────────────────────────────
//
// Quote and contract sides store this very differently:
//   • quote_large_loss_report.report_data is a single jsonb blob holding
//     BOTH large and cat losses ({ large: [...], cat: [...] }). The
//     mapper produces state in that exact shape.
//   • contract_large_loss_report is a header row with normalised
//     children in contract_large_losses; contract_cat_loss_report and
//     contract_cat_losses mirror that for CAT.
//
// The page's contract-side write path translates the blob into per-row
// inserts; the snapshot path rebuilds the blob from the relational
// rows so the saved payload (and therefore the restore) has the same
// shape on either side.

const largeLossesPage = {
  async snapshot(client, entity) {
    assertEntity(entity);
    if (entity.type === 'quote') {
      const { rows } = await client.query(
        `SELECT report_data FROM public.quote_large_loss_report WHERE quote_id=$1`,
        [entity.id],
      );
      return { report_data: rows[0]?.report_data ?? null };
    }
    // contract side — reconstruct the { large, cat } blob from rows.
    const [lrgHdr, catHdr] = await Promise.all([
      client.query(
        `SELECT report_id FROM public.contract_large_loss_report WHERE contract_id=$1`,
        [entity.id],
      ),
      client.query(
        `SELECT report_id FROM public.contract_cat_loss_report WHERE contract_id=$1`,
        [entity.id],
      ),
    ]);
    const [lrgRows, catRows] = await Promise.all([
      lrgHdr.rows.length
        ? client.query(
            `SELECT uw_year, insured_name, loss_name, date_of_loss, class_of_business,
                    paid, os, incurred
               FROM public.contract_large_losses WHERE report_id=$1 ORDER BY uw_year, date_of_loss`,
            [lrgHdr.rows[0].report_id],
          )
        : { rows: [] },
      catHdr.rows.length
        ? client.query(
            `SELECT uw_year, insured_name, loss_name, date_of_loss, class_of_business,
                    paid, os, incurred
               FROM public.contract_cat_losses WHERE report_id=$1 ORDER BY uw_year, date_of_loss`,
            [catHdr.rows[0].report_id],
          )
        : { rows: [] },
    ]);
    // No header AND no rows → the page is empty; preserve the null
    // payload shape so the snapshot/restore round-trip matches the
    // pre-import state on a quote with no large_loss_report row either.
    if (!lrgHdr.rows.length && !catHdr.rows.length) {
      return { report_data: null };
    }
    return {
      report_data: {
        large: lrgRows.rows.map(rowToLossRecord),
        cat:   catRows.rows.map(rowToLossRecord),
      },
    };
  },
  async write(client, entity, state) {
    assertEntity(entity);
    const payload = state?.report_data ?? null;
    if (entity.type === 'quote') {
      if (payload === null) {
        await client.query(
          `DELETE FROM public.quote_large_loss_report WHERE quote_id=$1`,
          [entity.id],
        );
        return;
      }
      await client.query(
        `INSERT INTO public.quote_large_loss_report (quote_id, report_data, updated_at)
         VALUES ($1, $2::jsonb, now())
         ON CONFLICT (quote_id) DO UPDATE SET report_data=EXCLUDED.report_data, updated_at=now()`,
        [entity.id, JSON.stringify(payload)],
      );
      return;
    }
    // contract side: write the relational tables.
    const large = Array.isArray(payload?.large) ? payload.large : [];
    const cat   = Array.isArray(payload?.cat)   ? payload.cat   : [];
    await writeContractLossReport(client, entity.id, 'large', large);
    await writeContractLossReport(client, entity.id, 'cat',   cat);
  },
  applies: () => true,
};

// ── NP expiring layers (the incumbent treaty's layer structure) ─────────────

const npStructurePage = {
  async snapshot(client, entity) {
    assertEntity(entity);
    const table = entity.type === 'quote' ? 'public.quote_np_expiring_layers' : 'public.contract_np_expiring_layers';
    const fk = entity.type === 'quote' ? 'quote_id' : 'contract_id';
    const { rows } = await client.query(
      `SELECT layer_number, attachment, layer_limit, aggregate_limit, egnpi,
              earned_premium, rate, rol, num_reinstatements, reinstatement_pct,
              annual_agg_deductible, peril_scope, mdp, mdp_pct
         FROM ${table}
        WHERE ${fk}=$1
        ORDER BY layer_number`,
      [entity.id],
    );
    return { layers: rows.map((r) => ({
      layer_number: r.layer_number,
      attachment: numOrNullCoerce(r.attachment),
      layer_limit: numOrNullCoerce(r.layer_limit),
      aggregate_limit: numOrNullCoerce(r.aggregate_limit),
      egnpi: numOrNullCoerce(r.egnpi),
      earned_premium: numOrNullCoerce(r.earned_premium),
      rate: numOrNullCoerce(r.rate),
      rol: numOrNullCoerce(r.rol),
      num_reinstatements: r.num_reinstatements == null ? null : Number(r.num_reinstatements),
      reinstatement_pct: numOrNullCoerce(r.reinstatement_pct),
      annual_agg_deductible: numOrNullCoerce(r.annual_agg_deductible),
      peril_scope: r.peril_scope || 'BOTH',
      mdp: numOrNullCoerce(r.mdp),
      mdp_pct: numOrNullCoerce(r.mdp_pct),
    })) };
  },
  async write(client, entity, state) {
    assertEntity(entity);
    const table = entity.type === 'quote' ? 'public.quote_np_expiring_layers' : 'public.contract_np_expiring_layers';
    const fk = entity.type === 'quote' ? 'quote_id' : 'contract_id';
    await client.query(`DELETE FROM ${table} WHERE ${fk}=$1`, [entity.id]);
    const layers = state?.layers || [];
    const layersInsert = buildBatchInserts({
      table,
      columns: [
        fk, 'layer_number', 'attachment', 'layer_limit', 'aggregate_limit', 'egnpi',
        'earned_premium', 'rate', 'rol', 'num_reinstatements', 'reinstatement_pct',
        'annual_agg_deductible', 'peril_scope', 'mdp', 'mdp_pct',
      ],
      rows: layers.map((l) => [
        Number(l.layer_number) || 1,
        numOrNullCoerce(l.attachment),
        numOrNullCoerce(l.layer_limit),
        numOrNullCoerce(l.aggregate_limit),
        numOrNullCoerce(l.egnpi),
        numOrNullCoerce(l.earned_premium),
        numOrNullCoerce(l.rate),
        numOrNullCoerce(l.rol),
        l.num_reinstatements == null ? null : Number(l.num_reinstatements),
        numOrNullCoerce(l.reinstatement_pct),
        numOrNullCoerce(l.annual_agg_deductible),
        l.peril_scope || 'BOTH',
        numOrNullCoerce(l.mdp),
        numOrNullCoerce(l.mdp_pct),
      ]),
      leadingId: entity.id,
    });
    for (const stmt of layersInsert) await client.query(stmt.sql, stmt.params);
  },
  applies: (cat) => cat === 'NON_PROPORTIONAL',
};

// ── EGNPI history (per UW year) ─────────────────────────────────────────────

const egnpiHistoryPage = {
  async snapshot(client, entity) {
    assertEntity(entity);
    const table = entity.type === 'quote' ? 'public.quote_np_historical_performance' : 'public.contract_np_historical_performance';
    const fk = entity.type === 'quote' ? 'quote_id' : 'contract_id';
    const { rows } = await client.query(
      `SELECT uw_year, premiums, claims, egnpi, result, loss_ratio, expense_ratio, combined_ratio
         FROM ${table}
        WHERE ${fk}=$1
        ORDER BY uw_year`,
      [entity.id],
    );
    return { rows: rows.map((r) => ({
      uw_year: Number(r.uw_year),
      premiums: numOrNullCoerce(r.premiums),
      claims: numOrNullCoerce(r.claims),
      egnpi: numOrNullCoerce(r.egnpi),
      result: numOrNullCoerce(r.result),
      loss_ratio: numOrNullCoerce(r.loss_ratio),
      expense_ratio: numOrNullCoerce(r.expense_ratio),
      combined_ratio: numOrNullCoerce(r.combined_ratio),
    })) };
  },
  async write(client, entity, state) {
    assertEntity(entity);
    const table = entity.type === 'quote' ? 'public.quote_np_historical_performance' : 'public.contract_np_historical_performance';
    const fk = entity.type === 'quote' ? 'quote_id' : 'contract_id';
    await client.query(`DELETE FROM ${table} WHERE ${fk}=$1`, [entity.id]);
    // Dedupe last-wins per uw_year: one multi-row upsert cannot touch the
    // same (fk, uw_year) twice, and the old per-row loop's end state was
    // last-wins anyway.
    const byYear = new Map(
      (state?.rows || [])
        .filter((r) => Number.isFinite(Number(r.uw_year)))
        .map((r) => [Number(r.uw_year), r]),
    );
    const egnpiInsert = buildBatchInserts({
      table,
      columns: [fk, 'uw_year', 'premiums', 'claims', 'egnpi', 'result', 'loss_ratio', 'expense_ratio', 'combined_ratio'],
      rows: [...byYear.values()].map((r) => [
        Number(r.uw_year),
        numOrNullCoerce(r.premiums),
        numOrNullCoerce(r.claims),
        numOrNullCoerce(r.egnpi),
        numOrNullCoerce(r.result),
        numOrNullCoerce(r.loss_ratio),
        numOrNullCoerce(r.expense_ratio),
        numOrNullCoerce(r.combined_ratio),
      ]),
      leadingId: entity.id,
      conflict: `ON CONFLICT (${fk}, uw_year)
         DO UPDATE SET premiums=EXCLUDED.premiums, claims=EXCLUDED.claims, egnpi=EXCLUDED.egnpi,
                       result=EXCLUDED.result, loss_ratio=EXCLUDED.loss_ratio,
                       expense_ratio=EXCLUDED.expense_ratio, combined_ratio=EXCLUDED.combined_ratio,
                       updated_at=now()`,
    });
    for (const stmt of egnpiInsert) await client.query(stmt.sql, stmt.params);
  },
  applies: (cat) => cat === 'NON_PROPORTIONAL',
};

// ── registry ────────────────────────────────────────────────────────────────

const PAGE_REGISTRY = {
  premium_history: makeTrianglePage('PREMIUM'),
  claims_history_paid: makeTrianglePage('CLAIMS_PAID'),
  claims_history_os: makeTrianglePage('CLAIMS_OS'),
  cresta: crestaPage,
  large_losses: largeLossesPage,
  np_structure: npStructurePage,
  egnpi_history: egnpiHistoryPage,
};

export function isKnownPage(name) {
  return Object.prototype.hasOwnProperty.call(PAGE_REGISTRY, name);
}

export async function snapshotPage(client, entity, name) {
  const page = PAGE_REGISTRY[name];
  if (!page) {
    logger.warn('[pageRegistry] snapshot called for unknown page', { name });
    return null;
  }
  return await page.snapshot(client, entity);
}

export async function writePage(client, entity, name, state) {
  const page = PAGE_REGISTRY[name];
  if (!page) {
    logger.warn('[pageRegistry] write called for unknown page', { name });
    return;
  }
  await page.write(client, entity, state);
}

// ── helpers ─────────────────────────────────────────────────────────────────

function numOrNullCoerce(v) {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function numOrZero(v) {
  const n = numOrNullCoerce(v);
  return n == null ? 0 : n;
}

function numOrNullPct(v, fallback) {
  const n = numOrNullCoerce(v);
  return n == null ? fallback : n;
}

function normaliseCrestaRow(r) {
  return {
    country_id: r.country_id,
    zone_id: r.zone_id,
    zone_name: r.zone_name,
    eq_agg: numOrNullCoerce(r.eq_agg),
    ws_agg: numOrNullCoerce(r.ws_agg),
    flood_agg: numOrNullCoerce(r.flood_agg),
    srcc_agg: numOrNullCoerce(r.srcc_agg),
    others_agg: numOrNullCoerce(r.others_agg),
    treaty_type: r.treaty_type || 'Both',
    cob_id: r.cob_id,
    cob_name: r.cob_name,
    residential_bldg_pct: numOrNullCoerce(r.residential_bldg_pct),
    commercial_bldg_pct: numOrNullCoerce(r.commercial_bldg_pct),
    commercial_cont_pct: numOrNullCoerce(r.commercial_cont_pct),
    industrial_bldg_pct: numOrNullCoerce(r.industrial_bldg_pct),
    industrial_cont_pct: numOrNullCoerce(r.industrial_cont_pct),
  };
}

// rowToLossRecord rebuilds the shape the mapper produces (and the
// quote-side blob stores) from a relational large/cat loss row.
function rowToLossRecord(r) {
  return {
    uwYear: r.uw_year == null ? null : Number(r.uw_year),
    insuredName: r.insured_name || null,
    description: r.loss_name || null,
    date: r.date_of_loss ? new Date(r.date_of_loss).toISOString().slice(0, 10) : null,
    classOfBusiness: r.class_of_business || null,
    paid: numOrNullCoerce(r.paid),
    os: numOrNullCoerce(r.os),
    incurred: numOrNullCoerce(r.incurred),
  };
}

async function writeContractLossReport(client, contractId, kind, records) {
  const reportTable = kind === 'large' ? 'public.contract_large_loss_report' : 'public.contract_cat_loss_report';
  const childTable  = kind === 'large' ? 'public.contract_large_losses'      : 'public.contract_cat_losses';

  if (!records.length) {
    // Mirror the quote-side semantics: an empty payload removes the
    // page state. Drop the header row and its rows together via the
    // FK cascade where it exists; where it doesn't, do an explicit
    // child delete first.
    const { rows: hdr } = await client.query(
      `SELECT report_id FROM ${reportTable} WHERE contract_id=$1`,
      [contractId],
    );
    if (hdr.length) {
      await client.query(`DELETE FROM ${childTable} WHERE report_id=$1`, [hdr[0].report_id]);
      await client.query(`DELETE FROM ${reportTable} WHERE contract_id=$1`, [contractId]);
    }
    return;
  }

  // Upsert the report header, then replace the child rows.
  const { rows: hdr } = await client.query(
    `SELECT report_id FROM ${reportTable} WHERE contract_id=$1`,
    [contractId],
  );
  let reportId;
  if (hdr.length) {
    reportId = hdr[0].report_id;
    await client.query(
      `UPDATE ${reportTable} SET updated_at=now() WHERE report_id=$1`,
      [reportId],
    );
  } else {
    const { rows: ins } = await client.query(
      `INSERT INTO ${reportTable} (contract_id, report_date) VALUES ($1, NULL) RETURNING report_id`,
      [contractId],
    );
    reportId = ins[0].report_id;
  }
  await client.query(`DELETE FROM ${childTable} WHERE report_id=$1`, [reportId]);
  const lossesInsert = buildBatchInserts({
    table: childTable,
    columns: [
      'report_id', 'loss_id', 'uw_year', 'insured_name', 'loss_name', 'date_of_loss',
      'class_of_business', 'paid', 'os', 'incurred', 'is_selected',
    ],
    rows: records.map((r) => [
      randomUUID(),
      r.uwYear == null ? null : Number(r.uwYear),
      r.insuredName || null,
      r.description || null,
      r.date || null,
      r.classOfBusiness || null,
      numOrNullCoerce(r.paid),
      numOrNullCoerce(r.os),
      numOrNullCoerce(r.incurred),
      true,
    ]),
    leadingId: reportId,
  });
  for (const stmt of lossesInsert) await client.query(stmt.sql, stmt.params);
}
