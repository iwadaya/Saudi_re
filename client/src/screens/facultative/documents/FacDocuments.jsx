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
//
// Styling lives in the co-located FacDocuments.css (Phase 3.2 of the
// frontend-hardening effort); interactive chrome uses the ui/ design-
// system primitives (Button, Badge, Table, Modal).
import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import api from '../../../api';
import WizardLayout from '../../../components/WizardLayout';
import { useFacRiskId } from '../../../hooks/useContractId';
import { invalidateFacPendingRecsCache } from '../../../components/FacPendingRecsBanner';
import { Badge, Button, Modal, Table } from '../../../components/ui';
import './FacDocuments.css';

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

// Analysis status → ui Badge tone.
const STATUS_TONES = {
  PENDING:   'neutral',
  RUNNING:   'info',
  SUCCEEDED: 'success',
  FAILED:    'danger',
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
  return (
    <Badge tone={STATUS_TONES[status] || 'neutral'}>
      {status === 'RUNNING' ? 'Analysing…' : status}
    </Badge>
  );
}

// One-liner used in each document row's Status column. The cell is
// clickable when SUCCEEDED (opens the drawer in 4.3.c). FAILED rows
// expose a Retry button so a transient OpenAI error can be re-tried
// without going back to the file picker.
// Confidence-bar colour tiers used by both the drawer and any other
// surface that surfaces a recommendation card.
function confidenceColor(c) {
  const n = Number(c);
  if (!Number.isFinite(n)) return 'rgba(148,163,184,0.30)';
  if (n >= 0.85) return '#23d18b';
  if (n >= 0.5)  return '#fbbf24';
  return 'rgba(148,163,184,0.35)';
}

// Compact JSON renderer for the "Raw extracted fields" block in the
// drawer. Falls back to a stringified summary if the value isn't
// JSON-serialisable (shouldn't happen, but defends against weird
// payloads from older analyses).
function jsonPreview(v) {
  try { return JSON.stringify(v, null, 2); }
  catch { return String(v); }
}

// Per-recommendation editor + actions. Reads data_type semantics from
// the target_field name (factor.* / clause.* / *.append / cope.* /
// dates / numbers / generic text), so the drawer doesn't need a
// separate field-catalogue fetch.
function inferInputKind(targetField) {
  if (targetField.startsWith('factor.')) return 'FACTOR_OPTION';
  if (targetField.startsWith('clause.')) return 'CLAUSE_TOGGLE';
  if (targetField === 'location.append')   return 'LOCATION_ARRAY';
  if (targetField === 'loss_history.append') return 'LOSS_APPEND';
  if (/_date$/.test(targetField))          return 'DATE';
  if (targetField === 'occupancy_code')    return 'INT';
  // Heuristic: anything containing 'pct' / '_pm' / numeric COPE fields → number.
  if (/_pct$|_pm$|_km$|si$|years?$|_si$/i.test(targetField)) return 'NUMERIC';
  if (targetField.startsWith('cope.construction_year')) return 'INT';
  return 'TEXT';
}

