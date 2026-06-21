// src/screens/non_proportional/final_pricing/npWorkbookExporters.js
// ─────────────────────────────────────────────────────────────────────────
// NP flow registry for the whole-contract Excel exporter.
//
// Maps every NP wizard step -> how to fetch its persisted data and how to
// turn it into worksheet rows. Order itself is NOT defined here: it comes
// from getWizardNav(...).order so the export sequence always matches the
// live wizard (including treaty-type / quote / flow filtering).
//
// Screens that hold no separately-persisted state (the Pareto screens are
// derived on-screen from the selected losses; the per-COB Risk/Claims
// profiles need a COB context the final screen doesn't carry) emit a short
// note sheet so the sequence stays complete and self-documenting.
// ─────────────────────────────────────────────────────────────────────────

import {
  buildContractWorkbook, fetchJson, tableSheet, kvSheet, autoSheet, noteSheet,
} from '../../../utils/contractWorkbook';
import { buildNpPricingSheets } from './exportPricingToExcel.js';
import { getWizardNav, STEP_LABELS } from '../../../config/wizard';

// API base for NP-specific endpoints (these have both /treaties and /quotes
// variants). The shared treatyData endpoints (documents, losses, cresta,
// loss-selection) live under /treaties only; in quote mode they simply
// return null and the screen gets a note sheet.
const npBase = ({ contractId, isQuote }) => (isQuote ? `/api/quotes/${contractId}` : `/api/treaties/${contractId}`);
const treatyBase = ({ contractId }) => `/api/treaties/${contractId}`;

// Two-part LDF screens: selected factors + derived ultimates.
function ldfSheets(data) {
  if (!data) return noteSheet('No saved development factors for this screen.');
  const out = [];
  if (Array.isArray(data.ldfs) && data.ldfs.length) {
    out.push({ name: 'LDFs', aoa: tableSheet(data.ldfs) });
  }
  if (Array.isArray(data.ultimates) && data.ultimates.length) {
    out.push({ name: 'Ultimates', aoa: tableSheet(data.ultimates) });
  }
  return out.length ? out : noteSheet('No saved development factors for this screen.');
}

