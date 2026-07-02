// client/src/components/market/MarketIntelligenceModal.jsx
//
// Child modal that opens from inside PropOfferModal / the NP equivalent.
// Two prompt scopes live here:
//
//   8.5.a — shell, fetch state machine, refresh, ESC/backdrop close,
//           6 section containers, footer.
//   8.5.b — section bodies (executive summary, market landscape,
//           treaty-vs-market, trends, recommendations with stage/reject,
//           sources).
//
// Sits one z-index above the parent offer modal. The fetch flow is
// deliberately separated into three states so the long-running
// generate-report call (web_search loops) shows progress prose.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api, HttpError } from '../../api';
import { useGlobalToast } from '../../hooks/useToast.js';

// REPORT_VIEWED audit debounce. Tracks (report_id, contract_id) pairs
// already logged in this browser session so opening the modal twice
// for the same treaty/report only writes one audit row. Cleared on
// page reload, which is the desired session granularity.
const _viewLogged = new Set();

// Source URLs come from the AI/model-generated report, so they are untrusted.
// React does not block javascript:/data: URLs bound to href, so only surface a
// clickable anchor for plain http(s) links; anything else renders as text.
function safeHref(url) {
  return typeof url === 'string' && /^https?:\/\//i.test(url) ? url : null;
}

const STATES = {
  LOADING_REPORT:     'LOADING_REPORT',
  GENERATING_REPORT:  'GENERATING_REPORT',
  LOADING_BENCHMARKS: 'LOADING_BENCHMARKS',
  LOADING_RECS:       'LOADING_RECS',
  GENERATING_RECS:    'GENERATING_RECS',
  READY:              'READY',
  ERROR:              'ERROR',
};

const PROGRESS_MESSAGES = [
  'Searching market reports…',
  'Reading regulator filings…',
  'Compiling benchmarks…',
  'Drafting recommendations…',
];

const VERDICT_STYLE = {
  BETTER:  { bg: 'rgba(74,222,128,0.10)',  border: 'rgba(74,222,128,0.35)',  fg: '#4ade80' },
  ON_PAR:  { bg: 'rgba(251,191,36,0.10)',  border: 'rgba(251,191,36,0.35)',  fg: '#fbbf24' },
  WORSE:   { bg: 'rgba(248,113,113,0.10)', border: 'rgba(248,113,113,0.35)', fg: '#f87171' },
  NO_DATA: { bg: 'rgba(255,255,255,0.06)', border: 'rgba(255,255,255,0.18)', fg: 'rgba(255,255,255,0.55)' },
};

const SEVERITY_STYLE = {
  INFO:        { bg: 'rgba(96,165,250,0.08)',  border: 'rgba(96,165,250,0.30)',  fg: '#60a5fa', icon: 'ℹ' },
  WARNING:     { bg: 'rgba(251,191,36,0.08)',  border: 'rgba(251,191,36,0.30)',  fg: '#fbbf24', icon: '⚠' },
  OPPORTUNITY: { bg: 'rgba(74,222,128,0.08)',  border: 'rgba(74,222,128,0.30)',  fg: '#4ade80', icon: '↑' },
};

const ACTION_PILL_STYLE = {
  LINE_SIZE: { bg: 'rgba(96,165,250,0.10)', border: 'rgba(96,165,250,0.35)', fg: '#60a5fa' },
  TERMS:     { bg: 'rgba(167,139,250,0.10)', border: 'rgba(167,139,250,0.35)', fg: '#a78bfa' },
  EXIT:      { bg: 'rgba(248,113,113,0.10)', border: 'rgba(248,113,113,0.35)', fg: '#f87171' },
  WATCH:     { bg: 'rgba(148,163,184,0.10)', border: 'rgba(148,163,184,0.35)', fg: '#94a3b8' },
};

function fmtPct(v, digits = 1) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  return `${Number(v).toFixed(digits)}%`;
}
function fmtMoney(v, currency) {
  if (v == null || !Number.isFinite(Number(v))) return '—';
  const n = Number(v);
  // Use compact notation for big market-size figures (≥ 1M).
  if (Math.abs(n) >= 1_000_000) {
    return `${currency || ''} ${n.toLocaleString('en-US', { notation: 'compact', maximumFractionDigits: 2 })}`.trim();
  }
  return `${currency || ''} ${n.toLocaleString('en-US')}`.trim();
}
function fmtRelativeDate(iso) {
  if (!iso) return '—';
  const then = new Date(iso); const now = new Date();
  const ms = now - then; const days = Math.round(ms / 86_400_000);
  if (Number.isNaN(days)) return '—';
  if (days <= 0)  return 'today';
  if (days === 1) return 'yesterday';
  if (days < 30)  return `${days} days ago`;
  const months = Math.round(days / 30);
  if (months < 12) return `${months} month${months === 1 ? '' : 's'} ago`;
  return then.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
}