function RecommendationCard({ rec, factorOptions, onAccept, onReject, busy, justApplied }) {
  const conf = Number(rec.confidence);
  const confPct = Number.isFinite(conf) ? Math.round(conf * 100) : null;
  const color = confidenceColor(conf);
  const isPending = rec.status === 'PENDING';
  const [editing, setEditing] = useState(false);
  const [editedValue, setEditedValue] = useState(() => formatForEditor(rec.suggested_value));
  const [rejectingOpen, setRejectingOpen] = useState(false);
  const [rejectReason, setRejectReason] = useState('');

  const inputKind = inferInputKind(rec.target_field);

  function formatForEditor(v) {
    if (v == null) return '';
    if (typeof v === 'string') return v;
    if (typeof v === 'number') return String(v);
    if (typeof v === 'boolean') return v ? 'true' : 'false';
    try { return JSON.stringify(v, null, 2); } catch { return String(v); }
  }

  function parseFromEditor(raw) {
    if (raw == null) return null;
    switch (inputKind) {
      case 'NUMERIC': {
        const n = Number(String(raw).replace(/,/g, '').trim());
        return Number.isFinite(n) ? n : null;
      }
      case 'INT': {
        const n = Number(String(raw).trim());
        return Number.isFinite(n) ? Math.trunc(n) : null;
      }
      case 'DATE': return String(raw).slice(0, 10) || null;
      case 'CLAUSE_TOGGLE': return raw === false || raw === 'false' ? false : true;
      case 'LOCATION_ARRAY':
      case 'LOSS_APPEND': {
        try { return JSON.parse(raw); }
        catch { return raw; } // server will likely fail; leave the bad value visible
      }
      case 'FACTOR_OPTION':
      case 'TEXT':
      default: return String(raw);
    }
  }

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
            <input className="fi facdoc-editor-field" type="number" value={editedValue}
                   onChange={(e) => setEditedValue(e.target.value)} />
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
                    onClick={() => onAccept(rec, parseFromEditor(editedValue))}>
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

      {justApplied && (
        <div className="facdoc-applied-row">
          <span>✓ Accepted just now</span>
          <Button size="sm" className="facdoc-btn--undo" disabled
                  title="Undo a recommendation acceptance — TODO: post a reversing change">
            Undo
          </Button>
        </div>
      )}
    </div>
  );
}

// target_screen → wizard route. Used by the "1 change applied to X"
// pill so the underwriter can hop straight to the screen affected
// by an accepted recommendation.
const SCREEN_ROUTES = {
  FAC_RISK_DETAIL:  'risk-detail',
  FAC_LOCATIONS:    'locations',
  FAC_COPE:         'cope',
  FAC_PRICING:      'pricing',
  FAC_LOSS_HISTORY: 'loss-history',
  FAC_DEDUCTIBLES:  'deductibles',
};

