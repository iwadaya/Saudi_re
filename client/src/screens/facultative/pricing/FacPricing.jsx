// src/screens/facultative/pricing/FacPricing.jsx
import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import api from '../../../api';
import WizardLayout from '../../../components/WizardLayout';
import PctInput from '../../../components/PctInput';
import { useFacRiskId } from '../../../hooks/useContractId';

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
    if (!riskId || !loaded.current || !dirty.current) return true;
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
      return true;
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