export const NP_SCREEN_EXPORTERS = {
  NP_TREATY_DETAIL: {
    sheetName: 'Treaty Detail',
    fetch: (ctx) => fetchJson(`${treatyBase(ctx)}`, ctx.signal),
    build: (fetched, ctx) => {
      // In-memory treaty detail (current screen state) merged over the
      // authoritative server header.
      const merged = { ...(fetched || {}), ...(ctx.npDetail || {}), ...(ctx.header || {}) };
      return kvSheet(merged, {
        skip: ['id', 'contractId', 'contract_id', 'createdAt', 'updatedAt', 'updated_at', 'created_at'],
      });
    },
  },

  NP_TREATY_DOCUMENTS: {
    sheetName: 'Documents',
    fetch: (ctx) => fetchJson(`${treatyBase(ctx)}/documents`, ctx.signal),
    build: (data) => {
      const rows = Array.isArray(data) ? data : (data?.documents || data?.files || []);
      return rows.length
        ? tableSheet(rows, { columns: ['file_name', 'doc_type', 'status', 'uploaded_at', 'uploaded_by', 'size_bytes'] })
        : noteSheet('No documents attached.');
    },
  },

  NP_EXPIRING_STRUCTURE: {
    sheetName: 'Expiring Structure',
    fetch: (ctx) => fetchJson(`${npBase(ctx)}/np/expiring`, ctx.signal),
    build: (data) => autoSheet(data),
  },

  NP_STRUCTURE: {
    sheetName: 'Structure',
    fetch: (ctx) => fetchJson(`${treatyBase(ctx)}/non-prop`, ctx.signal),
    build: (data) => {
      if (!data) return noteSheet('No saved structure.');
      const out = [];
      const layers = Array.isArray(data.layers) ? data.layers : [];
      out.push({
        name: 'Layers',
        aoa: layers.length
          ? tableSheet(layers, {
              columns: ['layer_number', 'layer_limit', 'attachment', 'risk_cover', 'cat_cover',
                'num_reinstatements', 'reinstatement_pct', 'rol', 'share_pct', 'egnpi'],
            })
          : noteSheet('No layers.'),
      });
      if (data.detail) out.push({ name: 'Detail', aoa: kvSheet(data.detail, { skip: ['contract_id'] }) });
      return out;
    },
  },

  NP_PREMIUMS_TABLE: {
    sheetName: 'Premiums & Inflation',
    fetch: (ctx) => fetchJson(`${npBase(ctx)}/np/egnpi-year`, ctx.signal),
    build: (data) => {
      const rows = Array.isArray(data) ? data : (data?.rows || []);
      return rows.length
        ? tableSheet(rows, { columns: ['uw_year', 'egnpi', 'inflation_pct', 'rate_change_pct'] })
        : noteSheet('No premium / inflation rows saved.');
    },
  },

  NP_LARGE_LOSS_LIST: {
    sheetName: 'Large Loss List',
    fetch: (ctx) => fetchJson(`${treatyBase(ctx)}/large-losses`, ctx.signal),
    build: (data) => {
      const losses = data?.losses || [];
      return losses.length
        ? tableSheet(losses, {
            columns: ['uw_year', 'insured_name', 'loss_name', 'date_of_loss', 'class_of_business',
              'paid', 'os', 'incurred', 'inflation_factor', 'is_selected'],
          })
        : noteSheet('No large losses recorded.');
    },
  },

  NP_LARGE_LOSS_SELECTION: {
    sheetName: 'Large Loss Selection',
    fetch: (ctx) => fetchJson(`${treatyBase(ctx)}/loss-selection/LARGE/latest`, ctx.signal),
    build: (data) => autoSheet(data),
  },

  NP_LARGE_LOSS_PARETO: {
    sheetName: 'Large Loss Pareto',
    build: () => noteSheet('Pareto curve is derived on-screen from the selected large losses (see Large Loss Selection). No separate persisted state.'),
  },

  NP_LARGE_LOSS_DEV_FACTORS: {
    sheetName: 'Large Loss Dev Factors',
    fetch: (ctx) => fetchJson(`${npBase(ctx)}/np/large-loss-ldfs`, ctx.signal),
    build: (data) => ldfSheets(data),
  },

  NP_CAT_LOSS_LIST: {
    sheetName: 'Cat Loss List',
    fetch: (ctx) => fetchJson(`${treatyBase(ctx)}/cat-losses`, ctx.signal),
    build: (data) => {
      const losses = data?.losses || [];
      return losses.length ? tableSheet(losses) : noteSheet('No cat losses recorded.');
    },
  },

  NP_CAT_LOSS_SELECTION: {
    sheetName: 'Cat Loss Selection',
    fetch: (ctx) => fetchJson(`${treatyBase(ctx)}/loss-selection/CAT/latest`, ctx.signal),
    build: (data) => autoSheet(data),
  },

  NP_CAT_LOSS_PARETO: {
    sheetName: 'Cat Loss Pareto',
    build: () => noteSheet('Pareto curve is derived on-screen from the selected cat losses (see Cat Loss Selection). No separate persisted state.'),
  },

  NP_CAT_LOSS_DEV_FACTORS: {
    sheetName: 'Cat Loss Dev Factors',
    fetch: (ctx) => fetchJson(`${npBase(ctx)}/np/cat-loss-ldfs`, ctx.signal),
    build: (data) => ldfSheets(data),
  },

  NP_EXCESS_DEV_FACTORS: {
    sheetName: 'Excess Dev Factors',
    fetch: (ctx) => fetchJson(`${npBase(ctx)}/np/excess-ldfs`, ctx.signal),
    build: (data) => autoSheet(data),
  },

  NP_HISTORICAL_PERFORMANCE: {
    sheetName: 'Historical Performance',
    fetch: (ctx) => fetchJson(`${npBase(ctx)}/np/historical-performance`, ctx.signal),
    build: (data) => autoSheet(data),
  },

  NP_RISK_PROFILE: {
    sheetName: 'Risk Profile',
    build: () => noteSheet('Risk profile is captured per class of business; export it from the Risk Profile screen for the relevant COB.'),
  },

  NP_CLAIMS_PROFILE: {
    sheetName: 'Claims Profile',
    build: () => noteSheet('Claims profile is captured per class of business; export it from the Claims Profile screen for the relevant COB.'),
  },

  NP_CRESTA_AGGREGATES: {
    sheetName: 'CRESTA Aggregates',
    fetch: (ctx) => fetchJson(`${treatyBase(ctx)}/cresta`, ctx.signal),
    build: (data) => {
      const rows = Array.isArray(data) ? data : (data?.rows || []);
      return rows.length ? tableSheet(rows) : noteSheet('No CRESTA aggregates saved.');
    },
  },

  NP_EVENT_LOSS_TABLES: {
    sheetName: 'Event Loss Tables',
    build: () => noteSheet('Event loss tables are managed on-screen; not part of the contract persistence exported here.'),
  },

  NP_STOP_LOSS_PRICING: {
    sheetName: 'Stop Loss Pricing',
    fetch: (ctx) => fetchJson(`${npBase(ctx)}/np/stop-loss-pricing`, ctx.signal),
    build: (data) => autoSheet(data),
  },

  // Terminal screens: figures are computed in-memory at this point, so the
  // caller passes them through ctx.finalData and we reuse the exact builder
  // the per-screen export uses.
  NP_FINAL_PRICING: {
    sheetName: 'Final Pricing',
    build: (_data, ctx) => buildNpPricingSheets(ctx.finalData || {}),
  },
  NP_FINAL_QUOTE: {
    sheetName: 'Final Quote',
    build: (_data, ctx) => buildNpPricingSheets(ctx.finalData || {}),
  },
};

