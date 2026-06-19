// src/screens/shared/DocumentsScreen.jsx
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { api } from '../../api';
import WordingAnalysisModal from './WordingAnalysisModal';
import { useContractId } from '../../hooks/useContractId';
import { useGlobalToast } from '../../hooks/useToast';
import WizardLayout from '../../components/WizardLayout';
import ImportProgressModal from '../../components/ImportProgressModal';
import WarningsDrawer from '../../components/WarningsDrawer';
import RestoreImportConfirm from '../../components/RestoreImportConfirm';

const DOC_TYPES = [
  'Final Slip','Draft Slip','Expiring Slip','Renewal Pack',
  'Large Loss List','Risk Profiles','Claims Profile',
  'Presentation','CAT Modelling','Bordereaux','Accounts','Other',
];

// Priority order for wording analysis / checklist
const WORDING_PRIORITY = ['Final Slip','Draft Slip','Expiring Slip'];

const VIEWABLE  = new Set(['application/pdf','image/png','image/jpeg','image/gif','image/webp','text/plain','text/csv']);
const isViewable = m => VIEWABLE.has(m) || (m||'').startsWith('image/');

// The upload form uses display-cased 'Renewal Pack' but the server's
// import endpoint accepts either form. Normalise here so the action
// shows up whether the row came in via the new convention or the old.
function isRenewalPack(d) {
  return String(d?.doc_type || '').toLowerCase().replace(/\s+/g, '_') === 'renewal_pack';
}

const IMPORT_POLL_MS = 2_000;

// Default title suggestion based on doc type
function defaultTitle(docType) {
  const map = {
    'Final Slip': 'Final Signed Slip',
    'Draft Slip': 'Draft Slip',
    'Expiring Slip': 'Expiring Slip',
    'Renewal Pack': 'Renewal Pack',
    'Large Loss List': 'Large Loss Schedule',
    'Risk Profiles': 'Risk Profile',
    'Claims Profile': 'Claims Profile',
    'Presentation': 'Treaty Presentation',
    'CAT Modelling': 'CAT Model Output',
    'Bordereaux': 'Bordereaux',
    'Accounts': 'Accounts',
    'Other': '',
  };
  return map[docType] || '';
}

function describeDocumentError(error, fallback) {
  const code = error?.body?.code || error?.code;
  if (code === 'READ_ONLY') return 'Only the current assignee can change this document. Ask for the treaty or quote to be assigned to you.';
  if (code === 'FORBIDDEN') return 'You do not have access to this document. Ask the assignee or a supervisor for access.';
  if (code === 'CSRF_FAILED') return 'Your session security token expired. Refresh the page and try again.';
  return `${fallback}: ${error?.message || error || 'Unknown error'}`;
}

