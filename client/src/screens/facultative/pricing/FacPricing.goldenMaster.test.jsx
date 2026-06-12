// Phase-6 money-path coverage: FacPricing golden master + save lifecycle +
// error path. The fixture is rich enough that BOTH pricing engines produce
// non-trivial numbers, and every displayed figure below is pinned as a hard
// literal expectation (computed by hand through logic/facPropertyPricing.js,
// which this suite deliberately does NOT mock).
//
// ── Fixture math (golden master) ────────────────────────────────────────────
// FLEXA base 1.2‰; factor D/L sums: tech −30%, flood −15%, EQ −10%
//   technical (no natcat) = 1.2 × 0.70           = 0.8400‰
//   flood loaded          = 0.20 × 0.85          = 0.1700‰
//   EQ loaded             = 0.10 × 0.90          = 0.0900‰
//   total                 = 0.84 + 0.17 + 0.09   = 1.1000‰
//   BI (12m → 0.75, BI_PLAN +10%) = 0.75 × 1.10 × 1.10 = 0.9075‰
//   net (PD share 0.8)    = 0.8×1.10 + 0.2×0.9075 = 1.0615‰  (= final net)
//   gross (÷ 1−0.20−0.05−0.005 = 0.745)          = 1.4248‰
//   premiums vs 500m SAR location SI: tech 420,000 / expected 712,416
//   engine score 82.00 (grade A / ACCEPT); panel score 72.00 (market rate
//   excluded there → MARKET_VS_TECH banded "Less than 40%" → 0)
//   market vs tech = 0.85 / 1.0615 = 80.08% → "More than Equal to 80%"
//   capacity = min(GCC 50m, 360m top-location × 30%) = 50,000,000
// Manual dual-engine section (TSI 500m): market 1.25‰ → 625,000; actuarial
// 1.45‰ → 725,000; blend 60/40 → 1.33‰ / 665,000; final = 1.33 × 1.10 (UW
// adj) × 1.23 (extensions 15+8) = 1.7995‰ / 899,745.
//
// ── Findings F1–F3 (originally pinned here as bugs) are FIXED ──
// F1. The load is one-shot per risk (hydrates over F_DEFAULTS, deps
//     [riskId]) — manual edits no longer re-trigger it or lose dirty;
//     wizard Next saves them (asserted below).
// F2. Save failures toast via useGlobalToast and return false (blocked
//     navigation), no window.showToast TypeError.
// F3. Primary-load failures surface through AsyncBoundary with Retry.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent, within } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({
  // Primary load trio (single Promise.all, silent catch)
  facGetRisk: vi.fn(),
  facGetPricing: vi.fn(),
  facListClasses: vi.fn(),
  // Saves
  facSavePricing: vi.fn(),
  facUpdateRisk: vi.fn(),
  // Locations feed pd_si_share / top-location / premium SI
  facGetLocations: vi.fn(),
  // Reference catalogues (fetched by both the screen and the UW panel)
  facGetOccupancies: vi.fn(),
  facGetFactors: vi.fn(),
  facGetFactorWeights: vi.fn(),
  facGetScoringTables: vi.fn(),
  facGetBiIndemnity: vi.fn(),
  facGetNatcatRates: vi.fn(),
  // UW factors panel (independent entity + save)
  facGetUwFactors: vi.fn(),
  facSaveUwFactors: vi.fn(),
}));
vi.mock('../../../api', () => ({ __esModule: true, default: apiMock, api: apiMock }));
// This fac screen resolves its entity via useFacRiskId (not useContractId).
vi.mock('../../../hooks/useContractId', () => ({ useFacRiskId: () => 'R-1' }));

// Save failures surface through the app-wide toast (Phase-5 fix of F2).
const toastMock = vi.hoisted(() => vi.fn());
vi.mock('../../../hooks/useToast', () => ({ useGlobalToast: () => toastMock }));
// Fake WizardLayout exposes onBeforeNext so the save lifecycle is testable;
// `wiz` records whether the save resolved (true/false) or threw.
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
  occupancy_code: 4002,
  risk_country_zone: 'SA-Z2',
  cedant_region: 'GCC',
  cob_category: 'PROPERTY',
  fac_cob_id: 'COB-PROP',
  currency_code: 'SAR',
};

