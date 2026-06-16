import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import FQFinalPriceModal from './FQFinalPriceModal.jsx';

// Structure 1: one ACTIVE risk layer (limit 1M, deductible 500k, EGNPI 50M,
// 1 reinstatement @ 100%, ROL/uwPrice 10% → premium 100k, rate 0.2%) plus a
// cat-only layer that must NOT appear in the Risk Final Price.
const structure = {
  id: 'str-0',
  layers: [
    { id: 0, risk: true, cat: false, limit: '1000000', attachment: '500000', egnpi: '50000000', riskUwPrice: '10', reinstatements: '1', pctReinst: '100', riskMdpPct: '' },
    { id: 1, risk: false, cat: true, limit: '2000000', attachment: '1500000', egnpi: '50000000', catUwPrice: '5' },
  ],
};

function renderModal(over = {}) {
  const props = {
    open: true,
    scopeKey: 'risk',
    structure,
    sIdx: 0,
    updateClientStructureLayer: vi.fn(),
    save: vi.fn(async () => true),
    doSubmitForApproval: vi.fn(async () => {}),
    onClose: vi.fn(),
    ...over,
  };
  return { props, ...render(<FQFinalPriceModal {...props} />) };
}

describe('FQFinalPriceModal', () => {
  it('renders nothing when closed', () => {
    const { container } = renderModal({ open: false });
    expect(container.firstChild).toBeNull();
  });

  it('titles by structure + scope and lists only the scope\'s active layers', () => {
    renderModal();
    expect(screen.getByTestId('fq-final-price-title').textContent).toBe('Final Price · Structure 1 · Risk');
    expect(document.querySelectorAll('tbody tr')).toHaveLength(1); // only the active risk layer
  });

  it('shows Limit/Deductible/EGNPI (no currency), Reinstatements, computed Rate/Premium, ROL=uw price', () => {
    renderModal();
    const cells = document.querySelector('tbody tr').querySelectorAll('td');
    expect(cells[1].textContent).toBe('1,000,000');  // Limit (no currency code)
    expect(cells[2].textContent).toBe('500,000');    // Deductible
    expect(cells[3].textContent).toBe('50,000,000'); // EGNPI
    expect(cells[4].textContent).toBe('1@100%');     // Reinstatements
    expect(cells[5].textContent).toBe('0.2000%');    // Rate = Premium/EGNPI, 4 dp
    expect(cells[6].textContent).toBe('100,000');    // Premium = ROL·Limit = 10%·1,000,000
    expect(cells[9].textContent).toBe('10.00%');     // ROL = uw price
  });

  it('edits MDP% (riskMdpPct) and recomputes MDP Amount live', () => {
    const updateClientStructureLayer = vi.fn();
    const { props, rerender } = renderModal({ updateClientStructureLayer });
    const mdpInput = screen.getByTestId('fq-final-price-mdp-0').querySelector('input');
    fireEvent.change(mdpInput, { target: { value: '25' } });
    expect(updateClientStructureLayer).toHaveBeenCalledWith(0, 0, 'riskMdpPct', '25');
    // Parent applies the edit → MDP Amount = 25% · 100,000 = 25,000.
    const updated = { ...structure, layers: [{ ...structure.layers[0], riskMdpPct: '25' }, structure.layers[1]] };
    rerender(<FQFinalPriceModal {...props} structure={updated} />);
    expect(document.querySelector('tbody tr').querySelectorAll('td')[8].textContent).toBe('25,000');
  });

  it('summary footer totals premium / MDP amount / limit-weighted ROL', () => {
    const withMdp = { ...structure, layers: [{ ...structure.layers[0], riskMdpPct: '25' }, structure.layers[1]] };
    renderModal({ structure: withMdp });
    const foot = screen.getByTestId('fq-final-price-total').querySelectorAll('td');
    expect(foot[0].textContent).toBe('TOTAL');
    expect(foot[6].textContent).toBe('100,000');  // total premium
    expect(foot[8].textContent).toBe('25,000');   // total MDP amount
    expect(foot[9].textContent).toBe('10.00%');   // limit-weighted ROL
  });

  it('Save calls save() and confirms "Saved" (does not auto-submit)', async () => {
    const save = vi.fn(async () => true);
    const doSubmitForApproval = vi.fn(async () => {});
    renderModal({ save, doSubmitForApproval });
    fireEvent.click(screen.getByTestId('fq-final-price-save'));
    await waitFor(() => expect(screen.getByTestId('fq-final-price-saved')).toBeInTheDocument());
    expect(save).toHaveBeenCalledTimes(1);
    expect(doSubmitForApproval).not.toHaveBeenCalled(); // plain Save never submits
  });
});
