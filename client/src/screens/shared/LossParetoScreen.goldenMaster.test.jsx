// LossParetoScreen.goldenMaster.test.jsx — Phase 4.2 golden master.
//
// Pins the EXACT rendered output (fitted α, return-period table, layer
// burning costs, chart geometry, snapshot payload) of LossParetoScreen
// for a realistic 24-loss fixture BEFORE the decomposition refactor.
// All literals below were computed by running the screen's own math on
// the fixture; the refactor must keep every one of them byte-identical.
//
// Fixture: the 24 inflated workbook losses from
// utils/paretoFit.verifyExcel.test.js (xm = 1,000,000 → α = 1.283856,
// n = 18, freq = 1.8/yr over 10 observation years).

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import LossParetoScreen from './LossParetoScreen.jsx';

const { apiMock, appStateMock, contractIdRef, toastSpy } = vi.hoisted(() => ({
  apiMock: {
    getContract: vi.fn(),
    getLargeLosses: vi.fn(),
    getCatLosses: vi.fn(),
    getLossSelectionLatest: vi.fn(),
    getNonPropTreaty: vi.fn(),
    getPortfolioLosses: vi.fn(),
    saveLossSelectionSnapshot: vi.fn(),
  },
  appStateMock: { wizardMode: 'NP', quoteMode: false, npTreatyDetail: {}, propTreatyDetail: {}, npStructureLayers: [] },
  contractIdRef: { current: 'contract-1' },
  toastSpy: vi.fn(),
}));

vi.mock('../../api', () => ({ api: apiMock }));
vi.mock('../../hooks/useContractId', () => ({ useContractId: () => contractIdRef.current }));
vi.mock('../../context/AppContext', () => ({ useAppState: () => ({ state: appStateMock }) }));
vi.mock('../../hooks/useToast', () => ({ useGlobalToast: () => toastSpy }));
vi.mock('../../components/WizardLayout', () => ({
  default: ({ children }) => (
    <div data-testid="wizard-layout">{typeof children === 'function' ? children() : children}</div>
  ),
}));

// 24 inflated incurred losses (descending) — workbook Tab 1.
const INFLATED = [
  4963200, 3955600, 3877500, 3583800, 3517500,
  2948000, 2658600, 2553600, 2316000, 1954800,
  1914000, 1785000, 1547700, 1433900, 1303200,
  1195950, 1155200, 1033900, 930600, 804000,
  697950, 570150, 443100, 351750,
];

const makeLosses = () => INFLATED.map((v, i) => ({
  loss_id: `LP-${String(i + 1).padStart(2, '0')}`,
  uw_year: 2015 + (i % 10),
  insured_name: `Insured ${i + 1}`,
  loss_name: `Event ${i + 1}`,
  date_of_loss: '2018-06-15',
  class_of_business: 'Property',
  paid: v,
  os: 0,
  incurred: v,
  inflation_factor: 1,
  is_selected: true,
}));

const RISK_LAYER = { layer: 'L1', peril_scope: 'RISK', attachment: 1_000_000, layer_limit: 4_000_000 };
const CAT_LAYER = { layer: 'L2', peril_scope: 'CAT', attachment: 5_000_000, layer_limit: 10_000_000 };

/** textContent of the stats-table row whose <th> is `label`. */
const statRow = (label) => screen.getByText(label).closest('tr').textContent;
/** textContent of the table row containing the given rendered text. */
const rowWith = (text) => screen.getByText(text).closest('tr').textContent;

afterEach(() => { cleanup(); vi.clearAllMocks(); });

beforeEach(() => {
  contractIdRef.current = 'contract-1';
  appStateMock.wizardMode = 'NP';
  appStateMock.quoteMode = false;
  appStateMock.npTreatyDetail = {};
  appStateMock.propTreatyDetail = {};
  appStateMock.npStructureLayers = [RISK_LAYER, CAT_LAYER];
  apiMock.getContract.mockResolvedValue({ header: {}, detail: {} });
  apiMock.getLargeLosses.mockResolvedValue({ losses: makeLosses() });
  apiMock.getCatLosses.mockResolvedValue({ losses: makeLosses() });
  apiMock.getLossSelectionLatest.mockResolvedValue(null);
  apiMock.getNonPropTreaty.mockResolvedValue({ layers: [] });
  apiMock.getPortfolioLosses.mockResolvedValue({ losses: [], treatyCount: 0 });
  apiMock.saveLossSelectionSnapshot.mockResolvedValue({ ok: true });
});

