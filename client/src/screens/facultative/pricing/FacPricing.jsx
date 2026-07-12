// src/screens/facultative/pricing/FacPricing.jsx
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import api from '../../../api';
import WizardLayout from '../../../components/WizardLayout';
import AsyncBoundary from '../../../components/AsyncBoundary';
import PctInput from '../../../components/PctInput';
import { useFacRiskId } from '../../../hooks/useContractId';
import { useEditLock } from '../../../hooks/useEditLock';
import EditLockBanner, { ReadOnlyWrap } from '../../../components/EditLockBanner.jsx';
import { useResource } from '../../../hooks/useResource';
import { useGlobalToast } from '../../../hooks/useToast';
import { isReadOnlyError } from '../../../utils/readOnlyError';
import { computeFacQuote } from '../../../logic/facPropertyPricing';
import { logger } from '../../../utils/logger';
import { UwFactorsPanel, EngineReadout } from './FacPricingPanels';

const ENGINE_VERSION = '1.0.0';

const ROUTE_KEY = 'FAC_PRICING';

// Canonical shape of the manual dual-engine pricing fields. Hydration
// merges the persisted row over THESE defaults (never over live state),
// so loading is a one-shot per risk and user edits can't re-trigger it.
const F_DEFAULTS = {
  market_rate_per_mille: '', market_premium: '', market_source: '',
  actuarial_method: '', actuarial_rate_per_mille: '', actuarial_premium: '',
  expected_loss_ratio: '', loss_cost: '', loading_pct: '',
  market_weight_pct: '50', actuarial_weight_pct: '50',
  blended_rate_per_mille: '', blended_premium: '',
  final_rate_per_mille: '', final_premium: '',
  uw_adjustment_pct: '0', uw_adjustment_reason: '',
  burning_cost_ratio: '', avg_loss_years: '5',
};
const numOrNull = v => { const c = String(v ?? '').replace(/,/g,'').trim(); if (!c) return null; const n = Number(c); return Number.isFinite(n) ? n : null; };
const cleanNum = v => { if (v == null || v === '') return ''; const n = Number(v); if (!Number.isFinite(n)) return String(v); return n === Math.floor(n) ? String(Math.floor(n)) : String(n); };
const fmtN = v => { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—'; };

function FR({ label, children, hint }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 10, alignItems: 'center', minHeight: 36 }}>
      <div>
        <div style={{ fontSize: 12, color: 'rgba(var(--text-rgb),0.7)' }}>{label}</div>
        {hint && <div style={{ fontSize: 10, color: 'rgba(var(--text-rgb),0.58)', marginTop: 1 }}>{hint}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}
function Sec({ title, color, children }) {
  return <>
    <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase', color: color || 'rgba(var(--accent-blue-rgb),0.75)', marginTop: 28, marginBottom: 12, paddingBottom: 6, borderBottom: '1px solid var(--hairline)' }}>{title}</div>
    {children}
  </>;
}

const CATEGORY_COLORS = {
  PROPERTY: '#23d18b', ENGINEERING: '#fbbf24', MARINE: '#0ea5e9',
  CASUALTY: '#a855f7', CYBER: '#f87171', ENERGY: '#f97316',
};

