import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import PropPricing from './PropPricing.jsx';
import { renderBindScreen, makeHttpError } from '../../../test/bindPathTestUtils.jsx';
import { bindIds, makeBindPathApiMock } from '../../../test/bindPathFixtures.js';

const { apiMock } = vi.hoisted(() => ({ apiMock: {} }));

vi.mock('../../../api', () => ({ api: apiMock }));

function resetApi(overrides = {}) {
  Object.keys(apiMock).forEach((key) => delete apiMock[key]);
  Object.assign(apiMock, makeBindPathApiMock(vi.fn, overrides));
}

function renderScreen({ quoteMode = false } = {}) {
  return renderBindScreen(<PropPricing />, {
    route: '/prop/pricing',
    contractId: bindIds.contract,
    quoteMode,
    appState: {
      wizardMode: 'PROP',
      propTreatyDetail: {
        contractId: bindIds.contract,
        cedantName: 'Audit Cedant',
        countryName: 'Saudi Arabia',
        currencyCode: 'SAR',
        treatyTypeName: 'Quota Share',
        quotaShareEpi: '6000000',
        fixedCommissionQSPct: '24%',
        brokeragePct: '7.5%',
        taxesPct: '2%',
      },
    },
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  resetApi();
});

describe('PropPricing integration', () => {
  it('loads treaty-mode pricing, edits a UW override, and saves', async () => {
    const { container } = renderScreen();

    expect(await screen.findByText(/Component Pricing Comparison/i)).toBeInTheDocument();
    const overrideInputs = screen.getAllByPlaceholderText('Override');
    fireEvent.change(overrideInputs[0], { target: { value: '47.00%' } });
    fireEvent.click(container.querySelector('.bbg-btn--save'));

    await waitFor(() => expect(apiMock.savePricingComposite).toHaveBeenCalled());
    const [payload] = apiMock.savePricingComposite.mock.calls.at(-1);
    const attritional = payload.components.find(c => c.component_name === 'Attritional Loss Ratio');
    expect(attritional.uw_value).toBe('47.00%');
    expect(await screen.findByText('Saved')).toBeInTheDocument();
  });

  it('shows the STALE_WRITE modal and saves again only after overwrite is chosen', async () => {
    apiMock.savePricingComposite.mockRejectedValueOnce(makeHttpError({
      status: 409,
      code: 'STALE_WRITE',
      message: 'Stale write',
      body: { current: '2026-05-01T12:00:00.000Z', expected: '2026-05-01T11:00:00.000Z' },
    }));
    const { container } = renderScreen();

    await screen.findByText(/Component Pricing Comparison/i);
    fireEvent.click(container.querySelector('.bbg-btn--save'));

    expect(await screen.findByRole('dialog', { name: /concurrent edit detected/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /save anyway, overwriting theirs/i }));

    await waitFor(() => expect(apiMock.savePricingComposite).toHaveBeenCalledTimes(2));
    expect(apiMock.savePricingComposite.mock.calls[1][1]).toMatchObject({ ifUnmodifiedSince: '*' });
  });

  it('surfaces PRICING_DRIFT 422 responses in the component save message', async () => {
    apiMock.savePricingComposite.mockRejectedValueOnce(makeHttpError({
      status: 422,
      code: 'PRICING_DRIFT',
      message: 'Pricing outputs failed server-side spot check',
      body: {
        requestId: 'req-prop-drift',
        drifts: [{ layer_number: 1, section: 'RISK', magnitude: 0.02 }],
      },
    }));
    const { container } = renderScreen();

    await screen.findByText(/Component Pricing Comparison/i);
    fireEvent.click(container.querySelector('.bbg-btn--save'));

    expect(await screen.findByText(/pricing outputs failed server-side spot check/i)).toBeInTheDocument();
    expect(screen.getByText(/req-prop-drift/i)).toBeInTheDocument();
  });

  it('opens proportional bind-path insights, aggregate drilldown, offer, and decline flows', async () => {
    const { container } = renderScreen();

    expect(await screen.findByText(/Component Pricing Comparison/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /^Checklist$/i }));
    await waitFor(() => expect(container.querySelector('.bbg-modal--fullscreen')).toHaveTextContent(/Checklist/i));
    fireEvent.click(container.querySelector('.bbg-modal-x'));

    fireEvent.click(screen.getByRole('button', { name: /Aggregate Analysis/i }));
    await waitFor(() => expect(screen.getAllByText(/Aggregate Analysis/i).length).toBeGreaterThan(1));
    fireEvent.click(screen.getByText('✕'));

    fireEvent.click(screen.getByRole('button', { name: /Offer Treaty/i }));
    await waitFor(() => expect(document.body).toHaveTextContent(/Offer Treaty/i));
    fireEvent.change(screen.getAllByPlaceholderText('0.0%')[0], { target: { value: '30%' } });
    fireEvent.click(screen.getByRole('button', { name: /Close/i }));

    fireEvent.click(screen.getByRole('button', { name: /^Decline$/i }));
    await waitFor(() => expect(container.querySelector('.bbg-modal')).toHaveTextContent(/Decline Treaty/i));
    fireEvent.change(screen.getByPlaceholderText(/Reason for declining/i), { target: { value: 'Capacity full' } });
    fireEvent.click(screen.getByRole('button', { name: /Confirm Decline/i }));

    await waitFor(() => expect(apiMock.declineContract).toHaveBeenCalled());
    expect(apiMock.declineContract.mock.calls.at(-1)[1]).toBe('Capacity full');
  });

  it('renders under quote mode without changing the pricing payload shape', async () => {
    const { container } = renderScreen({ quoteMode: true });

    await screen.findByText(/Component Pricing Comparison/i);
    fireEvent.click(container.querySelector('.bbg-btn--save'));

    await waitFor(() => expect(apiMock.savePricingComposite).toHaveBeenCalled());
    expect(apiMock.savePricingComposite.mock.calls.at(-1)[0]).toMatchObject({ contract_id: bindIds.contract });
  });
});
