// src/components/FacPendingRecsBanner.jsx
//
// Renders a thin "📄 N recommendations from the Aug 12 survey — Review"
// banner just below the wizard header. Only fires for fac screens
// (routeKey starts with FAC_).
//
// Behaviour:
//   • Fetches pending recommendations for the current risk, grouped by
//     target_screen, and shows the count for the current screen.
//   • Click → navigates to /fac/:id/documents?analysis=:analysisId so
//     FacDocuments can open the right drawer.
//   • Dismissible — per-session, no server state. Dismissal is keyed by
//     (riskId, target_screen) so dismissing on Pricing doesn't hide the
//     banner on Risk Detail.
//   • Caches the analyses fetch in-module for 30s so navigating
//     between fac screens doesn't refetch on every render.

import { useState, useEffect, useRef } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api';
import { useFacRiskId } from '../hooks/useContractId';

const CACHE_TTL = 30_000;
const _cache = new Map();   // riskId → { at, analyses }
const _dismissed = new Set(); // `${riskId}|${screen}` keys (session-local)

const ROUTE_KEY_TO_SCREEN = {
  FAC_RISK_DETAIL:  'FAC_RISK_DETAIL',
  FAC_LOCATIONS:    'FAC_LOCATIONS',
  FAC_COPE:         'FAC_COPE',
  FAC_PRICING:      'FAC_PRICING',
  FAC_LOSS_HISTORY: 'FAC_LOSS_HISTORY',
  FAC_DEDUCTIBLES:  'FAC_DEDUCTIBLES',
};

async function fetchAnalysesCached(riskId) {
  const hit = _cache.get(riskId);
  if (hit && Date.now() - hit.at < CACHE_TTL) return hit.analyses;
  const data = await api.facGetAnalyses(riskId);
  const analyses = data?.analyses || [];
  _cache.set(riskId, { at: Date.now(), analyses });
  return analyses;
}

/** Convenience: invalidate the cache for one risk. Wire-up later if
 * we want the banner to refresh after a screen accepts a rec. */
export function invalidateFacPendingRecsCache(riskId) {
  if (riskId) _cache.delete(riskId);
}

export default function FacPendingRecsBanner({ routeKey }) {
  const navigate = useNavigate();
  const riskId = useFacRiskId();
  const targetScreen = ROUTE_KEY_TO_SCREEN[routeKey] || null;
  const [analyses, setAnalyses] = useState([]);
  const [pendingByScreen, setPendingByScreen] = useState({});
  const [tick, setTick] = useState(0);  // re-render trigger on dismiss
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => { mountedRef.current = false; };
  }, []);

  useEffect(() => {
    if (!riskId || !routeKey || !routeKey.startsWith('FAC_')) return;
    let cancelled = false;
    (async () => {
      try {
        const list = await fetchAnalysesCached(riskId);
        if (cancelled || !mountedRef.current) return;
        setAnalyses(list);
        // Pull the per-screen pending breakdown by fetching the
        // detail rows for analyses that report a pending count.
        // We avoid this if there are no pending recs at all.
        const interesting = list.filter((a) => Number(a.pending_count || 0) > 0);
        if (interesting.length === 0) {
          setPendingByScreen({});
          return;
        }
        const details = await Promise.all(
          interesting.map((a) => api.facGetAnalysis(a.analysis_id).catch(() => null)),
        );
        if (cancelled || !mountedRef.current) return;
        // For each analysis, count its pending recs per screen.
        const map = {};   // screen → [{ analysis, count, latestAt }]
        for (let i = 0; i < details.length; i++) {
          const d = details[i];
          if (!d) continue;
          const a = interesting[i];
          for (const r of d.recommendations || []) {
            if (r.status !== 'PENDING') continue;
            if (!map[r.target_screen]) map[r.target_screen] = [];
            const bucket = map[r.target_screen];
            let entry = bucket.find((e) => e.analysis_id === a.analysis_id);
            if (!entry) {
              entry = {
                analysis_id: a.analysis_id,
                document_filename: a.document_filename,
                document_kind: a.document_kind,
                created_at: a.created_at,
                count: 0,
              };
              bucket.push(entry);
            }
            entry.count += 1;
          }
        }
        setPendingByScreen(map);
      } catch (e) {
        console.error('[FacPendingRecsBanner] load failed:', e);
      }
    })();
    return () => { cancelled = true; };
  }, [riskId, routeKey, tick]);

  if (!riskId || !targetScreen) return null;
  const dismissKey = `${riskId}|${targetScreen}`;
  if (_dismissed.has(dismissKey)) return null;

  const forScreen = pendingByScreen[targetScreen] || [];
  if (forScreen.length === 0) return null;

  // Pick the most-recent analysis as the click target — the underwriter
  // gets routed to the freshest source of suggestions for this screen.
  const top = [...forScreen].sort((a, b) => (b.created_at || '').localeCompare(a.created_at || ''))[0];
  const totalCount = forScreen.reduce((s, e) => s + e.count, 0);
  const docLabel = top.document_filename || top.document_kind || 'document';

  const goToDocs = () => {
    navigate(`/fac/${riskId}/documents?analysis=${encodeURIComponent(top.analysis_id)}`);
  };
  const dismiss = (e) => {
    e.stopPropagation();
    _dismissed.add(dismissKey);
    setTick((t) => t + 1);
  };

  return (
    <div role="button" tabIndex={0} aria-live="polite"
         onClick={goToDocs}
         onKeyDown={(e) => {
           if (e.target !== e.currentTarget) return;
           if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); goToDocs(); }
         }}
         style={{
           margin: '6px 0 10px', padding: '8px 14px',
           display: 'flex', alignItems: 'center', gap: 10,
           background: 'rgba(168,85,247,0.08)',
           border: '1px solid rgba(168,85,247,0.30)',
           borderRadius: 8,
           cursor: 'pointer',
           transition: 'background .12s',
         }}>
      <span aria-hidden="true" style={{ fontSize: 14 }}>📄</span>
      <span style={{ fontSize: 12, color: 'var(--text)', flex: 1 }}>
        <strong style={{ color: '#a855f7' }}>
          {totalCount} recommendation{totalCount === 1 ? '' : 's'}
        </strong>
        {' from '}
        <span style={{ color: 'rgba(var(--text-rgb),0.85)' }}>
          {docLabel}
        </span>
        {analyses.length > 1 && forScreen.length > 1
          ? <span style={{ color: 'var(--muted)' }}>{` (+${forScreen.length - 1} more)`}</span>
          : null}
        {' — '}
        <span style={{ color: '#a855f7', fontWeight: 700 }}>Review</span>
      </span>
      <button type="button" onClick={dismiss}
              style={{ background: 'none', border: 'none', fontFamily: 'inherit', lineHeight: 'inherit',
                       cursor: 'pointer', color: 'var(--muted)', fontSize: 14, padding: '0 4px' }}
              title="Dismiss for this session"
              aria-label="Dismiss banner">×</button>
    </div>
  );
}
