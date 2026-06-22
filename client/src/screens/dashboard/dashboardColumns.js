// client/src/screens/dashboard/dashboardColumns.js
// Single source of truth for the dashboard's table/pivot columns. Both the
// on-screen tables (DashboardScreen) and the Excel exporter (dashboardExport)
// read these, so a label can never drift between what's shown and what's filed.
//
//   kind ∈ 'money' | 'pct' | 'mult' | 'int' | 'text'
//   - screen: maps kind → display formatter (fm / fp / fmtBal / fmtNum)
//   - export: maps kind → Excel numFmt; raw numeric values are written, never
//             the formatted strings, so the file stays analyzable.

export const REGION_COLS = [
  { key: 'region', label: 'Region', kind: 'text' },
  { key: 'premium', label: 'Premium', kind: 'money' },
  { key: 'exposure', label: 'Exposure', kind: 'money' },
  { key: 'balance', label: 'Balance', kind: 'mult' },
  { key: 'rol', label: 'ROL', kind: 'pct' },
  { key: 'uwMargin', label: 'UW Margin', kind: 'pct' },
  { key: 'portfolioPct', label: '% of Portfolio', kind: 'pct' },
];

// LOB tables share the region columns, just keyed/labelled by line of business.
export const LOB_COLS = [
  { key: 'lob', label: 'Line of Business', kind: 'text' },
  ...REGION_COLS.slice(1),
];

export const BY_YEAR_COLS = [
  { key: 'uwYear', label: 'UW Year', kind: 'int' },
  { key: 'premium', label: 'Premium', kind: 'money' },
  { key: 'exposure', label: 'Exposure', kind: 'money' },
  { key: 'balance', label: 'Balance', kind: 'mult' },
  { key: 'rol', label: 'ROL', kind: 'pct' },
  { key: 'uwMargin', label: 'UW Margin', kind: 'pct' },
];

export const ROL_BAND_COLS = [
  { key: 'band', label: 'ROL Band', kind: 'text' },
  { key: 'contracts', label: 'Policies', kind: 'int' },
  { key: 'premium', label: 'Premium', kind: 'money' },
  { key: 'exposure', label: 'Exposure', kind: 'money' },
  { key: 'rol', label: 'Avg ROL', kind: 'pct' },
  { key: 'uwMargin', label: 'Avg UW Margin', kind: 'pct' },
];

export const BALANCE_BAND_COLS = [
  { key: 'band', label: 'Balance Band', kind: 'text' },
  { key: 'contracts', label: 'Policies', kind: 'int' },
  { key: 'premium', label: 'Premium', kind: 'money' },
  { key: 'exposure', label: 'Exposure', kind: 'money' },
  { key: 'balance', label: 'Avg Balance', kind: 'mult' },
  { key: 'uwMargin', label: 'Avg UW Margin', kind: 'pct' },
];

export const TREATY_TYPE_COLS = [
  { key: 'treatyType', label: 'Treaty Type', kind: 'text' },
  { key: 'premium', label: 'Premium', kind: 'money' },
  { key: 'exposure', label: 'Exposure', kind: 'money' },
  { key: 'rol', label: 'Avg ROL', kind: 'pct' },
  { key: 'balance', label: 'Avg Balance', kind: 'mult' },
  { key: 'uwMargin', label: 'Avg UW Margin', kind: 'pct' },
];

// Headline KPI tiles (shown above every tab) → Metric | Value export sheet.
export const KPI_ROWS = [
  { key: 'contracts', label: 'Contracts', kind: 'int' },
  { key: 'premium', label: 'Premium', kind: 'money' },
  { key: 'exposure', label: 'Exposure', kind: 'money' },
  { key: 'balance', label: 'Treaty Balance', kind: 'mult' },
  { key: 'avgRol', label: 'Avg ROL', kind: 'pct' },
  { key: 'avgUwMargin', label: 'Avg UW Margin', kind: 'pct' },
];

export const MONTH_SERIES_COLS = [
  { key: 'month', label: 'Month', kind: 'text' },
  { key: 'value', label: 'Premium', kind: 'money' },
];

const KPIS_BLOCK = { sheet: 'KPIs', type: 'kpis', key: 'kpis', cols: KPI_ROWS };

// Both technical-analysis tabs render the same blocks.
const TECHNICAL_BLOCKS = [
  KPIS_BLOCK,
  { sheet: 'NP Premiums by ROL Band', type: 'table', key: 'rolBands', cols: ROL_BAND_COLS },
  { sheet: 'Prop Prem by Balance Band', type: 'table', key: 'balanceBands', cols: BALANCE_BAND_COLS },
  { sheet: 'Treaty Type Breakdown', type: 'table', key: 'byTreatyType', cols: TREATY_TYPE_COLS },
  { sheet: 'Treaty Premium by Year', type: 'pivot', key: 'treatyPremiumByYear', kind: 'money', rowLabel: 'Treaty Type' },
  { sheet: 'Treaty Balance by Year', type: 'pivot', key: 'treatyBalanceByYear', kind: 'mult', rowLabel: 'Treaty Type' },
  { sheet: 'Treaty ROL by Year', type: 'pivot', key: 'treatyRolByYear', kind: 'pct', rowLabel: 'Treaty Type' },
  { sheet: 'Treaty UW Margin by Year', type: 'pivot', key: 'treatyUwMarginByYear', kind: 'pct', rowLabel: 'Treaty Type' },
];

