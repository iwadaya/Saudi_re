// FacDocuments.test.jsx — behavioral contract for the Documents screen
// (Phase 4.2). Written against the pre-decomposition screen first, so the
// orchestrator + hooks/components split can be verified against the same
// assertions:
//   1. documents list renders from a fixture (sorted, badges, status cells)
//   2. accept flow calls the right APIs and flips the row state
//   3. Undo restores the prior value via the existing save APIs
//   4. load-failure path (pins current behavior: logged + empty state)
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, within, waitFor, fireEvent } from '@testing-library/react';

const apiMock = vi.hoisted(() => ({
  // list + upload + analyse
  facGetDocuments: vi.fn(),
  facGetAnalyses: vi.fn(),
  facUploadDocumentMultipart: vi.fn(),
  facAnalyseDocument: vi.fn(),
  facDeleteDocument: vi.fn(),
  // drawer
  facGetAnalysis: vi.fn(),
  facGetFactors: vi.fn(),
  facAcceptRecommendation: vi.fn(),
  facRejectRecommendation: vi.fn(),
  // undo restore surface
  facGetRisk: vi.fn(),
  facUpdateRisk: vi.fn(),
  facGetUwFactors: vi.fn(),
  facSaveUwFactors: vi.fn(),
  facGetCope: vi.fn(),
  facSaveCope: vi.fn(),
  facGetClausesChecklist: vi.fn(),
  facSaveClausesChecklist: vi.fn(),
  facGetLocations: vi.fn(),
  facSaveLocations: vi.fn(),
  facGetLosses: vi.fn(),
  facSaveLosses: vi.fn(),
}));
const invalidateMock = vi.hoisted(() => vi.fn());

vi.mock('../../../api', () => ({ __esModule: true, default: apiMock, api: apiMock }));
vi.mock('../../../hooks/useContractId', () => ({ useFacRiskId: () => 'RISK-1' }));
vi.mock('../../../components/WizardLayout', () => ({
  __esModule: true,
  default: function FakeWizardLayout({ children }) {
    return <div>{typeof children === 'function' ? children() : children}</div>;
  },
}));
vi.mock('../../../components/FacPendingRecsBanner', () => ({
  __esModule: true,
  default: () => null,
  invalidateFacPendingRecsCache: invalidateMock,
}));
vi.mock('react-router-dom', () => ({
  __esModule: true,
  useSearchParams: () => [new URLSearchParams(), vi.fn()],
  useNavigate: () => vi.fn(),
  useLocation: () => ({ pathname: '/', state: null }),
}));

import FacDocuments from './FacDocuments';

// ── Fixtures ────────────────────────────────────────────────────────

const DOCS = [
  {
    document_id: 'doc-1',
    file_name: 'slip.pdf',
    document_kind: 'PLACEMENT_SLIP',
    byte_size: 2048,
    uploaded_at: '2026-06-01T10:00:00.000Z',
    uploaded_by_user_id: 'aaaabbbb-cccc-dddd-eeee-ffff00001111',
  },
  {
    document_id: 'doc-2',
    file_name: 'survey.pdf',
    document_kind: 'SURVEY_REPORT',
    byte_size: 5 * 1024 * 1024,
    uploaded_at: '2026-05-20T09:00:00.000Z',
    uploaded_by: 'alice',
  },
];

const ANALYSES = {
  analyses: [
    {
      analysis_id: 'an-1',
      document_id: 'doc-1',
      document_filename: 'slip.pdf',
      document_kind: 'PLACEMENT_SLIP',
      status: 'SUCCEEDED',
      recommendation_count: 2,
      pending_count: 1,
      created_at: '2026-06-01T10:05:00.000Z',
    },
  ],
};

const REC_PENDING = {
  recommendation_id: 'rec-1',
  analysis_id: 'an-1',
  target_screen: 'FAC_RISK_DETAIL',
  target_field: 'inception_date',
  current_value: '2026-01-01',
  suggested_value: '2026-02-01',
  rationale: 'Slip shows inception 1 Feb 2026',
  confidence: 0.92,
  status: 'PENDING',
};

const REC_PRIOR_ACCEPTED = {
  recommendation_id: 'rec-0',
  analysis_id: 'an-1',
  target_screen: 'FAC_RISK_DETAIL',
  target_field: 'occupancy_code',
  current_value: null,
  suggested_value: 2934,
  rationale: 'Occupancy stated on the slip',
  confidence: 0.7,
  status: 'ACCEPTED',
};

