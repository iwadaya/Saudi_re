// Deep-link hydration (audit F6): NP Final Pricing opened in a fresh session —
// npTreatyDetail slice empty, contractId resolved from storage — must derive
// the header (treaty type, currency, mode) from the server via the
// useNpTreatyDetail fallback instead of rendering the RISK & CAT XL / SAR
// defaults with a phantom Risk XL section.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, screen, waitFor } from '@testing-library/react';
import NpFinalPricing from './NpFinalPricing.jsx';
import { renderBindScreen } from '../../../test/bindPathTestUtils.jsx';
import { bindIds, makeBindPathApiMock, npTreatySnapshot } from '../../../test/bindPathFixtures.js';

const { apiMock } = vi.hoisted(() => ({ apiMock: {} }));

vi.mock('../../../api', () => ({ api: apiMock }));

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  Object.keys(apiMock).forEach((key) => delete apiMock[key]);
  Object.assign(apiMock, makeBindPathApiMock(vi.fn, {
    getContract: vi.fn().mockResolvedValue({
      contract_id: bindIds.contract,
      class_ids: [bindIds.cobProperty],
      header: {
        treaty_type_name: 'CAT XL',
        currency_code: 'USD',
        uw_year: 2026,
        cedant_name: 'Audit Cedant',
        country_name: 'Saudi Arabia',
      },
    }),
    getNonPropTreaty: vi.fn().mockResolvedValue({
      ...npTreatySnapshot,
      detail: {
        est_gnpi: 10000000,
        xl_type: 'Gross XL',
        accounting_method: 'Losses Occurring',
        number_of_layers: 1,
        deductible: 500000,
      },
    }),
  }));
});

describe('NpFinalPricing deep link (audit F6)', () => {
  it('derives treaty type, currency and mode from the server when the slice is empty', async () => {
    renderBindScreen(<NpFinalPricing />, {
      route: '/np/final-pricing',
      contractId: bindIds.contract,
      quoteMode: false,
      // Fresh session: nothing hydrated the detail slice.
      appState: { wizardMode: 'NP', npTreatyDetail: {} },
    });

    // The header resolves to the real treaty type — not the BOTH-mode default.
    await waitFor(() => expect(screen.getAllByText('CAT XL').length).toBeGreaterThan(0));
    expect(screen.queryByText('RISK & CAT XL')).not.toBeInTheDocument();
    // Currency comes from the contract header, not the SAR fallback.
    await waitFor(() => expect(screen.getAllByText(/USD/).length).toBeGreaterThan(0));
    // CAT-only mode: the phantom Risk XL layer section must not render.
    expect(screen.queryByText(/Risk XL Layers/i)).not.toBeInTheDocument();
    // The fallback actually fetched the header pair.
    expect(apiMock.getContract).toHaveBeenCalled();
  });
});