// Per-tab export manifest: blocks listed in on-screen display order. Sheet
// names are <= 31 chars and Excel-safe; the exporter skips any absent/empty
// block. 'kind' on a pivot block applies to every value cell.
export const DASHBOARD_EXPORT_MANIFEST = {
  'portfolio-overview': [
    KPIS_BLOCK,
    { sheet: 'Premium by Month', type: 'series', key: 'series.premiumByMonth', cols: MONTH_SERIES_COLS },
    { sheet: 'Summary by Region', type: 'table', key: 'summaryByRegion', cols: REGION_COLS },
    { sheet: 'Summary by LOB', type: 'table', key: 'summaryByLob', cols: LOB_COLS },
    { sheet: 'Premium (Region×Treaty)', type: 'pivot', key: 'premiumRegionTreaty', kind: 'money', rowLabel: 'Region' },
    { sheet: 'Exposure (Region×Treaty)', type: 'pivot', key: 'exposureRegionTreaty', kind: 'money', rowLabel: 'Region' },
    { sheet: 'UW Margin (Region×Treaty)', type: 'pivot', key: 'uwMarginRegionTreaty', kind: 'pct', rowLabel: 'Region' },
    { sheet: 'Composition (Reg×Treaty)', type: 'pivot', key: 'compositionRegionTreaty', kind: 'pct', rowLabel: 'Region' },
    { sheet: 'Premium (LOB×Treaty)', type: 'pivot', key: 'premiumLobTreaty', kind: 'money', rowLabel: 'Line of Business' },
    { sheet: 'Exposure (LOB×Treaty)', type: 'pivot', key: 'exposureLobTreaty', kind: 'money', rowLabel: 'Line of Business' },
    { sheet: 'Mix (LOB×Treaty)', type: 'pivot', key: 'compositionLobTreaty', kind: 'pct', rowLabel: 'Line of Business' },
    { sheet: 'UW Margin (LOB×Treaty)', type: 'pivot', key: 'uwMarginLobTreaty', kind: 'pct', rowLabel: 'Line of Business' },
    { sheet: 'Premium (LOB×Region)', type: 'pivot', key: 'premiumLobRegion', kind: 'money', rowLabel: 'Line of Business' },
    { sheet: 'UW Margin (LOB×Region)', type: 'pivot', key: 'uwMarginLobRegion', kind: 'pct', rowLabel: 'Line of Business' },
  ],
  'portfolio-summary': [
    KPIS_BLOCK,
    { sheet: 'Premium by Region×Year', type: 'pivot', key: 'regionYear', kind: 'money', rowLabel: 'Region' },
    { sheet: 'Summary by Year', type: 'table', key: 'byYear', cols: BY_YEAR_COLS },
  ],
  'regional-analysis': [
    KPIS_BLOCK,
    { sheet: 'Summary by Year', type: 'table', key: 'byYear', cols: BY_YEAR_COLS },
    { sheet: 'Summary by LOB', type: 'table', key: 'byLob', cols: LOB_COLS },
    { sheet: 'Premium (LOB×Treaty)', type: 'pivot', key: 'lobTreatyPremium', kind: 'money', rowLabel: 'Line of Business' },
    { sheet: 'Exposure (LOB×Treaty)', type: 'pivot', key: 'lobTreatyExposure', kind: 'money', rowLabel: 'Line of Business' },
    { sheet: 'Composition (LOB×Trty)', type: 'pivot', key: 'lobTreatyComposition', kind: 'pct', rowLabel: 'Line of Business' },
    { sheet: 'UW Margin (LOB×Treaty)', type: 'pivot', key: 'lobTreatyUwMargin', kind: 'pct', rowLabel: 'Line of Business' },
  ],
  'portfolio-technical-analysis': TECHNICAL_BLOCKS,
  'regional-technical-analysis': TECHNICAL_BLOCKS,
  'return-analysis-proportional': [
    KPIS_BLOCK,
    { sheet: 'Return per Unit Risk', type: 'pivot', key: 'propReturnPerUnitRisk', kind: 'pct', rowLabel: 'Region' },
    { sheet: 'Portfolio Premium', type: 'pivot', key: 'propPortfolioPremium', kind: 'money', rowLabel: 'Region' },
    { sheet: 'Portfolio %', type: 'pivot', key: 'propPortfolioPct', kind: 'pct', rowLabel: 'Region' },
  ],
  'return-analysis-nonproportional': [
    KPIS_BLOCK,
    { sheet: 'Return per Unit Risk', type: 'pivot', key: 'npReturnPerUnitRisk', kind: 'pct', rowLabel: 'Region' },
    { sheet: 'Portfolio Premium', type: 'pivot', key: 'npPortfolioPremium', kind: 'money', rowLabel: 'Region' },
    { sheet: 'Portfolio %', type: 'pivot', key: 'npPortfolioPct', kind: 'pct', rowLabel: 'Region' },
  ],
};
