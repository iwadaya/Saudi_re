// DocumentsTable.jsx — the legacy metadata list + per-row analysis
// status / actions (View / Re-analyse / Delete).
import { Badge, Button, Table } from '../../../../components/ui';
import { AI_KIND_LABELS, fmtBytes } from '../documentsShared';
import StatusChip from './StatusChip';

// One-liner used in each document row's Status column. The cell is
// clickable when SUCCEEDED (opens the drawer). FAILED rows expose a
// Retry button so a transient OpenAI error can be re-tried without
// going back to the file picker.
function DocStatusCell({ analysis, onOpen, onRetry, reanalysing }) {
  if (reanalysing) {
    return (
      <div className="facdoc-status-cell">
        <span className="facdoc-spinner" />
        <span className="facdoc-status-running">Analysing…</span>
      </div>
    );
  }
  if (!analysis) {
    return <span className="facdoc-status-none">—</span>;
  }
  if (analysis.status === 'RUNNING' || analysis.status === 'PENDING') {
    return (
      <div className="facdoc-status-cell">
        <span className="facdoc-spinner" />
        <span className="facdoc-status-running">Analysing…</span>
      </div>
    );
  }
  if (analysis.status === 'SUCCEEDED') {
    return (
      <button type="button" className="facdoc-linkbtn facdoc-status-ok" onClick={onOpen}>
        Succeeded — {analysis.recommendation_count ?? 0} recommendation{analysis.recommendation_count === 1 ? '' : 's'}
        {analysis.pending_count ? (
          <span className="facdoc-status-pending-count">
            ({analysis.pending_count} pending)
          </span>
        ) : null}
      </button>
    );
  }
  if (analysis.status === 'FAILED') {
    return (
      <div className="facdoc-status-cell">
        <span className="facdoc-status-failed" title={analysis.error || ''}>
          Failed{analysis.error ? ` — ${String(analysis.error).slice(0, 70)}${analysis.error.length > 70 ? '…' : ''}` : ''}
        </span>
        <Button size="sm" className="facdoc-btn--retry" onClick={onRetry}>Retry</Button>
      </div>
    );
  }
  return <StatusChip status={analysis.status} />;
}

export default function DocumentsTable({
  sortedDocs, latestAnalysisByDoc, reAnalyseBusyRef,
  onOpenAnalysis, onReAnalyse, onDelete,
}) {
  return (
    <Table>
      <thead>
        <tr>
          {['Filename', 'Kind', 'Size', 'Uploaded by', 'Status', 'Actions'].map((h) => (
            <th key={h}>{h}</th>
          ))}
        </tr>
      </thead>
      <tbody>
        {sortedDocs.map((d) => {
          const kind = d.document_kind || d.doc_type || 'OTHER';
          const analysis = latestAnalysisByDoc.get(d.document_id);
          const reanalysing = reAnalyseBusyRef.current === d.document_id;
          return (
            <tr key={d.document_id}>
              <td>
                <div className="facdoc-doc-name">{d.file_name || '—'}</div>
                <div className="facdoc-doc-date">
                  {d.uploaded_at || d.created_at
                    ? new Date(d.uploaded_at || d.created_at).toLocaleString()
                    : '—'}
                </div>
              </td>
              <td>
                <Badge className="facdoc-badge--kind">
                  {AI_KIND_LABELS[kind] || kind}
                </Badge>
              </td>
              <td className="facdoc-td-dim">
                {fmtBytes(d.byte_size || d.file_size)}
              </td>
              <td className="facdoc-td-user">
                {d.uploaded_by_user_id ? d.uploaded_by_user_id.slice(0, 8) : (d.uploaded_by || '—')}
              </td>
              <td>
                <DocStatusCell analysis={analysis} onOpen={() => onOpenAnalysis(analysis?.analysis_id || null)}
                               onRetry={() => onReAnalyse(d.document_id, kind)} reanalysing={reanalysing} />
              </td>
              <td className="facdoc-td-actions">
                <button type="button" className="facdoc-linkbtn facdoc-link-view"
                        disabled={analysis?.status !== 'SUCCEEDED'}
                        onClick={() => analysis?.status === 'SUCCEEDED' && onOpenAnalysis(analysis.analysis_id)}>
                  View
                </button>
                <button type="button" className="facdoc-linkbtn facdoc-link-reanalyse"
                        disabled={reanalysing}
                        onClick={() => !reanalysing && onReAnalyse(d.document_id, kind)}>
                  {reanalysing ? 'Re-analysing…' : 'Re-analyse'}
                </button>
                <button type="button" className="facdoc-linkbtn facdoc-link-delete"
                        onClick={() => onDelete(d.document_id)}>Delete</button>
              </td>
            </tr>
          );
        })}
      </tbody>
    </Table>
  );
}
