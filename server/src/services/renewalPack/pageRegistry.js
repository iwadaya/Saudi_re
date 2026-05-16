// Registry of wizard pages the renewal-pack import can populate.
//
// Each entry is a small triple:
//   • snapshot(client, quoteId)  — read the current DB state for this page
//   • write(client, quoteId, state) — overwrite the page with the given
//                                     state (also used for restore — capture
//                                     and restore are symmetric)
//   • applies(treatyCategory)    — guards pages that only make sense for
//                                   one treaty category. Pages that apply
//                                   to both treaty types return true for
//                                   either.
//
// The mapper produces a `state` per page from the LLM extraction; the
// orchestrator (importJob.js) drives snapshot → write per page that the
// mapper actually populated. The orchestrator never touches a page the
// mapper omitted, so an empty extraction never erases existing data.

import { logger } from '../../lib/logger.js';

// ── triangle pages (PREMIUM, CLAIMS_PAID, CLAIMS_OS) ────────────────────────

function makeTrianglePage(triangleType) {
  return {
    async snapshot(client, quoteId) {
      const { rows } = await client.query(
        `SELECT origin_year, dev_months, cum_value
           FROM public.quote_triangle_cells
          WHERE quote_id=$1 AND type=$2::public.triangle_type
          ORDER BY origin_year, dev_months`,
        [quoteId, triangleType],
      );
      return { cells: rows.map((r) => ({
        origin_year: r.origin_year,
        dev_months: r.dev_months,
        cum_value: r.cum_value == null ? null : Number(r.cum_value),
      })) };
    },
    async write(client, quoteId, state) {
      await client.query(
        `DELETE FROM public.quote_triangle_cells WHERE quote_id=$1 AND type=$2::public.triangle_type`,
        [quoteId, triangleType],
      );
      const cells = state?.cells || [];
      if (!cells.length) return;
      await client.query(
        `INSERT INTO public.quote_triangle_cells (quote_id, type, origin_year, dev_months, cum_value)
         SELECT $1, $2::public.triangle_type, oy, dm, cv
           FROM unnest($3::int[], $4::int[], $5::numeric[]) AS u(oy, dm, cv)`,
        [
          quoteId, triangleType,
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
  async snapshot(client, quoteId) {
    const { rows } = await client.query(
      `SELECT country_id, zone_id, zone_name, eq_agg, ws_agg, flood_agg, srcc_agg, others_agg,
              treaty_type, cob_id, cob_name,
              residential_bldg_pct, commercial_bldg_pct, commercial_cont_pct,
              industrial_bldg_pct, industrial_cont_pct
         FROM public.quote_cresta_data
        WHERE quote_id=$1
        ORDER BY country_id, zone_id`,
      [quoteId],
    );
    return { rows: rows.map(normaliseCrestaRow) };
  },
  async write(client, quoteId, state) {
    await client.query(`DELETE FROM public.quote_cresta_data WHERE quote_id=$1`, [quoteId]);
    const rows = (state?.rows || []).filter((r) => r && r.zone_id);
    for (const r of rows) {
      await client.query(
        `INSERT INTO public.quote_cresta_data
           (quote_id, country_id, zone_id, zone_name,
            eq_agg, ws_agg, flood_agg, srcc_agg, others_agg,
            treaty_type, cob_id, cob_name,
            residential_bldg_pct, commercial_bldg_pct, commercial_cont_pct,
            industrial_bldg_pct, industrial_cont_pct)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)`,
        [
          quoteId, r.country_id || null, r.zone_id, r.zone_name || null,
          numOrZero(r.eq_agg), numOrZero(r.ws_agg), numOrZero(r.flood_agg),
          numOrZero(r.srcc_agg), numOrZero(r.others_agg),
          r.treaty_type || 'Both', r.cob_id || null, r.cob_name || null,
          numOrNullPct(r.residential_bldg_pct, 30),
          numOrNullPct(r.commercial_bldg_pct, 25),
          numOrNullPct(r.commercial_cont_pct, 15),
          numOrNullPct(r.industrial_bldg_pct, 20),
          numOrNullPct(r.industrial_cont_pct, 10),
        ],
      );
    }
  },
  applies: () => true,
};

// ── large losses (jsonb blob — single row per quote) ────────────────────────

const largeLossesPage = {
  async snapshot(client, quoteId) {
    const { rows } = await client.query(
      `SELECT report_data FROM public.quote_large_loss_report WHERE quote_id=$1`,
      [quoteId],
    );
    return { report_data: rows[0]?.report_data ?? null };
  },
  async write(client, quoteId, state) {
    const payload = state?.report_data ?? null;
    if (payload === null) {
      await client.query(
        `DELETE FROM public.quote_large_loss_report WHERE quote_id=$1`,
        [quoteId],
      );
      return;
    }
    await client.query(
      `INSERT INTO public.quote_large_loss_report (quote_id, report_data, updated_at)
       VALUES ($1, $2::jsonb, now())
       ON CONFLICT (quote_id) DO UPDATE SET report_data=EXCLUDED.report_data, updated_at=now()`,
      [quoteId, JSON.stringify(payload)],
    );
  },
  applies: () => true,
};

// ── NP expiring layers (the incumbent treaty's layer structure) ─────────────

const npStructurePage = {
  async snapshot(client, quoteId) {
    const { rows } = await client.query(
      `SELECT layer_number, attachment, layer_limit, aggregate_limit, egnpi,
              earned_premium, rate, rol, num_reinstatements, reinstatement_pct,
              annual_agg_deductible, peril_scope, mdp, mdp_pct
         FROM public.quote_np_expiring_layers
        WHERE quote_id=$1
        ORDER BY layer_number`,
      [quoteId],
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
  async write(client, quoteId, state) {
    await client.query(
      `DELETE FROM public.quote_np_expiring_layers WHERE quote_id=$1`,
      [quoteId],
    );
    const layers = state?.layers || [];
    for (const l of layers) {
      await client.query(
        `INSERT INTO public.quote_np_expiring_layers
           (quote_id, layer_number, attachment, layer_limit, aggregate_limit, egnpi,
            earned_premium, rate, rol, num_reinstatements, reinstatement_pct,
            annual_agg_deductible, peril_scope, mdp, mdp_pct)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)`,
        [
          quoteId, Number(l.layer_number) || 1,
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
        ],
      );
    }
  },
  applies: (cat) => cat === 'NON_PROPORTIONAL',
};

// ── EGNPI history (per UW year) ─────────────────────────────────────────────

const egnpiHistoryPage = {
  async snapshot(client, quoteId) {
    const { rows } = await client.query(
      `SELECT uw_year, premiums, claims, egnpi, result, loss_ratio, expense_ratio, combined_ratio
         FROM public.quote_np_historical_performance
        WHERE quote_id=$1
        ORDER BY uw_year`,
      [quoteId],
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
  async write(client, quoteId, state) {
    await client.query(
      `DELETE FROM public.quote_np_historical_performance WHERE quote_id=$1`,
      [quoteId],
    );
    const rows = (state?.rows || []).filter((r) => Number.isFinite(Number(r.uw_year)));
    for (const r of rows) {
      await client.query(
        `INSERT INTO public.quote_np_historical_performance
           (quote_id, uw_year, premiums, claims, egnpi, result, loss_ratio, expense_ratio, combined_ratio)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
         ON CONFLICT (quote_id, uw_year)
         DO UPDATE SET premiums=EXCLUDED.premiums, claims=EXCLUDED.claims, egnpi=EXCLUDED.egnpi,
                       result=EXCLUDED.result, loss_ratio=EXCLUDED.loss_ratio,
                       expense_ratio=EXCLUDED.expense_ratio, combined_ratio=EXCLUDED.combined_ratio,
                       updated_at=now()`,
        [
          quoteId, Number(r.uw_year),
          numOrNullCoerce(r.premiums),
          numOrNullCoerce(r.claims),
          numOrNullCoerce(r.egnpi),
          numOrNullCoerce(r.result),
          numOrNullCoerce(r.loss_ratio),
          numOrNullCoerce(r.expense_ratio),
          numOrNullCoerce(r.combined_ratio),
        ],
      );
    }
  },
  applies: (cat) => cat === 'NON_PROPORTIONAL',
};

// ── registry ────────────────────────────────────────────────────────────────

export const PAGE_REGISTRY = {
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

export async function snapshotPage(client, quoteId, name) {
  const page = PAGE_REGISTRY[name];
  if (!page) {
    logger.warn('[pageRegistry] snapshot called for unknown page', { name });
    return null;
  }
  return await page.snapshot(client, quoteId);
}

export async function writePage(client, quoteId, name, state) {
  const page = PAGE_REGISTRY[name];
  if (!page) {
    logger.warn('[pageRegistry] write called for unknown page', { name });
    return;
  }
  await page.write(client, quoteId, state);
}

// ── small numeric helpers (kept local so the writers don't pull a util) ─────

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
