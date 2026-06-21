// src/screens/proportional/pricing/propWorkbookExporters.js
// ─────────────────────────────────────────────────────────────────────────
// Proportional flow registry for the whole-contract Excel exporter.
//
// Maps every PROP wizard step -> how to fetch its persisted data and how to
// render it. Order comes from getWizardNav(...).order so the sequence tracks
// the live wizard (including the triangulation on/off branch).
// ─────────────────────────────────────────────────────────────────────────

import {
  buildContractWorkbook, fetchJson, tableSheet, kvSheet, autoSheet, noteSheet,
} from '../../../utils/contractWorkbook';
import { buildPropPricingSheets } from './exportPropPricingToExcel.js';
import { getWizardNav, STEP_LABELS } from '../../../config/wizard';

const entityBase = ({ contractId, isQuote }) => (isQuote ? `/api/quotes/${contractId}` : `/api/treaties/${contractId}`);

const triangleStep = (type, label) => ({
  sheetName: label,
  fetch: (ctx) => fetchJson(`${entityBase(ctx)}/triangles/${type}`, ctx.signal),
  build: (data) => {
    const rows = Array.isArray(data) ? data : (data?.rows || data?.cells || []);
    return rows.length ? tableSheet(rows) : noteSheet('No triangle saved for this basis.');
  },
});

const devFactorStep = (type, label) => ({
  sheetName: label,
  fetch: (ctx) => fetchJson(`${entityBase(ctx)}/dev-factors/${type}`, ctx.signal),
  build: (data) => {
    const rows = Array.isArray(data) ? data : (data?.rows || []);
    return rows.length
      ? tableSheet(rows, {
          columns: ['dev_month', 'chosen_source', 'selected_ldf', 'selected_cdf',
            'actual_ldf', 'actual_cdf', 'param_ldf', 'param_cdf',
            'chosen_ldf', 'chosen_cdf', 'overridden'],
        })
      : noteSheet('No development factors saved for this basis.');
  },
});

