// NpPremiumsTable.test.jsx
//
// Covers the premiums-table inflation panel after the country/average fixes:
//   • Country resolves from the loaded treaty header (not just the
//     appState.npTreatyDetail slice, which is not reliably hydrated on this
//     screen in NP/quote mode) so it never renders "—" / fails to load country
//     inflation when the slice is empty.
//   • Selecting "Use average inflation" applies the average and never
//     white-screens, even when the inflation rows are empty / not yet loaded
//     (the array-guard regression that used to throw in computeCumulative).
//   • Switching back to "Use country inflation" reloads country values.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import NpPremiumsTable from './NpPremiumsTable.jsx';
import ScreenErrorBoundary from '../../../components/ScreenErrorBoundary.jsx';
import { renderBindScreen } from '../../../test/bindPathTestUtils.jsx';

const { apiMock } = vi.hoisted(() => ({ apiMock: {} }));
vi.mock('../../../api', () => ({ api: apiMock, default: apiMock }));

const COUNTRY_INFLATION = [
  { uwYear: 2020, inflationPct: 3 },
  { uwYear: 2021, inflationPct: 4 },
  { uwYear: 2022, inflationPct: 5 },
];

function installApi(overrides = {}) {
  Object.keys(apiMock).forEach((k) => delete apiMock[k]);
  Object.assign(apiMock, {
    getNpEgnpiYear: vi.fn().mockResolvedValue([]),
    getNonPropTreaty: vi.fn().mockResolvedValue({ detail: {}, terms: {} }),
    // Country lives on the contract header — NOT on the non-prop payload.
    getContract: vi.fn().mockResolvedValue({
      header: { country_id: 'country-sa', country_name: 'Saudi Arabia' },
    }),
    getRefInflation: vi.fn().mockResolvedValue(COUNTRY_INFLATION),
    getRefListItems: vi.fn().mockResolvedValue([
      { id: 'country-sa', name: 'Saudi Arabia' },
      { id: 'country-ae', name: 'United Arab Emirates' },
    ]),
    saveNpEgnpiYear: vi.fn().mockResolvedValue({ ok: true }),
    saveNonPropTreaty: vi.fn().mockResolvedValue({ ok: true }),
    ...overrides,
  });
}

const boundaryFallback = () => screen.queryByText(/This screen failed to render/i);

function renderScreen({ npTreatyDetail, quoteMode = false } = {}) {
  return renderBindScreen(
    <ScreenErrorBoundary><NpPremiumsTable /></ScreenErrorBoundary>,
    {
      route: quoteMode ? '/np/quote-premiums' : '/np/premiums',
      contractId: 'contract-prem-001',
      quoteMode,
      appState: {
        wizardMode: 'NP',
        npTreatyDetail: npTreatyDetail || {
          // Deliberately NO country here — it must be derived from the loaded
          // treaty header, which is the whole point of fix A.
          contractId: 'contract-prem-001',
          startYear: 2020,
          renewalDate: '2022-06-01',
          cedantName: 'Test Cedant',
          treatyTypeName: 'Risk XL',
        },
      },
    },
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  installApi();
});

describe('NpPremiumsTable — country resolution + average inflation', () => {
  it('resolves country from the loaded treaty header and loads its inflation', async () => {
    renderScreen();

    // Country name resolves from the header, not "—".
    expect(await screen.findByText('Saudi Arabia')).toBeInTheDocument();

    // Country inflation is fetched for the resolved country + UW year range.
    await waitFor(() => {
      expect(apiMock.getRefInflation).toHaveBeenCalledWith('country-sa', 2020, 2022);
    });
    // Values landed in the inflation column.
    await waitFor(() => {
      expect(screen.getAllByDisplayValue('3%').length).toBeGreaterThan(0);
    });
    expect(boundaryFallback()).toBeNull();
  });

  it('works in quote mode (country from the quote header)', async () => {
    renderScreen({ quoteMode: true });

    expect(await screen.findByText('Saudi Arabia')).toBeInTheDocument();
    // Quote routing flows the { quote: true } option through every load.
    await waitFor(() => {
      expect(apiMock.getContract).toHaveBeenCalledWith('contract-prem-001', { quote: true });
    });
    expect(boundaryFallback()).toBeNull();
  });

  it('toggling to average inflation never blanks the screen, even with empty rows', async () => {
    // No country inflation data → inflation rows have no values to start from.
    installApi({ getRefInflation: vi.fn().mockResolvedValue([]) });
    renderScreen();
    await screen.findByText('Saudi Arabia');

    // averageInflationPct is '' here — applying it must not throw (0% default).
    fireEvent.click(screen.getByLabelText(/Use average inflation/i));

    await waitFor(() => {
      expect(screen.getByText(/Average inflation %/i)).toBeInTheDocument();
    });
    expect(boundaryFallback()).toBeNull();
  });

  it('applies a typed average across all UW years without crashing', async () => {
    renderScreen();
    await screen.findByText('Saudi Arabia');

    fireEvent.click(screen.getByLabelText(/Use average inflation/i));
    const avgInput = await screen.findByLabelText(/Average inflation percent/i);
    fireEvent.focus(avgInput);
    fireEvent.change(avgInput, { target: { value: '7' } });
    fireEvent.blur(avgInput);
    fireEvent.click(screen.getByRole('button', { name: /Apply/i }));

    // Every inflation row now shows the average; cumulative column stays numeric.
    await waitFor(() => {
      expect(screen.getAllByDisplayValue('7%').length).toBeGreaterThan(0);
    });
    expect(screen.queryByText(/NaN/)).toBeNull();
    expect(boundaryFallback()).toBeNull();
  });

  it('switching back to country inflation reloads country values', async () => {
    renderScreen();
    await screen.findByText('Saudi Arabia');
    await waitFor(() => expect(apiMock.getRefInflation).toHaveBeenCalled());

    fireEvent.click(screen.getByLabelText(/Use average inflation/i));
    await waitFor(() => expect(screen.getByText(/Average inflation %/i)).toBeInTheDocument());

    apiMock.getRefInflation.mockClear();
    fireEvent.click(screen.getByLabelText(/Use country inflation/i));

    await waitFor(() => expect(apiMock.getRefInflation).toHaveBeenCalled());
    expect(boundaryFallback()).toBeNull();
  });

  it('lets the user pick a country when it cannot be derived', async () => {
    // No country anywhere: empty slice + header without a country.
    installApi({ getContract: vi.fn().mockResolvedValue({ header: {} }) });
    renderScreen({
      npTreatyDetail: {
        contractId: 'contract-prem-001',
        startYear: 2020,
        renewalDate: '2022-06-01',
      },
    });

    // Country starts unresolved ("—") and the COUNTRY button opens a picker.
    await waitFor(() => expect(apiMock.getContract).toHaveBeenCalled());
    fireEvent.click(screen.getByRole('button', { name: 'COUNTRY' }));

    const select = await screen.findByLabelText(/Select country for inflation/i);
    fireEvent.change(select, { target: { value: 'country-ae' } });

    // Picking a country drives the country-inflation load for it.
    await waitFor(() => {
      expect(apiMock.getRefInflation).toHaveBeenCalledWith('country-ae', 2020, 2022);
    });
    expect(await screen.findByText('United Arab Emirates')).toBeInTheDocument();
    expect(boundaryFallback()).toBeNull();
  });
});
