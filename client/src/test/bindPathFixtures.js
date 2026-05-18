export const bindIds = {
  contract: 'contract-bind-001',
  quote: 'quote-bind-001',
  cobMotor: 'cob-motor',
  cobProperty: 'cob-property',
  country: 'country-sa',
};

export const refData = {
  cobs: [
    { id: bindIds.cobMotor, name: 'Motor', code: 'MTR' },
    { id: bindIds.cobProperty, name: 'Property', code: 'PROP' },
  ],
  reinsurers: [
    { id: 're-lead', name: 'Lead Re' },
    { id: 're-expiring', name: 'Expiring Re' },
  ],
  brokers: [{ id: 'broker-audit', name: 'Audit Broker' }],
  treatyTypes: [{ id: 'treaty-qs', name: 'Quota Share' }],
  countries: [{ id: bindIds.country, name: 'Saudi Arabia', code: 'SA' }],
  currencies: [{ id: 'SAR', name: 'Saudi Riyal', code: 'SAR' }],
  cedants: [{ id: 'cedant-audit', name: 'Audit Cedant', country_id: bindIds.country }],
};

export const propContractSnapshot = {
  contract_id: bindIds.contract,
  header: {
    contract_id: bindIds.contract,
    cedant_name: 'Audit Cedant',
    cedant_id: 'cedant-audit',
    broker_name: 'Audit Broker',
    broker_id: 'broker-audit',
    country_id: bindIds.country,
    country_name: 'Saudi Arabia',
    treaty_type_id: 'treaty-qs',
    treaty_type_name: 'Quota Share',
    currency_id: 'SAR',
    currency_code: 'SAR',
    underwriting_year: 2026,
    uw_year: 2026,
    primary_class_of_business_id: bindIds.cobMotor,
    status: 'DRAFT',
    signed_line_pct: null,
    // Always-required identifiers now gated by PropTreatyDetail's
    // getMissingRequiredFields() — the inception_date is sourced from
    // the contract header per migration 104's source-of-truth shift.
    inception_date: '2026-01-01',
    renewal_date: '2026-12-31',
  },
  class_ids: [bindIds.cobMotor],
  updated_at: '2026-05-01T10:00:00.000Z',
  detail: {
    inception_date: '2026-01-01',
    renewal_date: '2026-12-31',
    start_year: 2026,
    experience_start_year: 2021,
    qs_limit: 10000000,
    quota_share_epi: 6000000,
    surplus_epi: 0,
    event_limit: 3000000,
    cession_pct: 50,
    retention_pct: 50,
    brokerage_pct: 7.5,
    taxes_pct: 2,
  },
  commissions: {
    fixed_commission_pct: 0.24,
    fixed_commission_qs_pct: 0.24,
  },
  // LP toggle defaults YES; the scalar trio below means the new
  // required-field gate doesn't block save() in existing test paths.
  lossParticipation: {
    enabled: true,
    min_loss_ratio_pct: 70,
    max_loss_ratio_pct: 100,
    reinsurer_share_pct: 50,
  },
};

export const propPricingSnapshot = {
  outputs: {
    epi: 888888,
    status: 'DRAFT',
    offer_line: '37.5%',
    offer_comment: 'offer audit',
    offer_approver: 'CU',
    signed_line_pct: '',
  },
  components: [
    { component_name: 'Attritional Loss Ratio', actuarial_value: '44.00%', uw_value: '45.00%', actual_stats_value: '46.00%', market_value: '43.00%', exposure_value: '42.00%', comment: 'dev-db attritional row' },
    { component_name: 'Large Loss Loading', actuarial_value: '11.00%', uw_value: '11.00%', actual_stats_value: '10.00%', market_value: '12.00%', exposure_value: '10.00%', comment: '' },
    { component_name: 'Cat Loss Loading', actuarial_value: '21.00%', uw_value: '21.00%', actual_stats_value: '20.00%', market_value: '22.00%', exposure_value: '20.00%', comment: '' },
  ],
  leads: { lead_reinsurer: 'Lead Re', expiring_reinsurer: 'Expiring Re', lead_share_pct: 42.5 },
  share_scenarios: [
    { share_label: 'Base', limit_amt: 100, premium_amt: 20, cedant_limit: 80, agg_contrib: 3, country_agg: 4, event_limit: 5, downside_amt: 6, shortfall_amt: 7 },
  ],
};