const FAC_CLASSES = [{ fac_cob_id: 'COB-PROP', category: 'PROPERTY', name: 'Property All Risks' }];

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
  // Manual dual-engine section (consistent with its own auto-calc effects).
  market_rate_per_mille: '1.2500',
  market_premium: '625000.00',
  market_source: 'Broker indication 2026',
  actuarial_method: 'BURNING_COST',
  actuarial_rate_per_mille: '1.4500',
  actuarial_premium: '725000.00',
  expected_loss_ratio: '65.00',
  loss_cost: '0.9400',
  loading_pct: '25.00',
  market_weight_pct: '60.00',
  actuarial_weight_pct: '40.00',
  blended_rate_per_mille: '1.3300',
  blended_premium: '665000.00',
  final_rate_per_mille: '1.7995',
  final_premium: '899745.00',
  uw_adjustment_pct: '10.00',
  uw_adjustment_reason: 'NatCat exposure',
  burning_cost_ratio: '0.72',
  avg_loss_years: '5',
  ui_state: { selectedExtensions: ['natcat_eq', 'bi_ext'], customExtensions: [] },
  // Engine inputs persisted on the row.
  indemnity_months: 12,
  commission_pct: '0.2000',
  margin_pct: '0.0500',
  other_expenses_pct: '0.0050',
  market_rate_pm: '0.8500',
  extra_cover_loadings: [],
};

// One engine-readout row = <div><span>label</span><span>value</span></div>.
const engineRow = (label) => within(screen.getByText(label).parentElement);
const expectEngineRows = (pairs) => {
  for (const [label, value] of pairs) {
    expect(engineRow(label).getByText(value)).toBeInTheDocument();
  }
};

// Later load-effect cycles must never re-hydrate state mid-test: hand the
// first call real data, leave every subsequent call pending forever.
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
  apiMock.facGetOccupancies.mockResolvedValue(OCCUPANCIES);
  apiMock.facGetFactors.mockResolvedValue(FACTORS);
  apiMock.facGetFactorWeights.mockResolvedValue(WEIGHTS);
  apiMock.facGetScoringTables.mockResolvedValue(SCORING);
  apiMock.facGetBiIndemnity.mockResolvedValue(BI_INDEMNITY);
  apiMock.facGetNatcatRates.mockResolvedValue(NATCAT);
  apiMock.facGetUwFactors.mockResolvedValue({ selections: {}, notes: '' });
  apiMock.facSaveUwFactors.mockResolvedValue({ ok: true });
  apiMock.facSavePricing.mockResolvedValue({ ok: true });
  apiMock.facUpdateRisk.mockResolvedValue({ ok: true });
});

