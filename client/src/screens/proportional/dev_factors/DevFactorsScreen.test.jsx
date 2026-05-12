import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import DevFactorsScreen from './DevFactorsScreen.jsx';

const { apiMock, appStateMock, contractIdRef } = vi.hoisted(() => ({
  apiMock: {
    getTriangle: vi.fn(),
    getDevFactors: vi.fn(),
    getPricingPattern: vi.fn(),
    saveDevFactors: vi.fn(),
    savePricingPattern: vi.fn(),
  },
  appStateMock: {
    quoteMode: false,
    propTreatyDetail: {},
    triangleMeta: { startYear: 2021, renewalYear: 2026 },
  },
  contractIdRef: { current: 'contract-1' },
}));

vi.mock('../../../api', () => ({ api: apiMock }));
vi.mock('../../../hooks/useContractId', () => ({ useContractId: () => contractIdRef.current }));
vi.mock('../../../context/AppContext', () => ({ useAppState: () => ({ state: appStateMock }) }));
vi.mock('../../../components/WizardLayout', () => ({
  default: ({ children }) => (
    <section>
      {typeof children === 'function' ? children({ showToast: () => {} }) : children}
    </section>
  ),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  contractIdRef.current = 'contract-1';
  appStateMock.quoteMode = false;
  appStateMock.propTreatyDetail = {};
  appStateMock.triangleMeta = { startYear: 2021, renewalYear: 2026 };
  apiMock.getTriangle.mockResolvedValue({ cells: [] });
  apiMock.getDevFactors.mockResolvedValue([]);
  apiMock.getPricingPattern.mockResolvedValue(null);
  apiMock.saveDevFactors.mockResolvedValue({ ok: true });
  apiMock.savePricingPattern.mockResolvedValue({ ok: true });
});

describe('DevFactorsScreen', () => {
  it('renders the empty premium dev-factor state without triangle data', async () => {
    render(
      <DevFactorsScreen
        routeKey="PROP_PREMIUM_DEV_FACTORS"
        title="Premium Development Factors"
        headerPill="PROPORTIONAL TREATY: PREMIUM DEVELOPMENT FACTORS"
      />,
    );

    expect(await screen.findByText(/No triangle data found/i)).toBeInTheDocument();
  });

  it('applies link-ratio factors without repeatedly updating parent state', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    apiMock.getTriangle.mockResolvedValue({
      cells: [
        { origin_year: 2021, dev_months: 12, cum_value: 100 },
        { origin_year: 2021, dev_months: 24, cum_value: 120 },
        { origin_year: 2021, dev_months: 36, cum_value: 144 },
        { origin_year: 2021, dev_months: 48, cum_value: 160 },
        { origin_year: 2021, dev_months: 60, cum_value: 176 },
        { origin_year: 2022, dev_months: 12, cum_value: 110 },
        { origin_year: 2022, dev_months: 24, cum_value: 132 },
        { origin_year: 2022, dev_months: 36, cum_value: 150 },
        { origin_year: 2022, dev_months: 48, cum_value: 170 },
        { origin_year: 2023, dev_months: 12, cum_value: 90 },
        { origin_year: 2023, dev_months: 24, cum_value: 108 },
        { origin_year: 2023, dev_months: 36, cum_value: 126 },
        { origin_year: 2024, dev_months: 12, cum_value: 80 },
        { origin_year: 2024, dev_months: 24, cum_value: 96 },
        { origin_year: 2025, dev_months: 12, cum_value: 70 },
      ],
    });

    try {
      render(
        <DevFactorsScreen
          routeKey="PROP_PREMIUM_DEV_FACTORS"
          title="Premium Development Factors"
          headerPill="PROPORTIONAL TREATY: PREMIUM DEVELOPMENT FACTORS"
        />,
      );

      expect(await screen.findByText(/Actual Development Factors/i)).toBeInTheDocument();
      fireEvent.click(screen.getAllByText(/Link Ratios/i)[0]);
      expect(await screen.findByText(/^Weighted$/i)).toBeInTheDocument();

      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 50));
      });

      expect(consoleErrorSpy.mock.calls.some(call =>
        call.some(arg => String(arg).includes('Maximum update depth exceeded')),
      )).toBe(false);
    } finally {
      consoleErrorSpy.mockRestore();
    }
  });

  it('saves link-ratio factors with a backward-compatible chosen source', async () => {
    apiMock.getTriangle.mockResolvedValue({
      cells: [
        { origin_year: 2021, dev_months: 12, cum_value: 100 },
        { origin_year: 2021, dev_months: 24, cum_value: 120 },
        { origin_year: 2021, dev_months: 36, cum_value: 144 },
        { origin_year: 2021, dev_months: 48, cum_value: 160 },
        { origin_year: 2021, dev_months: 60, cum_value: 176 },
        { origin_year: 2022, dev_months: 12, cum_value: 110 },
        { origin_year: 2022, dev_months: 24, cum_value: 132 },
        { origin_year: 2022, dev_months: 36, cum_value: 150 },
        { origin_year: 2022, dev_months: 48, cum_value: 170 },
        { origin_year: 2023, dev_months: 12, cum_value: 90 },
        { origin_year: 2023, dev_months: 24, cum_value: 108 },
        { origin_year: 2023, dev_months: 36, cum_value: 126 },
        { origin_year: 2024, dev_months: 12, cum_value: 80 },
        { origin_year: 2024, dev_months: 24, cum_value: 96 },
        { origin_year: 2025, dev_months: 12, cum_value: 70 },
      ],
    });

    render(
      <DevFactorsScreen
        routeKey="PROP_PREMIUM_DEV_FACTORS"
        title="Premium Development Factors"
        headerPill="PROPORTIONAL TREATY: PREMIUM DEVELOPMENT FACTORS"
      />,
    );

    expect(await screen.findByText(/Actual Development Factors/i)).toBeInTheDocument();
    fireEvent.click(screen.getAllByText(/Link Ratios/i)[0]);
    expect(await screen.findByText(/^Weighted$/i)).toBeInTheDocument();
    fireEvent.click(screen.getByText(/Save Link Ratio Factors/i));

    await waitFor(() => expect(apiMock.saveDevFactors).toHaveBeenCalledTimes(1));
    const factorsPayload = apiMock.saveDevFactors.mock.calls[0][2];
    expect(factorsPayload.factors.every(f => f.chosen_source === 'SELECTED')).toBe(true);

    await waitFor(() => expect(apiMock.savePricingPattern).toHaveBeenCalledTimes(1));
    const pricingPayload = apiMock.savePricingPattern.mock.calls[0][2];
    expect(pricingPayload.selected_factors.chosen_base).toBe('LINK_RATIO');
  });
});
