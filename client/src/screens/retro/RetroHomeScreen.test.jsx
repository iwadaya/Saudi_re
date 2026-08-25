// RetroHomeScreen — the Retro module home. Covers: the manager vs read-only
// gate (New Programme / Edit / Delete only render with can_manage), the
// programme ledger render, the coverage matrix with its RETRO / NO RETRO
// badges, the year refetch, create via the editor modal, and the load-failure
// alert.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({
  getRetroPermissions: vi.fn(),
  getRetroSummary: vi.fn(),
  listRetroProgrammes: vi.fn(),
  getRetroCoverage: vi.fn(),
  listClassOfBusiness: vi.fn(),
  getRefListItems: vi.fn(),
  getRetroRegions: vi.fn(),
  createRetroProgramme: vi.fn(),
  updateRetroProgramme: vi.fn(),
  deleteRetroProgramme: vi.fn(),
  getRetroProgramme: vi.fn(),
  uploadRetroPack: vi.fn(),
  deleteRetroPack: vi.fn(),
  getRetroPackDownloadUrl: vi.fn(() => 'http://x/download'),
}));
vi.mock('../../api', () => ({ api: apiMock }));

vi.mock('../../components/Topbar', () => ({
  __esModule: true,
  default: ({ title }) => <div data-testid="topbar">{title}</div>,
}));

vi.mock('../../utils/logger', () => ({ logger: { error: vi.fn(), warn: vi.fn(), info: vi.fn() } }));

import RetroHomeScreen from './RetroHomeScreen.jsx';

const YEAR = new Date().getFullYear();

const SUMMARY = { year: YEAR, total_programmes: 2, active: 1, draft: 1, active_occurrence_limit: 20000000, active_premium: 2500000 };

const PROGRAMME = {
  retro_programme_id: 'p1', uw_year: YEAR, programme_name: 'Property Cat XL',
  programme_type: 'XL_CAT', status: 'ACTIVE', reinsurer: 'Global Re', currency_code: 'USD',
  cession_pct: null, commission_pct: null, attachment: 5000000, occurrence_limit: 20000000,
  aggregate_limit: 40000000, reinstatements: 1, rol_pct: 12.5, premium: 2500000,
  covers_all_classes: false, covers_all_countries: true,
  classes: [{ class_of_business_id: 'cob1', name: 'Property' }],
  countries: [], packs_count: 2,
};

const COVERAGE = {
  year: YEAR,
  programme_count: 1,
  cells: [
    { country_id: 'c1', country_name: 'Saudi Arabia', class_of_business_id: 'cob1', class_name: 'Property',
      contract_count: 3, gross_limit_100: 80000000, signed_exposure: 8000000,
      has_retro: true, retro_limit: 20000000,
      programmes: [{ retro_programme_id: 'p1', programme_name: 'Property Cat XL' }] },
    { country_id: 'c2', country_name: 'Kenya', class_of_business_id: 'cob2', class_name: 'Motor',
      contract_count: 1, gross_limit_100: 5000000, signed_exposure: 500000,
      has_retro: false, retro_limit: 0, programmes: [] },
  ],
};

const matrix = () => within(screen.getByTestId('retro-coverage-matrix'));

beforeEach(() => {
  vi.clearAllMocks();
  apiMock.getRetroPermissions.mockResolvedValue({ can_manage: true });
  apiMock.getRetroSummary.mockResolvedValue(SUMMARY);
  apiMock.listRetroProgrammes.mockResolvedValue([PROGRAMME]);
  apiMock.getRetroCoverage.mockResolvedValue(COVERAGE);
  apiMock.listClassOfBusiness.mockResolvedValue([{ id: 'cob1', name: 'Property' }, { id: 'cob2', name: 'Motor' }]);
  apiMock.getRefListItems.mockResolvedValue([{ id: 'c1', name: 'Saudi Arabia' }, { id: 'c2', name: 'Kenya' }]);
  apiMock.getRetroRegions.mockResolvedValue(['Middle East', 'Africa']);
  apiMock.createRetroProgramme.mockResolvedValue({ ok: true });
  apiMock.deleteRetroProgramme.mockResolvedValue({ ok: true });
});

