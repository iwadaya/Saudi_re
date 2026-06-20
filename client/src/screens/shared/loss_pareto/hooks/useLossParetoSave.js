// loss_pareto/hooks/useLossParetoSave.js — snapshot persistence for
// LossParetoScreen, moved verbatim from the screen body (Phase 4.2):
// the full snapshot payload builder, the explicit save (wired to the
// Save Curve button and WizardLayout's onBeforeNext/onBeforeBack), and
// the 800ms debounced auto-save with its OK→failed toast edge-trigger.
// Save lifecycle state rides the reducer (SAVE_STARTED / SUCCEEDED / FAILED).

import { useCallback, useEffect, useRef } from 'react';
import { api } from '../../../../api';
import { toN as cn } from '../../../../utils/format';
import { logger } from '../../../../utils/logger';

/* ── Helpers ── */
function stableStringify(obj){
  const seen=new WeakSet();
  const norm=(v)=>{
    if(v&&typeof v==='object'){
      if(seen.has(v)) return null;
      seen.add(v);
      if(Array.isArray(v)) return v.map(norm);
      const out={};
      for(const k of Object.keys(v).sort()) out[k]=norm(v[k]);
      return out;
    }
    return v;
  };
  return JSON.stringify(norm(obj));
}
async function sha256Hex(str){
  // crypto.subtle is only defined in secure contexts (HTTPS, or
  // localhost / 127.0.0.1). Plain-HTTP origins — like a LAN IP
  // served on :3000/:4000 during internal testing — leave
  // crypto.subtle undefined and reading .digest throws the
  // "Cannot read properties of undefined" we saw in the field.
  // Fall back to a cheap non-cryptographic hash so the snapshot
  // still saves; the digest is only used for change detection,
  // not for security, so collision resistance is best-effort.
  const enc = new TextEncoder().encode(str);
  if (globalThis.crypto?.subtle?.digest) {
    const buf = await globalThis.crypto.subtle.digest('SHA-256', enc);
    return Array.from(new Uint8Array(buf)).map(b => b.toString(16).padStart(2, '0')).join('');
  }
  // djb2 → 32-bit unsigned → hex. Good enough for "did this
  // snapshot change?" equality; NOT a cryptographic hash.
  let h = 5381;
  for (let i = 0; i < enc.length; i++) h = ((h * 33) ^ enc[i]) >>> 0;
  return h.toString(16).padStart(8, '0');
}

/**
 * @param {{
 *   contractId: string,
 *   lossType: 'large' | 'cat',
 *   appState: Record<string, any>,
 *   state: import('../state/lossParetoReducer').LossParetoState,
 *   derived: ReturnType<typeof import('./useLossParetoDerived').useLossParetoDerived>,
 *   actions: import('./useLossParetoState').LossParetoActions,
 *   showToast: (msg: string) => void,
 * }} opts
 * @returns {{ saveSnapshot: () => Promise<boolean> }}
 */
