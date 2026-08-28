// Money-path coverage: FacPricing golden master + save lifecycle + error
// path. The fixture is rich enough that the engine produces non-trivial
// numbers, and every displayed figure below is pinned as a hard literal
// expectation (computed by hand through shared/fac/families/scheduleProperty,
// which this suite deliberately does NOT mock).
//
// ── Fixture math (golden master) ────────────────────────────────────────────
// FLEXA base 1.2‰; factor D/L sums: tech −30%, flood −15%, EQ −10%
//   technical (no natcat) = 1.2 × 0.70           = 0.8400‰
//   flood loaded          = 0.20 × 0.85          = 0.1700‰
//   EQ loaded             = 0.10 × 0.90          = 0.0900‰
//   total                 = 0.84 + 0.17 + 0.09   = 1.1000‰
//   BI (12m → 0.75, BI_PLAN +10%) = 0.75 × 1.10 × 1.10 = 0.9075‰
//   net (PD share 0.8)    = 0.8×1.10 + 0.2×0.9075 = 1.0615‰
//   extensions (EQ +15% + BI +8% = +23%)          = 1.3056‰ final net
//   gross (÷ 1−0.20−0.05−0.005 = 0.745)           = 1.7525‰
//   UW adjustment +10%    → quoted                = 1.9278‰
//   premiums vs 500m location SI: technical 420,000 / expected 876,272
//                                 quoted 963,899
//   engine score 78.00 (grade B); panel score 80.00 (no benchmark rate there,
//   so MARKET_VS_TECH is unscored and the remaining 90% of weight is
//   renormalised — it is NOT scored as the worst band any more)
//   market vs tech = 0.85 / 1.3056 = 65.10% → "Between 60% to 70%"
//   capacity = min(GCC 50m, 360m top-location × 20%) = 50,000,000
//
// ── What changed from the previous golden master ───────────────────────────
// The manual ①②③④ market / actuarial / blend / final block is gone, and with
// it the second set of numbers it produced. The extensions it used to feed
// now load the engine's net rate, which is why final net is 1.3056 here and
// was 1.0615 before — the ticks always claimed to load the rate and now
// actually do (findings F9 and design doc §1.3).
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({
  // Primary load trio (single Promise.all)
  facGetRisk: vi.fn(),
  facGetPricing: vi.fn(),
  facListClasses: vi.fn(),
  // Saves
  facSavePricing: vi.fn(),
  facUpdateRisk: vi.fn(),
  // Exposure: locations + sections feed the one profile
  facGetLocations: vi.fn(),
  facGetSections: vi.fn(),
  // Reference catalogues (fetched by both the screen and the UW panel)
  facGetOccupancies: vi.fn(),
  facGetFactors: vi.fn(),
  facGetFactorWeights: vi.fn(),
  facGetScoringTables: vi.fn(),
  facGetBiIndemnity: vi.fn(),
  facGetNatcatRates: vi.fn(),
  facGetRateVersion: vi.fn(),
  // Phase 2: the loss-cost methods and the blend run on the server.
  facPriceRisk: vi.fn(),
  // UW factors panel (independent entity + save)
  facGetUwFactors: vi.fn(),
  facGetAccumulation: vi.fn(),
  facSaveUwFactors: vi.fn(),
}));
vi.mock('../../../api', () => ({ __esModule: true, default: apiMock, api: apiMock }));
vi.mock('../../../hooks/useContractId', () => ({ useFacRiskId: () => 'R-1' }));

const toastMock = vi.hoisted(() => vi.fn());
vi.mock('../../../hooks/useToast', () => ({ useGlobalToast: () => toastMock }));
const wiz = vi.hoisted(() => ({ next: undefined, error: undefined }));
vi.mock('../../../components/WizardLayout', () => ({
  __esModule: true,
  default: function FakeWizardLayout({ children, onBeforeNext }) {
    return (
      <div>
        <button
          onClick={() => {
            wiz.next = undefined; wiz.error = undefined;
            Promise.resolve()
              .then(() => onBeforeNext?.())
              .then((r) => { wiz.next = r; }, (e) => { wiz.error = e; });
          }}
        >
          WIZ-NEXT
        </button>
        {typeof children === 'function' ? children() : children}
      </div>
    );
  },
}));

import FacPricing from './FacPricing';

// ── Fixtures (DB NUMERIC columns arrive as strings — keep them strings) ────
const RISK = {
  fac_risk_id: 'R-1',
  insured_name: 'SABIC Petrochemical Complex',
  total_sum_insured: '500000000.00',
  pd_sum_insured: '400000000.00',
  bi_sum_insured: '100000000.00',
  // Written share (whole percent). The engine and every displayed figure stay
  // on the 100% basis; ONLY the ri_premium written back to the risk header is
  // share-scaled (F28) — pinned in the save-lifecycle test below.
  our_share_pct: '15.00',
  occupancy_code: 4002,
  risk_country_zone: 'SA-Z2',
  cedant_region: 'GCC',
  cob_category: 'PROPERTY',
  fac_cob_id: 'COB-PROP',
  currency_code: 'SAR',
};

const FAC_CLASSES = [{
  fac_cob_id: 'COB-PROP', category: 'PROPERTY', class_name: 'Property All Risks',
  rating_family: 'SCHEDULE_PROPERTY', segment_code: 'NON_MARINE_PROPERTY',
  exposure_basis: 'SI_PER_MILLE',
}];