describe('golden master — large losses, Pareto fit restored from snapshot', () => {
  beforeEach(() => {
    apiMock.getLossSelectionLatest.mockResolvedValue({
      snapshot: {
        snapshot_id: 'snap-1',
        pareto_xm: 1_000_000,
        pareto_alpha: 1.1, // stale value — the fit effect must recompute α from the data
        pareto_limit: 0,
        observation_years: 10,
        active_distribution: 'pareto',
        return_period_curve: { layer_burning_cost: { wEmp: 50, wModel: 50 } },
      },
    });
  });

  const renderLarge = async () => {
    const utils = render(<LossParetoScreen routeKey="X" title="T" headerPill="P" lossType="large" />);
    expect(await screen.findByText('Severity Distribution Fit')).toBeInTheDocument();
    // α refit (1.1 → 1.284) lands one render after hydration
    expect(await screen.findByDisplayValue('1.284')).toBeInTheDocument();
    return utils;
  };

  it('hydrates the parameter fields: xm, structure-derived limit, refitted alpha, years', async () => {
    await renderLarge();
    expect(screen.getByDisplayValue('1,000,000')).toBeInTheDocument(); // xm
    expect(screen.getByDisplayValue('4,000,000')).toBeInTheDocument(); // RISK layer cap, not snapshot limit
    expect(screen.getByDisplayValue('1.284')).toBeInTheDocument();    // α = 1.283856 refitted
    expect(screen.getByDisplayValue('10')).toBeInTheDocument();       // observation years
  });

  it('renders the goodness-of-fit table with all four fitted distributions', async () => {
    await renderLarge();
    expect(rowWith('α=1.284')).toBe('Paretoα=1.284180.19140.4877Good');
    expect(rowWith('μ=14.59 σ=0.47')).toBe('Lognormalμ=14.59 σ=0.47180.12461.0000Good');
    expect(rowWith('λ=0.000001')).toBe('ExponentialBESTλ=0.000001180.10761.0000Good');
    expect(rowWith('k=1.135 λ=1489039')).toBe('Weibullk=1.135 λ=1489039180.11491.0000Good');
  });

  it('renders the loss statistics card', async () => {
    await renderLarge();
    expect(statRow('Count')).toBe('Count24');
    expect(statRow('Total Incurred')).toBe('Total Incurred47,495,000');
    expect(statRow('Average')).toBe('Average1,978,958');
    expect(statRow('Max / Min')).toBe('Max / Min4,963,200 / 351,750');
    expect(statRow('Std Deviation')).toBe('Std Deviation1,249,727');
    expect(statRow('Top 5 Concentration')).toBe('Top 5 Concentration41.9%');
    expect(statRow('Avg Yearly Loss')).toBe('Avg Yearly Loss4,749,500');
    expect(statRow('Frequency (≥ xm)')).toBe('Frequency (≥ xm)1.80 / yr');
    expect(statRow('Risk Pure Premium')).toBe('Risk Pure Premium2,325,485');
  });

  it('renders the fitted Pareto return-period table with over-limit flags', async () => {
    await renderLarge();
    expect(rowWith('1 in 500 yr')).toBe('1 in 500 yr126,542,807 ▲');
    expect(rowWith('1 in 250 yr')).toBe('1 in 250 yr73,750,355 ▲');
    expect(rowWith('1 in 100 yr')).toBe('1 in 100 yr36,124,946 ▲');
    expect(rowWith('1 in 50 yr')).toBe('1 in 50 yr21,053,963 ▲');
    expect(rowWith('1 in 25 yr')).toBe('1 in 25 yr12,270,451 ▲');
    expect(rowWith('1 in 20 yr')).toBe('1 in 20 yr10,312,808 ▲');
    expect(rowWith('1 in 10 yr')).toBe('1 in 10 yr6,010,403 ▲');
    expect(rowWith('1 in 5 yr')).toBe('1 in 5 yr3,502,920');
    expect(rowWith('1 in 2 yr')).toBe('1 in 2 yr1,715,826');
  });

  it('renders the Pareto ranking table with cum% and per-loss return periods', async () => {
    await renderLarge();
    expect(rowWith('Insured 1')).toBe('12015Insured 1Event 14,963,20004,963,2001.004,963,20010.4%4.3y');
    expect(rowWith('Insured 18')).toContain('0.6y'); // 1,033,900 → RP 0.58y
    expect(rowWith('Insured 24')).toContain('100.0%');
  });

  it('renders the blended layer burning cost for the RISK layer only', async () => {
    await renderLarge();
    expect(rowWith('L1')).toBe('L11,000,0004,000,0001-in-0.6y64.244%58.137%61.190%2,447,615');
    expect(screen.queryByText('L2')).toBeNull(); // CAT layer out of scope for large losses
  });

  it('renders the frequency–severity modal: parameter explanations + chart geometry', async () => {
    const { container } = await renderLarge();
    fireEvent.click(screen.getByText('View Sev-Freq Curve'));

    // Parameter explanations (severity + frequency models), scoped to the modal
    const modal = within(container.querySelector('.llp-modal'));
    expect(modal.getByText('1 < α < 2 → finite mean, infinite variance (very heavy tail)')).toBeInTheDocument();
    expect(modal.getByText('0.1914 (p=0.488)')).toBeInTheDocument();
    expect(modal.getByText('1.800 / yr')).toBeInTheDocument();
    expect(modal.getByText('83.5%')).toBeInTheDocument();  // P(N≥1) = 1 − e^−1.8
    expect(modal.getByText('26.9%')).toBeInTheDocument();  // P(N≥3)
    expect(modal.getByText('E[N] = 1.80')).toBeInTheDocument();
    expect(modal.getByText('Poisson(λ = 1.80)')).toBeInTheDocument();
    expect(modal.getByText('P(at least 1) = 83.5%')).toBeInTheDocument();

    // Return-period chart: 18 empirical points; the largest loss plots at
    // RP (n+1)/1 = 19yr with pinned log–log coordinates.
    const points = container.querySelectorAll('circle[r="4"]');
    expect(points).toHaveLength(18);
    expect(points[0].querySelector('title').textContent).toBe('RP 19.0yr — 4,963,200');
    expect(Number(points[0].getAttribute('cx'))).toBeCloseTo(377.9655717862719, 6);
    expect(Number(points[0].getAttribute('cy'))).toBeCloseTo(68.05466370452547, 6);
    expect(container.querySelector('polyline[stroke="url(#cg)"]')).not.toBeNull();
  });

  it('auto-saves the snapshot payload with the exact fitted values', async () => {
    await renderLarge();
    await waitFor(() => expect(apiMock.saveLossSelectionSnapshot).toHaveBeenCalled(), { timeout: 4000 });

    const [cid, lossType, payload, qm] = apiMock.saveLossSelectionSnapshot.mock.calls[0];
    expect(cid).toBe('contract-1');
    expect(lossType).toBe('large');
    expect(qm).toBeUndefined();

    expect(payload.selected_count).toBe(24);
    expect(payload.active_distribution).toBe('pareto');
    expect(payload.pareto_xm).toBe(1_000_000);
    expect(payload.pareto_limit).toBe(4_000_000);
    expect(payload.observation_years).toBe(10);
    expect(payload.pareto_alpha).toBeCloseTo(1.2838559161701648, 12);

    expect(payload.selected_losses[0]).toEqual({
      loss_id: 'LP-01', uw_year: 2015, insured_name: 'Insured 1', loss_name: 'Event 1',
      date_of_loss: '2018-06-15', class_of_business: 'Property',
      paid: 4963200, os: 0, incurred: 4963200, inflation_factor: 1, inflated: 4963200,
    });

    expect(payload.distribution_fits.map((f) => f.paramStr)).toEqual([
      'α=1.284', 'μ=14.59 σ=0.47', 'λ=0.000001', 'k=1.135 λ=1489039',
    ]);
    expect(payload.distribution_fits[0].ks.ks).toBeCloseTo(0.191405, 5);
    expect(payload.distribution_fits[0].ks.pValue).toBeCloseTo(0.487711, 4);

    expect(payload.return_period_key_points.rp10).toBeCloseTo(6010403.15641481, 5);
    expect(payload.return_period_key_points.rp50).toBeCloseTo(21053963.190461647, 5);
    expect(payload.return_period_key_points.rp100).toBeCloseTo(36124946.10264107, 5);
    expect(payload.return_period_key_points.rp250).toBeCloseTo(73750354.92456442, 5);

    const rpc = payload.return_period_curve;
    expect(rpc.activeDist).toBe('pareto');
    expect(rpc.xm).toBe(1_000_000);
    expect(rpc.limit).toBe(4_000_000);
    expect(rpc.yearsOvr).toBe('10');
    expect(rpc.points[0].rp).toBe(500);
    expect(rpc.points[0].loss).toBeCloseTo(126542806.81499188, 5);
    expect(rpc.layer_burning_cost.wEmp).toBe(50);
    expect(rpc.layer_burning_cost.wModel).toBe(50);
    const row = rpc.layer_burning_cost.rows[0];
    expect(row.layer).toBe('L1');
    expect(row.deductible).toBe(1_000_000);
    expect(row.limit).toBe(4_000_000);
    expect(row.return_period).toBeCloseTo(0.5555555555555556, 12);
    expect(row.empirical_rol).toBeCloseTo(0.64243625, 10);
    expect(row.model_rol).toBeCloseTo(0.5813712506254862, 10);
    expect(row.blended_rol).toBeCloseTo(0.6119037503127431, 10);
    expect(row.blended_annual_loss).toBeCloseTo(2447615.0012509725, 5);
    expect(rpc.oep_input).toBeUndefined();
    expect(rpc.third_party_rp).toBeUndefined();

    // sha256 when crypto.subtle exists in the test env, djb2 fallback otherwise
    expect([
      'd6b03108eb7f2b4cb1eca812297d2c298ca8aca66806bb2e27fb2285364434a7',
      'e77881e4',
    ]).toContain(payload.assumptions_hash);

    expect(await screen.findByText('✓ Saved')).toBeInTheDocument();
  });
});