export const npTreatySnapshot = {
  detail: {
    number_of_layers: 2,
    expiring_number_of_layers: 1,
    deductible: 100000,
    max_retention: 100000,
    xl_type: 'RISK',
    brokerage_pct: 7,
    taxes_pct: 2,
    est_gnpi: 1500000,
  },
  layers: [
    {
      layer_number: 1,
      attachment: 100000,
      layer_limit: 500000,
      aggregate_limit: 750000,
      egnpi: 1000000,
      earned_premium: 900000,
      rate: 5,
      rol: 10,
      num_reinstatements: 2,
      reinstatement_pct: 100,
      annual_agg_deductible: 5000,
      peril_scope: 'BOTH',
      mdp: 10000,
      mdp_pct: 1,
      hist_margin: 0.2,
      modelled_margin: 0.25,
      tech_ratio: 0.65,
      uw_price: 8.5,
      expiring_price: 6,
      lead_price: 6.8,
      class_of_business_ids: [bindIds.cobMotor, bindIds.cobProperty],
    },
    {
      layer_number: 2,
      attachment: 600000,
      layer_limit: 1000000,
      aggregate_limit: 1500000,
      egnpi: 1000000,
      earned_premium: 650000,
      rate: 3,
      rol: 6.5,
      num_reinstatements: 1,
      reinstatement_pct: 100,
      annual_agg_deductible: 0,
      peril_scope: 'RISK',
      mdp: 0,
      mdp_pct: 0,
      uw_price: 6.5,
      expiring_price: 5,
      lead_price: 6,
      class_of_business_ids: [bindIds.cobProperty],
    },
  ],
  terms: {
    np_structure: {
      layers: [
        { layer: 'L1', limit: '500000', deductible: '100000', egnpi: '1000000', earnedPremium: '900000', rate: '5%', riskCover: true, catCover: true, classOfBusinessIds: [bindIds.cobMotor, bindIds.cobProperty] },
        { layer: 'L2', limit: '1000000', deductible: '600000', egnpi: '1000000', earnedPremium: '650000', rate: '3%', riskCover: true, catCover: false, classOfBusinessIds: [bindIds.cobProperty] },
      ],
      cobRows: [
        { cobId: bindIds.cobMotor, name: 'Motor', underwritingLimit: '550000', layers: [true, false], manual: [false, false] },
        { cobId: bindIds.cobProperty, name: 'Property', underwritingLimit: '1200000', layers: [true, true], manual: [false, false] },
      ],
      coveredProps: [],
    },
    np_final_pricing: {
      layers: [
        {
          layer: 'L1',
          limit: '500000',
          deductible: '100000',
          risk: true,
          cat: true,
          riskPureBurn: '1.00%',
          riskPareto: '2.00%',
          riskAvgBurnPareto: '1.50%',
          riskExposure: '4.00%',
          riskWeightBurn: '40',
          riskWeightPareto: '10',
          riskWeightExposure: '50',
          riskLoading: '7',
          riskTotalPrice: '3.66%',
          riskUwPrice: '3.66%',
          catPureBurn: '0.50%',
          catPareto: '0.60%',
          catAvgBurnPareto: '0.55%',
          catExposure: '1.50%',
          catWeightBurn: '50',
          catWeightPareto: '0',
          catWeightExposure: '50',
          catLoading: '10',
          catTotalPrice: '1.14%',
          catUwPrice: '1.14%',
          reinsurerPricing: '8.50%',
          leadPricing: '6.80%',
          expiringPricing: '6.00%',
          uwPrice: '8.50%',
        },
      ],
      leadSetup: [{ reinsurer: 'Lead Re', sharePct: '42.5' }],
      offerStatus: 'DRAFT',
    },
  },
  cob_underwriting_limits: [
    { cob_id: bindIds.cobMotor, limit_amount: 550000 },
    { cob_id: bindIds.cobProperty, limit_amount: 1200000 },
  ],
};

