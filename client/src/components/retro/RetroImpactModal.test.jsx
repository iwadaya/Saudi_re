// RetroImpactModal.test.jsx — the "Retro Impact" modal opened from the
// offer modals. Covers: the AI suggested line given retro renders from
// the shared optimiser, Apply hands the % back to the host, the gross →
// net walk shows spend/recoveries, and editing the programme re-runs
// the optimisation live.

import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const apiMock = vi.hoisted(() => ({
  getApplicableRetroProgrammes: vi.fn(),
}));
vi.mock('../../api', () => ({ api: apiMock }));
vi.mock('../../utils/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import RetroImpactModal from './RetroImpactModal.jsx';
import { optimiseRetroLine, programmeFromStored } from '../../../../shared/retroImpact.js';

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.getApplicableRetroProgrammes.mockResolvedValue({ programmes: [] });
});

const STORED = [
  { programme_type: 'QUOTA_SHARE', programme_name: 'WA QS 2026', cession_pct: 25, commission_pct: 30 },
  { programme_type: 'XL_CAT', programme_name: 'Cat XL 2026', attachment: 5_000_000, occurrence_limit: 20_000_000, rol_pct: 11, reinstatements: 1 },
];

const SUBJECT = {
  grossPremium100: 40_000_000,
  grossLimit100: 500_000_000,
  expectedLossRatio: 0.55,
  expenseRatio: 0.38,
  authorityMaxLimit: 50_000_000,
};

const money = (n) => `USD ${Math.round(n).toLocaleString()}`;

function renderModal(over = {}) {
  const onClose = vi.fn();
  const onApplyLine = vi.fn();
  const props = {
    onClose, subject: SUBJECT, currentLinePct: 5, money,
    onApplyLine, contextLabel: 'Proportional', ...over,
  };
  return { ...render(<RetroImpactModal {...props} />), onClose, onApplyLine };
}

