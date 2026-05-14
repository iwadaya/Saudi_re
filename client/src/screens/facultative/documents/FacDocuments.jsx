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
import { useSearchParams } from 'react-router-dom';
import api from '../../../api';
import WizardLayout from '../../../components/WizardLayout';
import { useFacRiskId } from '../../../hooks/useContractId';
import { invalidateFacPendingRecsCache } from '../../../components/FacPendingRecsBanner';

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
    <div style={{ padding: '12px 14px', borderRadius: 10,
                   background: justApplied ? 'rgba(35,209,139,0.07)' : 'rgba(8,14,30,0.55)',
                   border: justApplied ? '1px solid rgba(35,209,139,0.40)' : '1px solid rgba(255,255,255,0.06)',
                   marginBottom: 8, transition: 'background 0.6s, border-color 0.6s' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center',
                     marginBottom: 6 }}>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <span style={{ padding: '2px 8px', borderRadius: 20, fontSize: 9, fontWeight: 800,
                          letterSpacing: '.10em', background: 'rgba(168,85,247,0.10)',
                          border: '1px solid rgba(168,85,247,0.30)', color: '#a855f7' }}>
            {rec.target_screen}
          </span>
          <span style={{ fontSize: 11, fontWeight: 700, color: 'rgba(226,232,240,0.85)',
                          fontFamily: 'monospace' }}>{rec.target_field}</span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <div style={{ width: 64, height: 6, borderRadius: 3,
                          background: 'rgba(148,163,184,0.10)', overflow: 'hidden' }}>
            <div style={{ width: `${confPct ?? 0}%`, height: '100%', background: color }} />
          </div>
          <span style={{ fontSize: 10, fontWeight: 800, color }}>
            {confPct == null ? '—' : `${confPct}%`}
          </span>
        </div>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr auto 1fr', gap: 8,
                     alignItems: 'center', marginBottom: 8, fontSize: 11 }}>
        <div style={{ padding: '6px 10px', borderRadius: 6,
                       background: 'rgba(148,163,184,0.05)',
                       border: '1px solid rgba(148,163,184,0.15)',
                       color: 'rgba(226,232,240,0.65)',
                       fontFamily: 'monospace', wordBreak: 'break-word' }}>
          {rec.current_value === null || rec.current_value === undefined
            ? <span style={{ color: 'rgba(148,163,184,0.40)' }}>—</span>
            : jsonPreview(rec.current_value)}
        </div>
        <div style={{ color: 'rgba(35,209,139,0.65)', fontSize: 14, fontWeight: 700 }}>→</div>
        <div style={{ padding: '6px 10px', borderRadius: 6,
                       background: 'rgba(35,209,139,0.05)',
                       border: '1px solid rgba(35,209,139,0.20)',
                       color: '#e2e8f0',
                       fontFamily: 'monospace', wordBreak: 'break-word' }}>
          {jsonPreview(rec.suggested_value)}
        </div>
      </div>
      <div style={{ fontSize: 11, color: 'rgba(148,163,184,0.70)', fontStyle: 'italic',
                     lineHeight: 1.4, marginBottom: editing || rejectingOpen ? 8 : 0 }}>
        “{rec.rationale}”
      </div>

      {editing && (
        <div style={{ marginTop: 8, padding: '8px 10px',
                       background: 'rgba(0,212,255,0.04)',
                       border: '1px solid rgba(0,212,255,0.25)', borderRadius: 6 }}>
          <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.12em',
                         textTransform: 'uppercase', color: 'rgba(0,212,255,0.65)', marginBottom: 6 }}>
            Override value · {inputKind.toLowerCase()}
          </div>
          {inputKind === 'FACTOR_OPTION' && (() => {
            const code = rec.target_field.replace(/^factor\./, '');
            const opts = factorOptions?.[code] || [];
            return (
              <select className="fi" value={editedValue}
                      onChange={(e) => setEditedValue(e.target.value)}
                      style={{ width: '100%', fontSize: 12 }}>
                {opts.map((o) => <option key={o} value={o}>{o}</option>)}
              </select>
            );
          })()}
          {inputKind === 'DATE' && (
            <input className="fi" type="date" value={editedValue || ''}
                   onChange={(e) => setEditedValue(e.target.value)}
                   style={{ width: '100%', fontSize: 12 }} />
          )}
          {(inputKind === 'NUMERIC' || inputKind === 'INT') && (
            <input className="fi" type="number" value={editedValue}
                   onChange={(e) => setEditedValue(e.target.value)}
                   style={{ width: '100%', fontSize: 12 }} />
          )}
          {(inputKind === 'LOCATION_ARRAY' || inputKind === 'LOSS_APPEND') && (
            <textarea className="fi" rows={5} value={editedValue}
                      onChange={(e) => setEditedValue(e.target.value)}
                      style={{ width: '100%', fontFamily: 'monospace', fontSize: 11 }} />
          )}
          {inputKind === 'CLAUSE_TOGGLE' && (
            <select className="fi" value={editedValue === 'false' ? 'false' : 'true'}
                    onChange={(e) => setEditedValue(e.target.value)}
                    style={{ width: '100%', fontSize: 12 }}>
              <option value="true">Checked</option>
              <option value="false">Unchecked</option>
            </select>
          )}
          {inputKind === 'TEXT' && (
            <input className="fi" value={editedValue}
                   onChange={(e) => setEditedValue(e.target.value)}
                   style={{ width: '100%', fontSize: 12 }} />
          )}
          <div style={{ marginTop: 8, display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button onClick={() => setEditing(false)}
                    style={{ appearance: 'none', border: '1px solid rgba(148,163,184,0.20)',
                              background: 'transparent', color: 'rgba(226,232,240,0.80)',
                              borderRadius: 6, padding: '4px 10px', fontSize: 11, cursor: 'pointer' }}>
              Cancel
            </button>
            <button disabled={busy}
                    onClick={() => onAccept(rec, parseFromEditor(editedValue))}
                    style={{ appearance: 'none', border: '1px solid rgba(35,209,139,0.40)',
                              background: 'rgba(35,209,139,0.10)', color: '#23d18b',
                              borderRadius: 6, padding: '4px 12px', fontSize: 11, fontWeight: 700,
                              cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1 }}>
              Confirm override
            </button>
          </div>
        </div>
      )}

      {rejectingOpen && (
        <div style={{ marginTop: 8, padding: '8px 10px',
                       background: 'rgba(248,113,113,0.04)',
                       border: '1px solid rgba(248,113,113,0.25)', borderRadius: 6 }}>
          <textarea className="fi" rows={3} value={rejectReason}
                    onChange={(e) => setRejectReason(e.target.value)}
                    placeholder="Optional reason…"
                    style={{ width: '100%', fontSize: 12, resize: 'vertical' }} />
          <div style={{ marginTop: 8, display: 'flex', gap: 6, justifyContent: 'flex-end' }}>
            <button onClick={() => setRejectingOpen(false)}
                    style={{ appearance: 'none', border: '1px solid rgba(148,163,184,0.20)',
                              background: 'transparent', color: 'rgba(226,232,240,0.80)',
                              borderRadius: 6, padding: '4px 10px', fontSize: 11, cursor: 'pointer' }}>
              Cancel
            </button>
            <button disabled={busy}
                    onClick={() => onReject(rec, rejectReason)}
                    style={{ appearance: 'none', border: '1px solid rgba(248,113,113,0.40)',
                              background: 'rgba(248,113,113,0.10)', color: '#f87171',
                              borderRadius: 6, padding: '4px 12px', fontSize: 11, fontWeight: 700,
                              cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1 }}>
              Confirm reject
            </button>
          </div>
        </div>
      )}

      {!editing && !rejectingOpen && isPending && !justApplied && (
        <div style={{ marginTop: 8, display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <button onClick={() => onAccept(rec, undefined)} disabled={busy}
                  style={{ appearance: 'none', border: '1px solid rgba(35,209,139,0.40)',
                            background: 'rgba(35,209,139,0.10)', color: '#23d18b',
                            borderRadius: 6, padding: '4px 12px', fontSize: 11, fontWeight: 700,
                            cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1 }}>
            Accept
          </button>
          <button onClick={() => { setEditedValue(formatForEditor(rec.suggested_value)); setEditing(true); }}
                  disabled={busy}
                  style={{ appearance: 'none', border: '1px solid rgba(0,212,255,0.40)',
                            background: 'rgba(0,212,255,0.08)', color: '#00d4ff',
                            borderRadius: 6, padding: '4px 12px', fontSize: 11, fontWeight: 700,
                            cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1 }}>
            Edit & Accept
          </button>
          <button onClick={() => { setRejectReason(''); setRejectingOpen(true); }}
                  disabled={busy}
                  style={{ appearance: 'none', border: '1px solid rgba(248,113,113,0.40)',
                            background: 'rgba(248,113,113,0.08)', color: '#f87171',
                            borderRadius: 6, padding: '4px 12px', fontSize: 11, fontWeight: 700,
                            cursor: busy ? 'not-allowed' : 'pointer', opacity: busy ? 0.5 : 1 }}>
            Reject
          </button>
        </div>
      )}

      {justApplied && (
        <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 8,
                       fontSize: 11, color: '#23d18b' }}>
          <span>✓ Accepted just now</span>
          <button disabled
                  title="Undo a recommendation acceptance — TODO: post a reversing change"
                  style={{ appearance: 'none', border: '1px dashed rgba(35,209,139,0.30)',
                            background: 'transparent', color: 'rgba(35,209,139,0.55)',
                            borderRadius: 6, padding: '2px 10px', fontSize: 10,
                            cursor: 'not-allowed', opacity: 0.65 }}>
            Undo
          </button>
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

// Side drawer rendered when openAnalysisId is set.
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

  // Close on Esc — installed once per open.
  useEffect(() => {
    if (!analysisId) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [analysisId, onClose]);

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
    <>
      {/* Outside-click backdrop */}
      <div onClick={onClose} style={{
        position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.45)', zIndex: 800,
      }} />
      {/* Drawer */}
      <aside onClick={(e) => e.stopPropagation()} style={{
        position: 'fixed', top: 0, right: 0, bottom: 0, width: 520,
        background: '#0a1422', borderLeft: '1px solid rgba(255,255,255,0.08)',
        zIndex: 900, overflowY: 'auto',
      }}>
        {loading || !analysis ? (
          <div style={{ padding: 30, textAlign: 'center', color: 'rgba(148,163,184,0.45)' }}>
            Loading analysis…
          </div>
        ) : (
          <div>
            {/* Header */}
            <div style={{ padding: '18px 20px', borderBottom: '1px solid rgba(255,255,255,0.06)' }}>
              <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                             marginBottom: 8 }}>
                <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.14em',
                                textTransform: 'uppercase', color: 'rgba(0,212,255,0.55)' }}>
                  AI Analysis
                </span>
                <span onClick={onClose} style={{ cursor: 'pointer', color: 'rgba(148,163,184,0.65)',
                                                   fontSize: 18 }}>×</span>
              </div>
              <div style={{ fontSize: 14, fontWeight: 800, color: '#e2e8f0' }}>
                {analysis.document_filename || 'Untitled document'}
              </div>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 6,
                             flexWrap: 'wrap' }}>
                <span style={{ padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 700,
                                background: 'rgba(0,212,255,0.08)', border: '1px solid rgba(0,212,255,0.20)',
                                color: '#00d4ff' }}>
                  {AI_KIND_LABELS[analysis.analysis_kind] || analysis.analysis_kind}
                </span>
                <StatusChip status={analysis.status} />
                <span style={{ fontSize: 10, color: 'rgba(148,163,184,0.45)' }}>
                  {analysis.completed_at
                    ? `analysed ${new Date(analysis.completed_at).toLocaleString()}`
                    : analysis.started_at
                      ? `started ${new Date(analysis.started_at).toLocaleString()}`
                      : ''}
                </span>
              </div>
            </div>

            {/* Summary */}
            <div style={{ padding: '16px 20px' }}>
              <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.12em',
                             textTransform: 'uppercase', color: 'rgba(148,163,184,0.45)',
                             marginBottom: 6 }}>Summary</div>
              <div style={{ fontSize: 12, lineHeight: 1.6, color: 'rgba(226,232,240,0.85)' }}>
                {analysis.summary || <span style={{ color: 'rgba(148,163,184,0.40)' }}>
                  No summary — analysis may have failed.
                </span>}
              </div>
              {analysis.status === 'FAILED' && analysis.error && (
                <div style={{ marginTop: 10, padding: '8px 12px', fontSize: 11,
                               background: 'rgba(248,113,113,0.08)',
                               border: '1px solid rgba(248,113,113,0.25)',
                               color: '#f87171', borderRadius: 6 }}>
                  {analysis.error}
                </div>
              )}
            </div>

            {/* Extracted JSON (collapsible) */}
            <div style={{ padding: '6px 20px 14px' }}>
              <div onClick={() => setExtractedOpen((v) => !v)}
                   style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
                            fontSize: 10, fontWeight: 800, letterSpacing: '.12em',
                            textTransform: 'uppercase', color: 'rgba(148,163,184,0.55)',
                            marginBottom: 6 }}>
                <span>{extractedOpen ? '▾' : '▸'}</span>
                <span>Raw extracted fields</span>
              </div>
              {extractedOpen && (
                <pre style={{ margin: 0, padding: '10px 12px', borderRadius: 6,
                                background: 'rgba(5,8,16,0.55)', fontSize: 10,
                                color: 'rgba(226,232,240,0.80)', overflowX: 'auto',
                                maxHeight: 280 }}>
                  {jsonPreview(analysis.extracted || {})}
                </pre>
              )}
            </div>

            {/* Applied-pill — links to the affected screen. */}
            {appliedPill && (
              <div style={{ margin: '4px 20px 8px', display: 'inline-flex' }}>
                <div style={{ padding: '4px 12px', borderRadius: 20, fontSize: 11,
                                background: 'rgba(35,209,139,0.10)',
                                border: '1px solid rgba(35,209,139,0.30)',
                                color: '#23d18b' }}>
                  {appliedPill.bulk
                    ? `${appliedPill.bulk} changes applied · ${appliedPill.screen}`
                    : `1 change applied · ${appliedPill.screen}`}
                  {' '}
                  <a href={`/fac/${analysis.fac_risk_id}/${SCREEN_ROUTES[appliedPill.screen] || ''}`}
                     style={{ color: '#23d18b', textDecoration: 'underline', marginLeft: 4 }}>
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
                <div style={{ padding: '0 20px 8px', display: 'flex', alignItems: 'center', gap: 10 }}>
                  <button onClick={onAcceptHighConfidence} disabled={!!bulkProgress}
                          style={{ appearance: 'none', border: '1px solid rgba(35,209,139,0.40)',
                                    background: 'rgba(35,209,139,0.08)', color: '#23d18b',
                                    borderRadius: 6, padding: '6px 12px', fontSize: 11, fontWeight: 700,
                                    cursor: bulkProgress ? 'not-allowed' : 'pointer',
                                    opacity: bulkProgress ? 0.5 : 1 }}>
                    Accept all ≥ 85% confidence ({hi.length})
                  </button>
                  {bulkProgress && (
                    <span style={{ fontSize: 11, color: 'rgba(148,163,184,0.65)' }}>
                      {bulkProgress.done} / {bulkProgress.total} done
                    </span>
                  )}
                </div>
              );
            })()}

            {/* Recommendations */}
            <div style={{ padding: '6px 20px 30px' }}>
              <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.12em',
                             textTransform: 'uppercase', color: 'rgba(148,163,184,0.55)',
                             marginBottom: 8 }}>
                Recommendations ({recs.length})
              </div>
              {recs.length === 0 ? (
                <div style={{ fontSize: 11, color: 'rgba(148,163,184,0.40)' }}>
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
      </aside>
    </>
  );
}

