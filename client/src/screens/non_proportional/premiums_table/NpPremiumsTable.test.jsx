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

  it('selecting average inflation applies the average of the country curve', async () => {
    renderScreen();
    await screen.findByText('Saudi Arabia');
    // Country inflation (3/4/5%) must be loaded first.
    await waitFor(() => expect(screen.getAllByDisplayValue('3%').length).toBeGreaterThan(0));

    fireEvent.click(screen.getByLabelText(/Use average inflation/i));

    // Mean of 3/4/5 = 4 — seeded into the average field and applied to every row
    // (not 0% / blank, which was the "average not showing" regression).
    const avgInput = await screen.findByLabelText(/Average inflation percent/i);
    await waitFor(() => expect(avgInput).toHaveValue('4%'));
    expect(screen.getAllByDisplayValue('4%').length).toBeGreaterThan(1);
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

    // Country curve (3/4/5%) loads first. The distinct 3% and 5% — neither of
    // which equals the flat 4% average — are what prove the column holds the
    // real per-year curve rather than a flat value.
    await waitFor(() => expect(screen.getAllByDisplayValue('3%').length).toBeGreaterThan(0));
    expect(screen.getAllByDisplayValue('5%').length).toBeGreaterThan(0);

    fireEvent.click(screen.getByLabelText(/Use average inflation/i));
    await waitFor(() => expect(screen.getByText(/Average inflation %/i)).toBeInTheDocument());

    // Mean of 3/4/5 = 4 → the column collapses to a flat 4%; the distinct
    // country values (3% and 5%) are gone.
    await waitFor(() => expect(screen.queryAllByDisplayValue('3%')).toHaveLength(0));
    expect(screen.queryAllByDisplayValue('5%')).toHaveLength(0);
    expect(screen.getAllByDisplayValue('4%').length).toBeGreaterThan(1);

    apiMock.getRefInflation.mockClear();
    fireEvent.click(screen.getByLabelText(/Use country inflation/i));

    // The fix under test: switching back re-fetches AND the per-year country
    // curve actually repopulates — 3% and 5% reappear, not just a flat 4%.
    await waitFor(() => expect(apiMock.getRefInflation).toHaveBeenCalled());
    await waitFor(() => {
      expect(screen.getAllByDisplayValue('3%').length).toBeGreaterThan(0);
      expect(screen.getAllByDisplayValue('5%').length).toBeGreaterThan(0);
    });
    expect(boundaryFallback()).toBeNull();
  });

  it('re-seeds the average from a newly picked country without leaving the screen', async () => {
    // country-sa → 3/4/5 (mean 4); country-ae → 10/20/30 (mean 20).
    installApi({
      getRefInflation: vi.fn((id) =>
        Promise.resolve(
          String(id) === 'country-ae'
            ? [
                { uwYear: 2020, inflationPct: 10 },
                { uwYear: 2021, inflationPct: 20 },
                { uwYear: 2022, inflationPct: 30 },
              ]
            : COUNTRY_INFLATION,
        ),
      ),
    });
    renderScreen();
    await screen.findByText('Saudi Arabia');
    await waitFor(() => expect(screen.getAllByDisplayValue('3%').length).toBeGreaterThan(0));

    // Switch to average → flat mean of the loaded country curve (3/4/5 → 4%).
    fireEvent.click(screen.getByLabelText(/Use average inflation/i));
    const avgInput = await screen.findByLabelText(/Average inflation percent/i);
    await waitFor(() => expect(avgInput).toHaveValue('4%'));

    // Pick a different country WITHOUT leaving average mode.
    fireEvent.click(screen.getByRole('button', { name: 'COUNTRY' }));
    const select = await screen.findByLabelText(/Select country for inflation/i);
    fireEvent.change(select, { target: { value: 'country-ae' } });

    // The fix: it refetches for the new country and re-seeds the flat average
    // from its mean (10/20/30 → 20%) across every row — previously this only
    // updated after navigating away from the screen and back.
    await waitFor(() =>
      expect(apiMock.getRefInflation).toHaveBeenCalledWith('country-ae', 2020, 2022),
    );
    await waitFor(() => expect(avgInput).toHaveValue('20%'));
    expect(screen.getAllByDisplayValue('20%').length).toBeGreaterThan(1);
    expect(await screen.findByText('United Arab Emirates')).toBeInTheDocument();
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
