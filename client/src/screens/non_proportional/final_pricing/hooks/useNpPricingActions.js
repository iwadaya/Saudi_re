// hooks/useNpPricingActions.js — Phase 4.1 (docs/frontend-hardening.md).
//
// The screen's imperative handlers — actuarial-engine runs, the dual
// relational+JSONB save (optimistic lock + STALE_WRITE/PRICING_DRIFT
// handling), and the offer workflow (submit/approve/sign/NTU/return/
// decline) — moved VERBATIM out of NpFinalPricing.jsx. Deliberately a
// plain-JS hook so the money-path bodies needed zero translation; all
// state flows through the typed reducer surface passed in as `pricing`
// (see hooks/useNpPricingState.ts).

import { useCallback } from 'react';
import { api } from '../../../../api';
import { calcLayerPricing } from '../../../../utils/npPricingEngine';
import { handleStaleWrite } from '../../../../utils/handleStaleWrite';
import { isReadOnlyError } from '../../../../utils/readOnlyError';
import { formatPricingDriftMessage } from '../../../../utils/pricingErrors';
import { useGlobalToast } from '../../../../hooks/useToast';
import { toN } from '../formatters.js';
import { expLayerEarnedPremium, normalizeQuoteStructures } from '../fqQuoteMath.js';
import { logger } from '../../../../utils/logger';

/**
 * @param {{
 *   pricing: import('./useNpPricingState').NpPricingStateApi,
 *   contractId: string,
 *   quoteMode: boolean,
 *   isQuote: boolean,
 *   npDetail: Record<string, any>,
 *   mode: string,
 *   structRefsMap: { current: Record<string, any> },
 *   actorName: string,
 *   readOnly?: boolean,
 *   onServerReadOnly?: (assignedToName?: string | null) => void,
 * }} params
 */
