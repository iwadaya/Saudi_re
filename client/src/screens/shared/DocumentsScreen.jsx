// src/screens/shared/DocumentsScreen.jsx
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { api } from '../../api';
import WordingChecker from './WordingChecker';
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
  const [showWording, setShowWording] = useState(false);
  const [parentId,    setParentId]    = useState(null);
  const [dragFile,    setDragFile]    = useState(null); // file from drag — no hidden input needed
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
    try {
      const d = await api.getDocuments(contractId, apiOpts);
      setDocs(Array.isArray(d) ? d : []);
      if (!quoteMode) {
        try {
          const c = await api.getContract(contractId);
          setParentId(c?.header?.parent_contract_id || null);
        } catch (e) { console.warn('[DocumentsScreen] getContract failed:', e?.message); }
      }
    } catch (e) { console.error('[DocumentsScreen] getDocuments failed:', e); }
  }, [apiOpts, contractId, quoteMode]);

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
    try { await api.deleteDocument(docId); await load(); } catch {}
  };

  const openPreview = (d) => {
    const docId = d.document_id || d.id;
    const mime = d.mime_type || '';
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

  // Find best wording doc for analysis (priority: Final Slip > Draft Slip > Expiring Slip)
  const bestWordingDoc = WORDING_PRIORITY.reduce((found, type) =>
    found || docs.find(d => d.doc_type === type) || null, null);

  // Styles
  const card      = { borderRadius: 18, border: '1px solid rgba(148,163,184,0.16)', background: 'rgba(2,6,23,0.14)', padding: '14px 18px', marginBottom: 16 };
  const dropzone  = { ...card, border: `1px dashed ${dragOver ? 'rgba(34,197,94,0.60)' : 'rgba(148,163,184,0.22)'}`, background: dragOver ? 'rgba(34,197,94,0.06)' : 'rgba(2,6,23,0.12)', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 14, transition: 'all .15s' };
  const greenBtn  = { borderRadius: 999, padding: '10px 18px', border: '1px solid rgba(34,197,94,0.75)', background: 'linear-gradient(180deg, rgba(34,197,94,0.88), rgba(16,185,129,0.78))', color: '#001b12', fontWeight: 900, letterSpacing: '.05em', cursor: 'pointer', fontSize: 13 };
  const lbl       = { color: 'rgba(226,232,240,0.65)', fontSize: 10, fontWeight: 800, letterSpacing: '.10em', textTransform: 'uppercase', marginBottom: 4 };
  const inp       = { width: '100%', borderRadius: 999, border: '1px solid rgba(148,163,184,0.25)', background: 'rgba(2,6,23,0.20)', color: 'rgba(226,232,240,0.88)', padding: '8px 14px', outline: 'none', fontSize: 12, boxSizing: 'border-box' };
  const sel       = { ...inp, appearance: 'none', WebkitAppearance: 'none', paddingRight: 28 };
  const smBtn     = { borderRadius: 999, padding: '6px 14px', border: '1px solid rgba(148,163,184,0.25)', background: 'rgba(2,6,23,0.20)', color: 'rgba(226,232,240,0.86)', fontWeight: 800, fontSize: 12, cursor: 'pointer' };
  const fillBtn   = { ...smBtn, borderColor: 'rgba(var(--accent-rgb), 0.50)', color: 'var(--accent)', background: 'rgba(var(--accent-rgb), 0.06)' };
  const fillBtnDisabled = { ...fillBtn, opacity: 0.45, cursor: 'not-allowed' };

  const currentFile = dragFile || (fileRef.current?.files?.[0]);

  return (
    <WizardLayout routeKey={routeKey} title="Documents" headerPill={headerPill}>
      {() => (
        <div>
          {/* Header */}
          <div style={{ display:'inline-flex', alignItems:'center', gap:8, padding:'6px 12px', borderRadius:999, background:'rgba(2,6,23,0.25)', border:'1px solid rgba(148,163,184,0.20)', marginBottom:6 }}>
            <span style={{ width:8, height:8, borderRadius:999, background:'rgba(34,197,94,0.9)', boxShadow:'0 0 0 4px rgba(34,197,94,0.10)' }}/>
            <span style={{ fontSize:11, fontWeight:800, letterSpacing:'.10em', textTransform:'uppercase', color:'rgba(226,232,240,0.85)' }}>Files for Treaty</span>
          </div>
          <div style={{ fontSize:12, color:'rgba(226,232,240,0.70)', marginBottom:16, marginTop:4 }}>
            <span style={{ fontWeight:700 }}>CONTRACT ID:</span>{' '}<span style={{ fontFamily:'monospace', opacity:0.8 }}>{contractId||'—'}</span>
          </div>

          {/* Dropzone */}
          <div style={dropzone} onDragOver={e=>{e.preventDefault();setDragOver(true);}} onDragLeave={()=>setDragOver(false)} onDrop={handleDrop}>
            <div style={{ display:'flex', gap:12, alignItems:'flex-start' }}>
              <div style={{ width:50, height:50, borderRadius:16, display:'grid', placeItems:'center', border:'1px solid rgba(34,197,94,0.35)', background:'radial-gradient(circle at 30% 30%, rgba(34,197,94,0.35), rgba(2,6,23,0.85))', boxShadow:'0 0 26px rgba(34,197,94,0.18)', flexShrink:0 }}>
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="rgba(34,197,94,0.9)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>
              </div>
              <div>
                <div style={{ fontWeight:800, fontSize:13, color:'rgba(226,232,240,0.88)' }}>
                  Drag & drop files here <span style={{ opacity:0.65 }}>or</span>{' '}
                  <span style={{ color:'rgba(34,197,94,0.95)', fontWeight:900, cursor:'pointer' }} onClick={()=>fileRef.current?.click()}>browse</span>
                </div>
                <div style={{ marginTop:4, color:'rgba(148,163,184,0.88)', fontSize:12 }}>Attach treaties, slips, wordings, accounts and bordereaux.</div>
                <div style={{ marginTop:4, color:'rgba(148,163,184,0.78)', fontSize:12 }}>PDF, XLSX, DOCX, CSV up to 50MB each.</div>
              </div>
            </div>
            <button style={greenBtn} onClick={()=>fileRef.current?.click()}>+ Select Files</button>
          </div>

          {/* Hidden file input */}
          <input type="file" ref={fileRef} onChange={handleFileSelect} style={{ display:'none' }}
            accept=".pdf,.xlsx,.xls,.docx,.doc,.csv,.txt,.png,.jpg,.jpeg" />

          {/* Upload form */}
          <div style={{ ...card, border:'1px dashed rgba(148,163,184,0.22)', background:'rgba(2,6,23,0.12)', marginTop:16, display:'grid', gridTemplateColumns:'160px 1fr 1.5fr auto', gap:12, alignItems:'end' }}>
            <div>
              <div style={lbl}>Document Type</div>
              <div style={{ position:'relative' }}>
                <select style={sel} value={docType} onChange={e=>handleDocTypeChange(e.target.value)}>
                  {DOC_TYPES.map(t=><option key={t} value={t}>{t}</option>)}
                </select>
                <span style={{ position:'absolute', right:10, top:'50%', transform:'translateY(-50%)', pointerEvents:'none', opacity:0.5, fontSize:10 }}>▾</span>
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
            <div style={{ display:'flex', flexDirection:'column', gap:6 }}>
              {currentFile && (
                <div style={{ fontSize:11, color:'rgba(34,197,94,0.9)', fontWeight:700, padding:'4px 10px', borderRadius:8, background:'rgba(34,197,94,0.08)', border:'1px solid rgba(34,197,94,0.25)', whiteSpace:'nowrap', overflow:'hidden', textOverflow:'ellipsis', maxWidth:180 }}>
                  📎 {currentFile.name}
                </div>
              )}
              <button style={{ ...greenBtn, padding:'8px 16px', fontSize:12, opacity: uploading ? 0.6 : 1 }} onClick={handleUploadClick} disabled={uploading}>
                {uploading ? '⟳ Uploading…' : '↑ Upload'}
              </button>
            </div>
            <div style={{ gridColumn:'1 / -1', fontSize:11, color:'rgba(148,163,184,0.70)', marginTop:-4 }}>
              Uploaded files are stored on the server and linked to this treaty.
              {bestWordingDoc && <span style={{ marginLeft:8, color:'rgba(34,197,94,0.7)' }}>✓ {bestWordingDoc.doc_type} available for wording analysis.</span>}
            </div>
          </div>

          {/* Uploaded Documents */}
          <div style={{ ...card, marginTop:16 }}>
            <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:10, gap:10 }}>
              <div style={{ fontWeight:900, fontSize:14, color:'rgba(226,232,240,0.90)' }}>Uploaded Documents</div>
              <div style={{ display:'flex', gap:8, alignItems:'center' }}>
                <button onClick={()=>setShowWording(v=>!v)} style={{ padding:'5px 12px', borderRadius:8, border:`1px solid ${showWording?'rgba(35,209,139,0.6)':'rgba(35,209,139,0.4)'}`, background: showWording?'rgba(35,209,139,0.2)':'rgba(35,209,139,0.08)', color:'#23d18b', fontSize:11, fontWeight:700, cursor:'pointer', display:'flex', alignItems:'center', gap:5 }}>
                  🔍 Wording Analysis
                  {!bestWordingDoc && <span style={{ fontSize:9, opacity:0.6 }}>(no slip yet)</span>}
                </button>
                <button style={smBtn} onClick={load}>↻ Reload</button>
              </div>
            </div>

            {docs.length === 0 ? (
              <div style={{ color:'rgba(148,163,184,0.70)', fontSize:13, padding:'10px 0' }}>No documents uploaded yet.</div>
            ) : (
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                <thead>
                  <tr style={{ borderBottom:'1px solid rgba(148,163,184,0.12)', color:'rgba(226,232,240,0.55)', fontSize:10, letterSpacing:'.14em', textTransform:'uppercase' }}>
                    <th style={{ textAlign:'left', padding:'8px 4px' }}>File</th>
                    <th style={{ textAlign:'left', padding:'8px 4px' }}>Type</th>
                    <th style={{ textAlign:'left', padding:'8px 4px' }}>Title</th>
                    <th style={{ textAlign:'left', padding:'8px 4px' }}>Size</th>
                    <th style={{ textAlign:'left', padding:'8px 4px' }}>Uploaded</th>
                    <th style={{ textAlign:'right', padding:'8px 4px' }}>Actions</th>
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
                      <tr key={docId} style={{ borderBottom:'1px solid rgba(148,163,184,0.08)', background: isWording ? 'rgba(34,197,94,0.03)' : 'transparent' }}>
                        <td style={{ padding:'10px 4px', fontWeight:700, color:'rgba(226,232,240,0.90)' }}>
                          <span style={{ cursor:'pointer', textDecoration:'underline', textDecorationColor:'rgba(226,232,240,0.25)' }} onClick={()=>openPreview(d)}>
                            {d.file_name||d.name||'–'}
                          </span>
                          {d.description && <div style={{ marginTop:2, fontSize:11, color:'rgba(148,163,184,0.70)', fontWeight:400 }}>{d.description}</div>}
                          {isRP && snapshot && (
                            <div style={{ marginTop:4, fontSize:11, color:'rgba(148,163,184,0.85)', fontWeight:500 }}>
                              Imported {fmtDate(snapshot.capturedAt)}
                              {snapshot.restorable && (
                                <>
                                  {' · '}
                                  <button
                                    type="button"
                                    onClick={() => setRestoring({ snapshotId: snapshot.id, documentId: docId })}
                                    style={{ background:'none', border:'none', padding:0, fontFamily:'inherit', fontSize:11, color:'rgba(96,165,250,0.95)', textDecoration:'underline', cursor:'pointer' }}
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
                        <td style={{ padding:'10px 4px' }}>
                          <span style={{ display:'inline-flex', padding:'3px 9px', borderRadius:999, border:`1px solid ${isWording?'rgba(34,197,94,0.35)':'rgba(148,163,184,0.22)'}`, background: isWording?'rgba(34,197,94,0.08)':'rgba(2,6,23,0.20)', fontSize:11, fontWeight:800, color: isWording?'rgba(34,197,94,0.9)':'inherit' }}>
                            {d.doc_type||'–'}
                          </span>
                        </td>
                        <td style={{ padding:'10px 4px', color:'rgba(226,232,240,0.75)' }}>{d.title||'–'}</td>
                        <td style={{ padding:'10px 4px', color:'rgba(226,232,240,0.65)' }}>{fmtSize(d.size_bytes)}</td>
                        <td style={{ padding:'10px 4px', color:'rgba(226,232,240,0.65)' }}>{(d.uploaded_at||'').slice(0,10)}</td>
                        <td style={{ padding:'10px 4px', textAlign:'right', display:'flex', justifyContent:'flex-end', gap:6, flexWrap:'wrap' }}>
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
                          {isViewable(d.mime_type) && (
                            <button style={{ ...smBtn, borderColor:'rgba(34,197,94,0.35)', color:'rgba(34,197,94,0.9)' }} onClick={()=>openPreview(d)}>View</button>
                          )}
                          <a href={api.getDocumentDownloadUrl(docId)} target="_blank" rel="noopener noreferrer"
                            style={{ ...smBtn, display:'inline-flex', alignItems:'center', borderColor:'rgba(96,165,250,0.35)', color:'rgba(96,165,250,0.9)', textDecoration:'none' }}>Download</a>
                          <button style={{ ...smBtn, borderColor:'rgba(248,113,113,0.35)', color:'rgba(248,113,113,0.9)' }} onClick={()=>del(docId)}>Delete</button>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Wording Analysis */}
          {showWording && (
            <div style={{ marginTop:16, padding:16, borderRadius:12, background:'rgba(2,6,23,0.4)', border:'1px solid rgba(35,209,139,0.2)' }}>
              <WordingChecker contractId={contractId} parentContractId={parentId} docs={docs} />
            </div>
          )}

          {/* Preview Modal */}
          {preview && (
            <div className="modal-backdrop" style={{ position:'fixed', inset:0, zIndex:9999, background:'rgba(0,0,0,0.85)', display:'flex', flexDirection:'column', alignItems:'stretch', justifyContent:'stretch' }}
              onClick={e=>{if(e.target===e.currentTarget)setPreview(null);}}>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', padding:'12px 20px', background:'rgba(15,23,42,0.95)', borderBottom:'1px solid rgba(148,163,184,0.15)' }}>
                <div style={{ color:'rgba(226,232,240,0.90)', fontWeight:800, fontSize:14 }}>{preview.name}</div>
                <div style={{ display:'flex', gap:10 }}>
                  <a href={preview.url.replace('/view','/download')} target="_blank" rel="noopener noreferrer"
                    style={{ ...smBtn, borderColor:'rgba(96,165,250,0.4)', color:'rgba(96,165,250,0.9)', fontSize:12, textDecoration:'none' }}>↓ Download</a>
                  <button type="button" aria-label="Close" style={{ ...smBtn, borderColor:'rgba(248,113,113,0.4)', color:'rgba(248,113,113,0.9)', fontSize:12 }} onClick={()=>setPreview(null)}>✕ Close</button>
                </div>
              </div>
              <div style={{ flex:1, overflow:'auto', display:'flex', justifyContent:'center', alignItems:'flex-start', padding:20 }}>
                {preview.mime==='application/pdf' ? (
                  <iframe src={preview.url} style={{ width:'100%', height:'100%', border:'none', borderRadius:8, background:'#fff', minHeight:'80vh' }} title="PDF Preview"/>
                ) : preview.mime?.startsWith('image/') ? (
                  <img src={preview.url} alt={preview.name} style={{ maxWidth:'100%', maxHeight:'85vh', borderRadius:8, objectFit:'contain' }}/>
                ) : (
                  <iframe src={preview.url} style={{ width:'100%', height:'100%', border:'none', borderRadius:8, background:'#fff', minHeight:'80vh' }} title="File Preview"/>
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