export const PROP_SCREEN_EXPORTERS = {
  PROP_TREATY_DETAIL: {
    sheetName: 'Treaty Detail',
    fetch: (ctx) => fetchJson(`${entityBase(ctx)}`, ctx.signal),
    build: (fetched, ctx) => {
      const merged = { ...(fetched || {}), ...(ctx.propDetail || {}), ...(ctx.header || {}) };
      return kvSheet(merged, {
        skip: ['id', 'contractId', 'contract_id', 'createdAt', 'updatedAt', 'updated_at', 'created_at'],
      });
    },
  },

  PROP_TREATY_DOCUMENTS: {
    sheetName: 'Documents',
    fetch: (ctx) => fetchJson(`${entityBase(ctx)}/documents`, ctx.signal),
    build: (data) => {
      const rows = Array.isArray(data) ? data : (data?.documents || data?.files || []);
      return rows.length
        ? tableSheet(rows, { columns: ['file_name', 'doc_type', 'status', 'uploaded_at', 'uploaded_by', 'size_bytes'] })
        : noteSheet('No documents attached.');
    },
  },

  PROP_NO_TRIANGULATION: {
    sheetName: 'Experience (No Triangulation)',
    fetch: (ctx) => fetchJson(`/api/straight-stats/load/${ctx.contractId}`, ctx.signal),
    build: (data) => autoSheet(data),
  },

  PROP_PREMIUM_TRIANGLES:        triangleStep('PREMIUM', 'Premium Triangle'),
  PROP_CLAIMS_PAID_TRIANGLES:    triangleStep('CLAIMS_PAID', 'Claims Paid Triangle'),
  PROP_OS_CLAIMS_TRIANGLES:      triangleStep('CLAIMS_OS', 'OS Claims Triangle'),
  PROP_INCURRED_CLAIMS_TRIANGLES:triangleStep('INCURRED', 'Incurred Triangle'),

  PROP_LARGE_LOSS_LIST: {
    sheetName: 'Large Loss List',
    fetch: (ctx) => fetchJson(`${entityBase(ctx)}/large-losses`, ctx.signal),
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
  PROP_LARGE_LOSS_SELECTION: {
    sheetName: 'Large Loss Selection',
    fetch: (ctx) => fetchJson(`${entityBase(ctx)}/loss-selection/LARGE/latest`, ctx.signal),
    build: (data) => autoSheet(data),
  },
  PROP_LARGE_LOSS_PARETO: {
    sheetName: 'Large Loss Pareto',
    build: () => noteSheet('Pareto curve is derived on-screen from the selected large losses (see Large Loss Selection).'),
  },

  PROP_CAT_LOSS_LIST: {
    sheetName: 'Cat Loss List',
    fetch: (ctx) => fetchJson(`${entityBase(ctx)}/cat-losses`, ctx.signal),
    build: (data) => {
      const losses = data?.losses || [];
      return losses.length ? tableSheet(losses) : noteSheet('No cat losses recorded.');
    },
  },
  PROP_CAT_LOSS_SELECTION: {
    sheetName: 'Cat Loss Selection',
    fetch: (ctx) => fetchJson(`${entityBase(ctx)}/loss-selection/CAT/latest`, ctx.signal),
    build: (data) => autoSheet(data),
  },
  PROP_CAT_LOSS_PARETO: {
    sheetName: 'Cat Loss Pareto',
    build: () => noteSheet('Pareto curve is derived on-screen from the selected cat losses (see Cat Loss Selection).'),
  },

  PROP_PREMIUM_DEV_FACTORS:     devFactorStep('PREMIUM', 'Premium Dev Factors'),
  PROP_PAID_CLAIMS_DEV_FACTORS: devFactorStep('CLAIMS_PAID', 'Paid Claims Dev Factors'),
  PROP_OS_CLAIMS_DEV_FACTORS:   devFactorStep('CLAIMS_OS', 'OS Claims Dev Factors'),
  PROP_INCURRED_DEV_FACTORS:    devFactorStep('INCURRED', 'Incurred Dev Factors'),

  PROP_PROJECTED_SUMMARY: {
    sheetName: 'Projected Summary',
    fetch: (ctx) => fetchJson(`${entityBase(ctx)}/pricing-yearly`, ctx.signal),
    build: (data) => autoSheet(data),
  },
  PROP_QUICK_SUMMARY: {
    sheetName: 'Quick Summary',
    fetch: (ctx) => fetchJson(`${entityBase(ctx)}/pricing-outputs`, ctx.signal),
    build: (data) => autoSheet(data),
  },

  PROP_RISK_PROFILE: {
    sheetName: 'Risk Profile',
    build: () => noteSheet('Risk profile is captured per class of business; export it from the Risk Profile screen for the relevant COB.'),
  },
  PROP_CLAIMS_PROFILE: {
    sheetName: 'Claims Profile',
    build: () => noteSheet('Claims profile is captured per class of business; export it from the Claims Profile screen for the relevant COB.'),
  },

  PROP_CRESTA_AGGREGATES: {
    sheetName: 'CRESTA Aggregates',
    fetch: (ctx) => fetchJson(`${entityBase(ctx)}/cresta`, ctx.signal),
    build: (data) => {
      const rows = Array.isArray(data) ? data : (data?.rows || []);
      return rows.length ? tableSheet(rows) : noteSheet('No CRESTA aggregates saved.');
    },
  },
  PROP_EVENT_LOSS_TABLES: {
    sheetName: 'Event Loss Tables',
    build: () => noteSheet('Event loss tables are managed on-screen; not part of the contract persistence exported here.'),
  },

  PROP_PRICING: {
    sheetName: 'Pricing',
    build: (_data, ctx) => buildPropPricingSheets(ctx.finalData || {}),
  },
};

/**
 * Export the whole Proportional contract as one ordered workbook.
 *
 * @param {object} args
 * @param {string}  args.contractId
 * @param {object}  args.finalData    object already assembled for the per-screen
 *                                    prop export (components, yearly, epiSplit,
 *                                    shareRows, shareGrid, leads, …)
 * @param {object}  args.propDetail   in-memory treaty-detail slice
 * @param {boolean} [args.isQuote]    use quote endpoints instead of treaty endpoints
 * @param {boolean} [args.triangulationsEnabled=true]
 * @param {AbortSignal} [args.signal]
 */
export async function exportPropContractWorkbook({
  contractId,
  finalData = {},
  propDetail = {},
  isQuote = !!finalData.isQuote,
  triangulationsEnabled = true,
  signal,
}) {
  const { order } = getWizardNav('PROP_PRICING', { wizardMode: 'PROP', triangulationsEnabled });
  const fullOrder = order.includes('PROP_PRICING') ? order : [...order, 'PROP_PRICING'];

  const header = {
    cedantName: finalData.cedantName || propDetail.cedantName || '',
    countryName: finalData.countryName || propDetail.countryName || '',
    uwYear: finalData.uwYear || propDetail.startYear || propDetail.uwYear || '',
    treatyTypeStr: finalData.treatyType || propDetail.treatyTypeName || propDetail.treatyType || '',
    modeLabel: 'Proportional',
    currency: finalData.currency || propDetail.currencyCode || propDetail.currency || 'SAR',
  };

  const safeCedant = (header.cedantName || 'Export').replace(/\s+/g, '_');
  const filename = `Universe_Prop_${safeCedant}_${header.uwYear || new Date().getFullYear()}.xlsx`;

  return buildContractWorkbook({
    contractId,
    order: fullOrder,
    labels: STEP_LABELS,
    registry: PROP_SCREEN_EXPORTERS,
    ctx: { isQuote, finalData, propDetail, header },
    header,
    filename,
    signal,
  });
}