export function useLossParetoSave({ contractId, lossType, appState, state, derived, actions, showToast }) {
  const {
    losses, portfolioFallback, loading, xm, limit, alpha, activeDist, yearsOvr,
    tpRows, tpSource, rpSource, rpBlend, oepRows, wEmp, wModel,
  } = state;
  const { fits, returnPeriods, effectiveReturnPeriods, blendedLayerRols, oepLayerRols } = derived;

  // Build the full snapshot payload.
  const buildSnapshotPayload = useCallback(async () => {
    const pts = returnPeriods.map(p => ({ rp: p.rp, loss: p.loss }));
    const rp10 = pts.find(p => p.rp === 10)?.loss ?? null;
    const rp50 = pts.find(p => p.rp === 50)?.loss ?? null;
    const rp100 = pts.find(p => p.rp === 100)?.loss ?? null;
    const rp250 = pts.find(p => p.rp === 250)?.loss ?? null;

    // Serialize all 4 distribution fits for audit
    const distFits = fits.map(f => ({
      key: f.key, params: f.params, ks: { ks: f.ks.ks, pValue: f.ks.pValue },
      paramStr: f.paramStr, n: f.n,
    }));

    const assumptions = {
      lossType, activeDist, xm, limit, yearsOvr: String(yearsOvr || ''),
      selected: losses.map(l => ({ id: l.loss_id, infl: cn(l.inflation_factor || 1) })).sort((a, b) => String(a.id).localeCompare(String(b.id))),
    };
    const assumptions_hash = await sha256Hex(stableStringify(assumptions));

    return {
      selected_count: losses.length,
      selected_losses: losses.map(l => ({
        loss_id: l.loss_id, uw_year: l.uw_year, insured_name: l.insured_name, loss_name: l.loss_name,
        date_of_loss: l.date_of_loss, class_of_business: l.class_of_business,
        paid: l.paid, os: l.os, incurred: l.incurred, inflation_factor: l.inflation_factor, inflated: l.inflated,
      })),
      distribution_fits: distFits,
      active_distribution: activeDist,
      pareto_xm: xm,
      pareto_alpha: alpha,
      pareto_limit: limit,
      observation_years: Number(yearsOvr) || 10,
      // return_period_curve carries the layer burning cost + OEP payload too,
      // since the server only persists a whitelist of top-level keys but stores
      // this one as JSONB. Nesting keeps everything within a column the handler
      // already round-trips.
      return_period_curve: {
        activeDist, xm, limit, yearsOvr: yearsOvr || null, points: pts,
        layer_burning_cost: {
          wEmp,
          wModel,
          rows: blendedLayerRols.map(r => ({
            layer:        r.layer,
            deductible:   r.D,
            limit:        r.L,
            return_period: r.rp,
            empirical_rol: r.empiricalRol,
            model_rol:     r.modelRol,
            blended_rol:   r.blendedRol,
            blended_annual_loss: r.blendedAnnual,
          })),
        },
        ...(lossType === 'cat' ? {
          oep_input: oepRows,
          oep_layer_burning_cost: oepLayerRols.map(r => ({
            layer:       r.layer,
            deductible:  r.D,
            limit:       r.L,
            return_period: r.rp,
            annual_loss: r.annualLoss,
            rol:         r.rol,
          })),
          third_party_rp: {
            rows: tpRows,
            source: tpSource,
            selection: rpSource,
            blend: rpBlend,
            effective_points: effectiveReturnPeriods,
          },
        } : {}),
      },
      return_period_key_points: { rp10, rp50, rp100, rp250 },
      assumptions_hash,
    };
  }, [lossType, activeDist, xm, limit, yearsOvr, alpha, losses, fits, returnPeriods, wEmp, wModel, blendedLayerRols, oepRows, oepLayerRols, tpRows, tpSource, rpSource, rpBlend, effectiveReturnPeriods]);

  // Explicit save function
  const saveSnapshot = useCallback(async () => {
    // Never persist a portfolio-fallback curve as this treaty's own snapshot.
    // Nothing to save here is a clean no-op, not a failure — return true so
    // WizardLayout doesn't surface a red "Save failed" banner on navigation.
    if (!contractId || !losses.length || xm <= 0 || portfolioFallback) return true;
    try {
      actions.saveStarted();
      const payload = await buildSnapshotPayload();
      await api.saveLossSelectionSnapshot(contractId, lossType, payload, appState.quoteMode ? { quote: true } : undefined);
      actions.saveSucceeded(new Date());
      return true;
    } catch (e) {
      logger.error('Save return period snapshot failed', e);
      actions.saveFailed(e?.message || String(e));
      return false;
    }
  }, [contractId, lossType, losses, xm, buildSnapshotPayload, appState.quoteMode, portfolioFallback, actions]);

  // Auto-save on debounce when key parameters change. Toast only on the
  // OK→failed transition so a flaky network doesn't spam the user every
  // 800ms; the inline ⚠ banner already shows the persistent error.
  const lastAutoSaveOkRef = useRef(true);
  useEffect(() => {
    if (loading || !contractId || !losses.length || xm <= 0 || !returnPeriods.length || portfolioFallback) return;
    const t = setTimeout(async () => {
      const ok = await saveSnapshot();
      if (!ok && lastAutoSaveOkRef.current) {
        showToast('Pareto auto-save failed — click Save Curve to retry');
      }
      lastAutoSaveOkRef.current = ok;
    }, 800);
    return () => { clearTimeout(t); };
  }, [loading, contractId, lossType, losses, xm, limit, alpha, activeDist, yearsOvr, returnPeriods, saveSnapshot, showToast, portfolioFallback]);

  return { saveSnapshot };
}

export default useLossParetoSave;
