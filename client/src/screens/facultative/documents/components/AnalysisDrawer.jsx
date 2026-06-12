// AnalysisDrawer.jsx — side drawer rendered when openAnalysisId is set.
// The Modal primitive supplies the backdrop, Esc-to-close, focus trap
// and aria-modal wiring; FacDocuments.css reshapes the panel into the
// right-hand drawer this screen has always used. State + flows live in
// hooks/useAnalysisDrawerState.
import { useState } from 'react';
import { Badge, Button, Modal } from '../../../../components/ui';
import { AI_KIND_LABELS, SCREEN_ROUTES, jsonPreview } from '../documentsShared';
import useAnalysisDrawerState from '../hooks/useAnalysisDrawerState';
import StatusChip from './StatusChip';
import RecommendationsList from './RecommendationsList';

export default function AnalysisDrawer({ analysisId, riskId, onClose }) {
  const {
    data, loading, factorOptions, busyRecs, justApplied,
    appliedPill, bulkProgress, groupCollapseRef,
    onAccept, onReject, onAcceptHighConfidence, onUndo, getUndoState,
  } = useAnalysisDrawerState({ analysisId, riskId });
  const [extractedOpen, setExtractedOpen] = useState(false);

  if (!analysisId) return null;

  const analysis = data?.analysis;
  const recs = data?.recommendations || [];
  // Mirrors the status-grouping rule in RecommendationsList: anything
  // that isn't ACCEPTED / REJECTED / SUPERSEDED falls into the Pending
  // bucket, so the bulk-button count matches the rendered group.
  const hiConfidencePending = recs.filter(
    (r) => !['ACCEPTED', 'REJECTED', 'SUPERSEDED'].includes(r.status)
      && Number(r.confidence) >= 0.85,
  );

  return (
    <Modal open onClose={onClose} className="facdoc-drawer">
      {loading || !analysis ? (
        <div className="facdoc-drawer-loading">
          Loading analysis…
        </div>
      ) : (
        <div>
          {/* Header */}
          <div className="facdoc-drawer-head">
            <div className="facdoc-drawer-head-row">
              <span className="facdoc-drawer-eyebrow">
                AI Analysis
              </span>
              <Button variant="ghost" size="sm" className="facdoc-drawer-close"
                      aria-label="Close analysis" onClick={onClose}>×</Button>
            </div>
            <div className="facdoc-drawer-title">
              {analysis.document_filename || 'Untitled document'}
            </div>
            <div className="facdoc-drawer-meta">
              <Badge className="facdoc-badge--kind">
                {AI_KIND_LABELS[analysis.analysis_kind] || analysis.analysis_kind}
              </Badge>
              <StatusChip status={analysis.status} />
              <span className="facdoc-drawer-when">
                {analysis.completed_at
                  ? `analysed ${new Date(analysis.completed_at).toLocaleString()}`
                  : analysis.started_at
                    ? `started ${new Date(analysis.started_at).toLocaleString()}`
                    : ''}
              </span>
            </div>
          </div>

          {/* Summary */}
          <div className="facdoc-summary">
            <div className="facdoc-section-label">Summary</div>
            <div className="facdoc-summary-text">
              {analysis.summary || <span className="facdoc-muted-note">
                No summary — analysis may have failed.
              </span>}
            </div>
            {analysis.status === 'FAILED' && analysis.error && (
              <div className="facdoc-analysis-error">
                {analysis.error}
              </div>
            )}
          </div>

          {/* Extracted JSON (collapsible) */}
          <div className="facdoc-extracted">
            <button type="button" className="facdoc-disclosure"
                    aria-expanded={extractedOpen}
                    onClick={() => setExtractedOpen((v) => !v)}>
              <span>{extractedOpen ? '▾' : '▸'}</span>
              <span>Raw extracted fields</span>
            </button>
            {extractedOpen && (
              <pre className="facdoc-extracted-pre">
                {jsonPreview(analysis.extracted || {})}
              </pre>
            )}
          </div>

          {/* Applied-pill — links to the affected screen. */}
          {appliedPill && (
            <div className="facdoc-applied-wrap">
              <div className="facdoc-applied-pill">
                {appliedPill.bulk
                  ? `${appliedPill.bulk} changes applied · ${appliedPill.screen}`
                  : `1 change applied · ${appliedPill.screen}`}
                {' '}
                <a href={`/fac/${analysis.fac_risk_id}/${SCREEN_ROUTES[appliedPill.screen] || ''}`}
                   className="facdoc-applied-link">
                  open →
                </a>
              </div>
            </div>
          )}

          {/* Bulk action */}
          {hiConfidencePending.length > 0 && (
            <div className="facdoc-bulk">
              <Button size="sm" className="facdoc-btn--bulk-accept"
                      disabled={!!bulkProgress} onClick={onAcceptHighConfidence}>
                Accept all ≥ 85% confidence ({hiConfidencePending.length})
              </Button>
              {bulkProgress && (
                <span className="facdoc-bulk-progress">
                  {bulkProgress.done} / {bulkProgress.total} done
                </span>
              )}
            </div>
          )}

          {/* Recommendations */}
          <RecommendationsList
            recs={recs}
            groupCollapseRef={groupCollapseRef}
            cardProps={{ factorOptions, onAccept, onReject, busyRecs, justApplied, onUndo, getUndoState }}
          />
        </div>
      )}
    </Modal>
  );
}
