// RecommendationCard.jsx — one AI recommendation: confidence bar,
// current → suggested diff, rationale, the Accept / Edit & Accept /
// Reject actions (plus the per-kind override editor), and the
// session-scoped Undo on the "Accepted just now" flash.
import { useState } from 'react';
import { Badge, Button } from '../../../../components/ui';
import {
  confidenceColor, jsonPreview, inferInputKind, formatForEditor, parseFromEditor,
} from '../documentsShared';
import { formatWithCommasDecimal, sanitizeNumber } from '../../../../utils/format';

const NO_UNDO = { available: false, reason: null, busy: false, done: false, error: null };

export default function RecommendationCard({
  rec, factorOptions, onAccept, onReject, onUndo, getUndoState, busy, justApplied,
}) {
  const conf = Number(rec.confidence);
  const confPct = Number.isFinite(conf) ? Math.round(conf * 100) : null;
  const color = confidenceColor(conf);
  const isPending = rec.status === 'PENDING';
  const undoState = getUndoState ? getUndoState(rec.recommendation_id) : NO_UNDO;
  const [editing, setEditing] = useState(false);
  const [editedValue, setEditedValue] = useState(() => formatForEditor(rec.suggested_value));
  const [rejectingOpen, setRejectingOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  const inputKind = inferInputKind(rec.target_field);

  return (
    <div className={`facdoc-rec${justApplied ? ' facdoc-rec--applied' : ''}`}>
      <div className="facdoc-rec-head">
        <div className="facdoc-rec-tags">
          <Badge className="facdoc-badge--screen">{rec.target_screen}</Badge>
          <span className="facdoc-rec-field">{rec.target_field}</span>
        </div>
        <div className="facdoc-conf">
          <div className="facdoc-conf-track">
            <div className="facdoc-conf-fill" style={{ width: `${confPct ?? 0}%`, background: color }} />
          </div>
          <span className="facdoc-conf-pct" style={{ color }}>
            {confPct == null ? '—' : `${confPct}%`}
          </span>
        </div>
      </div>
      <div className="facdoc-diff">
        <div className="facdoc-val facdoc-val--old">
          {rec.current_value === null || rec.current_value === undefined
            ? <span className="facdoc-val-null">—</span>
            : jsonPreview(rec.current_value)}
        </div>
        <div className="facdoc-diff-arrow">→</div>
        <div className="facdoc-val facdoc-val--new">
          {jsonPreview(rec.suggested_value)}
        </div>
      </div>
      <div className={`facdoc-rationale${editing || rejectingOpen ? ' facdoc-rationale--spaced' : ''}`}>
        “{rec.rationale}”
      </div>

      {editing && (
        <div className="facdoc-editor">
          <div className="facdoc-editor-label">
            Override value · {inputKind.toLowerCase()}
          </div>
          {inputKind === 'FACTOR_OPTION' && (() => {
            const code = rec.target_field.replace(/^factor\./, '');
            const opts = factorOptions?.[code] || [];
            return (
              <select className="fi facdoc-editor-field" value={editedValue}
                      onChange={(e) => setEditedValue(e.target.value)}>
                {opts.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            );
          })()}
          {inputKind === 'DATE' && (
            <input className="fi facdoc-editor-field" type="date" value={editedValue || ''}
                   onChange={(e) => setEditedValue(e.target.value)} />
          )}
          {(inputKind === 'NUMERIC' || inputKind === 'INT') && (
            <input className="fi facdoc-editor-field" type="text" inputMode="decimal"
                   value={formatWithCommasDecimal(editedValue)}
                   onChange={(e) => setEditedValue(sanitizeNumber(e.target.value))} />
          )}
          {(inputKind === 'LOCATION_ARRAY' || inputKind === 'LOSS_APPEND') && (
            <textarea className="fi facdoc-editor-json" rows={5} value={editedValue}
                      onChange={(e) => setEditedValue(e.target.value)} />
          )}
          {inputKind === 'CLAUSE_TOGGLE' && (
            <select className="fi facdoc-editor-field" value={editedValue === 'false' ? 'false' : 'true'}
                    onChange={(e) => setEditedValue(e.target.value)}>
              <option value="true">Checked</option>
              <option value="false">Unchecked</option>
            </select>
          )}
          {inputKind === 'TEXT' && (
            <input className="fi facdoc-editor-field" value={editedValue}
                   onChange={(e) => setEditedValue(e.target.value)} />
          )}
          <div className="facdoc-actions--end">
            <Button size="sm" className="facdoc-btn--cancel" onClick={() => setEditing(false)}>
              Cancel
            </Button>
            <Button size="sm" className="facdoc-btn--accept" disabled={busy}
                    onClick={() => onAccept(rec, parseFromEditor(editedValue, inputKind))}>
              Confirm override
            </Button>
          </div>
        </div>
      )}

      {rejectingOpen && (
        <div className="facdoc-reject">
          <textarea className="fi facdoc-reject-input" rows={3} value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    placeholder="Optional reason…" />
          <div className="facdoc-actions--end">
            <Button size="sm" className="facdoc-btn--cancel" onClick={() => setRejectingOpen(false)}>
              Cancel
            </Button>
            <Button size="sm" className="facdoc-btn--reject-confirm" disabled={busy}
                    onClick={() => onReject(rec, rejectReason)}>
              Confirm reject
            </Button>
          </div>
        </div>
      )}

      {!editing && !rejectingOpen && isPending && !justApplied && (
        <div className="facdoc-actions">
          <Button size="sm" className="facdoc-btn--accept" disabled={busy}
                  onClick={() => onAccept(rec, undefined)}>
            Accept
          </Button>
          <Button size="sm" className="facdoc-btn--edit" disabled={busy}
                  onClick={() => { setEditedValue(formatForEditor(rec.suggested_value)); setEditing(true); }}>
            Edit & Accept
          </Button>
          <Button size="sm" className="facdoc-btn--reject" disabled={busy}
                  onClick={() => { setRejectReason(''); setRejectingOpen(true); }}>
            Reject
          </Button>
        </div>
      )}

      {justApplied && !undoState.done && (
        <div className="facdoc-applied-row">
          <span>✓ Accepted just now</span>
          <Button size="sm" className="facdoc-btn--undo"
                  disabled={!undoState.available || undoState.busy || busy}
                  title={undoState.available
                    ? 'Restore the value this acceptance overwrote'
                    : (undoState.reason || 'Undo unavailable')}
                  onClick={() => onUndo?.(rec)}>
            {undoState.busy ? 'Undoing…' : 'Undo'}
          </Button>
          {undoState.error && (
            <span className="facdoc-undo-error" role="alert">{undoState.error}</span>
          )}
        </div>
      )}

      {undoState.done && (
        <div className="facdoc-applied-row facdoc-applied-row--undone">
          <span>↩ Undone — the previous value was restored</span>
        </div>
      )}
    </div>
  );
}