export default function DocumentsScreen({ routeKey, headerPill, quoteMode = false }) {
  const contractId = useContractId();
  const showToast = useGlobalToast();
  const [docs,        setDocs]        = useState([]);
  const [uploading,   setUploading]   = useState(false);
  const [docType,     setDocType]     = useState('Final Slip');
  const [title,       setTitle]       = useState(defaultTitle('Final Slip'));
  const [description, setDescription] = useState('');
  const [dragOver,    setDragOver]    = useState(false);
  const [preview,     setPreview]     = useState(null);
  const [analyzing,   setAnalyzing]   = useState(null); // { docId, doc } | null
  const [parentId,    setParentId]    = useState(null);
  const [dragFile,    setDragFile]    = useState(null); // file from drag — no hidden input needed
  const [loadError,   setLoadError]   = useState('');
  const [loadingDocs, setLoadingDocs] = useState(false);
  const fileRef = useRef(null);

  // ── Renewal-pack import state ─────────────────────────────────────────────
  // The Fill button is gated on:
  //   • the row being a renewal_pack document (rendered conditionally),
  //   • the entity's treaty detail being saved (treaty_type_id present),
  //   • no other import currently in flight for this entity.
  // We load the entity once for the treaty check and poll for the
  // active job + snapshots list on mount + after each import completes.
  const [treatyDetailSaved, setTreatyDetailSaved] = useState(false);
  const [activeJob, setActiveJob] = useState(null); // { jobId, documentId, startedAt } | null
  const [snapshotsByDocId, setSnapshotsByDocId] = useState({}); // docId → most-recent snapshot
  const [importingFor, setImportingFor] = useState(null); // { documentId, filename } when modal is open
  const [drawer, setDrawer] = useState(null); // { warnings, unmatchedCresta } | null
  const [restoring, setRestoring] = useState(null); // { snapshotId, documentId } | null
  const [restoreBusy, setRestoreBusy] = useState(false);

  const apiOpts = useMemo(() => (quoteMode ? { quote: true } : undefined), [quoteMode]);

  const load = useCallback(async () => {
    if (!contractId) return;
    setLoadingDocs(true);
    try {
      const d = await api.getDocuments(contractId, apiOpts);
      setDocs(Array.isArray(d) ? d : []);
      setLoadError('');
      if (!quoteMode) {
        try {
          const c = await api.getContract(contractId);
          setParentId(c?.header?.parent_contract_id || null);
        } catch (e) { console.warn('[DocumentsScreen] getContract failed:', e?.message); }
      }
    } catch (e) {
      const msg = describeDocumentError(e, 'Could not load documents');
      setLoadError(msg);
      showToast(msg, 5000);
      console.error('[DocumentsScreen] getDocuments failed:', e);
    } finally {
      setLoadingDocs(false);
    }
  }, [apiOpts, contractId, quoteMode, showToast]);

  useEffect(() => { load(); }, [load]);

  // Load import-related state. Renewal-pack import now exists on both
  // entity sides — getContract, getActiveRenewalPackImport and
  // listImportSnapshots all route through apiOpts to the right
  // /api/treaties/... or /api/quotes/... endpoint family.
  const loadImportState = useCallback(async () => {
    if (!contractId) return;
    try {
      const [q, active, snapshots] = await Promise.all([
        api.getContract(contractId, apiOpts),
        api.getActiveRenewalPackImport(contractId, apiOpts).catch(() => ({ activeJob: null })),
        api.listImportSnapshots(contractId, apiOpts).catch(() => []),
      ]);
      setTreatyDetailSaved(!!q?.header?.treaty_type_id);
      setActiveJob(active?.activeJob || null);
      const byDoc = {};
      for (const snap of Array.isArray(snapshots) ? snapshots : []) {
        if (!snap.documentId) continue;
        // listImportSnapshots returns newest first; keep the first hit per doc.
        if (!byDoc[snap.documentId]) byDoc[snap.documentId] = snap;
      }
      setSnapshotsByDocId(byDoc);
    } catch (e) {
      console.warn('[DocumentsScreen] loadImportState failed:', e?.message);
    }
  }, [apiOpts, contractId]);

  useEffect(() => { loadImportState(); }, [loadImportState]);

  // While we own the active job (we just kicked it off), poll every
  // IMPORT_POLL_MS until terminal. setImmediate-driven job means it
  // usually flips within a few seconds; the poll cap protects us
  // against a hung server.
  useEffect(() => {
    if (!importingFor || !activeJob?.jobId) return undefined;
    let cancelled = false;
    const tick = async () => {
      try {
        const res = await api.getRenewalPackImportJob(contractId, activeJob.jobId, apiOpts);
        if (cancelled) return;
        if (res.status === 'done') {
          finishImportSuccess(res);
        } else if (res.status === 'failed') {
          finishImportFailure(res.error || 'Import failed');
        }
      } catch (e) {
        if (!cancelled) finishImportFailure(e?.message || 'Import job poll failed');
      }
    };
    tick(); // immediate first poll — done jobs usually finish in <1s
    const handle = setInterval(tick, IMPORT_POLL_MS);
    return () => { cancelled = true; clearInterval(handle); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [importingFor, activeJob?.jobId, contractId, apiOpts]);

  const finishImportSuccess = useCallback((res) => {
    const filename = importingFor?.filename || 'pack';
    const filled = Array.isArray(res.filledPages) ? res.filledPages : [];
    const warnings = Array.isArray(res.warnings) ? res.warnings : [];
    const unmatched = Array.isArray(res.unmatchedCresta) ? res.unmatchedCresta : [];
    const hasIssues = warnings.length + unmatched.length > 0;
    setImportingFor(null);
    setActiveJob(null);
    loadImportState();

    if (hasIssues) {
      const total = warnings.length + unmatched.length;
      showToast(
        `Filled ${filled.length} pages from ${filename} with ${total} warning${total === 1 ? '' : 's'} — tap to view.`,
        { duration: 6000, onClick: () => setDrawer({ warnings, unmatchedCresta: unmatched }) },
      );
    } else {
      showToast(
        `Filled ${filled.length} pages from ${filename}. Review and adjust in the wizard.`,
        4000,
      );
    }
  }, [importingFor, loadImportState, showToast]);

  const finishImportFailure = useCallback((msg) => {
    setImportingFor(null);
    setActiveJob(null);
    showToast(`Import failed: ${msg}`, 5000);
    loadImportState();
  }, [loadImportState, showToast]);

  const startImport = useCallback(async (doc) => {
    if (!contractId) return;
    const docId = doc.document_id || doc.id;
    setImportingFor({ documentId: docId, filename: doc.file_name || doc.name || 'pack' });
    try {
      const res = await api.importRenewalPack(contractId, docId, apiOpts);
      setActiveJob({ jobId: res.jobId, documentId: docId, startedAt: new Date().toISOString() });
    } catch (e) {
      const code = e?.body?.code || e?.code;
      const msg = code === 'NOT_RENEWAL_PACK' ? 'Document is not a renewal pack'
        : code === 'TREATY_DETAIL_REQUIRED' ? 'Save Treaty Detail first'
        : code === 'IMPORT_IN_PROGRESS' ? 'An import is already in progress'
        : code === 'DOCUMENT_OWNER_MISMATCH' ? 'This document is attached to a different entity — reload the page'
        : (e?.message || 'Could not start import');
      setImportingFor(null);
      showToast(msg, 5000);
      // Refresh in-progress state so the UI catches up if there was a race.
      loadImportState();
    }
  }, [apiOpts, contractId, loadImportState, showToast]);

  const handleDocTypeChange = (t) => {
    setDocType(t);
    setTitle(defaultTitle(t));
  };

  const doUpload = async (file) => {
    if (!file || !contractId) return;
    setUploading(true);
    try {
      const fd = new FormData();
      fd.append('file', file);
      fd.append('doc_type', docType);
      fd.append('title', title || defaultTitle(docType) || file.name);
      if (description) fd.append('description', description);
      await api.uploadDocument(contractId, fd, apiOpts);
      setTitle(defaultTitle(docType));
      setDescription('');
      setDragFile(null);
      if (fileRef.current) fileRef.current.value = '';
      await load();
    } catch (e) { showToast('Upload failed: ' + (e.message || e)); }
    finally { setUploading(false); }
  };

  const handleDrop = (e) => {
    e.preventDefault(); setDragOver(false);
    const file = e.dataTransfer?.files?.[0];
    if (file) {
      setDragFile(file);
      // Auto-set title from filename if blank
      if (!title) setTitle(file.name.replace(/\.[^.]+$/, ''));
    }
  };

  const handleFileSelect = (e) => {
    const file = e.target.files?.[0];
    if (file) {
      setDragFile(file);
      if (!title || title === defaultTitle(docType)) setTitle(file.name.replace(/\.[^.]+$/, ''));
    }
  };

  const handleUploadClick = () => {
    const file = dragFile || fileRef.current?.files?.[0];
    if (!file) { showToast('Select or drop a file first.'); return; }
    doUpload(file);
  };

  const del = async (docId) => {
    if (!confirm('Delete this document?')) return;
    try {
      await api.deleteDocument(docId);
      showToast('Document deleted.', 3000);
      await load();
    } catch (e) {
      showToast(describeDocumentError(e, 'Delete failed'), 6000);
    }
  };

  const openPreview = (d) => {
    const docId = d.document_id || d.id;
    const mime = d.mime_type || '';
    const isSlip = WORDING_PRIORITY.includes(d.doc_type);
    if (isSlip && isViewable(mime)) {
      // Slips open in a new tab so the underwriter can keep the PDF
      // side-by-side with the wording-analysis modal.
      window.open(api.getDocumentViewUrl(docId), '_blank', 'noopener,noreferrer');
      return;
    }
    if (isViewable(mime)) setPreview({ url: api.getDocumentViewUrl(docId), mime, name: d.file_name || d.name || 'Document' });
    else window.open(api.getDocumentDownloadUrl(docId), '_blank');
  };

  // ── Restore (Undo) handlers ───────────────────────────────────────────────
  const confirmRestore = useCallback(async () => {
    if (!restoring) return;
    setRestoreBusy(true);
    try {
      await api.restoreImportSnapshot(contractId, restoring.snapshotId, apiOpts);
      showToast('Restored wizard to pre-import state.', 4000);
      setRestoring(null);
      await loadImportState();
    } catch (e) {
      const status = e?.status;
      const code = e?.body?.code;
      if (status === 410 || code === 'SNAPSHOT_ALREADY_RESTORED' || code === 'SNAPSHOT_EXPIRED') {
        showToast('This import has already been restored, or is older than 30 days.', 5000);
        setRestoring(null);
        await loadImportState(); // refresh so the now-stale link disappears
      } else {
        showToast(`Restore failed: ${e?.message || e}`, 5000);
      }
    } finally {
      setRestoreBusy(false);
    }
  }, [apiOpts, contractId, restoring, loadImportState, showToast]);

  const fmtSize = (b) => !b ? '–' : b < 1024 ? b+'B' : b < 1048576 ? Math.round(b/1024)+'KB' : (b/1048576).toFixed(1)+'MB';
  const fmtDate = (iso) => iso ? new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }) : '';

  // Styles — theme-token driven so the page reskins across all five
  // <html data-theme> palettes. Accent literals route through
  // var(--accent-rgb) / var(--accent-blue-rgb) / var(--accent-rose-rgb)
  // so transparencies survive theme swaps.
  const card      = { borderRadius: 18, border: '1px solid var(--hairline)', background: 'var(--surface-2)', padding: '14px 18px', marginBottom: 16 };
  const dropzone  = { ...card, border: `1px dashed ${dragOver ? 'rgba(var(--accent-rgb), 0.60)' : 'var(--stroke-soft)'}`, background: dragOver ? 'rgba(var(--accent-rgb), 0.06)' : 'var(--surface-muted)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 14, transition: 'all .15s' };
  const greenBtn  = { borderRadius: 999, padding: '10px 18px', border: '1px solid rgba(var(--accent-rgb), 0.75)', background: 'linear-gradient(180deg, rgba(var(--accent-rgb), 0.88), rgba(var(--accent2-rgb), 0.78))', color: 'var(--accent-contrast)', fontWeight: 900, letterSpacing: '.05em', cursor: 'pointer', fontSize: 13 };
  const lbl       = { color: 'var(--muted)', fontSize: 10, fontWeight: 800, letterSpacing: '.10em', textTransform: 'uppercase', marginBottom: 4 };
  const inp       = { width: '100%', borderRadius: 999, border: '1px solid var(--stroke-soft)', background: 'var(--control-bg)', color: 'var(--text)', padding: '8px 14px', outline: 'none', fontSize: 12, boxSizing: 'border-box' };
  const sel       = { ...inp, appearance: 'none', WebkitAppearance: 'none', paddingRight: 28 };
  const smBtn     = { borderRadius: 999, padding: '6px 14px', border: '1px solid var(--stroke-soft)', background: 'var(--control-bg)', color: 'var(--text)', fontWeight: 800, fontSize: 12, cursor: 'pointer' };
  const fillBtn   = { ...smBtn, borderColor: 'rgba(var(--accent-rgb), 0.50)', color: 'var(--accent)', background: 'rgba(var(--accent-rgb), 0.06)' };
  const fillBtnDisabled = { ...fillBtn, opacity: 0.45, cursor: 'not-allowed' };
  const statChipStyle = (accent) => ({ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '5px 9px', borderRadius: 999, border: `1px solid ${accent ? 'rgba(var(--accent-rgb), 0.35)' : 'var(--stroke-soft)'}`, background: accent ? 'rgba(var(--accent-rgb), 0.07)' : 'var(--surface-muted)', color: accent ? 'var(--accent)' : 'var(--muted)', fontSize: 11, fontWeight: 800 });
  const statChipValue = { color: 'var(--text)', fontVariantNumeric: 'tabular-nums' };
  const headerBadge = { display: 'inline-flex', alignItems: 'center', gap: 8, padding: '6px 12px', borderRadius: 999, background: 'var(--surface-muted)', border: '1px solid var(--stroke-soft)', marginBottom: 6 };
  const headerDot = { width: 8, height: 8, borderRadius: 999, background: 'var(--accent)', boxShadow: '0 0 0 4px rgba(var(--accent-rgb), 0.10)' };
  const headerText = { fontSize: 11, fontWeight: 800, letterSpacing: '.10em', textTransform: 'uppercase', color: 'var(--text)' };
  const metaLine = { fontSize: 12, color: 'var(--muted)', marginBottom: 16, marginTop: 4 };
  const metaLabel = { fontWeight: 700 };
  const metaId = { fontFamily: 'var(--font-mono)', opacity: 0.8 };
  const statRow = { display: 'flex', flexWrap: 'wrap', gap: 8, marginBottom: 16 };
  const alertBox = { display: 'flex', alignItems: 'flex-start', gap: 10, borderRadius: 14, border: '1px solid rgba(var(--accent-rose-rgb), 0.40)', background: 'rgba(var(--accent-rose-rgb), 0.08)', color: 'var(--text)', padding: '10px 12px', marginBottom: 16, fontSize: 12, fontWeight: 700 };
  const alertIcon = { width: 20, height: 20, borderRadius: 999, display: 'grid', placeItems: 'center', flexShrink: 0, background: 'rgba(var(--accent-rose-rgb), 0.14)', color: 'var(--accent-rose)' };
  const dropContent = { display: 'flex', gap: 12, alignItems: 'flex-start' };
  const dropIcon = { width: 50, height: 50, borderRadius: 16, display: 'grid', placeItems: 'center', border: '1px solid rgba(var(--accent-rgb), 0.35)', background: 'radial-gradient(circle at 30% 30%, rgba(var(--accent-rgb), 0.35), var(--surface-muted))', boxShadow: '0 0 26px rgba(var(--accent-rgb), 0.18)', flexShrink: 0 };
  const dropTitle = { fontWeight: 800, fontSize: 13, color: 'var(--text)' };
  const dropOr = { opacity: 0.65 };
  const browseButton = { appearance: 'none', border: 0, background: 'transparent', padding: 0, color: 'var(--accent)', fontWeight: 900, cursor: 'pointer', font: 'inherit' };
  const dropHint = { marginTop: 4, color: 'var(--muted-2)', fontSize: 12 };
  const hiddenFile = { display: 'none' };
  const uploadForm = { ...card, border: '1px dashed var(--stroke-soft)', background: 'var(--surface-muted)', marginTop: 16, display: 'grid', gridTemplateColumns: '160px 1fr 1.5fr auto', gap: 12, alignItems: 'end' };
  const selectWrap = { position: 'relative' };
  const selectChevron = { position: 'absolute', right: 10, top: '50%', transform: 'translateY(-50%)', pointerEvents: 'none', opacity: 0.5, fontSize: 10 };
  const uploadActions = { display: 'flex', flexDirection: 'column', gap: 6 };
  const selectedFile = { fontSize: 11, color: 'var(--accent)', fontWeight: 700, padding: '4px 10px', borderRadius: 8, background: 'rgba(var(--accent-rgb), 0.08)', border: '1px solid rgba(var(--accent-rgb), 0.25)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', maxWidth: 180 };
  const uploadBtn = { ...greenBtn, padding: '8px 16px', fontSize: 12, opacity: uploading ? 0.6 : 1 };
  const uploadNote = { gridColumn: '1 / -1', fontSize: 11, color: 'var(--muted-2)', marginTop: -4 };
  const docsCard = { ...card, marginTop: 16 };
  const docsHeader = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10, gap: 10 };
  const docsTitle = { fontWeight: 900, fontSize: 14, color: 'var(--text)' };
  const docsActions = { display: 'flex', gap: 8, alignItems: 'center' };
  const emptyState = { borderRadius: 16, border: '1px dashed var(--stroke-soft)', background: 'var(--surface-muted)', color: 'var(--muted)', fontSize: 13, padding: '22px', display: 'grid', gap: 8, justifyItems: 'center', textAlign: 'center' };
  const emptyIcon = { width: 42, height: 42, borderRadius: 14, display: 'grid', placeItems: 'center', border: '1px solid rgba(var(--accent-rgb), 0.25)', background: 'rgba(var(--accent-rgb), 0.06)', color: 'var(--accent)', fontWeight: 900 };
  const emptyTitle = { fontWeight: 900, color: 'var(--text)' };
  const emptyCopy = { maxWidth: 460, color: 'var(--muted-2)' };
  const tableStyle = { width: '100%', borderCollapse: 'collapse', fontSize: 12 };
  const tableHeadRow = { borderBottom: '1px solid var(--hairline)', color: 'var(--text-subtle)', fontSize: 10, letterSpacing: '.14em', textTransform: 'uppercase' };
  const thLeft = { textAlign: 'left', padding: '8px 4px' };
  const thRight = { textAlign: 'right', padding: '8px 4px' };
  const rowStyle = (isWording) => ({ borderBottom: '1px solid var(--hairline)', background: isWording ? 'rgba(var(--accent-rgb), 0.03)' : 'transparent' });
  const fileCell = { padding: '10px 4px', fontWeight: 700, color: 'var(--text)' };
  const fileLink = { cursor: 'pointer', textDecoration: 'underline', textDecorationColor: 'var(--stroke-soft)' };
  const descriptionText = { marginTop: 2, fontSize: 11, color: 'var(--muted-2)', fontWeight: 400 };
  const importMeta = { marginTop: 4, fontSize: 11, color: 'var(--muted)', fontWeight: 500 };
  const undoBtn = { background: 'none', border: 'none', padding: 0, fontFamily: 'inherit', fontSize: 11, color: 'var(--accent-blue)', textDecoration: 'underline', cursor: 'pointer' };
  const typeCell = { padding: '10px 4px' };
  const typeBadge = (isWording) => ({ display: 'inline-flex', padding: '3px 9px', borderRadius: 999, border: `1px solid ${isWording ? 'rgba(var(--accent-rgb), 0.35)' : 'var(--stroke-soft)'}`, background: isWording ? 'rgba(var(--accent-rgb), 0.08)' : 'var(--control-bg)', fontSize: 11, fontWeight: 800, color: isWording ? 'var(--accent)' : 'inherit' });
  const mutedCell = { padding: '10px 4px', color: 'var(--muted)' };
  const actionsCell = { padding: '10px 4px', textAlign: 'right', display: 'flex', justifyContent: 'flex-end', gap: 6, flexWrap: 'wrap' };
  const analyzeBtn = { ...smBtn, borderColor: 'rgba(var(--accent-rgb), 0.40)', color: 'var(--accent)', background: 'rgba(var(--accent-rgb), 0.06)' };
  const viewBtn = { ...smBtn, borderColor: 'rgba(var(--accent-rgb), 0.35)', color: 'var(--accent)' };
  const downloadBtn = { ...smBtn, display: 'inline-flex', alignItems: 'center', borderColor: 'rgba(var(--accent-blue-rgb), 0.35)', color: 'var(--accent-blue)', textDecoration: 'none' };
  const deleteBtn = { ...smBtn, borderColor: 'rgba(var(--accent-rose-rgb), 0.35)', color: 'var(--accent-rose)' };
  const previewBackdrop = { position: 'fixed', inset: 0, zIndex: 9999, background: 'rgba(0,0,0,0.85)', display: 'flex', flexDirection: 'column', alignItems: 'stretch', justifyContent: 'stretch' };
  const previewHeader = { display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '12px 20px', background: 'var(--surface-elevated)', borderBottom: '1px solid var(--hairline-strong)' };
  const previewTitle = { color: 'var(--text)', fontWeight: 800, fontSize: 14 };
  const previewActions = { display: 'flex', gap: 10 };
  const previewDownload = { ...smBtn, borderColor: 'rgba(var(--accent-blue-rgb), 0.40)', color: 'var(--accent-blue)', fontSize: 12, textDecoration: 'none' };
  const previewClose = { ...smBtn, borderColor: 'rgba(var(--accent-rose-rgb), 0.40)', color: 'var(--accent-rose)', fontSize: 12 };
  const previewBody = { flex: 1, overflow: 'auto', display: 'flex', justifyContent: 'center', alignItems: 'flex-start', padding: 20 };
  const previewFrame = { width: '100%', height: '100%', border: 'none', borderRadius: 8, background: '#fff', minHeight: '80vh' };
  const previewImage = { maxWidth: '100%', maxHeight: '85vh', borderRadius: 8, objectFit: 'contain' };

  const currentFile = dragFile || (fileRef.current?.files?.[0]);
  const entityLabel = quoteMode ? 'Quote' : 'Treaty';
  const renewalPackCount = docs.filter(isRenewalPack).length;
  const wordingCount = docs.filter((d) => WORDING_PRIORITY.includes(d.doc_type)).length;
  const statChip = (label, value, accent = false) => (
    <span style={statChipStyle(accent)}>
      <span style={statChipValue}>{value}</span>{label}
    </span>
  );

  return (
    // uploads are fire-and-forget — no onBeforeNext needed
    <WizardLayout routeKey={routeKey} title="Documents" headerPill={headerPill}>
      {() => (
        <div>
          {/* Header */}
          <div style={headerBadge}>
            <span style={headerDot}/>
            <span style={headerText}>Files for {entityLabel}</span>
          </div>
          <div style={metaLine}>
            <span style={metaLabel}>{entityLabel.toUpperCase()} ID:</span>{' '}<span style={metaId}>{contractId||'—'}</span>
          </div>
          <div style={statRow}>
            {statChip('documents', docs.length, docs.length > 0)}
            {statChip('renewal packs', renewalPackCount)}
            {statChip('wording slips', wordingCount)}
            {loadingDocs && statChip('loading', '...', true)}
          </div>

          {loadError && (
            <div role="alert" style={alertBox}>
              <span style={alertIcon}>!</span>
              <span>{loadError}</span>
            </div>
          )}

          {/* Dropzone */}
          {/* Drag-and-drop is a pointer-only convenience — keyboard users attach via the "+ Select Files" / browse buttons below. */}
          <div style={dropzone} role="presentation" onDragOver={e=>{e.preventDefault();setDragOver(true);}} onDragLeave={()=>setDragOver(false)} onDrop={handleDrop}>
            <div style={dropContent}>
              <div style={dropIcon}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
              </div>
              <div>
                <div style={dropTitle}>
                  Drag & drop files here <span style={dropOr}>or</span>{' '}
                  <button
                    type="button" style={browseButton}
                    onClick={()=>fileRef.current?.click()}
                    onKeyDown={e=>{ if (e.key==='Enter'||e.key===' ') { e.preventDefault(); fileRef.current?.click(); } }}
                  >browse</button>
                </div>
                <div style={dropHint}>Attach treaties, slips, wordings, accounts and bordereaux.</div>
                <div style={dropHint}>PDF, XLSX, DOCX, CSV up to 50MB each.</div>
              </div>
            </div>
            <button style={greenBtn} onClick={()=>fileRef.current?.click()}>+ Select Files</button>
          </div>

          {/* Hidden file input */}
          <input type="file" ref={fileRef} onChange={handleFileSelect} style={hiddenFile}
            accept=".pdf,.xlsx,.xls,.docx,.doc,.csv,.txt,.png,.jpg,.jpeg" />

          {/* Upload form */}
          <div style={uploadForm}>
            <div>
              <div style={lbl}>Document Type</div>
              <div style={selectWrap}>
                <select style={sel} value={docType} onChange={e=>handleDocTypeChange(e.target.value)}>
                  {DOC_TYPES.map(t=><option key={t} value={t}>{t}</option>)}
                </select>
                <span style={selectChevron}>▾</span>
              </div>
            </div>
            <div>
              <div style={lbl}>Document Title</div>
              <input style={inp} placeholder="e.g. Final signed slip" value={title} onChange={e=>setTitle(e.target.value)} />
            </div>
            <div>
              <div style={lbl}>Description (Optional)</div>
              <input style={inp} placeholder="Notes…" value={description} onChange={e=>setDescription(e.target.value)} />
            </div>
            <div style={uploadActions}>
              {currentFile && (
                <div style={selectedFile}>
                  📎 {currentFile.name}
                </div>
              )}
              <button style={uploadBtn} onClick={handleUploadClick} disabled={uploading}>
                {uploading ? '⟳ Uploading…' : '↑ Upload'}
              </button>
            </div>
            <div style={uploadNote}>
              Uploaded files are stored on the server and linked to this treaty.
            </div>
          </div>

          {/* Uploaded Documents */}
          <div style={docsCard}>
            <div style={docsHeader}>
              <div style={docsTitle}>Uploaded Documents</div>
              <div style={docsActions}>
                <button style={smBtn} onClick={load}>↻ Reload</button>
              </div>
            </div>

            {docs.length === 0 ? (
              <div style={emptyState}>
                <div style={emptyIcon}>0</div>
                <div style={emptyTitle}>{loadingDocs ? 'Loading documents...' : 'No documents uploaded yet'}</div>
                <div style={emptyCopy}>Drop a slip, wording, renewal pack, account, or bordereaux above to keep this {entityLabel.toLowerCase()} file set complete and review-ready.</div>
              </div>
            ) : (
              <table style={tableStyle}>
                <thead>
                  <tr style={tableHeadRow}>
                    <th style={thLeft}>File</th>
                    <th style={thLeft}>Type</th>
                    <th style={thLeft}>Title</th>
                    <th style={thLeft}>Size</th>
                    <th style={thLeft}>Uploaded</th>
                    <th style={thRight}>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {docs.map(d => {
                    const docId = d.document_id || d.id;
                    const isWording = WORDING_PRIORITY.includes(d.doc_type);
                    const isRP = isRenewalPack(d);
                    const snapshot = isRP ? snapshotsByDocId[docId] : null;
                    const otherImportRunning = !!(activeJob && activeJob.documentId !== docId);
                    const thisImportRunning = !!(activeJob && activeJob.documentId === docId);
                    const fillDisabled = !treatyDetailSaved || !!activeJob;
                    const fillTitle = !treatyDetailSaved
                      ? 'Save Treaty Detail first'
                      : (otherImportRunning || thisImportRunning)
                        ? 'Import in progress'
                        : 'Fill the remaining wizard pages from this renewal pack';
                    return (
                      <tr key={docId} style={rowStyle(isWording)}>
                        <td style={fileCell}>
                          <span
                            role="button" tabIndex={0} style={fileLink}
                            onClick={()=>openPreview(d)}
                            onKeyDown={e=>{ if (e.key==='Enter'||e.key===' ') { e.preventDefault(); openPreview(d); } }}
                          >
                            {d.file_name||d.name||'–'}
                          </span>
                          {d.description && <div style={descriptionText}>{d.description}</div>}
                          {isRP && snapshot && (
                            <div style={importMeta}>
                              Imported {fmtDate(snapshot.capturedAt)}
                              {snapshot.restorable && (
                                <>
                                  {' · '}
                                  <button
                                    type="button"
                                    onClick={() => setRestoring({ snapshotId: snapshot.id, documentId: docId })}
                                    style={undoBtn}
                                  >
                                    Undo
                                  </button>
                                </>
                              )}
                              {!snapshot.restorable && snapshot.restoredAt && (
                                <> {' · '} Restored {fmtDate(snapshot.restoredAt)}</>
                              )}
                            </div>
                          )}
                        </td>
                        <td style={typeCell}>
                          <span style={typeBadge(isWording)}>
                            {d.doc_type||'–'}
                          </span>
                        </td>
                        <td style={mutedCell}>{d.title||'–'}</td>
                        <td style={mutedCell}>{fmtSize(d.size_bytes)}</td>
                        <td style={mutedCell}>{(d.uploaded_at||'').slice(0,10)}</td>
                        <td style={actionsCell}>
                          {isRP && (
                            <button
                              type="button"
                              title={fillTitle}
                              aria-label="Fill from renewal pack"
                              disabled={fillDisabled}
                              style={fillDisabled ? fillBtnDisabled : fillBtn}
                              onClick={() => startImport(d)}
                            >
                              {thisImportRunning ? '⟳ Filling…' : '✨ Fill from renewal pack'}
                            </button>
                          )}
                          {isWording && (
                            <button
                              type="button"
                              title="Analyze this slip's wording"
                              aria-label="Analyze wording"
                              style={analyzeBtn}
                              onClick={() => setAnalyzing({ docId, doc: d })}
                            >
                              🔍 Analyze
                            </button>
                          )}
                          {isViewable(d.mime_type) && (
                            <button style={viewBtn} onClick={()=>openPreview(d)}>View</button>
                          )}
                          <a href={api.getDocumentDownloadUrl(docId)} target="_blank" rel="noopener noreferrer"
                            style={downloadBtn}>Download</a>
                          <button style={deleteBtn} onClick={()=>del(docId)}>Delete</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Wording Analysis modal — scoped to the slip the user clicked Analyze on */}
          {analyzing && (
            <WordingAnalysisModal
              contractId={contractId}
              parentContractId={parentId}
              docs={docs}
              doc={analyzing.doc}
              quoteMode={quoteMode}
              onClose={() => setAnalyzing(null)}
            />
          )}

          {/* Preview Modal — non-slip viewable docs only; slips open in a new tab */}
          {preview && (
            <div className="modal-backdrop" role="presentation" style={previewBackdrop}
              onClick={e=>{if(e.target===e.currentTarget)setPreview(null);}}>
              <div style={previewHeader}>
                <div style={previewTitle}>{preview.name}</div>
                <div style={previewActions}>
                  <a href={preview.url.replace('/view','/download')} target="_blank" rel="noopener noreferrer"
                    style={previewDownload}>↓ Download</a>
                  <button type="button" aria-label="Close" style={previewClose} onClick={()=>setPreview(null)}>✕ Close</button>
                </div>
              </div>
              <div style={previewBody}>
                {preview.mime==='application/pdf' ? (
                  <iframe src={preview.url} style={previewFrame} title="PDF Preview"/>
                ) : preview.mime?.startsWith('image/') ? (
                  <img src={preview.url} alt={preview.name} style={previewImage}/>
                ) : (
                  <iframe src={preview.url} style={previewFrame} title="File Preview"/>
                )}
              </div>
            </div>
          )}

          {/* Renewal-pack import flow */}
          <ImportProgressModal open={!!importingFor} filename={importingFor?.filename} />
          <WarningsDrawer
            open={!!drawer}
            warnings={drawer?.warnings || []}
            unmatchedCresta={drawer?.unmatchedCresta || []}
            onClose={() => setDrawer(null)}
          />
          <RestoreImportConfirm
            open={!!restoring}
            busy={restoreBusy}
            onConfirm={confirmRestore}
            onCancel={() => { if (!restoreBusy) setRestoring(null); }}
          />
        </div>
      )}
    </WizardLayout>
  );
}
