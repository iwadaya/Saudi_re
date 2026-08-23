// FacDashboardScreen — the facultative portfolio dashboard. Covers the initial
// filters + page load, the KPI tiles, tab switching re-fetching the page, and
// the fac technical matrix (Rate ‰ for proportional, ROL for XL). api + Topbar
// + the DOM-measuring labelWidth helper are mocked for a hermetic render.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const { apiMock } = vi.hoisted(() => ({
  apiMock: { facDashboardFilters: vi.fn(), facDashboardPage: vi.fn() },
}));
vi.mock('../../api', () => ({ api: apiMock }));
vi.mock('../../components/Topbar', () => ({ default: ({ title }) => <div data-testid="topbar">{title}</div> }));
vi.mock('../dashboard/labelWidth', () => ({ fitLabelColumn: vi.fn() }));

const { default: FacDashboardScreen } = await import('./FacDashboardScreen.jsx');

const FILTERS = { uwYears: ['2024', '2023'], months: ['01', '02'], regions: ['Middle East'], facTypes: ['Proportional FAC', 'XL FAC'], currencies: ['USD', 'SAR', 'GBP'] };
const PAGE = {
  kpis: { risks: 5, premium: 1_000_000, exposure: 2_000_000, rate: 1.2, avgRol: 0.05, avgUwMargin: 0.1 },
  series: { premiumByMonth: [] },
};

afterEach(() => { cleanup(); vi.clearAllMocks(); });
beforeEach(() => {
  apiMock.facDashboardFilters.mockResolvedValue(FILTERS);
  apiMock.facDashboardPage.mockResolvedValue(PAGE);
});

describe('FacDashboardScreen', () => {
  it('loads filters + the default page and renders the KPI tiles', async () => {
    render(<FacDashboardScreen />);
    expect(apiMock.facDashboardFilters).toHaveBeenCalled();
    await waitFor(() => expect(apiMock.facDashboardPage).toHaveBeenCalledWith('portfolio-overview', expect.anything()));
    // KPI tiles render once loading resolves — scope to the tile strip since
    // "Premium"/"Exposure" also appear as table headers.
    await screen.findByText('Risks');
    const kpis = within(document.querySelector('.dash-kpis'));
    expect(kpis.getByText('Risks')).toBeInTheDocument();
    expect(kpis.getByText('Premium')).toBeInTheDocument();
    expect(kpis.getByText('Avg Rate (Prop)')).toBeInTheDocument();
    expect(kpis.getByText('Avg ROL (XL)')).toBeInTheDocument();
    // the prop headline is a per-mille rate, not a balance multiple
    expect(kpis.getByText('1.20‰')).toBeInTheDocument();
  });

  it('renders every dashboard tab and the FAC Type filter', async () => {
    render(<FacDashboardScreen />);
    await screen.findByText('Risks');
    for (const label of ['Portfolio Overview', 'Regional Analysis', 'Return Analysis (Proportional)']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
    expect(screen.getByText('FAC Type')).toBeInTheDocument();
    expect(screen.getByRole('option', { name: 'Proportional FAC' })).toBeInTheDocument();
  });

  it('switching tabs re-fetches the page for the selected tab', async () => {
    render(<FacDashboardScreen />);
    await screen.findByText('Risks');
    apiMock.facDashboardPage.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Regional Analysis' }));
    await waitFor(() => expect(apiMock.facDashboardPage).toHaveBeenCalledWith('regional-analysis', expect.anything()));
  });

  it('renders the Strata-style technical matrix + band sections with a chart toggle', async () => {
    apiMock.facDashboardPage.mockResolvedValue({
      kpis: {},
      facKindByType: { 'Proportional FAC': 'PROP', 'XL FAC': 'NP' },
      byFacType: [
        { facType: 'Proportional FAC', kind: 'PROP', premium: 100, exposure: 300000, rol: null, rate: 0.9, uwMargin: 0.12 },
        { facType: 'XL FAC', kind: 'NP', premium: 40, exposure: 800, rol: 0.05, rate: null, uwMargin: -0.04 },
      ],
      facTypeRateByYear: { columns: ['2024'], rows: [{ key: 'Proportional FAC', region: 'Proportional FAC', values: { 2024: 0.9 }, total: 0.9 }], totals: { values: { 2024: 0.9 }, total: 0.9 } },
      facTypeRolByYear: { columns: ['2024'], rows: [{ key: 'XL FAC', region: 'XL FAC', values: { 2024: 0.05 }, total: 0.05 }], totals: { values: { 2024: 0.05 }, total: 0.05 } },
      facTypeUwMarginByYear: { columns: ['2024'], rows: [{ key: 'Proportional FAC', region: 'Proportional FAC', values: { 2024: 0.12 }, total: 0.12 }], totals: { values: { 2024: 0.05 }, total: 0.05 } },
      facTypePremiumByYear: { columns: ['2024'], rows: [], totals: { values: {}, total: 0 } },
      rolBands: [{ band: '0–5%', risks: 2, premium: 40, exposure: 800, rol: 0.04, uwMargin: -0.04 }],
      rateBands: [{ band: '0.5–1‰', risks: 3, premium: 100, exposure: 300000, rate: 0.9, uwMargin: 0.12 }],
    });
    render(<FacDashboardScreen />);
    await screen.findByText('Risks');
    fireEvent.click(screen.getByRole('button', { name: 'Portfolio Technical Analysis' }));
    await screen.findByText(/Technical Matrix/i);
    // diagonal-split cells render, with the prop rate shown in ‰
    expect(document.querySelectorAll('.dash-tech .dash-tcell').length).toBeGreaterThan(0);
    expect(screen.getAllByText('0.90‰').length).toBeGreaterThan(0);
    // band sections render, and toggling to Chart swaps the table for the SVG
    expect(screen.getByText('XL FAC — ROL Bands')).toBeInTheDocument();
    expect(screen.getByText('Proportional FAC — Rate Bands')).toBeInTheDocument();
    const chartBtns = screen.getAllByRole('button', { name: 'Chart' });
    fireEvent.click(chartBtns[0]);
    await waitFor(() => expect(document.querySelector('.dash-combo-svg')).toBeInTheDocument());
  });
});