describe('golden master — cat losses with third-party blend and OEP curve', () => {
  beforeEach(() => {
    apiMock.getLossSelectionLatest.mockResolvedValue({
      snapshot: {
        snapshot_id: 'snap-2',
        pareto_xm: 1_000_000,
        pareto_limit: 0,
        observation_years: 10,
        active_distribution: 'pareto',
        return_period_curve: {
          layer_burning_cost: { wEmp: 50, wModel: 50 },
          oep_input: [2, 5, 10, 25, 50, 100, 200, 250, 500].map((rp) => ({
            rp: String(rp),
            loss: { 10: '8,000,000', 50: '15,000,000', 100: '20,000,000', 250: '30,000,000' }[rp] || '',
          })),
          third_party_rp: {
            rows: [
              { rp: '10', loss: '5,000,000' },
              { rp: '100', loss: '20,000,000' },
              { rp: '250', loss: '30,000,000' },
            ],
            source: 'Aon Catalyst',
            selection: 'BLEND',
            blend: 50,
          },
        },
      },
    });
  });

  const renderCat = async () => {
    const utils = render(<LossParetoScreen routeKey="X" title="T" headerPill="P" lossType="cat" />);
    expect(await screen.findByText('Severity Distribution Fit')).toBeInTheDocument();
    expect(await screen.findByDisplayValue('1.284')).toBeInTheDocument();
    return utils;
  };

  it('uses the CAT layer cap and blends fitted RPs 50/50 with the third-party curve', async () => {
    await renderCat();
    expect(screen.getByDisplayValue('10,000,000')).toBeInTheDocument(); // CAT layer cap
    expect(screen.getByText('Blend 50% fitted / 50% Aon Catalyst')).toBeInTheDocument();
    expect(screen.getByText('Weighted blend of fitted + third-party')).toBeInTheDocument();
    expect(screen.getByText('Compare with TP →')).toBeInTheDocument();

    expect(rowWith('1 in 500 yr')).toBe('1 in 500 yr78,271,403 ▲');
    expect(rowWith('1 in 25 yr')).toBe('1 in 25 yr11,619,775 ▲');
    expect(rowWith('1 in 20 yr')).toBe('1 in 20 yr9,914,129');
    expect(rowWith('1 in 10 yr')).toBe('1 in 10 yr5,505,202');
    expect(rowWith('1 in 2 yr')).toBe('1 in 2 yr3,357,913');

    expect(statRow('Risk Pure Premium')).toBe('Risk Pure Premium3,130,772');
  });

  it('prices the CAT layer: blended table row and OEP burning cost', async () => {
    await renderCat();
    expect(rowWith('L2')).toBe('L25,000,00010,000,0001-in-4.4y—10.758%5.379%537,925');
    expect(screen.queryByText('L1')).toBeNull(); // RISK layer out of scope for cat

    // expand the OEP card
    fireEvent.click(screen.getByText(/Cat Model OEP Burning Cost/));
    expect(screen.getByDisplayValue('8,000,000')).toBeInTheDocument();
    expect(screen.getByDisplayValue('15,000,000')).toBeInTheDocument();
    expect(screen.getByDisplayValue('20,000,000')).toBeInTheDocument();
    expect(screen.getByDisplayValue('30,000,000')).toBeInTheDocument();

    // OEP layer row: attach (5M) below min OEP loss (8M) → RP '—';
    // ∫[5M,15M] survival ≈ 421,000/yr → 4.210% ROL on the 10M layer.
    const oepRows = screen.getAllByText('L2').map((el) => el.closest('tr').textContent);
    expect(oepRows).toContain('L2—421,0004.210%');
  });

  it('auto-saves the cat payload with OEP + third-party sections', async () => {
    await renderCat();
    await waitFor(() => expect(apiMock.saveLossSelectionSnapshot).toHaveBeenCalled(), { timeout: 4000 });

    const [, lossType, payload] = apiMock.saveLossSelectionSnapshot.mock.calls[0];
    expect(lossType).toBe('cat');
    expect(payload.pareto_limit).toBe(10_000_000);

    const rpc = payload.return_period_curve;
    expect(rpc.oep_input).toHaveLength(9);
    expect(rpc.oep_layer_burning_cost).toHaveLength(1);
    expect(rpc.oep_layer_burning_cost[0].layer).toBe('L2');
    expect(rpc.oep_layer_burning_cost[0].return_period).toBeNull();
    expect(rpc.oep_layer_burning_cost[0].annual_loss).toBeCloseTo(421000, 3);
    expect(rpc.oep_layer_burning_cost[0].rol).toBeCloseTo(0.0421, 10);

    expect(rpc.third_party_rp.selection).toBe('BLEND');
    expect(rpc.third_party_rp.blend).toBe(50);
    expect(rpc.third_party_rp.source).toBe('Aon Catalyst');
    expect(rpc.third_party_rp.rows).toHaveLength(3);
    expect(rpc.third_party_rp.effective_points[0].rp).toBe(500);
    expect(rpc.third_party_rp.effective_points[0].loss).toBeCloseTo(78271403.40749595, 4);
  });
});