export function useNpPricingActions({
  pricing,
  contractId,
  quoteMode,
  isQuote,
  npDetail,
  mode,
  structRefsMap,
  actorName,
  // Edit-lock verdict (useEditLock). When true the save path no-ops so wizard-
  // nav / workflow saves stop POSTing into a 403. Strictly gated on an explicit
  // read-only — absent/undefined ⇒ editable (golden-master fixtures resolve no
  // permission, so they stay fully editable and byte-identical).
  readOnly = false,
  onServerReadOnly,
}) {
  const showToast = useGlobalToast();
  const {
    layers, leadSetup, treatyMetrics, expLayers, clientStructures,
    quoteStructures, approvedStructures, quotePricing, quoteCurve,
    quoteCobUwLimits, cobToggles, cobManual, selectedCobs,
    layerWrittenLines, signedLinePcts, offerApprover, offerComment,
    returnReason, lastUpdatedAt,
    getCobFlags,
    engineStart, engineFinish, engineError,
    applyEngineResults, applyQuoteEngineResults,
    saveStart, saveSaved, saveFailed, setLastUpdatedAt,
    setOfferStatus, setApprovalTrail, setReturnReason,
  } = pricing;

  const runQuoteCalcEngine = useCallback(async (structureIndex = null) => {
    if (!contractId || !clientStructures.length) return;
    // structureIndex omitted (or non-integer, e.g. a click event) → run
    // all structures, preserving the global button's behaviour.
    const targetAll = !Number.isInteger(structureIndex);
    // Resolve the target's stable identity up front so an in-flight calc
    // can't merge into the wrong structure if the list is removed/reordered
    // mid-run. Match the build loop on this scope; id-less structures fall
    // back to their positional scope (str-<idx>).
    const targetScope = targetAll
      ? null
      : (clientStructures[structureIndex]?.id || `str-${structureIndex}`);
    const pricingLayers = [];
    const refs = [];
    clientStructures.forEach((structure, sIdx) => {
      const scope = structure.id || `str-${sIdx}`;
      if (!targetAll && scope !== targetScope) return;
      (structure.layers || []).forEach((layer, lIdx) => {
        const classOfBusinessIds = selectedCobs
          .filter((cob) => !!getCobFlags(scope, cob.id, structure.layers)[lIdx])
          .map((cob) => cob.id);
        const layerKey = `${scope}:${layer.id ?? lIdx}`;
        refs.push(layerKey);
        pricingLayers.push({
          ...layer,
          layer: `S${sIdx + 1}L${lIdx + 1}`,
          deductible: layer.attachment || layer.deductible,
          egnpi: layer.egnpi || quoteCurve.baseEgnpi || npDetail.estGnpi || npDetail.egnpi || '',
          riskCover: !!layer.risk,
          catCover: !!layer.cat,
          classOfBusinessIds,
        });
      });
    });
    if (!pricingLayers.length) return;

    engineStart(targetAll ? null : structureIndex);
    try {
      const results = await calcLayerPricing(
        api,
        contractId,
        pricingLayers,
        { ...npDetail, estGnpi: quoteCurve.baseEgnpi || npDetail.estGnpi || npDetail.egnpi },
        mode,
        quoteMode,
      );
      const byKey = new Map();
      results.forEach((result) => {
        const key = refs[result.idx];
        if (key) byKey.set(key, result);
      });
      applyQuoteEngineResults(byKey);
    } catch (e) {
      logger.error('[NP Quote Calc Engine]', e);
      engineError('Quote calculation failed: ' + (e.message || 'unknown error'));
    } finally {
      engineFinish(targetAll ? null : structureIndex);
    }
  }, [
    contractId,
    clientStructures,
    selectedCobs,
    getCobFlags,
    quoteCurve.baseEgnpi,
    npDetail,
    mode,
    quoteMode,
    engineStart,
    engineFinish,
    engineError,
    applyQuoteEngineResults,
  ]);

  // Both-scope engine run for ONE structure — backs the Pricing Analysis modal's
  // single tab-level CALCULATE button. Prices every layer ACTIVE in either scope
  // (its own risk/cat flags, screen `mode`), so calcLayerPricing returns risk +
  // cat together, and merges them in ONE applyQuoteEngineResults dispatch so both
  // sections' pure burn / Pareto / exposure cells (and Wtd ROL) refresh together.
  // Returns a per-scope, per-component "was anything priced?" summary so the modal
  // can flag missing inputs ("no loss data — burn not calculated") on the affected
  // scope instead of writing 0 (the merge keeps the prior value for a 0 result).
  // Does NOT touch the global engine-running state — the modal shows one local
  // "Calculating…" covering both.
  const runQuoteCalcStructure = useCallback(async (structureIndex) => {
    if (!contractId || !Number.isInteger(structureIndex)) return { ran: false };
    const structure = clientStructures[structureIndex];
    if (!structure) return { ran: false };
    const scope = structure.id || `str-${structureIndex}`;
    const pricingLayers = [];
    const refs = [];
    (structure.layers || []).forEach((layer, lIdx) => {
      if (!layer.risk && !layer.cat) return;   // only layers active in SOME scope
      const classOfBusinessIds = selectedCobs
        .filter((cob) => !!getCobFlags(scope, cob.id, structure.layers)[lIdx])
        .map((cob) => cob.id);
      refs.push(`${scope}:${layer.id ?? lIdx}`);
      pricingLayers.push({
        ...layer,
        layer: `S${structureIndex + 1}L${lIdx + 1}`,
        deductible: layer.attachment || layer.deductible,
        egnpi: layer.egnpi || quoteCurve.baseEgnpi || npDetail.estGnpi || npDetail.egnpi || '',
        riskCover: !!layer.risk,
        catCover: !!layer.cat,
        classOfBusinessIds,
      });
    });
    const emptyScope = () => ({ layerCount: 0, burn: false, pareto: false, exposure: false, lossCount: 0 });
    if (!pricingLayers.length) return { ran: true, risk: emptyScope(), cat: emptyScope() };
    try {
      const results = await calcLayerPricing(
        api,
        contractId,
        pricingLayers,
        { ...npDetail, estGnpi: quoteCurve.baseEgnpi || npDetail.estGnpi || npDetail.egnpi },
        mode,
        quoteMode,
      );
      const byKey = new Map();
      const summary = { risk: emptyScope(), cat: emptyScope() };
      results.forEach((result) => {
        const key = refs[result.idx];
        if (key) byKey.set(key, result);
        ['risk', 'cat'].forEach((sk) => {
          const comp = result[sk];
          if (!comp) return;
          summary[sk].layerCount += 1;
          // scopeLossCount is constant per scope — "were any losses loaded?".
          summary[sk].lossCount = Math.max(summary[sk].lossCount, Number(comp.scopeLossCount) || 0);
          if (toN(comp.pureBurn) > 0) summary[sk].burn = true;
          if (toN(comp.pareto) > 0) summary[sk].pareto = true;
          if (toN(comp.exposureRating) > 0) summary[sk].exposure = true;
        });
      });
      applyQuoteEngineResults(byKey);
      return { ran: true, ...summary };
    } catch (e) {
      // Surface the failure through the returned summary (the modal renders it as an
      // inline note) rather than a console call — keeps the screens console budget flat.
      return { ran: false, error: e.message || 'calculation failed' };
    }
  }, [
    contractId,
    clientStructures,
    selectedCobs,
    getCobFlags,
    quoteCurve.baseEgnpi,
    npDetail,
    mode,
    quoteMode,
    applyQuoteEngineResults,
  ]);

  // ── Actuarial Engine: run all three methods for all layers ────────
  // The per-layer merge (component totals, UW-price seeding) lives in the
  // reducer ('layers/applyEngineResults') — moved verbatim in Phase 4.1.
  const runCalcEngine = useCallback(async () => {
    if (!contractId || !layers.length) return;
    engineStart(null);
    try {
      const results = await calcLayerPricing(api, contractId, layers, npDetail, mode, quoteMode);
      applyEngineResults(results);
    } catch (e) {
      logger.error('[NP Calc Engine]', e);
      engineError('Calculation failed: ' + (e.message || 'unknown error'));
    } finally {
      engineFinish(null);
    }
  }, [contractId, layers, npDetail, mode, quoteMode, engineStart, engineFinish, engineError, applyEngineResults]);

  // Save — dual: relational pricing tables + JSONB terms for full UI state
  // Returns true on success, false on failure. Updates saveState so the UI
  // can show "Saved HH:MM:SS" or a failure banner instead of silently losing data.
  const save = useCallback(async (options = {}) => {
    if (!contractId) return true;
    // Read-only (not the assignee): never POST. Returning true is a no-op that
    // lets wizard navigation proceed; manual edits are already blocked by the
    // inert wrap. Checked before saveStart() so the save indicator never churns.
    if (readOnly) return true;
    const lockOverride = options?.ifUnmodifiedSince;
    let activeLock = lockOverride || lastUpdatedAt;
    const requestOptions = () => (
      quoteMode
        ? { quote: true, ...(activeLock ? { ifUnmodifiedSince: activeLock } : {}) }
        : (activeLock ? { ifUnmodifiedSince: activeLock } : undefined)
    );
    const noteSaved = (response) => {
      if (!response?.updated_at) return;
      activeLock = response.updated_at;
      setLastUpdatedAt(response.updated_at);
    };
    saveStart();
    try {
      // 1. Relational pricing (inputs + per-layer outputs)
      const firstLayer = layers[0] || {};
      const inputs = {
        burn_weight_pct:     firstLayer.riskWeightBurn  || firstLayer.catWeightBurn  || 50,
        exposure_weight_pct: firstLayer.riskWeightExposure || firstLayer.catWeightExposure || 50,
        pareto_weight_pct:   firstLayer.riskWeightPareto || firstLayer.catWeightPareto || 0,
        pricing_loading_pct: firstLayer.riskLoading     || firstLayer.catLoading     || 15,
      };
      const layer_inputs = layers.map((l, i) => ({
        layer_number: i + 1,
        expiring_pricing_pct: l.expiringPricing || null,
      }));
      const outputs = [];
      layers.forEach((l, i) => {
        // contract_np_pricing_outputs.section has a DB CHECK of
        // ('RISK', 'CAT') — one row per peril component. No summary
        // 'BOTH' row: the combined total is derivable from the two
        // component rows (sum of total_price per layer_number) and
        // used to force every PUT for a BOTH-covered layer to 400
        // (Zod) / 23514 (DB).
        //
        // uw_price is deliberately NOT in the outputs payload — the
        // contract_np_pricing_outputs table has no uw_price column,
        // so the server silently dropped the field. The real uw_price
        // persistence goes through `layer_margins` (below), which
        // updates contract_np_layers.uw_price.
        if (l.risk) {
          outputs.push({
            layer_number: i + 1, section: 'RISK',
            pure_burning_cost: l.riskPureBurn, pareto_pricing: l.riskPareto,
            burn_plus_pareto: l.riskAvgBurnPareto, exposure_rating: l.riskExposure,
            burn_weight_pct: l.riskWeightBurn, exposure_weight_pct: l.riskWeightExposure,
            pareto_weight_pct: l.riskWeightPareto,
            pricing_loading_pct: l.riskLoading, total_price: l.riskTotalPrice,
            prob_attach: l.riskPrAttach, prob_exhaust: l.riskPrExhaust,
          });
        }
        if (l.cat) {
          outputs.push({
            layer_number: i + 1, section: 'CAT',
            pure_burning_cost: l.catPureBurn, pareto_pricing: l.catPareto,
            burn_plus_pareto: l.catAvgBurnPareto, exposure_rating: l.catExposure,
            burn_weight_pct: l.catWeightBurn, exposure_weight_pct: l.catWeightExposure,
            pareto_weight_pct: l.catWeightPareto,
            pricing_loading_pct: l.catLoading, total_price: l.catTotalPrice,
            prob_attach: l.catPrAttach, prob_exhaust: l.catPrExhaust,
          });
        }
      });

      // layer_margins: persist per-layer margin columns to contract_np_layers
      // Mapping to NP Final Pricing screen columns:
      //   hist_margin     ← historicalMargin (HIST. MARGIN) → actual_margin in cedant summary
      //   modelled_margin ← reinsurerMargin  (MARGIN)       → actuarial_margin in cedant summary
      //   tech_ratio      ← technicalRatio   (TECH RATIO)
      //   uw_price        ← reinsurerPricing (REINSURER ROL)
      //   expiring_price  ← expiringPricing  (EXPIRING ROL)
      //   lead_price      ← leadPricing      (LEAD ROL)
      const pctToNum = v => {
        const x = parseFloat(String(v ?? '').replace(/%/g, '').trim());
        return Number.isFinite(x) ? x : null;
      };
      // Send a row for every layer, including ones where the user has
      // cleared every margin field — the server writes the values
      // directly, so an all-null row clears the row's margin columns.
      // Filtering all-null rows out meant deletion was silently lost
      // (the column kept its prior value).
      const layer_margins = layers.map((l, i) => ({
        layer_number:    i + 1,
        hist_margin:     pctToNum(l.historicalMargin),
        modelled_margin: pctToNum(l.reinsurerMargin),
        tech_ratio:      pctToNum(l.technicalRatio),
        uw_price:        pctToNum(l.reinsurerPricing) || pctToNum(l.uwPrice),
        expiring_price:  pctToNum(l.expiringPricing),
        lead_price:      pctToNum(l.leadPricing),
      }));

      noteSaved(await api.saveNpPricing(contractId, { inputs, layer_inputs, outputs, layer_margins }, requestOptions()));

      // 2. JSONB terms for full UI state (lead setup, all layer fields)
      // NOTE: offerStatus and offerApprover are NOT saved to JSONB — they come from the DB
      // (contract_offer.status / next_approver) to prevent stale status leaking across cycles.

      // Collect live structure data from QuoteStructureSection refs before saving
      let liveQuoteStructures = quoteStructures;
      if (isQuote && structRefsMap.current) {
        const live = [];
        Object.keys(structRefsMap.current).sort().forEach(idx => {
          const ref = structRefsMap.current[idx];
          if (ref?.current) {
            try { live.push(ref.current()); } catch {}
          }
        });
        if (live.length > 0) liveQuoteStructures = live;
      }
      const normalizedClientStructures = isQuote
        ? normalizeQuoteStructures(clientStructures, { curve: quoteCurve })
        : clientStructures;

      // 2a. Quote-mode scaffolding — relational where the schema has
      //     columns (expiring layers), JSONB for everything else.
      //     Field mapping mirrors NpExpiringStructure.localLayerToServer
      //     so the same quote_np_expiring_layers row shape works.
      if (isQuote) {
        const peril = (l) => (l.risk && l.cat ? 'BOTH' : l.risk ? 'RISK' : l.cat ? 'CAT' : 'BOTH');
        const expPayload = {
          layers: expLayers.map((l, i) => ({
            layer_number:          i + 1,
            attachment:            toN(l.attachment),
            layer_limit:           toN(l.limit),
            aggregate_limit:       0,
            egnpi:                 toN(l.egnpi),
            earned_premium:        expLayerEarnedPremium(l),
            rate:                  toN(l.rate),
            rol:                   toN(l.rol),
            // Preserve the 'UNLIMITED' sentinel verbatim; toN() would discard it
            // (server reinstatInt() keeps it in JSONB with the numeric column null).
            num_reinstatements:    String(l.reinstatements ?? '').trim().toUpperCase() === 'UNLIMITED'
                                     ? 'UNLIMITED' : toN(l.reinstatements),
            reinstatement_pct:     toN(l.pctReinst),
            annual_agg_deductible: null,
            peril_scope:           peril(l),
            mdp:                   toN(l.mdp),
            mdp_pct:               0,
          })),
          terms: { brokerage_pct: toN(npDetail.brokeragePct), no_claims_bonus_pct: 0, profit_commission_pct: 0 },
          // Covered props are owned by NpStructure; NpFinalPricing has no UI for them and must not overwrite.
        };
        noteSaved(await api.saveNpExpiring(contractId, expPayload, requestOptions()));
        // COB selection — keep the relational class_of_business
        // junction in sync with selectedCobs so other screens see it.
        try {
          await api.saveContractCobs(contractId, { class_ids: selectedCobs.map((c) => c.id) }, requestOptions());
        } catch (cobErr) {
          // Non-fatal: COB junction sync is best-effort here; the
          // canonical store is npTreatyDetail.classIds set on the
          // Treaty Detail step. Log but don't block the save.
          logger.warn('[NP Final Pricing save] cob sync failed', cobErr);
        }
      }

      // Probability fields for expiring layers — kept in JSONB until
      // the relational table grows columns for them.
      const expProbabilities = isQuote
        ? expLayers.map((l) => ({ pAttach: l.pAttach || '', pExhaust: l.pExhaust || '' }))
        : undefined;

      noteSaved(await api.saveNonPropTreaty(contractId, {
        terms: {
          np_final_pricing: {
            layers: layers.map(l => ({ ...l })),
            treatyMetrics,
            leadSetup,
            offerComment,          // comment is UI-only, ok to cache
            layerWrittenLines,
            signedLinePcts,
            approvedStructures: isQuote ? approvedStructures : undefined,
            quotePricing: isQuote ? quotePricing : undefined,
            quoteStructures: isQuote ? (normalizedClientStructures.length ? normalizedClientStructures : liveQuoteStructures) : undefined,
            // Final Quote scaffolding — single JSONB key so loads
            // can treat it as one object and we don't pollute the
            // top-level np_final_pricing namespace.
            fqScaffolding: isQuote ? {
              clientStructures: normalizedClientStructures,
              approvedStructures,
              quoteCobUwLimits,
              cobToggles,
              cobManual,
              expProbabilities,
            } : undefined,
          },
        },
      }, requestOptions()));
      saveSaved(Date.now());
      return true;
    } catch (e) {
      logger.error('[NP Final Pricing save]', e);
      // Not the assignee: the lock raced this write (or failed open). Flip the
      // editor read-only and surface it once via the save indicator — never
      // retry/overwrite an authz verdict. "Allocate to me" is the path back.
      if (isReadOnlyError(e)) {
        onServerReadOnly?.();
        saveFailed(Date.now(), 'Read-only — this treaty is assigned to someone else. Claim it (if unassigned) or have it allocated to you to edit.');
        return true; // no-op for nav: don't block, don't retry
      }
      if (lockOverride !== '*') {
        const stale = await handleStaleWrite(e, {
          entityType: isQuote ? 'quote pricing' : 'pricing',
          onRefresh: () => window.location.reload(),
          onOverwrite: () => save({ ifUnmodifiedSince: '*' }),
        });
        if (stale.handled) return stale.action === 'overwrite' ? !!stale.result : false;
      }
      saveFailed(Date.now(), formatPricingDriftMessage(e) || e?.message || 'Save failed');
      return false;
    }
  }, [contractId, readOnly, onServerReadOnly, quoteMode, lastUpdatedAt, layers, quoteStructures, isQuote, structRefsMap, expLayers, treatyMetrics, leadSetup, offerComment, layerWrittenLines, signedLinePcts, approvedStructures, quotePricing, clientStructures, quoteCurve, quoteCobUwLimits, cobToggles, cobManual, npDetail.brokeragePct, selectedCobs, saveStart, saveSaved, saveFailed, setLastUpdatedAt]);

  // ── Workflow ──────────────────────────────────────────────────────────────

  const doSubmitForApproval = useCallback(async () => {
    if (!offerApprover) { showToast('Please select who to send the offer to.'); return; }
    const approvedStructureIndices = approvedStructures
      .map((selected, index) => (selected ? index : null))
      .filter((index) => index != null);
    if (isQuote && approvedStructureIndices.length === 0) {
      showToast('Select at least one structure for Chief Underwriter approval.');
      return;
    }
    // Compute aggregate written_line_pct = average of non-zero lead share entries
    const shareVals = Object.entries(layerWrittenLines)
      .filter(([k]) => k.includes('_'))   // sIdx_li format = quote mode
      .map(([, v]) => parseFloat(String(v).replace(/%/g, '')) || 0)
      .filter(v => v > 0);
    const aggWrittenPct = shareVals.length ? (shareVals.reduce((a, b) => a + b, 0) / shareVals.length) : null;
    const hasAnyLine = layers.some((_, i) => parseFloat(String(layerWrittenLines[i] || '').replace(/%/g, '').trim()) > 0);
    if (!isQuote && !hasAnyLine) { showToast('Please enter a written line % for at least one layer before submitting.'); return; }
    const ok = await save();
    if (!ok) { showToast('Cannot submit: the latest pricing failed to save. Retry save first.'); return; }
    // Quote mode: each approved structure carries its own quote type + the single
    // line that applies (lead for LEAD, follow for INDICATIVE). The submission's
    // written line is the mean of those structure lines — NOT the per-layer
    // layerWrittenLines average (that path stays for the non-quote Offer flow).
    const linePctNum = (v) => { const n = toN(v); return Number.isFinite(n) && n > 0 ? n : null; };
    const approvedStructureDetails = approvedStructureIndices.map((index) => {
      const s = clientStructures[index] || {};
      return {
        id: s.id ?? null,
        structure_no: index + 1,
        quote_type: s.quoteType === 'INDICATIVE' ? 'INDICATIVE' : 'LEAD',
        lead_line_pct: linePctNum(s.leadLinePct),
        follow_line_pct: linePctNum(s.followLinePct),
      };
    });
    const quoteLineVals = approvedStructureDetails
      .map((d) => (d.quote_type === 'INDICATIVE' ? d.follow_line_pct : d.lead_line_pct))
      .filter((v) => Number.isFinite(v) && v > 0);
    const quoteWrittenPct = quoteLineVals.length ? quoteLineVals.reduce((a, b) => a + b, 0) / quoteLineVals.length : null;
    try {
      await api.submitOfferForApproval(contractId, {
        line_pct: JSON.stringify(layerWrittenLines), peer1_user_id: offerApprover, comment: offerComment, _actor: actorName,
        written_line_pct: isQuote ? quoteWrittenPct : aggWrittenPct,
        selected_structure_index: isQuote ? approvedStructureIndices[0] : undefined,
        selected_structure_id: isQuote ? clientStructures[approvedStructureIndices[0]]?.id : undefined,
        selected_structure_indices: isQuote ? approvedStructureIndices : undefined,
        selected_structure_ids: isQuote ? approvedStructureIndices.map((index) => clientStructures[index]?.id).filter(Boolean) : undefined,
        approved_structures: isQuote ? JSON.stringify(approvedStructureDetails) : undefined,
      }, quoteMode ? { quote: true } : undefined);
      setOfferStatus('AWAITING_APPROVAL');
      api.getApprovalTrail(contractId, quoteMode ? { quote: true } : undefined).then(setApprovalTrail).catch(() => {});
    } catch(e) { showToast('Submission failed: ' + (e?.message || 'Server error')); }
  }, [offerApprover, approvedStructures, isQuote, layerWrittenLines, layers, save, showToast, contractId, offerComment, actorName, clientStructures, quoteMode, setOfferStatus, setApprovalTrail]);

  const doMarkApproved = useCallback(async () => {
    const ok = await save();
    if (!ok) { showToast('Cannot approve: the latest pricing failed to save. Retry save first.'); return; }
    try {
      await api.markOfferApproved(contractId, { _actor: actorName, comment: returnReason || offerComment, line_pct: JSON.stringify(layerWrittenLines) }, quoteMode ? { quote: true } : undefined);
      setOfferStatus('AWAITING_SIGNED_LINE');
      api.getApprovalTrail(contractId, quoteMode ? { quote: true } : undefined).then(setApprovalTrail).catch(() => {});
    } catch(e) { showToast('Approval failed: ' + (e?.message || 'Server error')); }
  }, [save, showToast, contractId, actorName, returnReason, offerComment, layerWrittenLines, quoteMode, setOfferStatus, setApprovalTrail]);

  const doMarkSigned = useCallback(async () => {
    try {
      // Hard guard: don't let a caller mark SIGNED when every
      // signed_line_pct is 0/missing. The inline click-site already
      // checks this but we re-check here so any future code path
      // that invokes doMarkSigned can't bypass the validation.
      const hasAnySignedCheck = Object.values(signedLinePcts || {}).some(v => {
        const n = parseFloat(String(v || '').replace(/%/g, '').trim());
        return Number.isFinite(n) && n > 0;
      });
      if (!hasAnySignedCheck) {
        showToast('Cannot mark signed: enter at least one non-zero signed line %.');
        return;
      }
      // Save signed line pcts to JSONB first so they persist on reload
      const ok = await save();
      if (!ok) { showToast('Cannot mark signed: the latest pricing failed to save. Retry save first.'); return; }
      await api.markOfferSigned(contractId, {
        signed_line_pct: JSON.stringify(signedLinePcts),
        _actor: actorName,
      }, quoteMode ? { quote: true } : undefined);
      setOfferStatus('SIGNED');
      api.getApprovalTrail(contractId, quoteMode ? { quote: true } : undefined).then(setApprovalTrail).catch(() => {});
    } catch(e) { showToast('Failed to mark signed: ' + (e?.message || 'Server error')); }
  }, [signedLinePcts, save, contractId, actorName, quoteMode, showToast, setOfferStatus, setApprovalTrail]);

  const doMarkNTU = useCallback(async () => {
    try {
      await api.markOfferNTU(contractId, { reason: returnReason || offerComment || '', _actor: actorName }, quoteMode ? { quote: true } : undefined);
      setOfferStatus('NTU');
      api.getApprovalTrail(contractId, quoteMode ? { quote: true } : undefined).then(setApprovalTrail).catch(() => {});
    } catch(e) { showToast('Failed to mark NTU: ' + (e?.message || 'Server error')); }
  }, [contractId, returnReason, offerComment, actorName, quoteMode, showToast, setOfferStatus, setApprovalTrail]);

  const doReturnToUW = useCallback(async () => {
    if (!returnReason.trim()) { showToast('Please enter a reason for returning to the underwriter.'); return; }
    try {
      await api.returnToUnderwriter(contractId, { reason: returnReason, _actor: actorName }, quoteMode ? { quote: true } : undefined);
      setReturnReason('');
      setOfferStatus('DRAFT');
      api.getApprovalTrail(contractId, quoteMode ? { quote: true } : undefined).then(setApprovalTrail).catch(() => {});
    } catch(e) { showToast('Failed to return: ' + (e?.message || 'Server error')); }
  }, [returnReason, showToast, contractId, actorName, quoteMode, setReturnReason, setOfferStatus, setApprovalTrail]);

  const doDecline = useCallback(async () => {
    if (!window.confirm('Decline this treaty? This cannot be undone.')) return;
    const reason = returnReason.trim() || offerComment.trim() || 'Declined by Chief Underwriter';
    try {
      await api.declineContract(contractId, reason, { ...(quoteMode ? { quote: true } : {}), body: { reason, _actor: actorName } });
      setOfferStatus('DECLINED');
      api.getApprovalTrail(contractId, quoteMode ? { quote: true } : undefined).then(setApprovalTrail).catch(() => {});
    } catch(e) { showToast('Failed to decline: ' + (e?.message || 'Server error')); }
  }, [returnReason, offerComment, contractId, quoteMode, actorName, showToast, setOfferStatus, setApprovalTrail]);

  return {
    runQuoteCalcEngine,
    runQuoteCalcStructure,
    runCalcEngine,
    save,
    doSubmitForApproval,
    doMarkApproved,
    doMarkSigned,
    doMarkNTU,
    doReturnToUW,
    doDecline,
  };
}

export default useNpPricingActions;
