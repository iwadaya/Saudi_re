// DocumentsScreen tests focused on the renewal-pack import + undo flow
// (Prompt 2). The upload-form / preview behaviour is exercised by the
// existing integration tests for the prop/np document screens; this
// file targets the new surface area added in this refactor.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';

// ── module mocks ───────────────────────────────────────────────────────────

const apiMock = {
  getDocuments: vi.fn(),
  getContract: vi.fn(),
  uploadDocument: vi.fn(),
  deleteDocument: vi.fn(),
  getDocumentDownloadUrl: vi.fn(() => '/dl'),
  getDocumentViewUrl: vi.fn(() => '/view'),
  importRenewalPack: vi.fn(),
  getRenewalPackImportJob: vi.fn(),
  getActiveRenewalPackImport: vi.fn(),
  listImportSnapshots: vi.fn(),
  restoreImportSnapshot: vi.fn(),
};

class FakeHttpError extends Error {
  constructor(status, body) { super(`HTTP ${status}`); this.status = status; this.body = body; }
}

vi.mock('../../api.js', () => ({ api: apiMock, HttpError: FakeHttpError }));
vi.mock('../../api', () => ({ api: apiMock, HttpError: FakeHttpError }));

// Stable toast — see MarketIntelligenceModal.test.jsx for the why.
const stableToast = vi.fn();
vi.mock('../../hooks/useToast.js', () => ({ useGlobalToast: () => stableToast }));
vi.mock('../../hooks/useToast', () => ({ useGlobalToast: () => stableToast }));

// Active contract id is constant for these tests.
const QUOTE_ID = '00000000-0000-0000-0000-000000000aaa';
vi.mock('../../hooks/useContractId', () => ({
  useContractId: () => QUOTE_ID,
  setActiveContractId: vi.fn(),
}));

// WizardLayout passes through its render-prop child as-is so we test
// the body content directly without dragging the wizard chrome in.
vi.mock('../../components/WizardLayout', () => ({
  __esModule: true,
  default: function FakeWizardLayout({ children }) {
    return typeof children === 'function' ? children() : children;
  },
}));

vi.mock('./WordingChecker', () => ({
  __esModule: true,
  default: () => null,
}));

// WordingAnalysisModal — render a minimal identifiable shell so tests
// can assert when the modal opens and which slip it's scoped to. The
// real component pulls in WordingChecker + auto-runs analysis; we don't
// want to exercise that here, just the open/close + props plumbing.
vi.mock('./WordingAnalysisModal', () => ({
  __esModule: true,
  default: function FakeModal({ doc, onClose }) {
    if (!doc) return null;
    return (
      <div role="dialog" aria-label="wording-analysis-modal" data-doc-id={doc.document_id || doc.id}>
        <div>Wording Analysis</div>
        <div>{doc.doc_type} — {doc.title || doc.file_name}</div>
        <button onClick={onClose}>close-modal</button>
      </div>
    );
  },
}));

const { default: DocumentsScreen } = await import('./DocumentsScreen.jsx');

// ── fixture builders ──────────────────────────────────────────────────────

function rpDoc({ id = 'doc-rp-1', filename = 'pack.xlsx', docType = 'Renewal Pack' } = {}) {
  return {
    document_id: id,
    file_name: filename,
    doc_type: docType,
    title: 'Renewal pack title',
    size_bytes: 12345,
    mime_type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    uploaded_at: '2026-05-01T12:00:00.000Z',
  };
}
function slipDoc({ id = 'doc-slip-1', filename = 'slip.pdf', docType = 'Final Slip', title = 'Slip title' } = {}) {
  return {
    document_id: id,
    file_name: filename,
    doc_type: docType,
    title,
    size_bytes: 9999,
    mime_type: 'application/pdf',
    uploaded_at: '2026-05-02T12:00:00.000Z',
  };
}

function nonSlipDoc({ id = 'doc-risk-1', filename = 'risks.pdf' } = {}) {
  return {
    document_id: id,
    file_name: filename,
    doc_type: 'Risk Profiles',
    title: 'Risk profiles',
    size_bytes: 4321,
    mime_type: 'application/pdf',
    uploaded_at: '2026-05-03T12:00:00.000Z',
  };
}

