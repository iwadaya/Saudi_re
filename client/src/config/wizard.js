// src/config/wizard.js — Wizard step definitions, navigation logic

export const PROP_WIZARD_ORDER = [
  'PROP_TREATY_DETAIL',
  'PROP_TREATY_DOCUMENTS',
  'PROP_NO_TRIANGULATION',
  'PROP_PREMIUM_TRIANGLES',
  'PROP_CLAIMS_PAID_TRIANGLES',
  'PROP_OS_CLAIMS_TRIANGLES',
  'PROP_INCURRED_CLAIMS_TRIANGLES',
  // Large/cat losses are identified before dev factors so the factor
  // screens can offer a triangle stripped of those losses (the
  // attritional basis). Summaries consume the selected factors, so they
  // stay immediately after the dev-factor screens.
  'PROP_LARGE_LOSS_LIST',
  'PROP_LARGE_LOSS_SELECTION',
  'PROP_LARGE_LOSS_PARETO',
  'PROP_CAT_LOSS_LIST',
  'PROP_CAT_LOSS_SELECTION',
  'PROP_CAT_LOSS_PARETO',
  'PROP_PREMIUM_DEV_FACTORS',
  'PROP_PAID_CLAIMS_DEV_FACTORS',
  'PROP_OS_CLAIMS_DEV_FACTORS',
  'PROP_INCURRED_DEV_FACTORS',
  'PROP_PROJECTED_SUMMARY',
  'PROP_QUICK_SUMMARY',
  'PROP_RISK_PROFILE',
  'PROP_CLAIMS_PROFILE',
  'PROP_CRESTA_AGGREGATES',
  'PROP_EVENT_LOSS_TABLES',
  'PROP_PRICING',
];

export const NP_WIZARD_ORDER = [
  'NP_TREATY_DETAIL',
  'NP_TREATY_DOCUMENTS',
  'NP_STRUCTURE',
  'NP_PREMIUMS_TABLE',
  'NP_LARGE_LOSS_LIST',
  'NP_LARGE_LOSS_SELECTION',
  'NP_LARGE_LOSS_PARETO',
  'NP_LARGE_LOSS_DEV_FACTORS',
  'NP_CAT_LOSS_LIST',
  'NP_CAT_LOSS_SELECTION',
  'NP_CAT_LOSS_PARETO',
  'NP_CAT_LOSS_DEV_FACTORS',
  'NP_EXCESS_DEV_FACTORS',
  'NP_HISTORICAL_PERFORMANCE',
  'NP_RISK_PROFILE',
  'NP_CLAIMS_PROFILE',
  'NP_CRESTA_AGGREGATES',
  'NP_EVENT_LOSS_TABLES',
  'NP_STOP_LOSS_PRICING',
  'NP_FINAL_PRICING',
];

// Quote workflow — slimmed down per spec. Quotes run as standalone
// artefacts (no path to SIGNED), so the wizard only walks the screens
// needed to produce a quote: treaty detail (cut down — see
// NpTreatyDetail's quote-mode branch), documents, EGNPI/inflation,
// the large/cat loss workflows (kept as 4-step groups so the
// underlying screens are unchanged), historical performance,
// risk profile, CRESTA, and the final quote screen (pending
// redesign in a follow-up).
//
// Removed vs the contract NP wizard: NP_EXPIRING_STRUCTURE,
// NP_STRUCTURE, NP_EXCESS_DEV_FACTORS, NP_CLAIMS_PROFILE,
// NP_EVENT_LOSS_TABLES.
//
// Keep this list in sync with the QUOTE_HIDDEN set in
// components/WizardTabs.jsx — anything dropped here also needs
// hiding there or it will reappear in the left sidebar.
export const NP_QUOTE_WIZARD_ORDER = [
  'NP_TREATY_DETAIL',
  'NP_TREATY_DOCUMENTS',
  'NP_PREMIUMS_TABLE',
  'NP_LARGE_LOSS_LIST',
  'NP_LARGE_LOSS_SELECTION',
  'NP_LARGE_LOSS_PARETO',
  'NP_LARGE_LOSS_DEV_FACTORS',
  'NP_CAT_LOSS_LIST',
  'NP_CAT_LOSS_SELECTION',
  'NP_CAT_LOSS_PARETO',
  'NP_CAT_LOSS_DEV_FACTORS',
  'NP_HISTORICAL_PERFORMANCE',
  'NP_RISK_PROFILE',
  'NP_CRESTA_AGGREGATES',
  'NP_FINAL_QUOTE',
];