/**
 * Export the whole NP contract as one ordered workbook.
 *
 * @param {object} args
 * @param {string}  args.contractId
 * @param {boolean} args.isQuote
 * @param {object}  args.finalData    the object already assembled for the
 *                                    per-screen export (layers, quoteStructures,
 *                                    header fields, programmeRows, …)
 * @param {object}  args.npDetail     in-memory treaty-detail slice
 * @param {object} [args.flags]       { catDisabled, riskDisabled, npStopLoss }
 *                                    so order matches the live wizard exactly
 * @param {AbortSignal} [args.signal]
 */
export async function exportNpContractWorkbook({ contractId, isQuote, finalData = {}, npDetail = {}, flags = {}, signal }) {
  const routeKey = isQuote ? 'NP_FINAL_QUOTE' : 'NP_FINAL_PRICING';
  const { order } = getWizardNav(routeKey, {
    wizardMode: 'NP',
    quoteMode: !!isQuote,
    npCatDisabled: !!flags.catDisabled,
    npRiskDisabled: !!flags.riskDisabled,
    npStopLoss: !!flags.npStopLoss,
  });
  // Ensure the terminal pricing step is present even if a flag combination
  // filtered it (defensive: the button only renders on that screen).
  const fullOrder = order.includes(routeKey) ? order : [...order, routeKey];

  const header = {
    cedantName: finalData.cedantName || npDetail.cedantName || '',
    countryName: finalData.countryName || npDetail.countryName || '',
    uwYear: finalData.uwYear || npDetail.startYear || '',
    treatyTypeStr: finalData.treatyTypeStr || npDetail.treatyTypeName || npDetail.treatyType || '',
    modeLabel: `Non-Proportional${isQuote ? ' (Quote)' : ''}${finalData.mode ? ` — ${finalData.mode}` : ''}`,
    currency: finalData.currency || npDetail.currencyCode || npDetail.currency || 'SAR',
  };

  const safeCedant = (header.cedantName || 'Export').replace(/\s+/g, '_');
  const filename = `Universe_NP_${safeCedant}_${header.uwYear || new Date().getFullYear()}.xlsx`;

  return buildContractWorkbook({
    contractId,
    order: fullOrder,
    labels: STEP_LABELS,
    registry: NP_SCREEN_EXPORTERS,
    ctx: { isQuote, finalData, npDetail, header },
    header,
    filename,
    signal,
  });
}
