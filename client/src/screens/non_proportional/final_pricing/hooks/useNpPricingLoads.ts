// hooks/useNpPricingLoads.ts — Phase 4.1 (docs/frontend-hardening.md).
//
// The five server loads NpFinalPricing ran as hand-rolled effects, moved
// VERBATIM from the screen (bodies, hydration order, dependency arrays,
// cancelled flags). Called exclusively by useNpPricingState, in the same
// position the effects originally occupied, so the mount-order of the
// effects is unchanged:
//   1. class-of-business master list (+ selectedCobs seed)
//   2. quote-mode scaffolding (expiring layers, JSONB fqScaffolding, COBs)
//   3. main load (treaty + pricing + reinsurers → merged layers et al.)
//   4. treaty-metrics auto-calc from expiring + current structure
//   5. portfolio treaties for quote-mode analysis comparison
//
// See useNpPricingState's header for why these stay hand-rolled rather
// than moving onto useResource in this phase.

import { useEffect } from 'react';
import { api } from '../../../../api';
import { getRole } from '../../../../utils/auth';
import { toN, pct, emptyLayerPricing, deriveCombinedUwPrice, deriveComponentTotal } from '../formatters.js';
import { fqBuildPricingCurve } from '../fqHelpers.js';
import {
  expLayerEarnedPremium,
  syncExpLayerPricing,
  fmtAutoAmount,
  normalizeQuoteStructures,
} from '../fqQuoteMath.js';
import type { Setter, LayersSlice, FqSlice, WorkflowSlice, ModalsSlice, UiSlice, RefDataSlice, LooseRecord } from '../state/pricingReducer';
import type { NpDetailLike } from './useNpPricingState';

type Set<T> = (next: Setter<T>) => void;

/** The slice setters the loads hydrate through (from useNpPricingState). */
export interface NpPricingLoadSetters {
  setLayers: Set<LayersSlice['layers']>;
  setLeadSetup: Set<LayersSlice['leadSetup']>;
  setLocalStructureLayers: Set<LayersSlice['localStructureLayers']>;
  setTreatyMetrics: Set<LayersSlice['treatyMetrics']>;
  setCobUwLimits: Set<LayersSlice['cobUwLimits']>;
  setExpiringEgnpi: Set<LayersSlice['expiringEgnpi']>;
  setExpLayers: Set<FqSlice['expLayers']>;
  setNumExpLayers: Set<FqSlice['numExpLayers']>;
  setClientStructures: Set<FqSlice['clientStructures']>;
  setQuoteStructures: Set<FqSlice['quoteStructures']>;
  setApprovedStructures: Set<FqSlice['approvedStructures']>;
  setQuotePricing: Set<FqSlice['quotePricing']>;
  setQuoteCobUwLimits: Set<FqSlice['quoteCobUwLimits']>;
  setCobToggles: Set<FqSlice['cobToggles']>;
  setCobManual: Set<FqSlice['cobManual']>;
  setSelectedCobs: Set<FqSlice['selectedCobs']>;
  setCobList: Set<FqSlice['cobList']>;
  setOfferStatus: Set<WorkflowSlice['offerStatus']>;
  setOfferApprover: Set<WorkflowSlice['offerApprover']>;
  setOfferComment: Set<WorkflowSlice['offerComment']>;
  setLayerWrittenLines: Set<WorkflowSlice['layerWrittenLines']>;
  setSignedLinePcts: Set<WorkflowSlice['signedLinePcts']>;
  setApprovalTrail: Set<WorkflowSlice['approvalTrail']>;
  setEligibleApprovers: Set<WorkflowSlice['eligibleApprovers']>;
  setShowOfferModal: Set<ModalsSlice['showOfferModal']>;
  setLoading: Set<UiSlice['loading']>;
  setReinsurers: Set<RefDataSlice['reinsurers']>;
  setPortfolioTreaties: Set<RefDataSlice['portfolioTreaties']>;
  setPortfolioExportRows: Set<RefDataSlice['portfolioExportRows']>;
  setCedantProgLimit: Set<RefDataSlice['cedantProgLimit']>;
  setContractAgg100: Set<RefDataSlice['contractAgg100']>;
  setOtherCountryAgg: Set<RefDataSlice['otherCountryAgg']>;
  setLastUpdatedAt: (lastUpdatedAt: string | null) => void;
}