function analysisDetail(recs) {
  return {
    analysis: {
      analysis_id: 'an-1',
      fac_risk_id: 'RISK-1',
      document_filename: 'slip.pdf',
      analysis_kind: 'PLACEMENT_SLIP',
      status: 'SUCCEEDED',
      summary: 'Placement slip for ACME factory.',
      completed_at: '2026-06-01T10:06:00.000Z',
      extracted: { insured: 'ACME' },
    },
    recommendations: recs,
  };
}

function mockHappyList() {
  apiMock.facGetDocuments.mockResolvedValue(DOCS);
  apiMock.facGetAnalyses.mockResolvedValue(ANALYSES);
  apiMock.facGetFactors.mockResolvedValue({ factors: [] });
}

async function openDrawer() {
  render(<FacDocuments />);
  const opener = await screen.findByRole('button', { name: /Succeeded — 2 recommendations/ });
  fireEvent.click(opener);
  return await screen.findByRole('dialog');
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ── 1. List render ──────────────────────────────────────────────────

describe('documents list', () => {
  it('renders the fixture documents with kind, size, uploader and status', async () => {
    mockHappyList();

    render(<FacDocuments />);

    expect(await screen.findByText('slip.pdf')).toBeInTheDocument();
    expect(screen.getByText('survey.pdf')).toBeInTheDocument();

    // kind badges use the human label, not the enum code
    expect(screen.getByText('Placement Slip')).toBeInTheDocument();
    expect(screen.getByText('Survey Report')).toBeInTheDocument();

    // sizes are humanised
    expect(screen.getByText('2.0 KB')).toBeInTheDocument();
    expect(screen.getByText('5.0 MB')).toBeInTheDocument();

    // uploader: uuid is shortened to 8 chars, legacy rows fall back to name
    expect(screen.getByText('aaaabbbb')).toBeInTheDocument();
    expect(screen.getByText('alice')).toBeInTheDocument();

    // newest document sorts first
    const rows = screen.getAllByRole('row').slice(1); // drop header row
    expect(within(rows[0]).getByText('slip.pdf')).toBeInTheDocument();
    expect(within(rows[1]).getByText('survey.pdf')).toBeInTheDocument();

    // doc-1 has a SUCCEEDED analysis → clickable status; doc-2 has none
    expect(
      within(rows[0]).getByRole('button', { name: /Succeeded — 2 recommendations/ }),
    ).toBeInTheDocument();
    expect(within(rows[1]).getByText('—')).toBeInTheDocument();

    // per-row actions: View disabled without a SUCCEEDED analysis
    expect(within(rows[0]).getByRole('button', { name: 'View' })).toBeEnabled();
    expect(within(rows[1]).getByRole('button', { name: 'View' })).toBeDisabled();

    expect(apiMock.facGetDocuments).toHaveBeenCalledWith('RISK-1');
    expect(apiMock.facGetAnalyses).toHaveBeenCalledWith('RISK-1');
  });
});

// ── 2. Accept flow ──────────────────────────────────────────────────

describe('recommendation accept flow', () => {
  it('accepts a pending recommendation and flips the card to "Accepted just now"', async () => {
    mockHappyList();
    apiMock.facGetAnalysis
      .mockResolvedValueOnce(analysisDetail([REC_PENDING, REC_PRIOR_ACCEPTED]))
      .mockResolvedValue(analysisDetail([
        { ...REC_PENDING, status: 'ACCEPTED' },
        REC_PRIOR_ACCEPTED,
      ]));
    apiMock.facAcceptRecommendation.mockResolvedValue({
      recommendation_id: 'rec-1',
      status: 'ACCEPTED',
      target_field: 'inception_date',
      before: '2026-01-01',
      after: '2026-02-01',
    });

    const dialog = await openDrawer();

    expect(apiMock.facGetAnalysis).toHaveBeenCalledWith('an-1');
    expect(await within(dialog).findByText('Recommendations (2)')).toBeInTheDocument();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Accept' }));

    expect(await within(dialog).findByText(/Accepted just now/)).toBeInTheDocument();
    expect(apiMock.facAcceptRecommendation).toHaveBeenCalledTimes(1);
    expect(apiMock.facAcceptRecommendation).toHaveBeenCalledWith('rec-1', {});

    // drawer reloads the analysis and tells the banner cache
    expect(apiMock.facGetAnalysis).toHaveBeenCalledTimes(2);
    expect(invalidateMock).toHaveBeenCalledWith('RISK-1');

    // applied pill points at the affected screen
    expect(within(dialog).getByText(/1 change applied · FAC_RISK_DETAIL/)).toBeInTheDocument();

    // the pending action row is gone (no more bare Accept button)
    expect(within(dialog).queryByRole('button', { name: 'Accept' })).toBeNull();
  });
});

// ── 3. Undo ─────────────────────────────────────────────────────────
//
// Accepting applies the suggested value server-side and echoes
// { before, after }. Undo restores the prior value through the same
// save APIs the wizard screens use (read-modify-write so unrelated
// fields survive), then shows the local "undone" marker — there is no
// unaccept endpoint, so the rec row itself stays ACCEPTED.

describe('recommendation undo', () => {
  it('risk column: GETs the risk and PUTs it back with the prior value', async () => {
    mockHappyList();
    apiMock.facGetAnalysis
      .mockResolvedValueOnce(analysisDetail([REC_PENDING, REC_PRIOR_ACCEPTED]))
      .mockResolvedValue(analysisDetail([
        { ...REC_PENDING, status: 'ACCEPTED' },
        REC_PRIOR_ACCEPTED,
      ]));
    apiMock.facAcceptRecommendation.mockResolvedValue({
      recommendation_id: 'rec-1',
      status: 'ACCEPTED',
      target_field: 'inception_date',
      before: '2026-01-01',
      after: '2026-02-01',
    });
    const RISK_ROW = {
      fac_risk_id: 'RISK-1',
      insured_name: 'ACME Industries',
      inception_date: '2026-02-01', // post-accept value
      expiry_date: '2027-01-31',
      occupancy_code: 2934,
      status: 'DRAFT',
    };
    apiMock.facGetRisk.mockResolvedValue(RISK_ROW);
    apiMock.facUpdateRisk.mockResolvedValue({ ...RISK_ROW, inception_date: '2026-01-01' });

    const dialog = await openDrawer();
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Accept' }));
    await within(dialog).findByText(/Accepted just now/);

    // a risk-column accept needs no pre-accept capture call
    expect(apiMock.facGetRisk).not.toHaveBeenCalled();

    const undoBtn = within(dialog).getByRole('button', { name: 'Undo' });
    expect(undoBtn).toBeEnabled();
    fireEvent.click(undoBtn);

    expect(
      await within(dialog).findByText(/Undone — the previous value was restored/),
    ).toBeInTheDocument();

    // read-modify-write: full row back with ONLY the column reverted
    expect(apiMock.facGetRisk).toHaveBeenCalledWith('RISK-1');
    expect(apiMock.facUpdateRisk).toHaveBeenCalledTimes(1);
    expect(apiMock.facUpdateRisk).toHaveBeenCalledWith('RISK-1', {
      ...RISK_ROW,
      inception_date: '2026-01-01',
    });

    // flash + affordance retract; pill is cleared; drawer reloads
    expect(within(dialog).queryByText(/Accepted just now/)).toBeNull();
    expect(within(dialog).queryByRole('button', { name: 'Undo' })).toBeNull();
    expect(within(dialog).queryByText(/1 change applied · FAC_RISK_DETAIL/)).toBeNull();
    expect(apiMock.facGetAnalysis).toHaveBeenCalledTimes(3);
    expect(invalidateMock).toHaveBeenCalledTimes(2);
  });

  it('factor: rewrites the uw-factors selections with the prior option', async () => {
    mockHappyList();
    const recFactor = {
      recommendation_id: 'rec-f',
      analysis_id: 'an-1',
      target_screen: 'FAC_PRICING',
      target_field: 'factor.FIRE_PROTECTION',
      current_value: 'Poor',
      suggested_value: 'Good',
      rationale: 'Survey shows sprinklers throughout',
      confidence: 0.9,
      status: 'PENDING',
    };
    apiMock.facGetAnalysis
      .mockResolvedValueOnce(analysisDetail([recFactor]))
      .mockResolvedValue(analysisDetail([{ ...recFactor, status: 'ACCEPTED' }]));
    apiMock.facAcceptRecommendation.mockResolvedValue({
      recommendation_id: 'rec-f',
      status: 'ACCEPTED',
      target_field: 'factor.FIRE_PROTECTION',
      before: 'Poor',
      after: 'Good',
    });
    apiMock.facGetUwFactors.mockResolvedValue({
      selections: { FIRE_PROTECTION: 'Good', HOUSEKEEPING: 'Fair' },
      notes: 'survey notes',
    });
    apiMock.facSaveUwFactors.mockResolvedValue({});

    const dialog = await openDrawer();
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Accept' }));
    await within(dialog).findByText(/Accepted just now/);
    expect(apiMock.facGetUwFactors).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole('button', { name: 'Undo' }));
    await within(dialog).findByText(/Undone — the previous value was restored/);

    expect(apiMock.facGetUwFactors).toHaveBeenCalledWith('RISK-1');
    expect(apiMock.facSaveUwFactors).toHaveBeenCalledTimes(1);
    expect(apiMock.facSaveUwFactors).toHaveBeenCalledWith('RISK-1', {
      selections: { FIRE_PROTECTION: 'Poor', HOUSEKEEPING: 'Fair' },
      notes: 'survey notes',
    });
  });

  it('clause: captures { is_checked, comments } before accept and restores both', async () => {
    mockHappyList();
    const recClause = {
      recommendation_id: 'rec-c',
      analysis_id: 'an-1',
      target_screen: 'FAC_RISK_DETAIL',
      target_field: 'clause.LM7',
      current_value: false,
      suggested_value: true,
      rationale: 'Wording references LM7',
      confidence: 0.95,
      status: 'PENDING',
    };
    apiMock.facGetAnalysis
      .mockResolvedValueOnce(analysisDetail([recClause]))
      .mockResolvedValue(analysisDetail([{ ...recClause, status: 'ACCEPTED' }]));
    apiMock.facGetClausesChecklist.mockResolvedValue({
      items: [
        { clause_code: 'LM7', is_checked: false, comments: 'n/a per cedant' },
        { clause_code: 'ABI', is_checked: true, comments: null },
      ],
    });
    apiMock.facAcceptRecommendation.mockResolvedValue({
      recommendation_id: 'rec-c',
      status: 'ACCEPTED',
      target_field: 'clause.LM7',
      before: false,
      after: true,
    });
    apiMock.facSaveClausesChecklist.mockResolvedValue({ items: [] });

    const dialog = await openDrawer();
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Accept' }));
    await within(dialog).findByText(/Accepted just now/);

    // the prior clause state was captured BEFORE the accept mutated it
    expect(apiMock.facGetClausesChecklist).toHaveBeenCalledTimes(1);
    expect(apiMock.facGetClausesChecklist.mock.invocationCallOrder[0])
      .toBeLessThan(apiMock.facAcceptRecommendation.mock.invocationCallOrder[0]);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Undo' }));
    await within(dialog).findByText(/Undone — the previous value was restored/);

    // restore posts ONLY the affected clause, with the captured comment
    expect(apiMock.facSaveClausesChecklist).toHaveBeenCalledTimes(1);
    expect(apiMock.facSaveClausesChecklist).toHaveBeenCalledWith('RISK-1', {
      items: [{ clause_code: 'LM7', is_checked: false, comments: 'n/a per cedant' }],
    });
  });

  it('surfaces a per-card error and keeps the affordance when the restore fails', async () => {
    mockHappyList();
    apiMock.facGetAnalysis
      .mockResolvedValueOnce(analysisDetail([REC_PENDING]))
      .mockResolvedValue(analysisDetail([{ ...REC_PENDING, status: 'ACCEPTED' }]));
    apiMock.facAcceptRecommendation.mockResolvedValue({
      recommendation_id: 'rec-1',
      status: 'ACCEPTED',
      target_field: 'inception_date',
      before: '2026-01-01',
      after: '2026-02-01',
    });
    apiMock.facGetRisk.mockRejectedValue(new Error('API GET → 500: down'));

    const dialog = await openDrawer();
    fireEvent.click(await within(dialog).findByRole('button', { name: 'Accept' }));
    await within(dialog).findByText(/Accepted just now/);

    fireEvent.click(within(dialog).getByRole('button', { name: 'Undo' }));

    expect(await within(dialog).findByRole('alert')).toHaveTextContent(/API GET → 500: down/);
    // nothing was written; the value-restoring PUT never fired
    expect(apiMock.facUpdateRisk).not.toHaveBeenCalled();
    // still accepted, still undoable
    expect(within(dialog).getByText(/Accepted just now/)).toBeInTheDocument();
    expect(within(dialog).getByRole('button', { name: 'Undo' })).toBeEnabled();
  });
});

// ── 4. Load failure ─────────────────────────────────────────────────

describe('load failure', () => {
  it('logs the error and falls back to the empty state (current behavior)', async () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const boom = new Error('API GET → 500: down');
    apiMock.facGetDocuments.mockRejectedValue(boom);
    apiMock.facGetAnalyses.mockResolvedValue({ analyses: [] });

    render(<FacDocuments />);

    expect(await screen.findByText('No documents attached yet.')).toBeInTheDocument();
    await waitFor(() => expect(consoleSpy).toHaveBeenCalled());
    expect(consoleSpy.mock.calls.some((args) => args.includes(boom))).toBe(true);
  });
});