const LOCATIONS = [
  { location_id: 'L-1', pd_si: '300000000.00', bi_si: '60000000.00' },
  { location_id: 'L-2', pd_si: '100000000.00', bi_si: '40000000.00' },
];

const OCCUPANCIES = {
  occupancies: [{
    occupancy_code: 4002, occupancy_name: 'Petrochemical plant',
    hazard_grade: 3, frequency_category: 2, flexa_base_rate_pm: '1.2000',
  }],
};

const opt = (id, label, score, dl) => ({
  option_id: id, option_label: label, score, discount_loading: dl,
});

const FACTORS = {
  factors: [
    { factor_code: 'CONSTRUCTION', factor_name: 'Construction Class', affects_rate: true, affects_score: true,
      options: [opt('c1', 'Fire Resistive', '95.00', '-0.1000'), opt('c2', 'Combustible', '30.00', '0.2500')] },
    { factor_code: 'AGE_OF_RISK', factor_name: 'Age of Risk', affects_rate: true, affects_score: true,
      options: [opt('a1', '0-10 years', '90.00', '-0.0500'), opt('a2', 'Over 30 years', '40.00', '0.1500')] },
    { factor_code: 'CLAIM_EXPERIENCE', factor_name: 'Claims Experience', affects_rate: true, affects_score: true,
      options: [opt('x1', 'Clean 5 years', '100.00', '-0.1000'), opt('x2', 'Frequent losses', '20.00', '0.2000')] },
    { factor_code: 'FIRE_FIGHTING', factor_name: 'Fire Fighting Capability', affects_rate: true, affects_score: true,
      options: [opt('f1', 'Sprinklered & hydrants', '90.00', '-0.0500'), opt('f2', 'None', '10.00', '0.1500')] },
    { factor_code: 'MANAGEMENT', factor_name: 'Management Quality', affects_rate: true, affects_score: true,
      options: [opt('m1', 'Excellent', '90.00', '-0.0500'), opt('m2', 'Poor', '20.00', '0.1000')] },
    { factor_code: 'SURVEY_RATING', factor_name: 'Survey Rating', affects_rate: true, affects_score: true,
      options: [opt('s1', 'Surveyed - good', '80.00', '-0.0500'), opt('s2', 'Not surveyed', '50.00', '0.1000')] },
    { factor_code: 'DEDUCTIBLE_LEVEL', factor_name: 'Deductible Level', affects_rate: true, affects_score: true,
      options: [opt('d1', 'High deductible', '85.00', '-0.0500'), opt('d2', 'Minimal deductible', '50.00', '0.0500')] },
    // BI_PLAN's D/L folds into the BI rate (not the tech rate) and does not score.
    { factor_code: 'BI_PLAN', factor_name: 'BI Plan Quality', affects_rate: true, affects_score: false,
      options: [opt('b1', 'Standard BI plan', '70.00', '0.1000')] },
    // Scored from the computed market-vs-tech band, never user-picked.
    { factor_code: 'MARKET_VS_TECH', factor_name: 'Market vs Technical Rate', affects_rate: false, affects_score: true,
      options: [
        opt('v1', 'More than Equal to 80%', '100.00', null),
        opt('v2', 'Between 70% to 80%', '80.00', null),
        opt('v3', 'Between 60% to 70%', '60.00', null),
        opt('v4', 'Between 50% to 60%', '40.00', null),
        opt('v5', 'Between 40% to 50%', '20.00', null),
        opt('v6', 'Less than 40%', '0.00', null),
      ] },
    // Grade factors come from occupancy + dedicated score tables (no options).
    { factor_code: 'HAZARD_GRADE', factor_name: 'Hazard Grade', affects_rate: false, affects_score: true, options: [] },
    { factor_code: 'FREQUENCY_GRADE', factor_name: 'Frequency Grade', affects_rate: false, affects_score: true, options: [] },
  ],
};

const SHARED_WEIGHTS = {
  HAZARD_GRADE: '0.15', FREQUENCY_GRADE: '0.10', CONSTRUCTION: '0.15',
  AGE_OF_RISK: '0.05', MANAGEMENT: '0.10', SURVEY_RATING: '0.10',
  DEDUCTIBLE_LEVEL: '0.05', CLAIM_EXPERIENCE: '0.10', FIRE_FIGHTING: '0.10',
  MARKET_VS_TECH: '0.10',
};
const WEIGHTS = { schemes: { WITH_BI: SHARED_WEIGHTS, WITHOUT_BI: SHARED_WEIGHTS } };