function defaultMocks({
  docs = [rpDoc()],
  treatyTypeId = 'tt-1',
  activeJob = null,
  snapshots = [],
} = {}) {
  apiMock.getDocuments.mockResolvedValue(docs);
  apiMock.getContract.mockResolvedValue({ header: { treaty_type_id: treatyTypeId, treaty_category: 'PROPORTIONAL' } });
  apiMock.getActiveRenewalPackImport.mockResolvedValue({ activeJob });
  apiMock.listImportSnapshots.mockResolvedValue(snapshots);
}

beforeEach(() => {
  vi.clearAllMocks();
  stableToast.mockClear();
});

afterEach(() => {
  vi.useRealTimers();
});

// ── tests ─────────────────────────────────────────────────────────────────

describe('DocumentsScreen — Fill from renewal pack visibility', () => {
  it('shows the Fill button on renewal_pack docs and hides it on other types', async () => {
    defaultMocks({ docs: [rpDoc(), slipDoc()] });
    render(<DocumentsScreen routeKey="PROP_TREATY_DOCUMENTS" quoteMode />);
    await waitFor(() => expect(screen.getByText('pack.xlsx')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /fill from renewal pack/i })).toBeInTheDocument();
    // Only one Fill button — slip.pdf doesn't have one.
    expect(screen.getAllByRole('button', { name: /fill from renewal pack/i })).toHaveLength(1);
  });

  it('normalises "renewal_pack" (snake case) as a valid renewal pack', async () => {
    defaultMocks({ docs: [rpDoc({ docType: 'renewal_pack' })] });
    render(<DocumentsScreen routeKey="PROP_TREATY_DOCUMENTS" quoteMode />);
    await waitFor(() => expect(screen.getByRole('button', { name: /fill from renewal pack/i })).toBeInTheDocument());
  });

  // The four treaty workflows that surface the Documents tab: proportional
  // pricing, non-proportional pricing, renewal (which creates a new contract,
  // so quoteMode=false), and quote. The button is gated only on doc type and
  // edit permission — the workflow itself never gates visibility.
  const FLOWS = [
    { name: 'proportional pricing',     routeKey: 'PROP_TREATY_DOCUMENTS', quoteMode: false },
    { name: 'non-proportional pricing', routeKey: 'NP_TREATY_DOCUMENTS',   quoteMode: false },
    { name: 'renewal',                  routeKey: 'NP_TREATY_DOCUMENTS',   quoteMode: false },
    { name: 'quote',                    routeKey: 'NP_TREATY_DOCUMENTS',   quoteMode: true  },
  ];

  for (const flow of FLOWS) {
    it(`shows the Fill button on a renewal_pack document in the ${flow.name} flow`, async () => {
      defaultMocks({ docs: [rpDoc()] });
      render(<DocumentsScreen routeKey={flow.routeKey} quoteMode={flow.quoteMode} />);
      await waitFor(() => expect(screen.getByText('pack.xlsx')).toBeInTheDocument());
      expect(screen.getByRole('button', { name: /fill from renewal pack/i })).toBeInTheDocument();
    });

    it(`does NOT show the Fill button on a non-renewal document in the ${flow.name} flow`, async () => {
      defaultMocks({ docs: [slipDoc()] });
      render(<DocumentsScreen routeKey={flow.routeKey} quoteMode={flow.quoteMode} />);
      await waitFor(() => expect(screen.getByText('slip.pdf')).toBeInTheDocument());
      expect(screen.queryByRole('button', { name: /fill from renewal pack/i })).not.toBeInTheDocument();
    });
  }
});

describe('DocumentsScreen — doc-fetch endpoint scoping', () => {
  // The endpoint choice has to follow the workflow, not a global flag.
  // In quote mode the API client gets { quote: true }; in treaty mode it
  // gets no opts so the request goes to /api/treaties/...
  it('fetches from the treaty endpoint when quoteMode is false', async () => {
    defaultMocks();
    render(<DocumentsScreen routeKey="PROP_TREATY_DOCUMENTS" quoteMode={false} />);
    await waitFor(() => expect(apiMock.getDocuments).toHaveBeenCalled());
    expect(apiMock.getDocuments).toHaveBeenCalledWith(QUOTE_ID, undefined);
  });

  it('fetches from the quote endpoint when quoteMode is true', async () => {
    defaultMocks();
    render(<DocumentsScreen routeKey="NP_TREATY_DOCUMENTS" quoteMode />);
    await waitFor(() => expect(apiMock.getDocuments).toHaveBeenCalled());
    expect(apiMock.getDocuments).toHaveBeenCalledWith(QUOTE_ID, { quote: true });
  });
});