describe('golden master — Stop Loss treaty fits yearly aggregates', () => {
  beforeEach(() => {
    appStateMock.npTreatyDetail = { treatyTypeName: 'Stop Loss' };
    appStateMock.npStructureLayers = []; // forces the server-side structure fetch
    apiMock.getLossSelectionLatest.mockResolvedValue(null); // no snapshot → defaults
  });

  it('fits Pareto to the 10 yearly aggregates with xm defaulted to the smallest loss', async () => {
    render(<LossParetoScreen routeKey="X" title="T" headerPill="P" lossType="large" />);
    expect(await screen.findByText('Aggregate Distribution Fit')).toBeInTheDocument();
    expect(screen.getByText(/YEARLY AGGREGATES/)).toBeInTheDocument();
    expect(screen.getByText(/\(10 years\)/)).toBeInTheDocument();

    // xm defaults to the smallest per-loss value, NOT the smallest aggregate
    expect(await screen.findByDisplayValue('351,750')).toBeInTheDocument();
    expect(await screen.findByDisplayValue('0.391')).toBeInTheDocument(); // α fitted on aggregates

    expect(statRow('Count')).toBe('Count10');
    expect(statRow('Total Incurred')).toBe('Total Incurred47,495,000');
    expect(statRow('Frequency (≥ xm)')).toBe('Frequency (≥ xm)1.00 / yr');
    // α ≤ 1 → infinite mean → layer pricing refuses
    expect(statRow('Risk Pure Premium')).toBe('Risk Pure Premium0');
    expect(screen.getByText('⚠ α ≤ 1: infinite mean')).toBeInTheDocument();

    expect(screen.getByText('Yearly Aggregates · Ranking')).toBeInTheDocument();
    expect(rowWith('2015')).toBe('120157,575,15015.9%');

    // limit = 0 (no layers, no caps) → no over-limit flag even on huge RPs
    expect(rowWith('1 in 10 yr')).toBe('1 in 10 yr126,799,032');
    expect(rowWith('1 in 100 yr')).toBe('1 in 100 yr45,708,584,029');

    // GoF on the aggregates: lognormal wins, Pareto tail is a poor fit
    expect(rowWith('α=0.391')).toBe('Paretoα=0.391100.55310.0024Poor');
    expect(rowWith('μ=15.33 σ=0.30')).toBe('LognormalBESTμ=15.33 σ=0.30100.11701.0000Good');
  });
});
