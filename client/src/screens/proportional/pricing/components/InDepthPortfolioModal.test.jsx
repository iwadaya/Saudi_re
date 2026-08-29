// InDepthPortfolioModal.test.jsx — toDisplay must treat '%'-suffixed grid
// values as already-percent (a 1% Taxes row previously rendered '100.00%'
// and corrupted the gap analysis / adequacy scores); the >1.5 magnitude
// heuristic applies only to bare numbers.

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import InDepthPortfolioModal from './InDepthPortfolioModal.jsx';

// Grid shaped like PropPricing's components state: percent strings from the
// engine/hydration, plus one bare-number UW override ('35' means 35%).
const GRID = {
  Taxes: { actuarial: '1.00%', actual: '1.00%', market: '2.50%', uw: '', exposure: '' },
  'Attritional Loss Ratio': { actuarial: '63.40%', actual: '33.33%', market: '41.00%', uw: '35', exposure: '' },
};
const getC = (name, col) => GRID[name]?.[col] ?? '';

describe('InDepthPortfolioModal — percent normalization', () => {
  it('renders a 1% component as 1.00%, not 100.00%', () => {
    render(<InDepthPortfolioModal getC={getC} snapshots={[]} onClose={vi.fn()} />);
    // Taxes actuarial + actual cells (compare tab is the default).
    expect(screen.getAllByText('1.00%').length).toBeGreaterThanOrEqual(2);
    expect(screen.queryByText('100.00%')).not.toBeInTheDocument();
  });

  it('keeps the magnitude heuristic for bare numbers', () => {
    render(<InDepthPortfolioModal getC={getC} snapshots={[]} onClose={vi.fn()} />);
    // '63.40%' stays 63.40%; bare '35' (UW override) means 35%.
    expect(screen.getAllByText('63.40%').length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText('35.00%').length).toBeGreaterThanOrEqual(1);
  });
});
