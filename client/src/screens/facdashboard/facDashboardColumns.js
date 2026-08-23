// client/src/screens/facdashboard/facDashboardColumns.js
// Single source of truth for the FAC dashboard's table/pivot columns — the fac
// twin of dashboardColumns.js. Both the on-screen tables (FacDashboardScreen)
// and the shared Excel exporter (dashboard/dashboardExport) read these, so a
// label can never drift between what's shown and what's filed.
//
//   kind ∈ 'money' | 'pct' | 'permille' | 'mult' | 'int' | 'text'
//   The fac book prices in rate per mille, so the proportional headline is
//   Rate ‰ (premium ÷ sum insured × 1000) where the treaty dashboard shows
//   Balance ×; ROL stays the XL headline.

export const FAC_REGION_COLS = [
  { key: 'region', label: 'Region', kind: 'text' },
  { key: 'premium', label: 'Premium', kind: 'money' },
  { key: 'exposure', label: 'Exposure', kind: 'money' },
  { key: 'rate', label: 'Rate ‰', kind: 'permille' },
  { key: 'rol', label: 'ROL', kind: 'pct' },
  { key: 'uwMargin', label: 'UW Margin', kind: 'pct' },
  { key: 'portfolioPct', label: '% of Portfolio', kind: 'pct' },
];

// Class tables share the region columns, keyed/labelled by fac class.
export const FAC_LOB_COLS = [
  { key: 'lob', label: 'Class of Business', kind: 'text' },
  ...FAC_REGION_COLS.slice(1),
];

export const FAC_BY_YEAR_COLS = [
  { key: 'uwYear', label: 'UW Year', kind: 'int' },
  { key: 'premium', label: 'Premium', kind: 'money' },
  { key: 'exposure', label: 'Exposure', kind: 'money' },
  { key: 'rate', label: 'Rate ‰', kind: 'permille' },
  { key: 'rol', label: 'ROL', kind: 'pct' },
  { key: 'uwMargin', label: 'UW Margin', kind: 'pct' },
];

export const FAC_ROL_BAND_COLS = [
  { key: 'band', label: 'ROL Band', kind: 'text' },
  { key: 'risks', label: 'Risks', kind: 'int' },
  { key: 'premium', label: 'Premium', kind: 'money' },
  { key: 'exposure', label: 'Exposure', kind: 'money' },
  { key: 'rol', label: 'Avg ROL', kind: 'pct' },
  { key: 'uwMargin', label: 'Avg UW Margin', kind: 'pct' },
];

export const FAC_RATE_BAND_COLS = [
  { key: 'band', label: 'Rate Band', kind: 'text' },
  { key: 'risks', label: 'Risks', kind: 'int' },
  { key: 'premium', label: 'Premium', kind: 'money' },
  { key: 'exposure', label: 'Exposure', kind: 'money' },
  { key: 'rate', label: 'Avg Rate ‰', kind: 'permille' },
  { key: 'uwMargin', label: 'Avg UW Margin', kind: 'pct' },
];

export const FAC_TYPE_COLS = [
  { key: 'facType', label: 'FAC Type', kind: 'text' },
  { key: 'premium', label: 'Premium', kind: 'money' },
  { key: 'exposure', label: 'Exposure', kind: 'money' },
  { key: 'rol', label: 'Avg ROL', kind: 'pct' },
  { key: 'rate', label: 'Avg Rate ‰', kind: 'permille' },
  { key: 'uwMargin', label: 'Avg UW Margin', kind: 'pct' },
];

// Headline KPI tiles (shown above every tab) → Metric | Value export sheet.
export const FAC_KPI_ROWS = [
  { key: 'risks', label: 'Risks', kind: 'int' },
  { key: 'premium', label: 'Premium', kind: 'money' },
  { key: 'exposure', label: 'Exposure', kind: 'money' },
  { key: 'rate', label: 'Avg Rate (Prop)', kind: 'permille' },
  { key: 'avgRol', label: 'Avg ROL (XL)', kind: 'pct' },
  { key: 'avgUwMargin', label: 'Avg UW Margin', kind: 'pct' },
];

export const FAC_MONTH_SERIES_COLS = [
  { key: 'month', label: 'Month', kind: 'text' },
  { key: 'value', label: 'Premium', kind: 'money' },
];

const KPIS_BLOCK = { sheet: 'KPIs', type: 'kpis', key: 'kpis', cols: FAC_KPI_ROWS };