// Step labels for display
export const STEP_LABELS = {
  PROP_TREATY_DETAIL: 'Treaty Detail',
  PROP_TREATY_DOCUMENTS: 'Documents',
  PROP_NO_TRIANGULATION: 'Experience (No Triangulation)',
  PROP_PREMIUM_TRIANGLES: 'Premium Triangles',
  PROP_CLAIMS_PAID_TRIANGLES: 'Claims Paid Triangles',
  PROP_OS_CLAIMS_TRIANGLES: 'OS Claims Triangles',
  PROP_INCURRED_CLAIMS_TRIANGLES: 'Incurred Claims Triangles',
  PROP_PREMIUM_DEV_FACTORS: 'Premium Dev Factors',
  PROP_PAID_CLAIMS_DEV_FACTORS: 'Paid Claims Dev Factors',
  PROP_OS_CLAIMS_DEV_FACTORS: 'OS Claims Dev Factors',
  PROP_INCURRED_DEV_FACTORS: 'Incurred Dev Factors',
  PROP_PROJECTED_SUMMARY: 'Projected Summary',
  PROP_QUICK_SUMMARY: 'Quick Summary',
  PROP_LARGE_LOSS_LIST: 'Large Loss List',
  PROP_LARGE_LOSS_SELECTION: 'Large Loss Selection',
  PROP_LARGE_LOSS_PARETO: 'Large Loss Pareto',
  PROP_CAT_LOSS_LIST: 'Cat Loss List',
  PROP_CAT_LOSS_SELECTION: 'Cat Loss Selection',
  PROP_CAT_LOSS_PARETO: 'Cat Loss Pareto',
  PROP_RISK_PROFILE: 'Risk Profile',
  PROP_CLAIMS_PROFILE: 'Claims Profile',
  PROP_CRESTA_AGGREGATES: 'CRESTA Aggregates',
  PROP_EVENT_LOSS_TABLES: 'Event Loss Tables',
  PROP_PRICING: 'Pricing',
  PROP_HISTORY: 'History',
  NP_TREATY_DETAIL: 'Treaty Detail',
  NP_TREATY_DOCUMENTS: 'Documents',
  NP_EXPIRING_STRUCTURE: 'Expiring Structure',
  NP_STRUCTURE: 'Structure',
  NP_PREMIUMS_TABLE: 'Premiums Table',
  NP_EXCESS_DEV_FACTORS: 'Excess Dev Factors',
  NP_HISTORICAL_PERFORMANCE: 'Historical Performance',
  NP_LARGE_LOSS_LIST: 'Large Loss List',
  NP_LARGE_LOSS_SELECTION: 'Large Loss Selection',
  NP_LARGE_LOSS_PARETO: 'Large Loss Pareto',
  NP_LARGE_LOSS_DEV_FACTORS: 'Large Loss Dev Factors',
  NP_CAT_LOSS_LIST: 'Cat Loss List',
  NP_CAT_LOSS_SELECTION: 'Cat Loss Selection',
  NP_CAT_LOSS_PARETO: 'Cat Loss Pareto',
  NP_CAT_LOSS_DEV_FACTORS: 'Cat Loss Dev Factors',
  NP_RISK_PROFILE: 'Risk Profile',
  NP_CLAIMS_PROFILE: 'Claims Profile',
  NP_CRESTA_AGGREGATES: 'CRESTA Aggregates',
  NP_EVENT_LOSS_TABLES: 'Event Loss Tables',
  NP_STOP_LOSS_PRICING: 'Stop Loss Pricing',
  NP_FINAL_PRICING: 'Final Pricing',
  NP_FINAL_QUOTE: 'Final Quote',
  NP_HISTORY: 'History',
  // Facultative
  FAC_RISK_DETAIL: 'Risk Detail',
  FAC_LOCATIONS: 'Locations & SI',
  FAC_COPE: 'COPE Assessment',
  FAC_COVERAGE_STRUCTURE: 'Placement Structure',
  FAC_DEDUCTIBLES: 'Deductibles & Terms',
  FAC_LOSS_HISTORY: 'Loss History',
  FAC_PRICING: 'Pricing',
  FAC_DOCUMENTS: 'Documents',
  FAC_SUMMARY: 'Summary & Approval',
};

