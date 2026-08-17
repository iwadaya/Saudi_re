// Status→tone mapping for the Claims/Finance badges. These drive the only
// colour signal an underwriter gets when scanning the register, so the maps
// are asserted rather than eyeballed — in particular that CLOSED means
// "settled" (success) for a claim but merely "inactive" (neutral) for a
// finance ledger entry.
import { describe, it, expect } from 'vitest';
import { render, screen } from '@testing-library/react';
import { ApprovalBadge, ClaimStatusBadge, FinanceStatusBadge, KpiCard } from './ledger.jsx';

const toneOf = (el) => {
  const m = el.className.match(/ui-badge--(\w+)/);
  return m ? m[1] : 'neutral';
};

describe('ClaimStatusBadge', () => {
  it.each([
    ['OPEN', 'info'],
    ['REOPENED', 'warn'],
    ['CLOSED', 'success'],
    ['DECLINED', 'danger'],
  ])('maps %s to the %s tone', (status, tone) => {
    render(<ClaimStatusBadge status={status} />);
    expect(toneOf(screen.getByText(status))).toBe(tone);
  });

  it('falls back to info for an unknown status rather than rendering blank', () => {
    render(<ClaimStatusBadge status="SOMETHING_NEW" />);
    expect(toneOf(screen.getByText('SOMETHING NEW'))).toBe('info');
  });
});

describe('ApprovalBadge', () => {
  it.each([
    ['DRAFT', 'neutral'],
    ['WAITING_APPROVAL', 'warn'],
    ['REJECTED', 'danger'],
    ['FINALISED', 'success'],
  ])('maps %s to the %s tone', (status, tone) => {
    render(<ApprovalBadge status={status} />);
    expect(toneOf(screen.getByText(status.replace('_', ' ')))).toBe(tone);
  });

  it('treats a missing approval status as DRAFT', () => {
    render(<ApprovalBadge status={undefined} />);
    expect(screen.getByText('DRAFT')).toBeInTheDocument();
  });
});

describe('FinanceStatusBadge', () => {
  it.each([
    ['PENDING_SETUP', 'warn'],
    ['ACTIVE', 'success'],
    ['SUSPENDED', 'danger'],
  ])('maps %s to the %s tone', (status, tone) => {
    render(<FinanceStatusBadge status={status} />);
    expect(toneOf(screen.getByText(status.replace('_', ' ')))).toBe(tone);
  });

  it('renders a closed ledger entry as neutral, not as a claim-style success', () => {
    render(<FinanceStatusBadge status="CLOSED" />);
    expect(toneOf(screen.getByText('CLOSED'))).toBe('neutral');
  });
});

describe('KpiCard', () => {
  it('renders label, value and caption', () => {
    render(<KpiCard label="Total Claims" value={42} sub="12 open" />);
    expect(screen.getByText('Total Claims')).toBeInTheDocument();
    expect(screen.getByText('42')).toBeInTheDocument();
    expect(screen.getByText('12 open')).toBeInTheDocument();
  });

  it('tints the value only when a tone is given', () => {
    const { rerender } = render(<KpiCard label="Rejected" value={3} />);
    expect(screen.getByText('3').className).toBe('cf-kpi__value');
    rerender(<KpiCard label="Rejected" value={3} tone="danger" />);
    expect(screen.getByText('3').className).toContain('cf-kpi__value--danger');
  });
});