const SCORING = {
  hazard_grade: [
    { hazard_grade: 1, score: '90.00' }, { hazard_grade: 2, score: '75.00' },
    { hazard_grade: 3, score: '60.00' }, { hazard_grade: 4, score: '40.00' },
  ],
  frequency: [
    { frequency_category: 1, score: '85.00' }, { frequency_category: 2, score: '70.00' },
    { frequency_category: 3, score: '45.00' },
  ],
  capacity_bands: [
    { grade: 'A', score_min: '80', score_max: '100', max_capacity_pct: '0.30', min_tech_rate_pm: '0.50', underwriting_action: 'Accept', description: 'Excellent risk' },
    { grade: 'B', score_min: '60', score_max: '79.99', max_capacity_pct: '0.20', min_tech_rate_pm: '0.75', underwriting_action: 'Accept with caution', description: 'Good risk' },
    { grade: 'C', score_min: '40', score_max: '59.99', max_capacity_pct: '0.10', min_tech_rate_pm: '1.00', underwriting_action: 'Exceptional underwriting consideration', description: 'Marginal risk' },
    { grade: 'D', score_min: '0', score_max: '39.99', max_capacity_pct: '0', underwriting_action: 'Decline', description: 'Poor risk' },
  ],
  territorial_capacity: [{ region: 'GCC', max_capacity: '50000000.00' }],
};

const BI_INDEMNITY = { loadings: { 12: '0.7500', 24: '1.2500' } };
const NATCAT = { rates: [{ country_zone: 'SA-Z2', flood_storm_rate: '0.2000', earthquake_rate: '0.1000' }] };
const RATE_VERSION = { version_label: 'FAC-REF-2026.1', effective_from: '2026-01-01' };

const UW_SELECTIONS = {
  CONSTRUCTION: 'Fire Resistive',
  AGE_OF_RISK: '0-10 years',
  CLAIM_EXPERIENCE: 'Clean 5 years',
  FIRE_FIGHTING: 'Sprinklered & hydrants',
  MANAGEMENT: 'Excellent',
  SURVEY_RATING: 'Not surveyed',
  DEDUCTIBLE_LEVEL: 'High deductible',
  BI_PLAN: 'Standard BI plan',
};

const PRICING_ROW = {
  fac_risk_id: 'R-1',
  ui_state: { selectedExtensions: ['natcat_eq', 'bi_ext'], customExtensions: [] },
  indemnity_months: 12,
  commission_pct: '0.2000',
  margin_pct: '0.0500',
  other_expenses_pct: '0.0050',
  market_rate_pm: '0.8500',
  market_source: 'Broker indication 2026',
  uw_adjustment_pct: '10.00',          // stored in whole percent
  uw_adjustment_reason: 'NatCat exposure',
};

// One engine-detail row = <div><span>label</span><span>value</span></div>.
const engineRow = (label) => within(screen.getByText(label).parentElement);
const expectEngineRows = (pairs) => {
  for (const [label, value] of pairs) {
    expect(engineRow(label).getByText(value)).toBeInTheDocument();
  }
};

// One waterfall row is a two-column grid: <div><span>label</span>…</div><div>value</div>
// Scoped to the build-up region — "Earthquake" is also an extension checkbox.
const waterfallValue = (label) =>
  within(screen.getByRole('region', { name: 'Rate build-up' }))
    .getByText(label).parentElement.parentElement.lastElementChild.textContent;

const resolveOnceThenHang = (mock, value) => {
  mock.mockImplementationOnce(() => Promise.resolve(value))
    .mockImplementation(() => new Promise(() => {}));
};

beforeEach(() => {
  vi.resetAllMocks();
  wiz.next = undefined; wiz.error = undefined;
  apiMock.facGetRisk.mockResolvedValue(RISK);
  apiMock.facGetPricing.mockResolvedValue(null);
  apiMock.facListClasses.mockResolvedValue(FAC_CLASSES);
  apiMock.facGetLocations.mockResolvedValue(LOCATIONS);
  apiMock.facGetSections.mockResolvedValue([]);
  apiMock.facGetOccupancies.mockResolvedValue(OCCUPANCIES);
  apiMock.facGetFactors.mockResolvedValue(FACTORS);
  apiMock.facGetFactorWeights.mockResolvedValue(WEIGHTS);
  apiMock.facGetScoringTables.mockResolvedValue(SCORING);
  apiMock.facGetBiIndemnity.mockResolvedValue(BI_INDEMNITY);
  apiMock.facGetNatcatRates.mockResolvedValue(NATCAT);
  apiMock.facGetRateVersion.mockResolvedValue(RATE_VERSION);
  // Default: the server priced it with the workbook rate alone, which is the
  // no-history / no-curve case and must equal the local engine's own answer.
  apiMock.facPriceRisk.mockResolvedValue(null);
  apiMock.facGetUwFactors.mockResolvedValue({ selections: {}, notes: '' });
  apiMock.facGetAccumulation.mockResolvedValue({
    status: 'NO_BUDGET', referral: false, checks: [], reasons: [], unmeasured: [],
    family: 'SCHEDULE_PROPERTY', line_size: null, line_basis: 'TOTAL_SI', zones: [],
  });
  apiMock.facSaveUwFactors.mockResolvedValue({ ok: true });
  apiMock.facSavePricing.mockResolvedValue({ ok: true });
  apiMock.facUpdateRisk.mockResolvedValue({ ok: true });
});