// Route key → URL path mapping
export const ROUTE_PATHS = {
  HOME: '/',
  DASHBOARD: '/dashboard',
  LOGIN: '/login',
  CU_APPROVALS: '/approvals',
  PROP_TREATY_DETAIL: '/prop/treaty-detail',
  PROP_TREATY_DOCUMENTS: '/prop/documents',
  PROP_NO_TRIANGULATION: '/prop/no-triangulation',
  PROP_PREMIUM_TRIANGLES: '/prop/premium-triangles',
  PROP_CLAIMS_PAID_TRIANGLES: '/prop/claims-paid-triangles',
  PROP_OS_CLAIMS_TRIANGLES: '/prop/os-claims-triangles',
  PROP_INCURRED_CLAIMS_TRIANGLES: '/prop/incurred-claims-triangles',
  PROP_PREMIUM_DEV_FACTORS: '/prop/premium-dev-factors',
  PROP_PAID_CLAIMS_DEV_FACTORS: '/prop/paid-claims-dev-factors',
  PROP_OS_CLAIMS_DEV_FACTORS: '/prop/os-claims-dev-factors',
  PROP_INCURRED_DEV_FACTORS: '/prop/incurred-dev-factors',
  PROP_PROJECTED_SUMMARY: '/prop/projected-summary',
  PROP_QUICK_SUMMARY: '/prop/quick-summary',
  PROP_LARGE_LOSS_LIST: '/prop/large-loss-list',
  PROP_LARGE_LOSS_SELECTION: '/prop/large-loss-selection',
  PROP_LARGE_LOSS_PARETO: '/prop/large-loss-pareto',
  PROP_CAT_LOSS_LIST: '/prop/cat-loss-list',
  PROP_CAT_LOSS_SELECTION: '/prop/cat-loss-selection',
  PROP_CAT_LOSS_PARETO: '/prop/cat-loss-pareto',
  PROP_RISK_PROFILE: '/prop/risk-profile',
  PROP_CLAIMS_PROFILE: '/prop/claims-profile',
  PROP_CRESTA_AGGREGATES: '/prop/cresta-aggregates',
  PROP_EVENT_LOSS_TABLES: '/prop/event-loss-tables',
  PROP_PRICING: '/prop/pricing',
  PROP_HISTORY: '/prop/history',
  NP_TREATY_DETAIL: '/np/treaty-detail',
  NP_TREATY_DOCUMENTS: '/np/documents',
  NP_EXPIRING_STRUCTURE: '/np/expiring-structure',
  NP_STRUCTURE: '/np/structure',
  NP_PREMIUMS_TABLE: '/np/premiums-table',
  NP_EXCESS_DEV_FACTORS: '/np/excess-dev-factors',
  NP_HISTORICAL_PERFORMANCE: '/np/historical-performance',
  NP_LARGE_LOSS_LIST: '/np/large-loss-list',
  NP_LARGE_LOSS_SELECTION: '/np/large-loss-selection',
  NP_LARGE_LOSS_PARETO: '/np/large-loss-pareto',
  NP_LARGE_LOSS_DEV_FACTORS: '/np/large-loss-dev-factors',
  NP_CAT_LOSS_LIST: '/np/cat-loss-list',
  NP_CAT_LOSS_SELECTION: '/np/cat-loss-selection',
  NP_CAT_LOSS_PARETO: '/np/cat-loss-pareto',
  NP_CAT_LOSS_DEV_FACTORS: '/np/cat-loss-dev-factors',
  NP_RISK_PROFILE: '/np/risk-profile',
  NP_CLAIMS_PROFILE: '/np/claims-profile',
  NP_CRESTA_AGGREGATES: '/np/cresta-aggregates',
  NP_EVENT_LOSS_TABLES: '/np/event-loss-tables',
  NP_STOP_LOSS_PRICING: '/np/stop-loss-pricing',
  NP_FINAL_PRICING: '/np/final-pricing',
  NP_FINAL_QUOTE: '/np/final-quote',
  NP_HISTORY: '/np/history',
  // Facultative
  FAC_RISK_DETAIL: '/fac/risk/detail',
  FAC_LOCATIONS: '/fac/risk/locations',
  FAC_COPE: '/fac/risk/cope',
  FAC_COVERAGE_STRUCTURE: '/fac/risk/structure',
  FAC_DEDUCTIBLES: '/fac/risk/deductibles',
  FAC_LOSS_HISTORY: '/fac/risk/losses',
  FAC_PRICING: '/fac/risk/pricing',
  FAC_DOCUMENTS: '/fac/risk/documents',
  FAC_SUMMARY: '/fac/risk/summary',
};