// Side drawer rendered when openAnalysisId is set. The Modal primitive
// supplies the backdrop, Esc-to-close, focus trap and aria-modal
// wiring; FacDocuments.css reshapes the panel into the right-hand
// drawer this screen has always used.
function AnalysisDrawer({ analysisId, riskId, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [extractedOpen, setExtractedOpen] = useState(false);
  // Factor-option master list (fetched once per drawer mount), used
  // by the FACTOR_OPTION editor inside RecommendationCard.
  const [factorOptions, setFactorOptions] = useState({});
  // Set of recommendation_ids currently being acted on so the cards
  // can disable their buttons concurrently during bulk accept.
  const [busyRecs, setBusyRecs] = useState(() => new Set());
  // recommendation_id → setTimeout handle so we can clear the
  // "Accepted just now" highlight after 10s.
  const justAppliedRef = useRef(new Map());
  const [justApplied, setJustApplied] = useState(() => new Map());
  // Pill at the top of the drawer pointing to the most recent
  // accepted screen ("1 change applied to Pricing").
  const [appliedPill, setAppliedPill] = useState(null);
  // Bulk action progress { total, done } or null.
  const [bulkProgress, setBulkProgress] = useState(null);
  // Persisted-across-opens UI state: keep group collapse memory
  // keyed by the screen, so reopening the drawer doesn't reset
  // expansion state the underwriter just configured.
  const groupCollapseRef = useRef({ ACCEPTED: false, REJECTED: true });

  useEffect(() => {
    if (!analysisId) return;
    setLoading(true);
    api.facGetAnalysis(analysisId)
      .then(setData)
      .catch((e) => console.error('[AnalysisDrawer] load failed:', e))
      .finally(() => setLoading(false));
    api.facGetFactors().then((r) => {
      const map = {};
      for (const f of r?.factors || []) {
        if (Array.isArray(f.options) && f.options.length > 0) {
          map[f.factor_code] = f.options.map((o) => o.option_label);
        }
      }
      setFactorOptions(map);
    }).catch(() => {});
  }, [analysisId]);

  // Clear any pending "just applied" timers on unmount.
  useEffect(() => () => {
    for (const h of justAppliedRef.current.values()) clearTimeout(h);
    justAppliedRef.current.clear();
  }, []);

  const reload = useCallback(() => {
    if (!analysisId) return;
    return api.facGetAnalysis(analysisId)
      .then(setData)
      .catch((e) => console.error('[AnalysisDrawer] reload failed:', e));
  }, [analysisId]);

  const markBusy = (id, busy) => {
    setBusyRecs((prev) => {
      const next = new Set(prev);
      if (busy) next.add(id); else next.delete(id);
      return next;
    });
  };

  const flashApplied = (id) => {
    setJustApplied((prev) => {
      const next = new Map(prev);
      next.set(id, Date.now());
      return next;
    });
    const handle = setTimeout(() => {
      setJustApplied((prev) => {
        const next = new Map(prev);
        next.delete(id);
        return next;
      });
      justAppliedRef.current.delete(id);
    }, 10_000);
    justAppliedRef.current.set(id, handle);
  };

  const onAccept = useCallback(async (rec, overrideValue) => {
    markBusy(rec.recommendation_id, true);
    try {
      const payload = overrideValue !== undefined ? { override_value: overrideValue } : {};
      await api.facAcceptRecommendation(rec.recommendation_id, payload);
      flashApplied(rec.recommendation_id);
      setAppliedPill({ screen: rec.target_screen, field: rec.target_field });
      invalidateFacPendingRecsCache(riskId);
      await reload();
    } catch (e) {
      console.error('[AnalysisDrawer] accept failed:', e);
    } finally {
      markBusy(rec.recommendation_id, false);
    }
  }, [reload, riskId]);

  const onReject = useCallback(async (rec, reason) => {
    markBusy(rec.recommendation_id, true);
    try {
      await api.facRejectRecommendation(rec.recommendation_id, reason ? { reason } : {});
      invalidateFacPendingRecsCache(riskId);
      await reload();
    } catch (e) {
      console.error('[AnalysisDrawer] reject failed:', e);
    } finally {
      markBusy(rec.recommendation_id, false);
    }
  }, [reload, riskId]);

  // Bulk "Accept all ≥ 0.85". Fires the accept endpoint sequentially
  // with a concurrency cap of 3 so we don't melt the apply-dispatch
  // under a 20-recommendation drop.
  const onAcceptHighConfidence = useCallback(async () => {
    if (!data) return;
    const pool = (data.recommendations || []).filter(
      (r) => r.status === 'PENDING' && Number(r.confidence) >= 0.85,
    );
    if (pool.length === 0) return;
    const ok = typeof window !== 'undefined'
      ? window.confirm(`Accept ${pool.length} recommendation(s) with confidence ≥ 0.85?`)
      : true;
    if (!ok) return;
    setBulkProgress({ total: pool.length, done: 0 });
    const concurrency = 3;
    let cursor = 0;
    let done = 0;
    let lastScreen = null;
    async function next() {
      while (cursor < pool.length) {
        const rec = pool[cursor++];
        markBusy(rec.recommendation_id, true);
        try {
          await api.facAcceptRecommendation(rec.recommendation_id, {});
          flashApplied(rec.recommendation_id);
          lastScreen = rec.target_screen;
        } catch (e) {
          console.error('[AnalysisDrawer] bulk accept item failed:', e);
        } finally {
          markBusy(rec.recommendation_id, false);
          done += 1;
          setBulkProgress({ total: pool.length, done });
        }
      }
    }
    await Promise.all(Array.from({ length: Math.min(concurrency, pool.length) }, next));
    setBulkProgress(null);
    if (lastScreen) setAppliedPill({ screen: lastScreen, field: null, bulk: pool.length });
    invalidateFacPendingRecsCache(riskId);
    await reload();
  }, [data, reload, riskId]);

  if (!analysisId) return null;

  const analysis = data?.analysis;
  const recs = data?.recommendations || [];
  // Group: PENDING expanded by default, ACCEPTED expanded, REJECTED
  // collapsed. Order matters in the UI — show PENDING first.
  const grouped = { PENDING: [], ACCEPTED: [], REJECTED: [], SUPERSEDED: [] };
  for (const r of recs) (grouped[r.status] || (grouped.PENDING)).push(r);
  // Within each status group, sub-group by target_screen so the
  // underwriter sees per-screen impact at a glance.
  const groupByScreen = (list) => {
    const m = new Map();
    for (const r of list) {
      if (!m.has(r.target_screen)) m.set(r.target_screen, []);
      m.get(r.target_screen).push(r);
    }
    return Array.from(m.entries());
  };

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
          {(() => {
            const hi = grouped.PENDING.filter((r) => Number(r.confidence) >= 0.85);
            if (hi.length === 0) return null;
            return (
              <div className="facdoc-bulk">
                <Button size="sm" className="facdoc-btn--bulk-accept"
                        disabled={!!bulkProgress} onClick={onAcceptHighConfidence}>
                  Accept all ≥ 85% confidence ({hi.length})
                </Button>
                {bulkProgress && (
                  <span className="facdoc-bulk-progress">
                    {bulkProgress.done} / {bulkProgress.total} done
                  </span>
                )}
              </div>
            );
          })()}

          {/* Recommendations */}
          <div className="facdoc-recs">
            <div className="facdoc-section-label facdoc-section-label--recs">
              Recommendations ({recs.length})
            </div>
            {recs.length === 0 ? (
              <div className="facdoc-empty-recs">
                The model returned no actionable suggestions for this document.
              </div>
            ) : null}

            {/* PENDING — open by default */}
            <RecGroup title="Pending" status="PENDING" groups={groupByScreen(grouped.PENDING)}
                      startCollapsed={false}
                      cardProps={{ factorOptions, onAccept, onReject, busyRecs, justApplied }} />
            {grouped.ACCEPTED.length > 0 && (
              <RecGroup title="Accepted" status="ACCEPTED" groups={groupByScreen(grouped.ACCEPTED)}
                        startCollapsed={Boolean(groupCollapseRef.current.ACCEPTED)}
                        cardProps={{ factorOptions, onAccept, onReject, busyRecs, justApplied }} />
            )}
            {grouped.SUPERSEDED.length > 0 && (
              <RecGroup title="Superseded" status="SUPERSEDED" groups={groupByScreen(grouped.SUPERSEDED)}
                        startCollapsed
                        cardProps={{ factorOptions, onAccept, onReject, busyRecs, justApplied }} />
            )}
            {grouped.REJECTED.length > 0 && (
              <RecGroup title="Rejected" status="REJECTED" groups={groupByScreen(grouped.REJECTED)}
                        startCollapsed={Boolean(groupCollapseRef.current.REJECTED)}
                        cardProps={{ factorOptions, onAccept, onReject, busyRecs, justApplied }} />
            )}
          </div>
        </div>
      )}
    </Modal>
  );
}