describe('DocumentsScreen — import-status endpoints follow the workflow', () => {
  // Renewal-pack import-state endpoints exist on both entity sides;
  // the apiOpts the screen builds for documents flows straight through
  // to the import calls so they target the right /api/treaties/... or
  // /api/quotes/... family for the workflow the underwriter is in.
  it('fires getActiveRenewalPackImport + listImportSnapshots with treaty opts when quoteMode is false', async () => {
    defaultMocks();
    render(<DocumentsScreen routeKey="PROP_TREATY_DOCUMENTS" quoteMode={false} />);
    await waitFor(() => expect(apiMock.getActiveRenewalPackImport).toHaveBeenCalled());
    expect(apiMock.getActiveRenewalPackImport).toHaveBeenCalledWith(QUOTE_ID, undefined);
    expect(apiMock.listImportSnapshots).toHaveBeenCalledWith(QUOTE_ID, undefined);
  });

  it('fires both endpoints with { quote: true } when quoteMode is true', async () => {
    defaultMocks();
    render(<DocumentsScreen routeKey="NP_TREATY_DOCUMENTS" quoteMode />);
    await waitFor(() => expect(apiMock.getActiveRenewalPackImport).toHaveBeenCalled());
    expect(apiMock.getActiveRenewalPackImport).toHaveBeenCalledWith(QUOTE_ID, { quote: true });
    expect(apiMock.listImportSnapshots).toHaveBeenCalledWith(QUOTE_ID, { quote: true });
  });
});

describe('DocumentsScreen — Fill button disabled states', () => {
  const FLOWS = [
    { name: 'proportional pricing',     routeKey: 'PROP_TREATY_DOCUMENTS', quoteMode: false },
    { name: 'non-proportional pricing', routeKey: 'NP_TREATY_DOCUMENTS',   quoteMode: false },
    { name: 'renewal',                  routeKey: 'NP_TREATY_DOCUMENTS',   quoteMode: false },
    { name: 'quote',                    routeKey: 'NP_TREATY_DOCUMENTS',   quoteMode: true  },
  ];

  for (const flow of FLOWS) {
    it(`disabled with "Save Treaty Detail first" tooltip when treaty_type_id is null (${flow.name})`, async () => {
      defaultMocks({ treatyTypeId: null });
      render(<DocumentsScreen routeKey={flow.routeKey} quoteMode={flow.quoteMode} />);
      const btn = await screen.findByRole('button', { name: /fill from renewal pack/i });
      expect(btn).toBeDisabled();
      expect(btn).toHaveAttribute('title', 'Save Treaty Detail first');
    });

    it(`disabled with "Import in progress" tooltip when another job is running (${flow.name})`, async () => {
      defaultMocks({
        docs: [rpDoc({ id: 'doc-rp-1' }), rpDoc({ id: 'doc-rp-2', filename: 'other.xlsx' })],
        activeJob: { jobId: 'j-1', documentId: 'doc-rp-other-running', startedAt: new Date().toISOString() },
      });
      render(<DocumentsScreen routeKey={flow.routeKey} quoteMode={flow.quoteMode} />);
      const btns = await screen.findAllByRole('button', { name: /fill from renewal pack/i });
      for (const b of btns) {
        expect(b).toBeDisabled();
        expect(b).toHaveAttribute('title', 'Import in progress');
      }
    });
  }
});