export default function MarketIntelligenceModal({
  show, onClose,
  contractId, countryId, classOfBusinessId,
  countryName, cobName, targetYear,
  currency, treatyMetrics,
}) {
  const showToast = useGlobalToast();
  const [state, setState] = useState(STATES.LOADING_REPORT);
  const [error, setError] = useState(null);
  const [report, setReport] = useState(null);
  const [benchmarks, setBenchmarks] = useState(null);
  const [recommendations, setRecommendations] = useState([]);
  const [macro, setMacro] = useState(null);
  const [progressIdx, setProgressIdx] = useState(0);
  const sourceRowRefs = useRef(new Map());
  const [highlightedSourceIdx, setHighlightedSourceIdx] = useState(null);
  const [confirmStage, setConfirmStage] = useState(null); // rec being confirmed
  const [stagingRecId, setStagingRecId] = useState(null);
  // Track which load epoch each fetch belongs to, so a stale resolve
  // after Refresh can't overwrite the new state.
  const epochRef = useRef(0);

  const disabled = !contractId || !countryId || !classOfBusinessId || !targetYear;

  // ── Fetch flow ────────────────────────────────────────────────
  const runFlow = useCallback(async ({ forceRefresh = false } = {}) => {
    if (disabled) return;
    const epoch = ++epochRef.current;
    setError(null);
    setProgressIdx(0);

    // 1) Resolve the report (cached or freshly generated).
    let rep;
    if (forceRefresh) {
      setState(STATES.GENERATING_REPORT);
      try {
        rep = await api.generateMarketReport({
          country_id: countryId, class_of_business_id: classOfBusinessId,
          target_year: targetYear, force_refresh: true,
        });
      } catch (e) { return failHard(epoch, e); }
    } else {
      setState(STATES.LOADING_REPORT);
      try {
        rep = await api.getLatestMarketReport(countryId, classOfBusinessId, targetYear);
      } catch (e) {
        if (e instanceof HttpError && e.status === 404) {
          setState(STATES.GENERATING_REPORT);
          try {
            rep = await api.generateMarketReport({
              country_id: countryId, class_of_business_id: classOfBusinessId,
              target_year: targetYear,
            });
          } catch (e2) { return failHard(epoch, e2); }
        } else {
          return failHard(epoch, e);
        }
      }
    }
    if (epoch !== epochRef.current) return;
    setReport(rep);

    // 2) Benchmarks, macro snapshot, and recommendations in parallel.
    //    Macro is best-effort — World Bank or IMF unavailability never
    //    blocks the report; the section just hides on null.
    setState(STATES.LOADING_BENCHMARKS);
    const [benchResult, macroResult] = await Promise.allSettled([
      api.getTreatyBenchmarks(contractId, rep.report_id),
      countryId ? api.getCountryMacro(countryId, { forceRefresh }) : Promise.resolve(null),
    ]);
    if (epoch !== epochRef.current) return;
    if (benchResult.status === 'fulfilled') {
      setBenchmarks(benchResult.value);
    } else if (benchResult.reason instanceof HttpError && benchResult.reason.status === 404) {
      setBenchmarks(null);
    } else {
      return failHard(epoch, benchResult.reason);
    }
    setMacro(macroResult.status === 'fulfilled' ? macroResult.value : null);

    setState(STATES.LOADING_RECS);
    let recs;
    try {
      const r = await api.getTreatyRecommendations(contractId);
      recs = r?.recommendations || [];
    } catch (e) { return failHard(epoch, e); }

    // 3) If empty, generate now.
    if (recs.length === 0) {
      setState(STATES.GENERATING_RECS);
      try {
        const g = await api.generateTreatyRecommendations({
          contract_id: contractId, report_id: rep.report_id,
        });
        recs = g?.recommendations || [];
      } catch (e) {
        // Non-fatal — surface the report even if recs failed.
        showToast(`Could not generate recommendations: ${e?.message || e}`);
        recs = [];
      }
    }
    if (epoch !== epochRef.current) return;
    setRecommendations(recs);
    setState(STATES.READY);
  }, [contractId, countryId, classOfBusinessId, targetYear, disabled, showToast]);

  function failHard(epoch, e) {
    if (epoch !== epochRef.current) return;
    setError(e?.message || 'Failed to load market intelligence');
    setState(STATES.ERROR);
  }

  // Rotate progress messages while the long generate calls run.
  useEffect(() => {
    if (state !== STATES.GENERATING_REPORT && state !== STATES.GENERATING_RECS) return;
    const id = setInterval(() => setProgressIdx(i => (i + 1) % PROGRESS_MESSAGES.length), 2500);
    return () => clearInterval(id);
  }, [state]);

  // Kick off the flow when the modal opens. Reset on close so the
  // next open starts cleanly.
  useEffect(() => {
    if (!show) {
      epochRef.current++;       // invalidate any in-flight resolves
      setReport(null); setBenchmarks(null); setRecommendations([]); setMacro(null);
      setState(STATES.LOADING_REPORT); setError(null);
      return;
    }
    runFlow({ forceRefresh: false });
  }, [show, runFlow]);

  // ESC closes
  useEffect(() => {
    if (!show) return;
    const onKey = (e) => { if (e.key === 'Escape') onClose?.(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [show, onClose]);

  // Citation jump: scroll to the source row and briefly highlight it.
  const jumpToSource = useCallback((idx) => {
    const el = sourceRowRefs.current.get(idx);
    if (el) {
      el.scrollIntoView({ block: 'center', behavior: 'smooth' });
      setHighlightedSourceIdx(idx);
      setTimeout(() => setHighlightedSourceIdx(prev => (prev === idx ? null : prev)), 1500);
    }
  }, []);

  // ── Stage / reject handlers ───────────────────────────────────
  const stageRec = useCallback(async (rec, { acknowledged = false } = {}) => {
    setStagingRecId(rec.rec_id);
    try {
      await api.stageMarketRec(rec.rec_id, acknowledged ? { warning_acknowledged: true } : {});
      setRecommendations(prev => prev.map(r => r.rec_id === rec.rec_id ? { ...r, status: 'STAGED' } : r));
      showToast('Recommendation staged.');
    } catch (e) {
      if (e instanceof HttpError && e.status === 422 && e.body) {
        // Could be a warning gate the user hasn't yet acknowledged.
        try {
          const body = typeof e.body === 'string' ? JSON.parse(e.body) : e.body;
          if (Array.isArray(body.compliance_warnings)) {
            setConfirmStage({ rec, warnings: body.compliance_warnings });
            return;
          }
        } catch { /* fall through */ }
      }
      showToast(`Stage failed: ${e?.message || e}`);
    } finally {
      setStagingRecId(null);
    }
  }, [showToast]);

  const rejectRec = useCallback(async (rec) => {
    const reason = window.prompt('Reason for rejecting this recommendation? (optional)');
    if (reason === null) return; // user cancelled
    try {
      await api.rejectMarketRec(rec.rec_id, reason ? { reason } : {});
      setRecommendations(prev => {
        const updated = prev.map(r => r.rec_id === rec.rec_id ? { ...r, status: 'REJECTED' } : r);
        // Move rejected rows to the bottom for readability.
        return [...updated.filter(r => r.status !== 'REJECTED'), ...updated.filter(r => r.status === 'REJECTED')];
      });
      showToast('Recommendation rejected.');
    } catch (e) {
      showToast(`Reject failed: ${e?.message || e}`);
    }
  }, [showToast]);

  const regenerateRecs = useCallback(async () => {
    if (!report?.report_id) return;
    setState(STATES.GENERATING_RECS);
    try {
      const g = await api.generateTreatyRecommendations({
        contract_id: contractId, report_id: report.report_id, force_refresh: true,
      });
      setRecommendations(g?.recommendations || []);
      setState(STATES.READY);
    } catch (e) {
      showToast(`Could not generate recommendations: ${e?.message || e}`);
      setState(STATES.READY);
    }
  }, [contractId, report, showToast]);

  // Fire one REPORT_VIEWED audit row per (report, contract) per
  // session — see _viewLogged above. The endpoint is best-effort:
  // we don't surface failures to the user.
  useEffect(() => {
    if (state !== STATES.READY) return;
    if (!report?.report_id || !contractId) return;
    const key = `${report.report_id}::${contractId}`;
    if (_viewLogged.has(key)) return;
    _viewLogged.add(key);
    api.logMarketReportView({ report_id: report.report_id, contract_id: contractId })
      .catch(() => { _viewLogged.delete(key); });
  }, [state, report, contractId]);

  // Stable header / footer summary fields.
  const isLoading = state !== STATES.READY && state !== STATES.ERROR;
  const isGenerating = state === STATES.GENERATING_REPORT || state === STATES.GENERATING_RECS;

  if (!show) return null;

  return (
    <div
      className="bbg-modal-backdrop"
      // Backdrop dismissal is a pointer-only convenience; keyboard users
      // close via Escape (handled above) or the labelled ✕ button.
      role="presentation"
      onClick={(e) => { if (e.target === e.currentTarget) onClose?.(); }}
      style={{ zIndex: 1400 }}
    >
      <div
        className="bbg-modal bbg-modal--fullscreen off-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Market Intelligence"
      >
        <div className="bbg-modal-head" style={{ flexShrink: 0 }}>
          <span className="bbg-modal-title">
            ✦ Market Intelligence — {countryName || 'Country'} / {cobName || 'Class'} / {targetYear || '—'}
          </span>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {report && (
              <span style={{
                fontSize: 10, fontWeight: 800, letterSpacing: '.1em', textTransform: 'uppercase',
                padding: '3px 8px', borderRadius: 999,
                background: report.cached ? 'rgba(96,165,250,0.10)' : 'rgba(74,222,128,0.10)',
                border: `1px solid ${report.cached ? 'rgba(96,165,250,0.30)' : 'rgba(74,222,128,0.30)'}`,
                color: report.cached ? '#60a5fa' : '#4ade80',
              }}>
                {report.cached ? 'Cached' : 'Fresh'}
              </span>
            )}
            <button className="bbg-modal-x" onClick={onClose} aria-label="Close">✕</button>
          </div>
        </div>

        {/* Body sections are centered in a max-width column so the
            fullscreen modal stays readable on ultrawide monitors —
            cards still fill that column for visual balance. */}
        <div
          className="bbg-modal-body"
          style={{ display: 'flex', flexDirection: 'column', alignItems: 'stretch', gap: 14 }}
        >
         <div style={{ width: '100%', maxWidth: 1200, margin: '0 auto', display: 'flex', flexDirection: 'column', gap: 14 }}>
          {disabled && (
            <ErrorBox message="Country and class of business required for market intelligence." />
          )}
          {state === STATES.ERROR && !disabled && (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <ErrorBox message={error || 'Something went wrong.'} />
              <div>
                <button className="bbg-btn" onClick={() => runFlow({ forceRefresh: false })}>
                  Retry
                </button>
              </div>
            </div>
          )}
          {isLoading && !disabled && (
            <LoadingBlock state={state} message={isGenerating ? PROGRESS_MESSAGES[progressIdx] : null} />
          )}

          {state === STATES.READY && report && (
            <>
              <StaleBanner report={report} onRefresh={() => runFlow({ forceRefresh: true })} />
              <SectionExecSummary
                report={report}
                countryName={countryName}
                cobName={cobName}
                targetYear={targetYear}
              />
              <SectionLandscape report={report} currency={currency} jumpToSource={jumpToSource} />
              <SectionMacro macro={macro} />
              <SectionBenchmarks
                benchmarks={benchmarks}
                treatyMetrics={treatyMetrics}
              />
              <SectionTrends report={report} jumpToSource={jumpToSource} />
              <SectionRecommendations
                recommendations={recommendations}
                stagingRecId={stagingRecId}
                onStage={(rec) => {
                  const warnings = Array.isArray(rec.compliance_warnings) ? rec.compliance_warnings : [];
                  if (warnings.length === 0) return stageRec(rec, { acknowledged: false });
                  setConfirmStage({ rec, warnings });
                }}
                onReject={rejectRec}
                onRegenerate={regenerateRecs}
                onClose={onClose}
              />
              <SectionSources
                report={report}
                rowRefs={sourceRowRefs}
                highlightedIdx={highlightedSourceIdx}
              />
            </>
          )}

          {confirmStage && (
            <ConfirmStageDialog
              warnings={confirmStage.warnings}
              onCancel={() => setConfirmStage(null)}
              onConfirm={async () => {
                const rec = confirmStage.rec;
                setConfirmStage(null);
                await stageRec(rec, { acknowledged: true });
              }}
            />
          )}
         </div>
        </div>

        <div style={{
          padding: '10px 20px', borderTop: '1px solid rgba(255,255,255,0.07)', flexShrink: 0,
        }}>
          <div style={{
            width: '100%', maxWidth: 1200, margin: '0 auto',
            display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12,
          }}>
            <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.40)' }}>
              {report
                ? `Generated ${fmtRelativeDate(report.generated_at)} · ${report.model || 'model'}`
                : 'Generating…'}
            </span>
            <button
              className="bbg-btn"
              disabled={isLoading || disabled}
              onClick={() => runFlow({ forceRefresh: true })}
              title="Bypass cache and regenerate"
            >
              Refresh ↻
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Shared section primitives
// ──────────────────────────────────────────────────────────────────

function SectionHeader({ children }) {
  return (
    <div style={{
      fontSize: 10, fontWeight: 800, letterSpacing: '.18em', textTransform: 'uppercase',
      color: '#67e8f9', marginBottom: 8, paddingBottom: 6,
      borderBottom: '1px solid rgba(103,232,249,0.18)',
    }}>{children}</div>
  );
}

function Card({ children, style }) {
  return (
    <div style={{
      background: 'rgba(255,255,255,0.04)',
      border: '0.5px solid rgba(255,255,255,0.12)',
      borderRadius: 10, padding: '14px 16px', ...style,
    }}>{children}</div>
  );
}

function ErrorBox({ message }) {
  return (
    <div style={{
      padding: '10px 12px', borderRadius: 8,
      background: 'rgba(248,113,113,0.08)', border: '1px solid rgba(248,113,113,0.30)',
      color: '#f87171', fontSize: 12,
    }}>⚠ {message}</div>
  );
}

// Stale-cache amber banner. Renders only when the report was served
// from cache AND is more than 30 days old. Refreshing replaces the
// report with a fresh one and the banner naturally disappears.
function StaleBanner({ report, onRefresh }) {
  if (!report?.cached) return null;
  const ageDays = Math.floor((Date.now() - new Date(report.generated_at).getTime()) / 86_400_000);
  if (!Number.isFinite(ageDays) || ageDays <= 30) return null;
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 10,
      padding: '8px 12px', borderRadius: 8,
      background: 'rgba(251,191,36,0.08)', border: '1px solid rgba(251,191,36,0.30)',
      color: '#fbbf24', fontSize: 12,
    }}>
      <span aria-hidden="true">⚠</span>
      <span style={{ flex: 1 }}>
        This report is <b>{ageDays} days old</b> — Refresh for the latest.
      </span>
      <button
        type="button" className="bbg-btn"
        onClick={onRefresh}
        style={{
          fontSize: 11, padding: '4px 10px',
          borderColor: 'rgba(251,191,36,0.45)', color: '#fbbf24',
          background: 'rgba(251,191,36,0.08)',
        }}
      >Refresh now</button>
    </div>
  );
}

function LoadingBlock({ state, message }) {
  const label = state === STATES.GENERATING_REPORT
    ? 'Generating market report'
    : state === STATES.GENERATING_RECS
      ? 'Generating recommendations'
      : state === STATES.LOADING_BENCHMARKS
        ? 'Loading benchmarks'
        : state === STATES.LOADING_RECS
          ? 'Loading recommendations'
          : 'Loading report';
  return (
    <div style={{
      display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12,
      padding: '40px 20px', color: 'rgba(255,255,255,0.65)',
    }}>
      <div style={{
        width: 32, height: 32, borderRadius: '50%',
        border: '2px solid rgba(96,165,250,0.20)', borderTopColor: '#60a5fa',
        animation: 'mi-spin 0.9s linear infinite',
      }} />
      <div style={{ fontSize: 13, fontWeight: 700 }}>{label}</div>
      {message && <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.5)' }}>{message}</div>}
      <style>{`@keyframes mi-spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Section 1 — Executive Summary
// ──────────────────────────────────────────────────────────────────
function SectionExecSummary({ report, countryName, cobName, targetYear }) {
  return (
    <section>
      <SectionHeader>Executive Summary</SectionHeader>
      <Card>
        <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: 'rgba(255,255,255,0.88)' }}>
          {report.executive_summary || '—'}
        </p>
        <div style={{
          marginTop: 12, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,0.06)',
          fontSize: 11, color: 'rgba(255,255,255,0.45)',
        }}>
          {countryName} · {cobName} · Target year {targetYear} · Generated {fmtRelativeDate(report.generated_at)} · Cached: {report.cached ? 'yes' : 'no'}
        </div>
      </Card>
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────
// Section 2 — Market Landscape
// ──────────────────────────────────────────────────────────────────
function SectionLandscape({ report, currency, jumpToSource }) {
  const ml = report.market_landscape || {};
  return (
    <section>
      <SectionHeader>Market Landscape</SectionHeader>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12 }}>
        <Card>
          <div className="off-card-title">Regulator &amp; Players</div>
          <RegulatorBlock landscape={ml} />
          <CarriersBlock landscape={ml} />
          <MarketSizeBlock landscape={ml} currency={currency} jumpToSource={jumpToSource} />
        </Card>
        <Card>
          <div className="off-card-title">Recent Context</div>
          <CitableProse text={ml.recent_context || '—'} jumpToSource={jumpToSource} />
        </Card>
      </div>
    </section>
  );
}

function RegulatorBlock({ landscape }) {
  const [showAll, setShowAll] = useState(false);
  const actions = Array.isArray(landscape.regulator_recent_actions) ? landscape.regulator_recent_actions : [];
  const visible = showAll ? actions : actions.slice(0, 4);
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 12, fontWeight: 700, color: '#fff' }}>
        Regulator: <span style={{ color: 'rgba(255,255,255,0.65)', fontWeight: 500 }}>{landscape.regulator || '—'}</span>
      </div>
      {actions.length > 0 && (
        <>
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', marginTop: 8, marginBottom: 4 }}>Recent actions:</div>
          <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: 'rgba(255,255,255,0.75)' }}>
            {visible.map((a, i) => <li key={i} style={{ marginBottom: 2 }}>{a}</li>)}
          </ul>
          {actions.length > 4 && (
            <button
              type="button" className="bbg-btn"
              style={{ marginTop: 6, fontSize: 11, padding: '2px 8px' }}
              onClick={() => setShowAll(v => !v)}
            >
              {showAll ? 'Show less' : `Show ${actions.length - 4} more`}
            </button>
          )}
        </>
      )}
    </div>
  );
}

function CarriersBlock({ landscape }) {
  const rows = (Array.isArray(landscape.top_carriers) ? landscape.top_carriers : []).slice(0, 7);
  if (rows.length === 0) return null;
  return (
    <div style={{ marginBottom: 12 }}>
      <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.45)', marginBottom: 4 }}>Top carriers:</div>
      <table style={{ width: '100%', fontSize: 12, borderCollapse: 'collapse' }}>
        <thead>
          <tr style={{ color: 'rgba(255,255,255,0.40)' }}>
            <th style={cellHeadL}>Name</th>
            <th style={cellHeadR}>AM Best</th>
            <th style={cellHeadR}>Share</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((c, i) => (
            <tr key={i}>
              <td style={cellL}>{c.name || '—'}</td>
              <td style={cellR}>{c.am_best_rating || '—'}</td>
              <td style={cellR}>{c.market_share_pct != null ? fmtPct(c.market_share_pct, 1) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function MarketSizeBlock({ landscape, currency, jumpToSource }) {
  const mp = landscape.market_size_premium;
  const growth = landscape.market_growth_pct;
  const arrow = (growth == null) ? '' : (growth > 0 ? '▲' : (growth < 0 ? '▼' : '—'));
  const arrowColor = (growth == null) ? 'rgba(255,255,255,0.45)' : (growth >= 0 ? '#4ade80' : '#f87171');
  return (
    <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.75)' }}>
      {mp && (
        <div>
          Market size: <b style={{ color: '#fff' }}>{fmtMoney(mp.value, mp.currency || currency || '')}</b>
          {mp.year ? <span style={{ color: 'rgba(255,255,255,0.45)' }}> ({mp.year})</span> : null}
          {mp.source_idx ? <SourceLink idx={mp.source_idx} onJump={jumpToSource} /> : null}
        </div>
      )}
      {growth != null && (
        <div style={{ marginTop: 4 }}>
          Market growth: <b style={{ color: '#fff' }}>{fmtPct(growth, 1)} YoY</b>{' '}
          <span style={{ color: arrowColor, fontWeight: 800 }}>{arrow}</span>
        </div>
      )}
    </div>
  );
}

// Inline citation [n] → jumps to source row n.
function SourceLink({ idx, onJump }) {
  return (
    <button
      type="button"
      onClick={(e) => { e.preventDefault(); onJump?.(idx); }}
      style={{
        background: 'transparent', border: 'none', padding: 0, marginLeft: 3,
        color: '#67e8f9', cursor: 'pointer', fontFamily: 'inherit',
        fontSize: 10, verticalAlign: 'super',
      }}
      aria-label={`Jump to source ${idx}`}
    >[{idx}]</button>
  );
}

// Renders prose with embedded [n] citations as clickable jump links.
function CitableProse({ text, jumpToSource }) {
  if (!text) return <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.55)' }}>—</div>;
  const parts = [];
  const regex = /\[(\d+)\]/g;
  let cursor = 0; let match; let key = 0;
  while ((match = regex.exec(text)) !== null) {
    if (match.index > cursor) parts.push(<span key={`t-${key++}`}>{text.slice(cursor, match.index)}</span>);
    const idx = Number(match[1]);
    parts.push(<SourceLink key={`c-${key++}`} idx={idx} onJump={jumpToSource} />);
    cursor = match.index + match[0].length;
  }
  if (cursor < text.length) parts.push(<span key={`t-${key++}`}>{text.slice(cursor)}</span>);
  return <p style={{ margin: 0, fontSize: 13, lineHeight: 1.6, color: 'rgba(255,255,255,0.85)' }}>{parts}</p>;
}

// ──────────────────────────────────────────────────────────────────
// Section 2.5 — Macro Snapshot (open-source: World Bank + IMF)
// ──────────────────────────────────────────────────────────────────
function SectionMacro({ macro }) {
  // Hide the section entirely when neither source returned data —
  // typically because the country has no usable ISO code mapping.
  const wb  = macro?.world_bank || null;
  const imf = macro?.imf || null;
  if (!wb && !imf) return null;

  // Pick the cleanest source for each canonical metric. World Bank
  // is preferred for historicals; IMF fills in current-year and
  // forecast values where WB lags.
  const rows = MACRO_DISPLAY.map(d => {
    const wbInd  = wb?.indicators?.[d.wbKey];
    const imfInd = imf?.indicators?.[d.imfKey];
    const latest =
      wbInd?.latest_value != null  ? { value: wbInd.latest_value,  year: wbInd.latest_year,  source: 'World Bank' }
      : imfInd?.latest_value != null ? { value: imfInd.latest_value, year: imfInd.latest_year, source: 'IMF', unit: d.imfUnit }
      : null;
    const forecast = imfInd?.forecast_value != null
      ? { value: imfInd.forecast_value, year: imfInd.forecast_year, unit: d.imfUnit }
      : null;
    return { ...d, latest, forecast };
  });

  return (
    <section>
      <SectionHeader>Macro Snapshot</SectionHeader>
      <Card>
        <div style={{
          display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 12,
        }}>
          {rows.map((r, i) => <MacroCell key={i} row={r} />)}
        </div>
        <div style={{
          marginTop: 12, paddingTop: 10, borderTop: '1px solid rgba(255,255,255,0.06)',
          fontSize: 11, color: 'rgba(255,255,255,0.40)',
        }}>
          Sources:
          {wb  ? <> <a href="https://data.worldbank.org/" target="_blank" rel="noreferrer noopener" style={{ color: '#67e8f9' }}>World Bank Open Data</a></> : null}
          {wb && imf ? ' · ' : ''}
          {imf ? <a href="https://www.imf.org/external/datamapper/" target="_blank" rel="noreferrer noopener" style={{ color: '#67e8f9' }}>IMF Datamapper</a> : null}
        </div>
      </Card>
    </section>
  );
}

const MACRO_DISPLAY = [
  { label: 'Population',           wbKey: 'population',         imfKey: 'population_imf',     unit: 'count',           imfUnit: 'PERSONS_MILLIONS' },
  { label: 'Population growth',    wbKey: 'population_growth',  imfKey: null,                 unit: '%' },
  { label: 'GDP (USD)',            wbKey: 'gdp_usd',            imfKey: 'gdp_usd_imf',        unit: 'USD',             imfUnit: 'USD_BILLIONS' },
  { label: 'GDP per capita (USD)', wbKey: 'gdp_per_capita_usd', imfKey: 'gdp_per_capita_imf', unit: 'USD' },
  { label: 'GDP growth',           wbKey: 'gdp_growth',         imfKey: null,                 unit: '%' },
  { label: 'Inflation (CPI)',      wbKey: 'inflation_cpi',      imfKey: 'inflation_imf',      unit: '%' },
  { label: 'Unemployment',         wbKey: 'unemployment',       imfKey: 'unemployment_imf',   unit: '%' },
  { label: 'Gov debt (% of GDP)',  wbKey: 'gov_debt_pct_gdp',   imfKey: 'gov_debt_imf',       unit: '%' },
];

function MacroCell({ row }) {
  const v = row.latest;
  const f = row.forecast;
  return (
    <div style={{
      background: 'rgba(255,255,255,0.025)',
      border: '0.5px solid rgba(255,255,255,0.08)',
      borderRadius: 8, padding: '10px 12px',
    }}>
      <div style={{
        fontSize: 10, fontWeight: 700, letterSpacing: '.08em', textTransform: 'uppercase',
        color: 'rgba(255,255,255,0.50)', marginBottom: 6,
      }}>{row.label}</div>
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6 }}>
        <span style={{ fontSize: 18, fontWeight: 800, color: '#fff', fontVariantNumeric: 'tabular-nums' }}>
          {formatMacroValue(v?.value, row.unit, v?.unit)}
        </span>
        {v?.year ? <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.40)' }}>({v.year})</span> : null}
      </div>
      {f && f.value != null && (
        <div style={{ fontSize: 11, color: 'rgba(167,139,250,0.85)', marginTop: 4 }}>
          IMF forecast {f.year}: <b>{formatMacroValue(f.value, row.unit, f.unit)}</b>
        </div>
      )}
      {v?.source && (
        <div style={{ fontSize: 10, color: 'rgba(255,255,255,0.30)', marginTop: 4 }}>
          via {v.source}
        </div>
      )}
    </div>
  );
}

// Display-side formatters. Some indicators arrive in raw units (USD,
// people) while IMF reports macro magnitudes already scaled to
// billions or millions — convert into a single canonical display.
function formatMacroValue(value, unit, sourceUnit) {
  if (value == null || !Number.isFinite(Number(value))) return '—';
  let v = Number(value);
  if (sourceUnit === 'USD_BILLIONS' && unit === 'USD') v *= 1_000_000_000;
  if (sourceUnit === 'PERSONS_MILLIONS' && unit === 'count') v *= 1_000_000;
  if (unit === 'USD') {
    if (Math.abs(v) >= 1e12) return `$${(v / 1e12).toFixed(2)} T`;
    if (Math.abs(v) >= 1e9)  return `$${(v / 1e9).toFixed(2)} B`;
    if (Math.abs(v) >= 1e6)  return `$${(v / 1e6).toFixed(2)} M`;
    return `$${v.toLocaleString('en-US')}`;
  }
  if (unit === 'count') {
    if (Math.abs(v) >= 1e9) return `${(v / 1e9).toFixed(2)} B`;
    if (Math.abs(v) >= 1e6) return `${(v / 1e6).toFixed(2)} M`;
    if (Math.abs(v) >= 1e3) return `${(v / 1e3).toFixed(1)} k`;
    return `${v.toLocaleString('en-US')}`;
  }
  if (unit === '%') return `${v.toFixed(2)}%`;
  return v.toLocaleString('en-US');
}

// ──────────────────────────────────────────────────────────────────
// Section 3 — This Treaty vs Market
// ──────────────────────────────────────────────────────────────────
function SectionBenchmarks({ benchmarks, treatyMetrics }) {
  // Prefer the live server-side benchmarks_table (canonical verdicts).
  // Fall back to a minimal client-side render if the endpoint returned
  // nothing — keeps the section visible rather than vanishing.
  const rows = useMemo(() => {
    if (benchmarks?.benchmarks_table?.length) return benchmarks.benchmarks_table;
    if (!treatyMetrics) return [];
    return [
      { metric: 'Loss Ratio', treaty_value: treatyMetrics.loss_ratio_pct, market_value: null, delta: null, verdict: 'NO_DATA', unit: '%' },
      { metric: 'Commission', treaty_value: treatyMetrics.commission_pct, market_value: null, delta: null, verdict: 'NO_DATA', unit: '%' },
      { metric: 'Retention',  treaty_value: treatyMetrics.retention_pct,  market_value: null, delta: null, verdict: 'NO_DATA', unit: '%' },
      { metric: 'Margin',     treaty_value: treatyMetrics.margin_pct,     market_value: null, delta: null, verdict: 'NO_DATA', unit: '%' },
    ];
  }, [benchmarks, treatyMetrics]);

  return (
    <section>
      <SectionHeader>This Treaty vs Market</SectionHeader>
      <Card>
        <table style={{ width: '100%', fontSize: 13, borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ color: 'rgba(255,255,255,0.45)', fontSize: 11 }}>
              <th style={cellHeadL}>Metric</th>
              <th style={cellHeadR}>This Treaty</th>
              <th style={cellHeadR}>Market</th>
              <th style={cellHeadR}>Δ</th>
              <th style={cellHeadR}>Verdict</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <BenchmarkRow key={i} row={r} />
            ))}
          </tbody>
        </table>
      </Card>
    </section>
  );
}

function BenchmarkRow({ row }) {
  const v = row.verdict || 'NO_DATA';
  const style = VERDICT_STYLE[v];
  const arrow = row.delta == null ? '' : (row.delta > 0 ? '▲' : (row.delta < 0 ? '▼' : '—'));
  return (
    <tr>
      <td style={cellL}>{row.metric}</td>
      <td style={cellR}>{row.treaty_value != null ? fmtPct(row.treaty_value, 1) : '—'}</td>
      <td style={cellR}>{row.market_value != null ? fmtPct(row.market_value, 1) : '—'}</td>
      <td style={{ ...cellR, color: arrow === '▲' ? '#fbbf24' : (arrow === '▼' ? '#4ade80' : 'rgba(255,255,255,0.45)') }}>
        {row.delta == null ? '—' : `${arrow} ${Math.abs(row.delta).toFixed(1)} pts`}
      </td>
      <td style={cellR}>
        <span style={{
          fontSize: 10, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase',
          padding: '2px 8px', borderRadius: 999,
          background: style.bg, border: `1px solid ${style.border}`, color: style.fg,
        }}>{v.replace('_', ' ')}</span>
      </td>
    </tr>
  );
}

// ──────────────────────────────────────────────────────────────────
// Section 4 — Beyond the Model (trends)
// ──────────────────────────────────────────────────────────────────
function SectionTrends({ report, jumpToSource }) {
  const trends = Array.isArray(report.trends) ? report.trends : [];
  return (
    <section>
      <SectionHeader>Beyond the Model</SectionHeader>
      {trends.length === 0
        ? <Card><div style={{ fontSize: 13, color: 'rgba(255,255,255,0.55)' }}>No trends to highlight.</div></Card>
        : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {trends.map((t, i) => {
              const s = SEVERITY_STYLE[t.severity] || SEVERITY_STYLE.INFO;
              return (
                <div key={i} style={{
                  background: s.bg, border: `1px solid ${s.border}`,
                  borderRadius: 10, padding: '10px 14px',
                }}>
                  <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', marginBottom: 4 }}>
                    <span style={{ color: s.fg, fontWeight: 800, fontSize: 13 }}>{s.icon}</span>
                    <div style={{ fontWeight: 700, fontSize: 13, color: '#fff' }}>{t.title}</div>
                    {t.source_idx ? <SourceLink idx={t.source_idx} onJump={jumpToSource} /> : null}
                  </div>
                  <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.78)', lineHeight: 1.6 }}>{t.body}</div>
                </div>
              );
            })}
          </div>
        )}
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────
// Section 5 — Recommendations
// ──────────────────────────────────────────────────────────────────
function SectionRecommendations({ recommendations, stagingRecId, onStage, onReject, onRegenerate, onClose }) {
  return (
    <section>
      <SectionHeader>Recommendations</SectionHeader>
      {recommendations.length === 0
        ? (
          <Card>
            <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.55)', marginBottom: 8 }}>
              No recommendations yet for this treaty.
            </div>
            <button className="bbg-btn bbg-btn--offer" type="button" onClick={onRegenerate}>
              Generate recommendations →
            </button>
          </Card>
        )
        : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {recommendations.map((rec) => (
              <RecommendationCard
                key={rec.rec_id}
                rec={rec}
                staging={stagingRecId === rec.rec_id}
                onStage={onStage}
                onReject={onReject}
                onClose={onClose}
              />
            ))}
          </div>
        )}
    </section>
  );
}

function RecommendationCard({ rec, staging, onStage, onReject, onClose }) {
  const a = ACTION_PILL_STYLE[rec.action_type] || ACTION_PILL_STYLE.WATCH;
  const conf = Number(rec.confidence ?? 0);
  const status = rec.status || 'PENDING';
  const warnings = Array.isArray(rec.compliance_warnings) ? rec.compliance_warnings : [];
  const isTerminal = status === 'COMMITTED' || status === 'REJECTED' || status === 'SUPERSEDED';
  const isStaged = status === 'STAGED';
  const stagingSupported = rec.staging_supported !== false && rec.action_type === 'LINE_SIZE';

  // Persisted body: title and rationale were concatenated server-side
  // into the `rationale` column. Keep the convenience fields if the
  // server returned them on the freshly generated path.
  const title = rec.title || firstLineOf(rec.rationale) || 'Recommendation';
  const body  = rec.body  || stripTitle(rec.rationale);

  return (
    <div style={{
      background: 'rgba(255,255,255,0.04)',
      border: '0.5px solid rgba(255,255,255,0.12)',
      borderRadius: 10, padding: '12px 14px',
      opacity: status === 'REJECTED' ? 0.55 : 1,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <span style={{
          fontSize: 10, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase',
          padding: '2px 8px', borderRadius: 999,
          background: a.bg, border: `1px solid ${a.border}`, color: a.fg,
        }}>{rec.action_type}</span>
        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.40)' }}>
          Confidence
        </span>
        <ConfidenceBar value={conf} />
        <span style={{ fontSize: 10, color: 'rgba(255,255,255,0.50)' }}>{(conf * 100).toFixed(0)}%</span>
        <div style={{ flex: 1 }} />
        <StatusChip status={status} />
      </div>
      <div style={{ fontSize: 13, fontWeight: 700, color: '#fff', marginBottom: 4 }}>{title}</div>
      <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.80)', lineHeight: 1.55 }}>{body}</div>
      {rec.action_type === 'LINE_SIZE' && rec.recommended_line_pct != null && (
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.65)', marginTop: 6 }}>
          Recommended: <b style={{ color: '#60a5fa' }}>{(Number(rec.recommended_line_pct) * 100).toFixed(1)}%</b>
        </div>
      )}
      {rec.action_type === 'TERMS' && rec.recommended_terms_changes && (
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.65)', marginTop: 6 }}>
          Recommended changes: {Object.entries(rec.recommended_terms_changes)
            .map(([k, v]) => `${labelForTerm(k)} ${fmtPct(v, 1)}`).join(', ')}
        </div>
      )}
      {warnings.length > 0 && (
        <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          {warnings.map((w, i) => (
            <span key={i} title={w} style={{
              fontSize: 10, fontWeight: 700, padding: '2px 8px', borderRadius: 999,
              background: 'rgba(251,191,36,0.10)', border: '1px solid rgba(251,191,36,0.30)',
              color: '#fbbf24', maxWidth: 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            }}>⚠ {w}</span>
          ))}
        </div>
      )}
      {!isTerminal && (
        <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
          {isStaged ? (
            <>
              <span style={{ fontSize: 11, color: '#4ade80', fontWeight: 700 }}>✓ Staged</span>
              <button
                type="button" className="bbg-btn"
                onClick={() => {
                  // The cedant panel + Metrics tab live on the same
                  // pricing screen the offer modal opened from. Closing
                  // the market modal stack returns the user there; the
                  // staged row will be visible on the Metrics tab.
                  onClose?.();
                  window.dispatchEvent(new CustomEvent('market-rec:show-staging'));
                }}
                style={{ fontSize: 11, padding: '4px 10px' }}
              >View staging on cedant summary →</button>
            </>
          ) : (
            <>
              <button
                type="button" className="bbg-btn bbg-btn--offer"
                disabled={!stagingSupported || staging}
                title={!stagingSupported ? (rec.staging_disabled_reason || 'Not stageable') : 'Stage this change'}
                onClick={() => onStage?.(rec)}
                style={{ fontSize: 12, padding: '4px 12px' }}
              >{staging ? 'Staging…' : 'Stage'}</button>
              <button
                type="button" className="bbg-btn"
                onClick={() => onReject?.(rec)}
                style={{ fontSize: 12, padding: '4px 12px' }}
              >Reject</button>
            </>
          )}
        </div>
      )}
    </div>
  );
}

function ConfidenceBar({ value }) {
  const v = Math.max(0, Math.min(1, Number(value) || 0));
  return (
    <div style={{ width: 80, height: 4, borderRadius: 2, background: 'rgba(255,255,255,0.08)', overflow: 'hidden' }}>
      <div style={{
        width: `${v * 100}%`, height: '100%',
        background: v >= 0.7 ? '#4ade80' : v >= 0.4 ? '#fbbf24' : '#f87171',
      }} />
    </div>
  );
}

function StatusChip({ status }) {
  const map = {
    PENDING:   { bg: 'rgba(255,255,255,0.06)', fg: 'rgba(255,255,255,0.55)' },
    STAGED:    { bg: 'rgba(74,222,128,0.10)',  fg: '#4ade80' },
    COMMITTED: { bg: 'rgba(74,222,128,0.10)',  fg: '#4ade80' },
    REJECTED:  { bg: 'rgba(248,113,113,0.10)', fg: '#f87171' },
    SUPERSEDED:{ bg: 'rgba(148,163,184,0.10)', fg: '#94a3b8' },
  };
  const s = map[status] || map.PENDING;
  return (
    <span style={{
      fontSize: 9, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase',
      padding: '2px 6px', borderRadius: 6, background: s.bg, color: s.fg,
    }}>{status}</span>
  );
}

function labelForTerm(k) {
  if (k === 'commission_pct')        return 'Commission';
  if (k === 'brokerage_pct')         return 'Brokerage';
  if (k === 'profit_commission_pct') return 'Profit commission';
  return k;
}

function firstLineOf(text) {
  if (!text) return '';
  const i = text.indexOf('\n');
  return i === -1 ? text : text.slice(0, i);
}
function stripTitle(text) {
  if (!text) return '';
  const i = text.indexOf('\n');
  return i === -1 ? '' : text.slice(i + 1).trim();
}

// ──────────────────────────────────────────────────────────────────
// Section 6 — Sources
// ──────────────────────────────────────────────────────────────────
function SectionSources({ report, rowRefs, highlightedIdx }) {
  const sources = Array.isArray(report.sources) ? report.sources : [];
  return (
    <section>
      <SectionHeader>Sources</SectionHeader>
      <Card>
        {sources.length === 0
          ? <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)' }}>No sources cited.</div>
          : (
            <ol style={{ margin: 0, paddingLeft: 22, fontSize: 12, lineHeight: 1.6, color: 'rgba(255,255,255,0.80)' }}>
              {sources.map((s) => {
                const isHi = highlightedIdx === s.idx;
                return (
                  <li
                    key={s.idx}
                    ref={(el) => {
                      if (rowRefs?.current) {
                        if (el) rowRefs.current.set(s.idx, el);
                        else rowRefs.current.delete(s.idx);
                      }
                    }}
                    style={{
                      marginBottom: 6,
                      background: isHi ? 'rgba(103,232,249,0.10)' : 'transparent',
                      borderRadius: 6, padding: isHi ? '4px 6px' : 0,
                      transition: 'background 0.3s ease',
                    }}
                  >
                    <div style={{ color: '#fff', fontWeight: 600 }}>{s.title}</div>
                    {(() => {
                      const linkStyle = {
                        color: '#67e8f9', fontSize: 11, textDecoration: 'none',
                        wordBreak: 'break-all', display: 'inline-block', maxWidth: '100%',
                        overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                      };
                      const href = safeHref(s.url);
                      return href
                        ? <a href={href} target="_blank" rel="noreferrer noopener" style={linkStyle}>{s.url}</a>
                        : <span style={{ ...linkStyle, color: 'rgba(255,255,255,0.55)' }}>{s.url}</span>;
                    })()}
                    {s.snippet && <div style={{ fontStyle: 'italic', color: 'rgba(255,255,255,0.55)', marginTop: 2 }}>“{s.snippet}”</div>}
                  </li>
                );
              })}
            </ol>
          )}
      </Card>
    </section>
  );
}

// ──────────────────────────────────────────────────────────────────
// Confirm-stage dialog (warnings present)
// ──────────────────────────────────────────────────────────────────
function ConfirmStageDialog({ warnings, onCancel, onConfirm }) {
  return (
    <div
      // Backdrop dismissal is a pointer-only convenience; keyboard users
      // cancel via the labelled Cancel button below.
      role="presentation"
      style={{
        position: 'fixed', inset: 0, zIndex: 1500,
        background: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(4px)',
        display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20,
      }}
      onClick={(e) => { if (e.target === e.currentTarget) onCancel?.(); }}
    >
      <div style={{
        background: 'rgba(14,22,45,0.98)', border: '1px solid rgba(251,191,36,0.40)',
        borderRadius: 12, padding: 18, width: 'min(440px, 100%)', color: '#fff',
      }}>
        <div style={{
          fontSize: 12, fontWeight: 900, letterSpacing: '.12em',
          textTransform: 'uppercase', color: '#fbbf24', marginBottom: 10,
        }}>⚠ Compliance warning{warnings.length === 1 ? '' : 's'}</div>
        <div style={{ fontSize: 13, color: 'rgba(255,255,255,0.80)', marginBottom: 10 }}>
          This recommendation has {warnings.length} compliance warning{warnings.length === 1 ? '' : 's'}.
          Review before staging.
        </div>
        <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12, color: 'rgba(255,255,255,0.75)' }}>
          {warnings.map((w, i) => <li key={i} style={{ marginBottom: 4 }}>{w}</li>)}
        </ul>
        <div style={{ marginTop: 14, display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button className="bbg-btn" onClick={onCancel}>Cancel</button>
          <button
            className="bbg-btn bbg-btn--offer"
            style={{ borderColor: 'rgba(251,191,36,0.45)', color: '#fbbf24' }}
            onClick={onConfirm}
          >Acknowledge &amp; Stage</button>
        </div>
      </div>
    </div>
  );
}

// ──────────────────────────────────────────────────────────────────
// Style helpers
// ──────────────────────────────────────────────────────────────────
const cellHeadL = { textAlign: 'left',  fontSize: 10, fontWeight: 800, letterSpacing: '.08em', textTransform: 'uppercase', padding: '4px 6px 6px 0', borderBottom: '1px solid rgba(255,255,255,0.08)' };
const cellHeadR = { ...cellHeadL, textAlign: 'right' };
const cellL = { padding: '6px 6px 6px 0', borderBottom: '1px solid rgba(255,255,255,0.05)', color: 'rgba(255,255,255,0.85)' };
const cellR = { ...cellL, textAlign: 'right', fontVariantNumeric: 'tabular-nums' };
