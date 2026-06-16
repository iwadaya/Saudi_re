// src/screens/shared/HistoryScreen.jsx
// Read-only audit / history timeline for a treaty (contract). Renders the
// merged GET /api/contracts/:id/history feed — audit events, status
// transitions, approval decisions and field-level diffs — newest-first, with
// actor, timestamp, action, and expandable field changes (from → to).
import { useState } from 'react';
import { api } from '../../api';
import { useContractId } from '../../hooks/useContractId';
import { useResource } from '../../hooks/useResource';
import WizardLayout from '../../components/WizardLayout';
import AsyncBoundary from '../../components/AsyncBoundary';
import { formatDateTime } from '../../utils/format';

/** Short relative-time label ("3h ago") for the timeline's secondary stamp. */
function relativeTime(at) {
  const t = new Date(at).getTime();
  if (!Number.isFinite(t)) return '';
  const secs = Math.round((Date.now() - t) / 1000);
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.round(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.round(hours / 24);
  if (days < 30) return `${days}d ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months}mo ago`;
  return `${Math.round(months / 12)}y ago`;
}

/** Visual tone for the rail dot + type chip, derived from the event type. */
function toneOf(item) {
  const t = String(item?.type || '').toUpperCase();
  if (/APPROVED|SIGNED/.test(t)) return 'ok';
  if (/DECLINED|NTU|RECALL|RETURN|DISPUTE|DELETED|OVERRIDE/.test(t)) return 'warn';
  if (item?.source === 'workflow' || t.startsWith('STATUS_') || t === 'SUBMITTED') return 'info';
  return 'muted';
}

/** Up-to-two-letter initials for the actor avatar. */
function initials(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '–';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
}

/** Render a from/to value: primitives as-is, objects compacted, empties as —. */
function renderValue(v) {
  if (v == null || v === '') return <span className="hist-val hist-val--empty">—</span>;
  if (typeof v === 'object') {
    let s;
    try { s = JSON.stringify(v); } catch { s = String(v); }
    if (s.length > 120) s = `${s.slice(0, 117)}…`;
    return <span className="hist-val hist-val--json">{s}</span>;
  }
  return <span className="hist-val">{String(v)}</span>;
}

/** A single timeline entry; owns its own expand state for the field diffs. */
function HistoryItem({ item }) {
  const [open, setOpen] = useState(false);
  const changes = Array.isArray(item.changes) ? item.changes : [];
  const hasChanges = changes.length > 0;
  const tone = toneOf(item);
  const typeLabel = String(item.type || 'EVENT').replace(/_/g, ' ');

  return (
    <li className={`hist-item hist-item--${tone}`}>
      <div className="hist-rail" aria-hidden="true">
        <span className="hist-dot" />
      </div>

      <div className="hist-card glass">
        <div className="hist-card-head">
          <span className="hist-avatar" aria-hidden="true">{initials(item.actor?.name)}</span>
          <div className="hist-who">
            <span className="hist-actor">{item.actor?.name || 'System'}</span>
            {item.actor?.role && <span className="hist-role">{item.actor.role}</span>}
          </div>
          <span className={`hist-type hist-type--${tone}`}>{typeLabel}</span>
          <time
            className="hist-time"
            dateTime={item.at || undefined}
            title={formatDateTime(item.at)}
          >
            {relativeTime(item.at)}
          </time>
        </div>

        <div className="hist-summary">{item.summary || typeLabel}</div>
        {item.comment && <div className="hist-comment">“{item.comment}”</div>}

        {hasChanges && (
          <div className="hist-changes">
            <button
              type="button"
              className="hist-changes-toggle"
              aria-expanded={open}
              onClick={() => setOpen((o) => !o)}
            >
              <span aria-hidden="true">{open ? '▾' : '▸'}</span>
              {' '}{changes.length} field {changes.length === 1 ? 'change' : 'changes'}
            </button>
            {open && (
              <table className="hist-changes-table">
                <thead>
                  <tr><th>Field</th><th>From</th><th aria-hidden="true" /><th>To</th></tr>
                </thead>
                <tbody>
                  {changes.map((c, i) => (
                    <tr key={`${c.field}-${i}`}>
                      <td className="hist-field">{c.field}</td>
                      <td className="hist-from">{renderValue(c.from)}</td>
                      <td className="hist-arrow" aria-hidden="true">→</td>
                      <td className="hist-to">{renderValue(c.to)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        )}

        <div className="hist-stamp">{formatDateTime(item.at)}</div>
      </div>
    </li>
  );
}

export default function HistoryScreen({ routeKey, title, headerPill }) {
  const contractId = useContractId();

  const history = useResource(
    (signal) => api.getContractHistory(contractId, { signal }),
    [contractId],
    { enabled: !!contractId, reportLabel: 'contract-history' },
  );

  const items = Array.isArray(history.data)
    ? history.data
    : (Array.isArray(history.data?.items) ? history.data.items : []);

  const content = (
    <div className="HISTORY_SCREEN">
      <div className="hist-head">
        <div>
          <h2 className="hist-title">Audit &amp; History</h2>
          <p className="hist-sub">
            Every change, status transition and approval decision for this treaty,
            newest first. Read-only.
          </p>
        </div>
        <button
          type="button"
          className="hist-refresh"
          onClick={() => history.refetch()}
          aria-label="Refresh history"
        >
          <span aria-hidden="true">↻</span> Refresh
        </button>
      </div>

      {!contractId ? (
        <div className="hist-empty">Select a treaty first to view its history.</div>
      ) : (
        <AsyncBoundary loading={history.loading} error={history.error}
          onRetry={history.refetch} label="history">
          {items.length === 0 ? (
            <div className="hist-empty">No history recorded for this treaty yet.</div>
          ) : (
            <ol className="hist-timeline">
              {items.map((item) => (
                <HistoryItem key={item.id || `${item.source}-${item.at}-${item.type}`} item={item} />
              ))}
            </ol>
          )}
        </AsyncBoundary>
      )}
    </div>
  );

  return (
    <WizardLayout routeKey={routeKey} title={title} headerPill={headerPill} suppressSaveIndicator>
      {content}
    </WizardLayout>
  );
}