describe('DocumentsScreen — uploaded renewal pack lands on the right entity', () => {
  // contract_document has a CHECK constraint requiring exactly one of
  // (contract_id, quote_id). The endpoint encodes that choice — POSTing to
  // /api/treaties/:id/documents writes the contract_id column, POSTing to
  // /api/quotes/:id/documents writes the quote_id column. From the client
  // side that means the upload's apiOpts decides which relation the pack
  // ends up queryable through.
  const FLOWS = [
    { name: 'proportional pricing',     routeKey: 'PROP_TREATY_DOCUMENTS', quoteMode: false, expected: undefined },
    { name: 'non-proportional pricing', routeKey: 'NP_TREATY_DOCUMENTS',   quoteMode: false, expected: undefined },
    { name: 'renewal',                  routeKey: 'NP_TREATY_DOCUMENTS',   quoteMode: false, expected: undefined },
    { name: 'quote',                    routeKey: 'NP_TREATY_DOCUMENTS',   quoteMode: true,  expected: { quote: true } },
  ];

  for (const flow of FLOWS) {
    it(`uploads to the ${flow.expected ? 'quote' : 'treaty'} endpoint in the ${flow.name} flow`, async () => {
      defaultMocks({ docs: [] });
      apiMock.uploadDocument.mockResolvedValue({ document_id: 'new-doc-1' });

      const { container } = render(<DocumentsScreen routeKey={flow.routeKey} quoteMode={flow.quoteMode} />);
      // Wait for initial load so the upload form is mounted.
      await waitFor(() => expect(apiMock.getDocuments).toHaveBeenCalled());

      // Pick "Renewal Pack" from the document-type select so the test
      // mirrors how the underwriter would upload a renewal pack.
      const docTypeSelect = container.querySelector('select');
      fireEvent.change(docTypeSelect, { target: { value: 'Renewal Pack' } });

      // The file input is hidden; drive it directly to simulate file pick.
      const file = new File(['hello'], 'pack.xlsx', {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const fileInput = container.querySelector('input[type="file"]');
      fireEvent.change(fileInput, { target: { files: [file] } });

      fireEvent.click(screen.getByRole('button', { name: /Upload/i }));

      await waitFor(() => expect(apiMock.uploadDocument).toHaveBeenCalled());
      const [id, formData, opts] = apiMock.uploadDocument.mock.calls[0];
      expect(id).toBe(QUOTE_ID);
      expect(formData).toBeInstanceOf(FormData);
      expect(formData.get('doc_type')).toBe('Renewal Pack');
      expect(opts).toEqual(flow.expected);
    });
  }
});

describe('DocumentsScreen — import success flow', () => {
  it('opens the progress modal, polls until done, and toasts on success (no warnings)', async () => {
    defaultMocks();
    apiMock.importRenewalPack.mockResolvedValue({ jobId: 'job-123' });
    apiMock.getRenewalPackImportJob
      .mockResolvedValueOnce({ status: 'processing' })
      .mockResolvedValueOnce({
        status: 'done',
        filledPages: ['premium_history', 'claims_history'],
        warnings: [],
        unmatchedCresta: [],
        restorePointId: 'snap-1',
      });

    render(<DocumentsScreen routeKey="PROP_TREATY_DOCUMENTS" quoteMode />);
    const btn = await screen.findByRole('button', { name: /fill from renewal pack/i });
    fireEvent.click(btn);

    // Progress modal opens (stage label visible — appears twice: as the
    // active-phase header AND in the phase list).
    await waitFor(() => {
      expect(screen.getByRole('dialog')).toBeInTheDocument();
      expect(screen.getAllByText(/Reading sheets/i).length).toBeGreaterThan(0);
    });

    // After polling settles to "done", the modal closes and the toast fires.
    await waitFor(() => {
      expect(stableToast).toHaveBeenCalledWith(
        expect.stringMatching(/Filled 2 pages from pack\.xlsx/i),
        expect.any(Number),
      );
    }, { timeout: 3500 });
  });

  it('toast with warnings is clickable → opens the warnings drawer', async () => {
    defaultMocks();
    apiMock.importRenewalPack.mockResolvedValue({ jobId: 'job-w' });
    apiMock.getRenewalPackImportJob.mockResolvedValue({
      status: 'done',
      filledPages: ['premium_history'],
      warnings: ['CRESTA zone "Z9" did not resolve'],
      unmatchedCresta: ['Z9'],
      restorePointId: 'snap-w',
    });

    render(<DocumentsScreen routeKey="PROP_TREATY_DOCUMENTS" quoteMode />);
    fireEvent.click(await screen.findByRole('button', { name: /fill from renewal pack/i }));

    await waitFor(() => {
      const call = stableToast.mock.calls.find((c) => /warning/.test(String(c[0])));
      expect(call).toBeTruthy();
      const opts = call[1];
      expect(opts && typeof opts.onClick).toBe('function');
      // Fire the toast's onClick to open the drawer.
      act(() => opts.onClick());
    });

    // Drawer is rendered with the unmatched zones.
    await waitFor(() => {
      expect(screen.getByText(/Import warnings/i)).toBeInTheDocument();
      // "Z9" appears in BOTH the warning text and the CRESTA-zone list
      // entry; both are inside the drawer.
      expect(screen.getAllByText(/Z9/).length).toBeGreaterThan(0);
    });
  });

  it('failed job → error toast, no warnings drawer', async () => {
    defaultMocks();
    apiMock.importRenewalPack.mockResolvedValue({ jobId: 'job-f' });
    apiMock.getRenewalPackImportJob.mockResolvedValue({ status: 'failed', error: 'boom' });

    render(<DocumentsScreen routeKey="PROP_TREATY_DOCUMENTS" quoteMode />);
    fireEvent.click(await screen.findByRole('button', { name: /fill from renewal pack/i }));

    await waitFor(() => {
      const call = stableToast.mock.calls.find((c) => /Import failed/i.test(String(c[0])));
      expect(call).toBeTruthy();
    });
  });
});

describe('DocumentsScreen — Undo affordance', () => {
  it('renders "Imported {date} · Undo" for a restorable snapshot, and hides Undo for restored/expired ones', async () => {
    defaultMocks({
      docs: [rpDoc({ id: 'doc-rp-1' }), rpDoc({ id: 'doc-rp-2', filename: 'old.xlsx' })],
      snapshots: [
        { id: 'snap-a', documentId: 'doc-rp-1', capturedAt: '2026-05-10T10:00:00Z', filename: 'pack.xlsx', filledPages: ['premium_history'], restorable: true, restoredAt: null },
        { id: 'snap-b', documentId: 'doc-rp-2', capturedAt: '2026-05-09T10:00:00Z', filename: 'old.xlsx',  filledPages: ['cresta'],         restorable: false, restoredAt: '2026-05-11T11:11:11Z' },
      ],
    });
    render(<DocumentsScreen routeKey="PROP_TREATY_DOCUMENTS" quoteMode />);
    await screen.findByText(/Imported May 10, 2026/);
    expect(screen.getByRole('button', { name: 'Undo' })).toBeInTheDocument();
    // The other row shows Restored, not Undo.
    expect(screen.getByText(/Restored May 11, 2026/)).toBeInTheDocument();
  });

  it('clicking Undo opens confirmation → restore call → success toast → link gone', async () => {
    defaultMocks({
      snapshots: [
        { id: 'snap-a', documentId: 'doc-rp-1', capturedAt: '2026-05-10T10:00:00Z', filename: 'pack.xlsx', filledPages: ['premium_history'], restorable: true, restoredAt: null },
      ],
    });
    apiMock.restoreImportSnapshot.mockResolvedValue({ ok: true, snapshotId: 'snap-a' });

    render(<DocumentsScreen routeKey="PROP_TREATY_DOCUMENTS" quoteMode />);
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));

    // Confirm dialog visible.
    expect(screen.getByText(/Restore previous state\?/i)).toBeInTheDocument();

    // After restore the listing refresh returns a consumed snapshot.
    apiMock.listImportSnapshots.mockResolvedValue([
      { id: 'snap-a', documentId: 'doc-rp-1', capturedAt: '2026-05-10T10:00:00Z', filename: 'pack.xlsx', filledPages: ['premium_history'], restorable: false, restoredAt: '2026-05-12T10:00:00Z' },
    ]);
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));

    await waitFor(() => {
      expect(apiMock.restoreImportSnapshot).toHaveBeenCalledWith(QUOTE_ID, 'snap-a', { quote: true });
      const call = stableToast.mock.calls.find((c) => /Restored wizard/i.test(String(c[0])));
      expect(call).toBeTruthy();
    });
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
      expect(screen.getByText(/Restored May 12, 2026/)).toBeInTheDocument();
    });
  });

  it('restore returns 410 → toast explaining why, link disappears after refresh', async () => {
    defaultMocks({
      snapshots: [
        { id: 'snap-a', documentId: 'doc-rp-1', capturedAt: '2026-05-10T10:00:00Z', filename: 'pack.xlsx', filledPages: ['premium_history'], restorable: true, restoredAt: null },
      ],
    });
    apiMock.restoreImportSnapshot.mockRejectedValue(new FakeHttpError(410, { code: 'SNAPSHOT_ALREADY_RESTORED' }));
    apiMock.listImportSnapshots.mockResolvedValueOnce(/* initial */ [
      { id: 'snap-a', documentId: 'doc-rp-1', capturedAt: '2026-05-10T10:00:00Z', filename: 'pack.xlsx', filledPages: ['premium_history'], restorable: true, restoredAt: null },
    ]).mockResolvedValueOnce(/* refresh */ [
      { id: 'snap-a', documentId: 'doc-rp-1', capturedAt: '2026-05-10T10:00:00Z', filename: 'pack.xlsx', filledPages: ['premium_history'], restorable: false, restoredAt: '2026-05-12T10:00:00Z' },
    ]);

    render(<DocumentsScreen routeKey="PROP_TREATY_DOCUMENTS" quoteMode />);
    fireEvent.click(await screen.findByRole('button', { name: 'Undo' }));
    fireEvent.click(screen.getByRole('button', { name: 'Restore' }));

    await waitFor(() => {
      const call = stableToast.mock.calls.find((c) => /already been restored|older than 30 days/i.test(String(c[0])));
      expect(call).toBeTruthy();
    });
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument());
  });

  it('snapshot already past retention (restorable=false on initial load) → no Undo link', async () => {
    defaultMocks({
      snapshots: [
        { id: 'snap-old', documentId: 'doc-rp-1', capturedAt: '2025-01-01T00:00:00Z', filename: 'pack.xlsx', filledPages: ['premium_history'], restorable: false, restoredAt: null },
      ],
    });
    render(<DocumentsScreen routeKey="PROP_TREATY_DOCUMENTS" quoteMode />);
    await screen.findByText(/Imported Jan 1, 2025/);
    expect(screen.queryByRole('button', { name: 'Undo' })).not.toBeInTheDocument();
  });
});