describe('FacPricing golden master', () => {
  it('renders one rate build-up from reference data to quoted premium', async () => {
    resolveOnceThenHang(apiMock.facGetRisk, RISK);
    resolveOnceThenHang(apiMock.facGetPricing, PRICING_ROW);
    resolveOnceThenHang(apiMock.facListClasses, FAC_CLASSES);
    apiMock.facGetUwFactors.mockResolvedValue({
      selections: UW_SELECTIONS, notes: 'Premier petrochemical risk',
    });

    render(<FacPricing />);

    await waitFor(() => {
      expect(screen.getAllByText('1.9278').length).toBeGreaterThan(0);
    }, { timeout: 3000 });

    expect(apiMock.facGetRisk).toHaveBeenCalledWith('R-1', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(apiMock.facGetUwFactors).toHaveBeenCalledWith('R-1');
    expect(apiMock.facGetLocations).toHaveBeenCalledWith('R-1');
    expect(apiMock.facGetSections).toHaveBeenCalledWith('R-1');

    // ── The build-up, in the order it is derived ──
    expect(waterfallValue('FLEXA base rate')).toBe('1.2000');
    expect(waterfallValue('Technical rate')).toBe('0.8400');
    expect(waterfallValue('Flood / storm')).toBe('0.1700');
    expect(waterfallValue('Earthquake')).toBe('0.0900');
    expect(waterfallValue('= Total rate')).toBe('1.1000');
    expect(waterfallValue('BI rate')).toBe('0.9075');
    expect(waterfallValue('= Net rate')).toBe('1.0615');
    // Extensions load the ENGINE net rate now, not a parallel calculation.
    expect(waterfallValue('+ Extensions')).toBe('1.3056');
    expect(waterfallValue('= Technical net')).toBe('1.3056');
    expect(waterfallValue('= TECHNICAL GROSS')).toBe('1.7525');
    expect(waterfallValue('UW adjustment')).toBe('+10.0%');
    expect(waterfallValue('QUOTED RATE (‰)')).toBe('1.9278');
    expect(waterfallValue('Quoted premium')).toBe('963,899');

    // ── Engine detail (score + capacity half) ──
    expectEngineRows([
      ['Underwriting Score', '78.00'],
      ['Scoring Completeness', '100.00%'],
      ['Capacity Grade', 'B'],
      ['UW Action', 'ACCEPT_WITH_CAUTION'],
      ['Max Capacity %', '20.00%'],
      ['Max Capacity (SAR)', '50,000,000'],
      ['Market vs Tech %', '65.10%'],
      ['Market vs Tech Band', 'Between 60% to 70%'],
      ['Technical Premium', '420,000'],
      ['Expected Premium', '876,272'],
      ['Total Sum Insured', '500,000,000'],
    ]);
    expect(screen.queryByText('WARNINGS')).toBeNull();

    // ── Provenance: which exposure, which family, which rate set ──
    expect(screen.getByText(/Priced on/)).toBeInTheDocument();
    expect(screen.getByText('the location schedule')).toBeInTheDocument();
    expect(screen.getByText('Schedule Property')).toBeInTheDocument();
    expect(screen.getByText('FAC-REF-2026.1')).toBeInTheDocument();

    // ── UW factors panel: no benchmark rate there, so MARKET_VS_TECH is
    //    unscored and the remaining 90% of weight is renormalised. It used
    //    to be scored as the worst band, costing the risk a grade (F5b). ──
    expect(screen.getByText('80.00')).toBeInTheDocument();
    expect(screen.getByText('A · ACCEPT')).toBeInTheDocument();
    expect(screen.getByText('90% of the scoring weight selected')).toBeInTheDocument();
    expect(screen.getByText('WITH BI')).toBeInTheDocument();
    expect(screen.getByText('score 95.00')).toBeInTheDocument(); // CONSTRUCTION chip
    expect(screen.getByDisplayValue('Premier petrochemical risk')).toBeInTheDocument();

    // ── Extensions rehydrated from ui_state (PROPERTY catalogue) ──
    expect(screen.getByRole('checkbox', { name: /Earthquake \+15%/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Business Interruption \+8%/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Flood \+10%/ })).not.toBeChecked();

    // ── Engine inputs hydrated; percentages shown as whole percent ──
    expect(screen.getByDisplayValue('12')).toBeInTheDocument();      // indemnity months
    expect(screen.getByDisplayValue('0.8500')).toBeInTheDocument();  // benchmark rate ‰
    expect(screen.getByDisplayValue('Broker indication 2026')).toBeInTheDocument();
    expect(screen.getByDisplayValue('20%')).toBeInTheDocument();     // commission
    expect(screen.getByDisplayValue('5%')).toBeInTheDocument();      // margin
    expect(screen.getByDisplayValue('0.5%')).toBeInTheDocument();    // other expenses
    expect(screen.getByDisplayValue('10%')).toBeInTheDocument();     // UW adjustment
    expect(screen.getByDisplayValue('NatCat exposure')).toBeInTheDocument();

    // The retired manual block is gone.
    expect(screen.queryByText('① Market Rate Pricing')).toBeNull();
    expect(screen.queryByText('③ Blended Rate')).toBeNull();
  });

  it('recomputes the whole build-up when a UW factor selection changes', async () => {
    resolveOnceThenHang(apiMock.facGetRisk, RISK);
    resolveOnceThenHang(apiMock.facGetPricing, PRICING_ROW);
    resolveOnceThenHang(apiMock.facListClasses, FAC_CLASSES);
    apiMock.facGetUwFactors.mockResolvedValue({ selections: UW_SELECTIONS, notes: '' });

    render(<FacPricing />);
    await waitFor(() => {
      expect(screen.getAllByText('1.9278').length).toBeGreaterThan(0);
    }, { timeout: 3000 });

    // Construction: Fire Resistive (−10%, score 95) → Combustible (+25%, score 30)
    fireEvent.change(screen.getByDisplayValue('Fire Resistive'), {
      target: { value: 'Combustible' },
    });

    await waitFor(() => {
      expect(screen.getAllByText('2.8479').length).toBeGreaterThan(0);
    }, { timeout: 3000 });

    expect(waterfallValue('FLEXA base rate')).toBe('1.2000');   // base unchanged
    expect(waterfallValue('Technical rate')).toBe('1.2600');    // D/L sum −30% → +5%
    expect(waterfallValue('Flood / storm')).toBe('0.2400');     // −15% → +20%
    expect(waterfallValue('Earthquake')).toBe('0.1250');        // −10% → +25%
    expect(waterfallValue('= Total rate')).toBe('1.6250');
    expect(waterfallValue('BI rate')).toBe('1.3406');
    expect(waterfallValue('= Net rate')).toBe('1.5681');
    expect(waterfallValue('= Technical net')).toBe('1.9288');
    expect(waterfallValue('= TECHNICAL GROSS')).toBe('2.5890');
    expect(waterfallValue('QUOTED RATE (‰)')).toBe('2.8479');

    expectEngineRows([
      ['Underwriting Score', '64.25'],                // was 78.00
      ['Capacity Grade', 'B'],
      ['Max Capacity (SAR)', '50,000,000'],           // GCC cap still binds
      ['Market vs Tech %', '44.07%'],                 // 0.85 / 1.9288
      ['Market vs Tech Band', 'Between 40% to 50%'],
    ]);
    // Panel score drops too (95→30 at weight 0.15), renormalised over 90%.
    expect(screen.getByText('69.17')).toBeInTheDocument();
    expect(screen.getByText('score 30.00')).toBeInTheDocument();
    expect(screen.getByText('+25.00%')).toBeInTheDocument();
  });
});

describe('FacPricing — an unfinished score is not a declined risk (F5)', () => {
  it('reports INCOMPLETE and withholds the grade instead of landing on the bottom band', async () => {
    // No UW selections: only hazard and frequency score, which come from the
    // occupancy. That is 25% of the weight. The old engine scored the other
    // 75% as zero — mid-scale on a −100..+100 range — and landed the risk on
    // the bottom grade, which reads as DECLINE.
    render(<FacPricing />);
    await waitFor(() => {
      expect(engineRow('UW Action').getByText('INCOMPLETE')).toBeInTheDocument();
    }, { timeout: 3000 });

    expectEngineRows([
      ['Underwriting Score', '64.00'],          // (60×.15 + 70×.10) / 0.25
      ['Scoring Completeness', '25.00%'],
      ['Capacity Grade', 'not issued'],
      ['UW Action', 'INCOMPLETE'],
      ['Max Capacity %', '—'],
      ['Max Capacity (SAR)', '—'],
    ]);
    expect(screen.getByText('PROVISIONAL')).toBeInTheDocument();
    expect(screen.getByText('80% needed before a grade is issued')).toBeInTheDocument();
    // The rate is still computed — an incomplete score blocks the capacity
    // decision, not the price.
    expect(waterfallValue('= TECHNICAL GROSS')).toBe('1.9128');
  });
});

describe('FacPricing save lifecycle', () => {
  it('wizard Next persists the engine snapshot, the quoted rate and its provenance', async () => {
    render(<FacPricing />);
    await waitFor(() => {
      expect(engineRow('UW Action').getByText('INCOMPLETE')).toBeInTheDocument();
    }, { timeout: 3000 });

    // Panel-owned edit (independent save path).
    fireEvent.change(
      screen.getByPlaceholderText('Underwriter notes on these factor selections…'),
      { target: { value: 'Checked with cedant' } },
    );
    // Engine input edit: commission 20% → 25%.
    fireEvent.change(screen.getByDisplayValue('20%'), { target: { value: '25' } });
    // Extension toggle — now an engine cover loading, not a parallel figure.
    fireEvent.click(screen.getByRole('checkbox', { name: /Earthquake \+15%/ }));

    // net 1.425 × 1.15 = 1.63875; ÷ (1−0.25−0.05−0.005 = 0.695) = 2.3579.
    await waitFor(() => {
      expect(waterfallValue('= TECHNICAL GROSS')).toBe('2.3579');
    }, { timeout: 3000 });

    fireEvent.click(screen.getByRole('button', { name: 'WIZ-NEXT' }));
    await waitFor(() => expect(wiz.next).toBe(true));

    expect(apiMock.facSaveUwFactors).toHaveBeenCalledTimes(1);
    expect(apiMock.facSaveUwFactors).toHaveBeenCalledWith('R-1', {
      selections: {}, notes: 'Checked with cedant',
    });

    expect(apiMock.facSavePricing).toHaveBeenCalledTimes(1);
    const [savedId, payload] = apiMock.facSavePricing.mock.calls[0];
    expect(savedId).toBe('R-1');
    expect(payload.commission_pct).toBe(0.25);
    expect(payload.ui_state).toEqual({ selectedExtensions: ['natcat_eq'], customExtensions: [] });
    expect(payload.indemnity_months).toBe(12);
    expect(payload.margin_pct).toBe(0.05);
    expect(payload.other_expenses_pct).toBe(0.005);
    expect(payload.market_rate_pm).toBeNull();
    // Ticked extensions ARE the engine's cover loadings — one mechanism.
    expect(payload.extra_cover_loadings).toEqual([{ label: 'Earthquake', pct: 0.15 }]);

    // Engine snapshot + the new provenance columns.
    expect(payload.engine_version).toBe('2.0.0');
    expect(payload.family_code).toBe('SCHEDULE_PROPERTY');
    expect(payload.rate_table_version).toBe('FAC-REF-2026.1');
    expect(payload.exposure_basis).toBe('LOCATIONS');
    expect(payload.underwriting_score).toBeCloseTo(64, 5);
    expect(payload.score_completeness).toBeCloseTo(0.25, 6);
    expect(payload.capacity_grade).toBeNull();
    expect(payload.uw_action).toBe('INCOMPLETE');
    expect(payload.max_capacity_sar).toBeNull();
    expect(payload.technical_rate_pm).toBeCloseTo(1.2, 10);
    expect(payload.final_gross_rate_pm).toBeCloseTo(2.35791, 4);
    expect(payload.technical_premium).toBeCloseTo(600000, 5);
    // The quoted figures land in the columns the manual block used to own,
    // so the Summary screen and the existing reports keep working.
    expect(payload.final_rate_per_mille).toBeCloseTo(2.35791, 4);
    expect(payload.final_premium).toBeCloseTo(1178956.8, 1);
    expect(payload.engine_warnings.length).toBeGreaterThan(0);
    // Quoted premium syncs to the risk header AT OUR SHARE (F28): ri_premium
    // is "RI Premium (Our Share)" to every consumer (fac dashboard, bound-
    // premium KPI, class accumulation), so the 100% quoted premium
    // (1,178,956.8, still displayed and saved as final_premium above) is
    // scaled by our_share_pct 15% → 176,843.52. The rate stays 100%-basis.
    expect(apiMock.facUpdateRisk).toHaveBeenCalledTimes(1);
    const [updId, updBody] = apiMock.facUpdateRisk.mock.calls[0];
    expect(updId).toBe('R-1');
    expect(updBody.ri_premium).toBeCloseTo(1178956.8 * 0.15, 1);
    expect(updBody.original_rate).toBeCloseTo(2.35791, 4);

    // Second Next is a no-op (state no longer dirty).
    fireEvent.click(screen.getByRole('button', { name: 'WIZ-NEXT' }));
    await waitFor(() => expect(wiz.next).toBe(true));
    expect(apiMock.facSavePricing).toHaveBeenCalledTimes(1);
  });

  it('benchmark-source edits survive and are saved by wizard Next', async () => {
    render(<FacPricing />);
    await waitFor(() => {
      expect(engineRow('UW Action').getByText('INCOMPLETE')).toBeInTheDocument();
    }, { timeout: 3000 });
    expect(apiMock.facGetRisk).toHaveBeenCalledTimes(1);

    fireEvent.change(
      screen.getByPlaceholderText('e.g. Market benchmark 2026, broker indication'),
      { target: { value: 'Direct cedant quote' } },
    );
    // The edit must NOT re-trigger the primary load (one-shot per risk).
    expect(apiMock.facGetRisk).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'WIZ-NEXT' }));
    await waitFor(() => expect(wiz.next).toBe(true));

    expect(apiMock.facSavePricing).toHaveBeenCalledTimes(1);
    expect(apiMock.facSavePricing.mock.calls[0][1]).toEqual(
      expect.objectContaining({ market_source: 'Direct cedant quote' }),
    );
    expect(screen.getByDisplayValue('Direct cedant quote')).toBeInTheDocument();
  });

  it('save failure toasts via the global toast and blocks navigation', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      apiMock.facSavePricing.mockRejectedValue(
        Object.assign(new Error('API PUT → 500: db down'), { status: 500 }),
      );
      render(<FacPricing />);
      await waitFor(() => {
        expect(engineRow('UW Action').getByText('INCOMPLETE')).toBeInTheDocument();
      }, { timeout: 3000 });

      fireEvent.change(screen.getByDisplayValue('20%'), { target: { value: '25' } });

      fireEvent.click(screen.getByRole('button', { name: 'WIZ-NEXT' }));
      await waitFor(() => expect(wiz.next).toBe(false));
      expect(wiz.error).toBeUndefined();
      expect(toastMock).toHaveBeenCalledWith('Pricing save failed: API PUT → 500: db down');
      expect(apiMock.facSavePricing).toHaveBeenCalledTimes(1);
    } finally {
      errSpy.mockRestore();
    }
  });
});

