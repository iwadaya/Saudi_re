// src/screens/facultative/pricing/FacPricing.jsx
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import api from '../../../api';
import WizardLayout from '../../../components/WizardLayout';
import PctInput from '../../../components/PctInput';
import { useFacRiskId } from '../../../hooks/useContractId';
import { useScreenSave } from '../../../hooks/useScreenSave';
import { computeScoreAndDecision } from '../../../logic/facPropertyPricing';

const ROUTE_KEY = 'FAC_PRICING';
const numOrNull = v => { const c = String(v ?? '').replace(/,/g,'').trim(); if (!c) return null; const n = Number(c); return Number.isFinite(n) ? n : null; };
const cleanNum = v => { if (v == null || v === '') return ''; const n = Number(v); if (!Number.isFinite(n)) return String(v); return n === Math.floor(n) ? String(Math.floor(n)) : String(n); };
const fmtN = v => { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—'; };

function FR({ label, children, hint }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 10, alignItems: 'center', minHeight: 36 }}>
      <div>
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)' }}>{label}</div>
        {hint && <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.30)', marginTop: 1 }}>{hint}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}
function Sec({ title, color, children }) {
  return <>
    <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase', color: color || 'rgba(0,212,255,0.55)', marginTop: 28, marginBottom: 12, paddingBottom: 6, borderBottom: '1px solid rgba(255,255,255,0.06)' }}>{title}</div>
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

function pctChip(decimal) {
  // discount_loading is stored as a decimal (e.g. -0.10 = -10%).
  const n = Number(decimal);
  if (!Number.isFinite(n) || n === 0) return '0%';
  const sign = n > 0 ? '+' : '−';
  return `${sign}${Math.abs(n * 100).toFixed(2)}%`;
}

function UwFactorsPanel({ riskId, risk, onScoreChange }) {
  const [collapsed, setCollapsed] = useState(false);
  const [factors, setFactors]       = useState([]);
  const [weights, setWeights]       = useState(null);
  const [scoring, setScoring]       = useState(null);
  const [occupancies, setOccupancies] = useState([]);
  const [selections, setSelections] = useState({});
  const [notes, setNotes]           = useState('');

  // Load reference data + the risk's saved selections. Factor master,
  // weights, scoring tables and occupancies are cached client-side so
  // navigating between screens does not refetch.
  useEffect(() => {
    if (!riskId) return;
    Promise.all([
      api.facGetFactors(),
      api.facGetFactorWeights(),
      api.facGetScoringTables(),
      api.facGetOccupancies(),
    ]).then(([fac, fw, st, occ]) => {
      setFactors(fac?.factors || []);
      setWeights(fw?.schemes || null);
      setScoring(st || null);
      setOccupancies(occ?.occupancies || []);
    }).catch(console.error);
  }, [riskId]);

  // Hydrate selections separately so reloading the saved blob does not
  // race the reference-data fetch.
  const hydrateSelections = useCallback((data) => {
    setSelections(data?.selections || {});
    setNotes(data?.notes || '');
  }, []);

  const saveSelections = useCallback(
    (id, state) => api.facSaveUwFactors(id, { selections: state.selections, notes: state.notes || null }),
    [],
  );

  const { save: saveUwFactors, markDirty } = useScreenSave({
    entityId: riskId || '',
    load: api.facGetUwFactors,
    save: saveSelections,
    currentState: () => ({ selections, notes }),
    onLoaded: hydrateSelections,
    errorLabel: 'UW Factors',
  });

  const setSelection = useCallback((code, label) => {
    setSelections((prev) => ({ ...prev, [code]: label }));
    markDirty();
  }, [markDirty]);

  // Filter the master list down to the 18 qualitative factors — those
  // with at least one option in fac_factor_option. HAZARD_GRADE and
  // FREQUENCY_GRADE come from the occupancy + dedicated score tables,
  // not from a user-picked option.
  const qualitativeFactors = useMemo(
    () => factors.filter((f) => Array.isArray(f.options) && f.options.length > 0),
    [factors],
  );

  // BI is included when bi_sum_insured > 0 OR pd_sum_insured is 0 with
  // BI > 0; in practice the existing risk model treats any positive BI
  // SI as BI-included. Falls through to WITHOUT_BI when there is no
  // BI exposure.
  const biIncluded = useMemo(() => {
    const bi = Number(risk?.bi_sum_insured) || 0;
    return bi > 0;
  }, [risk]);

  // Live score — pure client-side compute, no network call.
  const liveScore = useMemo(() => {
    if (!risk || !factors.length || !weights || !scoring) return null;
    try {
      return computeScoreAndDecision(
        {
          occupancy_code: risk.occupancy_code,
          factor_selections: selections,
          bi_included: biIncluded,
          market_rate_pm: 0,
        },
        {
          occupancies,
          factors,
          factorWeights: weights,
          hazardGradeScore: scoring.hazard_grade,
          frequencyScore: scoring.frequency,
          capacityBands: scoring.capacity_bands,
          territorialCapacity: scoring.territorial_capacity,
        },
        { final_net_rate_pm: 0 },
      );
    } catch {
      return null;
    }
  }, [risk, factors, weights, scoring, occupancies, selections, biIncluded]);

  // Surface the score upwards if the parent wants to compose it with the
  // pricing screen's other readouts.
  useEffect(() => {
    if (onScoreChange) onScoreChange(liveScore);
  }, [liveScore, onScoreChange]);

  // Lift the save() handle on the parent so WizardLayout's onBeforeNext
  // can flush both this panel and the pricing screen on navigation.
  useEffect(() => {
    if (typeof window === 'undefined') return;
    window.__facUwFactorsSave = saveUwFactors;
    return () => { delete window.__facUwFactorsSave; };
  }, [saveUwFactors]);

  const scheme = biIncluded ? 'WITH_BI' : 'WITHOUT_BI';

  return (
    <div style={{ marginBottom: 20, padding: '14px 18px',
                  background: 'rgba(168,85,247,0.04)',
                  border: '1px solid rgba(168,85,247,0.25)', borderRadius: 12 }}>
      {/* Header */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: collapsed ? 0 : 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, cursor: 'pointer' }}
             onClick={() => setCollapsed((c) => !c)}>
          <span style={{ fontSize: 13, color: 'rgba(168,85,247,0.80)' }}>{collapsed ? '▶' : '▼'}</span>
          <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.14em',
                         textTransform: 'uppercase', color: 'rgba(168,85,247,0.80)' }}>
            Underwriting Factors — Drivers of Rate &amp; Score
          </span>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 14 }}>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.12em',
                          textTransform: 'uppercase', color: 'rgba(148,163,184,0.45)' }}>Scheme</div>
            <div style={{ fontSize: 11, fontWeight: 800, color: '#a855f7', fontVariantNumeric: 'tabular-nums' }}>{scheme}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.12em',
                          textTransform: 'uppercase', color: 'rgba(148,163,184,0.45)' }}>Score</div>
            <div style={{ fontSize: 18, fontWeight: 900, color: '#23d18b', fontVariantNumeric: 'tabular-nums' }}>
              {liveScore ? liveScore.underwriting_score.toFixed(2) : '—'}
              {liveScore?.capacity_grade && (
                <span style={{ marginLeft: 8, fontSize: 10, color: 'rgba(35,209,139,0.65)' }}>
                  {liveScore.capacity_grade} · {liveScore.uw_action}
                </span>
              )}
            </div>
          </div>
        </div>
      </div>

      {!collapsed && (
        <>
          {qualitativeFactors.length === 0 ? (
            <div style={{ fontSize: 12, color: 'rgba(148,163,184,0.45)', padding: '8px 0' }}>
              Loading factor catalogue…
            </div>
          ) : (
            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 6 }}>
              {qualitativeFactors.map((factor) => {
                const selectedLabel = selections[factor.factor_code] || '';
                const selectedOpt = factor.options.find((o) => o.option_label === selectedLabel);
                return (
                  <div key={factor.factor_code} style={{ display: 'grid',
                       gridTemplateColumns: '220px 1fr 90px 90px', gap: 10, alignItems: 'center',
                       padding: '4px 0' }}>
                    <div style={{ fontSize: 12, color: 'rgba(226,232,240,0.75)' }}>
                      {factor.factor_name}
                    </div>
                    <select className="fi" value={selectedLabel}
                            onChange={(e) => setSelection(factor.factor_code, e.target.value)}
                            style={{ fontSize: 12 }}>
                      <option value="">— Select —</option>
                      {factor.options.map((o) => (
                        <option key={o.option_id || o.option_label} value={o.option_label}>
                          {o.option_label}
                        </option>
                      ))}
                    </select>
                    <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                                  fontSize: 11, fontWeight: 700,
                                  color: selectedOpt ? '#23d18b' : 'rgba(148,163,184,0.30)' }}>
                      {selectedOpt ? `score ${selectedOpt.score}` : '—'}
                    </div>
                    <div style={{ textAlign: 'right', fontVariantNumeric: 'tabular-nums',
                                  fontSize: 11, fontWeight: 700,
                                  color: factor.affects_rate
                                    ? (selectedOpt ? '#fbbf24' : 'rgba(148,163,184,0.30)')
                                    : 'rgba(148,163,184,0.35)' }}>
                      {factor.affects_rate
                        ? (selectedOpt ? pctChip(selectedOpt.discount_loading || 0) : '—')
                        : 'score only'}
                    </div>
                  </div>
                );
              })}
            </div>
          )}

          <div style={{ marginTop: 12 }}>
            <textarea className="fi" rows={2} value={notes}
                      onChange={(e) => { setNotes(e.target.value); markDirty(); }}
                      placeholder="Underwriter notes on these factor selections…"
                      style={{ width: '100%', resize: 'vertical', fontSize: 12 }} />
          </div>
        </>
      )}
    </div>
  );
}

