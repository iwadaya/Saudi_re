// DashboardScreen — the portfolio analytics dashboard. Covers the initial
// filters + page load, the KPI tiles, and tab switching re-fetching the page.
// api + Topbar + the DOM-measuring labelWidth helper are mocked for a hermetic,
// crash-free render.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const { apiMock } = vi.hoisted(() => ({
  apiMock: { dashboardFilters: vi.fn(), dashboardPage: vi.fn() },
}));
vi.mock('../../api', () => ({ api: apiMock }));
vi.mock('../../components/Topbar', () => ({ default: ({ title }) => <div data-testid="topbar">{title}</div> }));
vi.mock('./labelWidth', () => ({ fitLabelColumn: vi.fn() }));

const { default: DashboardScreen } = await import('./DashboardScreen.jsx');

const FILTERS = { uwYears: ['2024', '2023'], months: ['01', '02'], regions: ['GCC'], treatyTypes: ['Quota Share'], currencies: ['USD', 'SAR', 'GBP'] };
const PAGE = {
  kpis: { contracts: 5, premium: 1_000_000, exposure: 2_000_000, balance: 1.2, avgRol: 0.05, avgUwMargin: 0.1 },
  series: { premiumByMonth: [] },
  byRegion: [], byLob: [], byYear: [], byBand: [], byBalanceBand: [], byTreaty: [],
};

afterEach(() => { cleanup(); vi.clearAllMocks(); });
beforeEach(() => {
  apiMock.dashboardFilters.mockResolvedValue(FILTERS);
  apiMock.dashboardPage.mockResolvedValue(PAGE);
});

describe('DashboardScreen', () => {
  it('loads filters + the default page and renders the KPI tiles', async () => {
    render(<DashboardScreen />);
    expect(apiMock.dashboardFilters).toHaveBeenCalled();
    await waitFor(() => expect(apiMock.dashboardPage).toHaveBeenCalledWith('portfolio-overview', expect.anything()));
    // KPI tiles render once loading resolves — scope to the tile strip since
    // "Premium"/"Exposure" also appear as table headers.
    await screen.findByText('Contracts');
    const kpis = within(document.querySelector('.dash-kpis'));
    expect(kpis.getByText('Contracts')).toBeInTheDocument();
    expect(kpis.getByText('Premium')).toBeInTheDocument();
    expect(kpis.getByText('Avg ROL')).toBeInTheDocument();
  });

  it('renders every dashboard tab', async () => {
    render(<DashboardScreen />);
    await screen.findByText('Contracts');
    for (const label of ['Portfolio Overview', 'Regional Analysis', 'Return Analysis (Proportional)']) {
      expect(screen.getByRole('button', { name: label })).toBeInTheDocument();
    }
  });

  it('switching tabs re-fetches the page for the selected tab', async () => {
    render(<DashboardScreen />);
    await screen.findByText('Contracts');
    apiMock.dashboardPage.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'Regional Analysis' }));
    await waitFor(() => expect(apiMock.dashboardPage).toHaveBeenCalledWith('regional-analysis', expect.anything()));
  });

  it('renders the Strata-style technical matrix + band sections with a chart toggle', async () => {
    apiMock.dashboardPage.mockResolvedValue({
      kpis: {},
      treatyKindByType: { 'Quota Share': 'PROP', 'Cat XL': 'NP' },
      byTreatyType: [
        { treatyType: 'Quota Share', kind: 'PROP', premium: 100, exposure: 300, rol: null, balance: 3, uwMargin: 0.12 },
        { treatyType: 'Cat XL', kind: 'NP', premium: 40, exposure: 800, rol: 0.05, balance: null, uwMargin: -0.04 },
      ],
      treatyBalanceByYear: { columns: ['2024'], rows: [{ key: 'Quota Share', region: 'Quota Share', values: { 2024: 3 }, total: 3 }], totals: { values: { 2024: 3 }, total: 3 } },
      treatyRolByYear: { columns: ['2024'], rows: [{ key: 'Cat XL', region: 'Cat XL', values: { 2024: 0.05 }, total: 0.05 }], totals: { values: { 2024: 0.05 }, total: 0.05 } },
      treatyUwMarginByYear: { columns: ['2024'], rows: [{ key: 'Quota Share', region: 'Quota Share', values: { 2024: 0.12 }, total: 0.12 }], totals: { values: { 2024: 0.05 }, total: 0.05 } },
      treatyPremiumByYear: { columns: ['2024'], rows: [], totals: { values: {}, total: 0 } },
      rolBands: [{ band: '0–5%', contracts: 2, premium: 40, exposure: 800, rol: 0.04, uwMargin: -0.04 }],
      balanceBands: [{ band: '1–3×', contracts: 3, premium: 100, exposure: 300, balance: 3, uwMargin: 0.12 }],
    });
    render(<DashboardScreen />);
    await screen.findByText('Contracts');
    fireEvent.click(screen.getByRole('button', { name: 'Portfolio Technical Analysis' }));
    await screen.findByText(/Technical Matrix/i);
    // diagonal-split cells render
    expect(document.querySelectorAll('.dash-tech .dash-tcell').length).toBeGreaterThan(0);
    // band section renders, and toggling to Chart swaps the table for the SVG
    expect(screen.getByText('Non-Proportional — ROL Bands')).toBeInTheDocument();
    const chartBtns = screen.getAllByRole('button', { name: 'Chart' });
    fireEvent.click(chartBtns[0]);
    await waitFor(() => expect(document.querySelector('.dash-combo-svg')).toBeInTheDocument());
  });
});
