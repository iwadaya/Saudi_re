// The capacity panel: three states, and the one that matters most is the
// middle one — "no budget set" must not look like a pass.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({ facGetAccumulation: vi.fn() }));
vi.mock('../../../api', () => ({ __esModule: true, default: apiMock, api: apiMock }));

const { default: FacCapacityPanel } = await import('./FacCapacityPanel');

beforeEach(() => { apiMock.facGetAccumulation.mockReset(); });

describe('FacCapacityPanel', () => {
  it('shows a pass with the zone figures behind it', async () => {
    apiMock.facGetAccumulation.mockResolvedValue({
      status: 'PASS', referral: false, line_size: 120_000_000, line_basis: 'TOP_LOCATION_SI',
      zones: ['KSA-01'],
      checks: [
        {
          level: 'PER_RISK_LINE', status: 'PASS', lineSize: 120_000_000,
          maxCapacityPct: 0.75, maxLine: 90_000_000, written: 60_000_000,
          headroom: 30_000_000, message: 'Up to 75.0% of the line is available on this grade.',
        },
        {
          level: 'ZONE_ACCUMULATION', status: 'PASS', zone: 'KSA-01',
          committed: 180_000_000, adding: 40_000_000, wouldBe: 220_000_000,
          budget: 300_000_000, utilisation: 0.733,
          message: 'KSA-01 would be at 73.3% of budget after this risk.',
        },
      ],
      reasons: [], unmeasured: [],
    });

    render(<FacCapacityPanel riskId="R-1" />);

    await waitFor(() => expect(screen.getByText('Within capacity')).toBeInTheDocument());
    expect(screen.getByText(/73.3% of budget/)).toBeInTheDocument();
    expect(screen.getByText('180,000,000')).toBeInTheDocument();
    expect(screen.getByText('73.3%')).toBeInTheDocument();
  });

  it('shows a breach as a referral, not a refusal', async () => {
    apiMock.facGetAccumulation.mockResolvedValue({
      status: 'BREACH', referral: true, line_size: 120_000_000, line_basis: 'TOP_LOCATION_SI',
      zones: ['KSA-01'],
      checks: [{
        level: 'ZONE_ACCUMULATION', status: 'BREACH', zone: 'KSA-01',
        committed: 280_000_000, adding: 40_000_000, wouldBe: 320_000_000,
        budget: 300_000_000, message: 'Binding this would take KSA-01 to 320,000,000 against '
          + 'a budget of 300,000,000 — over by 20,000,000.',
      }],
      reasons: ['over budget'], unmeasured: [],
    });

    render(<FacCapacityPanel riskId="R-1" />);

    await waitFor(() => expect(screen.getByText('Referral — capacity breach')).toBeInTheDocument());
    expect(screen.getByText(/a referral, not a refusal/i)).toBeInTheDocument();
    expect(screen.getByText(/over by 20,000,000/)).toBeInTheDocument();
  });

  it('does not dress an unset budget up as a pass', async () => {
    // fac_zone_budget ships empty. Showing a green tick against a budget
    // nobody set would be finding F14 again in a nicer colour.
    apiMock.facGetAccumulation.mockResolvedValue({
      status: 'NO_BUDGET', referral: false, line_size: null, line_basis: 'TOTAL_SI',
      zones: ['KSA-01'],
      checks: [{
        level: 'ZONE_ACCUMULATION', status: 'NO_BUDGET', zone: 'KSA-01',
        committed: 180_000_000, adding: 40_000_000, wouldBe: 220_000_000,
        message: 'No budget is set for the zone — load one in fac_zone_budget.',
      }],
      reasons: [], unmeasured: ['no budget'],
    });

    render(<FacCapacityPanel riskId="R-1" />);

    await waitFor(() => {
      expect(screen.getByText('Committed exposure shown, no budget set')).toBeInTheDocument();
    });
    expect(screen.queryByText('Within capacity')).toBeNull();
    expect(screen.getByText(/load one in fac_zone_budget/i)).toBeInTheDocument();
  });

  it('reports the cyber vendor concentration the book already carries', async () => {
    apiMock.facGetAccumulation.mockResolvedValue({
      status: 'PASS', referral: false, line_size: 10_000_000, line_basis: 'LIMIT', zones: [],
      checks: [{
        level: 'SYSTEMIC_VENDOR', status: 'PASS', vendor: 'AWS',
        committedLimit: 240_000_000, riskCount: 12,
        message: '12 bound risk(s) already depend on AWS, carrying 240,000,000 of limit. '
          + 'One outage is one loss across all of them.',
      }],
      reasons: [], unmeasured: [],
    });

    render(<FacCapacityPanel riskId="R-1" />);

    await waitFor(() => expect(screen.getByText(/Common vendor · AWS/)).toBeInTheDocument());
    expect(screen.getByText(/One outage is one loss across all of them/)).toBeInTheDocument();
    expect(screen.getByText('12')).toBeInTheDocument();
  });

  it('says it could not check rather than falling silent', async () => {
    apiMock.facGetAccumulation.mockRejectedValue(new Error('network down'));

    render(<FacCapacityPanel riskId="R-1" />);

    await waitFor(() => {
      expect(screen.getByText(/has not been checked against the committed book/i))
        .toBeInTheDocument();
    });
  });
});
