import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import NpFinalPricing from './NpFinalPricing.jsx';
import { renderBindScreen, makeHttpError } from '../../../test/bindPathTestUtils.jsx';
import { bindIds, makeBindPathApiMock, npTreatySnapshot } from '../../../test/bindPathFixtures.js';

const { apiMock } = vi.hoisted(() => ({ apiMock: {} }));

vi.mock('../../../api', () => ({ api: apiMock }));

function resetApi(overrides = {}) {
  Object.keys(apiMock).forEach((key) => delete apiMock[key]);
  Object.assign(apiMock, makeBindPathApiMock(vi.fn, overrides));
}

function renderScreen({ quoteMode = false } = {}) {
  return renderBindScreen(<NpFinalPricing />, {
    route: quoteMode ? '/np/final-quote' : '/np/final-pricing',
    contractId: quoteMode ? bindIds.quote : bindIds.contract,
    quoteMode,
    appState: {
      wizardMode: 'NP',
      npTreatyDetail: {
        contractId: quoteMode ? bindIds.quote : bindIds.contract,
        cedant: 'Audit Cedant',
        cedantName: 'Audit Cedant',
        countryName: 'Saudi Arabia',
        currencyCode: 'SAR',
        classIds: [bindIds.cobMotor, bindIds.cobProperty],
        classOfBusinessIds: [bindIds.cobMotor, bindIds.cobProperty],
        lineOfBusinessLabels: ['Motor', 'Property'],
        xlType: 'RISK',
        numberOfLayers: 2,
        deductible: 100000,
        brokeragePct: 7,
      },
      npStructureLayers: npTreatySnapshot.terms.np_structure.layers,
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

describe('NpFinalPricing integration', () => {
  it('loads treaty-mode pricing, edits a layer UW price, and saves', async () => {
    const { container } = renderScreen();

    expect(await screen.findByText(/Risk XL Layers/i)).toBeInTheDocument();
    const reinsurerInput = container.querySelector('.np-mini-input--reinsurer');
    expect(reinsurerInput).toBeTruthy();

    fireEvent.change(reinsurerInput, { target: { value: '9.25%' } });
    fireEvent.click(container.querySelector('.bbg-btn--save'));

    await waitFor(() => expect(apiMock.saveNpPricing).toHaveBeenCalled());
    await waitFor(() => expect(apiMock.saveNonPropTreaty).toHaveBeenCalled());
    const [, payload] = apiMock.saveNpPricing.mock.calls.at(-1);
    expect(payload.layer_margins[0]).toMatchObject({ layer_number: 1, uw_price: 9.25 });
  });

  it('shows the STALE_WRITE modal and allows an explicit overwrite', async () => {
    apiMock.saveNpPricing.mockRejectedValueOnce(makeHttpError({
      status: 409,
      code: 'STALE_WRITE',
      message: 'Stale write',
      body: { current: '2026-05-01T12:00:00.000Z', expected: '2026-05-01T11:00:00.000Z' },
    }));
    renderScreen();

    await screen.findByText(/Risk XL Layers/i);
    fireEvent.click(document.querySelector('.bbg-btn--save'));

    expect(await screen.findByRole('dialog', { name: /concurrent edit detected/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /save anyway, overwriting theirs/i }));

    await waitFor(() => expect(apiMock.saveNpPricing).toHaveBeenCalledTimes(2));
    expect(apiMock.saveNpPricing.mock.calls[1][2]).toMatchObject({ ifUnmodifiedSince: '*' });
  });

  it('surfaces PRICING_DRIFT 422 responses in the save banner', async () => {
    apiMock.saveNpPricing.mockRejectedValueOnce(makeHttpError({
      status: 422,
      code: 'PRICING_DRIFT',
      message: 'Pricing outputs failed server-side spot check',
      body: {
        requestId: 'req-drift-001',
        drifts: [{ layer_number: 1, section: 'RISK', magnitude: 0.12 }],
      },
    }));
    renderScreen();

    await screen.findByText(/Risk XL Layers/i);
    fireEvent.click(document.querySelector('.bbg-btn--save'));

    expect(await screen.findByRole('alert')).toHaveTextContent(/pricing outputs failed server-side spot check/i);
    expect(screen.getByRole('alert')).toHaveTextContent(/req-drift-001/i);
  });

  it('opens the treaty-mode analysis and offer modals from the bind decision path', async () => {
    const { container } = renderScreen();

    expect(await screen.findByText(/Risk XL Layers/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /Reinsurer Analysis/i }));
    await waitFor(() => expect(container.querySelector('.screen-modal[role="dialog"]')).toHaveTextContent(/Reinsurer Analysis/i));
    fireEvent.click(container.querySelector('.screen-modal-close'));

    fireEvent.click(screen.getByRole('button', { name: /Technical Analysis/i }));
    await waitFor(() => expect(container.querySelector('.screen-modal[role="dialog"]')).toHaveTextContent(/Technical Analysis/i));
    fireEvent.click(container.querySelector('.screen-modal-close'));

    fireEvent.click(screen.getByRole('button', { name: /Market Analysis/i }));
    expect(await screen.findByText(/Analysis · Layer Pricing/i)).toBeInTheDocument();
    fireEvent.click(container.querySelector('.bm-modal .bm-pill'));

    fireEvent.click(screen.getByRole('button', { name: /^Checklist$/i }));
    await waitFor(() => expect(container.querySelector('.bbg-modal--fullscreen')).toHaveTextContent(/Underwriting Checklist/i));
    fireEvent.click(container.querySelector('.bbg-modal-x'));

    fireEvent.click(screen.getByRole('button', { name: /Offer Treaty/i }));
    await waitFor(() => expect(container.querySelector('.off-modal')).toHaveTextContent(/Offer Treaty/i));
    fireEvent.click(container.querySelector('.off-ai-apply'));
    expect(container.querySelector('.off-modal')).toHaveTextContent(/Treaty Classification/i);
    fireEvent.click(container.querySelector('.off-modal .bbg-modal-x'));

    fireEvent.click(screen.getByRole('button', { name: /^Decline$/i }));
    expect(await screen.findByRole('dialog')).toHaveTextContent(/Decline Treaty/i);
    fireEvent.change(container.querySelector('.screen-modal textarea'), { target: { value: 'Not in appetite' } });
    fireEvent.click(screen.getByRole('button', { name: /Cancel/i }));
  });

  it('uses quote-mode save paths when final quote pricing is open', async () => {
    const { container } = renderScreen({ quoteMode: true });

    expect(await screen.findByText(/Quote Pricing/i)).toBeInTheDocument();
    fireEvent.click(container.querySelector('.bm-topbar .bm-pill[title^="Save expiring"]'));

    await waitFor(() => expect(apiMock.saveNpPricing).toHaveBeenCalled());
    expect(apiMock.saveNpPricing.mock.calls.at(-1)[2]).toMatchObject({ quote: true });
  });

  it('supports quote-mode structure editing, benchmark modal, and COB participation', async () => {
    const { container } = renderScreen({ quoteMode: true });

    expect(await screen.findByText(/Quote Pricing/i)).toBeInTheDocument();
    expect(await screen.findByText(/Expiring Structure/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /\+ Add Structure/i }));
    expect(await screen.findByText(/Structure 1/i)).toBeInTheDocument();

    const structure = screen.getByText(/Structure 1/i).closest('section');
    const cells = structure.querySelectorAll('input.bm-cell');
    fireEvent.change(cells[0], { target: { value: '750000' } });
    fireEvent.change(cells[1], { target: { value: '100000' } });
    fireEvent.change(cells[2], { target: { value: '2.5%' } });
    fireEvent.change(cells[3], { target: { value: '1.5%' } });
    fireEvent.change(cells[4], { target: { value: '4.0%' } });

    await waitFor(() => {
      const calculatedCells = Array.from(structure.querySelectorAll('.bm-calc'));
      expect(calculatedCells.some(cell => /%/.test(cell.textContent || ''))).toBe(true);
    });

    const pricingGraphButton = Array.from(structure.querySelectorAll('button')).find(button => /Pricing Graph/i.test(button.textContent || ''));
    fireEvent.click(pricingGraphButton);
    expect(await screen.findByText(/AI Limit/i)).toBeInTheDocument();
    expect(await screen.findByText(/Within Country Average/i)).toBeInTheDocument();
    expect(screen.getByText(/Deductible\/Premium/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Close/i }));

    const pricingAnalysisButton = Array.from(structure.querySelectorAll('button')).find(button => /^Pricing Analysis$/i.test((button.textContent || '').trim()));
    fireEvent.click(pricingAnalysisButton);
    expect(await screen.findByText(/Risk Pricing Analysis/i)).toBeInTheDocument();
    expect(screen.getByText(/Cat Pricing Analysis/i)).toBeInTheDocument();
    expect(screen.getByText(/Total Section/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Close/i }));

    const approveBox = structure.querySelector('input[aria-label="Send Structure 1 for Approval"]');
    fireEvent.click(approveBox);
    expect(approveBox).toBeChecked();

    const analysisButton = Array.from(structure.querySelectorAll('button')).find(button => /^Market Analysis$/i.test((button.textContent || '').trim()));
    fireEvent.click(analysisButton);
    expect(await screen.findByText(/Analysis · Structure 1/i)).toBeInTheDocument();
    fireEvent.click(container.querySelector('.bm-modal .bm-pill'));

    const cobCheckboxes = container.querySelectorAll('.bm-cob-section input[type="checkbox"]');
    expect(cobCheckboxes.length).toBeGreaterThan(0);
    fireEvent.click(cobCheckboxes[0]);

    fireEvent.click(screen.getByRole('button', { name: /\+ Layer/i }));
    expect(structure.querySelectorAll('tbody tr').length).toBeGreaterThan(1);
    fireEvent.click(structure.querySelector('.bm-del'));
    fireEvent.click(structure.querySelector('button[title="Remove structure"]'));
    await waitFor(() => expect(screen.queryByText(/Structure 1/i)).not.toBeInTheDocument());
  });

  it('runs the NP actuarial engine for quote structure pure burn and exposure', async () => {
    resetApi({
      getLargeLosses: vi.fn().mockResolvedValue({
        losses: [
          { uw_year: 2024, incurred: 400000, os: 0, is_selected: true, class_of_business: 'Motor' },
        ],
      }),
      getCatLosses: vi.fn().mockResolvedValue({ losses: [] }),
      getLossSelectionLatest: vi.fn((_, lossType) => Promise.resolve(
        lossType === 'large' ? { snapshot: { observation_years: 1 } } : { snapshot: { observation_years: 1 } },
      )),
      getNpEgnpiYear: vi.fn().mockResolvedValue([{ uw_year: 2024, egnpi: 800000 }]),
      getRiskProfile: vi.fn().mockResolvedValue({
        profile: { pml_percentage: 100, selected_curve: 'Y3', gross_loss_ratio: 100 },
        bands: [{ no_of_risks: 1, total_sum_insured: 1000000 }],
      }),
      getCrestaData: vi.fn().mockResolvedValue([]),
    });
    const { container } = renderScreen({ quoteMode: true });

    expect(await screen.findByText(/Quote Pricing/i)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /\+ Add Structure/i }));
    const structure = await screen.findByText(/Structure 1/i).then((node) => node.closest('section'));
    const cells = structure.querySelectorAll('input.bm-cell');
    fireEvent.change(cells[0], { target: { value: '750000' } });
    fireEvent.change(cells[1], { target: { value: '100000' } });
    await waitFor(() => {
      const priced = screen.getByText(/Structure 1/i).closest('section').querySelectorAll('input.bm-cell');
      expect(priced[2].value).toMatch(/%$/);
    });

    fireEvent.click(screen.getByRole('button', { name: /Run Actuarial Engine/i }));

    await waitFor(() => expect(apiMock.getLargeLosses).toHaveBeenCalled());
    await waitFor(() => {
      const refreshed = screen.getByText(/Structure 1/i).closest('section').querySelectorAll('input.bm-cell');
      expect(refreshed[2].value).toMatch(/^37\.5/);
      expect(refreshed[4].value).toMatch(/%$/);
      expect(refreshed[4].value).not.toBe('');
    });
    expect(apiMock.getLargeLosses).toHaveBeenCalledWith(bindIds.quote, { quote: true });
    expect(apiMock.getRiskProfile).toHaveBeenCalled();
    expect(container).toBeTruthy();
  });
});
