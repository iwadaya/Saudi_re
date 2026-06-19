// GemDamageRatioPanel.test.jsx — the GEM/HAZUS EQ damage-ratio panel:
// source-aware curve loading, the HAZUS calibration + placeholder guards,
// compute payload assembly, and the apply-to-cat hand-off.

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';
import GemDamageRatioPanel from './GemDamageRatioPanel.jsx';

const getGemScenario = vi.fn();
const getGemCurves = vi.fn();
const computeGemEqLoss = vi.fn();

// The panel imports `../../../api` (→ client/src/api) from this folder.
vi.mock('../../../api', () => ({
  api: {
    getGemScenario: (...a) => getGemScenario(...a),
    getGemCurves: (...a) => getGemCurves(...a),
    computeGemEqLoss: (...a) => computeGemEqLoss(...a),
  },
}));
// recharts needs real layout; stub it to pass-through wrappers.
vi.mock('recharts', () => {
  const Pass = ({ children }) => <div>{children}</div>;
  return {
    ResponsiveContainer: Pass, BarChart: Pass, Bar: Pass,
    XAxis: Pass, YAxis: Pass, CartesianGrid: Pass, Tooltip: Pass,
  };
});

// One CRESTA zone carrying EQ aggregate + the five occupancy splits.
const ZONE = {
  zone_id: 'SA-01', zone_name: 'Riyadh', eq_agg: 1_000_000,
  residential_bldg_pct: 30, commercial_bldg_pct: 25, commercial_cont_pct: 15,
  industrial_bldg_pct: 20, industrial_cont_pct: 10,
};

const GEM_LIST = [
  { id: 1, taxonomy: 'CR/LFINF/H:1/COM', occupancy: 'COM', loss_category: 'structural', imt: 'PGA', n_points: 40 },
  { id: 2, taxonomy: 'CR/LDUAL/H:4/RES', occupancy: 'RES', loss_category: 'structural', imt: 'PGA', n_points: 40 },
];
const HAZUS_LIST = [
  { id: 101, taxonomy: 'HAZUS:COM_PLACEHOLDER', occupancy: 'COM', loss_category: 'structural', imt: 'PGA', n_points: 40 },
];

const RESULT = {
  groundUpEqLoss: 250_000,
  effectiveMdr: 0.25,
  byZone: [{ zoneId: 'SA-01', zoneName: 'Riyadh', eqAgg: 1_000_000, zoneLoss: 250_000, effectiveMdr: 0.25, byBucket: [] }],
  warnings: [],
};

const renderPanel = (over = {}) => render(
  <GemDamageRatioPanel
    contractId="c-1"
    currency="SAR"
    catLayers={[{ cat: true }]}
    onApplyToCat={vi.fn()}
    {...over}
  />,
);

beforeEach(() => {
  vi.clearAllMocks();
  getGemScenario.mockResolvedValue({ scenario: null, zones: [ZONE], countryName: 'Saudi Arabia' });
  // Forward the source: GEM (or undefined) → GEM catalogue; HAZUS → HAZUS catalogue.
  getGemCurves.mockImplementation((params) =>
    Promise.resolve({ curves: params?.source === 'HAZUS' ? HAZUS_LIST : GEM_LIST }));
  computeGemEqLoss.mockResolvedValue(RESULT);
});

describe('GemDamageRatioPanel', () => {
  it('defaults to the GEM source + contract country and renders five occupancy selects', async () => {
    renderPanel();

    const selects = await screen.findAllByRole('combobox');
    expect(selects).toHaveLength(5);

    expect(screen.getByDisplayValue('Saudi Arabia')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'GEM' })).toHaveAttribute('aria-pressed', 'true');

    await waitFor(() => expect(getGemCurves).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'GEM', country: 'Saudi Arabia' }),
    ));
  });

  it('switches to HAZUS: re-queries with source HAZUS, shows both banners, repopulates selects', async () => {
    renderPanel();
    await screen.findAllByRole('combobox');

    fireEvent.click(screen.getByRole('button', { name: 'HAZUS' }));

    await waitFor(() => expect(getGemCurves).toHaveBeenCalledWith(
      expect.objectContaining({ source: 'HAZUS' }),
    ));
    // US-calibration caveat + placeholder-data warning.
    expect(await screen.findByText(/calibrated to US building types/i)).toBeInTheDocument();
    expect(await screen.findByText(/placeholder parameters/i)).toBeInTheDocument();
    // Selects now offer the HAZUS curve (one option per slot).
    expect(await screen.findAllByText('HAZUS:COM_PLACEHOLDER (PGA)')).not.toHaveLength(0);
  });

  it('calculates: forwards the assembled curveAssignments + intensities and renders the headline', async () => {
    renderPanel();
    // Wait for curves to load + auto-pick to assign before computing.
    await screen.findAllByText('CR/LFINF/H:1/COM (PGA)');

    fireEvent.change(await screen.findByLabelText('PGA'), { target: { value: '0.18' } });
    fireEvent.click(screen.getByRole('button', { name: /Calculate/i }));

    await waitFor(() => expect(computeGemEqLoss).toHaveBeenCalledWith('c-1', expect.objectContaining({
      curveAssignments: expect.objectContaining({ source: 'GEM' }),
      intensities: { PGA: 0.18 },
      persist: false,
    })));

    const headline = screen.getByText('Ground-up EQ loss').parentElement;
    expect(within(headline).getByText('SAR 250,000')).toBeInTheDocument();
  });

  it('renders the amber warnings callout when the result carries warnings', async () => {
    computeGemEqLoss.mockResolvedValueOnce({ ...RESULT, warnings: ['Commercial — building: missing PGA intensity'] });
    renderPanel();
    await screen.findAllByRole('combobox');

    fireEvent.change(await screen.findByLabelText('PGA'), { target: { value: '0.18' } });
    fireEvent.click(screen.getByRole('button', { name: /Calculate/i }));

    expect(await screen.findByText(/missing PGA intensity/i)).toBeInTheDocument();
  });

  it('applies the ground-up loss to cat, and disables Apply under the HAZUS placeholder warning', async () => {
    const onApplyToCat = vi.fn();
    renderPanel({ onApplyToCat });
    await screen.findAllByText('CR/LFINF/H:1/COM (PGA)');

    fireEvent.change(await screen.findByLabelText('PGA'), { target: { value: '0.18' } });
    fireEvent.click(screen.getByRole('button', { name: /Calculate/i }));

    const applyBtn = await screen.findByRole('button', { name: /Apply to cat burning cost/i });
    expect(applyBtn).toBeEnabled();
    fireEvent.click(applyBtn);
    expect(onApplyToCat).toHaveBeenCalledWith(250_000);

    // Switching to HAZUS surfaces the placeholder warning → Apply is blocked.
    fireEvent.click(screen.getByRole('button', { name: 'HAZUS' }));
    await screen.findByText(/placeholder parameters/i);
    await waitFor(() => expect(
      screen.getByRole('button', { name: /Apply to cat burning cost/i }),
    ).toBeDisabled());
  });
});
