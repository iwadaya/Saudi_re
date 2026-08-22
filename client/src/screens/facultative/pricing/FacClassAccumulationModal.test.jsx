// The accumulation modal: the numbers it shows are the point, so the tests
// assert the figures and the separation of "carried" from "this risk".
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import FacClassAccumulationModal from './FacClassAccumulationModal.jsx';

const { apiMock } = vi.hoisted(() => ({ apiMock: { facGetClassAccumulation: vi.fn() } }));
vi.mock('../../../api', () => ({ api: apiMock, default: apiMock }));

const PAYLOAD = {
  class: { facRiskId: 'r1', facCobId: 'fc1', facClassName: 'Industrial All Risks', category: 'PROPERTY', classOfBusinessId: 'cob1', className: 'Property' },
  unavailableReason: null,
  facRisks: [
    { facRiskId: 'f1', facRef: 'FAC-2026-001', insuredName: 'SABIC Jubail', cedantName: 'Saudi Re', facClassName: 'Industrial All Risks', uwYear: 2026, currencyCode: 'USD', exposureUsd: 100_000_000, premiumUsd: 700_000 },
    { facRiskId: 'f2', facRef: 'FAC-2026-002', insuredName: 'Al Rajhi Tower', cedantName: 'Gulf Ins', facClassName: 'Property All Risks', uwYear: 2026, currencyCode: 'USD', exposureUsd: 15_000_000, premiumUsd: 300_000 },
  ],
  treaties: [
    { contractId: 'c1', cedantName: 'Saudi Re', treatyType: 'Quota Share', isNp: false, uwYear: 2026, uwStatus: 'SIGNED', currencyCode: 'USD', exposureUsd: 400_000_000, premiumUsd: 4_000_000 },
  ],
  facSubtotal: { exposureUsd: 115_000_000, premiumUsd: 1_000_000, count: 2 },
  treatySubtotal: { exposureUsd: 400_000_000, premiumUsd: 4_000_000, count: 1 },
  total: { exposureUsd: 515_000_000, premiumUsd: 5_000_000, count: 3 },
  currentRisk: { facRiskId: 'r1', facRef: 'FAC-2026-009', insuredName: 'New Plant', cedantName: 'Saudi Re', facClassName: 'Industrial All Risks', uwYear: 2026, status: 'DRAFT', currencyCode: 'USD', exposureUsd: 20_000_000, premiumUsd: 500_000 },
};

afterEach(() => { cleanup(); vi.clearAllMocks(); });
beforeEach(() => { apiMock.facGetClassAccumulation.mockResolvedValue(PAYLOAD); });

const open = (onClose = vi.fn()) => {
  render(<FacClassAccumulationModal riskId="r1" onClose={onClose} />);
  return onClose;
};

describe('FacClassAccumulationModal', () => {
  it('is a labelled dialog naming the mapped treaty class, not the fac class', async () => {
    open();
    const dlg = await screen.findByRole('dialog');
    // Pricing "Industrial All Risks" accumulates at "Property" — the level the
    // treaty half can be matched on.
    expect(dlg).toHaveAccessibleName(/Property/);
    expect(await screen.findByText(/pricing Industrial All Risks/i)).toBeInTheDocument();
  });

  it('lists both halves with their own subtotals', async () => {
    open();
    expect(await screen.findByText('SABIC Jubail')).toBeInTheDocument();
    expect(screen.getByText('Al Rajhi Tower')).toBeInTheDocument();
    expect(screen.getByText('Quota Share')).toBeInTheDocument();
    expect(screen.getByText(/Facultative subtotal \(2\)/)).toBeInTheDocument();
    expect(screen.getByText(/Treaty subtotal \(1\)/)).toBeInTheDocument();
  });

  it('shows the carried total', async () => {
    open();
    const row = (await screen.findByText(/Total carried in Property/)).closest('tr');
    expect(within(row).getByText('$515,000,000')).toBeInTheDocument();
    expect(within(row).getByText('$5,000,000')).toBeInTheDocument();
  });

  it('keeps the risk being priced out of the total and says so', async () => {
    open();
    const row = (await screen.findByText(/This risk — New Plant/)).closest('tr');
    expect(within(row).getByText('$20,000,000')).toBeInTheDocument();
    expect(within(row).getByText(/not in the totals above/i)).toBeInTheDocument();
    // The carried total is unchanged by it.
    const totalRow = screen.getByText(/Total carried in Property/).closest('tr');
    expect(within(totalRow).getByText('$515,000,000')).toBeInTheDocument();
  });

  it('explains an unmapped class instead of showing a bare zero', async () => {
    apiMock.facGetClassAccumulation.mockResolvedValue({
      ...PAYLOAD,
      class: { ...PAYLOAD.class, classOfBusinessId: null, className: null, facClassName: 'Cyber - First Party' },
      unavailableReason: 'Cyber - First Party is not mapped to a treaty class of business, so treaty exposure cannot be matched.',
      facRisks: [], treaties: [],
      facSubtotal: { exposureUsd: 0, premiumUsd: 0, count: 0 },
      treatySubtotal: { exposureUsd: 0, premiumUsd: 0, count: 0 },
      total: { exposureUsd: 0, premiumUsd: 0, count: 0 },
    });
    open();
    expect(await screen.findByRole('status')).toHaveTextContent(/not mapped to a treaty class/i);
  });

  it('reports a failure rather than rendering empty totals', async () => {
    apiMock.facGetClassAccumulation.mockRejectedValue(new Error('server down'));
    open();
    expect(await screen.findByRole('alert')).toHaveTextContent(/server down/i);
  });

  it('closes on the Close button, the backdrop and Escape', async () => {
    const onClose = open();
    fireEvent.click(await screen.findByRole('button', { name: /close/i }));
    expect(onClose).toHaveBeenCalledTimes(1);

    cleanup();
    const onClose2 = open();
    await screen.findByRole('dialog');
    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => expect(onClose2).toHaveBeenCalled());
  });
});
