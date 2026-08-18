// src/screens/facultative/pricing/FacPricing.jsx
//
// One rate, one build-up.
//
// This screen used to run three unreconciled pricing mechanisms side by
// side: the engine, an Extensions checklist whose loadings fed nothing but
// the legacy blend, and a manual ①②③④ market / actuarial / 50-50 blend /
// final block — and it was the manual block, not the engine, that wrote
// back to fac_risk.ri_premium and that the Summary screen showed as
// accepted. A fourth loading list ("extra cover loadings") sat inside the
// engine inputs with no relationship to the Extensions ticks above it
// (findings F9, and the design doc §1.3).
//
// The manual block is gone. The market rate it collected is now the
// engine's own Benchmark input — it was always the thing that drove the
// market-vs-technical band — and the Extensions ticks feed the engine's
// cover loadings, so there is a single path from reference data to a
// quoted rate and every step of it is on screen in order.
//
// The legacy fac_pricing columns are still written (final_rate_per_mille,
// final_premium and friends) so historic rows keep rendering and the
// Summary screen, the risk header premium and the reports that read them
// keep working. They now carry the engine's answer rather than a typed one.
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
// Imported from the modules themselves, not the shared/fac barrel: the barrel
// is the server's entry point, and importing it here would attach all eleven
// rate engines to the registry and ship them to the browser. The registry on
// its own is metadata — labels, rating bases, what needs a COPE survey.
import { buildExposureProfile } from '../../../../../shared/fac/exposure.js';
import { familyForClass, pricingBlocker } from '../../../../../shared/fac/registry.js';
// The one engine the browser runs. Every other family prices on the server,
// and this screen shows the server's answer for them.
import { scheduleProperty } from '../../../../../shared/fac/families/scheduleProperty.js';
import { logger } from '../../../utils/logger';
import './FacPricing.css';
import {
  UwFactorsPanel, EngineReadout, PricingWaterfall, FamilyBlocker, ExposureBasisNote,
  LossCostPanel, TechnicalBuildUp,
} from './FacPricingPanels';
import FacCapacityPanel from './FacCapacityPanel';

const ENGINE_VERSION = '2.0.0';

const ROUTE_KEY = 'FAC_PRICING';