// ── Wording analysis — per-row Analyze button + modal ─────────────────────
// The top-level "Wording Analysis" button is gone; analysis is per-row
// and only on slip rows (Final / Draft / Expiring). Clicking opens a
// modal scoped to that specific slip; Escape / backdrop close it.
describe('DocumentsScreen — wording analysis trigger', () => {
  it('renders no Analyze button when there are no documents', async () => {
    defaultMocks({ docs: [] });
    render(<DocumentsScreen routeKey="PROP_TREATY_DOCUMENTS" quoteMode />);
    await waitFor(() => expect(apiMock.getDocuments).toHaveBeenCalled());
    expect(screen.queryByRole('button', { name: /Analyze wording/i })).not.toBeInTheDocument();
  });

  it('renders no Analyze button on a non-slip row (Risk Profiles)', async () => {
    defaultMocks({ docs: [nonSlipDoc()] });
    render(<DocumentsScreen routeKey="PROP_TREATY_DOCUMENTS" quoteMode />);
    await waitFor(() => expect(screen.getByText('risks.pdf')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Analyze wording/i })).not.toBeInTheDocument();
  });

  it('renders exactly one Analyze button on a Final Slip row', async () => {
    defaultMocks({ docs: [slipDoc()] });
    render(<DocumentsScreen routeKey="PROP_TREATY_DOCUMENTS" quoteMode />);
    await waitFor(() => expect(screen.getByText('slip.pdf')).toBeInTheDocument());
    expect(screen.getAllByRole('button', { name: /Analyze wording/i })).toHaveLength(1);
  });

  it('renders one Analyze button per slip row (Final / Draft / Expiring) and none on the non-slip row', async () => {
    defaultMocks({
      docs: [
        slipDoc({ id: 'slip-final',    filename: 'final.pdf',    docType: 'Final Slip' }),
        slipDoc({ id: 'slip-draft',    filename: 'draft.pdf',    docType: 'Draft Slip' }),
        slipDoc({ id: 'slip-expiring', filename: 'expiring.pdf', docType: 'Expiring Slip' }),
        nonSlipDoc({ id: 'non-slip-1', filename: 'risks.pdf' }),
      ],
    });
    render(<DocumentsScreen routeKey="PROP_TREATY_DOCUMENTS" quoteMode />);
    await waitFor(() => expect(screen.getByText('final.pdf')).toBeInTheDocument());
    expect(screen.getAllByRole('button', { name: /Analyze wording/i })).toHaveLength(3);
  });

  it('removes the top-level "Wording Analysis" toggle from the docs list header', async () => {
    defaultMocks({ docs: [slipDoc()] });
    render(<DocumentsScreen routeKey="PROP_TREATY_DOCUMENTS" quoteMode />);
    await waitFor(() => expect(screen.getByText('slip.pdf')).toBeInTheDocument());
    // The old top-level "🔍 Wording Analysis" button is gone — only the
    // row-level "Analyze" button should be present.
    expect(screen.queryByRole('button', { name: /Wording Analysis/i })).not.toBeInTheDocument();
  });

  it('clicking Analyze opens the modal scoped to that slip', async () => {
    defaultMocks({ docs: [slipDoc({ id: 'slip-1', title: 'Final Signed Slip' })] });
    render(<DocumentsScreen routeKey="PROP_TREATY_DOCUMENTS" quoteMode />);
    fireEvent.click(await screen.findByRole('button', { name: /Analyze wording/i }));
    const modal = await screen.findByRole('dialog', { name: 'wording-analysis-modal' });
    expect(modal).toHaveAttribute('data-doc-id', 'slip-1');
    expect(screen.getByText(/Final Slip — Final Signed Slip/)).toBeInTheDocument();
  });

  it('closes the modal via the onClose hook', async () => {
    defaultMocks({ docs: [slipDoc()] });
    render(<DocumentsScreen routeKey="PROP_TREATY_DOCUMENTS" quoteMode />);
    fireEvent.click(await screen.findByRole('button', { name: /Analyze wording/i }));
    await screen.findByRole('dialog', { name: 'wording-analysis-modal' });
    fireEvent.click(screen.getByRole('button', { name: 'close-modal' }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'wording-analysis-modal' })).not.toBeInTheDocument());
  });
});

