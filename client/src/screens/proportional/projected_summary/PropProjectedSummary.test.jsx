import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import PropProjectedSummary from './PropProjectedSummary.jsx';

const { apiMock, appStateMock, contractIdRef, loadProjectedRowsMock } = vi.hoisted(() => ({
  apiMock: { getDevFactorStaleness: vi.fn(), getLossSelectionStaleness: vi.fn(), savePricingYearly: vi.fn() },
  appStateMock: { quoteMode: false, propTreatyDetail: {} },
  contractIdRef: { current: 'contract-1' },
  loadProjectedRowsMock: vi.fn(),
}));

vi.mock('../../../api', () => ({ api: apiMock }));
vi.mock('../../../hooks/useContractId', () => ({ useContractId: () => contractIdRef.current }));
vi.mock('../../../context/AppContext', () => ({ useAppState: () => ({ state: appStateMock }) }));
vi.mock('../../../components/WizardLayout', () => ({
  default: ({ children }) => (
    <section>{typeof children === 'function' ? children({ showToast: () => {} }) : children}</section>
  ),
}));
vi.mock('../../../logic/projectWithSavedFactors', () => ({ loadProjectedRows: loadProjectedRowsMock }));
// Keep the real deriveLossComponents; only stub the network-backed loader.
vi.mock('../../../logic/lossCategoryAmounts', async (importOriginal) => {
  const actual = await importOriginal();
  return { ...actual, loadLossCategoryByYear: vi.fn().mockResolvedValue({ large: new Map(), cat: new Map() }) };
});

// type-aware staleness responder
const staleness = (incurred, premium) => (_id, type) =>
  Promise.resolve({ stale: type === 'INCURRED' ? incurred : premium });

afterEach(() => { cleanup(); vi.clearAllMocks(); });

beforeEach(() => {
  contractIdRef.current = 'contract-1';
  appStateMock.quoteMode = false;
  appStateMock.propTreatyDetail = {};
  apiMock.getLossSelectionStaleness.mockResolvedValue({ stale: false });
  loadProjectedRowsMock.mockResolvedValue({
    rows: [{ year: 2021, ultPrem: 1000, ultLoss: 500, actPrem: 1000, actLoss: 500, ultPaid: 400 }],
    source: 'saved-factors',
  });
});

describe('PropProjectedSummary staleness banner', () => {
  it('shows the incurred-only message', async () => {
    apiMock.getDevFactorStaleness.mockImplementation(staleness(true, false));
    render(<PropProjectedSummary />);
    expect(await screen.findByText(
      /^Incurred triangle updated since dev factors were last saved/i,
    )).toBeInTheDocument();
  });

  it('shows the premium-only message', async () => {
    apiMock.getDevFactorStaleness.mockImplementation(staleness(false, true));
    render(<PropProjectedSummary />);
    expect(await screen.findByText(
      /^Premium triangle updated since dev factors were last saved/i,
    )).toBeInTheDocument();
  });

  it('shows the combined message when both are stale', async () => {
    apiMock.getDevFactorStaleness.mockImplementation(staleness(true, true));
    render(<PropProjectedSummary />);
    expect(await screen.findByText(
      /^Premium and incurred triangles updated since dev factors were last saved/i,
    )).toBeInTheDocument();
  });

  it('shows no banner when neither is stale', async () => {
    apiMock.getDevFactorStaleness.mockImplementation(staleness(false, false));
    render(<PropProjectedSummary />);
    // Wait for the page to render, then assert the (only) alert is absent.
    expect(await screen.findByText(/UNCAPPED ULTIMATES/i)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
  });

  it('shows the loss-selection-outdated message when loss selection is stale', async () => {
    apiMock.getDevFactorStaleness.mockImplementation(staleness(false, false));
    apiMock.getLossSelectionStaleness.mockResolvedValue({ stale: true });
    render(<PropProjectedSummary />);
    expect(await screen.findByText(/Loss selection is outdated/i)).toBeInTheDocument();
  });

  it('combines factor and loss staleness in one banner', async () => {
    apiMock.getDevFactorStaleness.mockImplementation(staleness(true, false));
    apiMock.getLossSelectionStaleness.mockResolvedValue({ stale: true });
    render(<PropProjectedSummary />);
    expect(await screen.findByText(/Incurred triangle updated since dev factors/i)).toBeInTheDocument();
    expect(screen.getByText(/Loss selection is outdated/i)).toBeInTheDocument();
  });

  it('shows the prominent placeholder-curve banner when projection used benchmark curves', async () => {
    apiMock.getDevFactorStaleness.mockImplementation(staleness(false, false));
    loadProjectedRowsMock.mockResolvedValue({
      rows: [{ year: 2021, ultPrem: 1000, ultLoss: 500, actPrem: 1000, actLoss: 500, ultPaid: 400 }],
      source: 'straight-benchmark',
      usedPlaceholderLdfs: true,
    });
    render(<PropProjectedSummary />);
    expect(await screen.findByText(/projection is using placeholder benchmark curves/i)).toBeInTheDocument();
  });
});
