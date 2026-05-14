// src/screens/facultative/documents/FacDocuments.jsx
//
// Documents tab now hosts the document-AI ingestion workflow on top of
// the legacy metadata list. New flow:
//   1. drag-drop or pick a file
//   2. choose a document_kind
//   3. Upload & analyse → multipart POST to upload, then POST to
//      /api/ai/fac/analyse-document
//   4. poll /risks/:id/analyses every 2s until the row leaves RUNNING
//      (max 60s, then show a "still running" hint).
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import api from '../../../api';
import WizardLayout from '../../../components/WizardLayout';
import { useFacRiskId } from '../../../hooks/useContractId';

const ROUTE_KEY = 'FAC_DOCUMENTS';
const MAX_BYTES = 20 * 1024 * 1024;     // 20 MB
const POLL_INTERVAL_MS = 2000;
const POLL_DEADLINE_MS = 60_000;

// AI kinds (drive both the upload metadata and the analyser routing).
const AI_KINDS = [
  ['PLACEMENT_SLIP',   'Placement Slip'],
  ['SURVEY_REPORT',    'Survey Report'],
  ['CLAIMS_BORDEREAU', 'Claims Bordereau'],
  ['COPE_REPORT',      'COPE Report'],
  ['WORDING',          'Wording / Clauses'],
  ['OTHER',            'Other'],
];
const AI_KIND_LABELS = Object.fromEntries(AI_KINDS);

const STATUS_PALETTE = {
  PENDING:   { bg: 'rgba(148,163,184,0.10)', border: 'rgba(148,163,184,0.30)', fg: 'rgba(226,232,240,0.80)' },
  RUNNING:   { bg: 'rgba(0,212,255,0.10)',   border: 'rgba(0,212,255,0.40)',   fg: '#00d4ff' },
  SUCCEEDED: { bg: 'rgba(35,209,139,0.10)',  border: 'rgba(35,209,139,0.40)',  fg: '#23d18b' },
  FAILED:    { bg: 'rgba(248,113,113,0.10)', border: 'rgba(248,113,113,0.40)', fg: '#f87171' },
};

function fmtBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / (1024 * 1024)).toFixed(1)} MB`;
}

function StatusChip({ status }) {
  if (!status) return null;
  const p = STATUS_PALETTE[status] || STATUS_PALETTE.PENDING;
  return (
    <span style={{
      display: 'inline-block', padding: '2px 8px', borderRadius: 20,
      fontSize: 10, fontWeight: 800, letterSpacing: '.08em',
      background: p.bg, border: `1px solid ${p.border}`, color: p.fg,
    }}>
      {status === 'RUNNING' ? 'Analysing…' : status}
    </span>
  );
}

export default function FacDocuments() {
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
  const fileInputRef = useRef(null);
  const pollHandleRef = useRef(null);
  const pollDeadlineRef = useRef(0);

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

  const handleDelete = async (docId) => {
    try {
      await api.facDeleteDocument(docId);
      load();
    } catch (e) { console.error(e); }
  };

  return (
    <WizardLayout routeKey={ROUTE_KEY} title="Documents" headerPill="FACULTATIVE">
      <div style={{ maxWidth: 900, margin: '0 auto', padding: '8px 0 40px' }}>
        <div style={{ fontSize: 12, color: 'rgba(148,163,184,0.55)', marginBottom: 16 }}>
          Upload placement slips, surveys, bordereaux, COPE reports and wordings.
          The AI runner extracts data and proposes edits on each downstream screen.
        </div>

        {/* Upload zone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setDraggingOver(true); }}
          onDragLeave={() => setDraggingOver(false)}
          onDrop={onDrop}
          style={{
            padding: 18, borderRadius: 14,
            border: `2px dashed ${draggingOver ? '#00d4ff' : 'rgba(148,163,184,0.30)'}`,
            background: draggingOver ? 'rgba(0,212,255,0.05)' : 'rgba(8,14,30,0.50)',
            marginBottom: 18, transition: 'border-color .12s, background .12s',
          }}
        >
          {!pendingFile ? (
            <div style={{ textAlign: 'center' }}>
              <div style={{ fontSize: 13, fontWeight: 800, color: 'rgba(226,232,240,0.85)' }}>
                Drag &amp; drop a document, or pick a file
              </div>
              <div style={{ fontSize: 11, color: 'rgba(148,163,184,0.45)', marginTop: 4 }}>
                Up to 20 MB · PDFs preferred · the AI analyser uses the file kind you pick
              </div>
              <input ref={fileInputRef} type="file" style={{ display: 'none' }}
                     onChange={(e) => onPickFile(e.target.files?.[0])} />
              <button onClick={() => fileInputRef.current?.click()} style={{
                marginTop: 10, appearance: 'none', border: '1px solid rgba(0,212,255,0.30)',
                background: 'rgba(0,212,255,0.10)', color: '#00d4ff',
                borderRadius: 8, padding: '8px 18px', fontSize: 12, fontWeight: 700,
                cursor: 'pointer',
              }}>Choose file</button>
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 220px 160px', gap: 12, alignItems: 'end' }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'rgba(226,232,240,0.85)' }}>{pendingFile.name}</div>
                <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.45)', marginTop: 2 }}>
                  {fmtBytes(pendingFile.size)} · {pendingFile.type || 'application/octet-stream'}
                </div>
                <span style={{ display: 'inline-block', marginTop: 8, fontSize: 11, color: '#f87171',
                                cursor: 'pointer' }}
                       onClick={() => setPendingFile(null)}>
                  remove
                </span>
              </div>
              <div>
                <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.45)', marginBottom: 4 }}>Document kind</div>
                <select className="fi" value={pendingKind} onChange={(e) => setPendingKind(e.target.value)}>
                  {AI_KINDS.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
                </select>
              </div>
              <button onClick={onUploadAndAnalyse} disabled={uploading} style={{
                appearance: 'none', border: 'none',
                background: 'linear-gradient(135deg, #23d18b, #0aa36a)', color: '#08140e',
                borderRadius: 8, padding: '10px 16px', fontSize: 12, fontWeight: 800,
                cursor: uploading ? 'not-allowed' : 'pointer', opacity: uploading ? 0.5 : 1,
              }}>{uploading ? 'Uploading…' : 'Upload & analyse'}</button>
            </div>
          )}
        </div>

        {/* Toast */}
        {toast && (
          <div style={{
            padding: '8px 14px', marginBottom: 12, fontSize: 12,
            background: toast.kind === 'error' ? 'rgba(248,113,113,0.08)' : 'rgba(35,209,139,0.08)',
            border: `1px solid ${toast.kind === 'error' ? 'rgba(248,113,113,0.30)' : 'rgba(35,209,139,0.30)'}`,
            color: toast.kind === 'error' ? '#f87171' : '#23d18b',
            borderRadius: 8,
          }}>{toast.text}</div>
        )}
        {stalePollHint && (
          <div style={{
            padding: '8px 14px', marginBottom: 12, fontSize: 12,
            background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.30)',
            color: '#fbbf24', borderRadius: 8,
          }}>
            Analysis is still running — the model is taking longer than usual.
            Refresh in a minute to pick up the result.
          </div>
        )}

        {/* Documents list */}
        {loading ? (
          <div style={{ padding: 30, textAlign: 'center', color: 'rgba(148,163,184,0.40)', fontSize: 12 }}>Loading…</div>
        ) : docs.length === 0 ? (
          <div style={{ padding: 30, textAlign: 'center', color: 'rgba(148,163,184,0.30)', fontSize: 12 }}>
            No documents attached yet.
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'rgba(5,8,16,0.6)' }}>
                {['Kind', 'Document', 'Size', 'AI Status', 'Added', ''].map((h) => (
                  <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontSize: 9, fontWeight: 800,
                                       letterSpacing: '.12em', textTransform: 'uppercase',
                                       color: 'rgba(148,163,184,0.50)',
                                       borderBottom: '1px solid rgba(255,255,255,0.08)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {docs.map((d) => {
                const kind = d.document_kind || d.doc_type || 'OTHER';
                const analysis = latestAnalysisByDoc.get(d.document_id);
                return (
                  <tr key={d.document_id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    <td style={{ padding: '10px 12px' }}>
                      <span style={{ padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 700,
                                     background: 'rgba(0,212,255,0.08)', border: '1px solid rgba(0,212,255,0.20)',
                                     color: '#00d4ff' }}>
                        {AI_KIND_LABELS[kind] || kind}
                      </span>
                    </td>
                    <td style={{ padding: '10px 12px', fontWeight: 600, color: 'rgba(226,232,240,0.85)' }}>
                      {d.file_name || '—'}
                    </td>
                    <td style={{ padding: '10px 12px', color: 'rgba(148,163,184,0.55)' }}>
                      {fmtBytes(d.byte_size || d.file_size)}
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      {analysis ? (
                        <div>
                          <StatusChip status={analysis.status} />
                          {analysis.recommendation_count != null && analysis.status === 'SUCCEEDED' && (
                            <span style={{ fontSize: 10, color: 'rgba(148,163,184,0.55)', marginLeft: 8 }}>
                              {analysis.recommendation_count} suggestion(s){analysis.pending_count ? `, ${analysis.pending_count} pending` : ''}
                            </span>
                          )}
                        </div>
                      ) : (
                        <span style={{ fontSize: 10, color: 'rgba(148,163,184,0.35)' }}>— not analysed —</span>
                      )}
                    </td>
                    <td style={{ padding: '10px 12px', color: 'rgba(148,163,184,0.40)', fontSize: 11 }}>
                      {d.uploaded_at || d.created_at
                        ? new Date(d.uploaded_at || d.created_at).toLocaleDateString()
                        : '—'}
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      <span style={{ cursor: 'pointer', color: '#f87171', fontSize: 11, fontWeight: 600 }}
                             onClick={() => handleDelete(d.document_id)}>Delete</span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </div>
    </WizardLayout>
  );
}
