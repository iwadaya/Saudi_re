// src/screens/facultative/documents/FacDocuments.jsx
//
// Documents tab hosts the document-AI ingestion workflow on top of the
// legacy metadata list:
//   1. drag-drop or pick a file
//   2. choose a document_kind
//   3. Upload & analyse → multipart POST to upload, then POST to
//      /api/ai/fac/analyse-document
//   4. poll /risks/:id/analyses every 2s until the row leaves RUNNING
//      (max 60s, then show a "still running" hint).
//
// Phase 4.2 (frontend-hardening): this file is now a thin orchestrator.
//   hooks/useFacDocumentsState   — list/upload/poll/re-analyse state
//   hooks/useAnalysisDrawerState — drawer load + accept/reject/bulk
//   hooks/useRecommendationUndo  — session-scoped accept undo
//   components/*                 — upload card, table, drawer, rec cards
//   documentsShared.js           — kinds/labels + pure helpers
// Styling lives in the co-located FacDocuments.css (Phase 3.2);
// interactive chrome uses the ui/ design-system primitives.
import WizardLayout from '../../../components/WizardLayout';
import useFacDocumentsState from './hooks/useFacDocumentsState';
import UploadDropzone from './components/UploadDropzone';
import DocumentsTable from './components/DocumentsTable';
import AnalysisDrawer from './components/AnalysisDrawer';
import './FacDocuments.css';

const ROUTE_KEY = 'FAC_DOCUMENTS';

export default function FacDocuments() {
  const {
    riskId,
    docs, loading, toast, stalePollHint,
    pendingFile, setPendingFile,
    pendingKind, setPendingKind,
    pendingTitle, setPendingTitle,
    pendingDescription, setPendingDescription,
    uploading,
    draggingOver, setDraggingOver,
    fileInputRef,
    onPickFile, onDrop, onUpload, onUploadAndAnalyse,
    sortedDocs, latestAnalysisByDoc, reAnalyseBusyRef,
    onReAnalyse, handleDelete,
    openAnalysisId, setOpenAnalysisId,
  } = useFacDocumentsState();

  return (
    <WizardLayout routeKey={ROUTE_KEY} title="Documents" headerPill="FACULTATIVE">
      <div className="facdoc-page">
        <div className="facdoc-intro">
          Upload placement slips, surveys, bordereaux, COPE reports and wordings.
          The AI runner extracts data and proposes edits on each downstream screen.
        </div>

        {/* Upload zone */}
        <UploadDropzone
          pendingFile={pendingFile} setPendingFile={setPendingFile}
          pendingKind={pendingKind} setPendingKind={setPendingKind}
          pendingTitle={pendingTitle} setPendingTitle={setPendingTitle}
          pendingDescription={pendingDescription} setPendingDescription={setPendingDescription}
          uploading={uploading}
          draggingOver={draggingOver} setDraggingOver={setDraggingOver}
          fileInputRef={fileInputRef}
          onPickFile={onPickFile} onDrop={onDrop}
          onUpload={onUpload} onUploadAndAnalyse={onUploadAndAnalyse}
        />

        {/* Toast */}
        {toast && (
          <div className={`facdoc-toast ${toast.kind === 'error' ? 'facdoc-toast--error' : 'facdoc-toast--ok'}`}>
            {toast.text}
          </div>
        )}
        {stalePollHint && (
          <div className="facdoc-toast facdoc-toast--warn">
            Analysis is still running — the model is taking longer than usual.
            Refresh in a minute to pick up the result.
          </div>
        )}

        {/* Documents list */}
        {loading ? (
          <div className="facdoc-list-loading">Loading…</div>
        ) : docs.length === 0 ? (
          <div className="facdoc-list-empty">
            No documents attached yet.
          </div>
        ) : (
          <DocumentsTable
            sortedDocs={sortedDocs}
            latestAnalysisByDoc={latestAnalysisByDoc}
            reAnalyseBusyRef={reAnalyseBusyRef}
            onOpenAnalysis={setOpenAnalysisId}
            onReAnalyse={onReAnalyse}
            onDelete={handleDelete}
          />
        )}
      </div>

      <AnalysisDrawer analysisId={openAnalysisId} riskId={riskId}
                       onClose={() => setOpenAnalysisId(null)} />
    </WizardLayout>
  );
}