describe('RetroHomeScreen', () => {
  it('renders KPIs, the programme ledger row and its scope tags', async () => {
    render(<RetroHomeScreen />);
    expect(await screen.findByText('Property Cat XL')).toBeInTheDocument();
    expect(screen.getByText('Active Programmes')).toBeInTheDocument();
    expect(screen.getByText('Occurrence Limit (Active)')).toBeInTheDocument();
    // Scope: named class + covers-all countries tag; pack count link.
    // ('Property' also appears as a matrix column header, so allow both.)
    expect(screen.getAllByText('Property').length).toBeGreaterThan(0);
    expect(screen.getByText('All countries')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: '2 files' })).toBeInTheDocument();
  });

  it('shows the coverage matrix with RETRO and NO RETRO badges per cell', async () => {
    render(<RetroHomeScreen />);
    await screen.findByTestId('retro-coverage-matrix');
    const m = matrix();
    expect(m.getByText('Saudi Arabia')).toBeInTheDocument();
    expect(m.getByText('Kenya')).toBeInTheDocument();
    expect(m.getByText('RETRO')).toBeInTheDocument();
    expect(m.getByText('NO RETRO')).toBeInTheDocument();
    expect(m.getByText('80,000,000')).toBeInTheDocument();
    // Protected/total cells KPI.
    expect(screen.getByText('1 / 2')).toBeInTheDocument();
  });

  it('refetches when the UW year changes', async () => {
    render(<RetroHomeScreen />);
    await screen.findByText('Property Cat XL');
    fireEvent.change(screen.getByLabelText('Underwriting year'), { target: { value: String(YEAR - 1) } });
    await waitFor(() => expect(apiMock.listRetroProgrammes).toHaveBeenLastCalledWith({ year: String(YEAR - 1) }));
    await waitFor(() => expect(apiMock.getRetroCoverage).toHaveBeenLastCalledWith(String(YEAR - 1)));
  });

  it('creates a programme through the editor modal and reloads', async () => {
    render(<RetroHomeScreen />);
    await screen.findByText('Property Cat XL');
    fireEvent.click(screen.getByRole('button', { name: '+ New Programme' }));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByLabelText(/Programme name/), { target: { value: 'New WA XL' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Create Programme' }));
    await waitFor(() => expect(apiMock.createRetroProgramme).toHaveBeenCalledTimes(1));
    expect(apiMock.createRetroProgramme.mock.calls[0][0]).toMatchObject({
      programme_name: 'New WA XL', uw_year: String(YEAR),
    });
    // Reload after save (initial load + post-create).
    await waitFor(() => expect(apiMock.listRetroProgrammes).toHaveBeenCalledTimes(2));
  });

  it('captures tower layers and a region scope on create', async () => {
    render(<RetroHomeScreen />);
    await screen.findByText('Property Cat XL');
    fireEvent.click(screen.getByRole('button', { name: '+ New Programme' }));
    const dialog = within(await screen.findByRole('dialog'));
    fireEvent.change(dialog.getByLabelText(/Programme name/), { target: { value: 'Layered Tower' } });
    // Region scope (options come from api.getRetroRegions).
    fireEvent.click(dialog.getByLabelText('Middle East'));
    // Two layers with different coverages.
    fireEvent.click(dialog.getByRole('button', { name: '+ Add layer' }));
    fireEvent.click(dialog.getByRole('button', { name: '+ Add layer' }));
    fireEvent.change(dialog.getByLabelText('Layer 1 attachment'), { target: { value: '5000000' } });
    fireEvent.change(dialog.getByLabelText('Layer 1 occurrence limit'), { target: { value: '10000000' } });
    fireEvent.change(dialog.getByLabelText('Layer 2 attachment'), { target: { value: '15000000' } });
    fireEvent.change(dialog.getByLabelText('Layer 2 occurrence limit'), { target: { value: '25000000' } });
    fireEvent.click(dialog.getByRole('button', { name: 'Create Programme' }));
    await waitFor(() => expect(apiMock.createRetroProgramme).toHaveBeenCalledTimes(1));
    const body = apiMock.createRetroProgramme.mock.calls[0][0];
    expect(body.regions).toEqual(['Middle East']);
    expect(body.layers).toHaveLength(2);
    expect(body.layers[1]).toMatchObject({ attachment: '15000000', occurrence_limit: '25000000' });
  });

  it('hides all write controls for a read-only user (underwriter view)', async () => {
    apiMock.getRetroPermissions.mockResolvedValue({ can_manage: false });
    render(<RetroHomeScreen />);
    await screen.findByText('Property Cat XL');
    expect(screen.queryByRole('button', { name: '+ New Programme' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Delete' })).toBeNull();
    // The coverage matrix — the underwriter's view — still renders.
    expect(await screen.findByTestId('retro-coverage-matrix')).toBeInTheDocument();
  });

  it('surfaces a load failure as an alert', async () => {
    apiMock.getRetroSummary.mockRejectedValue(new Error('boom'));
    render(<RetroHomeScreen />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Failed to load the retro module');
  });
});