describe('FacPricing extensions', () => {
  it('ticked and custom extensions both load the engine net rate', async () => {
    // Baseline, no selections: net = 0.8×1.5 + 0.2×1.125 = 1.4250,
    // gross = 1.425 / 0.745 = 1.9128.
    render(<FacPricing />);
    await waitFor(() => {
      expect(waterfallValue('= TECHNICAL GROSS')).toBe('1.9128');
    }, { timeout: 3000 });

    // Custom extension: auto-checked on add, straight into the engine.
    fireEvent.change(screen.getByPlaceholderText('Custom extension name'), {
      target: { value: 'Sabotage' },
    });
    fireEvent.change(screen.getByPlaceholderText('Loading %'), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: '+ Add' }));

    expect(screen.getByRole('checkbox', { name: /Sabotage \+7%/ })).toBeChecked();
    // final net = 1.425 × 1.07 = 1.52475; gross = 1.52475 / 0.745 = 2.0466.
    await waitFor(() => {
      expect(waterfallValue('= TECHNICAL GROSS')).toBe('2.0466');
    }, { timeout: 3000 });
    expect(waterfallValue('= Net rate')).toBe('1.4250');
    expect(waterfallValue('= Technical net')).toBe('1.5248');

    fireEvent.click(screen.getByRole('button', { name: 'Remove Sabotage' }));
    await waitFor(() => {
      expect(waterfallValue('= TECHNICAL GROSS')).toBe('1.9128');
    }, { timeout: 3000 });
    expect(screen.queryByRole('checkbox', { name: /Sabotage/ })).toBeNull();
  });
});