// Both technical-analysis tabs render the same blocks.
const TECHNICAL_BLOCKS = [
  KPIS_BLOCK,
  { sheet: 'XL Premiums by ROL Band', type: 'table', key: 'rolBands', cols: FAC_ROL_BAND_COLS },
  { sheet: 'Prop Prem by Rate Band', type: 'table', key: 'rateBands', cols: FAC_RATE_BAND_COLS },
  { sheet: 'FAC Type Breakdown', type: 'table', key: 'byFacType', cols: FAC_TYPE_COLS },
  { sheet: 'FAC Premium by Year', type: 'pivot', key: 'facTypePremiumByYear', kind: 'money', rowLabel: 'FAC Type' },
  { sheet: 'FAC Rate by Year', type: 'pivot', key: 'facTypeRateByYear', kind: 'permille', rowLabel: 'FAC Type' },
  { sheet: 'FAC ROL by Year', type: 'pivot', key: 'facTypeRolByYear', kind: 'pct', rowLabel: 'FAC Type' },
  { sheet: 'FAC UW Margin by Year', type: 'pivot', key: 'facTypeUwMarginByYear', kind: 'pct', rowLabel: 'FAC Type' },
];

// Per-tab export manifest: blocks in on-screen display order. Sheet names are
// <= 31 chars and Excel-safe; the exporter skips any absent/empty block.
export const FAC_DASHBOARD_EXPORT_MANIFEST = {
  'portfolio-overview': [
    KPIS_BLOCK,
    { sheet: 'Premium by Month', type: 'series', key: 'series.premiumByMonth', cols: FAC_MONTH_SERIES_COLS },
    { sheet: 'Summary by Region', type: 'table', key: 'summaryByRegion', cols: FAC_REGION_COLS },
    { sheet: 'Summary by Class', type: 'table', key: 'summaryByLob', cols: FAC_LOB_COLS },
    { sheet: 'Premium (Region×FAC)', type: 'pivot', key: 'premiumRegionFacType', kind: 'money', rowLabel: 'Region' },
    { sheet: 'Exposure (Region×FAC)', type: 'pivot', key: 'exposureRegionFacType', kind: 'money', rowLabel: 'Region' },
    { sheet: 'UW Margin (Region×FAC)', type: 'pivot', key: 'uwMarginRegionFacType', kind: 'pct', rowLabel: 'Region' },
    { sheet: 'Composition (Reg×FAC)', type: 'pivot', key: 'compositionRegionFacType', kind: 'pct', rowLabel: 'Region' },
    { sheet: 'Premium (Class×FAC)', type: 'pivot', key: 'premiumLobFacType', kind: 'money', rowLabel: 'Class of Business' },
    { sheet: 'Exposure (Class×FAC)', type: 'pivot', key: 'exposureLobFacType', kind: 'money', rowLabel: 'Class of Business' },
    { sheet: 'Mix (Class×FAC)', type: 'pivot', key: 'compositionLobFacType', kind: 'pct', rowLabel: 'Class of Business' },
    { sheet: 'UW Margin (Class×FAC)', type: 'pivot', key: 'uwMarginLobFacType', kind: 'pct', rowLabel: 'Class of Business' },
    { sheet: 'Premium (Class×Region)', type: 'pivot', key: 'premiumLobRegion', kind: 'money', rowLabel: 'Class of Business' },
    { sheet: 'UW Margin (Class×Region)', type: 'pivot', key: 'uwMarginLobRegion', kind: 'pct', rowLabel: 'Class of Business' },
  ],
  'portfolio-summary': [
    KPIS_BLOCK,
    { sheet: 'Premium by Region×Year', type: 'pivot', key: 'regionYear', kind: 'money', rowLabel: 'Region' },
    { sheet: 'Summary by Year', type: 'table', key: 'byYear', cols: FAC_BY_YEAR_COLS },
  ],
  'regional-analysis': [
    KPIS_BLOCK,
    { sheet: 'Summary by Year', type: 'table', key: 'byYear', cols: FAC_BY_YEAR_COLS },
    { sheet: 'Summary by Class', type: 'table', key: 'byLob', cols: FAC_LOB_COLS },
    { sheet: 'Premium (Class×FAC)', type: 'pivot', key: 'lobFacTypePremium', kind: 'money', rowLabel: 'Class of Business' },
    { sheet: 'Exposure (Class×FAC)', type: 'pivot', key: 'lobFacTypeExposure', kind: 'money', rowLabel: 'Class of Business' },
    { sheet: 'Composition (Class×FAC)', type: 'pivot', key: 'lobFacTypeComposition', kind: 'pct', rowLabel: 'Class of Business' },
    { sheet: 'UW Margin (Class×FAC)', type: 'pivot', key: 'lobFacTypeUwMargin', kind: 'pct', rowLabel: 'Class of Business' },
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