export const npPricingSnapshot = {
  inputs: { burn_weight_pct: 40, exposure_weight_pct: 50, pareto_weight_pct: 10, pricing_loading_pct: 7, swiss_re_curve_name: 'Audit Curve' },
  layer_inputs: [{ layer_number: 1, expiring_pricing_pct: 6 }],
  outputs: [
    { layer_number: 1, section: 'RISK', pure_burning_cost: 1, pareto_pricing: 2, burn_plus_pareto: 1.5, exposure_rating: 4, burn_weight_pct: 40, exposure_weight_pct: 50, pareto_weight_pct: 10, pricing_loading_pct: 7, total_price: 3.66, prob_attach: 0.1, prob_exhaust: 0.01 },
  ],
};

export const npExpiringSnapshot = {
  layers: [
    { layer_number: 1, attachment: 90000, layer_limit: 400000, aggregate_limit: 500000, egnpi: 800000, earned_premium: 700000, rate: 4, rol: 9, num_reinstatements: 1, reinstatement_pct: 100, annual_agg_deductible: 3000, peril_scope: 'RISK', mdp: 5000, mdp_pct: 0.5 },
  ],
  terms: { egnpi: 800000, deductible: 9000, risk_limit: 400000, cat_limit: 0, brokerage_pct: 6, no_claims_bonus_pct: 1, profit_commission_pct: 2, notes: 'expiring audit' },
  coveredProps: [{ id: 'prop-1', label: 'covered prop' }],
};

export const approvalRows = {
  pending: [
    {
      contract_id: bindIds.contract,
      cedant_name: 'Audit Cedant',
      treaty_type_name: 'Quota Share',
      treaty_category: 'PROPORTIONAL',
      status: 'AWAITING_APPROVAL',
      updated_at: '2026-05-01T10:30:00.000Z',
    },
  ],
  decided: [],
  quotes: [],
};

export const aggDrilldownSnapshot = {
  contract: { contract_id: bindIds.contract, country_name: 'Saudi Arabia', uw_year: 2026, signed_line_pct: 37.5 },
  zones: [
    { zone_id: 'Z1', zone_name: 'Riyadh', eq_agg: 2500000, ws_agg: 500000, flood_agg: 250000, srcc_agg: 100000, others_agg: 50000, total_agg: 3400000 },
    { zone_id: 'Z2', zone_name: 'Jeddah', eq_agg: 500000, ws_agg: 1000000, flood_agg: 750000, srcc_agg: 50000, others_agg: 25000, total_agg: 2325000 },
  ],
  cob: [
    { cob: 'Motor', eq_agg: 1000000, ws_agg: 400000, flood_agg: 250000, srcc_agg: 100000, others_agg: 50000, total_agg: 1800000 },
    { cob: 'Property', eq_agg: 2000000, ws_agg: 1100000, flood_agg: 750000, srcc_agg: 50000, others_agg: 25000, total_agg: 3925000 },
  ],
  portfolio: {
    zones: [
      { zone_id: 'Z1', zone_name: 'Riyadh', eq_agg: 5000000, ws_agg: 1000000, flood_agg: 500000, srcc_agg: 200000, others_agg: 100000, total_agg: 6800000 },
      { zone_id: 'Z2', zone_name: 'Jeddah', eq_agg: 1500000, ws_agg: 3000000, flood_agg: 1000000, srcc_agg: 100000, others_agg: 50000, total_agg: 5650000 },
    ],
    cob: [
      { cob: 'Motor', total_agg: 3000000 },
      { cob: 'Property', total_agg: 9450000 },
    ],
  },
};

const copy = (value) => JSON.parse(JSON.stringify(value));