describe('FacPricing — a class with no engine is a state, not a crash (F1)', () => {
  it('explains what an unbuilt family rates on instead of rendering an exception', async () => {
    // Every family the class taxonomy maps to is built as of Phase 4. The
    // declared-but-unbuilt state is still real — it is how a class gets added
    // before its maths exists — and this is what an underwriter sees.
    apiMock.facListClasses.mockResolvedValue([{
      fac_cob_id: 'COB-AV', category: 'AVIATION', class_name: 'Aviation Hull',
      rating_family: 'AVIATION_HULL', exposure_basis: 'AGREED_VALUE',
    }]);
    apiMock.facGetRisk.mockResolvedValue({
      ...RISK, fac_cob_id: 'COB-AV', cob_category: 'AVIATION',
      occupancy_code: null, risk_country_zone: null,
    });

    render(<FacPricing />);

    await waitFor(() => {
      expect(screen.getByText('No engine for this class yet')).toBeInTheDocument();
    }, { timeout: 3000 });
    expect(screen.getByText(/rates on rate per mille of agreed value/i)).toBeInTheDocument();
    expect(screen.getByText(/Phase 5/)).toBeInTheDocument();
    // No red exception message, and no half-rendered engine output.
    expect(screen.queryByText(/Unknown occupancy_code/)).toBeNull();
    expect(screen.queryByText('Rate Build-Up')).toBeNull();
  });

  it('hides the workbook sections for a family that has no workbook', async () => {
    // Phase 3 built HULL_VALUE, so it is no longer blocked — but it rates off
    // loaded tables through the server, not off a browser-side workbook. The
    // property-only sections must not render empty, and the property engine
    // must not be handed a hull risk.
    apiMock.facListClasses.mockResolvedValue([{
      fac_cob_id: 'COB-HULL', category: 'MARINE', class_name: 'Hull & Machinery',
      rating_family: 'HULL_VALUE', exposure_basis: 'AGREED_VALUE',
    }]);
    apiMock.facGetRisk.mockResolvedValue({
      ...RISK, fac_cob_id: 'COB-HULL', cob_category: 'MARINE',
      occupancy_code: null, risk_country_zone: null,
    });

    render(<FacPricing />);

    await waitFor(() => {
      expect(screen.getByText('Loss Cost')).toBeInTheDocument();
    }, { timeout: 3000 });
    expect(screen.queryByText('No engine for this class yet')).toBeNull();
    expect(screen.queryByText('Workbook Rate Build-Up')).toBeNull();
    expect(screen.queryByText('Engine Detail')).toBeNull();
    expect(screen.queryByText(/Unknown occupancy_code/)).toBeNull();
  });

  it('names the missing input when a property risk has no NatCat zone', async () => {
    apiMock.facGetRisk.mockResolvedValue({ ...RISK, risk_country_zone: null });

    render(<FacPricing />);

    await waitFor(() => {
      expect(screen.getByText('Missing input')).toBeInTheDocument();
    }, { timeout: 3000 });
    expect(screen.getByText(/risk_country_zone/)).toBeInTheDocument();
    expect(screen.getByText(/Risk Detail screen/)).toBeInTheDocument();
  });
});

