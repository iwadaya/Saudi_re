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
});
