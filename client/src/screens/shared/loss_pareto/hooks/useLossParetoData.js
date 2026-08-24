// loss_pareto/hooks/useLossParetoData.js — the LossParetoScreen load
// effect, moved verbatim from the screen body (Phase 4.2). Same fetch
// order, same fallback chain (structure layers → server structure →
// prop caps; treaty losses → cedant portfolio), same snapshot-restore
// conditionals — only the setState calls became reducer dispatches.
// Hydration happens inside the fetch flow, before loading flips off,
// exactly as before (the useScreenSave/useResource discipline).

import { useEffect } from 'react';
import { api } from '../../../../api';
import { toN as cn } from '../../../../utils/format';
import { sumLayerLimits } from '../math/distributions';
import { logger } from '../../../../utils/logger';

/**
 * @param {{
 *   contractId: string,
 *   lossType: 'large' | 'cat',
 *   appState: Record<string, any>,
 *   td: Record<string, any>,
 *   actions: import('./useLossParetoState').LossParetoActions,
 * }} opts
 */
export function useLossParetoData({ contractId, lossType, appState, td, actions }) {
  useEffect(() => {
    if (!contractId) { actions.loadDone(); return; }
    (async () => {
      try {
        const qm = appState.quoteMode ? { quote: true } : undefined;
        const isNpCat = lossType === 'cat';

        const [treaty, lossData, snapshotData] = await Promise.all([
          api.getContract(contractId, qm).catch(() => ({})),
          (lossType === 'cat' ? api.getCatLosses : api.getLargeLosses)(contractId, qm),
          api.getLossSelectionLatest(contractId, lossType, qm).catch(() => null),
        ]);

        // Fetch structure layers: prefer appState (already loaded by NpStructure),
        // fall back to a server fetch so the cap is correct even on direct
        // navigation. Gate the fallback on the CONTRACT's actual category —
        // on a proportional treaty GET /:id/non-prop is fenced with a 409
        // that the browser logs on every navigation, and wizardMode is not a
        // reliable signal on a deep link (it resets to PROP). Quote flows are
        // always non-proportional in this build.
        let npCap = 0;
        const stateLayers = appState.npStructureLayers || [];
        const category = String(treaty?.header?.treaty_category || treaty?.treaty_category || '').toUpperCase();
        const isNpTreaty = appState.quoteMode || (category ? category.startsWith('NON') : appState.wizardMode === 'NP');
        if (stateLayers.length > 0) {
          npCap = sumLayerLimits(stateLayers, isNpCat);
        } else if (isNpTreaty) {
          // getNonPropTreaty returns { layers: [{layer_limit, peril_scope}] }.
          const npData = await api.getNonPropTreaty(contractId, qm).catch(() => null);
          const serverLayers = npData?.layers || [];
          if (serverLayers.length > 0) {
            npCap = sumLayerLimits(serverLayers, isNpCat);
          }
        }
        const parseLossList = (raw) => (Array.isArray(raw) ? raw : [])
          .filter(l => l.is_selected !== false)
          .map(l => { const inc = cn(l.incurred) || (cn(l.paid) + cn(l.os)); return { ...l, incurred: inc, inflated: inc * cn(l.inflation_factor || 1) }; })
          .filter(l => l.inflated > 0);
        // Portfolio fallback uses all inflated losses regardless of their
        // is_selected status on the source treaties, so skip that filter.
        const parsePortfolioLossList = (raw) => (Array.isArray(raw) ? raw : [])
          .map(l => { const inc = cn(l.incurred) || (cn(l.paid) + cn(l.os)); return { ...l, incurred: inc, inflated: inc * cn(l.inflation_factor || 1) }; })
          .filter(l => l.inflated > 0);
        const list = lossData?.losses || lossData?.rows || lossData || [];
        let parsed = parseLossList(list);
        // No losses saved for this treaty → fall back to the cedant's wider
        // portfolio (large/cat losses across its other treaties) so the curve
        // still renders. Contract mode only; quotes keep the empty state.
        let fallback = null;
        if (parsed.length === 0 && !qm) {
          const pf = await api.getPortfolioLosses(contractId, lossType).catch(() => null);
          const pfParsed = parsePortfolioLossList(pf?.losses || []);
          if (pfParsed.length > 0) { parsed = pfParsed; fallback = { treatyCount: pf?.treatyCount || 0 }; }
        }
        actions.lossesLoaded(parsed, fallback);
        const vals = parsed.map(l => l.inflated).sort((a, b) => a - b);
        const det = treaty?.detail || {};
        // NP: use risk or cat layer sum from structure. Prop: for cat use event_limit; for large loss use capacity/limit.
        const propCap = lossType === 'cat'
          ? (cn(det.event_limit) || cn(td.eventLimit) || cn(det.total_capacity) || cn(td.totalCapacity) || cn(det.qs_limit) || cn(td.qsLimit) || 0)
          : (cn(det.total_capacity) || cn(td.totalCapacity) || cn(det.qs_limit) || cn(td.qsLimit) || cn(det.event_limit) || cn(td.eventLimit) || 0);
        const cap = npCap > 0 ? npCap : propCap;

        // Restore from saved snapshot if available.
        // For NP: structure cap ALWAYS sets the limit (structure may have changed since snapshot).
        // Snapshot only restores the analytical parameters (xm, alpha, years, dist).
        const snap = snapshotData?.snapshot;
        if (snap) {
          const patch = {};
          if (snap.pareto_xm > 0) patch.xm = snap.pareto_xm;
          else if (vals.length) patch.xm = vals[0];
          // limit: use live structure cap for NP; fall back to snapshot for prop
          if (cap > 0) patch.limit = cap;
          else if (snap.pareto_limit > 0) patch.limit = snap.pareto_limit;
          if (snap.observation_years) patch.yearsOvr = String(snap.observation_years);
          if (snap.active_distribution) patch.activeDist = snap.active_distribution;
          if (snap.pareto_alpha > 0) patch.alpha = snap.pareto_alpha;
          // layer_burning_cost and oep_input are nested inside return_period_curve
          // because the server only persists a whitelist of top-level keys.
          const rpc = snap.return_period_curve || {};
          if (rpc.layer_burning_cost) {
            if (typeof rpc.layer_burning_cost.wEmp === 'number') patch.wEmp = rpc.layer_burning_cost.wEmp;
            if (typeof rpc.layer_burning_cost.wModel === 'number') patch.wModel = rpc.layer_burning_cost.wModel;
          }
          if (rpc.oep_input && lossType === 'cat' && Array.isArray(rpc.oep_input)) {
            patch.oepRows = rpc.oep_input;
          }
          // Third-party RP comparison state (CAT only).
          if (lossType === 'cat' && rpc.third_party_rp) {
            const tp = rpc.third_party_rp;
            if (Array.isArray(tp.rows)) patch.tpRows = tp.rows;
            if (typeof tp.source === 'string') patch.tpSource = tp.source;
            if (tp.selection === 'FITTED' || tp.selection === 'TP' || tp.selection === 'BLEND') {
              patch.rpSource = tp.selection;
            }
            if (typeof tp.blend === 'number') patch.rpBlend = tp.blend;
          }
          patch.savedSnapshotId = snap.snapshot_id || null;
          actions.snapshotHydrated(patch);
        } else {
          if (vals.length) actions.xmDefaulted(vals[0]);
          if (cap > 0) actions.setLimit(cap);
        }
      } catch (e) { logger.error('Pareto load', e); }
      actions.loadDone();
    })();
  }, [appState.npStructureLayers, appState.quoteMode, appState.wizardMode, contractId, lossType, td.eventLimit, td.qsLimit, td.totalCapacity, actions]);
}

export default useLossParetoData;