// ── Slip View opens in a new tab ──────────────────────────────────────────
// Slip rows are the only place we redirect View to window.open. Non-slip
// viewable docs keep the old inline preview modal.
describe('DocumentsScreen — slip View opens in a new tab', () => {
  let openSpy;
  beforeEach(() => {
    openSpy = vi.spyOn(window, 'open').mockImplementation(() => null);
  });
  afterEach(() => {
    openSpy.mockRestore();
  });

  it('opens the slip view URL in a new tab and does NOT open the inline preview', async () => {
    defaultMocks({ docs: [slipDoc({ id: 'slip-1' })] });
    render(<DocumentsScreen routeKey="PROP_TREATY_DOCUMENTS" quoteMode />);
    await waitFor(() => expect(screen.getByText('slip.pdf')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'View' }));

    expect(openSpy).toHaveBeenCalledWith('/view', '_blank', 'noopener,noreferrer');
    // The inline preview modal would render a "✕ Close" button — its
    // absence confirms we routed to a new tab instead.
    expect(screen.queryByRole('button', { name: /Close/i })).not.toBeInTheDocument();
  });

  it('non-slip viewable docs (Risk Profiles PDF) open the inline modal instead', async () => {
    defaultMocks({ docs: [nonSlipDoc()] });
    render(<DocumentsScreen routeKey="PROP_TREATY_DOCUMENTS" quoteMode />);
    await waitFor(() => expect(screen.getByText('risks.pdf')).toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: 'View' }));

    expect(openSpy).not.toHaveBeenCalled();
    // The inline preview chrome surfaces a "↓ Download" link + "✕ Close"
    // button — proof the modal opened.
    expect(screen.getByRole('button', { name: /Close/i })).toBeInTheDocument();
  });
});

// ── Theme tokens — no hardcoded slate/green literals leak into the DOM ────
describe('DocumentsScreen — theme tokens drive page chrome', () => {
  it('no hardcoded slate/green rgba literals remain in the rendered DOM', async () => {
    defaultMocks({ docs: [slipDoc(), nonSlipDoc()] });
    const { container } = render(<DocumentsScreen routeKey="PROP_TREATY_DOCUMENTS" quoteMode />);
    await waitFor(() => expect(screen.getByText('slip.pdf')).toBeInTheDocument());

    // These literals were the hardcoded slate/green palette before the
    // theme-token migration. If any leaked through they'd show up here
    // as inline-style strings on rendered elements.
    const html = container.innerHTML;
    expect(html).not.toMatch(/rgba\(34,\s*197,\s*94/);  // hardcoded emerald-500
    expect(html).not.toMatch(/rgba\(2,\s*6,\s*23/);     // hardcoded slate-950
    expect(html).not.toMatch(/rgba\(148,\s*163,\s*184/); // hardcoded slate-400
    expect(html).not.toMatch(/rgba\(226,\s*232,\s*240/); // hardcoded slate-200
  });
});
