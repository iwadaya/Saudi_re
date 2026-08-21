// RetroProgrammeScreen.test.jsx
//
// Admin capture of the outward retro contract — the record the offer modal's
// retro cover analysis reads. Covers the level-2 gate, the captured list, the
// save (numbers parsed out of the formatted inputs), edit-by-year and delete.

import { render, screen, within, fireEvent, waitFor } from '@testing-library/react';
import { describe, expect, it, vi, beforeEach } from 'vitest';

const api = {
  getRetroProgrammes: vi.fn(),
  saveRetroProgramme: vi.fn(),
  deleteRetroProgramme: vi.fn(),
};
let level = 2;

vi.mock('../../api', () => ({ api }));
vi.mock('../../utils/auth', () => ({ isAtLeast: (n) => level <= n, ROLE_LABELS: {} }));
vi.mock('../../components/Topbar', () => ({ default: ({ title }) => <div>{title}</div> }));

const { default: RetroProgrammeScreen } = await import('./RetroProgrammeScreen.jsx');

const P2026 = {
  retro_programme_id: 'r1', uw_year: 2026, currency: 'SAR', label: '2026 Cat XL Retro',
  reinsurer: 'Retro Re', retention_amt: 25000000, limit_amt: 180000000, rol_pct: 8,
  used_limit_amt: 40000000, cession_pct: 10, commission_pct: 25, max_line_pct: 25,
  inception_date: '2026-01-01', expiry_date: '2026-12-31', notes: null, is_active: true,
};

beforeEach(() => {
  level = 2;
  api.getRetroProgrammes.mockReset().mockResolvedValue({ programmes: [P2026] });
  api.saveRetroProgramme.mockReset().mockResolvedValue({ programme: { ...P2026, retro_programme_id: 'r2', uw_year: 2027 } });
  api.deleteRetroProgramme.mockReset().mockResolvedValue({ ok: true });
});

describe('RetroProgrammeScreen', () => {
  it('lists the retro contracts captured so far', async () => {
    render(<RetroProgrammeScreen />);
    const row = within(await screen.findByTestId('rp-row-2026-SAR'));
    expect(row.getByText('2026')).toBeInTheDocument();
    expect(row.getByText('SAR')).toBeInTheDocument();
    expect(row.getByText('2026 Cat XL Retro')).toBeInTheDocument();
    expect(row.getByText('SAR 25,000,000')).toBeInTheDocument();   // retention
    expect(row.getByText('SAR 180,000,000')).toBeInTheDocument();  // limit
    expect(row.getByText('8%')).toBeInTheDocument();               // rate on line
    expect(row.getByText('SAR 40,000,000')).toBeInTheDocument();   // limit used
    expect(row.getByText('10%')).toBeInTheDocument();              // retro QS
  });

  it('saves a new year, parsing the numbers out of the typed values', async () => {
    render(<RetroProgrammeScreen />);
    await screen.findByTestId('rp-row-2026-SAR');

    fireEvent.change(screen.getByLabelText(/Underwriting Year/i), { target: { value: '2027' } });
    fireEvent.change(screen.getByLabelText(/^Currency/i), { target: { value: 'usd' } });
    fireEvent.change(screen.getByLabelText(/Contract Name/i), { target: { value: '2027 Cat XL Retro' } });
    fireEvent.change(screen.getByLabelText(/Retention/i), { target: { value: '5,000,000' } });
    fireEvent.change(screen.getByLabelText(/^Limit \(/i), { target: { value: '45,000,000' } });
    fireEvent.change(screen.getByLabelText(/Rate On Line/i), { target: { value: '8.5' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Retro Contract/i }));

    await waitFor(() => expect(api.saveRetroProgramme).toHaveBeenCalled());
    expect(api.saveRetroProgramme.mock.calls[0][0]).toMatchObject({
      uw_year: 2027, currency: 'USD', label: '2027 Cat XL Retro',
      retention_amt: 5000000, limit_amt: 45000000, rol_pct: 8.5, max_line_pct: 25,
    });
    // Blank optional fields are omitted rather than sent as empty strings.
    expect(api.saveRetroProgramme.mock.calls[0][0]).not.toHaveProperty('notes');
    expect(await screen.findByRole('status')).toHaveTextContent('Saved the 2027 SAR retro contract.');
    expect(api.getRetroProgrammes).toHaveBeenCalledTimes(2);   // list refreshed
  });

  it('loads a captured year into the form to edit it, and re-saves the same key', async () => {
    render(<RetroProgrammeScreen />);
    const row = within(await screen.findByTestId('rp-row-2026-SAR'));
    fireEvent.click(row.getByRole('button', { name: /Edit/i }));

    expect(screen.getByTestId('rp-form')).toHaveTextContent('Editing 2026 SAR');
    expect(screen.getByLabelText(/Retention/i)).toHaveValue('25,000,000');
    expect(screen.getByLabelText(/Limit Used/i)).toHaveValue('40,000,000');

    fireEvent.change(screen.getByLabelText(/Limit Used/i), { target: { value: '60,000,000' } });
    fireEvent.click(screen.getByRole('button', { name: /Save Changes/i }));
    await waitFor(() => expect(api.saveRetroProgramme).toHaveBeenCalled());
    expect(api.saveRetroProgramme.mock.calls[0][0]).toMatchObject({
      uw_year: 2026, currency: 'SAR', used_limit_amt: 60000000,
    });
  });

  it('surfaces a rejected save instead of pretending it worked', async () => {
    api.saveRetroProgramme.mockRejectedValue(new Error('uw_year is required'));
    render(<RetroProgrammeScreen />);
    await screen.findByTestId('rp-row-2026-SAR');
    fireEvent.click(screen.getByRole('button', { name: /Save Retro Contract/i }));
    expect(await screen.findByRole('alert')).toHaveTextContent('uw_year is required');
  });

  it('deletes a year once confirmed, warning what that costs', async () => {
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(true);
    render(<RetroProgrammeScreen />);
    const row = within(await screen.findByTestId('rp-row-2026-SAR'));
    fireEvent.click(row.getByRole('button', { name: /Delete/i }));
    await waitFor(() => expect(api.deleteRetroProgramme).toHaveBeenCalledWith('r1'));
    expect(confirmSpy.mock.calls[0][0]).toMatch(/no retro analysis for that year/i);
    confirmSpy.mockRestore();
  });

  it('keeps the contract away from users below the admin tier', () => {
    level = 5;
    render(<RetroProgrammeScreen />);
    expect(screen.getByText(/Access restricted to Chief Underwriter/i)).toBeInTheDocument();
    expect(api.getRetroProgrammes).not.toHaveBeenCalled();
  });

  it('tells an empty install what is missing', async () => {
    api.getRetroProgrammes.mockResolvedValue({ programmes: [] });
    render(<RetroProgrammeScreen />);
    expect(await screen.findByText(/No retro contract has been captured yet/i)).toBeInTheDocument();
    expect(screen.getByText(/offer modal shows no retro analysis until a year is entered/i)).toBeInTheDocument();
  });
});
