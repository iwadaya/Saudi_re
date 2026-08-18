// Layer tower: the derived columns are the point.
//
// ROL and payback are what an excess underwriter reads first, and they are
// derived here rather than typed so they cannot disagree with the premium
// sitting next to them.

import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent, within } from '@testing-library/react';
import FacLayerTower from './FacLayerTower';

const LAYERS = [
  { layer_no: 1, attachment: 0, limit_amount: 5_000_000, our_share_pct: 25, reinstatements: 2, premium: 400_000 },
  { layer_no: 2, attachment: 5_000_000, limit_amount: 10_000_000, our_share_pct: 10, reinstatements: 1, premium: 250_000 },
];

describe('FacLayerTower', () => {
  it('says a single-band placement needs no tower rather than showing an empty grid', () => {
    render(<FacLayerTower layers={[]} onChange={() => {}} />);
    expect(screen.getByText(/No layers recorded/i)).toBeInTheDocument();
  });

  it('derives rate on line from the premium and the limit', () => {
    render(<FacLayerTower layers={LAYERS} onChange={() => {}} />);
    // 400,000 ÷ 5,000,000 = 8.00%; 250,000 ÷ 10,000,000 = 2.50%.
    expect(screen.getByText('8.00%')).toBeInTheDocument();
    expect(screen.getByText('2.50%')).toBeInTheDocument();
  });

  it('derives payback as the clean years that repay one total loss', () => {
    render(<FacLayerTower layers={LAYERS} onChange={() => {}} />);
    expect(screen.getByText('12.5 yrs')).toBeInTheDocument();
    expect(screen.getByText('40.0 yrs')).toBeInTheDocument();
  });

  it('shows total cover as the limit times the reinstatements plus the original', () => {
    render(<FacLayerTower layers={LAYERS} onChange={() => {}} />);
    // Layer 1: 5m × (1 + 2) = 15m. Layer 2: 10m × (1 + 1) = 20m.
    expect(screen.getByText('15,000,000')).toBeInTheDocument();
    expect(screen.getByText('20,000,000')).toBeInTheDocument();
  });

  it('reads a blank limit as unlimited, not as zero', () => {
    render(<FacLayerTower
      layers={[{ layer_no: 1, attachment: 15_000_000, limit_amount: null, premium: 90_000 }]}
      onChange={() => {}}
    />);
    expect(screen.getByText('Unlimited')).toBeInTheDocument();
    // No limit means no rate on line — a percentage of infinity is not a number.
    const row = screen.getAllByRole('row')[1];
    expect(within(row).getAllByText('—').length).toBeGreaterThan(0);
  });

  it('totals the premium and our share of it', () => {
    render(<FacLayerTower layers={LAYERS} onChange={() => {}} />);
    expect(screen.getByText('650,000')).toBeInTheDocument();
    // 25% of 400k + 10% of 250k = 125,000.
    expect(screen.getByText('125,000')).toBeInTheDocument();
  });

  it('attaches a new layer where the one below it tops out', () => {
    const onChange = vi.fn();
    render(<FacLayerTower layers={LAYERS} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Add layer' }));
    const next = onChange.mock.calls[0][0];
    expect(next).toHaveLength(3);
    expect(next[2].layer_no).toBe(3);
    expect(next[2].attachment).toBe('15000000');
  });

  it('renumbers the tower when a layer is removed', () => {
    const onChange = vi.fn();
    render(<FacLayerTower layers={LAYERS} onChange={onChange} />);
    fireEvent.click(screen.getByRole('button', { name: 'Remove layer 1' }));
    const next = onChange.mock.calls[0][0];
    expect(next).toHaveLength(1);
    expect(next[0].layer_no).toBe(1);
    expect(Number(next[0].attachment)).toBe(5_000_000);
  });

  it('edits a cell through onChange rather than holding its own copy', () => {
    const onChange = vi.fn();
    render(<FacLayerTower layers={LAYERS} onChange={onChange} />);
    fireEvent.change(screen.getByLabelText('Layer 1 premium'), { target: { value: '500,000' } });
    expect(onChange.mock.calls[0][0][0].premium).toBe('500000');
  });

  it('offers no editing controls when read-only', () => {
    render(<FacLayerTower layers={LAYERS} onChange={() => {}} readOnly />);
    expect(screen.queryByRole('button', { name: 'Add layer' })).not.toBeInTheDocument();
    expect(screen.getByLabelText('Layer 1 premium')).toHaveAttribute('readonly');
  });
});