// Collapsible status group containing per-screen sub-groups.
function RecGroup({ title, status, groups, startCollapsed = false, cardProps = {} }) {
  const [collapsed, setCollapsed] = useState(startCollapsed);
  const STATUS_TONE = {
    PENDING:   { color: '#00d4ff' },
    ACCEPTED:  { color: '#23d18b' },
    REJECTED:  { color: '#f87171' },
    SUPERSEDED:{ color: 'rgba(148,163,184,0.60)' },
  };
  const tone = STATUS_TONE[status] || STATUS_TONE.PENDING;
  const totalCount = groups.reduce((s, [, r]) => s + r.length, 0);
  if (totalCount === 0) return null;
  const { factorOptions, onAccept, onReject, busyRecs, justApplied } = cardProps;
  return (
    <div style={{ marginBottom: 14 }}>
      <div onClick={() => setCollapsed((v) => !v)}
           style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer',
                    fontSize: 10, fontWeight: 800, letterSpacing: '.10em',
                    textTransform: 'uppercase', color: tone.color, marginBottom: 6 }}>
        <span>{collapsed ? '▸' : '▾'}</span>
        <span>{title}</span>
        <span style={{ color: 'rgba(148,163,184,0.45)', fontWeight: 700 }}>· {totalCount}</span>
      </div>
      {!collapsed && groups.map(([screen, list]) => (
        <div key={screen} style={{ marginBottom: 8 }}>
          <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.12em',
                         color: 'rgba(148,163,184,0.45)', marginBottom: 4 }}>
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
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 10, height: 10, borderRadius: 5,
                       border: '2px solid rgba(0,212,255,0.30)',
                       borderTopColor: '#00d4ff', display: 'inline-block',
                       animation: 'spin 0.9s linear infinite' }} />
        <span style={{ fontSize: 11, color: '#00d4ff' }}>Analysing…</span>
      </div>
    );
  }
  if (!analysis) {
    return <span style={{ fontSize: 11, color: 'rgba(148,163,184,0.35)' }}>—</span>;
  }
  if (analysis.status === 'RUNNING' || analysis.status === 'PENDING') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ width: 10, height: 10, borderRadius: 5,
                       border: '2px solid rgba(0,212,255,0.30)',
                       borderTopColor: '#00d4ff', display: 'inline-block',
                       animation: 'spin 0.9s linear infinite' }} />
        <span style={{ fontSize: 11, color: '#00d4ff' }}>Analysing…</span>
      </div>
    );
  }
  if (analysis.status === 'SUCCEEDED') {
    return (
      <span onClick={onOpen} style={{ cursor: 'pointer', fontSize: 11, fontWeight: 700,
                                       color: '#23d18b' }}>
        Succeeded — {analysis.recommendation_count ?? 0} recommendation{analysis.recommendation_count === 1 ? '' : 's'}
        {analysis.pending_count ? (
          <span style={{ marginLeft: 6, fontSize: 10, color: 'rgba(35,209,139,0.55)' }}>
            ({analysis.pending_count} pending)
          </span>
        ) : null}
      </span>
    );
  }
  if (analysis.status === 'FAILED') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ fontSize: 11, fontWeight: 700, color: '#f87171' }}
              title={analysis.error || ''}>
          Failed{analysis.error ? ` — ${String(analysis.error).slice(0, 70)}${analysis.error.length > 70 ? '…' : ''}` : ''}
        </span>
        <button onClick={onRetry} style={{
          appearance: 'none', border: '1px solid rgba(248,113,113,0.30)',
          background: 'rgba(248,113,113,0.05)', color: '#f87171',
          borderRadius: 6, padding: '2px 8px', fontSize: 10, fontWeight: 700,
          cursor: 'pointer',
        }}>Retry</button>
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
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
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
                {['Filename', 'Kind', 'Size', 'Uploaded by', 'Status', 'Actions'].map((h) => (
                  <th key={h} style={{ padding: '8px 12px', textAlign: 'left', fontSize: 9, fontWeight: 800,
                                       letterSpacing: '.12em', textTransform: 'uppercase',
                                       color: 'rgba(148,163,184,0.50)',
                                       borderBottom: '1px solid rgba(255,255,255,0.08)' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {sortedDocs.map((d) => {
                const kind = d.document_kind || d.doc_type || 'OTHER';
                const analysis = latestAnalysisByDoc.get(d.document_id);
                const reanalysing = reAnalyseBusyRef.current === d.document_id;
                return (
                  <tr key={d.document_id} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                    <td style={{ padding: '10px 12px' }}>
                      <div style={{ fontWeight: 600, color: 'rgba(226,232,240,0.85)' }}>{d.file_name || '—'}</div>
                      <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.40)', marginTop: 2 }}>
                        {d.uploaded_at || d.created_at
                          ? new Date(d.uploaded_at || d.created_at).toLocaleString()
                          : '—'}
                      </div>
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      <span style={{ padding: '2px 8px', borderRadius: 20, fontSize: 10, fontWeight: 700,
                                     background: 'rgba(0,212,255,0.08)', border: '1px solid rgba(0,212,255,0.20)',
                                     color: '#00d4ff' }}>
                        {AI_KIND_LABELS[kind] || kind}
                      </span>
                    </td>
                    <td style={{ padding: '10px 12px', color: 'rgba(148,163,184,0.55)' }}>
                      {fmtBytes(d.byte_size || d.file_size)}
                    </td>
                    <td style={{ padding: '10px 12px', fontSize: 11, color: 'rgba(148,163,184,0.65)' }}>
                      {d.uploaded_by_user_id ? d.uploaded_by_user_id.slice(0, 8) : (d.uploaded_by || '—')}
                    </td>
                    <td style={{ padding: '10px 12px' }}>
                      <DocStatusCell analysis={analysis} onOpen={() => setOpenAnalysisId(analysis?.analysis_id || null)}
                                     onRetry={() => onReAnalyse(d.document_id, kind)} reanalysing={reanalysing} />
                    </td>
                    <td style={{ padding: '10px 12px', whiteSpace: 'nowrap' }}>
                      <span style={{ cursor: analysis?.status === 'SUCCEEDED' ? 'pointer' : 'not-allowed',
                                      color: analysis?.status === 'SUCCEEDED' ? '#00d4ff' : 'rgba(148,163,184,0.30)',
                                      fontSize: 11, fontWeight: 600, marginRight: 12 }}
                             onClick={() => analysis?.status === 'SUCCEEDED' && setOpenAnalysisId(analysis.analysis_id)}>
                        View
                      </span>
                      <span style={{ cursor: reanalysing ? 'not-allowed' : 'pointer',
                                      color: reanalysing ? 'rgba(148,163,184,0.30)' : '#fbbf24',
                                      fontSize: 11, fontWeight: 600, marginRight: 12 }}
                             onClick={() => !reanalysing && onReAnalyse(d.document_id, kind)}>
                        {reanalysing ? 'Re-analysing…' : 'Re-analyse'}
                      </span>
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

      <AnalysisDrawer analysisId={openAnalysisId} riskId={riskId}
                       onClose={() => setOpenAnalysisId(null)} />
    </WizardLayout>
  );
}
