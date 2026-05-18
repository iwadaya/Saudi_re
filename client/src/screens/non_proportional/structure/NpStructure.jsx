import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { api } from '../../../api';
import { useContractId } from '../../../hooks/useContractId';
import { useGlobalToast } from '../../../hooks/useToast';
import { useAppState } from '../../../context/AppContext';
import { ACTIVE_QUOTE_ID } from '../../../constants/storageKeys';
import { handleStaleWrite } from '../../../utils/handleStaleWrite';
import WizardLayout from '../../../components/WizardLayout';
import { getNpTreatyTypeMode, isNpStopLossTreaty, isNpAggregateXlTreaty } from '../../../utils/npTreatyType';
import {
  toNum, rateToFloat, appendPct, fmtPctMaybe,
  strOrEmpty, strRate, parseExcelInt, parseClipboard,
  emptyLayer, emptyCoveredProp,
  PASTE_FIELD_ORDER, NUMERIC_FIELDS,
  CommaInput, RateInput, PctInput,
} from './NpStructureHelpers';
import { QuoteStructureSection } from './QuoteStructureSection';
import NpStopLossStructure from './NpStopLossStructure';
import NpStopLossExpiring from '../expiring_structure/NpStopLossExpiring';
import NpAggregateXlStructure from './NpAggregateXlStructure';

const ROUTE_KEY = 'NP_STRUCTURE';