describe('FacPricing error path', () => {
  it('primary load failure surfaces an alert with Retry, which recovers', async () => {
    const boom = Object.assign(new Error('API GET → 500: down'), { status: 500 });
    apiMock.facGetRisk.mockRejectedValueOnce(boom);

    render(<FacPricing />);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not load/i);
    expect(screen.queryByText('Engine Inputs')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(apiMock.facGetRisk).toHaveBeenCalledTimes(2);
    await waitFor(() => {
      expect(screen.getByText('Engine Inputs')).toBeInTheDocument();
    });
  });
});


describe('FacPricing — loss-cost methods and the blend (Phase 2)', () => {
  const priced = (over = {}) => ({
    ok: true,
    technical: {
      priced: true,
      candidates: [
        { code: 'WORKBOOK_RATE', label: 'Workbook rate', role: 'EXPOSURE', available: true, ratePm: 1.0615, diagnostics: {} },
        {
          code: 'BURNING_COST', label: 'Burning cost', role: 'EXPERIENCE', available: true,
          ratePm: 2.0, claimCount: 6, diagnostics: { exposure_years: 5 },
        },
        {
          code: 'EXPOSURE_CURVE', label: 'Exposure curve', role: 'EXPOSURE', available: false,
          ratePm: null, unavailableReason: 'No exposure curve is configured for this family and size band.',
          diagnostics: {},
        },
        {
          code: 'BENCHMARK', label: 'Benchmark', role: 'REFERENCE', available: true,
          ratePm: 1.5, diagnostics: { n: 7, confidence: 'MEDIUM', p25: 1.2, p50: 1.5, p75: 1.9 },
        },
      ],
      weights: { WORKBOOK_RATE: 0.5, BURNING_COST: 0.5 },
      weightSource: 'MECHANICAL',
      weightOverrideReason: null,
      credibility: { z: 0.5, capped: false },
      blendedLossCostPm: 1.53075,
      catLoadPm: 0,
      expectedLossPm: 1.53075,
      riskLoadPm: 0,
      riskLoadBasis: { kind: 'PERCENTAGE', pct: 0 },
      internalExpensePm: 0,
      technicalNetPm: 1.53075,
      grossUpDenominator: 0.745,
      technicalGrossPm: 2.0547,
      warnings: [],
      ...over,
    },
  });

  it('shows each method, its rate and the weight it carries', async () => {
    apiMock.facPriceRisk.mockResolvedValue(priced());
    render(<FacPricing />);

    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Loss cost methods' })).toBeInTheDocument();
    }, { timeout: 3000 });

    const panel = within(screen.getByRole('region', { name: 'Loss cost methods' }));
    expect(panel.getByText('Workbook rate')).toBeInTheDocument();
    expect(panel.getByText('1.0615')).toBeInTheDocument();
    expect(panel.getByText('Burning cost')).toBeInTheDocument();
    expect(panel.getByText('2.0000')).toBeInTheDocument();
    expect(panel.getByText('5 yrs · 6 claims in layer')).toBeInTheDocument();
    expect(panel.getAllByText('50%')).toHaveLength(2);
    expect(panel.getByText('Blended loss cost')).toBeInTheDocument();
    expect(panel.getByText('1.5308')).toBeInTheDocument();
    expect(panel.getByText('credibility Z = 50%')).toBeInTheDocument();
  });

  it('says why a method is unavailable instead of pricing it at zero', async () => {
    apiMock.facPriceRisk.mockResolvedValue(priced());
    render(<FacPricing />);

    await waitFor(() => {
      expect(screen.getByText(/No exposure curve is configured/)).toBeInTheDocument();
    }, { timeout: 3000 });

    const panel = within(screen.getByRole('region', { name: 'Loss cost methods' }));
    // Unavailable: no rate, no weight — and visibly different from a zero.
    expect(panel.getByText('Exposure curve')).toBeInTheDocument();
    expect(panel.getByText('reference')).toBeInTheDocument();   // the benchmark
  });

  it('drives the quoted rate off the blend once the server has priced it', async () => {
    apiMock.facPriceRisk.mockResolvedValue(priced());
    render(<FacPricing />);

    // technical gross 2.0547 — the blend, not the workbook rate's 1.9128.
    await waitFor(() => {
      expect(screen.getAllByText('2.0547').length).toBeGreaterThan(0);
    }, { timeout: 3000 });
    expect(waterfallValue('= TECHNICAL GROSS')).toBe('1.9128');   // workbook build-up, unchanged
    expect(screen.queryByText(/workbook only/)).toBeNull();
  });

  it('falls back to the workbook rate, and says so, when the server cannot price', async () => {
    apiMock.facPriceRisk.mockResolvedValue({ ok: true, technical: { priced: false, reason: 'No loss-cost method produced a rate.' } });
    render(<FacPricing />);

    // The screen shows the workbook rate immediately and keeps it — the
    // server round trip lands with nothing better, so nothing jumps.
    await waitFor(() => {
      expect(screen.getByText('No loss-cost method produced a rate.')).toBeInTheDocument();
    }, { timeout: 3000 });
    expect(screen.getByText(/workbook only/)).toBeInTheDocument();
  });

  it('flags an overridden blend with its reason', async () => {
    apiMock.facPriceRisk.mockResolvedValue(priced({
      weightSource: 'OVERRIDE', weightOverrideReason: 'LARGE_LOSS_DISTORTION',
      weights: { WORKBOOK_RATE: 1 },
    }));
    render(<FacPricing />);

    await waitFor(() => {
      expect(screen.getByText(/Weights overridden — large loss distortion/)).toBeInTheDocument();
    }, { timeout: 3000 });
  });

  it('persists the blend alongside the engine snapshot', async () => {
    apiMock.facPriceRisk.mockResolvedValue(priced());
    render(<FacPricing />);
    await waitFor(() => {
      expect(screen.getByRole('region', { name: 'Loss cost methods' })).toBeInTheDocument();
    }, { timeout: 3000 });

    fireEvent.change(screen.getByDisplayValue('20%'), { target: { value: '25' } });
    fireEvent.click(screen.getByRole('button', { name: 'WIZ-NEXT' }));
    await waitFor(() => expect(wiz.next).toBe(true));

    const payload = apiMock.facSavePricing.mock.calls[0][1];
    expect(payload.blended_loss_cost_pm).toBeCloseTo(1.53075, 6);
    expect(payload.blend_weights).toEqual({ WORKBOOK_RATE: 0.5, BURNING_COST: 0.5 });
  });
});
