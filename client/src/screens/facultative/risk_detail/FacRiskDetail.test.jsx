// Phase-2 migration test: the primary risk load rides
// useScreenSave→useResource behind an AsyncBoundary, and the reference
// lists ride useResource directly (degrading to empty lists on failure),
// so the loading→loaded and loading→error transitions are part of the
// screen's contract.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render, screen, waitFor, fireEvent } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({
  // Primary risk load + save
  facGetRisk: vi.fn(),
  facUpdateRisk: vi.fn(),
  // Sections — their own entity (migration 133) with their own save.
  facGetSections: vi.fn(),
  facSaveSections: vi.fn(),
  // Reference lists (single useResource over Promise.all)
  listCedants: vi.fn(),
  listBrokers: vi.fn(),
  getRefListItems: vi.fn(),
  facListClasses: vi.fn(),
  facGetOccupancies: vi.fn(),
  facGetNatcatRates: vi.fn(),
  facGetScoringTables: vi.fn(),
  // Address lookup — the Insured Address field probes this on mount. Left
  // unconfigured here so the field behaves as the plain text input these
  // specs assert against.
  facPlacesStatus: vi.fn(),
  facPlacesSuggest: vi.fn(),
  facPlaceDetails: vi.fn(),
  // Related Treaties side-section (lazy; only fires once cedant+cob set)
  facGetEligibleTreaties: vi.fn(),
  facGetTreatyLinks: vi.fn(),
  facCreateTreatyLink: vi.fn(),
  facDeleteTreatyLink: vi.fn(),
}));
vi.mock('../../../api', () => ({ __esModule: true, default: apiMock, api: apiMock }));
// This fac screen resolves its entity via useFacRiskId (not useContractId).
vi.mock('../../../hooks/useContractId', () => ({ useFacRiskId: () => 'R-1' }));
vi.mock('../../../components/WizardLayout', () => ({
  __esModule: true,
  default: function FakeWizardLayout({ children }) {
    return <div>{typeof children === 'function' ? children() : children}</div>;
  },
}));

import { AppProvider } from '../../../context/AppContext';
import FacRiskDetail from './FacRiskDetail';

// The screen publishes the risk's rating families into app state so the
// wizard can hide the steps this risk has no use for, so it needs the
// provider the app always mounts it inside.
const renderScreen = () => render(<AppProvider><FacRiskDetail /></AppProvider>);

beforeEach(() => {
  vi.clearAllMocks();
  // Reference lists resolve empty by default — the screen must render
  // regardless (old behaviour: silently continue with empty lists).
  apiMock.listCedants.mockResolvedValue([]);
  apiMock.listBrokers.mockResolvedValue([]);
  apiMock.getRefListItems.mockResolvedValue({ items: [] });
  apiMock.facListClasses.mockResolvedValue([]);
  apiMock.facGetOccupancies.mockResolvedValue({ occupancies: [] });
  apiMock.facGetNatcatRates.mockResolvedValue({ rates: [] });
  apiMock.facGetScoringTables.mockResolvedValue({ territorial_capacity: [] });
  apiMock.facGetSections.mockResolvedValue([]);
  apiMock.facPlacesStatus.mockResolvedValue({ configured: false });
  apiMock.facSaveSections.mockResolvedValue([]);
  apiMock.facGetEligibleTreaties.mockResolvedValue({ treaties: [] });
  apiMock.facGetTreatyLinks.mockResolvedValue({ links: [] });
});

describe('FacRiskDetail', () => {
  it('transitions loading → loaded and hydrates the form', async () => {
    let resolveLoad;
    apiMock.facGetRisk.mockReturnValue(
      new Promise((resolve) => { resolveLoad = resolve; }),
    );

    renderScreen();

    // boundary shows while the risk fetch is in flight
    expect(screen.getByRole('status')).toHaveTextContent(/loading risk detail/i);

    resolveLoad({
      insured_name: 'SABIC Petrochemical Plant',
      fac_ref: 'FAC-2026-0001',
      nature_of_business: 'Petrochemical manufacturing',
    });

    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    // hydrated fields rendered inside the boundary
    expect(screen.getByDisplayValue('SABIC Petrochemical Plant')).toBeInTheDocument();
    expect(screen.getByText('FAC-2026-0001')).toBeInTheDocument();
    expect(apiMock.facGetRisk).toHaveBeenCalledWith('R-1');
  });

  it('transitions loading → error and recovers via Retry', async () => {
    apiMock.facGetRisk
      .mockRejectedValueOnce(Object.assign(new Error('API GET → 500: down'), { status: 500 }))
      .mockResolvedValueOnce({ insured_name: 'Recovered Insured' });

    renderScreen();

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent(/could not load/i);

    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));

    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull());
    expect(apiMock.facGetRisk).toHaveBeenCalledTimes(2);
    expect(screen.getByDisplayValue('Recovered Insured')).toBeInTheDocument();
  });

  it('keeps the form usable when reference lists fail (degrades to empty lists)', async () => {
    // All eight lookups ride one Promise.all — reject it wholesale.
    apiMock.listCedants.mockRejectedValue(Object.assign(new Error('lookups down'), { status: 500 }));
    apiMock.facGetRisk.mockResolvedValue({ insured_name: 'Still Editable Co' });

    renderScreen();

    await waitFor(() => expect(screen.queryByRole('status')).toBeNull());
    // No error boundary for reference data — the form still hydrates,
    // pickers just have no options (the pre-migration degradation).
    expect(screen.queryByRole('alert')).toBeNull();
    expect(screen.getByDisplayValue('Still Editable Co')).toBeInTheDocument();
    expect(screen.getByText('— Select Country —')).toBeInTheDocument();
  });
});