// ── Extensions library by category ──
const EXTENSIONS_BY_CATEGORY = {
  PROPERTY: [
    { id: 'natcat_eq',    label: 'Earthquake',                   loadingPct: 15 },
    { id: 'natcat_flood', label: 'Flood',                        loadingPct: 10 },
    { id: 'natcat_storm', label: 'Windstorm / Typhoon',          loadingPct: 12 },
    { id: 'bi_ext',       label: 'Business Interruption',        loadingPct: 8 },
    { id: 'terrorism',    label: 'Terrorism',                    loadingPct: 5 },
    { id: 'riots',        label: 'Strikes, Riots & Civil Commotion (SRCC)', loadingPct: 4 },
    { id: 'malicious',    label: 'Malicious Damage',             loadingPct: 3 },
    { id: 'spontaneous',  label: 'Spontaneous Combustion',       loadingPct: 6 },
    { id: 'subsidence',   label: 'Subsidence & Landslide',       loadingPct: 5 },
    { id: 'waiver_sub',   label: 'Waiver of Subrogation',        loadingPct: 2 },
    { id: 'debris',       label: 'Debris Removal',               loadingPct: 1 },
    { id: 'architects',   label: 'Architects & Surveyors Fees',  loadingPct: 1 },
  ],
  ENGINEERING: [
    { id: 'testing',      label: 'Testing & Commissioning',      loadingPct: 10 },
    { id: 'maint_visit',  label: 'Maintenance Visits',           loadingPct: 5 },
    { id: 'cross_liab',   label: 'Cross Liability (Section II)', loadingPct: 8 },
    { id: 'alop',         label: 'ALoP / DSU',                   loadingPct: 12 },
    { id: 'defects',      label: 'Defects Liability Period',     loadingPct: 6 },
    { id: 'offsite',      label: 'Offsite Storage',              loadingPct: 3 },
    { id: 'natcat_eq_e',  label: 'Earthquake',                   loadingPct: 15 },
    { id: 'natcat_flood_e',label: 'Flood',                       loadingPct: 10 },
    { id: 'terrorism_e',  label: 'Terrorism',                    loadingPct: 5 },
  ],
  MARINE: [
    { id: 'war',          label: 'War & Strikes',                loadingPct: 20 },
    { id: 'piracy',       label: 'Piracy',                       loadingPct: 8 },
    { id: 'rdc',          label: 'Running Down Clause (RDC)',     loadingPct: 5 },
    { id: 'salvage',      label: 'Sue & Labour',                 loadingPct: 3 },
    { id: 'ga',           label: 'General Average',              loadingPct: 4 },
    { id: 'pollution_m',  label: 'Pollution Liability',          loadingPct: 10 },
    { id: 'tranship',     label: 'Transhipment',                 loadingPct: 3 },
  ],
  CASUALTY: [
    { id: 'products',     label: 'Products Liability',           loadingPct: 12 },
    { id: 'employers',    label: 'Employers Liability',          loadingPct: 8 },
    { id: 'public_liab',  label: 'Public Liability',             loadingPct: 6 },
    { id: 'prof_indem',   label: 'Professional Indemnity',       loadingPct: 10 },
    { id: 'pollution_c',  label: 'Pollution Liability',          loadingPct: 15 },
    { id: 'recall',       label: 'Product Recall',               loadingPct: 12 },
    { id: 'retroactive',  label: 'Retroactive Cover',            loadingPct: 8 },
    { id: 'defence_costs',label: 'Defence Costs in Addition',    loadingPct: 5 },
  ],
  CYBER: [
    { id: 'ransomware',   label: 'Ransomware / Extortion',       loadingPct: 20 },
    { id: 'data_breach',  label: 'Data Breach Response',         loadingPct: 10 },
    { id: 'bi_cyber',     label: 'Business Interruption (Cyber)',loadingPct: 15 },
    { id: 'regulatory',   label: 'Regulatory Fines & Penalties', loadingPct: 8 },
    { id: 'media_liab',   label: 'Media Liability',              loadingPct: 5 },
    { id: 'social_eng',   label: 'Social Engineering Fraud',     loadingPct: 12 },
    { id: 'sys_failure',  label: 'System Failure (non-cyber)',   loadingPct: 10 },
  ],
  ENERGY: [
    { id: 'natcat_eq_en', label: 'Earthquake',                   loadingPct: 15 },
    { id: 'natcat_flood_en',label: 'Flood',                      loadingPct: 10 },
    { id: 'natcat_storm_en',label: 'Windstorm',                  loadingPct: 12 },
    { id: 'bi_energy',    label: 'Business Interruption',        loadingPct: 10 },
    { id: 'oee',          label: 'Operators Extra Expense (OEE)',loadingPct: 6 },
    { id: 'pollution_en', label: 'Pollution / Clean-up',         loadingPct: 15 },
    { id: 'control_well', label: 'Control of Well',              loadingPct: 12 },
    { id: 'terrorism_en', label: 'Terrorism',                    loadingPct: 5 },
  ],
};

// ───────────────────────────────────────────────────────────────────────────
// Underwriting factors panel — independent entity (fac_underwriting_factors),
// independent save. Lives at the top of the pricing screen because the
// 18 selections drive both the rate adjustment and the underwriting score
// the rest of the screen reasons about.
// ───────────────────────────────────────────────────────────────────────────