// Collapsible status group containing per-screen sub-groups.
const REC_GROUP_TOGGLE_CLASS = {
  PENDING:    'facdoc-group-toggle--pending',
  ACCEPTED:   'facdoc-group-toggle--accepted',
  REJECTED:   'facdoc-group-toggle--rejected',
  SUPERSEDED: 'facdoc-group-toggle--superseded',
};

function RecGroup({ title, status, groups, startCollapsed = false, cardProps = {} }) {
  const [collapsed, setCollapsed] = useState(startCollapsed);
  const toneClass = REC_GROUP_TOGGLE_CLASS[status] || REC_GROUP_TOGGLE_CLASS.PENDING;
  const totalCount = groups.reduce((s, [, r]) => s + r.length, 0);
  if (totalCount === 0) return null;
  const { factorOptions, onAccept, onReject, busyRecs, justApplied } = cardProps;
  return (
    <div className="facdoc-group">
      <button type="button" aria-expanded={!collapsed}
              className={`facdoc-disclosure facdoc-disclosure--group ${toneClass}`}
              onClick={() => setCollapsed((v) => !v)}>
        <span>{collapsed ? '▸' : '▾'}</span>
        <span>{title}</span>
        <span className="facdoc-group-count">· {totalCount}</span>
      </button>
      {!collapsed && groups.map(([screen, list]) => (
        <div key={screen} className="facdoc-group-screen">
          <div className="facdoc-screen-label">
            {screen}
          </div>
          {list.map((rec) => (
            <RecommendationCard key={rec.recommendation_id} rec={rec}
                                factorOptions={factorOptions}
                                onAccept={onAccept} onReject={onReject}
                                busy={busyRecs?.has(rec.recommendation_id)}
                                justApplied={justApplied?.has(rec.recommendation_id)} />
          ))}
        </div>
      ))}
    </div>
  );
}

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

  // onReAnalyse is defined later (it depends on pollAnalysis, which
  // is declared further down). See the block after pollAnalysis.

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

  const handleDelete = async (docId) => {
    try {
      await api.facDeleteDocument(docId);
      load();
    } catch (e) { console.error(e); }
  };

  return (
    <WizardLayout routeKey={ROUTE_KEY} title="Documents" headerPill="FACULTATIVE">
      <div className="facdoc-page">
        <div className="facdoc-intro">
          Upload placement slips, surveys, bordereaux, COPE reports and wordings.
          The AI runner extracts data and proposes edits on each downstream screen.
        </div>

        {/* Upload zone */}
        <div
          className={`facdoc-dropzone${draggingOver ? ' facdoc-dropzone--active' : ''}`}
          onDragOver={(e) => { e.preventDefault(); setDraggingOver(true); }}
          onDragLeave={() => setDraggingOver(false)}
          onDrop={onDrop}
        >
          {!pendingFile ? (
            <div className="facdoc-dropzone-idle">
              <div className="facdoc-dropzone-title">
                Drag &amp; drop a document, or pick a file
              </div>
              <div className="facdoc-dropzone-hint">
                Up to 20 MB · PDFs preferred · the AI analyser uses the file kind you pick
              </div>
              <input ref={fileInputRef} type="file" className="facdoc-file-input"
                     onChange={(e) => onPickFile(e.target.files?.[0])} />
              <Button className="facdoc-btn--choose"
                      onClick={() => fileInputRef.current?.click()}>Choose file</Button>
            </div>
          ) : (
            <div className="facdoc-upload-row">
              <div>
                <div className="facdoc-upload-name">{pendingFile.name}</div>
                <div className="facdoc-upload-meta">
                  {fmtBytes(pendingFile.size)} · {pendingFile.type || 'application/octet-stream'}
                </div>
                <button type="button" className="facdoc-linkbtn facdoc-link-remove"
                        onClick={() => setPendingFile(null)}>
                  remove
                </button>
              </div>
              <div>
                <div className="facdoc-kind-label">Document kind</div>
                <select className="fi" value={pendingKind} onChange={(e) => setPendingKind(e.target.value)}>
                  {AI_KINDS.map(([code, label]) => <option key={code} value={code}>{label}</option>)}
                </select>
              </div>
              <Button variant="primary" className="facdoc-btn--upload" disabled={uploading}
                      onClick={onUploadAndAnalyse}>
                {uploading ? 'Uploading…' : 'Upload & analyse'}
              </Button>
            </div>
          )}
        </div>

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
                      <DocStatusCell analysis={analysis} onOpen={() => setOpenAnalysisId(analysis?.analysis_id || null)}
                                     onRetry={() => onReAnalyse(d.document_id, kind)} reanalysing={reanalysing} />
                    </td>
                    <td className="facdoc-td-actions">
                      <button type="button" className="facdoc-linkbtn facdoc-link-view"
                              disabled={analysis?.status !== 'SUCCEEDED'}
                              onClick={() => analysis?.status === 'SUCCEEDED' && setOpenAnalysisId(analysis.analysis_id)}>
                        View
                      </button>
                      <button type="button" className="facdoc-linkbtn facdoc-link-reanalyse"
                              disabled={reanalysing}
                              onClick={() => !reanalysing && onReAnalyse(d.document_id, kind)}>
                        {reanalysing ? 'Re-analysing…' : 'Re-analyse'}
                      </button>
                      <button type="button" className="facdoc-linkbtn facdoc-link-delete"
                              onClick={() => handleDelete(d.document_id)}>Delete</button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </Table>
        )}
      </div>

      <AnalysisDrawer analysisId={openAnalysisId} riskId={riskId}
                       onClose={() => setOpenAnalysisId(null)} />
    </WizardLayout>
  );
}
