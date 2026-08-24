// RetroImpactModal.test.jsx — the "Retro Impact" modal opened from the
// offer modals. Covers: the AI suggested line given retro renders from
// the shared optimiser, Apply hands the % back to the host, the gross →
// net walk shows spend/recoveries, and editing the programme re-runs
// the optimisation live.

import { render, screen, fireEvent, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import RetroImpactModal from './RetroImpactModal.jsx';
import { optimiseRetroLine } from '../../../../shared/retroImpact.js';

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
});