export default function FacPricing() {
  const riskId = useFacRiskId();
  const loaded = useRef(false);
  const dirty = useRef(false);
  const [risk, setRisk] = useState(null);
  const [facClasses, setFacClasses] = useState([]);
  const [selectedExtensions, setSelectedExtensions] = useState(new Set());
  const [customExtensions, setCustomExtensions] = useState([]); // { id, label, loadingPct }
  const [newExtLabel, setNewExtLabel] = useState('');
  const [newExtLoading, setNewExtLoading] = useState('');

  const [f, setF] = useState({
    market_rate_per_mille: '', market_premium: '', market_source: '',
    actuarial_method: '', actuarial_rate_per_mille: '', actuarial_premium: '',
    expected_loss_ratio: '', loss_cost: '', loading_pct: '',
    market_weight_pct: '50', actuarial_weight_pct: '50',
    blended_rate_per_mille: '', blended_premium: '',
    final_rate_per_mille: '', final_premium: '',
    uw_adjustment_pct: '0', uw_adjustment_reason: '',
    burning_cost_ratio: '', avg_loss_years: '5',
  });

  // Load risk + pricing + fac classes
  useEffect(() => {
    if (!riskId) return;
    loaded.current = false;
    Promise.all([api.facGetRisk(riskId), api.facGetPricing(riskId), api.facListClasses()])
      .then(([r, p, fc]) => {
        setRisk(r);
        setFacClasses(fc || []);
        if (p) {
          const o = {};
          for (const k of Object.keys(f)) o[k] = cleanNum(p[k]) || (typeof f[k] === 'string' ? (p[k] || '') : f[k]);
          setF(o);
          // Rehydrate extension selections from ui_state JSONB
          const ui = p.ui_state || {};
          if (Array.isArray(ui.selectedExtensions)) setSelectedExtensions(new Set(ui.selectedExtensions));
          if (Array.isArray(ui.customExtensions))   setCustomExtensions(ui.customExtensions);
        }
        loaded.current = true; dirty.current = false;
      }).catch(console.error);
  }, [f, riskId]);

  const set = (k, v) => { setF(prev => ({ ...prev, [k]: v })); dirty.current = true; };
  const tsi = numOrNull(risk?.total_sum_insured) || 0;

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
    try {
      await api.facSavePricing(riskId, payload);
      const fp = numOrNull(f.final_premium);
      if (fp) await api.facUpdateRisk(riskId, { ri_premium: fp, original_rate: numOrNull(f.final_rate_per_mille) });
      dirty.current = false;
      return uwOk;
    } catch (e) {
      console.error('[FacPricing] save failed:', e);
      window.showToast('Pricing save failed: ' + (e?.message || 'Server error'));
      return false;
    }
  }, [riskId, f, selectedExtensions, customExtensions]);

  const extCheckbox = (ext, catColor) => {
    const checked = selectedExtensions.has(ext.id);
    return (
      <label key={ext.id} style={{
        display: 'flex', alignItems: 'center', gap: 8, padding: '7px 12px',
        borderRadius: 8, cursor: 'pointer', fontSize: 12,
        background: checked ? 'rgba(168,85,247,0.08)' : 'transparent',
        border: checked ? '1px solid rgba(168,85,247,0.30)' : '1px solid rgba(255,255,255,0.06)',
        color: checked ? 'rgba(226,232,240,0.90)' : 'rgba(148,163,184,0.60)',
        transition: 'all .15s',
      }}>
        <input type="checkbox" checked={checked} onChange={() => toggleExtension(ext.id)} style={{ width: 14, height: 14, accentColor: catColor || '#a855f7' }} />
        <span style={{ flex: 1 }}>{ext.label}</span>
        <span style={{ fontSize: 10, fontWeight: 700, color: checked ? (catColor || '#a855f7') : 'rgba(148,163,184,0.35)', fontVariantNumeric: 'tabular-nums' }}>+{ext.loadingPct}%</span>
      </label>
    );
  };

  return (
    <WizardLayout routeKey={ROUTE_KEY} title="Pricing" headerPill="FACULTATIVE" onBeforeNext={save} onBeforeBack={save}>
      <div style={{ maxWidth: 800, margin: '0 auto', padding: '8px 0 40px' }}>
        {tsi > 0 && (
          <div style={{ fontSize: 12, color: 'rgba(148,163,184,0.45)', marginBottom: 8 }}>
            Total Sum Insured: <span style={{ color: '#00d4ff', fontWeight: 700 }}>{tsi.toLocaleString('en-US')}</span>
          </div>
        )}

        <UwFactorsPanel riskId={riskId} risk={risk} />

        {/* ── Extensions — filtered by selected COB categories ── */}
        <Sec title="Extensions" color="rgba(168,85,247,0.55)">
          <div style={{ fontSize: 11, color: 'rgba(148,163,184,0.45)', marginBottom: 12 }}>
            Extensions shown are based on classes selected on the Risk Detail page. Check applicable extensions — each adds a loading to the base rate.
          </div>

          {relevantExtensions.length === 0 && (
            <div style={{ fontSize: 12, color: 'rgba(148,163,184,0.35)', padding: '8px 0' }}>No classes selected on Risk Detail — select classes to see relevant extensions</div>
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
              <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.12em', color: 'rgba(251,191,36,0.60)', marginBottom: 6, textTransform: 'uppercase' }}>CUSTOM EXTENSIONS</div>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }}>
                {customExtensions.map(ext => (
                  <div key={ext.id} style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <div style={{ flex: 1 }}>{extCheckbox(ext, '#fbbf24')}</div>
                    <span onClick={() => removeCustomExtension(ext.id)} style={{ cursor: 'pointer', color: 'rgba(248,113,113,0.50)', fontSize: 13, padding: '0 4px' }} title="Remove">✕</span>
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
              appearance: 'none', border: '1px solid rgba(251,191,36,0.35)', background: 'rgba(251,191,36,0.08)',
              color: '#fbbf24', borderRadius: 8, padding: '7px 14px', fontSize: 11, fontWeight: 700,
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
          <FR label="Market Premium"><div style={{ fontSize: 13, fontWeight: 700, color: 'rgba(226,232,240,0.80)' }}>{fmtN(f.market_premium)}</div></FR>
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
          <FR label="Actuarial Premium"><div style={{ fontSize: 13, fontWeight: 700, color: 'rgba(226,232,240,0.80)' }}>{fmtN(f.actuarial_premium)}</div></FR>
          {f.actuarial_method === 'BURNING_COST' && (
            <FR label="Burning Cost Ratio"><input className="fi" type="number" value={f.burning_cost_ratio} onChange={e => set('burning_cost_ratio', e.target.value)} min={0} step={0.01} style={{ width: 100 }} /></FR>
          )}
        </Sec>

        {/* ── Blend ── */}
        <Sec title="③ Blended Rate" color="rgba(251,191,36,0.55)">
          <div style={{ display: 'flex', gap: 16, marginBottom: 12 }}>
            <FR label="Market Weight %"><PctInput value={f.market_weight_pct} onChange={v => { set('market_weight_pct', v); set('actuarial_weight_pct', String(100 - (Number(v) || 0))); }} style={{ width: 80 }} /></FR>
            <FR label="Actuarial Weight %"><PctInput value={f.actuarial_weight_pct} onChange={() => {}} readOnly style={{ width: 80, opacity: 0.6 }} /></FR>
          </div>
          <FR label="Blended Rate (‰)"><div style={{ fontSize: 14, fontWeight: 800, color: '#fbbf24' }}>{cleanNum(f.blended_rate_per_mille) || '—'}</div></FR>
          <FR label="Blended Premium"><div style={{ fontSize: 14, fontWeight: 800, color: '#fbbf24' }}>{fmtN(f.blended_premium)}</div></FR>
        </Sec>

        {/* ── Final ── */}
        <Sec title="④ Final UW Rate" color="rgba(35,209,139,0.65)">
          <FR label="UW Adjustment %" hint="+ surcharge / - discount">
            <PctInput value={f.uw_adjustment_pct} onChange={v => set('uw_adjustment_pct', v)} style={{ width: 100 }} />
          </FR>
          <FR label="Adjustment Reason"><input className="fi" value={f.uw_adjustment_reason} onChange={e => set('uw_adjustment_reason', e.target.value)} placeholder="e.g. Poor housekeeping, NatCat exposure" /></FR>

          {extensionsLoadingPct > 0 && (
            <div style={{ marginTop: 8, fontSize: 11, color: 'rgba(168,85,247,0.60)' }}>
              Extensions loading applied: +{extensionsLoadingPct}% on base rate
            </div>
          )}

          <div style={{ marginTop: 16, padding: 16, background: 'rgba(35,209,139,0.06)', border: '1px solid rgba(35,209,139,0.25)', borderRadius: 12 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <div>
                <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase', color: 'rgba(35,209,139,0.55)' }}>Final Rate (‰)</div>
                <div style={{ fontSize: 24, fontWeight: 900, color: '#23d18b', marginTop: 4 }}>{cleanNum(f.final_rate_per_mille) || '—'}</div>
              </div>
              <div style={{ textAlign: 'right' }}>
                <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase', color: 'rgba(35,209,139,0.55)' }}>Final Premium</div>
                <div style={{ fontSize: 24, fontWeight: 900, color: '#23d18b', marginTop: 4 }}>{fmtN(f.final_premium)}</div>
              </div>
            </div>
          </div>
        </Sec>
      </div>
    </WizardLayout>
  );
}