export default function NpStructure() {
  const contractId = useContractId();
  const showToast = useGlobalToast();
  const { state: appState, setSlice, structRefsMap } = useAppState();
  const [layers, setLayers] = useState([]);
  const [cobRows, setCobRows] = useState([]);
  const [coveredProps, setCoveredProps] = useState([]);
  const [cobOptions, setCobOptions] = useState([]);
  const [savedQuoteStructures, setSavedQuoteStructures] = useState([]);
  const [loading, setLoading] = useState(false);
  const loaded = useRef(false);
  // Expiring structure
  const [expiringLayerCount, setExpiringLayerCount] = useState(0);
  const [expiringLayers, setExpiringLayers] = useState([]);
  const [expiringTerms, setExpiringTerms] = useState({});
  const [isRenewal, setIsRenewal] = useState(false);
  const [expiringAutoPopulated, setExpiringAutoPopulated] = useState(false);
  const [expiringCoveredProps, setExpiringCoveredProps] = useState([emptyCoveredProp()]);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);

  const [showExpCurveModal, setShowExpCurveModal] = useState(false);
  const dirty = useRef(false);

  /* Quote mode detection */
  const quoteMode = !!(appState.quoteMode) || (() => {
    try { return !!localStorage.getItem(ACTIVE_QUOTE_ID); } catch { return false; }
  })();

  const npDetail = useMemo(() => appState.npTreatyDetail || {}, [appState.npTreatyDetail]);
  const mode = getNpTreatyTypeMode(appState);
  const currency = npDetail.currencyCode || npDetail.currency || 'SAR';

  // Keep expiringLayerCount in sync with Treaty Detail's expiringNumberOfLayers
  // Only override when no relational rows have been saved yet (expiringLayers is empty)
  useEffect(() => {
    const n = parseInt(npDetail.expiringNumberOfLayers || npDetail.expiring_number_of_layers || '0', 10) || 0;
    if (n > 0 && expiringLayers.length === 0) {
      setExpiringLayerCount(n);
    }
  }, [expiringLayers.length, npDetail.expiringNumberOfLayers, npDetail.expiring_number_of_layers]);

  // Mirror local layers → global npStructureLayers slice. Runs after
  // commit (effect phase) so callers like updateLayer don't have to
  // touch the cross-tree slice from inside a state updater, which
  // triggered React's "setState during render" warning.
  useEffect(() => {
    setSlice('npStructureLayers', layers);
  }, [layers, setSlice]);

  /* Structures to Quote: stored in npTreatyDetail so it persists across screens */
  const structuresCount = Math.max(1, parseInt(npDetail.quoteStructuresCount || '1', 10) || 1);
  const updateStructuresCount = useCallback((val) => {
    setSlice('npTreatyDetail', { quoteStructuresCount: val });
  }, [setSlice]);

  const isNetXl = useMemo(() => {
    const raw = String(npDetail.xlType || npDetail.xl_type || npDetail.typeOfXl || '').trim().toLowerCase().replace(/_/g, ' ');
    return raw.includes('net') && raw.includes('xl');
  }, [npDetail]);

  const getNumLayers = useCallback(() => {
    const n = parseInt(npDetail.numberOfLayers || npDetail.number_of_layers || '4', 10);
    return Number.isFinite(n) && n > 0 ? n : 4;
  }, [npDetail]);

  const getBaseDeductible = useCallback(() => {
    return String(toNum(npDetail.deductible || npDetail.maxRetention || npDetail.attachment || 0));
  }, [npDetail]);

  /* ── Recalculate deductibles (cascade from layer 1) ──
     Each layer's deductible = previous layer's deductible + previous layer's limit.
     Must accumulate — read from the updated result, not the original array.
  ── */
  const recomputeDeductibles = useCallback((allLayers) => {
    if (!allLayers.length) return allLayers;
    const base = getBaseDeductible();
    const result = [];
    for (let i = 0; i < allLayers.length; i++) {
      if (i === 0) {
        result.push({ ...allLayers[0], deductible: base || allLayers[0].deductible });
      } else {
        const prev = result[i - 1];                    // use updated previous, not original
        const prevDed = toNum(prev.deductible);
        const prevLim = toNum(prev.limit);
        const nextDed = prevDed + prevLim;
        result.push({ ...allLayers[i], deductible: nextDed > 0 ? String(nextDed) : allLayers[i].deductible });
      }
    }
    return result;
  }, [getBaseDeductible]);

  /* ── Recalculate financials ──
     Earned Premium = EGNPI × Rate%   e.g. 120,000,000 × 3% = 3,600,000
     rateToFloat("3%") = 3  →  multiply by 3 then divide by 100
  ── */
  const recomputeFinancials = useCallback((l) => {
    const egnpi   = toNum(l.egnpi);
    const ratePct = rateToFloat(l.rate);          // "3%" → 3
    const earned  = (egnpi > 0 && ratePct > 0)
      ? Math.round(egnpi * ratePct / 100)         // 120,000,000 × 3 / 100 = 3,600,000
      : 0;
    const limit  = toNum(l.limit);
    const rol    = (limit > 0 && earned > 0) ? fmtPctMaybe(earned / limit) : '';
    const mdp    = toNum(l.mdp);
    const mdpPct = (earned > 0 && mdp > 0) ? fmtPctMaybe(mdp / earned) : '';
    return { ...l, earnedPremium: earned ? String(earned) : '', rol, mdpPct };
  }, []);

  /* ── Full recalc pipeline — used when user edits limit/deductible (cascades deductibles) ── */
  const fullRecalc = useCallback((allLayers) => {
    const withDed = recomputeDeductibles(allLayers);
    return withDed.map(l => recomputeFinancials(l));
  }, [recomputeDeductibles, recomputeFinancials]);

  /* ── Financials-only recalc — used on load (deductibles already correct from DB, don't overwrite) ── */
  const recalcFinancialsOnly = useCallback((allLayers) => {
    return allLayers.map(l => recomputeFinancials(l));
  }, [recomputeFinancials]);

  /* ── Expiring layer recalc: cascade deductibles + compute earned/mdpPct/rol ──
     skipDedCascade=true on load (deductibles already correct from DB)
     skipDedCascade=false on user edit (cascade from layer 1 downward)          ── */
  const expiringRecalc = useCallback((allLayers, skipDedCascade = false) => {
    const result = [];
    for (let i = 0; i < allLayers.length; i++) {
      const l = { ...allLayers[i] };
      // Deductible cascade — skip on load, run on user edit
      if (!skipDedCascade && i > 0) {
        const prev = result[i - 1];
        const prevDed = toNum(prev.deductible);
        const prevLim = toNum(prev.limit);
        if (prevDed + prevLim > 0) l.deductible = String(prevDed + prevLim);
      }
      // Earned Premium = EGNPI × Rate%  — only overwrite if we can compute it
      const egnpiN  = toNum(l.egnpi);
      const ratePct = rateToFloat(l.rate);
      const computed = (egnpiN > 0 && ratePct > 0) ? Math.round(egnpiN * ratePct / 100) : 0;
      if (computed > 0) l.earnedPremium = String(computed);
      // else: keep whatever DB value was hydrated (strOrEmpty already applied)
      const earnedN = computed || toNum(l.earnedPremium);
      // ROL = Earned Premium / Limit
      const limitN = toNum(l.limit);
      l.rol = (limitN > 0 && earnedN > 0) ? fmtPctMaybe(earnedN / limitN) : (l.rol || '');
      // MDP% = MDP / Earned Premium
      const mdpN = toNum(l.mdp);
      l.mdpPct = (earnedN > 0 && mdpN > 0) ? fmtPctMaybe(mdpN / earnedN) : '';
      result.push(l);
    }
    return result;
  }, []);

  /* ── Lock risk/cat covers based on treaty type ── */
  const applyTreatyModeCovers = useCallback((allLayers) => {
    return allLayers.map(l => {
      if (mode === 'RISK') return { ...l, riskCover: true, catCover: false };
      if (mode === 'CAT')  return { ...l, riskCover: false, catCover: true };
      // BOTH or other (Stop Loss, Aggregate XL, etc.) — default both on, user can deselect
      return { ...l, riskCover: l.riskCover !== undefined ? l.riskCover : true, catCover: l.catCover !== undefined ? l.catCover : true };
    });
  }, [mode]);

  /* ── Load COB options ── */
  useEffect(() => {
    let cancelled = false;
    async function loadCobs() {
      try {
        if (contractId) {
          const data = await api.getContractCobs(contractId, quoteMode ? { quote: true } : undefined);
          if (cancelled) return;
          if (Array.isArray(data) && data.length) {
            setCobOptions(
              data
                .map(c => ({
                  id: String(c.id ?? c.class_of_business_id ?? ''),
                  name: String(c.name ?? c.class_of_business ?? ''),
                  code: String(c.code ?? ''),
                }))
                .filter(x => x.id && x.name)
            );
            return;
          }
        }
        // No contractId or getContractCobs returned empty
        // Use classIds from appState to filter the full list to only selected COBs
        const all = await api.listClassOfBusiness();
        if (!cancelled) {
          const selectedIds = new Set((npDetail.classIds || []).map(String));
          const filtered = Array.isArray(all)
            ? (selectedIds.size > 0 ? all.filter(c => selectedIds.has(String(c.id))) : all)
            : [];
          setCobOptions(filtered);
        }
      } catch {
        if (cancelled) return;
        try {
          const all = await api.listClassOfBusiness();
          if (!cancelled) {
            const selectedIds = new Set((npDetail.classIds || []).map(String));
            const filtered = Array.isArray(all)
              ? (selectedIds.size > 0 ? all.filter(c => selectedIds.has(String(c.id))) : all)
              : [];
            setCobOptions(filtered);
          }
        } catch { /* silent */ }
      }
    }
    loadCobs();
    return () => { cancelled = true; };
  }, [contractId, npDetail.classIds, quoteMode]);

  /* ── Load structure data from server ──
     Source of truth priority:
       1. contract_np_layers (relational) — always the authoritative layer data
       2. contract_np_layer_class_of_business (junction) — which COBs participate per layer
       3. contract_underwriting_limit (relational) — UW limit per COB
       4. np_structure JSONB — fallback for quote structures + coveredProps only
  ── */
  useEffect(() => {
    if (!contractId) return;
    setLoading(true);
    // Resolve quote mode: appState is authoritative, fall back to localStorage
    // in case RESET_FLOW hasn't propagated before this effect fires
    const isQuoteLoad = quoteMode || (() => {
      try { return localStorage.getItem(ACTIVE_QUOTE_ID) === contractId; } catch { return false; }
    })();
    api.getNonPropTreaty(contractId, isQuoteLoad ? { quote: true } : undefined)
      .then(data => {
        setLastUpdatedAt(data?.updated_at || null);
        const terms = data?.terms || {};
        const saved = terms?.np_structure || terms?.structure || {};
        const relationalLayers = data?.layers || [];
        const cobUwLimits = data?.cob_underwriting_limits || []; // [{cob_id, limit_amount}]

        // ── Build layers from relational table (authoritative) ──
        let ls;
        if (relationalLayers.length > 0) {
          ls = relationalLayers.map((rl, i) => ({
            ...emptyLayer(i),
            layer: rl.layer_number || (i + 1),
            limit: strOrEmpty(rl.layer_limit),
            deductible: strOrEmpty(rl.attachment),
            annualAggLimit: strOrEmpty(rl.aggregate_limit),
            egnpi: strOrEmpty(rl.egnpi),
            rate: strRate(rl.rate),         // plain number from DB → bare string for RateInput
            earnedPremium: '',                // always recomputed by fullRecalc
            rol: '',                          // always recomputed by fullRecalc
            reinstatements: strOrEmpty(rl.num_reinstatements),
            reinstatementPct: strOrEmpty(rl.reinstatement_pct),
            aad: !!rl.annual_agg_deductible,
            aadAmount: strOrEmpty(rl.annual_agg_deductible),
            riskCover: rl.peril_scope === 'RISK' || rl.peril_scope === 'BOTH',
            catCover: rl.peril_scope === 'CAT' || rl.peril_scope === 'BOTH',
            mdp: strOrEmpty(rl.mdp),
            mdpPct: '',                       // always recomputed by fullRecalc
            // classOfBusinessIds from the junction table (already loaded by server)
            classOfBusinessIds: Array.isArray(rl.class_of_business_ids) ? rl.class_of_business_ids : [],
          }));
        } else {
          // No relational layers yet — use JSONB fallback or build from treaty detail layer count.
          // Priority: data.detail.number_of_layers (just fetched) → AppContext → default 4
          const jsonbLayers = saved.layers || [];
          const countFromDetail = parseInt(data?.detail?.number_of_layers || '0', 10) || 0;
          const count = countFromDetail > 0 ? countFromDetail : getNumLayers();
          const baseDeductible = String(toNum(data?.detail?.deductible || data?.detail?.max_retention || 0) || 0);
          ls = jsonbLayers.map((l, i) => ({ ...emptyLayer(i), ...l }));
          while (ls.length < count) ls.push(emptyLayer(ls.length));
          // Trim to count if JSONB had more rows than current layer count
          if (ls.length > count && count > 0) ls = ls.slice(0, count);
          // Seed layer 1 deductible from detail if not already set
          if (ls.length > 0 && !ls[0].deductible && baseDeductible !== '0') {
            ls[0] = { ...ls[0], deductible: baseDeductible };
          }
        }
        ls = applyTreatyModeCovers(ls);
        ls = recalcFinancialsOnly(ls);  // load: deductibles already from DB, only recompute earned/rol/mdpPct
        setLayers(ls);
        setSlice('npStructureLayers', ls);

        // ── Build cobRows ──
        // For standard mode: reconstruct from relational data (UW limits + junction table COB ids per layer).
        // For quote mode:  reconstruct from JSONB cobRows (no junction table for quotes).
        // Fallback in both cases: JSONB cobRows if relational data missing.
        const jsonbCobRows = saved.cobRows || saved.cob_rows || [];

        if (!quoteMode && cobUwLimits.length > 0) {
          // Standard mode — relational source of truth
          // Build a name map from JSONB backup (populated on previous saves)
          const nameMap = new Map(jsonbCobRows.map(r => [String(r.cobId), { name: r.name, code: r.code || '' }]));
          const manualMap = new Map(jsonbCobRows.map(r => [String(r.cobId), r.manual || []]));

          const newCobRows = cobUwLimits.map(r => {
            const cobId = String(r.cob_id);
            const meta = nameMap.get(cobId) || {};
            // Layer participation: which layers have this COB in their classOfBusinessIds?
            const layerFlags = ls.map(l => (l.classOfBusinessIds || []).includes(cobId));
            const savedManual = manualMap.get(cobId) || [];
            return {
              cobId,
              name: meta.name || '',   // backfilled from cobOptions once that loads
              code: meta.code || '',
              underwritingLimit: String(r.limit_amount ?? ''),
              layers: layerFlags,
              manual: Array(ls.length).fill(false).map((_, i) => savedManual[i] || false),
            };
          });
          setCobRows(newCobRows);
        } else if (jsonbCobRows.length > 0) {
          // Quote mode or no relational data yet — use JSONB cobRows directly
          // For quote mode these are the structure 0 cobRows saved in JSONB terms
          setCobRows(jsonbCobRows);
        }
        // else: leave empty — cobOptions sync effect will initialise from cobOptions

        // Quote structures (for quote mode) — still JSONB-based
        if (Array.isArray(saved.structures) && saved.structures.length) {
          setSavedQuoteStructures(saved.structures);
        }

        // Covered props
        const cp = saved.coveredProps || saved.covered_props || [];
        setCoveredProps(cp.length > 0 ? cp : [emptyCoveredProp()]);
      })
      .catch(() => {
        const count = getNumLayers();
        let ls = Array.from({ length: count }, (_, i) => emptyLayer(i));
        ls = applyTreatyModeCovers(ls);
        ls = fullRecalc(ls);
        setLayers(ls);
        setSlice('npStructureLayers', ls);
        setCoveredProps([emptyCoveredProp()]);
      })
      .finally(() => { setLoading(false); loaded.current = true; });
    // Load expiring structure in parallel
    api.getNpExpiring(contractId, isQuoteLoad ? { quote: true } : undefined).then(exp => {
      if (!exp) return;
      setIsRenewal(!!exp.isRenewal);
      setExpiringAutoPopulated(!!exp.autoPopulated);
      const expLayers = (exp.layers || []).map((rl, i) => ({
        layer: rl.layer_number || (i + 1),
        limit: strOrEmpty(rl.layer_limit),
        deductible: strOrEmpty(rl.attachment),
        annualAggLimit: strOrEmpty(rl.aggregate_limit),
        egnpi: strOrEmpty(rl.egnpi),
        rate: strRate(rl.rate),
        earnedPremium: strOrEmpty(rl.earned_premium),  // preserve DB value; recalc will overwrite if rate present
        rol: strOrEmpty(rl.rol),                        // preserve DB value too
        mdp: strOrEmpty(rl.mdp),
        mdpPct: '',
        reinstatements: strOrEmpty(rl.num_reinstatements),
        reinstatementPct: strOrEmpty(rl.reinstatement_pct),
        aad: !!rl.annual_agg_deductible,
        aadAmount: strOrEmpty(rl.annual_agg_deductible),
        riskCover: rl.peril_scope === 'RISK' || rl.peril_scope === 'BOTH',
        catCover:  rl.peril_scope === 'CAT'  || rl.peril_scope === 'BOTH',
        perilScope: rl.peril_scope || 'BOTH',
      }));
      // Always set layer count (even 0) so no ghost rows show before data arrives
      // Fallback to npDetail.expiringNumberOfLayers if no saved rows yet
      const recalced = expLayers.length > 0 ? expiringRecalc(expLayers, true) : [];
      const savedCount = recalced.length ||
        parseInt(npDetail.expiringNumberOfLayers || npDetail.expiring_number_of_layers || '0', 10) || 0;
      setExpiringLayerCount(savedCount);
      setExpiringLayers(recalced);
      if (exp.terms) {
        // Coerce DB numeric values to strings for controlled inputs, preserve all fields
        const t = exp.terms;
        setExpiringTerms({
          egnpi:                 t.egnpi                 != null ? String(t.egnpi)                 : '',
          deductible:            t.deductible            != null ? String(t.deductible)            : '',
          risk_limit:            t.risk_limit            != null ? String(t.risk_limit)            : '',
          cat_limit:             t.cat_limit             != null ? String(t.cat_limit)             : '',
          brokerage_pct:         t.brokerage_pct         != null ? String(t.brokerage_pct)         : '',
          no_claims_bonus_pct:   t.no_claims_bonus_pct   != null ? String(t.no_claims_bonus_pct)   : '',
          profit_commission_pct: t.profit_commission_pct != null ? String(t.profit_commission_pct) : '',
          notes:                 t.notes                 ?? '',
        });
      }
      // coveredProps comes back at top level from the server (see
      // nonProp.js npExpiringGet). We also tolerate the legacy
      // nested location for forward-compat with any pre-fix rows
      // where the code used to read exp.terms.coveredProps.
      const expCp = Array.isArray(exp.coveredProps)
        ? exp.coveredProps
        : (Array.isArray(exp.terms?.coveredProps) ? exp.terms.coveredProps : []);
      setExpiringCoveredProps(expCp.length > 0 ? expCp : [emptyCoveredProp()]);
    }).catch(() => {});
  }, [contractId, getNumLayers, applyTreatyModeCovers, fullRecalc, recalcFinancialsOnly, quoteMode, setSlice, expiringRecalc, npDetail.expiringNumberOfLayers, npDetail.expiring_number_of_layers]);

  /* ── Re-sync layers when treaty detail deductible or numberOfLayers changes ──
     When the user edits these fields on Treaty Detail and navigates back to Structure,
     the layers should reflect the updated base deductible and layer count without
     requiring a full page reload or server re-fetch.
     - If deductible changes: re-cascade deductibles from layer 1 (full recalc pipeline).
     - If numberOfLayers changes: add/trim layers to match, then recalc.
     Guards:
       - Only runs when layers are already loaded (length > 0).
       - Uses refs to track the previous values so we only act on actual changes.
  ── */
  const prevDedRef = React.useRef(null);
  const prevNumLayersRef = React.useRef(null);
  useEffect(() => {
    if (!layers.length) return;
    const curDed = String(toNum(npDetail.deductible || npDetail.maxRetention || 0));
    const curNum = parseInt(npDetail.numberOfLayers || npDetail.number_of_layers || '0', 10) || 0;

    const dedChanged       = prevDedRef.current !== null && prevDedRef.current !== curDed;
    const numLayersChanged = prevNumLayersRef.current !== null && curNum > 0 && prevNumLayersRef.current !== curNum;

    prevDedRef.current       = curDed;
    prevNumLayersRef.current = curNum;

    if (!dedChanged && !numLayersChanged) return;

    setLayers(prev => {
      let ls = [...prev];
      // Adjust layer count if numberOfLayers changed
      if (numLayersChanged && curNum > 0) {
        while (ls.length < curNum) ls.push(emptyLayer(ls.length));
        if (ls.length > curNum) ls = ls.slice(0, curNum);
      }
      // Re-cascade deductibles from base deductible (fullRecalc does recomputeDeductibles + financials)
      return fullRecalc(ls);
    });
  }, [fullRecalc, layers.length, npDetail.deductible, npDetail.maxRetention, npDetail.numberOfLayers, npDetail.number_of_layers]);

  /* ── Auto-recompute COB coverage from underwriting limits ──
     Business rule: a COB participates in a layer if and only if
     its underwriting limit EXCEEDS that layer's attachment (deductible).
     i.e. UW limit > attachment → loss from this COB can trigger that layer.
     Manual overrides (r.manual[i] = true) bypass the auto-calc for that cell.
  ── */
  const recomputeCobCoverage = useCallback((rows, layerData) => {
    return rows.map(r => {
      const ul = toNum(r.underwritingLimit);
      const n = layerData.length;
      const nextLayers = [...(r.layers || [])];
      const manual = [...(r.manual || [])];
      while (nextLayers.length < n) nextLayers.push(false);
      while (manual.length < n) manual.push(false);
      for (let i = 0; i < n; i++) {
        if (manual[i]) continue;
        const attach = toNum(layerData[i]?.deductible);
        // COB triggers this layer only if its UW limit exceeds the layer attachment
        nextLayers[i] = ul > attach;
      }
      return { ...r, layers: nextLayers, manual };
    });
  }, []);

  /* ── Update a single layer field ── */
  // setSlice lives in a sibling useEffect — calling it from inside the
  // setLayers updater fired React's "Cannot update a component while
  // rendering a different component" warning, since functional state
  // updaters run during reconciliation. The useEffect below mirrors
  // `layers` → npStructureLayers whenever layers changes, which is
  // semantically identical but runs AFTER commit.
  const updateLayer = useCallback((idx, field, value) => {
    setLayers(prev => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: value };
      const recalced = fullRecalc(next);
      if (field === 'limit') {
        setCobRows(cr => recomputeCobCoverage(cr, recalced));
      }
      return recalced;
    });
    dirty.current = true;
  }, [fullRecalc, recomputeCobCoverage]);

  const addLayer = useCallback(() => {
    setLayers(prev => {
      const recalced = fullRecalc([...prev, emptyLayer(prev.length)]);
      setCobRows(cr => recomputeCobCoverage(cr, recalced));
      return recalced;
    });
    dirty.current = true;
  }, [fullRecalc, recomputeCobCoverage]);

  const deleteLastLayer = useCallback(() => {
    setLayers(prev => {
      if (prev.length <= 1) return prev;
      const recalced = fullRecalc(prev.slice(0, -1));
      setCobRows(cr => recomputeCobCoverage(cr, recalced));
      return recalced;
    });
    dirty.current = true;
  }, [fullRecalc, recomputeCobCoverage]);

  /* ── Excel paste handler for layer table ── */
  const handleLayerPaste = useCallback((e) => {
    const target = e.target;
    if (!target || !target.closest('tr[data-layer-row]')) return;
    const tr = target.closest('tr[data-layer-row]');
    const startRow = Number(tr.getAttribute('data-layer-row'));
    // Determine the field from data-paste-field attribute
    const field = target.getAttribute('data-paste-field');
    if (!Number.isFinite(startRow) || !field) return;
    const clip = e.clipboardData?.getData('text') ?? '';
    const matrix = parseClipboard(clip);
    if (matrix.length <= 1 && (!matrix[0] || matrix[0].length <= 1)) return; // single cell = normal paste
    e.preventDefault();

    setLayers(prev => {
      const next = prev.map(l => ({ ...l }));
      const startCol = Math.max(0, PASTE_FIELD_ORDER.indexOf(field));
      for (let r = 0; r < matrix.length; r++) {
        const idx = startRow + r;
        if (idx >= next.length) break;
        const rowVals = matrix[r] || [];
        if (rowVals.length <= 1) {
          // Single column paste into the target field
          const val = rowVals[0] || '';
          if (NUMERIC_FIELDS.has(field)) next[idx][field] = parseExcelInt(val);
          else if (field === 'rate') next[idx].rate = appendPct(val);
          else next[idx][field] = val;
        } else {
          for (let c = 0; c < rowVals.length; c++) {
            const f = PASTE_FIELD_ORDER[startCol + c];
            if (!f) break;
            const val = rowVals[c] || '';
            if (NUMERIC_FIELDS.has(f)) next[idx][f] = parseExcelInt(val);
            else if (f === 'rate') next[idx].rate = appendPct(val);
            else next[idx][f] = val;
          }
        }
      }
      dirty.current = true;
      return fullRecalc(next);
    });
  }, [fullRecalc]);

  /* ── Excel paste handler for expiring layer table ── */
  const handleExpiringPaste = useCallback((e) => {
    const target = e.target;
    if (!target || !target.closest('tr[data-exp-row]')) return;
    const tr = target.closest('tr[data-exp-row]');
    const startRow = Number(tr.getAttribute('data-exp-row'));
    const field = target.getAttribute('data-paste-field');
    if (!Number.isFinite(startRow) || !field) return;
    const clip = e.clipboardData?.getData('text') ?? '';
    const matrix = parseClipboard(clip);
    if (matrix.length <= 1 && (!matrix[0] || matrix[0].length <= 1)) return;
    e.preventDefault();
    const emptyExp = { layer: 0, limit:'', deductible:'', annualAggLimit:'', egnpi:'', earnedPremium:'', rate:'', mdp:'', mdpPct:'', reinstatements:'', reinstatementPct:'', aad:false, aadAmount:'', riskCover:true, catCover:true, rol:'' };
    setExpiringLayers(prev => {
      // Ensure array is long enough
      const next = Array.from({ length: Math.max(expiringLayerCount, prev.length) }, (_, i) => ({
        ...emptyExp, layer: i + 1, ...(prev[i] || {})
      }));
      const startCol = Math.max(0, PASTE_FIELD_ORDER.indexOf(field));
      for (let r = 0; r < matrix.length; r++) {
        const idx = startRow + r;
        if (idx >= next.length) break;
        const rowVals = matrix[r] || [];
        if (rowVals.length <= 1) {
          const val = rowVals[0] || '';
          if (NUMERIC_FIELDS.has(field)) next[idx][field] = parseExcelInt(val);
          else if (field === 'rate') next[idx].rate = appendPct(val);
          else next[idx][field] = val;
        } else {
          for (let c = 0; c < rowVals.length; c++) {
            const f = PASTE_FIELD_ORDER[startCol + c];
            if (!f) break;
            const val = rowVals[c] || '';
            if (NUMERIC_FIELDS.has(f)) next[idx][f] = parseExcelInt(val);
            else if (f === 'rate') next[idx].rate = appendPct(val);
            else next[idx][f] = val;
          }
        }
      }
      dirty.current = true;
      return expiringRecalc(next); // cascade deductibles + recompute financials
    });
  }, [expiringRecalc, expiringLayerCount]);

  /* ── COB row updates ── */
  const updateCobRow = useCallback((idx, field, value) => {
    setCobRows(prev => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: value };
      if (field === 'underwritingLimit') {
        return recomputeCobCoverage(next, layers);
      }
      return next;
    });
    dirty.current = true;
  }, [layers, recomputeCobCoverage]);

  const toggleCobLayer = useCallback((cobIdx, layerIdx) => {
    setCobRows(prev => {
      const next = [...prev];
      const r = { ...next[cobIdx] };
      r.layers = [...(r.layers || [])];
      r.manual = [...(r.manual || [])];
      r.layers[layerIdx] = !r.layers[layerIdx];
      r.manual[layerIdx] = true;
      next[cobIdx] = r;
      return next;
    });
    dirty.current = true;
  }, []);

  /* ── Covered props with auto-calc ── */
  const updateCoveredProp = useCallback((idx, field, value) => {
    setCoveredProps(prev => {
      const next = [...prev]; next[idx] = { ...next[idx], [field]: value }; return next;
    });
    dirty.current = true;
  }, []);

  const coveredPropsCalc = useMemo(() => coveredProps.map(r => {
    const qs = toNum(r.qsLimit);
    const retPct01 = rateToFloat(r.retentionPct) / 100;
    const retAmt = (qs > 0 && retPct01 > 0) ? Math.round(qs * retPct01) : 0;
    const lines = toNum(r.surplusLines);
    const totalCap = qs > 0 ? Math.round(qs * (1 + Math.max(0, lines))) : 0;
    return { ...r, retentionAmount: retAmt, totalCapacity: totalCap };
  }), [coveredProps]);

  const expiringCoveredPropsCalc = useMemo(() => expiringCoveredProps.map(r => {
    const qs = toNum(r.qsLimit);
    const retPct01 = rateToFloat(r.retentionPct) / 100;
    const retAmt = (qs > 0 && retPct01 > 0) ? Math.round(qs * retPct01) : 0;
    const lines = toNum(r.surplusLines);
    const totalCap = qs > 0 ? Math.round(qs * (1 + Math.max(0, lines))) : 0;
    return { ...r, retentionAmount: retAmt, totalCapacity: totalCap };
  }), [expiringCoveredProps]);

  const updateExpiringCoveredProp = useCallback((i, field, val) => {
    setExpiringCoveredProps(prev => {
      const next = [...prev];
      next[i] = { ...next[i], [field]: val };
      return next;
    });
  }, []);

  /* ── Ensure COB rows match treaty detail COBs ──
     Two jobs:
     1. If cobRows is empty (first visit, no saved data), initialise from cobOptions.
     2. Backfill any cobRow whose name is missing/empty once cobOptions loads.
        This fixes the race where relational load fires before cobOptions resolves.
  ── */
  useEffect(() => {
    if (!cobOptions.length || !layers.length) return;
    setCobRows(prev => {
      // Job 1: init empty rows from cobOptions
      if (prev.length === 0) {
        const n = layers.length;
        return cobOptions.map(c => ({
          cobId: String(c.id), name: c.name, code: c.code || '',
          underwritingLimit: '', layers: Array(n).fill(false), manual: Array(n).fill(false),
        }));
      }
      // Job 2: backfill missing names from cobOptions
      const optMap = new Map(cobOptions.map(c => [String(c.id), c]));
      const needsFill = prev.some(r => !r.name || r.name === r.cobId);
      if (!needsFill) return prev;
      return prev.map(r => {
        if (r.name && r.name !== r.cobId) return r;
        const opt = optMap.get(String(r.cobId));
        return opt ? { ...r, name: opt.name, code: opt.code || r.code || '' } : r;
      });
    });
  }, [cobOptions, layers.length]);

  /* ── Save ──
     Relational writes:
       • contract_np_layers          — every layer with all fields + peril_scope
       • contract_np_layer_class_of_business — junction: (layer_id, cob_id) per layer
       • contract_underwriting_limit — UW limit per COB (drives loss-to-layer assignment)
     JSONB write (np_structure key):
       • cobRows backup + coveredProps + quote structures
     The layer↔COB participation is derived: UW limit > attachment → COB triggers layer.
     Manual checkbox overrides are preserved in the JSONB cobRows.manual arrays.
  ── */
  const save = useCallback(async (options = {}) => {
    if (!contractId) return true;
    if (!loaded.current) return true; // don't overwrite DB before data has loaded
    // Resolve quote mode reliably — appState + localStorage fallback
    const isQuoteSave = quoteMode || (() => {
      try { return localStorage.getItem(ACTIVE_QUOTE_ID) === contractId; } catch { return false; }
    })();
    const lockOverride = options?.ifUnmodifiedSince;
    let activeLock = lockOverride || lastUpdatedAt;
    const requestOptions = () => (
      isQuoteSave
        ? { quote: true, ...(activeLock ? { ifUnmodifiedSince: activeLock } : {}) }
        : (activeLock ? { ifUnmodifiedSince: activeLock } : undefined)
    );
    const noteSaved = (response) => {
      if (!response?.updated_at) return;
      activeLock = response.updated_at;
      setLastUpdatedAt(response.updated_at);
    };
    const pn = v => { const s = String(v ?? '').replace(/,/g, ''); const n = parseFloat(s); return Number.isFinite(n) ? n : null; };

    let payload;
    if (quoteMode) {
      /* ── Quote mode: collect data from each QuoteStructureSection via context refs ── */
      const structures = [];
      for (let i = 0; i < structuresCount; i++) {
        const ref = structRefsMap.current?.[i];
        if (ref?.current) structures.push(ref.current());
      }
      // Quote mode — quote_np_layers has the same full column set as contract_np_layers.
      // Structure 1 layers go into the relational table; all structures also stored in JSONB.
      // COB participation per layer lives in JSONB (no junction table for quotes).
      // UW limits go into quote_underwriting_limit (shared across all structures in a quote).

      // Collect UW limits from structure 1 (the primary structure)
      const struct0CobRows = structures[0]?.cobRows || [];
      const quoteCobUwLimits = struct0CobRows
        .filter(r => r.cobId)
        .map(r => ({ cob_id: String(r.cobId), limit_amount: pn(r.underwritingLimit) }));

      // Build relational layer rows from structure 1
      const struct0Layers = structures[0]?.layers || [];
      const struct0LayerCobIds = struct0Layers.map((_, li) =>
        struct0CobRows
          .filter(r => !!(r.layers && r.layers[li]))
          .map(r => String(r.cobId))
          .filter(Boolean)
      );

      payload = {
        layers: struct0Layers.map((l, i) => ({
          layer_number: i + 1,
          attachment: pn(l.deductible),
          layer_limit: pn(l.limit),
          aggregate_limit: pn(l.annualAggLimit ?? l.deductible),
          egnpi: pn(l.egnpi),
          earned_premium: null,
          rate: null,
          rol: null,
          num_reinstatements: l.reinstatements || null,
          reinstatement_pct: pn(l.reinstatementPct),
          annual_agg_deductible: pn(l.aadAmount),
          peril_scope: l.riskCover && l.catCover ? 'BOTH' : l.catCover ? 'CAT' : 'RISK',
          mdp: null,
          mdp_pct: null,
        })),
        cob_underwriting_limits: quoteCobUwLimits,
        terms: {
          np_structure: {
            structures: structures.map((st, i) => ({
              structureNo: i + 1,
              layersCount: String(st.layersCount ?? ''),
              layers: (st.layers || []).map(l => ({
                layer: l.layer, limit: l.limit, deductible: l.deductible,
                annualAggLimit: l.annualAggLimit ?? '',
                aad: !!l.aad, aadAmount: l.aadAmount,
                reinstatements: l.reinstatements, reinstatementPct: l.reinstatementPct,
                egnpi: l.egnpi,
                riskCover: l.riskCover !== undefined ? !!l.riskCover : true,
                catCover:  l.catCover  !== undefined ? !!l.catCover  : true,
              })),
              cobRows: (st.cobRows || []).map(r => ({
                cobId: r.cobId, name: r.name,
                underwritingLimit: r.underwritingLimit,
                layers: r.layers,
                manual: r.manual || [],
              })),
            })),
            layers: struct0Layers.map((l, i) => ({
              ...l, classOfBusinessIds: struct0LayerCobIds[i] || [],
            })),
            cobRows: struct0CobRows,
            coveredProps: coveredProps.filter(r => r.cobId || r.qsLimit).map(r => ({
              cobId: r.cobId, qsLimit: r.qsLimit, retentionPct: r.retentionPct, surplusLines: r.surplusLines,
            })),
          },
        },
      };
    } else {
      /* ── Standard mode ──
         Derive classOfBusinessIds for each layer from cobRows state.
         A COB participates in a layer if cobRows[cob].layers[i] === true.
         This is the source of truth for the junction table.
      ── */
      const layerCobIds = layers.map((_, li) =>
        cobRows
          .filter(r => !!(r.layers && r.layers[li]))
          .map(r => String(r.cobId))
          .filter(Boolean)
      );

      payload = {
        // Relational layer rows — full data per layer
        layers: layers.map((l, i) => ({
          layer_number: i + 1,
          attachment: pn(l.deductible),
          layer_limit: pn(l.limit),
          aggregate_limit: pn(l.annualAggLimit),
          egnpi: pn(l.egnpi),
          earned_premium: pn(l.earnedPremium),
          rate: pn(l.rate),
          rol: pn(l.rol),
          num_reinstatements: pn(l.reinstatements),
          reinstatement_pct: pn(l.reinstatementPct),
          annual_agg_deductible: pn(l.aadAmount),
          // peril_scope: RISK, CAT, or BOTH — determines which loss types can trigger this layer
          peril_scope: l.riskCover && l.catCover ? 'BOTH' : l.catCover ? 'CAT' : 'RISK',
          mdp: pn(l.mdp),
          mdp_pct: pn(l.mdpPct),
          // COB participation for this layer (for junction table)
          class_of_business_ids: layerCobIds[i] || [],
        })),

        // UW limits per COB — used by loss screens to determine if a loss triggers a layer
        cob_underwriting_limits: cobRows
          .filter(r => r.cobId)
          .map(r => ({
            cob_id: String(r.cobId),
            limit_amount: pn(r.underwritingLimit),
          })),

        // JSONB backup for cobRows (preserves manual overrides + names for re-hydration)
        terms: {
          np_structure: {
            layers: layers.map(l => ({
              layer: l.layer, limit: l.limit, deductible: l.deductible,
              annualAggLimit: l.annualAggLimit, egnpi: l.egnpi, rate: l.rate,
              earnedPremium: l.earnedPremium, mdp: l.mdp, mdpPct: l.mdpPct,
              reinstatements: l.reinstatements, reinstatementPct: l.reinstatementPct,
              aad: !!l.aad, aadAmount: l.aadAmount,
              riskCover: !!l.riskCover, catCover: !!l.catCover, rol: l.rol,
            })),
            cobRows: cobRows.map(r => ({
              cobId: r.cobId, name: r.name, code: r.code || '',
              underwritingLimit: r.underwritingLimit,
              layers: r.layers,
              manual: r.manual,
            })),
            coveredProps: coveredProps.filter(r => r.cobId || r.qsLimit).map(r => ({
              cobId: r.cobId, qsLimit: r.qsLimit, retentionPct: r.retentionPct, surplusLines: r.surplusLines,
            })),
          },
        },
      };
    }
    try {
      noteSaved(await api.saveNonPropTreaty(contractId, payload, requestOptions()));

      // Surface a non-blocking warning if any layer was saved with no
      // COB participation but a non-zero attachment. The pricing engine
      // reads `class_of_business_ids` to decide which losses trigger a
      // layer; an empty list means the layer will silently produce a 0
      // expected loss. The save still succeeds (an empty list is valid
      // server-side) but the underwriter should know.
      const layersWithNoCob = (payload.layers || []).filter((rl) => {
        const ids = Array.isArray(rl.class_of_business_ids) ? rl.class_of_business_ids : [];
        const hasAttach = (Number(rl.attachment) || 0) > 0;
        return ids.length === 0 && hasAttach;
      });
      if (layersWithNoCob.length > 0) {
        const numbers = layersWithNoCob.map(l => `L${l.layer_number}`).join(', ');
        showToast(`Saved. Note: ${layersWithNoCob.length} layer${layersWithNoCob.length === 1 ? '' : 's'} (${numbers}) ${layersWithNoCob.length === 1 ? 'has' : 'have'} no class of business — they won't be triggered by any loss in pricing.`);
      }

      // Save expiring structure to relational tables
      const expPayload = {
        layers: expiringLayers.map((l, i) => ({
          layer_number: i + 1,
          attachment:             pn(l.deductible),
          layer_limit:            pn(l.limit),
          aggregate_limit:        pn(l.annualAggLimit),
          egnpi:                  pn(l.egnpi),
          earned_premium:         pn(l.earnedPremium),
          rate:                   pn(l.rate),    // pn strips % → stores 1.5 not "1.5%"
          rol:                    pn(l.rol),
          num_reinstatements:     l.reinstatements ? parseInt(l.reinstatements) : null,
          reinstatement_pct:      pn(l.reinstatementPct),
          annual_agg_deductible:  pn(l.aadAmount),
          peril_scope: l.riskCover && l.catCover ? 'BOTH' : l.catCover ? 'CAT' : 'RISK',
          mdp:                    pn(l.mdp),
          mdp_pct:                pn(l.mdpPct),
        })),
        terms: {
          // Preserve all server fields so ON CONFLICT DO UPDATE doesn't null out auto-populated values
          egnpi:                 expiringTerms.egnpi                 ?? null,
          deductible:            expiringTerms.deductible            ?? null,
          risk_limit:            expiringTerms.risk_limit            ?? null,
          cat_limit:             expiringTerms.cat_limit             ?? null,
          brokerage_pct:         expiringTerms.brokerage_pct         ?? null,
          no_claims_bonus_pct:   expiringTerms.no_claims_bonus_pct   ?? null,
          profit_commission_pct: expiringTerms.profit_commission_pct ?? null,
          notes:                 expiringTerms.notes                 ?? null,
        },
        // coveredProps lives at TOP LEVEL — the server handler reads
        // `req.body.coveredProps`, and GET /np/expiring returns it at
        // the top level too. An earlier revision nested it inside
        // `terms`, which caused every save to persist `covered_props='[]'`.
        coveredProps: expiringCoveredProps.filter(r => r.cobId || r.qsLimit).map(r => ({
          cobId: r.cobId, qsLimit: r.qsLimit, retentionPct: r.retentionPct, surplusLines: r.surplusLines,
        })),
      };
      noteSaved(await api.saveNpExpiring(contractId, expPayload, requestOptions()));
      dirty.current = false;
      return true;
    } catch (e) {
      console.error('[NpStructure] save failed:', e);
      if (lockOverride !== '*') {
        const stale = await handleStaleWrite(e, {
          entityType: isQuoteSave ? 'quote structure' : 'structure',
          onRefresh: () => window.location.reload(),
          onOverwrite: () => save({ ifUnmodifiedSince: '*' }),
        });
        if (stale.handled) return stale.action === 'overwrite' ? !!stale.result : false;
      }
      showToast('Structure save failed: ' + (e?.message || 'Server error'));
      return false;
    }
  }, [contractId, quoteMode, lastUpdatedAt, coveredProps, structuresCount, structRefsMap, layers, cobRows, expiringLayers, expiringTerms.egnpi, expiringTerms.deductible, expiringTerms.risk_limit, expiringTerms.cat_limit, expiringTerms.brokerage_pct, expiringTerms.no_claims_bonus_pct, expiringTerms.profit_commission_pct, expiringTerms.notes, expiringCoveredProps, showToast]);

  // RISK: risk forced on, cat forced off, both columns disabled
  // CAT:  cat forced on, risk forced off, both columns disabled
  // BOTH: both editable (default on)
  // '' (Stop Loss, Excess of Loss, Aggregate XL): both editable (default on)
  const riskLocked = mode === 'RISK' || mode === 'CAT';
  const catLocked  = mode === 'RISK' || mode === 'CAT';
  const riskPillOn = mode === 'RISK' || mode === 'BOTH';
  const catPillOn  = mode === 'CAT'  || mode === 'BOTH';

  const reinstatementOptions = useMemo(() => {
    const opts = [{ v: '', l: '—' }];
    for (let i = 1; i <= 10; i++) opts.push({ v: String(i), l: String(i) });
    opts.push({ v: 'UNLIMITED', l: 'Unlimited' });
    return opts;
  }, []);

  // Stop Loss + Aggregate XL each have their own structure surfaces
  // (different shapes from the Risk XL / Cat XL layer grid). Short-
  // circuit the regular layout so each treaty type renders its
  // dedicated setup instead.
  const stopLossTreaty = isNpStopLossTreaty(appState);
  const aggregateXlTreaty = isNpAggregateXlTreaty(appState);

  return (
    <WizardLayout routeKey={ROUTE_KEY} title="Structure" headerPill={`${quoteMode ? 'NP-QUOTE TREATY' : 'NON-PROPORTIONAL TREATY'}: STRUCTURE`} onBeforeNext={save} onBeforeBack={save}>
      {() => (
        <div className="NP_STRUCTURE">
          {stopLossTreaty ? (
            <>
              <NpStopLossStructure currency={currency} />
              <NpStopLossExpiring currency={currency} />
            </>
          ) : aggregateXlTreaty ? (
            <NpAggregateXlStructure currency={currency} />
          ) : loading ? <div className="df-card df-card--notice"><div className="df-note">Loading...</div></div> : (
            <>
              {/* ═══ QUOTE: Structures to Quote selector ═══ */}
              {quoteMode && (
                <section className="np-struct-card glass" style={{ marginBottom: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 16, padding: '14px 18px' }}>
                    <label style={{ fontSize: 13, fontWeight: 700, color: 'rgba(255,255,255,0.6)', whiteSpace: 'nowrap' }}>
                      Structures to Quote
                    </label>
                    <select
                      className="fi"
                      style={{ width: 120 }}
                      value={String(structuresCount)}
                      onChange={e => updateStructuresCount(e.target.value)}
                    >
                      {[1,2,3,4,5].map(n => (
                        <option key={n} value={n}>{n}</option>
                      ))}
                    </select>
                    <span style={{ fontSize: 12, color: 'rgba(255,255,255,0.35)' }}>
                      Number of alternative structures to quote
                    </span>
                  </div>
                </section>
              )}

              {/* ═══ QUOTE MODE: render per-structure simplified sections ═══ */}
              {quoteMode ? (
                <>
                  {Array.from({ length: structuresCount }, (_, si) => (
                    <QuoteStructureSection
                      key={si}
                      structIdx={si}
                      currency={currency}
                      cobOptions={cobOptions}
                      reinstatementOptions={reinstatementOptions}
                      onDirty={() => { dirty.current = true; }}
                      initialData={savedQuoteStructures[si] || null}
                      mode={mode}
                    />
                  ))}
                </>
              ) : (
              <>
              {/* ═══ STANDARD MODE: full layer table ═══ */}
              <section className="np-struct-card glass" id="npLayersCard">
                <div className="np-struct-card-header">
                  <div className="np-struct-card-title">TREATY STRUCTURE – LAYERS</div>
                  <div className="np-struct-card-actions">
                    <div className="np-type-pills" aria-label="Treaty type">
                      <span className={`np-type-pill ${riskPillOn ? 'is-on' : 'is-off'}`}>RISK XL</span>
                      <span className={`np-type-pill ${catPillOn ? 'is-on' : 'is-off'}`}>CAT XL</span>
                    </div>
                    <button type="button" className="np-struct-btn" onClick={addLayer}>+ Add Layer</button>
                    <button type="button" className="np-struct-btn" onClick={deleteLastLayer} disabled={layers.length <= 1}>Delete Layer</button>
                  </div>
                </div>
                <div className="np-table-wrap np-table-wrap--scroll np-table-wrap--wide">
                  <table className="np-struct-table np-struct-table--wide">
                    <thead>
                      <tr>
                        <th className="np-table-sticky cell-center">LAYER</th>
                        <th className="np-col">LIMIT</th>
                        <th className="np-col">DEDUCTIBLE / ATTACHMENT</th>
                        <th className="np-col">AGGREGATE LIMIT</th>
                        <th className="np-col">EGNPI</th>
                        <th className="np-col-rate" title="RATE = Earned Premium ÷ EGNPI (expressed as %). Enter e.g. 2.5 for 2.5% — NOT 0.025.">RATE</th>
                        <th className="np-col">EARNED PREMIUM</th>
                        <th className="np-col">MDP</th>
                        <th className="np-col-mdp-pct">MDP%</th>
                        <th className="np-col-reinst">NO. REINSTATEMENTS</th>
                        <th className="np-col-reinst">% REINSTATEMENTS</th>
                        <th className="np-col-chk">AAD</th>
                        <th className="np-col">AAD AMOUNT</th>
                        <th className="np-col-chk">RISK</th>
                        <th className="np-col-chk">CAT</th>
                        <th className="np-col-rol" title="ROL = Earned Premium ÷ Limit (Rate-on-Line, expressed as %). Auto-computed from Rate and Limit — displayed here, not editable.">ROL</th>
                      </tr>
                    </thead>
                    <tbody onPaste={handleLayerPaste}>
                      {layers.map((l, i) => (
                        <tr key={i} data-layer-row={i}>
                          <th className="np-table-sticky cell-center">{l.layer}</th>
                          <td><CommaInput value={l.limit} onChange={v => updateLayer(i, 'limit', v)} suffix={currency} pasteField="limit" /></td>
                          <td><CommaInput value={l.deductible} readOnly suffix={currency} onChange={() => {}} /></td>
                          <td><CommaInput value={l.annualAggLimit} onChange={v => updateLayer(i, 'annualAggLimit', v)} suffix={currency} pasteField="annualAggLimit" /></td>
                          <td><CommaInput value={l.egnpi} onChange={v => updateLayer(i, 'egnpi', v)} suffix={currency} pasteField="egnpi" /></td>
                          <td className="cell-center np-col-rate"><RateInput value={l.rate} onChange={v => updateLayer(i, 'rate', v)} pasteField="rate" /></td>
                          <td><CommaInput value={l.earnedPremium} readOnly suffix={currency} onChange={() => {}} /></td>
                          <td><CommaInput value={l.mdp} onChange={v => updateLayer(i, 'mdp', v)} suffix={currency} pasteField="mdp" /></td>
                          <td className="cell-center np-col-mdp-pct"><PctInput className="np-mini-input np-mini-input--center np-mini-input--readonly" readOnly value={l.mdpPct || ''} onChange={() => {}} placeholder="—%" /></td>
                          <td className="cell-center np-col-reinst">
                            <div className="np-cell-input">
                              <select className="np-mini-input np-mini-input--center np-mini-select" value={l.reinstatements || ''} onChange={e => updateLayer(i, 'reinstatements', e.target.value)}>
                                {reinstatementOptions.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
                              </select>
                            </div>
                          </td>
                          <td className="cell-center np-col-reinst">
                            <PctInput value={l.reinstatementPct} onChange={v => updateLayer(i, 'reinstatementPct', v)} pasteField="reinstatementPct" />
                          </td>
                          <td className="np-col-chk cell-center"><input type="checkbox" className="np-check" checked={!!l.aad} onChange={e => updateLayer(i, 'aad', e.target.checked)} /></td>
                          <td><CommaInput value={l.aadAmount} onChange={v => updateLayer(i, 'aadAmount', v)} suffix={currency} disabled={!l.aad} pasteField="aadAmount" /></td>
                          <td className={`np-col-chk cell-center np-cover-cell ${mode === 'CAT' ? 'is-off' : ''} ${riskLocked ? 'is-locked' : ''}`}>
                            <input type="checkbox" className="np-check" checked={!!l.riskCover} onChange={e => updateLayer(i, 'riskCover', e.target.checked)} disabled={mode === 'RISK' || mode === 'CAT'} />
                          </td>
                          <td className={`np-col-chk cell-center np-cover-cell ${mode === 'RISK' ? 'is-off' : ''} ${catLocked ? 'is-locked' : ''}`}>
                            <input type="checkbox" className="np-check" checked={!!l.catCover} onChange={e => updateLayer(i, 'catCover', e.target.checked)} disabled={mode === 'RISK' || mode === 'CAT'} />
                          </td>
                          <td className="cell-center np-col-rol"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center np-mini-input--readonly" readOnly value={l.rol || ''} placeholder="—" /></div></td>
                        </tr>
                      ))}
                    </tbody>
                    {/* Totals row */}
                    {layers.length > 0 && (() => {
                      const totLimit     = layers.reduce((s,l) => s + toNum(l.limit), 0);
                      const firstDed     = toNum(layers[0]?.deductible);
                      const totAgg       = layers.reduce((s,l) => s + toNum(l.annualAggLimit), 0);
                      const totEgnpi     = Math.max(0, ...layers.map(l => toNum(l.egnpi)));
                      const totRate      = layers.reduce((s,l) => s + rateToFloat(l.rate), 0);
                      const totEP        = layers.reduce((s,l) => s + toNum(l.earnedPremium), 0);
                      const totMdp       = layers.reduce((s,l) => s + toNum(l.mdp), 0);
                      const totMdpPct    = totEP > 0 && totMdp > 0 ? fmtPctMaybe(totMdp / totEP) : '';
                      // ROL total = SUMPRODUCT(rate% × EGNPI) / totalLimit
                      // Falls back to SUM(earnedPremium) / totalLimit if EP is entered directly
                      const totRolNum    = layers.reduce((s,l) => s + rateToFloat(l.rate) / 100 * toNum(l.egnpi), 0);
                      const totRol       = totLimit > 0 && totRolNum > 0
                        ? fmtPctMaybe(totRolNum / totLimit)
                        : totLimit > 0 && totEP > 0 ? fmtPctMaybe(totEP / totLimit) : '';
                      const maxReinst    = layers.reduce((max,l) => {
                        if (l.reinstatements === 'UNLIMITED') return 'UNLIMITED';
                        const n = parseInt(l.reinstatements, 10);
                        return Number.isFinite(n) && n > (typeof max === 'number' ? max : 0) ? n : max;
                      }, 0);
                      const maxReinstLabel = maxReinst === 'UNLIMITED' ? 'Unlimited' : maxReinst > 0 ? String(maxReinst) : '';
                      return (
                        <tfoot>
                          <tr style={{ borderTop: '2px solid rgba(0,212,255,0.45)', background: 'rgba(0,212,255,0.06)' }}>
                            <th className="np-table-sticky cell-center" style={{ color: '#00d4ff', fontSize: 10, letterSpacing: '.08em', fontWeight: 800, background: 'rgba(0,212,255,0.08)' }}>TOTAL</th>
                            <td><CommaInput value={totLimit ? String(totLimit) : ''} readOnly suffix={currency} onChange={() => {}} /></td>
                            <td><CommaInput value={firstDed ? String(firstDed) : ''} readOnly suffix={currency} onChange={() => {}} /></td>
                            <td><CommaInput value={totAgg ? String(totAgg) : ''} readOnly suffix={currency} onChange={() => {}} /></td>
                            <td><CommaInput value={totEgnpi ? String(totEgnpi) : ''} readOnly suffix={currency} onChange={() => {}} /></td>
                            <td className="cell-center np-col-rate"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center np-mini-input--readonly" readOnly value={totRate > 0 ? `${parseFloat(totRate.toFixed(4))}%` : ''} placeholder="—" /></div></td>
                            <td><CommaInput value={totEP ? String(totEP) : ''} readOnly suffix={currency} onChange={() => {}} /></td>
                            <td><CommaInput value={totMdp ? String(totMdp) : ''} readOnly suffix={currency} onChange={() => {}} /></td>
                            <td className="cell-center np-col-mdp-pct"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center np-mini-input--readonly" readOnly value={totMdpPct} placeholder="—" /></div></td>
                            <td className="cell-center np-col-reinst"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center np-mini-input--readonly" readOnly value={maxReinstLabel} placeholder="—" /></div></td>
                            <td></td>
                            <td></td>
                            <td></td>
                            <td></td>
                            <td></td>
                            <td className="cell-center np-col-rol"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center np-mini-input--readonly" readOnly value={totRol} placeholder="—" style={{ borderColor: 'rgba(0,212,255,0.55)', borderWidth: totRol ? 2 : 1 }} /></div></td>
                          </tr>
                        </tfoot>
                      );
                    })()}
                  </table>
                </div>
                <div className="np-struct-footnote">Enter <b>Rate</b> to calculate <b>Earned Premium = EGNPI × Rate</b>. <b>ROL</b> is implied as <b>Earned Premium ÷ Limit</b>. <b>MDP%</b> is implied as <b>MDP ÷ Earned Premium</b>. Layer 1 deductible is pulled from NP treaty detail; subsequent deductibles auto-calculate as <b>prior deductible + prior limit</b>.</div>
              </section>

              {/* ═══ COB PARTICIPATION ═══ */}
              <section className="np-struct-card glass">
                <div className="np-struct-card-header np-struct-card-header--plain">
                  <div>
                    <div className="np-struct-card-h2">Classes of Business &amp; Layer Participation</div>
                    <div className="np-struct-card-hint">Underwriting limits are entered per class. Tick layers that participate for each class.</div>
                  </div>
                </div>
                <div className="np-table-wrap np-table-wrap--scroll">
                  <table className="np-struct-table np-struct-table--tight np-cob-table">
                    <thead>
                      <tr>
                        <th>CLASS OF BUSINESS</th>
                        <th>UNDERWRITING LIMIT</th>
                        {layers.map((_, i) => <th key={i} className="cell-center">LAYER {i + 1}</th>)}
                      </tr>
                    </thead>
                    <tbody>
                      {cobRows.map((r, ci) => (
                        <tr key={ci}>
                          <td>{r.name || '—'}</td>
                          <td><CommaInput value={r.underwritingLimit} onChange={v => updateCobRow(ci, 'underwritingLimit', v)} suffix={currency} /></td>
                          {layers.map((_, li) => (
                            <td key={li} className="cell-center">
                              <input type="checkbox" className="np-check" checked={!!(r.layers && r.layers[li])}
                                onChange={() => toggleCobLayer(ci, li)} />
                            </td>
                          ))}
                        </tr>
                      ))}
                      {cobRows.length === 0 && (
                        <tr><td colSpan={2 + layers.length} className="cell-center muted" style={{ padding: 20 }}>Select classes of business in NP treaty detail.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
                <div className="np-struct-footnote np-struct-footnote--right">Underwriting limits are captured per class. Participation checkboxes sync with layer COB selections.</div>
              </section>

              {/* ═══ PROPORTIONAL STRUCTURE COVERED ═══ */}
              <section className="np-struct-card glass">
                <div className="np-struct-card-header np-struct-card-header--plain">
                  <div>
                    <div className="np-struct-card-h2">Proportional Structure Covered</div>
                    <div className="np-struct-card-hint">If this treaty is written on a Net XL basis, summarise the underlying proportional programmes whose net are covered here.</div>
                  </div>
                </div>
                <div className="np-table-wrap np-table-wrap--scroll">
                  <table className="np-struct-table np-struct-table--wide">
                    <thead>
                      <tr>
                        <th className="np-col-prog">PROPORTIONAL PROGRAMME</th>
                        <th className="np-col-prog">QS LIMIT 100%</th>
                        <th className="np-col-prog">RETENTION %</th>
                        <th className="np-col-prog">RETENTION AMOUNT</th>
                        <th className="np-col-prog">SURPLUS LINES</th>
                        <th className="np-col-prog">TOTAL CAPACITY</th>
                      </tr>
                    </thead>
                    <tbody>
                      {!isNetXl ? (
                        <tr><td colSpan={6} className="np-muted cell-center" style={{ padding: 20 }}>Proportional structure is only required for Net XL treaties.</td></tr>
                      ) : coveredPropsCalc.map((r, i) => {
                        const cobOpts = cobOptions.length ? cobOptions : [];
                        return (
                          <tr key={i}>
                            <td>
                              <div className="np-cell-input">
                                <select className="np-mini-input np-mini-select" value={r.cobId || ''} onChange={e => updateCoveredProp(i, 'cobId', e.target.value)}>
                                  <option value="">Select…</option>
                                  {cobOpts.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                                </select>
                              </div>
                            </td>
                            <td><CommaInput value={r.qsLimit} onChange={v => updateCoveredProp(i, 'qsLimit', v)} suffix={currency} /></td>
                            <td className="cell-center"><PctInput value={r.retentionPct} onChange={v => updateCoveredProp(i, 'retentionPct', v)} /></td>
                            <td><CommaInput value={r.retentionAmount} readOnly suffix={currency} onChange={() => {}} /></td>
                            <td className="cell-center">
                              <div className="np-cell-input">
                                <input className="np-mini-input np-mini-input--center" inputMode="numeric" placeholder="0"
                                  value={r.surplusLines || ''} onChange={e => updateCoveredProp(i, 'surplusLines', e.target.value)} />
                              </div>
                            </td>
                            <td><CommaInput value={r.totalCapacity} readOnly suffix={currency} onChange={() => {}} /></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                <div className="np-struct-footnote np-struct-footnote--right">Populate only when treaty nature is Net XL; leave empty for Gross XL.</div>
              </section>

              {/* ═══ EXPIRING STRUCTURE & TERMS ═══ */}
              <section className="np-struct-card glass">
                <div className="np-struct-card-header np-struct-card-header--plain">
                  <div>
                    <div className="np-struct-card-h2">Expiring Structure &amp; Terms</div>
                    <div className="np-struct-card-hint">
                      {isRenewal
                        ? expiringAutoPopulated
                          ? '⟳ Auto-populated from prior year contract. Fields are read-only — click Override to edit manually.'
                          : '✓ Loaded from prior year contract. You may edit fields below.'
                        : 'New business — enter expiring market terms manually for YoY comparison in pricing metrics.'}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <button
                      className="np-green-pill"
                      style={{ fontSize: 11 }}
                      onClick={() => setShowExpCurveModal(true)}>
                      ◈ VIEW IMPLIED PRICING CURVE
                    </button>
                    {isRenewal && expiringAutoPopulated && (
                      <button
                        className="np-struct-btn np-struct-btn--ghost"
                        style={{ fontSize: 11 }}
                        onClick={() => setExpiringAutoPopulated(false)}>
                        Override
                      </button>
                    )}
                    <label style={{ fontSize: 12, color: 'rgba(226,232,240,0.45)', whiteSpace: 'nowrap' }}>
                      Layers
                    </label>
                    <span style={{ fontSize: 13, fontWeight: 600, color: 'rgba(226,232,240,0.75)', minWidth: 24, textAlign: 'center' }}>
                      {expiringLayerCount || '—'}
                    </span>
                  </div>
                </div>

                {/* Renewal auto-populate notice */}
                {isRenewal && expiringAutoPopulated && (
                  <div style={{ margin: '0 14px 10px', padding: '8px 12px', borderRadius: 10, background: 'rgba(34,211,238,0.08)', border: '1px solid rgba(34,211,238,0.25)', fontSize: 12, color: 'rgba(34,211,238,0.9)' }}>
                    ⟳ Expiring structure auto-loaded from prior year contract. Data is read-only. Click <b>Override</b> above to edit.
                  </div>
                )}

                {/* Expiring Terms — Brokerage, NCB, Profit Commission only */}
                <div style={{ display: 'grid', gridTemplateColumns: 'repeat(3, minmax(180px, 240px))', gap: 10, padding: '10px 14px 12px', borderBottom: '1px solid rgba(148,163,184,0.12)' }}>
                  {[
                    { k: 'brokerage_pct',          label: 'Brokerage %' },
                    { k: 'no_claims_bonus_pct',    label: 'NCB %' },
                    { k: 'profit_commission_pct',  label: 'Profit Comm. %' },
                  ].map(({ k, label }) => {
                    const locked = isRenewal && expiringAutoPopulated;
                    return (
                      <div key={k}>
                        <div style={{ fontSize: 11, color: 'rgba(226,232,240,0.55)', marginBottom: 4, textTransform: 'uppercase', letterSpacing: '0.1em' }}>{label}</div>
                        <input
                          className={`np-mini-input${locked ? ' np-mini-input--readonly' : ''}`}
                          value={expiringTerms[k] ?? ''}
                          placeholder="—"
                          readOnly={locked}
                          onChange={locked ? undefined : e => setExpiringTerms(p => ({ ...p, [k]: e.target.value }))} />
                      </div>
                    );
                  })}
                </div>

                                {/* Expiring Layers table */}
                <div className="np-table-wrap np-table-wrap--scroll np-table-wrap--wide">
                  <table className="np-struct-table np-struct-table--wide">
                    <thead>
                      <tr>
                        <th className="np-table-sticky cell-center">LAYER</th>
                        <th className="np-col">LIMIT</th>
                        <th className="np-col">DEDUCTIBLE / ATTACHMENT</th>
                        <th className="np-col">AGGREGATE LIMIT</th>
                        <th className="np-col">EGNPI</th>
                        <th className="np-col-rate" title="RATE = Earned Premium ÷ EGNPI (expressed as %). Enter e.g. 2.5 for 2.5% — NOT 0.025.">RATE</th>
                        <th className="np-col">EARNED PREMIUM</th>
                        <th className="np-col">MDP</th>
                        <th className="np-col-mdp-pct">MDP%</th>
                        <th className="np-col-reinst">NO. REINSTATEMENTS</th>
                        <th className="np-col-reinst">% REINSTATEMENTS</th>
                        <th className="np-col-chk">AAD</th>
                        <th className="np-col">AAD AMOUNT</th>
                        <th className="np-col-chk">RISK</th>
                        <th className="np-col-chk">CAT</th>
                        <th className="np-col-rol" title="ROL = Earned Premium ÷ Limit (Rate-on-Line, expressed as %). Auto-computed from Rate and Limit — displayed here, not editable.">ROL</th>
                      </tr>
                    </thead>
                    <tbody onPaste={handleExpiringPaste}>
                      {Array.from({ length: expiringLayerCount }, (_, i) => {
                        const locked = isRenewal && expiringAutoPopulated;
                        const emptyExp = { layer: i+1, limit:'', deductible:'', annualAggLimit:'', egnpi:'', earnedPremium:'', rate:'', mdp:'', mdpPct:'', reinstatements:'', reinstatementPct:'', aad:false, aadAmount:'', riskCover:true, catCover:true, rol:'', perilScope:'BOTH' };
                        const l = { ...emptyExp, ...(expiringLayers[i] || {}) };
                        const upd = locked ? () => {} : (field, val) => {
                          setExpiringLayers(prev => {
                            const next = [...prev];
                            while (next.length <= i) next.push({ ...emptyExp, layer: next.length + 1 });
                            next[i] = { ...next[i], [field]: val };
                            // Cascade deductibles + recompute earned/rol/mdpPct
                            return expiringRecalc(next);
                          });
                          dirty.current = true;
                        };
                        return (
                          <tr key={i} data-exp-row={i} style={locked ? { opacity: 0.8 } : undefined}>
                            <th className="np-table-sticky cell-center"><span className="np-layer-badge">L{i+1}</span></th>
                            <td><CommaInput value={l.limit} onChange={v => upd('limit', v)} suffix={currency} readOnly={locked} pasteField="limit" /></td>
                            <td><CommaInput value={l.deductible} onChange={i === 0 ? v => upd('deductible', v) : () => {}} readOnly={locked || i > 0} suffix={currency} /></td>
                            <td><CommaInput value={l.annualAggLimit} onChange={v => upd('annualAggLimit', v)} suffix={currency} readOnly={locked} pasteField="annualAggLimit" /></td>
                            <td><CommaInput value={l.egnpi} onChange={v => upd('egnpi', v)} suffix={currency} readOnly={locked} pasteField="egnpi" /></td>
                            <td className="cell-center np-col-rate"><RateInput value={l.rate} onChange={v => upd('rate', v)} readOnly={locked} pasteField="rate" /></td>
                            <td><CommaInput value={l.earnedPremium} readOnly suffix={currency} onChange={() => {}} /></td>
                            <td><CommaInput value={l.mdp} onChange={v => upd('mdp', v)} suffix={currency} readOnly={locked} pasteField="mdp" /></td>
                            <td className="cell-center np-col-mdp-pct"><PctInput className="np-mini-input np-mini-input--center np-mini-input--readonly" readOnly value={l.mdpPct || ''} onChange={() => {}} placeholder="—%" /></td>
                            <td className="cell-center np-col-reinst">
                              <div className="np-cell-input">
                                <select className="np-mini-input np-mini-input--center np-mini-select"
                                  value={l.reinstatements || ''} disabled={locked}
                                  onChange={locked ? undefined : e => upd('reinstatements', e.target.value)}>
                                  {reinstatementOptions.map(o => <option key={o.v} value={o.v}>{o.l}</option>)}
                                </select>
                              </div>
                            </td>
                            <td className="cell-center np-col-reinst"><PctInput value={l.reinstatementPct} onChange={v => upd('reinstatementPct', v)} readOnly={locked} pasteField="reinstatementPct" /></td>
                            <td className="np-col-chk cell-center"><input type="checkbox" className="np-check" checked={!!l.aad} disabled={locked} onChange={locked ? undefined : e => upd('aad', e.target.checked)} /></td>
                            <td><CommaInput value={l.aadAmount} onChange={v => upd('aadAmount', v)} suffix={currency} disabled={!l.aad || locked} readOnly={locked} /></td>
                            <td className="np-col-chk cell-center"><input type="checkbox" className="np-check" checked={!!l.riskCover} disabled={locked} onChange={locked ? undefined : e => upd('riskCover', e.target.checked)} /></td>
                            <td className="np-col-chk cell-center"><input type="checkbox" className="np-check" checked={!!l.catCover} disabled={locked} onChange={locked ? undefined : e => upd('catCover', e.target.checked)} /></td>
                            <td className="cell-center np-col-rol"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center np-mini-input--readonly" readOnly value={l.rol || ''} placeholder="—" /></div></td>
                          </tr>
                        );
                      })}
                    </tbody>
                    {/* Totals row */}
                    {expiringLayerCount > 0 && (() => {
                      const visLayers    = Array.from({ length: expiringLayerCount }, (_, i) => ({ ...{ limit:'', deductible:'', annualAggLimit:'', egnpi:'', earnedPremium:'', rate:'', mdp:'' }, ...(expiringLayers[i] || {}) }));
                      const totLimit     = visLayers.reduce((s,l) => s + toNum(l.limit), 0);
                      const firstDed     = toNum(visLayers[0]?.deductible);
                      const totAgg       = visLayers.reduce((s,l) => s + toNum(l.annualAggLimit), 0);
                      const totEgnpi     = Math.max(0, ...visLayers.map(l => toNum(l.egnpi)));
                      const totRate      = visLayers.reduce((s,l) => s + rateToFloat(l.rate), 0);
                      const totEP        = visLayers.reduce((s,l) => s + toNum(l.earnedPremium), 0);
                      const totMdp       = visLayers.reduce((s,l) => s + toNum(l.mdp), 0);
                      const totMdpPct    = totEP > 0 && totMdp > 0 ? fmtPctMaybe(totMdp / totEP) : '';
                      // ROL total = SUMPRODUCT(rate% × EGNPI) / totalLimit
                      const totRolNum    = visLayers.reduce((s,l) => s + rateToFloat(l.rate) / 100 * toNum(l.egnpi), 0);
                      const totRol       = totLimit > 0 && totRolNum > 0
                        ? fmtPctMaybe(totRolNum / totLimit)
                        : totLimit > 0 && totEP > 0 ? fmtPctMaybe(totEP / totLimit) : '';
                      const maxReinst    = visLayers.reduce((max,l) => {
                        if (l.reinstatements === 'UNLIMITED') return 'UNLIMITED';
                        const n = parseInt(l.reinstatements, 10);
                        return Number.isFinite(n) && n > (typeof max === 'number' ? max : 0) ? n : max;
                      }, 0);
                      const maxReinstLabel = maxReinst === 'UNLIMITED' ? 'Unlimited' : maxReinst > 0 ? String(maxReinst) : '';
                      return (
                        <tfoot>
                          <tr style={{ borderTop: '2px solid rgba(0,212,255,0.45)', background: 'rgba(0,212,255,0.06)' }}>
                            <th className="np-table-sticky cell-center" style={{ color: '#00d4ff', fontSize: 10, letterSpacing: '.08em', fontWeight: 800, background: 'rgba(0,212,255,0.08)' }}>TOTAL</th>
                            <td><CommaInput value={totLimit ? String(totLimit) : ''} readOnly suffix={currency} onChange={() => {}} /></td>
                            <td><CommaInput value={firstDed ? String(firstDed) : ''} readOnly suffix={currency} onChange={() => {}} /></td>
                            <td><CommaInput value={totAgg ? String(totAgg) : ''} readOnly suffix={currency} onChange={() => {}} /></td>
                            <td><CommaInput value={totEgnpi ? String(totEgnpi) : ''} readOnly suffix={currency} onChange={() => {}} /></td>
                            <td className="cell-center np-col-rate"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center np-mini-input--readonly" readOnly value={totRate > 0 ? `${parseFloat(totRate.toFixed(4))}%` : ''} placeholder="—" /></div></td>
                            <td><CommaInput value={totEP ? String(totEP) : ''} readOnly suffix={currency} onChange={() => {}} /></td>
                            <td><CommaInput value={totMdp ? String(totMdp) : ''} readOnly suffix={currency} onChange={() => {}} /></td>
                            <td className="cell-center np-col-mdp-pct"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center np-mini-input--readonly" readOnly value={totMdpPct} placeholder="—" /></div></td>
                            <td className="cell-center np-col-reinst"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center np-mini-input--readonly" readOnly value={maxReinstLabel} placeholder="—" /></div></td>
                            <td></td>
                            <td></td>
                            <td></td>
                            <td></td>
                            <td></td>
                            <td className="cell-center np-col-rol"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center np-mini-input--readonly" readOnly value={totRol} placeholder="—" style={{ borderColor: 'rgba(0,212,255,0.55)', borderWidth: totRol ? 2 : 1 }} /></div></td>
                          </tr>
                        </tfoot>
                      );
                    })()}
                  </table>
                </div>
                <div className="np-struct-footnote np-struct-footnote--right">Expiring structure is used to auto-populate year-on-year metrics in Final Pricing.</div>
              </section>

              {/* ── Expiring Structure Implied Pricing Curve Modal (prototype: fitPowerCurve) ── */}
              {showExpCurveModal && (() => {
                const eps = 1e-9;

                // ── Prototype fitPowerCurve: y = a * x^b, 1D search over b ──
                const fitPowerCurve = (points) => {
                  const pts = (points || [])
                    .map(p => ({ x: Math.max(eps, Number(p.x) || 0), y: Math.max(eps, Number(p.y) || 0) }))
                    .filter(p => p.x > 0 && p.y > 0 && Number.isFinite(p.x) && Number.isFinite(p.y));
                  if (pts.length < 2) return null;
                  const sseForB = b => {
                    let num = 0, den = 0;
                    for (const p of pts) {
                      const xb = Math.pow(p.x, b);
                      if (!Number.isFinite(xb)) return { sse: Infinity, a: NaN };
                      num += p.y * xb; den += xb * xb;
                    }
                    if (!den) return { sse: Infinity, a: NaN };
                    const a = num / den;
                    if (!Number.isFinite(a) || a <= 0) return { sse: Infinity, a };
                    let sse = 0;
                    for (const p of pts) { const e = p.y - a * Math.pow(p.x, b); sse += e * e; }
                    return { sse, a };
                  };
                  let best = { sse: Infinity, a: NaN, b: NaN };
                  for (let b = -6; b <= 6; b += 0.1) {
                    const r = sseForB(b);
                    if (r.sse < best.sse) best = { sse: r.sse, a: r.a, b };
                  }
                  if (!Number.isFinite(best.sse) || best.sse === Infinity) return null;
                  let b0 = best.b;
                  for (let step = 0.05; step >= 0.002; step /= 2) {
                    let lb = best;
                    for (let b = b0 - 0.2; b <= b0 + 0.2; b += step) {
                      const r = sseForB(b);
                      if (r.sse < lb.sse) lb = { sse: r.sse, a: r.a, b };
                    }
                    best = lb; b0 = best.b;
                  }
                  return (Number.isFinite(best.a) && Number.isFinite(best.b) && best.a > 0)
                    ? { a: best.a, b: best.b } : null;
                };

                const r2ForPower = (pts, model) => {
                  if (!model || pts.length < 2) return NaN;
                  const meanY = pts.reduce((s, p) => s + p.y, 0) / pts.length;
                  let ssTot = 0, ssRes = 0;
                  for (const p of pts) {
                    const yhat = model.a * Math.pow(Math.max(1e-6, p.x), model.b);
                    ssTot += (p.y - meanY) ** 2;
                    ssRes += (p.y - yhat) ** 2;
                  }
                  const r2 = 1 - ssRes / ssTot;
                  return Number.isFinite(r2) ? r2 : NaN;
                };

                // ── Build points: x = √((Att+Lim)×Att) / EGNPI, y = ROL as fraction ──
                const expLys = Array.from({ length: expiringLayerCount }, (_, i) => ({
                  layer: i + 1,
                  limit: '', deductible: '', egnpi: '', earnedPremium: '', rate: '', rol: '',
                  ...(expiringLayers[i] || {}),
                }));
                const egnpiOverall = Math.max(0, ...expLys.map(l => toNum(l.egnpi)).filter(n => n > 0));
                const pts = egnpiOverall > 0 ? expLys.map(l => {
                  const ded = toNum(l.deductible ?? l.attachment);
                  const lim = toNum(l.limit);
                  if (ded <= 0 || lim <= 0) return null;
                  const top = ded + lim;
                  const epN = toNum(l.earnedPremium);
                  const rolRaw = parseFloat(String(l.rol || l.rate || '').replace(/%/g, '')) || 0;
                  const rol01 = (lim > 0 && epN > 0) ? epN / lim : rolRaw / 100;
                  if (!rol01 || rol01 <= 0) return null;
                  const x = Math.sqrt(top * ded) / egnpiOverall;
                  return (Number.isFinite(x) && x > 0) ? { x, y: rol01, layer: l.layer } : null;
                }).filter(Boolean) : [];

                const model = fitPowerCurve(pts);
                const r2 = r2ForPower(pts, model);

                // ── SVG rendering ──
                const renderSVG = () => {
                  if (pts.length < 2 || !model) return null;
                  const W = 860, H = 300, padL = 54, padR = 18, padT = 24, padB = 38;
                  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
                  const x0 = Math.max(0, Math.min(...xs) * 0.85);
                  const x1 = Math.max(...xs) * 1.15;
                  const y0 = Math.max(0, Math.min(...ys) * 0.85);
                  const y1 = Math.max(...ys) * 1.15;
                  const sx = x => padL + ((x - x0) / (x1 - x0 || 1)) * (W - padL - padR);
                  const sy = y => H - padB - ((y - y0) / (y1 - y0 || 1)) * (H - padT - padB);
                  let pathD = '';
                  for (let i = 0; i <= 80; i++) {
                    const x = x0 + (i / 80) * (x1 - x0);
                    const y = model.a * Math.pow(Math.max(eps, x), model.b);
                    pathD += `${i === 0 ? 'M' : 'L'}${sx(x).toFixed(2)},${sy(y).toFixed(2)}`;
                  }
                  const label = `ROL = ${(model.a * 100).toFixed(4)}% × x^${model.b.toFixed(4)}${Number.isFinite(r2) ? `  |  R² = ${r2.toFixed(3)}` : ''}`;
                  return (
                    <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" className="crisp-grid" style={{ display: 'block', fontFamily: 'inherit', fontVariantNumeric: 'tabular-nums' }} role="img" aria-label="Implied power curve">
                      <line x1={padL} y1={padT} x2={padL} y2={H - padB} stroke="rgba(255,255,255,0.30)" shapeRendering="crispEdges" vectorEffect="non-scaling-stroke" />
                      <line x1={padL} y1={H - padB} x2={W - padR} y2={H - padB} stroke="rgba(255,255,255,0.30)" shapeRendering="crispEdges" vectorEffect="non-scaling-stroke" />
                      <text x={padL + 6} y={padT + 14} fontSize={12} fontWeight="600" fill="rgba(255,255,255,0.85)">{label}</text>
                      <path d={pathD} fill="none" stroke="var(--accent, #3b82f6)" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" opacity={0.95} vectorEffect="non-scaling-stroke" />
                      {pts.map((p, i) => (
                        <g key={i}>
                          <circle cx={sx(p.x).toFixed(2)} cy={sy(p.y).toFixed(2)} r={4} fill="var(--accent, #3b82f6)" opacity={0.95} />
                          <text x={+sx(p.x).toFixed(2) + 6} y={+sy(p.y).toFixed(2) + 4} fontSize={10} fontWeight="500" fill="rgba(255,255,255,0.75)">L{p.layer}</text>
                        </g>
                      ))}
                      <text x={padL} y={H - 8} fontSize={11} fontWeight="500" fill="rgba(255,255,255,0.65)">x = √((Att+Lim)×Att) / EGNPI</text>
                      <text x={10} y={padT + 4} fontSize={11} fontWeight="500" fill="rgba(255,255,255,0.65)">ROL</text>
                    </svg>
                  );
                };

                return (
                  <div
                    className="modal-backdrop"
                    style={{ position: 'fixed', inset: 0, zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.65)' }}
                    onClick={e => { if (e.target === e.currentTarget) setShowExpCurveModal(false); }}>
                    <div className="glass" role="dialog" aria-modal="true" style={{ background: 'var(--glass-bg, #0d1117)', border: '1px solid rgba(0,212,255,0.25)', borderRadius: 12, width: '92vw', maxWidth: 1000, maxHeight: '80vh', display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                        <div>
                          <div style={{ fontWeight: 800, fontSize: 14, letterSpacing: '.06em', color: '#e2e8f0' }}>IMPLIED PRICING CURVE</div>
                          <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', marginTop: 2 }}>
                            Fitted from expiring layer attachments and tops. Requires at least two expiring layers with EGNPI and ROL.
                          </div>
                        </div>
                        <button
                          type="button"
                          onClick={() => setShowExpCurveModal(false)}
                          aria-label="Close"
                          style={{ background: 'none', border: '1px solid rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.6)', borderRadius: 6, padding: '4px 12px', cursor: 'pointer', fontSize: 13 }}>
                          ✕ Close
                        </button>
                      </div>
                      <div style={{ overflowY: 'auto', padding: '16px 20px', flex: 1 }}>
                        {pts.length < 2 ? (
                          <p style={{ color: 'rgba(255,255,255,0.4)', textAlign: 'center', padding: 32 }}>
                            Enter Limit, Deductible, EGNPI and ROL (or Rate) for at least two expiring layers to display the implied power curve.
                          </p>
                        ) : !model ? (
                          <p style={{ color: 'rgba(255,255,255,0.4)', textAlign: 'center', padding: 32 }}>
                            Unable to fit a curve from the current layer points.
                          </p>
                        ) : (
                          <>
                            {renderSVG()}
                            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.32)', marginTop: 12, borderTop: '1px solid rgba(255,255,255,0.07)', paddingTop: 10 }}>
                              Model: ROL = a × x^b &nbsp;|&nbsp; x = √((Attachment + Limit) × Attachment) / EGNPI &nbsp;|&nbsp; Fitted by least-squares search over b ∈ [−6, 6].
                              {Number.isFinite(r2) && <span style={{ marginLeft: 16 }}>R² = {r2.toFixed(3)}</span>}
                            </div>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })()}

              {/* ═══ EXPIRING PROPORTIONAL COVERED ═══ */}
              <section className="np-struct-card glass">
                <div className="np-struct-card-header np-struct-card-header--plain">
                  <div>
                    <div className="np-struct-card-h2">Expiring Proportional Structure Covered</div>
                    <div className="np-struct-card-hint">Prior year underlying proportional programmes covered under this Net XL treaty.</div>
                  </div>
                </div>
                <div className="np-table-wrap np-table-wrap--scroll">
                  <table className="np-struct-table np-struct-table--wide">
                    <thead>
                      <tr>
                        <th className="np-col-prog">PROPORTIONAL PROGRAMME</th>
                        <th className="np-col-prog">QS LIMIT 100%</th>
                        <th className="np-col-prog">RETENTION %</th>
                        <th className="np-col-prog">RETENTION AMOUNT</th>
                        <th className="np-col-prog">SURPLUS LINES</th>
                        <th className="np-col-prog">TOTAL CAPACITY</th>
                      </tr>
                    </thead>
                    <tbody>
                      {!isNetXl ? (
                        <tr><td colSpan={6} className="np-muted cell-center" style={{ padding: 20 }}>Only required for Net XL treaties.</td></tr>
                      ) : expiringCoveredPropsCalc.map((r, i) => {
                        const locked = isRenewal && expiringAutoPopulated;
                        const cobOpts = cobOptions.length ? cobOptions : [];
                        return (
                          <tr key={i}>
                            <td>
                              <div className="np-cell-input">
                                <select className="np-mini-input np-mini-select" value={r.cobId || ''} disabled={locked}
                                  onChange={locked ? undefined : e => updateExpiringCoveredProp(i, 'cobId', e.target.value)}>
                                  <option value="">Select…</option>
                                  {cobOpts.map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
                                </select>
                              </div>
                            </td>
                            <td><CommaInput value={r.qsLimit} onChange={v => updateExpiringCoveredProp(i, 'qsLimit', v)} suffix={currency} readOnly={locked} /></td>
                            <td className="cell-center"><PctInput value={r.retentionPct} onChange={v => updateExpiringCoveredProp(i, 'retentionPct', v)} readOnly={locked} /></td>
                            <td><CommaInput value={r.retentionAmount} readOnly suffix={currency} onChange={() => {}} /></td>
                            <td className="cell-center">
                              <div className="np-cell-input">
                                <input className={`np-mini-input np-mini-input--center${locked ? ' np-mini-input--readonly' : ''}`} inputMode="numeric" placeholder="0"
                                  value={r.surplusLines || ''} readOnly={locked}
                                  onChange={locked ? undefined : e => updateExpiringCoveredProp(i, 'surplusLines', e.target.value)} />
                              </div>
                            </td>
                            <td><CommaInput value={r.totalCapacity} readOnly suffix={currency} onChange={() => {}} /></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
                {isNetXl && !isRenewal && (
                  <div style={{ padding: '8px 14px', display: 'flex', gap: 8 }}>
                    <button className="np-struct-btn" onClick={() => setExpiringCoveredProps(p => [...p, emptyCoveredProp()])}>+ Add Row</button>
                    {expiringCoveredProps.length > 1 && (
                      <button className="np-struct-btn" onClick={() => setExpiringCoveredProps(p => p.slice(0,-1))}>− Remove</button>
                    )}
                  </div>
                )}
                <div className="np-struct-footnote np-struct-footnote--right">Expiring proportional covered — leave empty for Gross XL.</div>
              </section>
              </>
              )}
            </>
          )}
        </div>
      )}
    </WizardLayout>
  );
}
