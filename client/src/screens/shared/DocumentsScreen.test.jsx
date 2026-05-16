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
function slipDoc({ id = 'doc-slip-1', filename = 'slip.pdf' } = {}) {
  return {
    document_id: id,
    file_name: filename,
    doc_type: 'Final Slip',
    title: 'Slip title',
    size_bytes: 9999,
    mime_type: 'application/pdf',
    uploaded_at: '2026-05-02T12:00:00.000Z',
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

  it('does not show the Fill button in contract mode (only quoteMode)', async () => {
    defaultMocks({ docs: [rpDoc()] });
    render(<DocumentsScreen routeKey="PROP_TREATY_DOCUMENTS" quoteMode={false} />);
    await waitFor(() => expect(screen.getByText('pack.xlsx')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /fill from renewal pack/i })).not.toBeInTheDocument();
  });
});

describe('DocumentsScreen — Fill button disabled states', () => {
  it('disabled with "Save Treaty Detail first" tooltip when treaty_type_id is null', async () => {
    defaultMocks({ treatyTypeId: null });
    render(<DocumentsScreen routeKey="PROP_TREATY_DOCUMENTS" quoteMode />);
    const btn = await screen.findByRole('button', { name: /fill from renewal pack/i });
    expect(btn).toBeDisabled();
    expect(btn).toHaveAttribute('title', 'Save Treaty Detail first');
  });

  it('disabled with "Import in progress" tooltip when another job is running', async () => {
    defaultMocks({
      docs: [rpDoc({ id: 'doc-rp-1' }), rpDoc({ id: 'doc-rp-2', filename: 'other.xlsx' })],
      activeJob: { jobId: 'j-1', documentId: 'doc-rp-other-running', startedAt: new Date().toISOString() },
    });
    render(<DocumentsScreen routeKey="PROP_TREATY_DOCUMENTS" quoteMode />);
    const btns = await screen.findAllByRole('button', { name: /fill from renewal pack/i });
    for (const b of btns) {
      expect(b).toBeDisabled();
      expect(b).toHaveAttribute('title', 'Import in progress');
    }
  });
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
      expect(apiMock.restoreImportSnapshot).toHaveBeenCalledWith(QUOTE_ID, 'snap-a');
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
