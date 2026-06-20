// useAnalysisDrawerState.js — state + flows behind the analysis drawer
// (Phase 4.2 decomposition of FacDocuments.jsx):
//   • analysis detail load/reload + factor-option master list
//   • per-recommendation accept / reject with busy tracking
//   • bulk "accept all ≥ 0.85" with a concurrency cap of 3
//   • the 10s "Accepted just now" flash + the applied-screen pill
//   • session-scoped Undo of an acceptance (useRecommendationUndo)
import { useState, useEffect, useCallback, useRef } from 'react';
import api from '../../../../api';
import { invalidateFacPendingRecsCache } from '../../../../components/FacPendingRecsBanner';
import useRecommendationUndo from './useRecommendationUndo';
import { logger } from '../../../../utils/logger';

export default function useAnalysisDrawerState({ analysisId, riskId }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
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
  // Session-scoped undo of an acceptance: captures the prior value
  // around each accept and restores it via the wizard save APIs.
  const {
    captureBeforeAccept, recordAccepted, undoAccept, getUndoState,
  } = useRecommendationUndo({ riskId });

  useEffect(() => {
    if (!analysisId) return;
    setLoading(true);
    api.facGetAnalysis(analysisId)
      .then(setData)
      .catch((e) => logger.error('[AnalysisDrawer] load failed:', e))
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
      .catch((e) => logger.error('[AnalysisDrawer] reload failed:', e));
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

  const clearAppliedFlash = (id) => {
    const handle = justAppliedRef.current.get(id);
    if (handle) clearTimeout(handle);
    justAppliedRef.current.delete(id);
    setJustApplied((prev) => {
      if (!prev.has(id)) return prev;
      const next = new Map(prev);
      next.delete(id);
      return next;
    });
  };

  const onAccept = useCallback(async (rec, overrideValue) => {
    markBusy(rec.recommendation_id, true);
    try {
      // Snapshot whatever the accept response won't echo back (clause
      // comments, append id-sets) BEFORE the apply mutates the data.
      // Never throws — a failed capture only disables Undo.
      const capture = await captureBeforeAccept(rec);
      const payload = overrideValue !== undefined ? { override_value: overrideValue } : {};
      const resp = await api.facAcceptRecommendation(rec.recommendation_id, payload);
      recordAccepted(
        rec,
        overrideValue !== undefined ? overrideValue : rec.suggested_value,
        resp,
        capture,
      );
      flashApplied(rec.recommendation_id);
      setAppliedPill({ screen: rec.target_screen, field: rec.target_field });
      invalidateFacPendingRecsCache(riskId);
      await reload();
    } catch (e) {
      logger.error('[AnalysisDrawer] accept failed:', e);
    } finally {
      markBusy(rec.recommendation_id, false);
    }
  }, [reload, riskId, captureBeforeAccept, recordAccepted]);

  const onReject = useCallback(async (rec, reason) => {
    markBusy(rec.recommendation_id, true);
    try {
      await api.facRejectRecommendation(rec.recommendation_id, reason ? { reason } : {});
      invalidateFacPendingRecsCache(riskId);
      await reload();
    } catch (e) {
      logger.error('[AnalysisDrawer] reject failed:', e);
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
          const capture = await captureBeforeAccept(rec);
          const resp = await api.facAcceptRecommendation(rec.recommendation_id, {});
          recordAccepted(rec, rec.suggested_value, resp, capture);
          flashApplied(rec.recommendation_id);
          lastScreen = rec.target_screen;
        } catch (e) {
          logger.error('[AnalysisDrawer] bulk accept item failed:', e);
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
  }, [data, reload, riskId, captureBeforeAccept, recordAccepted]);

  // Undo an acceptance made this session: restore the prior value via
  // the wizard save APIs (see useRecommendationUndo for the per-family
  // mapping), drop the "Accepted just now" flash and its timer, retract
  // the applied pill when it points at this field, and reload. The rec
  // row itself stays ACCEPTED server-side — no unaccept endpoint exists
  // — so the card renders the local "undone" marker instead.
  const onUndo = useCallback(async (rec) => {
    const id = rec.recommendation_id;
    markBusy(id, true);
    try {
      const ok = await undoAccept(rec);
      if (!ok) return; // failure surfaced via getUndoState(id).error
      clearAppliedFlash(id);
      setAppliedPill((p) => (p && p.field === rec.target_field ? null : p));
      invalidateFacPendingRecsCache(riskId);
      await reload();
    } finally {
      markBusy(id, false);
    }
  }, [undoAccept, reload, riskId]);

  return {
    data,
    loading,
    factorOptions,
    busyRecs,
    justApplied,
    appliedPill,
    bulkProgress,
    groupCollapseRef,
    onAccept,
    onReject,
    onAcceptHighConfidence,
    onUndo,
    getUndoState,
  };
}