export default function FacPricing() {
  const riskId = useFacRiskId();
  const { readOnly, assignedToName: lockAssignedToName, refresh: refreshLock, markReadOnly } = useEditLock({ facRiskId: riskId });
  const showToast = useGlobalToast();
  const loaded = useRef(false);
  const dirty = useRef(false);
  const [risk, setRisk] = useState(null);
  const [facClasses, setFacClasses] = useState([]);
  const [selectedExtensions, setSelectedExtensions] = useState(new Set());
  const [customExtensions, setCustomExtensions] = useState([]); // { id, label, loadingPct }
  const [newExtLabel, setNewExtLabel] = useState('');
  const [newExtLoading, setNewExtLoading] = useState('');

  const [f, setF] = useState(F_DEFAULTS);

  // ── Engine inputs (computeFacQuote) ──────────────────────────────
  // The five user-controlled fields below feed straight into the engine
  // along with the UW factor selections (panel) and the locations'
  // SI / FX figures. Fractions are stored as 0..1 to match the column
  // conventions; the UI converts on display.
  const [eng, setEng] = useState({
    indemnity_months: '12',
    commission_pct: '0.20',
    margin_pct: '0.05',
    other_expenses_pct: '0.005',
    market_rate_pm: '',
    extra_cover_loadings: [],
    _newLabel: '',
    _newPct: '',
  });
  const setEngField = useCallback((key, val) => {
    setEng((prev) => ({ ...prev, [key]: val }));
    dirty.current = true;
  }, []);
  const removeExtraCover = (i) => {
    const next = [...eng.extra_cover_loadings];
    next.splice(i, 1);
    setEngField('extra_cover_loadings', next);
  };

  // Reference catalogues — every engine input flows through these.
  const [occupancies, setOccupancies]     = useState([]);
  const [factors, setFactors]             = useState([]);
  const [factorWeights, setFactorWeights] = useState(null);
  const [scoringTables, setScoringTables] = useState(null);
  const [biIndemnity, setBiIndemnity]     = useState({});
  const [natcatRates, setNatcatRates]     = useState([]);
  // UW factor selections mirrored up from UwFactorsPanel so the engine
  // recomputes the second a dropdown changes — no API round-trip.
  const [uwSelections, setUwSelections] = useState({});
  // Locations drive pd_si_share, total SAR, top-location SAR.
  const [locations, setLocations] = useState([]);
  const [engineOutput, setEngineOutput] = useState(null);

  // Single-fetch reference loaders. CACHEABLE_PATHS in api.js dedupes
  // these across the wizard, so navigating away and back is free.
  useEffect(() => {
    Promise.all([
      api.facGetOccupancies(),
      api.facGetFactors(),
      api.facGetFactorWeights(),
      api.facGetScoringTables(),
      api.facGetBiIndemnity(),
      api.facGetNatcatRates(),
    ]).then(([occ, fac, fw, st, bi, nc]) => {
      setOccupancies(occ?.occupancies || []);
      setFactors(fac?.factors || []);
      setFactorWeights(fw?.schemes || null);
      setScoringTables(st || null);
      setBiIndemnity(bi?.loadings || {});
      setNatcatRates(nc?.rates || []);
    }).catch(logger.error);
  }, []);

  // Locations — used for pd_si_share / top-location lookups.
  useEffect(() => {
    if (!riskId) return;
    api.facGetLocations(riskId).then((rows) => setLocations(rows || [])).catch(logger.error);
  }, [riskId]);

  // Load risk + pricing + fac classes — one shot per risk. Hydration runs
  // inside the fetcher (useResource owns loading/error/abort), merging the
  // persisted row over F_DEFAULTS so a user edit can never re-trigger the
  // load (the old [f, riskId] dependency silently wiped the dirty flag on
  // every edit and refetch-looped on persisted rows — see
  // docs/frontend-hardening.md, FacPricing findings).
  const pricingLoad = useResource(
    async (signal) => {
      loaded.current = false;
      const [r, p, fc] = await Promise.all([
        api.facGetRisk(riskId, { signal }),
        api.facGetPricing(riskId, { signal }),
        api.facListClasses({ signal }),
      ]);
      if (signal.aborted) return { r, p, fc };
      setRisk(r);
      setFacClasses(fc || []);
      if (p) {
        const o = {};
        for (const k of Object.keys(F_DEFAULTS)) o[k] = cleanNum(p[k]) || (typeof F_DEFAULTS[k] === 'string' ? (p[k] || '') : F_DEFAULTS[k]);
        setF(o);
        // Rehydrate extension selections from ui_state JSONB
        const ui = p.ui_state || {};
        if (Array.isArray(ui.selectedExtensions)) setSelectedExtensions(new Set(ui.selectedExtensions));
        if (Array.isArray(ui.customExtensions))   setCustomExtensions(ui.customExtensions);
        // Rehydrate engine inputs from the persisted pricing row.
        setEng((prev) => ({
          ...prev,
          indemnity_months:   p.indemnity_months   != null ? String(p.indemnity_months)   : prev.indemnity_months,
          commission_pct:     p.commission_pct     != null ? String(p.commission_pct)     : prev.commission_pct,
          margin_pct:         p.margin_pct         != null ? String(p.margin_pct)         : prev.margin_pct,
          other_expenses_pct: p.other_expenses_pct != null ? String(p.other_expenses_pct) : prev.other_expenses_pct,
          market_rate_pm:     p.market_rate_pm     != null ? String(p.market_rate_pm)     : prev.market_rate_pm,
          extra_cover_loadings: Array.isArray(p.extra_cover_loadings) ? p.extra_cover_loadings : prev.extra_cover_loadings,
        }));
      }
      loaded.current = true; dirty.current = false;
      return { r, p, fc };
    },
    [riskId],
    { enabled: !!riskId, reportLabel: 'fac pricing' },
  );

  const set = (k, v) => { setF(prev => ({ ...prev, [k]: v })); dirty.current = true; };
  const tsi = numOrNull(risk?.total_sum_insured) || 0;

  // ── Derived inputs the engine needs but the user doesn't type ────────
  // pd_si_share: share of total SAR SI sitting in Material Damage.
  // bi_included: any positive BI exposure on the risk or its locations.
  // top_location_si_sar: largest single-location combined SAR SI.
  const { pdSiShare, biIncludedGlobal, topLocationSiSar, totalLocSar } = useMemo(() => {
    let pdSar = 0, biSar = 0, topSar = 0;
    for (const l of locations) {
      const pd = Number(l.pd_si) || 0;
      const bi = Number(l.bi_si) || 0;
      pdSar += pd; biSar += bi;
      if (pd + bi > topSar) topSar = pd + bi;
    }
    const total = pdSar + biSar;
    const share = total > 0 ? pdSar / total : 1;
    const biFromRisk = Number(risk?.bi_sum_insured) || 0;
    return {
      pdSiShare: share,
      biIncludedGlobal: biSar > 0 || biFromRisk > 0,
      topLocationSiSar: topSar,
      totalLocSar: total,
    };
  }, [locations, risk]);

  // ── Debounced engine recompute (150ms) ───────────────────────────
  // The engine is pure JS — debouncing only smooths a fast-typing user;
  // there is no network round-trip behind it. Recompute fires whenever
  // any of the engine inputs change.
  useEffect(() => {
    if (!risk || !occupancies.length || !factors.length || !factorWeights || !scoringTables) {
      setEngineOutput(null);
      return undefined;
    }
    const handle = setTimeout(() => {
      try {
        const inputs = {
          occupancy_code: risk.occupancy_code,
          country_zone:   risk.risk_country_zone,
          region:         risk.cedant_region,
          factor_selections: uwSelections,
          pd_si_share_pct: pdSiShare,
          indemnity_months: numOrNull(eng.indemnity_months) || 12,
          commission_pct:   numOrNull(eng.commission_pct),
          margin_pct:       numOrNull(eng.margin_pct),
          other_expenses_pct: numOrNull(eng.other_expenses_pct),
          extra_cover_loadings: (eng.extra_cover_loadings || [])
            .map((x) => Number(x.pct))
            .filter((n) => Number.isFinite(n)),
          bi_included: biIncludedGlobal,
          market_rate_pm: numOrNull(eng.market_rate_pm),
          top_location_si_sar: topLocationSiSar || tsi || null,
        };
        const refData = {
          occupancies, factors,
          factorWeights,
          hazardGradeScore:     scoringTables.hazard_grade,
          frequencyScore:       scoringTables.frequency,
          capacityBands:        scoringTables.capacity_bands,
          territorialCapacity:  scoringTables.territorial_capacity,
          biIndemnity, natcatRates,
        };
        const out = computeFacQuote(inputs, refData);
        setEngineOutput(out);
      } catch (err) {
        // Surface the problem in-panel rather than swallowing it; the
        // most common cause is a missing risk_country_zone before the
        // underwriter has filled out the Risk Detail screen.
        setEngineOutput({ _error: true, warnings: [String(err?.message || err)] });
      }
    }, 150);
    return () => clearTimeout(handle);
  }, [
    risk, occupancies, factors, factorWeights, scoringTables, biIndemnity, natcatRates,
    uwSelections, eng, pdSiShare, biIncludedGlobal, topLocationSiSar, tsi,
  ]);

  // ── Engine premiums (derived from engine output + total SI) ─────────
  // We can't ask the engine for premiums directly — it returns rates
  // per mille. Multiply by SAR SI here so the persisted snapshot
  // contains the SAR figures the underwriter actually quoted.
  const enginePremiums = useMemo(() => {
    if (!engineOutput || engineOutput._error) return { technical: null, expected: null };
    const siSar = totalLocSar || tsi || 0;
    const tech = engineOutput.technical_rate_no_natcat_pm != null
      ? (engineOutput.technical_rate_no_natcat_pm * siSar) / 1000 : null;
    const exp = engineOutput.final_gross_rate_pm != null
      ? (engineOutput.final_gross_rate_pm * siSar) / 1000 : null;
    return { technical: tech, expected: exp };
  }, [engineOutput, totalLocSar, tsi]);

  // Determine which categories are active from the risk's selected COBs
  // The risk stores fac_cob_id (primary) and cob_category, but we need all selected categories
  // Read from the risk's cob_category + check if there are multiple via the fac_cob_id
  const activeCategories = useMemo(() => {
    if (!risk) return new Set();
    const cats = new Set();
    // Primary COB category from risk
    if (risk.cob_category) cats.add(risk.cob_category);
    // Also derive from fac_cob_id
    if (risk.fac_cob_id && facClasses.length) {
      const cls = facClasses.find(c => c.fac_cob_id === risk.fac_cob_id);
      if (cls) cats.add(cls.category);
    }
    return cats;
  }, [risk, facClasses]);

  // Build filtered extensions list: only categories matching selected COBs
  const relevantExtensions = useMemo(() => {
    const result = [];
    for (const cat of activeCategories) {
      const exts = EXTENSIONS_BY_CATEGORY[cat];
      if (exts) result.push({ category: cat, extensions: exts });
    }
    return result;
  }, [activeCategories]);

  // All extensions (relevant + custom) for loading calc
  const allExtensions = useMemo(() => {
    const list = [];
    relevantExtensions.forEach(g => g.extensions.forEach(e => list.push(e)));
    customExtensions.forEach(e => list.push(e));
    return list;
  }, [relevantExtensions, customExtensions]);

  // Total loading %
  const extensionsLoadingPct = useMemo(() => {
    let total = 0;
    for (const ext of allExtensions) {
      if (selectedExtensions.has(ext.id)) total += ext.loadingPct;
    }
    return total;
  }, [selectedExtensions, allExtensions]);

  const toggleExtension = (id) => {
    setSelectedExtensions(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
    dirty.current = true;
  };

  // Add custom extension
  const addCustomExtension = () => {
    const label = newExtLabel.trim();
    const loading = numOrNull(newExtLoading);
    if (!label || loading == null) return;
    const id = 'custom_' + Date.now();
    setCustomExtensions(prev => [...prev, { id, label, loadingPct: loading }]);
    setSelectedExtensions(prev => new Set([...prev, id])); // auto-check it
    setNewExtLabel(''); setNewExtLoading('');
    dirty.current = true;
  };

  const removeCustomExtension = (id) => {
    setCustomExtensions(prev => prev.filter(e => e.id !== id));
    setSelectedExtensions(prev => { const next = new Set(prev); next.delete(id); return next; });
    dirty.current = true;
  };

  // Auto-calc market premium
  useEffect(() => {
    const rate = numOrNull(f.market_rate_per_mille);
    if (rate != null && tsi) set('market_premium', String(Math.round(tsi * rate / 1000)));
  }, [f.market_rate_per_mille, tsi]);

  // Auto-calc actuarial premium
  useEffect(() => {
    const rate = numOrNull(f.actuarial_rate_per_mille);
    if (rate != null && tsi) set('actuarial_premium', String(Math.round(tsi * rate / 1000)));
  }, [f.actuarial_rate_per_mille, tsi]);

  // Auto-calc blend
  useEffect(() => {
    const mw = (numOrNull(f.market_weight_pct) || 0) / 100;
    const aw = (numOrNull(f.actuarial_weight_pct) || 0) / 100;
    const mr = numOrNull(f.market_rate_per_mille) || 0;
    const ar = numOrNull(f.actuarial_rate_per_mille) || 0;
    if (mr || ar) {
      const blended = mr * mw + ar * aw;
      setF(prev => ({ ...prev, blended_rate_per_mille: blended.toFixed(4), blended_premium: tsi ? String(Math.round(tsi * blended / 1000)) : '' }));
    }
  }, [f.market_rate_per_mille, f.actuarial_rate_per_mille, f.market_weight_pct, f.actuarial_weight_pct, tsi]);

  // Auto-calc final = blended × (1 + UW adj%) × (1 + extensions loading%)
  useEffect(() => {
    const blended = numOrNull(f.blended_rate_per_mille) || 0;
    const adj = (numOrNull(f.uw_adjustment_pct) || 0) / 100;
    const extLoad = extensionsLoadingPct / 100;
    if (blended) {
      const final_rate = blended * (1 + adj) * (1 + extLoad);
      setF(prev => ({ ...prev, final_rate_per_mille: final_rate.toFixed(4), final_premium: tsi ? String(Math.round(tsi * final_rate / 1000)) : '' }));
    }
  }, [f.blended_rate_per_mille, f.uw_adjustment_pct, extensionsLoadingPct, tsi]);

  const save = useCallback(async () => {
    // Read-only (not the assignee): never POST — not the pricing record nor the
    // panel-owned UW factors. Returning true is a no-op that lets wizard
    // navigation proceed; manual edits are already blocked by the inert wrap.
    if (readOnly) return true;
    // Two independent saves: the pricing record (this screen's local
    // state) and the UW-factor selections (panel-owned). Both have to
    // succeed before WizardLayout advances.
    const uwSave = typeof window !== 'undefined' ? window.__facUwFactorsSave : null;
    let uwOk = true;
    if (typeof uwSave === 'function') {
      try { uwOk = await uwSave(); } catch { uwOk = false; }
    }
    if (!riskId || !loaded.current || !dirty.current) return uwOk;
    const payload = {};
    for (const k of Object.keys(f)) payload[k] = numOrNull(f[k]) ?? f[k];
    // Persist extension selections so they rehydrate on reload/navigation.
    payload.ui_state = {
      selectedExtensions: Array.from(selectedExtensions),
      customExtensions,
    };
    // Engine inputs (the five fields the underwriter types).
    payload.indemnity_months   = numOrNull(eng.indemnity_months);
    payload.commission_pct     = numOrNull(eng.commission_pct);
    payload.margin_pct         = numOrNull(eng.margin_pct);
    payload.other_expenses_pct = numOrNull(eng.other_expenses_pct);
    payload.market_rate_pm     = numOrNull(eng.market_rate_pm);
    payload.extra_cover_loadings = eng.extra_cover_loadings || [];
    // Engine outputs — snapshot of what the screen showed. Persisting
    // here means the DB always has the exact figures the underwriter
    // signed off on, even if the engine is updated later.
    if (engineOutput && !engineOutput._error) {
      payload.technical_rate_pm   = engineOutput.technical_rate_no_natcat_pm ?? null;
      payload.total_rate_pm       = engineOutput.total_rate_pm ?? null;
      payload.bi_rate_pm          = engineOutput.bi_rate_pm ?? null;
      payload.net_rate_pm         = engineOutput.net_rate_pm ?? null;
      payload.final_net_rate_pm   = engineOutput.final_net_rate_pm ?? null;
      payload.final_gross_rate_pm = engineOutput.final_gross_rate_pm ?? null;
      payload.technical_premium   = enginePremiums.technical;
      payload.expected_premium    = enginePremiums.expected;
      payload.underwriting_score  = engineOutput.underwriting_score ?? null;
      payload.capacity_grade      = engineOutput.capacity_grade ?? null;
      payload.uw_action           = engineOutput.uw_action ?? null;
      payload.max_capacity_pct    = engineOutput.max_capacity_pct ?? null;
      payload.max_capacity_sar    = engineOutput.max_capacity_sar ?? null;
      payload.market_vs_tech_pct  = engineOutput.market_vs_tech_pct ?? null;
      payload.market_vs_tech_band = engineOutput.market_vs_tech_band ?? null;
      payload.engine_warnings     = engineOutput.warnings || [];
      payload.engine_version      = ENGINE_VERSION;
    }
    try {
      await api.facSavePricing(riskId, payload);
      const fp = numOrNull(f.final_premium);
      if (fp) await api.facUpdateRisk(riskId, { ri_premium: fp, original_rate: numOrNull(f.final_rate_per_mille) });
      dirty.current = false;
      return uwOk;
    } catch (e) {
      logger.error('[FacPricing] save failed:', e);
      // Not the assignee: the lock raced this write (or failed open). Flip the
      // editor read-only and surface it once — never retry an authz verdict.
      // "Allocate to me" on the banner is the path back to editing.
      if (isReadOnlyError(e)) {
        markReadOnly();
        showToast('Read-only — this risk is assigned to someone else. Claim it (if unassigned) or have it allocated to you to edit.');
        return true; // no-op for nav: don't block, don't retry
      }
      showToast('Pricing save failed: ' + (e?.message || 'Server error'));
      return false;
    }
  }, [riskId, readOnly, markReadOnly, f, selectedExtensions, customExtensions, eng, engineOutput, enginePremiums, showToast]);

  const extCheckbox = (ext, catColor) => {
    const checked = selectedExtensions.has(ext.id);
    return (
      <label key={ext.id} style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px',
        borderRadius: 8, cursor: 'pointer', fontSize: 12,
        background: checked ? 'rgba(168,85,247,0.08)' : 'transparent',
        border: checked ? '1px solid rgba(168,85,247,0.30)' : '1px solid var(--hairline)',
        color: checked ? 'rgba(var(--text-rgb),0.90)' : 'var(--muted)',
        transition: 'all .15s',
      }}>
        <input type="checkbox" checked={checked} onChange={() => toggleExtension(ext.id)} style={{ width: 14, height: 14, accentColor: catColor || '#a855f7' }} />
        <span style={{ flex: 1 }}>{ext.label}</span>
        <span style={{ fontSize: 10, fontWeight: 700, color: checked ? (catColor || '#a855f7') : 'rgba(var(--text-rgb),0.45)', fontVariantNumeric: 'tabular-nums' }}>+{ext.loadingPct}%</span>
      </label>
    );
  };

  return (
    <WizardLayout routeKey={ROUTE_KEY} title="Pricing" headerPill="FACULTATIVE" onBeforeNext={save} onBeforeBack={save}>
      <AsyncBoundary loading={pricingLoad.loading} error={pricingLoad.error} onRetry={pricingLoad.refetch} label="fac pricing">
      <div style={{ maxWidth: 800, margin: '0 auto', padding: '8px 0 40px' }}>
        {readOnly && <EditLockBanner facRiskId={riskId} assignedToName={lockAssignedToName} onAllocated={refreshLock} />}
        <ReadOnlyWrap readOnly={readOnly}>
        {tsi > 0 && (
          <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 8 }}>
            Total Sum Insured: <span style={{ color: 'var(--accent-blue)', fontWeight: 700 }}>{tsi.toLocaleString('en-US')}</span>
          </div>
        )}

        <UwFactorsPanel riskId={riskId} risk={risk} onSelectionsChange={setUwSelections} />

        {/* ── Engine inputs ── */}
        <Sec title="Engine Inputs" color="rgba(var(--accent-blue-rgb),0.85)">
          <FR label="Indemnity Period (months)" hint="Drives the BI rate multiplier (1–60)">
            <input className="fi" type="number" min={1} max={60} value={eng.indemnity_months}
                   onChange={(e) => setEngField('indemnity_months', e.target.value)} style={{ width: 100 }} />
          </FR>
          <FR label="Market Rate (‰)" hint="Used for the market-vs-tech band">
            <input className="fi" type="number" min={0} step={0.0001} value={eng.market_rate_pm}
                   onChange={(e) => setEngField('market_rate_pm', e.target.value)} style={{ width: 120 }} />
          </FR>
          <FR label="Commission %" hint="Stored as 0..1 (e.g. 0.20 = 20%)">
            <input className="fi" type="number" min={0} max={1} step={0.0001} value={eng.commission_pct}
                   onChange={(e) => setEngField('commission_pct', e.target.value)} style={{ width: 110 }} />
          </FR>
          <FR label="Margin %">
            <input className="fi" type="number" min={0} max={1} step={0.0001} value={eng.margin_pct}
                   onChange={(e) => setEngField('margin_pct', e.target.value)} style={{ width: 110 }} />
          </FR>
          <FR label="Other Expenses %">
            <input className="fi" type="number" min={0} max={1} step={0.0001} value={eng.other_expenses_pct}
                   onChange={(e) => setEngField('other_expenses_pct', e.target.value)} style={{ width: 110 }} />
          </FR>
          <FR label="Extra Cover Loadings" hint="Per-cover additive loading; sum applied to net rate">
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {(eng.extra_cover_loadings || []).map((ext, i) => (
                <div key={`${ext.label}-${i}`} style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <input className="fi" value={ext.label || ''} placeholder="Cover label"
                         onChange={(e) => {
                           const next = [...eng.extra_cover_loadings];
                           next[i] = { ...next[i], label: e.target.value };
                           setEngField('extra_cover_loadings', next);
                         }}
                         style={{ flex: 1, fontSize: 12 }} />
                  <input className="fi" type="number" min={0} step={0.0001} value={ext.pct ?? ''}
                         onChange={(e) => {
                           const next = [...eng.extra_cover_loadings];
                           next[i] = { ...next[i], pct: e.target.value === '' ? null : Number(e.target.value) };
                           setEngField('extra_cover_loadings', next);
                         }}
                         placeholder="0..1" style={{ width: 100, fontSize: 12, textAlign: 'right' }} />
                  <span role="button" tabIndex={0} aria-label={`Remove cover loading ${ext.label || i + 1}`}
                        style={{ cursor: 'pointer', color: 'var(--accent-rose)', fontSize: 14 }}
                        onClick={() => removeExtraCover(i)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); removeExtraCover(i); }
                        }}>×</span>
                </div>
              ))}
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                <input className="fi" value={eng._newLabel} placeholder="New cover label"
                       onChange={(e) => setEngField('_newLabel', e.target.value)}
                       style={{ flex: 1, fontSize: 12 }} />
                <input className="fi" type="number" min={0} step={0.0001} value={eng._newPct}
                       onChange={(e) => setEngField('_newPct', e.target.value)}
                       placeholder="0..1" style={{ width: 100, fontSize: 12, textAlign: 'right' }} />
                <button type="button" onClick={() => {
                  const label = (eng._newLabel || '').trim();
                  const pct = numOrNull(eng._newPct);
                  if (!label || pct == null) return;
                  setEng((prev) => ({
                    ...prev,
                    extra_cover_loadings: [...(prev.extra_cover_loadings || []), { label, pct }],
                    _newLabel: '', _newPct: '',
                  }));
                  dirty.current = true;
                }} style={{ appearance: 'none', border: '1px solid rgba(var(--accent-blue-rgb),0.30)',
                            background: 'rgba(var(--accent-blue-rgb),0.08)', color: 'var(--accent-blue)', borderRadius: 6,
                            padding: '6px 14px', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>+ Add</button>
              </div>
            </div>
          </FR>
        </Sec>

        {/* ── Engine output (read-only) ── */}
        <Sec title="Engine Output" color="rgba(var(--accent-rgb),0.85)">
          <EngineReadout output={engineOutput} premiums={enginePremiums} totalLocSar={totalLocSar} />
        </Sec>

        {/* ── Extensions — filtered by selected COB categories ── */}
        <Sec title="Extensions" color="rgba(168,85,247,0.8)">
          <div style={{ fontSize: 11, color: 'var(--muted)', marginBottom: 12 }}>
            Extensions shown are based on classes selected on the Risk Detail page. Check applicable extensions — each adds a loading to the base rate.
          </div>

          {relevantExtensions.length === 0 && (
            <div style={{ fontSize: 12, color: 'rgba(var(--text-rgb),0.58)', padding: '8px 0' }}>No classes selected on Risk Detail — select classes to see relevant extensions</div>
          )}

          {relevantExtensions.map(({ category, extensions: exts }) => {
            const catColor = CATEGORY_COLORS[category] || '#a855f7';
            return (
              <div key={category} style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.12em', color: catColor, marginBottom: 6, textTransform: 'uppercase' }}>{category}</div>
                <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                  {exts.map(ext => extCheckbox(ext, catColor))}
                </div>
              </div>
            );
          })}

          {/* Custom extensions */}
          {customExtensions.length > 0 && (
            <div style={{ marginTop: 14, marginBottom: 8 }}>
              <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.12em', color: 'rgba(var(--accent-amber-rgb),0.8)', marginBottom: 6, textTransform: 'uppercase' }}>CUSTOM EXTENSIONS</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                {customExtensions.map(ext => (
                  <div key={ext.id} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <div style={{ flex: 1 }}>{extCheckbox(ext, '#fbbf24')}</div>
                    <span role="button" tabIndex={0} aria-label={`Remove ${ext.label || 'custom extension'}`}
                      onClick={() => removeCustomExtension(ext.id)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); removeCustomExtension(ext.id); }
                      }}
                      style={{ cursor: 'pointer', color: 'rgba(var(--accent-rose-rgb),0.7)', fontSize: 13, padding: '0 4px' }} title="Remove">✕</span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Add custom extension */}
          <div style={{ marginTop: 12, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <input className="fi" value={newExtLabel} onChange={e => setNewExtLabel(e.target.value)}
              placeholder="Custom extension name" style={{ flex: 1, minWidth: 180 }} />
            <PctInput value={newExtLoading} onChange={v => setNewExtLoading(v)}
              placeholder="Loading %" style={{ width: 90 }} />
            <button onClick={addCustomExtension} disabled={!newExtLabel.trim() || !numOrNull(newExtLoading)} style={{
              appearance: 'none', border: '1px solid rgba(var(--accent-amber-rgb),0.35)', background: 'rgba(var(--accent-amber-rgb),0.08)',
              color: 'var(--accent-amber)', borderRadius: 8, padding: '7px 14px', fontSize: 11, fontWeight: 700,
              cursor: newExtLabel.trim() && numOrNull(newExtLoading) ? 'pointer' : 'not-allowed',
              opacity: newExtLabel.trim() && numOrNull(newExtLoading) ? 1 : 0.4,
            }}>+ Add</button>
          </div>

          {extensionsLoadingPct > 0 && (
            <div style={{ marginTop: 12, fontSize: 12, fontWeight: 700, color: '#a855f7' }}>
              Total Extensions Loading: +{extensionsLoadingPct}%
            </div>
          )}
        </Sec>

        {/* ── Market Rate ── */}
        <Sec title="① Market Rate Pricing">
          <FR label="Market Rate (‰)" hint="Average set rate for this class/region">
            <input className="fi" type="number" value={f.market_rate_per_mille} onChange={e => set('market_rate_per_mille', e.target.value)} min={0} step={0.001} style={{ width: 120 }} />
          </FR>
          <FR label="Market Premium"><div style={{ fontSize: 13, fontWeight: 700, color: 'rgba(var(--text-rgb),0.85)' }}>{fmtN(f.market_premium)}</div></FR>
          <FR label="Source"><input className="fi" value={f.market_source} onChange={e => set('market_source', e.target.value)} placeholder="e.g. Market benchmark 2026, Broker indication" /></FR>
        </Sec>

        {/* ── Actuarial ── */}
        <Sec title="② Actuarial Pricing">
          <FR label="Method">
            <select className="fi" value={f.actuarial_method} onChange={e => set('actuarial_method', e.target.value)}>
              <option value="">— Select —</option>
              <option value="BURNING_COST">Burning Cost</option>
              <option value="EXPOSURE_RATED">Exposure Rated</option>
              <option value="FREQUENCY_SEVERITY">Frequency × Severity</option>
            </select>
          </FR>
          <FR label="Expected Loss Ratio %"><PctInput value={f.expected_loss_ratio} onChange={v => set('expected_loss_ratio', v)} style={{ width: 100 }} /></FR>
          <FR label="Loading %"><PctInput value={f.loading_pct} onChange={v => set('loading_pct', v)} style={{ width: 100 }} placeholder="Expense + profit" /></FR>
          <FR label="Actuarial Rate (‰)"><input className="fi" type="number" value={f.actuarial_rate_per_mille} onChange={e => set('actuarial_rate_per_mille', e.target.value)} min={0} step={0.001} style={{ width: 120 }} /></FR>
          <FR label="Actuarial Premium"><div style={{ fontSize: 13, fontWeight: 700, color: 'rgba(var(--text-rgb),0.85)' }}>{fmtN(f.actuarial_premium)}</div></FR>
          {f.actuarial_method === 'BURNING_COST' && (
            <FR label="Burning Cost Ratio"><input className="fi" type="number" value={f.burning_cost_ratio} onChange={e => set('burning_cost_ratio', e.target.value)} min={0} step={0.01} style={{ width: 100 }} /></FR>
          )}
        </Sec>

        {/* ── Blend ── */}
        <Sec title="③ Blended Rate" color="rgba(var(--accent-amber-rgb),0.8)">
          <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
            <FR label="Market Weight %"><PctInput value={f.market_weight_pct} onChange={v => { set('market_weight_pct', v); set('actuarial_weight_pct', String(100 - (Number(v) || 0))); }} style={{ width: 80 }} /></FR>
            <FR label="Actuarial Weight %"><PctInput value={f.actuarial_weight_pct} onChange={() => {}} readOnly style={{ width: 80, opacity: 0.6 }} /></FR>
          </div>
          <FR label="Blended Rate (‰)"><div style={{ fontSize: 14, fontWeight: 800, color: 'var(--accent-amber)' }}>{cleanNum(f.blended_rate_per_mille) || '—'}</div></FR>
          <FR label="Blended Premium"><div style={{ fontSize: 14, fontWeight: 800, color: 'var(--accent-amber)' }}>{fmtN(f.blended_premium)}</div></FR>
        </Sec>

        {/* ── Final ── */}
        <Sec title="④ Final UW Rate" color="rgba(var(--accent-rgb),0.85)">
          <FR label="UW Adjustment %" hint="+ surcharge / - discount">
            <PctInput value={f.uw_adjustment_pct} onChange={v => set('uw_adjustment_pct', v)} style={{ width: 100 }} />
          </FR>
          <FR label="Adjustment Reason"><input className="fi" value={f.uw_adjustment_reason} onChange={e => set('uw_adjustment_reason', e.target.value)} placeholder="e.g. Poor housekeeping, NatCat exposure" /></FR>

          {extensionsLoadingPct > 0 && (
            <div style={{ marginTop: 8, fontSize: 11, color: 'rgba(168,85,247,0.85)' }}>
              Extensions loading applied: +{extensionsLoadingPct}% on base rate
            </div>
          )}

          <div style={{ marginTop: 16, padding: 16, background: 'rgba(var(--accent-rgb),0.06)', border: '1px solid rgba(var(--accent-rgb),0.25)', borderRadius: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase', color: 'rgba(var(--accent-rgb),0.8)' }}>Final Rate (‰)</div>
                <div style={{ fontSize: 24, fontWeight: 900, color: 'var(--accent)', marginTop: 4 }}>{cleanNum(f.final_rate_per_mille) || '—'}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase', color: 'rgba(var(--accent-rgb),0.8)' }}>Final Premium</div>
                <div style={{ fontSize: 24, fontWeight: 900, color: 'var(--accent)', marginTop: 4 }}>{fmtN(f.final_premium)}</div>
              </div>
            </div>
          </div>
        </Sec>
        </ReadOnlyWrap>
      </div>
      </AsyncBoundary>
    </WizardLayout>
  );
}