describe('FacPricing golden master', () => {
  it('renders the full dual-engine pricing readout with pinned computed values', async () => {
    resolveOnceThenHang(apiMock.facGetRisk, RISK);
    resolveOnceThenHang(apiMock.facGetPricing, PRICING_ROW);
    resolveOnceThenHang(apiMock.facListClasses, FAC_CLASSES);
    apiMock.facGetUwFactors.mockResolvedValue({
      selections: UW_SELECTIONS, notes: 'Premier petrochemical risk',
    });

    render(<FacPricing />);

    // Engine output lands after reference data + the 150ms debounce.
    await waitFor(() => {
      expect(screen.getByText('1.4248')).toBeInTheDocument();
      expect(screen.getByText('72.00')).toBeInTheDocument();
    }, { timeout: 3000 });

    expect(apiMock.facGetRisk).toHaveBeenCalledWith('R-1', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(apiMock.facGetPricing).toHaveBeenCalledWith('R-1', expect.objectContaining({ signal: expect.any(AbortSignal) }));
    expect(apiMock.facGetUwFactors).toHaveBeenCalledWith('R-1');
    expect(apiMock.facGetLocations).toHaveBeenCalledWith('R-1');

    // ── Engine readout (computeFacQuote through the REAL engine) ──
    expectEngineRows([
      ['Flexa Base Rate (‰)', '1.2000'],
      ['Technical Rate — no NatCat (‰)', '0.8400'],
      ['Flood / Storm Loaded (‰)', '0.1700'],
      ['Earthquake Loaded (‰)', '0.0900'],
      ['Total Rate (‰)', '1.1000'],
      ['BI Rate (‰)', '0.9075'],
      ['Net Rate (‰)', '1.0615'],
      ['Final Net Rate (‰)', '1.0615'],
      ['Final Gross Rate (‰)', '1.4248'],
      ['Technical Premium (SAR)', '420,000'],
      ['Expected Premium (SAR)', '712,416'],
      ['Underwriting Score', '82.00'],
      ['Capacity Grade', 'A'],
      ['UW Action', 'ACCEPT'],
      ['Max Capacity %', '30.00%'],
      ['Max Capacity (SAR)', '50,000,000'],
      ['Market vs Tech %', '80.08%'],
      ['Market vs Tech Band', 'More than Equal to 80%'],
    ]);
    // Clean fixture ⇒ no engine warnings block.
    expect(screen.queryByText('WARNINGS')).toBeNull();

    // ── UW factors panel (score excludes market rate ⇒ band score 0) ──
    expect(screen.getByText('72.00')).toBeInTheDocument();
    expect(screen.getByText('B · ACCEPT_WITH_CAUTION')).toBeInTheDocument();
    expect(screen.getByText('WITH_BI')).toBeInTheDocument();
    expect(screen.getByText('score 95.00')).toBeInTheDocument(); // CONSTRUCTION chip
    expect(screen.getByDisplayValue('Premier petrochemical risk')).toBeInTheDocument();

    // ── Manual dual-engine section, hydrated + auto-calced ──
    // TSI header line + engine premium footnote (both 500m).
    expect(screen.getByText('500,000,000')).toBeInTheDocument();
    expect(
      screen.getByText('Premium computed against total location SAR SI = 500,000,000.'),
    ).toBeInTheDocument();
    expect(screen.getByDisplayValue('1.25')).toBeInTheDocument();   // market ‰
    expect(screen.getByText('625,000')).toBeInTheDocument();        // market premium
    expect(screen.getByDisplayValue('Broker indication 2026')).toBeInTheDocument();
    expect(screen.getByDisplayValue('Burning Cost')).toBeInTheDocument();
    expect(screen.getByDisplayValue('1.45')).toBeInTheDocument();   // actuarial ‰
    expect(screen.getByText('725,000')).toBeInTheDocument();        // actuarial premium
    expect(screen.getByDisplayValue('65%')).toBeInTheDocument();    // expected loss ratio
    expect(screen.getByDisplayValue('25%')).toBeInTheDocument();    // loading
    expect(screen.getByDisplayValue('0.72')).toBeInTheDocument();   // burning cost ratio
    expect(screen.getByDisplayValue('60%')).toBeInTheDocument();    // market weight
    expect(screen.getByDisplayValue('40%')).toBeInTheDocument();    // actuarial weight
    expect(screen.getByText('1.33')).toBeInTheDocument();           // blended ‰
    expect(screen.getByText('665,000')).toBeInTheDocument();        // blended premium
    expect(screen.getByDisplayValue('10%')).toBeInTheDocument();    // UW adjustment
    expect(screen.getByDisplayValue('NatCat exposure')).toBeInTheDocument();
    expect(screen.getByText('1.7995')).toBeInTheDocument();         // final ‰
    expect(screen.getByText('899,745')).toBeInTheDocument();        // final premium

    // ── Extensions rehydrated from ui_state (PROPERTY catalogue) ──
    expect(screen.getByRole('checkbox', { name: /Earthquake \+15%/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Business Interruption \+8%/ })).toBeChecked();
    expect(screen.getByRole('checkbox', { name: /Flood \+10%/ })).not.toBeChecked();
    expect(screen.getByText('Total Extensions Loading: +23%')).toBeInTheDocument();
    expect(screen.getByText('Extensions loading applied: +23% on base rate')).toBeInTheDocument();

    // ── Engine inputs hydrated from the persisted pricing row ──
    expect(screen.getByDisplayValue('12')).toBeInTheDocument();     // indemnity months
    expect(screen.getByDisplayValue('0.8500')).toBeInTheDocument(); // engine market rate ‰
    expect(screen.getByDisplayValue('0.2000')).toBeInTheDocument(); // commission
    expect(screen.getByDisplayValue('0.0500')).toBeInTheDocument(); // margin
    expect(screen.getByDisplayValue('0.0050')).toBeInTheDocument(); // other expenses
  });

  it('recomputes rates, score and capacity when a UW factor selection changes', async () => {
    resolveOnceThenHang(apiMock.facGetRisk, RISK);
    resolveOnceThenHang(apiMock.facGetPricing, PRICING_ROW);
    resolveOnceThenHang(apiMock.facListClasses, FAC_CLASSES);
    apiMock.facGetUwFactors.mockResolvedValue({ selections: UW_SELECTIONS, notes: '' });

    render(<FacPricing />);
    await waitFor(() => {
      expect(screen.getByText('1.4248')).toBeInTheDocument();
    }, { timeout: 3000 });

    // Construction: Fire Resistive (−10%, score 95) → Combustible (+25%, score 30)
    fireEvent.change(screen.getByDisplayValue('Fire Resistive'), {
      target: { value: 'Combustible' },
    });

    await waitFor(() => {
      expect(screen.getByText('2.1049')).toBeInTheDocument();
    }, { timeout: 3000 });

    expectEngineRows([
      ['Flexa Base Rate (‰)', '1.2000'],            // base unchanged
      ['Technical Rate — no NatCat (‰)', '1.2600'], // D/L sum −30% → +5%
      ['Flood / Storm Loaded (‰)', '0.2400'],       // −15% → +20%
      ['Earthquake Loaded (‰)', '0.1250'],          // −10% → +25%
      ['Total Rate (‰)', '1.6250'],
      ['BI Rate (‰)', '1.3406'],
      ['Net Rate (‰)', '1.5681'],
      ['Final Net Rate (‰)', '1.5681'],
      ['Final Gross Rate (‰)', '2.1049'],
      ['Technical Premium (SAR)', '630,000'],
      ['Expected Premium (SAR)', '1,052,433'],
      ['Underwriting Score', '66.25'],              // was 82.00
      ['Capacity Grade', 'B'],
      ['UW Action', 'ACCEPT_WITH_CAUTION'],
      ['Max Capacity %', '20.00%'],
      ['Max Capacity (SAR)', '50,000,000'],         // GCC cap still binds
      ['Market vs Tech %', '54.20%'],               // 0.85 / 1.5681
      ['Market vs Tech Band', 'Between 50% to 60%'],
    ]);
    // Panel score drops too (95→30 at weight 0.15): 72.00 → 62.25.
    expect(screen.getByText('62.25')).toBeInTheDocument();
    expect(screen.getByText('score 30.00')).toBeInTheDocument();
    expect(screen.getByText('+25.00%')).toBeInTheDocument();
  });
});

describe('FacPricing save lifecycle', () => {
  it('wizard Next persists engine-input + extension edits and the UW panel notes', async () => {
    // No persisted pricing row: the load effect settles after one cycle.
    render(<FacPricing />);
    await waitFor(() => {
      expect(engineRow('Capacity Grade').getByText('D')).toBeInTheDocument();
    }, { timeout: 3000 });

    // Panel-owned edit (independent save path).
    fireEvent.change(
      screen.getByPlaceholderText('Underwriter notes on these factor selections…'),
      { target: { value: 'Checked with cedant' } },
    );
    // Engine input edit: commission 0.20 → 0.25 (does not touch `f`).
    fireEvent.change(screen.getByDisplayValue('0.20'), { target: { value: '0.25' } });
    // Extension toggle (ui_state payload).
    fireEvent.click(screen.getByRole('checkbox', { name: /Earthquake \+15%/ }));

    // Let the engine debounce flush so the persisted snapshot is current:
    // denom 1−0.25−0.05−0.005 = 0.695 → gross = 1.425 / 0.695 = 2.0504.
    await waitFor(() => {
      expect(screen.getByText('2.0504')).toBeInTheDocument();
    }, { timeout: 3000 });

    fireEvent.click(screen.getByRole('button', { name: 'WIZ-NEXT' }));
    await waitFor(() => expect(wiz.next).toBe(true));

    // UW panel saved through its own endpoint, with the typed notes.
    expect(apiMock.facSaveUwFactors).toHaveBeenCalledTimes(1);
    expect(apiMock.facSaveUwFactors).toHaveBeenCalledWith('R-1', {
      selections: {}, notes: 'Checked with cedant',
    });

    expect(apiMock.facSavePricing).toHaveBeenCalledTimes(1);
    const [savedId, payload] = apiMock.facSavePricing.mock.calls[0];
    expect(savedId).toBe('R-1');
    // The edits travel in the payload.
    expect(payload.commission_pct).toBe(0.25);
    expect(payload.ui_state).toEqual({ selectedExtensions: ['natcat_eq'], customExtensions: [] });
    // Untouched engine inputs keep their defaults.
    expect(payload.indemnity_months).toBe(12);
    expect(payload.margin_pct).toBe(0.05);
    expect(payload.other_expenses_pct).toBe(0.005);
    expect(payload.market_rate_pm).toBeNull();
    expect(payload.extra_cover_loadings).toEqual([]);
    // Manual section: empty numerics persist as '' / weights as numbers.
    expect(payload.market_rate_per_mille).toBe('');
    expect(payload.market_weight_pct).toBe(50);
    expect(payload.uw_adjustment_pct).toBe(0);
    // Engine snapshot rides along (no UW selections ⇒ score 16 ⇒ D/DECLINE).
    expect(payload.engine_version).toBe('1.0.0');
    expect(payload.underwriting_score).toBeCloseTo(16, 5);
    expect(payload.capacity_grade).toBe('D');
    expect(payload.uw_action).toBe('DECLINE');
    expect(payload.max_capacity_pct).toBe(0);
    expect(payload.max_capacity_sar).toBe(0);
    expect(payload.technical_rate_pm).toBeCloseTo(1.2, 10);
    expect(payload.final_gross_rate_pm).toBeCloseTo(2.05036, 4);
    expect(payload.technical_premium).toBeCloseTo(600000, 5);
    expect(payload.expected_premium).toBeCloseTo(1025179.86, 1);
    expect(payload.engine_warnings.length).toBeGreaterThan(0);
    // No final premium in the manual section ⇒ no risk header sync.
    expect(apiMock.facUpdateRisk).not.toHaveBeenCalled();

    // Second Next is a no-op (state no longer dirty).
    fireEvent.click(screen.getByRole('button', { name: 'WIZ-NEXT' }));
    await waitFor(() => expect(wiz.next).toBe(true));
    expect(apiMock.facSavePricing).toHaveBeenCalledTimes(1);
  });

  it('F1 FIXED: manual pricing-field edits survive and are saved by wizard Next', async () => {
    render(<FacPricing />);
    await waitFor(() => {
      expect(screen.getAllByText('500,000,000').length).toBeGreaterThan(0);
    }, { timeout: 3000 });
    expect(apiMock.facGetRisk).toHaveBeenCalledTimes(1);

    // Edit a manual (`f`-state) field — the market source.
    fireEvent.change(
      screen.getByPlaceholderText('e.g. Market benchmark 2026, Broker indication'),
      { target: { value: 'Direct cedant quote' } },
    );
    // The edit must NOT re-trigger the primary load (load is one-shot per
    // risk now — the old [f] dependency caused refetch loops + dirty wipes).
    expect(apiMock.facGetRisk).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'WIZ-NEXT' }));
    await waitFor(() => expect(wiz.next).toBe(true));

    // The edit rides the save payload to the server.
    expect(apiMock.facSavePricing).toHaveBeenCalledTimes(1);
    expect(apiMock.facSavePricing.mock.calls[0][1]).toEqual(
      expect.objectContaining({ market_source: 'Direct cedant quote' }),
    );
    expect(screen.getByDisplayValue('Direct cedant quote')).toBeInTheDocument();
  });

  it('F2 FIXED: save failure toasts via the global toast and blocks navigation', async () => {
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      apiMock.facSavePricing.mockRejectedValue(
        Object.assign(new Error('API PUT → 500: db down'), { status: 500 }),
      );
      render(<FacPricing />);
      await waitFor(() => {
        expect(engineRow('Capacity Grade').getByText('D')).toBeInTheDocument();
      }, { timeout: 3000 });

      // Dirty the screen via an engine input (survives the F1 reset).
      fireEvent.change(screen.getByDisplayValue('0.20'), { target: { value: '0.25' } });

      // The failure toasts through the app-wide ToastProvider hook (no
      // window.showToast — that global never existed) and save() returns
      // false so the wizard blocks navigation.
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

describe('FacPricing extensions & extra covers', () => {
  it('extra cover loadings multiply the engine net rate; custom extensions load the manual rate', async () => {
    // p=null baseline (no UW selections): net = 0.8×1.5 + 0.2×1.125 = 1.4250,
    // gross = 1.425 / 0.745 = 1.9128.
    render(<FacPricing />);
    await waitFor(() => {
      expect(screen.getByText('1.9128')).toBeInTheDocument();
    }, { timeout: 3000 });
    expect(engineRow('Final Net Rate (‰)').getByText('1.4250')).toBeInTheDocument();

    // ── Engine extra cover: +4% additive loading on the net rate ──
    fireEvent.change(screen.getByPlaceholderText('New cover label'), {
      target: { value: 'War risk' },
    });
    fireEvent.change(screen.getByPlaceholderText('0..1'), { target: { value: '0.04' } });
    const [engineAdd, extensionAdd] = screen.getAllByRole('button', { name: '+ Add' });
    fireEvent.click(engineAdd);

    // final net = 1.425 × 1.04 = 1.4820; gross = 1.482 / 0.745 = 1.9893.
    await waitFor(() => {
      expect(screen.getByText('1.9893')).toBeInTheDocument();
    }, { timeout: 3000 });
    expect(engineRow('Net Rate (‰)').getByText('1.4250')).toBeInTheDocument();
    expect(engineRow('Final Net Rate (‰)').getByText('1.4820')).toBeInTheDocument();
    expect(screen.getByDisplayValue('War risk')).toBeInTheDocument();

    // Removing the cover restores the baseline.
    fireEvent.click(screen.getByRole('button', { name: 'Remove cover loading War risk' }));
    await waitFor(() => {
      expect(screen.getByText('1.9128')).toBeInTheDocument();
    }, { timeout: 3000 });
    expect(engineRow('Final Net Rate (‰)').getByText('1.4250')).toBeInTheDocument();

    // ── Custom extension: auto-checked on add, feeds the manual loading ──
    fireEvent.change(screen.getByPlaceholderText('Custom extension name'), {
      target: { value: 'Sabotage' },
    });
    fireEvent.change(screen.getByPlaceholderText('Loading %'), { target: { value: '7' } });
    fireEvent.click(extensionAdd);

    expect(screen.getByRole('checkbox', { name: /Sabotage \+7%/ })).toBeChecked();
    expect(screen.getByText('Total Extensions Loading: +7%')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Remove Sabotage' }));
    expect(screen.queryByText(/Total Extensions Loading/)).toBeNull();
    expect(screen.queryByRole('checkbox', { name: /Sabotage/ })).toBeNull();
  });
});

describe('FacPricing error path', () => {
  it('F3 FIXED: primary load failure surfaces an alert with Retry, which recovers', async () => {
    const boom = Object.assign(new Error('API GET → 500: down'), { status: 500 });
    apiMock.facGetRisk.mockRejectedValueOnce(boom);

    render(<FacPricing />);

    // AsyncBoundary surfaces the failure instead of painting an
    // empty-but-normal-looking form (the old silent degrade).
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not load/i);
    expect(screen.queryByText('① Market Rate Pricing')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(apiMock.facGetRisk).toHaveBeenCalledTimes(2);
    await waitFor(() => {
      expect(screen.getByText('① Market Rate Pricing')).toBeInTheDocument();
    });
  });
});