// Get wizard navigation for a given route key and mode
export function getWizardNav(routeKey, { quoteMode = false, triangulationsEnabled = true, npCatDisabled = false, npRiskDisabled = false, npStopLoss = false } = {}) {
  let order;
  if (routeKey.startsWith('FAC_')) {
    order = [...FAC_WIZARD_ORDER];
  } else if (routeKey.startsWith('NP_')) {
    order = quoteMode ? [...NP_QUOTE_WIZARD_ORDER] : [...NP_WIZARD_ORDER];
    // Filter disabled flows
    if (npCatDisabled) {
      // RISK XL: remove all CAT screens + CRESTA + Event Loss Tables
      order = order.filter(k =>
        !k.startsWith('NP_CAT_LOSS_') &&
        k !== 'NP_CRESTA_AGGREGATES' &&
        k !== 'NP_EVENT_LOSS_TABLES'
      );
    }
    if (npRiskDisabled) {
      // CAT XL: remove all large-loss/risk screens
      order = order.filter(k => !k.startsWith('NP_LARGE_LOSS_'));
    }
    // Stop Loss / Aggregate XL is only meaningful for treaty types
    // that price an aggregate-loss cover — hide the screen elsewhere.
    if (!npStopLoss) {
      order = order.filter(k => k !== 'NP_STOP_LOSS_PRICING');
    } else {
      // For Stop Loss treaties the Final Pricing screen (layer-grid
      // pricing for Risk XL / Cat XL) doesn't apply — the dedicated
      // Stop Loss Pricing step is the terminal pricing surface.
      order = order.filter(k => k !== 'NP_FINAL_PRICING');
    }
  } else {
    order = [...PROP_WIZARD_ORDER];
    // Keep this in sync with WizardTabs.shouldShow(): when triangulations are
    // enabled the No-Triangulation screen is hidden, and when disabled the
    // triangle / dev-factor screens are. Sidebar visibility and Next/Back
    // navigation must agree, or a tab could be clickable but unreachable.
    if (triangulationsEnabled) {
      order = order.filter(k => k !== 'PROP_NO_TRIANGULATION');
    } else {
      order = order.filter(k =>
        !k.includes('TRIANGLES') &&
        !k.includes('DEV_FACTORS')
      );
    }
  }

  const idx = order.indexOf(routeKey);
  if (idx === -1) return { prev: null, next: null, order, index: -1 };
  return {
    prev: idx > 0 ? order[idx - 1] : null,
    next: idx < order.length - 1 ? order[idx + 1] : null,
    order,
    index: idx,
  };
}