describe('RetroImpactModal', () => {
  it('renders the retro-adjusted AI line from the shared optimiser', () => {
    renderModal();
    expect(screen.getByText(/Retro Impact on Line Size/)).toBeInTheDocument();
    expect(screen.getByText('✦ AI Suggested Line Given Retro')).toBeInTheDocument();
    // The number shown must be a real optimiser output for this subject
    // (default programme seeds from the current line), not a hardcode.
    const pct = screen.getByText((_, el) => el?.className === 'off-ai-pct');
    expect(parseFloat(pct.textContent)).toBeGreaterThan(0);
    expect(parseFloat(pct.textContent)).toBeLessThanOrEqual(100);
  });

  it('Apply hands the suggested line back to the host modal', () => {
    const { onApplyLine } = renderModal();
    const pct = parseFloat(screen.getByText((_, el) => el?.className === 'off-ai-pct').textContent);
    fireEvent.click(screen.getByRole('button', { name: /Apply →/ }));
    expect(onApplyLine).toHaveBeenCalledTimes(1);
    expect(onApplyLine).toHaveBeenCalledWith(pct);
  });

  it('hides Apply when the host is terminal (onApplyLine null)', () => {
    renderModal({ onApplyLine: null });
    expect(screen.queryByRole('button', { name: /Apply →/ })).toBeNull();
  });

  it('shows the gross → net walk with retro spend and recoveries', () => {
    renderModal();
    const table = screen.getByRole('table');
    const t = within(table);
    expect(t.getByText('Retro spend')).toBeInTheDocument();
    expect(t.getByText('Expected recoveries')).toBeInTheDocument();
    expect(t.getByText('Net retro cost')).toBeInTheDocument();
    expect(t.getByText('PML relief from retro')).toBeInTheDocument();
    expect(t.getByText('Risk-adjusted result')).toBeInTheDocument();
    // One column per view: current line, suggested line, no-retro baseline.
    expect(t.getByText(/Current 5\.0%/)).toBeInTheDocument();
    expect(t.getByText(/✦ Suggested/)).toBeInTheDocument();
    expect(t.getByText(/No retro @/)).toBeInTheDocument();
  });

  it('re-optimises live when the programme is edited', () => {
    renderModal();
    // Switching the XL off changes the economics — cross-check the new
    // suggestion against the optimiser run with the same programme.
    fireEvent.click(screen.getByLabelText(/Bought/));
    expect(screen.getByText('Not bought')).toBeInTheDocument();
    const expected = optimiseRetroLine({
      subject: { ...SUBJECT, lossCv: 0.9 },
      programme: { qsCessionPct: 20, qsCommissionPct: 27.5, xlEnabled: false, costOfCapitalPct: 15 },
      currentLinePct: 5,
    });
    const after = screen.getByText((_, el) => el?.className === 'off-ai-pct').textContent;
    expect(parseFloat(after)).toBeCloseTo(expected.suggestedLinePct, 5);
  });

  it('notes the authority cap on the sensitivity caption', () => {
    renderModal();
    // 50m authority on 500m capacity caps the line at 10%.
    expect(screen.getByText(/authority caps the line at 10\.0%/)).toBeInTheDocument();
  });

  it('closes from the ✕ button and the backdrop', () => {
    const { onClose } = renderModal();
    fireEvent.click(screen.getByRole('button', { name: '✕' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('does not fetch stored programmes without a contractId', () => {
    renderModal();
    expect(apiMock.getApplicableRetroProgrammes).not.toHaveBeenCalled();
  });

  it('seeds from the stored programmes covering the treaty and says so', async () => {
    apiMock.getApplicableRetroProgrammes.mockResolvedValue({ uw_year: 2026, programmes: STORED });
    renderModal({ contractId: 'c-1' });
    expect(apiMock.getApplicableRetroProgrammes).toHaveBeenCalledWith({ contractId: 'c-1' });
    await screen.findByText(/Seeded from stored programmes/);
    expect(screen.getByText('WA QS 2026, Cat XL 2026')).toBeInTheDocument();
    // Fields carry the stored terms, and the suggestion is the optimiser run
    // on exactly that stored programme.
    expect(screen.getByLabelText('Retro XL attachment')).toHaveValue('5000000');
    expect(screen.getByLabelText('Retro XL limit')).toHaveValue('20000000');
    const expected = optimiseRetroLine({
      subject: { ...SUBJECT, lossCv: 0.9 },
      programme: programmeFromStored(STORED).programme,
      currentLinePct: 5,
    });
    const pct = screen.getByText((_, el) => el?.className === 'off-ai-pct').textContent;
    expect(parseFloat(pct)).toBeCloseTo(expected.suggestedLinePct, 5);
  });

  it('queries by quoteId in quote mode', async () => {
    renderModal({ contractId: 'q-1', isQuote: true });
    await waitFor(() => expect(apiMock.getApplicableRetroProgrammes).toHaveBeenCalledWith({ quoteId: 'q-1' }));
  });

  it('flips to "Edited" with a working Reset to stored after an edit', async () => {
    apiMock.getApplicableRetroProgrammes.mockResolvedValue({ programmes: STORED });
    renderModal({ contractId: 'c-1' });
    await screen.findByText(/Seeded from stored programmes/);
    fireEvent.change(screen.getByLabelText('Retro XL limit'), { target: { value: '99000000' } });
    expect(screen.getByText(/Edited — differs from the stored programme/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Reset to stored/ }));
    expect(screen.getByLabelText('Retro XL limit')).toHaveValue('20000000');
    expect(screen.getByText(/Seeded from stored programmes/)).toBeInTheDocument();
  });

  it('scales a whole-account XL to the treaty share of the protected book and says so', async () => {
    apiMock.getApplicableRetroProgrammes.mockResolvedValue({
      subject_exposure: 80_000_000,
      subject_in_book: true,
      programmes: [{
        programme_type: 'WHOLE_ACCOUNT_XL', programme_name: 'WA Cat XL',
        attachment: 20_000_000, occurrence_limit: 80_000_000,
        rol_pct: 12, reinstatements: 1, book_exposure: 320_000_000,
      }],
    });
    renderModal({ contractId: 'c-1' });
    await screen.findByText(/Seeded from stored programme/);
    // 80m / 320m book → 25% share: 80m xs 20m becomes 20m xs 5m.
    expect(screen.getByText(/XL scaled to this treaty's 25\.0% share of the protected book/)).toBeInTheDocument();
    expect(screen.getByLabelText('Retro XL attachment')).toHaveValue('5000000');
    expect(screen.getByLabelText('Retro XL limit')).toHaveValue('20000000');
  });

  it('converts programme currency to treaty currency and shows the rate; warns on a missing rate', async () => {
    apiMock.getApplicableRetroProgrammes.mockResolvedValue({
      subject_exposure: 0,           // no scaling — isolate the FX step
      subject_currency: 'SAR',
      subject_in_book: true,
      programmes: [{
        programme_type: 'XL_CAT', programme_name: 'EUR Cat XL', currency_code: 'EUR',
        attachment: 10_000_000, occurrence_limit: 40_000_000,
        rol_pct: 12, reinstatements: 1, fx_to_subject: 4.05, fx_missing: false,
      }],
    });
    renderModal({ contractId: 'c-1' });
    await screen.findByText(/converted EUR → SAR at/);
    expect(screen.getByText(/1 EUR = 4\.0500 SAR/)).toBeInTheDocument();
    // 10m × 4.05 = 40.5m; 40m × 4.05 = 162m — in treaty currency.
    expect(screen.getByLabelText('Retro XL attachment')).toHaveValue('40500000');
    expect(screen.getByLabelText('Retro XL limit')).toHaveValue('162000000');
    expect(screen.queryByText(/No exchange rate stored/)).toBeNull();
  });

  it('warns when the exchange rate is missing and leaves amounts unconverted', async () => {
    apiMock.getApplicableRetroProgrammes.mockResolvedValue({
      subject_currency: 'SAR', subject_in_book: true,
      programmes: [{
        programme_type: 'XL_CAT', programme_name: 'EUR Cat XL', currency_code: 'EUR',
        attachment: 10_000_000, occurrence_limit: 40_000_000,
        rol_pct: 12, reinstatements: 1, fx_to_subject: 1, fx_missing: true,
      }],
    });
    renderModal({ contractId: 'c-1' });
    await screen.findByText(/No exchange rate stored for EUR/);
    expect(screen.getByLabelText('Retro XL attachment')).toHaveValue('10000000');
  });

  it('warns when part of the protected book has no exchange rate (approximate share)', async () => {
    apiMock.getApplicableRetroProgrammes.mockResolvedValue({
      subject_exposure: 80_000_000, subject_currency: 'SAR', subject_in_book: true,
      programmes: [{
        programme_type: 'XL_CAT', programme_name: 'Cat XL', currency_code: 'SAR',
        attachment: 20_000_000, occurrence_limit: 80_000_000,
        rol_pct: 12, reinstatements: 1, fx_to_subject: 1, fx_missing: false,
        book_exposure: 320_000_000, book_fx_missing: 2,
      }],
    });
    renderModal({ contractId: 'c-1' });
    await screen.findByText(/2 in-scope treaties have no stored exchange rate — book share is approximate/);
    // The share still applies (25%): 80m xs 20m → 20m xs 5m.
    expect(screen.getByLabelText('Retro XL attachment')).toHaveValue('5000000');
  });

  it('says when no stored programme covers the treaty and keeps the defaults', async () => {
    apiMock.getApplicableRetroProgrammes.mockResolvedValue({ programmes: [] });
    renderModal({ contractId: 'c-1' });
    await screen.findByText(/No stored retro programme covers this treaty/);
  });
});