export interface UseNpPricingLoadsParams {
  contractId: string;
  quoteMode: boolean;
  isQuote: boolean;
  npDetail: NpDetailLike;
  countryId: string | null;
  localStructureLayers: LooseRecord[];
  setters: NpPricingLoadSetters;
}

export function useNpPricingLoads({
  contractId,
  quoteMode,
  isQuote,
  npDetail,
  countryId,
  localStructureLayers,
  setters,
}: UseNpPricingLoadsParams): void {
  const {
    setLayers, setLeadSetup, setLocalStructureLayers, setTreatyMetrics, setCobUwLimits,
    setExpiringEgnpi, setExpLayers, setNumExpLayers, setClientStructures, setQuoteStructures,
    setApprovedStructures, setQuotePricing, setQuoteCobUwLimits, setCobToggles, setCobManual,
    setSelectedCobs, setCobList, setOfferStatus, setOfferApprover, setOfferComment,
    setLayerWrittenLines, setSignedLinePcts, setApprovalTrail, setEligibleApprovers,
    setShowOfferModal, setLoading, setReinsurers, setPortfolioTreaties, setPortfolioExportRows,
    setCedantProgLimit, setContractAgg100, setOtherCountryAgg, setLastUpdatedAt,
  } = setters;

  // Load class-of-business master list (one-shot) and seed selectedCobs
  // from npDetail.classIds when the user lands on this screen with COBs
  // already picked at the Treaty Detail step.
  useEffect(() => {
    let cancelled = false;
    api.listClassOfBusiness().then((rows: any) => {
      if (cancelled) return;
      const list = Array.isArray(rows) ? rows : [];
      setCobList(list);
      const seedIds = Array.isArray(npDetail.classIds) ? npDetail.classIds : [];
      const map = new Map(list.map((c: any) => [c.id, c.name]));
      setSelectedCobs(prev => (
        seedIds.length && prev.length === 0
          ? seedIds.map((id: any) => ({ id, name: map.get(id) || id, uwLimit: '' }))
          : prev
      ));
    }).catch(() => {});
    return () => { cancelled = true; };
    // selectedCobs intentionally not a dep — we only seed once on mount.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [npDetail.classIds]);

  // ── Load quote-mode scaffolding from server when landing on the
  //    Final Quote page. Three sources:
  //      1) /np/expiring  → expLayers + numExpLayers
  //      2) /non-prop      → JSONB scaffolding (clientStructures,
  //                          quoteCobUwLimits, cobToggles, cobManual)
  //      3) /cobs          → selectedCobs (already seeded above from
  //                          npDetail.classIds; this refresh covers
  //                          the case where the server has a more
  //                          recent selection)
  useEffect(() => {
    if (!isQuote || !contractId) return undefined;
    let cancelled = false;
    const qm = { quote: true };
    Promise.all([
      api.getNpExpiring(contractId, qm).catch(() => null),
      api.getNonPropTreaty(contractId, qm).catch(() => null),
      api.getContractCobs(contractId, qm).catch(() => []),
    ]).then(([expDataRaw, treatyDataRaw, quoteCobsRaw]) => {
      if (cancelled) return;
      const expData = expDataRaw as any;
      const treatyData = treatyDataRaw as any;
      const quoteCobs = quoteCobsRaw as any;

      // 1) Expiring layers from the relational endpoint
      let hydratedExpLayers: any[] | null = null;
      const serverExpLayers = Array.isArray(expData?.layers) ? expData.layers : [];
      if (serverExpLayers.length > 0) {
        const hydrated = serverExpLayers.map((sl: any, i: number) => {
          const rawLayer = {
            id: sl.layer_number || i + 1,
            limit:          sl.layer_limit          != null ? String(sl.layer_limit)          : '',
            attachment:     sl.attachment           != null ? String(sl.attachment)           : '',
            egnpi:          sl.egnpi                != null ? String(sl.egnpi)                : '',
            rate:           sl.rate                 != null ? String(sl.rate)                 : '',
            earnedPremium:  sl.earned_premium       != null ? String(sl.earned_premium)       : '',
            rol:            sl.rol                  != null ? String(sl.rol)                  : '',
            mdp:            sl.mdp                  != null ? String(sl.mdp)                  : '',
            reinstatements: sl.num_reinstatements   != null ? String(sl.num_reinstatements)   : '',
            pctReinst:      sl.reinstatement_pct    != null ? String(sl.reinstatement_pct)    : '',
            risk:  sl.peril_scope === 'RISK' || sl.peril_scope === 'BOTH',
            cat:   sl.peril_scope === 'CAT'  || sl.peril_scope === 'BOTH',
            pAttach: '', pExhaust: '',
          };
          if (rawLayer.rate || rawLayer.rol) {
            return syncExpLayerPricing(rawLayer, rawLayer.rate ? 'rate' : 'rol');
          }
          return { ...rawLayer, earnedPremium: rawLayer.earnedPremium || fmtAutoAmount(expLayerEarnedPremium(rawLayer)) };
        });
        hydratedExpLayers = hydrated;
        setExpLayers(hydrated);
        setNumExpLayers(hydrated.length);
      }

      // 2) JSONB scaffolding from the treaty endpoint
      const savedPricing = treatyData?.terms?.np_final_pricing || {};
      const scaffold = savedPricing?.fqScaffolding;
      const curveForHydration = fqBuildPricingCurve({
        expLayers: hydratedExpLayers || [],
        structures: [],
        npDetail,
      } as any);
      if (scaffold && typeof scaffold === 'object') {
        if (Array.isArray(scaffold.clientStructures))   setClientStructures(normalizeQuoteStructures(scaffold.clientStructures, { curve: curveForHydration }));
        if (Array.isArray(scaffold.approvedStructures)) setApprovedStructures(scaffold.approvedStructures.map(Boolean));
        else if (Array.isArray(savedPricing.approvedStructures)) setApprovedStructures(savedPricing.approvedStructures.map(Boolean));
        if (scaffold.quoteCobUwLimits && typeof scaffold.quoteCobUwLimits === 'object') setQuoteCobUwLimits(scaffold.quoteCobUwLimits);
        if (scaffold.cobToggles       && typeof scaffold.cobToggles       === 'object') setCobToggles(scaffold.cobToggles);
        if (scaffold.cobManual        && typeof scaffold.cobManual        === 'object') setCobManual(scaffold.cobManual);
        // Probability fields for expiring layers — stored separately
        // because the relational table has no columns for them yet.
        const expProb = scaffold.expProbabilities;
        if (Array.isArray(expProb) && expProb.length > 0) {
          setExpLayers((prev) => prev.map((l: any, i: number) => ({
            ...l,
            pAttach:  expProb[i]?.pAttach  != null ? String(expProb[i].pAttach)  : (l.pAttach  || ''),
            pExhaust: expProb[i]?.pExhaust != null ? String(expProb[i].pExhaust) : (l.pExhaust || ''),
          })));
        }
      } else if (Array.isArray(savedPricing.quoteStructures) && savedPricing.quoteStructures.length > 0) {
        setClientStructures(normalizeQuoteStructures(savedPricing.quoteStructures, { curve: curveForHydration }));
      }

      const serverCobs = Array.isArray(quoteCobs) ? quoteCobs : [];
      if (serverCobs.length > 0) {
        setSelectedCobs(serverCobs.map((c: any, i: number) => ({
          id: c.id || c.class_of_business_id || c.cob_id || `quote-cob-${i}`,
          name: c.name || c.cob_name || c.class_of_business || c.label || c.code || `Class ${i + 1}`,
          uwLimit: '',
        })));
      }
    }).catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isQuote, contractId, npDetail]);


  // Load data
  useEffect(() => {
    if (!contractId) return;
    let cancelled = false;
    setLoading(true);
    Promise.all([
      api.getNonPropTreaty(contractId, quoteMode ? { quote: true } : undefined).catch(() => ({})),
      api.getNpPricing(contractId, quoteMode ? { quote: true } : undefined).catch(() => ({})),
      api.listReinsurers().catch(() => []),
    ]).then(([npDataRaw, pricingRaw, reinsRaw]) => {
      const npData = npDataRaw as any;
      const pricing = pricingRaw as any;
      const reins = reinsRaw as any;
      setReinsurers(Array.isArray(reins) ? reins : []);
      setLastUpdatedAt(npData?.updated_at || null);
      const npTerms = npData?.terms || {};
      const savedPricing = npTerms.np_final_pricing || {};
      const struct = npTerms.np_structure || npTerms.structure || npData?.structure || {};
      const structLayers = struct.layers || (npData?.layers || []).map((rl: any, i: number) => ({
        layer: `L${i + 1}`, limit: rl.layer_limit || '', deductible: rl.attachment || '',
        egnpi: rl.egnpi || '', earnedPremium: rl.earned_premium || '', rate: rl.rate || '',
        noReinst: rl.num_reinstatements || '',
        reinstPct: String(rl.reinstatement_pct ?? ''),
        risk: rl.peril_scope === 'RISK' || rl.peril_scope === 'BOTH',
        cat: rl.peril_scope === 'CAT' || rl.peril_scope === 'BOTH',
        classOfBusinessIds: Array.isArray(rl.class_of_business_ids) ? rl.class_of_business_ids : [],
      }));
      const pricingLayers = pricing?.layer_inputs || pricing?.layers || [];

      const savedLayers = savedPricing.layers || [];
      const numLayers = savedLayers.length || structLayers.length || parseInt(npDetail.numberOfLayers || npDetail.number_of_layers || '0', 10) || 0;
      const merged: any[] = [];
      for (let i = 0; i < numLayers; i++) {
        const sl = structLayers[i] || {};
        const pl = pricingLayers[i] || {};
        const sv = savedLayers[i] || {};
        const ml: any = {
          ...emptyLayerPricing(i),
          layer: sl.layer || `L${i + 1}`,
          limit: sl.limit || pl.limit || '',
          deductible: sl.deductible || pl.deductible || '',
          risk: sl.riskCover ?? sl.risk ?? pl.risk ?? false,
          cat: sl.catCover ?? sl.cat ?? pl.cat ?? false,
          egnpi: sl.egnpi || '',
          earnedPremium: sl.earnedPremium || '',
          rate: sl.rate || '',
          noReinst: sl.noReinst || sl.reinstatements || '',
          reinstPct: sl.reinstPct || sl.reinstatementPct || '',
          classOfBusinessIds: sl.classOfBusinessIds || [],
          ...pl,
          ...sv,
        };

        // Re-derive component totals + combined UW price from the loaded
        // actuarial fields so a price saved under the old Rate-%-of-EPI scale
        // doesn't persist. Only overwrite a UW price when it still tracks the
        // saved total (i.e. the user hasn't manually diverged it) — the same
        // guard runCalcEngine applies. Uses pct() to match the engine's format.
        if (ml.risk) {
          const riskTotal = deriveComponentTotal(
            ml.riskPureBurn, ml.riskPareto, ml.riskExposure,
            ml.riskWeightBurn || '50', ml.riskWeightPareto || '0',
            ml.riskWeightExposure || '50', ml.riskLoading || '15',
          );
          if (riskTotal > 0) {
            const uwTracks = !ml.riskUwPrice || ml.riskUwPrice === '0.00%' || toN(ml.riskUwPrice) === toN(ml.riskTotalPrice);
            ml.riskTotalPrice = pct(riskTotal);
            if (uwTracks) ml.riskUwPrice = pct(riskTotal);
          }
        }
        if (ml.cat) {
          const catTotal = deriveComponentTotal(
            ml.catPureBurn, ml.catPareto, ml.catExposure,
            ml.catWeightBurn || '50', ml.catWeightPareto || '0',
            ml.catWeightExposure || '50', ml.catLoading || '15',
          );
          if (catTotal > 0) {
            const uwTracks = !ml.catUwPrice || ml.catUwPrice === '0.00%' || toN(ml.catUwPrice) === toN(ml.catTotalPrice);
            ml.catTotalPrice = pct(catTotal);
            if (uwTracks) ml.catUwPrice = pct(catTotal);
          }
        }
        const combined = deriveCombinedUwPrice(ml);
        if (combined > 0) {
          const uwTracks = !ml.uwPrice || ml.uwPrice === '0.00%' || toN(ml.uwPrice) === toN(ml.totalPrice);
          ml.totalPrice = pct(combined);
          if (uwTracks) ml.uwPrice = pct(combined);
        }
        merged.push(ml);
      }
      setLayers(merged);

      // Always build serverStructLayers from relational layer data (has layer_limit, earned_premium, rol).
      // JSONB structLayers is only a fallback when no relational rows exist (e.g. quote mode).
      const relLayers = Array.isArray(npData?.layers) ? npData.layers : [];
      const serverStructLayers = relLayers.length
        ? relLayers.map((rl: any, i: number) => {
            const lim = parseFloat(rl.layer_limit) || 0;
            const ep  = parseFloat(rl.earned_premium) || 0;
            const rolStored = parseFloat(rl.rol) || 0;
            // Use stored rol if present, else derive from earned_premium / layer_limit
            const rolPct = rolStored > 0 ? rolStored : (lim > 0 && ep > 0 ? (ep / lim) * 100 : 0);
            return {
              layer: rl.layer_number || (i + 1),
              limit: lim || '',
              deductible: parseFloat(rl.attachment) || '',
              egnpi: rl.egnpi || '',
              rate: rl.rate || '',
              earnedPremium: ep || '',
              rol: rolPct ? String(rolPct.toFixed(4)) : '',
              riskCover: rl.peril_scope === 'RISK' || rl.peril_scope === 'BOTH',
              catCover:  rl.peril_scope === 'CAT'  || rl.peril_scope === 'BOTH',
              classOfBusinessIds: Array.isArray(rl.class_of_business_ids) ? rl.class_of_business_ids : [],
            };
          })
        : structLayers.map((sl: any) => ({
            ...sl,
            riskCover: sl.riskCover ?? sl.risk ?? false,
            catCover:  sl.catCover  ?? sl.cat  ?? false,
          }));
      setLocalStructureLayers(serverStructLayers);

      // Build COB underwriting limits — combine relational UW limits with JSONB cobRows for names + layer flags
      const rawUwLimits = Array.isArray(npData?.cob_underwriting_limits) ? npData.cob_underwriting_limits : [];
      const jsonbCobRows = struct.cobRows || struct.cob_rows || [];
      if (rawUwLimits.length) {
        const cobRowsMap = new Map(jsonbCobRows.map((r: any) => [String(r.cobId || r.cob_id), r]));
        setCobUwLimits(rawUwLimits.map((r: any) => {
          const row: any = cobRowsMap.get(String(r.cob_id)) || {};
          return {
            cob_id: r.cob_id,
            cob_name: row.name || r.cob_name || r.cob_id,
            limit_amount: r.limit_amount,
            layers: row.layers || [],   // array of booleans per layer
          };
        }));
      } else if (jsonbCobRows.length) {
        setCobUwLimits(jsonbCobRows.map((r: any) => ({
          cob_id: r.cobId || r.cob_id,
          cob_name: r.name || '',
          limit_amount: r.underwritingLimit || r.limit_amount || '',
          layers: r.layers || [],
        })));
      }
      const ls = savedPricing.leadSetup || pricing?.leadSetup || [];
      setLeadSetup(merged.map((l, i) => ({
        leader: ls[i]?.leader || '',
        expiringReinsurer: ls[i]?.expiringReinsurer || '',
        rol: ls[i]?.rol || '',
        leadShare: ls[i]?.leadShare || '',
      })));

      // ── Offer / approval status — always drive from live DB, never from JSONB ──
      // contract_offer.status (offer_status) is authoritative; uw_status is secondary fallback.
      // JSONB savedPricing.offerStatus is only used if DB has NO offer row at all (very old contracts).
      const UW_STATUS_MAP: Record<string, string> = {
        OFFERED: 'DRAFT', PENDING: 'DRAFT', RETURNED: 'DRAFT', APPROVED: 'AWAITING_SIGNED_LINE',
      };
      const dbOfferStatus = npData?.offer_status || null;
      const dbUwStatus    = npData?.uw_status    || null;
      const dbStatus = dbOfferStatus || (dbUwStatus ? (UW_STATUS_MAP[dbUwStatus] || dbUwStatus) : null);
      setOfferStatus(dbStatus || savedPricing.offerStatus || '');
      // Approver: prefer DB offer row, fall back to JSONB
      setOfferApprover(npData?.offer_approver || savedPricing.offerApprover || '');
      if (savedPricing.offerComment)   setOfferComment(savedPricing.offerComment);
      if (savedPricing.layerWrittenLines) setLayerWrittenLines(savedPricing.layerWrittenLines);
      if (savedPricing.signedLinePcts) setSignedLinePcts(savedPricing.signedLinePcts);
      if (savedPricing.treatyMetrics) setTreatyMetrics(savedPricing.treatyMetrics);

      // ── Auto-open offer modal based on role + resolved status (mirrors PropPricing) ──
      const resolvedStatus = dbStatus || savedPricing.offerStatus || '';
      const role = getRole(); // roleCode e.g. CE, CU, TD, TM, TUW
      if ((role === 'CU' || role === 'CE') && resolvedStatus === 'AWAITING_APPROVAL') setShowOfferModal(true);
      if (role !== 'CU' && role !== 'CE' && (resolvedStatus === 'AWAITING_SIGNED_LINE' || resolvedStatus === 'APPROVED')) setShowOfferModal(true);

      // Load approval trail — pass quoteMode so it hits the correct endpoint
      if (contractId) {
        api.getApprovalTrail(contractId, quoteMode ? { quote: true } : undefined).then((trail: any) => { setApprovalTrail(trail); }).catch(() => {});
        api.getEligibleApprovers(contractId, {}, quoteMode ? { quote: true } : undefined).then((rows: any) => { setEligibleApprovers(Array.isArray(rows) ? rows : []); }).catch(() => {});
      }

      // Cedant programme limits + country aggregates
      if (contractId && !isQuote) {
        api.getCedantProgrammeLimits(contractId).then((data: any) => {
          setCedantProgLimit(parseFloat(data?.totalLimit) || 0);
        }).catch(() => {});

        // Country aggregates: same as proportional
        // contractAgg100 = sum of this contract's CRESTA zones
        // otherCountryAgg = other contracts' agg for same country (excluding this one)
        // This branch only runs in treaty mode (gated above on !isQuote),
        // so no quote-mode flag is needed on getCrestaData here.
        api.getCrestaData(contractId).then((rows: any) => {
          const arr = Array.isArray(rows) ? rows : (Array.isArray(rows?.rows) ? rows.rows : []);
          const total = arr.reduce((s: number, r: any) =>
            s + (parseFloat(r.eq_agg||0)||0) + (parseFloat(r.ws_agg||0)||0) +
                (parseFloat(r.flood_agg||0)||0) + (parseFloat(r.srcc_agg||0)||0) + (parseFloat(r.others_agg||0)||0), 0);
          setContractAgg100(total);
        }).catch(() => {});
        if (countryId) {
          api.getCountryAggregates(countryId, { excludeContractId: contractId }).then((cd: any) => {
            setOtherCountryAgg(parseFloat(cd?.total_country_agg ?? cd?.total_agg ?? 0) || 0);
          }).catch(() => {});
        }
      }

      // Quote mode hydration
      if (isQuote) {
        // Match prototype getQuoteStructuresFromState() — try structures[], fallback to single structure from layers
        // Priority: JSONB savedPricing.quoteStructures (our live-edit save) > struct.structures > structLayers > relational layers
        let qs = (savedPricing.quoteStructures?.length ? savedPricing.quoteStructures : null)
               || (struct.structures || []);
        if (!qs.length && structLayers.length) {
          qs = [{ layers: structLayers, cobRows: struct.cobRows || [] }];
        }
        // Also try npData.layers (relational) if still empty — map all columns
        if (!qs.length && Array.isArray(npData?.layers) && npData.layers.length) {
          qs = [{ layers: npData.layers.map((rl: any, i: number) => ({
            layer: i + 1,
            limit:          rl.layer_limit        || '',
            deductible:     rl.attachment          || '',
            annualAggLimit: rl.aggregate_limit     || '',
            egnpi:          rl.egnpi               || '',
            earnedPremium:  rl.earned_premium      || '',
            reinstatements:    rl.num_reinstatements != null ? String(rl.num_reinstatements) : '',
            reinstatementPct:  rl.reinstatement_pct != null ? String(rl.reinstatement_pct)  : '',
            aad:               !!(rl.annual_agg_deductible),
            aadAmount:         rl.annual_agg_deductible || '',
            riskCover: rl.peril_scope === 'RISK' || rl.peril_scope === 'BOTH',
            catCover:  rl.peril_scope === 'CAT'  || rl.peril_scope === 'BOTH',
          })), cobRows: [] }];
        }
        setQuoteStructures(qs);
        const savedApproved = Array.isArray(savedPricing.fqScaffolding?.approvedStructures)
          ? savedPricing.fqScaffolding.approvedStructures
          : (savedPricing.approvedStructures || []);
        if (qs.length) {
          setApprovedStructures(qs.map((_: unknown, i: number) => !!savedApproved[i]));
        } else if (Array.isArray(savedApproved)) {
          setApprovedStructures(savedApproved.map(Boolean));
        }
        setQuotePricing(savedPricing.quotePricing || {});
      }
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contractId, quoteMode, npDetail, isQuote, countryId]);

  // ── Auto-calculate treaty metrics from expiring + current structure ──
  useEffect(() => {
    if (!contractId) return;
    let cancelled = false;
    const qm = quoteMode ? { quote: true } : undefined;
    api.getNpExpiring(contractId, qm).then((exp: any) => {
      if (cancelled) return;
      if (!exp || (!exp.terms && !exp.layers?.length)) return;
      const et = exp.terms || {};
      const expLayerRows = exp.layers || [];
      const expEgnpi     = parseFloat(et.egnpi) || 0;
      if (expEgnpi) setExpiringEgnpi(expEgnpi);

      // ── Expiring (previous year) calculations ──
      const expFirstDed = expLayerRows.length ? (parseFloat(expLayerRows[0].attachment) || 0) : (parseFloat(et.deductible) || 0);
      const expTotalLimit = expLayerRows.reduce((s: number, l: any) => s + (parseFloat(l.layer_limit) || 0), 0);
      const expTotalAgg = expLayerRows.reduce((s: number, l: any) => s + (parseFloat(l.aggregate_limit) || 0), 0);
      const expTotalEP  = expLayerRows.reduce((s: number, l: any) => s + (parseFloat(l.earned_premium) || 0), 0);
      // Rate = total earned premium / EGNPI (overall programme rate)
      const expRate = expEgnpi > 0 ? (expTotalEP / expEgnpi * 100) : 0;

      // ── Current year calculations ──
      const curEgnpi = parseFloat(npDetail.estGnpi) || 0;
      const curLayers: any[] = localStructureLayers.length ? localStructureLayers : [];
      const curFirstDed = curLayers.length ? (parseFloat(curLayers[0].deductible ?? curLayers[0].attachment) || 0) : (parseFloat(npDetail.deductible) || 0);
      const curTotalLimit = curLayers.reduce((s, l) => s + (parseFloat(l.limit) || 0), 0);
      const curTotalAgg = curLayers.reduce((s, l) => s + (parseFloat(l.annualAggLimit ?? l.aggregate_limit) || 0), 0);
      const curTotalEP  = curLayers.reduce((s, l) => s + (parseFloat(l.earnedPremium ?? l.earned_premium) || 0), 0);
      const curRate = curEgnpi > 0 ? (curTotalEP / curEgnpi * 100) : 0;

      setTreatyMetrics(prev => {
        const next: Record<string, string> = { ...prev };
        const autoPrev = (k: string, val: unknown) => { if (!next[k + '_prev'] && val) next[k + '_prev'] = String(val); };
        const autoCurr = (k: string, val: unknown) => { if (val) next[k + '_curr'] = String(val); };

        // Deductible as % of Cover = first layer deductible / total limit of all layers
        if (expFirstDed && expTotalLimit) autoPrev('ded_pct_cover', ((expFirstDed / expTotalLimit) * 100).toFixed(2) + '%');
        if (curFirstDed && curTotalLimit) autoCurr('ded_pct_cover', ((curFirstDed / curTotalLimit) * 100).toFixed(2) + '%');

        // Deductible as % EGNPI
        if (expFirstDed && expEgnpi) autoPrev('ded_pct_egnpi', ((expFirstDed / expEgnpi) * 100).toFixed(2) + '%');
        if (curFirstDed && curEgnpi) autoCurr('ded_pct_egnpi', ((curFirstDed / curEgnpi) * 100).toFixed(2) + '%');

        // % Change EGNPI — show absolute values, % change auto-computed in render
        if (expEgnpi) autoPrev('chg_egnpi', expEgnpi.toLocaleString());
        if (curEgnpi) autoCurr('chg_egnpi', curEgnpi.toLocaleString());

        // % Change Aggregates — sum of all aggregate limits per year
        if (expTotalAgg) autoPrev('chg_aggregates', expTotalAgg.toLocaleString());
        if (curTotalAgg) autoCurr('chg_aggregates', curTotalAgg.toLocaleString());

        // % Change in Rates — total earned premium / EGNPI (programme rate)
        if (expRate) autoPrev('chg_rates', expRate.toFixed(4) + '%');
        if (curRate) autoCurr('chg_rates', curRate.toFixed(4) + '%');

        // % Change in Risk Profile — weighted average ROL across layers
        // ROL = earned premium / limit per layer, weighted by limit
        if (expTotalLimit > 0 && expLayerRows.length) {
          const wtdRol = expLayerRows.reduce((s: number, l: any) => {
            const lim = parseFloat(l.layer_limit) || 0;
            const ep = parseFloat(l.earned_premium) || 0;
            return s + (lim > 0 ? (ep / lim) * lim : 0);
          }, 0) / expTotalLimit * 100;
          if (wtdRol) autoPrev('chg_risk_profile', wtdRol.toFixed(4) + '%');
        }
        if (curTotalLimit > 0 && curLayers.length) {
          const wtdRol = curLayers.reduce((s, l) => {
            const lim = parseFloat(l.limit) || 0;
            const ep = parseFloat(l.earnedPremium ?? l.earned_premium) || 0;
            return s + (lim > 0 ? (ep / lim) * lim : 0);
          }, 0) / curTotalLimit * 100;
          if (wtdRol) autoCurr('chg_risk_profile', wtdRol.toFixed(4) + '%');
        }

        return next;
      });
    }).catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contractId, quoteMode, npDetail, localStructureLayers]);

  // ── Load portfolio treaties for analysis comparison (quote mode only) ──
  useEffect(() => {
    if (!isQuote || !contractId) return;
    let cancelled = false;
    Promise.all([
      api.listContracts({ limit: 200 }).catch(() => []),
      typeof (api as any).getPortfolioExport === 'function'
        ? (api as any).getPortfolioExport().catch(() => null)
        : Promise.resolve(null),
    ]).then(([treatiesRaw, portfolioExportRaw]) => {
      if (cancelled) return;
      const treaties = treatiesRaw as any;
      const portfolioExport = portfolioExportRaw as any;
      // Filter to NP treaties (same treaty category), exclude current contract
      const npTreaties = (Array.isArray(treaties) ? treaties : []).filter((t: any) =>
        String(t.contract_id || t.id) !== String(contractId) &&
        (String(t.treaty_category || '').toUpperCase().includes('NON') ||
         String(t.treaty_type_name || '').toUpperCase().includes('XL') ||
         String(t.treaty_type_name || '').toUpperCase().includes('EXCESS'))
      );
      const treatyMap = new Map(npTreaties.map((t: any) => [String(t.contract_id || t.id), t]));
      const npRows = Array.isArray(portfolioExport?.np)
        ? portfolioExport.np.filter((r: any) => String(r.contract_id || '') !== String(contractId))
        : [];
      setPortfolioExportRows(npRows);

      if (npRows.length) {
        const grouped = new Map<string, any>();
        npRows.forEach((row: any) => {
          const cid = String(row.contract_id || '');
          if (!cid) return;
          const treaty: any = treatyMap.get(cid) || {};
          const existing = grouped.get(cid) || {
            id: cid,
            contract_id: cid,
            country_id: treaty.country_id || '',
            countryId: treaty.country_id || '',
            country: row.country || treaty.country_name || '',
            region: row.region || treaty.region || treaty.region_name || '',
            treaty_type_name: row.treaty_type || treaty.treaty_type_name || '',
            layers: [],
          };
          existing.layers.push({
            layer_number: row.layer_number,
            attachment: row.attachment,
            layer_limit: row.limit_layer,
            limit: row.limit_layer,
            egnpi: row.egnpi_100,
            earnedPremium: row.premium_100,
            rol: row.rol_pct,
            rate: row.rate_pct,
          });
          grouped.set(cid, existing);
        });
        setPortfolioTreaties([...grouped.values()]);
      } else {
        setPortfolioTreaties(npTreaties);
      }
    }).catch(() => {});
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [contractId, isQuote]);
}

export default useNpPricingLoads;