// Wizard tab groups for sidebar/tabs display
export const PROP_TAB_GROUPS = [
  { label: 'Setup', keys: ['PROP_TREATY_DETAIL', 'PROP_TREATY_DOCUMENTS'] },
  { label: 'Triangles', keys: ['PROP_PREMIUM_TRIANGLES', 'PROP_CLAIMS_PAID_TRIANGLES', 'PROP_OS_CLAIMS_TRIANGLES', 'PROP_INCURRED_CLAIMS_TRIANGLES'] },
  { label: 'Large Losses', keys: ['PROP_LARGE_LOSS_LIST', 'PROP_LARGE_LOSS_SELECTION', 'PROP_LARGE_LOSS_PARETO'] },
  { label: 'Cat Losses', keys: ['PROP_CAT_LOSS_LIST', 'PROP_CAT_LOSS_SELECTION', 'PROP_CAT_LOSS_PARETO'] },
  { label: 'Dev Factors', keys: ['PROP_PREMIUM_DEV_FACTORS', 'PROP_PAID_CLAIMS_DEV_FACTORS', 'PROP_OS_CLAIMS_DEV_FACTORS', 'PROP_INCURRED_DEV_FACTORS'] },
  { label: 'Summaries', keys: ['PROP_NO_TRIANGULATION', 'PROP_PROJECTED_SUMMARY', 'PROP_QUICK_SUMMARY'] },
  { label: 'Profiles', keys: ['PROP_RISK_PROFILE', 'PROP_CLAIMS_PROFILE'] },
  { label: 'Exposure', keys: ['PROP_CRESTA_AGGREGATES', 'PROP_EVENT_LOSS_TABLES'] },
  { label: 'Pricing', keys: ['PROP_PRICING'] },
  { label: 'Audit', keys: ['PROP_HISTORY'] },
];

export const NP_TAB_GROUPS = [
  { label: 'Setup', keys: ['NP_TREATY_DETAIL', 'NP_TREATY_DOCUMENTS'] },
  { label: 'Structure', keys: ['NP_EXPIRING_STRUCTURE', 'NP_STRUCTURE', 'NP_PREMIUMS_TABLE'] },
  { label: 'Large Losses', keys: ['NP_LARGE_LOSS_LIST', 'NP_LARGE_LOSS_SELECTION', 'NP_LARGE_LOSS_PARETO', 'NP_LARGE_LOSS_DEV_FACTORS'] },
  { label: 'Cat Losses', keys: ['NP_CAT_LOSS_LIST', 'NP_CAT_LOSS_SELECTION', 'NP_CAT_LOSS_PARETO', 'NP_CAT_LOSS_DEV_FACTORS'] },
  { label: 'Experience', keys: ['NP_EXCESS_DEV_FACTORS', 'NP_HISTORICAL_PERFORMANCE'] },
  { label: 'Profiles', keys: ['NP_RISK_PROFILE', 'NP_CLAIMS_PROFILE'] },
  { label: 'Exposure', keys: ['NP_CRESTA_AGGREGATES', 'NP_EVENT_LOSS_TABLES'] },
  { label: 'Pricing', keys: ['NP_STOP_LOSS_PRICING', 'NP_FINAL_PRICING', 'NP_FINAL_QUOTE'] },
  { label: 'Audit', keys: ['NP_HISTORY'] },
];

// ── Facultative Wizard ────────────────────────────────────────────────────────

export const FAC_WIZARD_ORDER = [
  'FAC_RISK_DETAIL',
  'FAC_DOCUMENTS',
  'FAC_LOCATIONS',
  'FAC_COPE',
  'FAC_COVERAGE_STRUCTURE',
  'FAC_DEDUCTIBLES',
  'FAC_LOSS_HISTORY',
  'FAC_PRICING',
  'FAC_SUMMARY',
];

export const FAC_TAB_GROUPS = [
  { label: 'Submission',  keys: ['FAC_RISK_DETAIL', 'FAC_DOCUMENTS', 'FAC_LOCATIONS'] },
  { label: 'Risk',        keys: ['FAC_COPE', 'FAC_COVERAGE_STRUCTURE', 'FAC_DEDUCTIBLES'] },
  { label: 'Experience',  keys: ['FAC_LOSS_HISTORY'] },
  { label: 'Pricing',     keys: ['FAC_PRICING', 'FAC_SUMMARY'] },
];