export function makeBindPathApiMock(fn, overrides = {}) {
  const defaults = {
    listClassOfBusiness: fn().mockResolvedValue(copy(refData.cobs)),
    listReinsurers: fn().mockResolvedValue(copy(refData.reinsurers)),
    listBrokers: fn().mockResolvedValue(copy(refData.brokers)),
    listTreatyTypes: fn().mockResolvedValue(copy(refData.treatyTypes)),
    getRefListItems: fn((key) => Promise.resolve(copy(key === 'country' ? refData.countries : refData.currencies))),
    listCedants: fn().mockResolvedValue(copy(refData.cedants)),
    getContract: fn().mockResolvedValue(copy(propContractSnapshot)),
    createContract: fn().mockResolvedValue({ contract_id: bindIds.contract, updated_at: '2026-05-01T10:00:00.000Z' }),
    saveContract: fn().mockResolvedValue({ ok: true, updated_at: '2026-05-01T10:01:00.000Z' }),
    getPricing: fn().mockResolvedValue(copy(propPricingSnapshot)),
    getPricingYearly: fn().mockResolvedValue([
      { uw_year: 2024, ultimate_premium: 1000, ultimate_loss: 600, loss_ratio: 0.6, record_type: 'ACTUAL' },
      { uw_year: 2025, ultimate_premium: 2000, ultimate_loss: 1100, loss_ratio: 0.55, record_type: 'PROJECTED' },
    ]),
    getExchangeRates: fn().mockResolvedValue([{ currency_code: 'SAR', rate_to_usd: 0.266 }],
    ),
    getComponentSnapshots: fn().mockResolvedValue([]),
    savePricingComposite: fn().mockResolvedValue({ ok: true }),
    saveComponentSnapshot: fn().mockResolvedValue({ id: 'snap-1', snapshot_label: 'Initial pricing', components: {} }),
    deleteComponentSnapshot: fn().mockResolvedValue({ ok: true }),
    getTriangle: fn().mockResolvedValue({ cells: [] }),
    getStraightStats: fn().mockResolvedValue(null),
    getLossSelectionLatest: fn().mockResolvedValue({}),
    getLargeLosses: fn().mockResolvedValue([]),
    getCatLosses: fn().mockResolvedValue([]),
    getContractCobs: fn().mockResolvedValue(copy(refData.cobs)),
    getRiskProfile: fn().mockResolvedValue({ bands: [] }),
    getMarketAverage: fn().mockResolvedValue({}),
    getCrestaData: fn().mockResolvedValue([]),
    getNpEgnpiYear: fn().mockResolvedValue([]),
    getCountryAggregates: fn().mockResolvedValue({ total_agg: 0, zones: [] }),
    getAggCobBreakdown: fn().mockResolvedValue({}),
    getAggDrilldown: fn().mockResolvedValue(copy(aggDrilldownSnapshot)),
    getApprovalTrail: fn().mockResolvedValue([]),
    getDocuments: fn().mockResolvedValue([]),
    getWordingChecklist: fn().mockResolvedValue({ items: [], latest_run: null }),
    saveWordingChecklist: fn().mockResolvedValue({ items: [], latest_run: null }),
    runWordingChecklistAi: fn().mockResolvedValue({ ok: false, items: [], latest_run: null }),
    getEligibleApprovers: fn().mockResolvedValue([{ user_id: 'cu-bind-test', display_name: 'Chief Underwriter', role_code: 'CU' }]),
    submitOfferForApproval: fn().mockResolvedValue({ ok: true }),
    markOfferApproved: fn().mockResolvedValue({ ok: true }),
    markOfferSigned: fn().mockResolvedValue({ ok: true }),
    markOfferNTU: fn().mockResolvedValue({ ok: true }),
    returnToUnderwriter: fn().mockResolvedValue({ ok: true }),
    recallOffer: fn().mockResolvedValue({ ok: true }),
    declineContract: fn().mockResolvedValue({ ok: true }),
    listContracts: fn((params = {}) => {
      const status = String(params.status || '');
      if (status.includes('AWAITING_APPROVAL')) return Promise.resolve(copy(approvalRows.pending));
      return Promise.resolve(copy(approvalRows.decided));
    }),
    listQuotes: fn().mockResolvedValue(copy(approvalRows.quotes)),
    getNonPropTreaty: fn().mockResolvedValue(copy(npTreatySnapshot)),
    saveNonPropTreaty: fn().mockResolvedValue({ ok: true }),
    getNpPricing: fn().mockResolvedValue(copy(npPricingSnapshot)),
    saveNpPricing: fn().mockResolvedValue({ ok: true }),
    getNpExpiring: fn().mockResolvedValue(copy(npExpiringSnapshot)),
    saveNpExpiring: fn().mockResolvedValue({ ok: true }),
    saveContractCobs: fn().mockResolvedValue({ ok: true }),
    getCedantProgrammeLimits: fn().mockResolvedValue({ cedant_programme_limit: 10000000 }),
    getPeerStructures: fn().mockResolvedValue({ scope: 'country', sourceContract: {}, peers: [], peerCount: 0 }),
    generateStructureCommentary: fn().mockResolvedValue({ signal: 'NO_DATA', commentary: '', highlights: [] }),
  };
  return { ...defaults, ...overrides };
}