const numOrNull = v => { const c = String(v ?? '').replace(/,/g,'').trim(); if (!c) return null; const n = Number(c); return Number.isFinite(n) ? n : null; };
const fmtN = v => { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—'; };

function FR({ label, children, hint }) {
  return (
    <div className="facpx-row">
      <div>
        <div className="facpx-row-label">{label}</div>
        {hint && <div className="facpx-row-hint">{hint}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}
function Sec({ title, children }) {
  return <>
    <div className="facpx-sec-title">{title}</div>
    {children}
  </>;
}

const CATEGORY_COLORS = {
  PROPERTY: '#23d18b', ENGINEERING: '#fbbf24', MARINE: '#0ea5e9',
  CASUALTY: '#a855f7', CYBER: '#f87171', ENERGY: '#f97316',
};

// ── Extensions library by category ──
// Still hard-coded here. Moving it into a versioned fac_extension_catalogue
// (design doc §4.5 M7) with an explicit ADDITIVE / MULTIPLICATIVE flag is a
// later phase; what changed now is where these numbers GO — they are the
// engine's cover loadings rather than a parallel calculation.
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

  // ── Engine inputs ────────────────────────────────────────────────
  // Percentages are stored as fractions (0.20 = 20%) and entered through
  // PctInput, which takes and shows whole percents. The old number inputs
  // asked for "0..1" in a hint and let anything through, which is how a
  // percent-vs-fraction guess ended up in the engine (finding F8).
  const [eng, setEng] = useState({
    indemnity_months: '12',
    commission_pct: '0.20',
    margin_pct: '0.05',
    other_expenses_pct: '0.005',
    market_rate_pm: '',
    market_source: '',
    uw_adjustment_pct: '0',
    uw_adjustment_reason: '',
  });
  const setEngField = useCallback((key, val) => {
    setEng((prev) => ({ ...prev, [key]: val }));
    dirty.current = true;
  }, []);
  // PctInput speaks whole percents; the engine and the DB columns speak
  // fractions. Convert at this single boundary. Round on the way out —
  // 0.07 × 100 is 7.000000000000001 in binary floating point, and that is
  // not something to show an underwriter.
  const pctField = (key) => {
    const n = numOrNull(eng[key]);
    return n == null ? '' : String(Number((n * 100).toFixed(10)));
  };
  const setPctField = (key, whole) => {
    const n = numOrNull(whole);
    setEngField(key, n == null ? '' : String(n / 100));
  };

  // Reference catalogues — every engine input flows through these.
  const [occupancies, setOccupancies]     = useState([]);
  const [factors, setFactors]             = useState([]);
  const [factorWeights, setFactorWeights] = useState(null);
  const [scoringTables, setScoringTables] = useState(null);
  const [biIndemnity, setBiIndemnity]     = useState({});
  const [natcatRates, setNatcatRates]     = useState([]);
  const [rateVersion, setRateVersion]     = useState(null);
  // UW factor selections mirrored up from UwFactorsPanel so the engine
  // recomputes the second a dropdown changes — no API round-trip.
  const [uwSelections, setUwSelections] = useState({});
  const [locations, setLocations] = useState([]);
  const [sections, setSections] = useState([]);
  const [engineOutput, setEngineOutput] = useState(null);
  // The server's full pricing run: every loss-cost method, the credibility
  // blend and the technical build-up. The local engine cannot produce this —
  // it has no sight of the loss experience, the curve library or the bound
  // book — so this is fetched rather than computed.
  const [technical, setTechnical] = useState(null);

  useEffect(() => {
    Promise.all([
      api.facGetOccupancies(),
      api.facGetFactors(),
      api.facGetFactorWeights(),
      api.facGetScoringTables(),
      api.facGetBiIndemnity(),
      api.facGetNatcatRates(),
      api.facGetRateVersion().catch(() => null),
    ]).then(([occ, fac, fw, st, bi, nc, rv]) => {
      setOccupancies(occ?.occupancies || []);
      setFactors(fac?.factors || []);
      setFactorWeights(fw?.schemes || null);
      setScoringTables(st || null);
      setBiIndemnity(bi?.loadings || {});
      setNatcatRates(nc?.rates || []);
      setRateVersion(rv?.version_label || null);
    }).catch(logger.error);
  }, []);

  // Locations and sections both feed the one exposure profile.
  useEffect(() => {
    if (!riskId) return;
    Promise.all([
      api.facGetLocations(riskId).catch(() => []),
      api.facGetSections(riskId).catch(() => []),
    ]).then(([locs, secs]) => {
      setLocations(locs || []);
      setSections(secs || []);
    }).catch(logger.error);
  }, [riskId]);

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
        const ui = p.ui_state || {};
        if (Array.isArray(ui.selectedExtensions)) setSelectedExtensions(new Set(ui.selectedExtensions));
        if (Array.isArray(ui.customExtensions))   setCustomExtensions(ui.customExtensions);
        setEng((prev) => ({
          ...prev,
          indemnity_months:   p.indemnity_months   != null ? String(p.indemnity_months)   : prev.indemnity_months,
          commission_pct:     p.commission_pct     != null ? String(p.commission_pct)     : prev.commission_pct,
          margin_pct:         p.margin_pct         != null ? String(p.margin_pct)         : prev.margin_pct,
          other_expenses_pct: p.other_expenses_pct != null ? String(p.other_expenses_pct) : prev.other_expenses_pct,
          // market_rate_pm is the engine's own field; market_rate_per_mille is
          // the retired manual one. Fall back to it so a risk quoted before
          // the manual block was removed keeps its benchmark.
          market_rate_pm:     p.market_rate_pm != null ? String(p.market_rate_pm)
            : (p.market_rate_per_mille != null ? String(p.market_rate_per_mille) : prev.market_rate_pm),
          market_source:      p.market_source || prev.market_source,
          uw_adjustment_pct:  p.uw_adjustment_pct != null ? String(Number(p.uw_adjustment_pct) / 100) : prev.uw_adjustment_pct,
          uw_adjustment_reason: p.uw_adjustment_reason || prev.uw_adjustment_reason,
        }));
      }
      loaded.current = true; dirty.current = false;
      return { r, p, fc };
    },
    [riskId],
    { enabled: !!riskId, reportLabel: 'fac pricing' },
  );

  // ── Rating family + whether it can price this risk ────────────────
  const primaryCob = useMemo(
    () => facClasses.find((c) => c.fac_cob_id === risk?.fac_cob_id) || null,
    [facClasses, risk],
  );
  const family = useMemo(() => familyForClass(primaryCob), [primaryCob]);
  const blocker = useMemo(
    () => (risk ? pricingBlocker(family, risk) : null),
    [family, risk],
  );
  // Only SCHEDULE_PROPERTY has a workbook — a rate build-up, a score and a
  // decision computed in the browser. Every other family rates off loaded
  // tables through the server pipeline, so the workbook sections below are
  // hidden for them rather than rendered empty. "Implemented" is not the
  // test: a family can be fully implemented and have no workbook.
  const workbook = family?.code === scheduleProperty.code ? scheduleProperty : null;
  const hasWorkbook = Boolean(workbook);

  // ── The one exposure profile ─────────────────────────────────────
  // PD/BI share, the BI-included flag, the top-location figure and the
  // premium basis all come from here, so they cannot disagree (F10, F11).
  const exposure = useMemo(
    () => buildExposureProfile({ risk, sections, locations }),
    [risk, sections, locations],
  );

  // ── Extensions → engine cover loadings ───────────────────────────
  const activeCategories = useMemo(() => {
    if (!risk) return new Set();
    const cats = new Set();
    if (risk.cob_category) cats.add(risk.cob_category);
    if (primaryCob?.category) cats.add(primaryCob.category);
    return cats;
  }, [risk, primaryCob]);

  const relevantExtensions = useMemo(() => {
    const result = [];
    for (const cat of activeCategories) {
      const exts = EXTENSIONS_BY_CATEGORY[cat];
      if (exts) result.push({ category: cat, extensions: exts });
    }
    return result;
  }, [activeCategories]);

  const allExtensions = useMemo(() => {
    const list = [];
    relevantExtensions.forEach(g => g.extensions.forEach(e => list.push(e)));
    customExtensions.forEach(e => list.push(e));
    return list;
  }, [relevantExtensions, customExtensions]);

  // The engine takes fractions; the catalogue is authored in whole percent.
  const coverLoadings = useMemo(
    () => allExtensions
      .filter((e) => selectedExtensions.has(e.id))
      .map((e) => ({ label: e.label, pct: Number(e.loadingPct) / 100 })),
    [allExtensions, selectedExtensions],
  );
  const extensionsLoadingPct = useMemo(
    () => coverLoadings.reduce((acc, e) => acc + e.pct * 100, 0),
    [coverLoadings],
  );

  const toggleExtension = (id) => {
    setSelectedExtensions(prev => { const next = new Set(prev); if (next.has(id)) next.delete(id); else next.add(id); return next; });
    dirty.current = true;
  };

  const addCustomExtension = () => {
    const label = newExtLabel.trim();
    const loading = numOrNull(newExtLoading);
    if (!label || loading == null) return;
    const id = 'custom_' + Date.now();
    setCustomExtensions(prev => [...prev, { id, label, loadingPct: loading }]);
    setSelectedExtensions(prev => new Set([...prev, id]));
    setNewExtLabel(''); setNewExtLoading('');
    dirty.current = true;
  };

  const removeCustomExtension = (id) => {
    setCustomExtensions(prev => prev.filter(e => e.id !== id));
    setSelectedExtensions(prev => { const next = new Set(prev); next.delete(id); return next; });
    dirty.current = true;
  };

  // ── Debounced engine recompute (150ms) ───────────────────────────
  // Pure JS, no network behind it — the debounce only smooths fast typing.
  useEffect(() => {
    if (!risk || blocker || !hasWorkbook
        || !occupancies.length || !factors.length || !factorWeights || !scoringTables) {
      setEngineOutput(null);
      return undefined;
    }
    const handle = setTimeout(() => {
      try {
        const out = workbook.computeQuote({
          occupancy_code: risk.occupancy_code,
          country_zone:   risk.risk_country_zone,
          region:         risk.cedant_region,
          factor_selections: uwSelections,
          exposure,
          indemnity_months: numOrNull(eng.indemnity_months) || 12,
          commission_pct:   numOrNull(eng.commission_pct),
          margin_pct:       numOrNull(eng.margin_pct),
          other_expenses_pct: numOrNull(eng.other_expenses_pct),
          extra_cover_loadings: coverLoadings,
          market_rate_pm: numOrNull(eng.market_rate_pm),
        }, {
          occupancies, factors,
          factorWeights,
          hazardGradeScore:     scoringTables.hazard_grade,
          frequencyScore:       scoringTables.frequency,
          capacityBands:        scoringTables.capacity_bands,
          territorialCapacity:  scoringTables.territorial_capacity,
          biIndemnity, natcatRates,
        });
        setEngineOutput(out);
      } catch (err) {
        setEngineOutput({ _error: true, warnings: [String(err?.message || err)] });
      }
    }, 150);
    return () => clearTimeout(handle);
  }, [
    risk, blocker, workbook, hasWorkbook, occupancies, factors, factorWeights, scoringTables,
    biIndemnity, natcatRates, uwSelections, eng, exposure, coverLoadings,
  ]);

  // ── Server-side price (debounced) ────────────────────────────────
  // Slower than the local engine on purpose: it is a round trip, and it is
  // the number that gets quoted. The local engine keeps the rate readout
  // instant while this settles.
  useEffect(() => {
    if (!riskId || blocker || !family?.implemented) { setTechnical(null); return undefined; }
    let cancelled = false;
    const handle = setTimeout(() => {
      api.facPriceRisk(riskId, {
        indemnity_months:   numOrNull(eng.indemnity_months),
        commission_pct:     numOrNull(eng.commission_pct),
        margin_pct:         numOrNull(eng.margin_pct),
        other_expenses_pct: numOrNull(eng.other_expenses_pct),
        market_rate_pm:     numOrNull(eng.market_rate_pm),
        extra_cover_loadings: coverLoadings,
        factor_selections: uwSelections,
      })
        .then((out) => { if (!cancelled) setTechnical(out?.technical ?? null); })
        .catch((err) => { if (!cancelled) { logger.error('[FacPricing] price failed:', err); setTechnical(null); } });
    }, 400);
    return () => { cancelled = true; clearTimeout(handle); };
  }, [riskId, blocker, family, eng, uwSelections, coverLoadings]);

  // ── Quoted rate = technical gross × (1 + UW adjustment) ───────────
  // The adjustment is the underwriter's last word on the price and stays
  // visible as its own line in the build-up rather than being folded into
  // an upstream number.
  // The blend is authoritative once the server has priced it. Until then —
  // and whenever no Phase 2 data exists — it equals the local engine's own
  // gross rate, so the number never jumps when the round trip lands.
  const quoted = useMemo(() => {
    const adj = numOrNull(eng.uw_adjustment_pct) || 0;
    const gross = technical?.priced
      ? technical.technicalGrossPm
      : (engineOutput && !engineOutput._error ? engineOutput.final_gross_rate_pm : null);
    if (gross == null) return { rate: null, premium: null, adj, source: null };
    const rate = gross * (1 + adj);
    const si = exposure.total_si;
    return {
      rate,
      premium: si > 0 ? (rate * si) / 1000 : null,
      adj,
      source: technical?.priced ? 'BLEND' : 'ENGINE',
    };
  }, [technical, engineOutput, eng.uw_adjustment_pct, exposure]);

  const save = useCallback(async () => {
    if (readOnly) return true;
    const uwSave = typeof window !== 'undefined' ? window.__facUwFactorsSave : null;
    let uwOk = true;
    if (typeof uwSave === 'function') {
      try { uwOk = await uwSave(); } catch { uwOk = false; }
    }
    if (!riskId || !loaded.current || !dirty.current) return uwOk;

    const payload = {
      ui_state: {
        selectedExtensions: Array.from(selectedExtensions),
        customExtensions,
      },
      // Engine inputs.
      indemnity_months:   numOrNull(eng.indemnity_months),
      commission_pct:     numOrNull(eng.commission_pct),
      margin_pct:         numOrNull(eng.margin_pct),
      other_expenses_pct: numOrNull(eng.other_expenses_pct),
      market_rate_pm:     numOrNull(eng.market_rate_pm),
      market_source:      eng.market_source || null,
      extra_cover_loadings: coverLoadings,
      // uw_adjustment_pct stays in whole percent for backward compatibility
      // with the rows the manual block wrote.
      uw_adjustment_pct:  (numOrNull(eng.uw_adjustment_pct) || 0) * 100,
      uw_adjustment_reason: eng.uw_adjustment_reason || null,
      // Provenance.
      engine_version: ENGINE_VERSION,
      family_code: family?.code || null,
      rate_table_version: rateVersion,
      exposure_basis: exposure.basis,
    };

    if (engineOutput && !engineOutput._error) {
      payload.technical_rate_pm   = engineOutput.technical_rate_no_natcat_pm ?? null;
      payload.total_rate_pm       = engineOutput.total_rate_pm ?? null;
      payload.bi_rate_pm          = engineOutput.bi_rate_pm ?? null;
      payload.net_rate_pm         = engineOutput.net_rate_pm ?? null;
      payload.final_net_rate_pm   = engineOutput.final_net_rate_pm ?? null;
      payload.final_gross_rate_pm = engineOutput.final_gross_rate_pm ?? null;
      payload.technical_premium   = engineOutput.premiums?.technical ?? null;
      payload.expected_premium    = engineOutput.premiums?.expected ?? null;
      payload.underwriting_score  = engineOutput.underwriting_score ?? null;
      payload.score_completeness  = engineOutput.score_completeness ?? null;
      payload.capacity_grade      = engineOutput.capacity_grade ?? null;
      payload.uw_action           = engineOutput.uw_action ?? null;
      payload.max_capacity_pct    = engineOutput.max_capacity_pct ?? null;
      payload.max_capacity_sar    = engineOutput.max_capacity_sar ?? null;
      payload.market_vs_tech_pct  = engineOutput.market_vs_tech_pct ?? null;
      payload.market_vs_tech_band = engineOutput.market_vs_tech_band ?? null;
      payload.engine_warnings     = engineOutput.warnings || [];
    }
    if (technical?.priced) {
      payload.blended_loss_cost_pm = technical.blendedLossCostPm ?? null;
      payload.cat_load_pm          = technical.catLoadPm ?? null;
      payload.risk_load_pm         = technical.riskLoadPm ?? null;
      payload.blend_weights        = technical.weights || {};
      payload.blend_override_reason = technical.weightOverrideReason || null;
    }
    if (engineOutput && !engineOutput._error) {
      // The quoted figures land in the columns the manual block used to
      // own, so the Summary screen and every existing report keep working.
      payload.final_rate_per_mille = quoted.rate;
      payload.final_premium        = quoted.premium;
      payload.market_rate_per_mille = numOrNull(eng.market_rate_pm);
    }

    try {
      await api.facSavePricing(riskId, payload);
      if (quoted.premium != null) {
        await api.facUpdateRisk(riskId, { ri_premium: quoted.premium, original_rate: quoted.rate });
      }
      dirty.current = false;
      return uwOk;
    } catch (e) {
      logger.error('[FacPricing] save failed:', e);
      if (isReadOnlyError(e)) {
        markReadOnly();
        showToast('Read-only — this risk is assigned to someone else. Claim it (if unassigned) or have it allocated to you to edit.');
        return true;
      }
      showToast('Pricing save failed: ' + (e?.message || 'Server error'));
      return false;
    }
  }, [
    riskId, readOnly, markReadOnly, selectedExtensions, customExtensions, eng,
    coverLoadings, engineOutput, technical, quoted, family, rateVersion, exposure, showToast,
  ]);

  const extCheckbox = (ext, catColor) => {
    const checked = selectedExtensions.has(ext.id);
    return (
      <label key={ext.id}
             className={`facpx-ext${checked ? ' facpx-ext--on' : ''}`}
             style={{ '--fac-accent': catColor || '#a855f7' }}>
        <input type="checkbox" checked={checked} onChange={() => toggleExtension(ext.id)} />
        <span className="facpx-ext-name">{ext.label}</span>
        <span className="facpx-ext-pct">+{ext.loadingPct}%</span>
      </label>
    );
  };

  return (
    <WizardLayout routeKey={ROUTE_KEY} title="Pricing" headerPill="FACULTATIVE" onBeforeNext={save} onBeforeBack={save}>
      <AsyncBoundary loading={pricingLoad.loading} error={pricingLoad.error} onRetry={pricingLoad.refetch} label="fac pricing">
      <div className="facpx-page">
        {readOnly && <EditLockBanner facRiskId={riskId} assignedToName={lockAssignedToName} onAllocated={refreshLock} />}
        <ReadOnlyWrap readOnly={readOnly}>

        <ExposureBasisNote exposure={exposure} rateVersion={rateVersion} family={family} />

        {blocker && <FamilyBlocker blocker={blocker} family={family} />}

        {!blocker && (
          <>
            <UwFactorsPanel riskId={riskId} risk={risk} exposure={exposure} onSelectionsChange={setUwSelections} />

            <Sec title="Engine Inputs">
              <FR label="Indemnity Period (months)" hint="Drives the BI rate multiplier (1–60)">
                <input className="fi" type="number" min={1} max={60} value={eng.indemnity_months}
                       onChange={(e) => setEngField('indemnity_months', e.target.value)} style={{ width: 100 }} />
              </FR>
              <FR label="Benchmark Market Rate (‰)" hint="Sets the market-vs-technical band in the score">
                <input className="fi" type="number" min={0} step={0.0001} value={eng.market_rate_pm}
                       onChange={(e) => setEngField('market_rate_pm', e.target.value)} style={{ width: 120 }} />
              </FR>
              <FR label="Benchmark Source">
                <input className="fi" value={eng.market_source}
                       onChange={(e) => setEngField('market_source', e.target.value)}
                       placeholder="e.g. Market benchmark 2026, broker indication" />
              </FR>
              <FR label="Commission %">
                <PctInput value={pctField('commission_pct')} onChange={(v) => setPctField('commission_pct', v)} style={{ width: 110 }} />
              </FR>
              <FR label="Margin %">
                <PctInput value={pctField('margin_pct')} onChange={(v) => setPctField('margin_pct', v)} style={{ width: 110 }} />
              </FR>
              <FR label="Other Expenses %">
                <PctInput value={pctField('other_expenses_pct')} onChange={(v) => setPctField('other_expenses_pct', v)} style={{ width: 110 }} />
              </FR>
            </Sec>

            <Sec title="Extensions">
              <div className="facpx-note">
                Filtered by the classes selected on Risk Detail. Each ticked extension is a cover
                loading on the engine&apos;s net rate — there is no second calculation behind them.
              </div>

              {relevantExtensions.length === 0 && (
                <div className="facpx-empty">No classes selected on Risk Detail — select classes to see relevant extensions</div>
              )}

              {relevantExtensions.map(({ category, extensions: exts }) => {
                const catColor = CATEGORY_COLORS[category] || '#a855f7';
                return (
                  <div key={category} className="facpx-ext-group" style={{ '--fac-accent': catColor }}>
                    <div className="facpx-ext-cat">{category}</div>
                    <div className="facpx-ext-grid">
                      {exts.map(ext => extCheckbox(ext, catColor))}
                    </div>
                  </div>
                );
              })}

              {customExtensions.length > 0 && (
                <div className="facpx-custom">
                  <div className="facpx-custom-kicker">CUSTOM EXTENSIONS</div>
                  <div className="facpx-ext-grid">
                    {customExtensions.map(ext => (
                      <div key={ext.id} className="facpx-custom-item">
                        <div>{extCheckbox(ext, '#fbbf24')}</div>
                        <span role="button" tabIndex={0} aria-label={`Remove ${ext.label || 'custom extension'}`}
                          onClick={() => removeCustomExtension(ext.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); removeCustomExtension(ext.id); }
                          }}
                          className="facpx-custom-remove" title="Remove">✕</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}

              <div className="facpx-add-row">
                <input className="fi" value={newExtLabel} onChange={e => setNewExtLabel(e.target.value)}
                  placeholder="Custom extension name" />
                <PctInput value={newExtLoading} onChange={v => setNewExtLoading(v)}
                  placeholder="Loading %" style={{ width: 90 }} />
                <button className="facpx-add-btn" onClick={addCustomExtension}
                  disabled={!newExtLabel.trim() || !numOrNull(newExtLoading)}>+ Add</button>
              </div>
            </Sec>

            <Sec title="Underwriter Adjustment">
              <FR label="UW Adjustment %" hint="+ surcharge / − discount, applied to the technical gross rate">
                <PctInput value={pctField('uw_adjustment_pct')} onChange={(v) => setPctField('uw_adjustment_pct', v)} style={{ width: 110 }} />
              </FR>
              <FR label="Reason" hint="Required whenever the adjustment is not zero">
                <input className="fi" value={eng.uw_adjustment_reason}
                       onChange={(e) => setEngField('uw_adjustment_reason', e.target.value)}
                       placeholder="e.g. Long-standing client, clean 5-year record" />
              </FR>
              {quoted.adj !== 0 && !eng.uw_adjustment_reason.trim() && (
                <div className="facpx-warn-inline">
                  An adjustment without a reason cannot be explained at review — add one.
                </div>
              )}
            </Sec>

            <Sec title="Loss Cost">
              <LossCostPanel technical={technical} quotedRatePm={quoted.rate} />
            </Sec>

            {/* The committed book, not a static territorial budget (F14). */}
            <Sec title="Capacity Check">
              <FacCapacityPanel riskId={riskId} />
            </Sec>

            <Sec title="Technical Build-Up">
              <TechnicalBuildUp technical={technical} />
              {!technical?.priced && (
                <div className="facpx-note">
                  The technical build-up appears once the server has priced the risk.
                </div>
              )}
            </Sec>

            {hasWorkbook && (
              <Sec title="Workbook Rate Build-Up">
                <PricingWaterfall
                  output={engineOutput}
                  exposure={exposure}
                  extensionsLoadingPct={extensionsLoadingPct}
                  coverLoadings={coverLoadings}
                  adjustmentPct={quoted.adj}
                  adjustmentReason={eng.uw_adjustment_reason}
                  quotedRate={quoted.rate}
                  quotedPremium={quoted.premium}
                />
              </Sec>
            )}

            {hasWorkbook && (
              <Sec title="Engine Detail">
                <EngineReadout output={engineOutput} exposure={exposure} />
              </Sec>
            )}

            {quoted.rate != null && (
              <div className="facpx-quoted">
                <div className="facpx-quoted-inner">
                  <div>
                    <div className="facpx-quoted-kicker">
                      Quoted Rate (‰){quoted.source === 'ENGINE' ? ' · workbook only' : ''}
                    </div>
                    <div className="facpx-quoted-val">{quoted.rate.toFixed(4)}</div>
                  </div>
                  <div className="facpx-quoted-col--right">
                    <div className="facpx-quoted-kicker">Quoted Premium</div>
                    <div className="facpx-quoted-val">{fmtN(quoted.premium)}</div>
                  </div>
                </div>
              </div>
            )}
          </>
        )}
        </ReadOnlyWrap>
      </div>
      </AsyncBoundary>
    </WizardLayout>
  );
}
