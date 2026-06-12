// useFacDocumentsState.js — page-level state + flows for the Documents
// screen (Phase 4.2 decomposition of FacDocuments.jsx):
//   • documents + analyses load
//   • drag-drop / file-picker selection with the 20 MB cap
//   • upload → analyse → 2s poll loop (60s deadline, then a stale hint)
//   • re-analyse + delete actions
//   • drawer open/close + the ?analysis=<id> deep link
// Behavior is unchanged from the pre-decomposition screen.
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../../../api';
import { useFacRiskId } from '../../../../hooks/useContractId';
import { MAX_BYTES, POLL_INTERVAL_MS, POLL_DEADLINE_MS, fmtBytes } from '../documentsShared';

export default function useFacDocumentsState() {
  const riskId = useFacRiskId();
  const [docs, setDocs] = useState([]);
  const [analyses, setAnalyses] = useState([]);
  const [loading, setLoading] = useState(true);
  const [toast, setToast] = useState(null);

  // Upload zone state.
  const [pendingFile, setPendingFile] = useState(null);
  const [pendingKind, setPendingKind] = useState('PLACEMENT_SLIP');
  const [uploading, setUploading] = useState(false);
  const [stalePollHint, setStalePollHint] = useState(false);
  const [draggingOver, setDraggingOver] = useState(false);
  // Selected analysis for the drawer (4.3.c). Null = drawer closed.
  const [openAnalysisId, setOpenAnalysisId] = useState(null);
  // Deep-link support — the FacPendingRecsBanner sends users here
  // with ?analysis=<id>; the param wins on initial mount, then we
  // clean it out of the URL so a refresh doesn't replay it.
  const [searchParams, setSearchParams] = useSearchParams();
  useEffect(() => {
    const deep = searchParams.get('analysis');
    if (deep) {
      setOpenAnalysisId(deep);
      const next = new URLSearchParams(searchParams);
      next.delete('analysis');
      setSearchParams(next, { replace: true });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const fileInputRef = useRef(null);
  const pollHandleRef = useRef(null);
  const pollDeadlineRef = useRef(0);
  // Track which document is currently being re-analysed so the row
  // can show "Re-analysing…" without spinning a global busy state.
  const reAnalyseBusyRef = useRef(null);

  const load = useCallback(async () => {
    if (!riskId) return;
    setLoading(true);
    try {
      const [d, a] = await Promise.all([
        api.facGetDocuments(riskId),
        api.facGetAnalyses(riskId).catch(() => ({ analyses: [] })),
      ]);
      setDocs(d || []);
      setAnalyses(a?.analyses || []);
    } catch (e) { console.error(e); }
    setLoading(false);
  }, [riskId]);

  useEffect(() => { load(); }, [load]);

  // Cleanup poll timer on unmount.
  useEffect(() => () => {
    if (pollHandleRef.current) clearTimeout(pollHandleRef.current);
  }, []);

  // Map analysis status by document_id for the chip on each row.
  // We surface the most recent analysis per document.
  const latestAnalysisByDoc = useMemo(() => {
    const map = new Map();
    for (const a of analyses) {
      if (!map.has(a.document_id)) map.set(a.document_id, a);
    }
    return map;
  }, [analyses]);

  // Documents sorted newest-first by uploaded_at (falling back to
  // created_at for legacy rows that pre-date migration 090).
  const sortedDocs = useMemo(() => {
    const safeTime = (d) => {
      const v = d.uploaded_at || d.created_at;
      const t = v ? Date.parse(v) : 0;
      return Number.isFinite(t) ? t : 0;
    };
    return [...docs].sort((a, b) => safeTime(b) - safeTime(a));
  }, [docs]);

  // ── File selection (drop + click) ──
  const validateFile = useCallback((f) => {
    if (!f) return 'No file selected';
    if (f.size > MAX_BYTES) return `File is ${fmtBytes(f.size)} — over the 20 MB cap`;
    return null;
  }, []);

  const onPickFile = useCallback((f) => {
    const err = validateFile(f);
    if (err) {
      setToast({ kind: 'error', text: err });
      return;
    }
    setPendingFile(f);
    setToast(null);
  }, [validateFile]);

  const onDrop = useCallback((e) => {
    e.preventDefault();
    setDraggingOver(false);
    const f = e.dataTransfer?.files?.[0];
    if (f) onPickFile(f);
  }, [onPickFile]);

  // ── Polling loop ──
  // Re-fetches /risks/:id/analyses every 2s until the analysis tied
  // to `analysisId` leaves RUNNING, or 60s elapse. Cancellable.
  const pollAnalysis = useCallback((analysisId) => {
    if (pollHandleRef.current) clearTimeout(pollHandleRef.current);
    pollDeadlineRef.current = Date.now() + POLL_DEADLINE_MS;
    setStalePollHint(false);
    const tick = async () => {
      try {
        const a = await api.facGetAnalyses(riskId);
        setAnalyses(a?.analyses || []);
        const row = (a?.analyses || []).find((x) => x.analysis_id === analysisId);
        const done = row && row.status !== 'RUNNING' && row.status !== 'PENDING';
        if (done) {
          if (row.status === 'SUCCEEDED') {
            setToast({ kind: 'ok', text: `AI analysis complete — ${row.recommendation_count} suggestion(s).` });
          } else if (row.status === 'FAILED') {
            setToast({ kind: 'error', text: 'AI analysis failed — see the analysis row for details.' });
          }
          return;
        }
        if (Date.now() > pollDeadlineRef.current) {
          setStalePollHint(true);
          return;
        }
        pollHandleRef.current = setTimeout(tick, POLL_INTERVAL_MS);
      } catch (e) {
        console.error('[FacDocuments] poll failed:', e);
        pollHandleRef.current = setTimeout(tick, POLL_INTERVAL_MS);
      }
    };
    pollHandleRef.current = setTimeout(tick, POLL_INTERVAL_MS);
  }, [riskId]);

  // Re-analyse: fires a fresh analyse call against the same document.
  // The server inserts a brand-new fac_document_analysis row, so the
  // history is preserved — the latestAnalysisByDoc map picks up the
  // new (most-recent-by-created_at) row on the next /analyses fetch.
  const onReAnalyse = useCallback(async (documentId, kind) => {
    if (reAnalyseBusyRef.current) return;
    reAnalyseBusyRef.current = documentId;
    setToast(null);
    setStalePollHint(false);
    const placeholder = `placeholder-${Date.now()}`;
    setAnalyses((prev) => [
      { analysis_id: placeholder, document_id: documentId,
        document_filename: '', document_kind: kind || 'OTHER',
        status: 'RUNNING', summary: null, created_at: new Date().toISOString(),
        recommendation_count: 0, pending_count: 0 },
      ...prev,
    ]);
    try {
      api.facAnalyseDocument({
        fac_risk_id: riskId, document_id: documentId, document_kind: kind || 'OTHER',
      }).then((r) => {
        setToast({ kind: 'ok', text: `Re-analysis ready (${(r.recommendations || []).length} suggestion(s)).` });
        load();
      }).catch((e) => {
        console.error('[FacDocuments] re-analyse failed:', e);
      }).finally(() => {
        reAnalyseBusyRef.current = null;
      });
      pollAnalysis(placeholder);
    } catch (e) {
      reAnalyseBusyRef.current = null;
      setToast({ kind: 'error', text: `Re-analyse failed: ${e?.message || e}` });
    }
  }, [riskId, load, pollAnalysis]);

  // ── Upload + analyse ──
  const onUploadAndAnalyse = useCallback(async () => {
    if (!pendingFile || !riskId) return;
    setUploading(true);
    setToast(null);
    setStalePollHint(false);
    try {
      const doc = await api.facUploadDocumentMultipart(riskId, pendingFile, pendingKind);
      setDocs((prev) => [doc, ...prev]);
      setPendingFile(null);

      // Kick off analysis. The endpoint runs synchronously so the
      // response IS the analysis row — but we poll the list endpoint
      // anyway so a refresh during the call still surfaces progress.
      api.facAnalyseDocument({
        fac_risk_id:   riskId,
        document_id:   doc.document_id,
        document_kind: pendingKind,
      }).then((r) => {
        setToast({ kind: 'ok', text: `Analysis ready (${(r.recommendations || []).length} suggestion(s)).` });
        // After-the-fact reload to pick up the SUCCEEDED row + count.
        load();
      }).catch((e) => {
        // The server already wrote a FAILED row — surfaced via the poll.
        console.error('[FacDocuments] analyse failed:', e);
      });

      // Optimistically inject a RUNNING analysis row keyed off this
      // document so the chip shows immediately, then start polling.
      const placeholderAnalysisId = `placeholder-${doc.document_id}`;
      setAnalyses((prev) => [
        { analysis_id: placeholderAnalysisId, document_id: doc.document_id,
          document_filename: doc.file_name, document_kind: pendingKind,
          status: 'RUNNING', summary: null, created_at: new Date().toISOString(),
          recommendation_count: 0, pending_count: 0 },
        ...prev,
      ]);
      pollAnalysis(placeholderAnalysisId);
    } catch (e) {
      setToast({ kind: 'error', text: `Upload failed: ${e?.message || e}` });
    }
    setUploading(false);
  }, [pendingFile, pendingKind, riskId, load, pollAnalysis]);

  const handleDelete = useCallback(async (docId) => {
    try {
      await api.facDeleteDocument(docId);
      load();
    } catch (e) { console.error(e); }
  }, [load]);

  return {
    riskId,
    docs,
    loading,
    toast,
    stalePollHint,
    // upload zone
    pendingFile, setPendingFile,
    pendingKind, setPendingKind,
    uploading,
    draggingOver, setDraggingOver,
    fileInputRef,
    onPickFile,
    onDrop,
    onUploadAndAnalyse,
    // table
    sortedDocs,
    latestAnalysisByDoc,
    reAnalyseBusyRef,
    onReAnalyse,
    handleDelete,
    // drawer
    openAnalysisId, setOpenAnalysisId,
  };
}
