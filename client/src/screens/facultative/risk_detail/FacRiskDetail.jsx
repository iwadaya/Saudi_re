// src/screens/facultative/risk_detail/FacRiskDetail.jsx
import React, { useState, useEffect, useCallback, useMemo } from 'react';
import api from '../../../api';
import WizardLayout from '../../../components/WizardLayout';
import PctInput from '../../../components/PctInput';
import { useScreenSave } from '../../../hooks/useScreenSave';
import { useFacRiskId } from '../../../hooks/useContractId';

const ROUTE_KEY = 'FAC_RISK_DETAIL';

const numOrNull = v => { const c = String(v ?? '').replace(/,/g, '').trim(); if (!c) return null; const n = Number(c); return Number.isFinite(n) ? n : null; };
const fmtComma = v => { const d = String(v ?? '').replace(/[^\d]/g, ''); return d ? Number(d).toLocaleString('en-US') : ''; };
const stripDigits = v => String(v ?? '').replace(/[^\d]/g, '');
const cleanNum = v => { if (v == null || v === '') return ''; const n = Number(v); if (!Number.isFinite(n)) return String(v); return n === Math.floor(n) ? String(Math.floor(n)) : String(n); };
const fmt = v => { const n = Number(v); return Number.isFinite(n) ? n.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '—'; };

function FR({ label, children, hint }) {
  return (
    <div style={{ display: 'grid', gridTemplateColumns: '220px 1fr', gap: 12, alignItems: 'center', minHeight: 40, marginBottom: 6 }}>
      <div>
        <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.55)' }}>{label}</div>
        {hint && <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.35)', marginTop: 1 }}>{hint}</div>}
      </div>
      <div>{children}</div>
    </div>
  );
}
function CommaInput({ value, onChange, placeholder, readOnly }) {
  const [display, setDisplay] = useState(fmtComma(value));
  useEffect(() => { setDisplay(fmtComma(value)); }, [value]);
  const handleChange = e => { const raw = stripDigits(e.target.value); setDisplay(fmtComma(raw)); onChange(raw); };
  return <input className="fi" type="text" inputMode="numeric" placeholder={placeholder} value={display} onChange={handleChange} readOnly={readOnly} />;
}
function SectionTitle({ children }) {
  return <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.14em', textTransform: 'uppercase', color: 'rgba(0,212,255,0.55)', marginTop: 32, marginBottom: 14, paddingBottom: 8, borderBottom: '1px solid rgba(255,255,255,0.06)' }}>{children}</div>;
}

const CATEGORY_COLORS = {
  PROPERTY: '#23d18b', ENGINEERING: '#fbbf24', MARINE: '#0ea5e9',
  CASUALTY: '#a855f7', CYBER: '#f87171', ENERGY: '#f97316',
};

/* ─── Section COB Checklist ─── */
function SectionCobChecklist({ sectionIndex, selected, facClasses, classesByCategory, onChange }) {
  const toggle = (cobId) => {
    const next = new Set(selected);
    if (next.has(cobId)) next.delete(cobId); else next.add(cobId);
    onChange(sectionIndex, [...next]);
  };
  return (
    <div style={{ background: 'rgba(8,14,30,0.50)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 12, padding: '14px 16px', marginBottom: 10 }}>
      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.10em', color: 'rgba(0,212,255,0.50)', marginBottom: 10 }}>SECTION {sectionIndex + 1} — CLASSES COVERED</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 3 }}>
        {Object.entries(classesByCategory).map(([cat, items]) => (
          <React.Fragment key={cat}>
            <div style={{ gridColumn: '1 / -1', fontSize: 9, fontWeight: 800, letterSpacing: '.12em', color: 'rgba(148,163,184,0.40)', marginTop: 6, marginBottom: 2, textTransform: 'uppercase' }}>{cat}</div>
            {items.map(c => {
              const checked = selected.has(c.fac_cob_id);
              return (
                <label key={c.fac_cob_id} style={{ display: 'flex', alignItems: 'center', gap: 7, padding: '5px 10px', borderRadius: 6, cursor: 'pointer', fontSize: 12, background: checked ? 'rgba(0,212,255,0.06)' : 'transparent', color: checked ? 'rgba(226,232,240,0.90)' : 'rgba(148,163,184,0.55)', transition: 'all .12s' }}>
                  <input type="checkbox" checked={checked} onChange={() => toggle(c.fac_cob_id)} style={{ width: 13, height: 13, accentColor: '#00d4ff' }} />
                  <span>{c.class_name}</span>
                  {c.is_project && <span style={{ fontSize: 8, color: 'rgba(251,191,36,0.60)', marginLeft: 4 }}>PROJECT</span>}
                </label>
              );
            })}
          </React.Fragment>
        ))}
      </div>
      {selected.size > 0 && (
        <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {[...selected].map(id => {
            const cls = facClasses.find(c => c.fac_cob_id === id);
            return cls ? (
              <span key={id} style={{ display: 'inline-flex', alignItems: 'center', gap: 4, padding: '2px 8px', borderRadius: 20, background: 'rgba(0,212,255,0.10)', border: '1px solid rgba(0,212,255,0.25)', color: '#00d4ff', fontSize: 10, fontWeight: 700 }}>
                {cls.class_name}
                <span style={{ cursor: 'pointer', opacity: 0.6, fontSize: 12, lineHeight: 1 }} onClick={() => toggle(id)}>×</span>
              </span>
            ) : null;
          })}
        </div>
      )}
    </div>
  );
}

export default function FacRiskDetail() {
  const riskId = useFacRiskId();

  const [f, setF] = useState({
    insured_name: '', insured_address: '', nature_of_business: '',
    cedant_id: '', broker_id: '', country_id: '', currency_id: '', fac_cob_id: '',
    inception_date: '', expiry_date: '', policy_period_months: '12', uw_year: '',
    total_sum_insured: '', pd_sum_insured: '', bi_sum_insured: '',
    pml_amount: '', pml_pct: '', mfl_amount: '', mfl_pct: '',
    underwriter_notes: '', fac_ref: '',
  });

  const [numSections, setNumSections] = useState(1);
  const [sectionCobs, setSectionCobs] = useState([new Set()]);
  // Per-COB SI values: keyed by fac_cob_id
  const [cobSiValues, setCobSiValues] = useState({});

  const [allCedants, setAllCedants] = useState([]);
  const [brokers, setBrokers] = useState([]);
  const [countries, setCountries] = useState([]);
  const [currencies, setCurrencies] = useState([]);
  const [facClasses, setFacClasses] = useState([]);

  useEffect(() => {
    Promise.all([
      api.listCedants(), api.listBrokers(),
      api.getRefListItems('country'), api.getRefListItems('currency'),
      api.facListClasses(),
    ]).then(([c, b, co, cu, fc]) => {
      setAllCedants(Array.isArray(c) ? c : c?.rows || []);
      setBrokers(Array.isArray(b) ? b : b?.rows || []);
      setCountries(Array.isArray(co) ? co : co?.items || []);
      setCurrencies(Array.isArray(cu) ? cu : cu?.items || []);
      setFacClasses(fc || []);
    }).catch(console.error);
  }, []);

  const filteredCedants = useMemo(() => {
    if (!f.country_id) return [];
    return allCedants.filter(c => (c.country_id || c.countryId) === f.country_id);
  }, [allCedants, f.country_id]);

  const classesByCategory = useMemo(() => facClasses.reduce((acc, c) => { (acc[c.category] = acc[c.category] || []).push(c); return acc; }, {}), [facClasses]);

  // All selected COB IDs across all sections (ordered, deduplicated)
  const allSelectedCobs = useMemo(() => {
    const seen = new Set();
    const ordered = [];
    sectionCobs.forEach((s, si) => {
      [...s].forEach(id => {
        if (!seen.has(id)) { seen.add(id); ordered.push({ id, section: si }); }
      });
    });
    return ordered;
  }, [sectionCobs]);

  // Does any selected COB belong to a property-type category (for PML/MFL)?
  const anyPropertyType = useMemo(() => {
    const propCats = new Set(['PROPERTY', 'ENGINEERING', 'ENERGY', 'MARINE']);
    return allSelectedCobs.some(({ id }) => {
      const cls = facClasses.find(c => c.fac_cob_id === id);
      return cls && propCats.has(cls.category);
    });
  }, [allSelectedCobs, facClasses]);

  // Total SI across all COBs
  const totalSi = useMemo(() => {
    let t = 0;
    for (const v of Object.values(cobSiValues)) t += (numOrNull(v) || 0);
    return t;
  }, [cobSiValues]);

  const hydrate = useCallback((r) => {
    setF({
      insured_name: r.insured_name || '', insured_address: r.insured_address || '',
      nature_of_business: r.nature_of_business || '',
      cedant_id: r.cedant_id || '', broker_id: r.broker_id || '',
      country_id: r.country_id || '', currency_id: r.currency_id || '',
      fac_cob_id: r.fac_cob_id || '',
      inception_date: r.inception_date ? r.inception_date.substring(0, 10) : '',
      expiry_date: r.expiry_date ? r.expiry_date.substring(0, 10) : '',
      policy_period_months: cleanNum(r.policy_period_months) || '12',
      uw_year: cleanNum(r.uw_year) || '',
      total_sum_insured: cleanNum(r.total_sum_insured) || '',
      pd_sum_insured: cleanNum(r.pd_sum_insured) || '',
      bi_sum_insured: cleanNum(r.bi_sum_insured) || '',
      pml_amount: cleanNum(r.pml_amount) || '', pml_pct: cleanNum(r.pml_pct) || '',
      mfl_amount: cleanNum(r.mfl_amount) || '', mfl_pct: cleanNum(r.mfl_pct) || '',
      underwriter_notes: r.underwriter_notes || '', fac_ref: r.fac_ref || '',
    });
    if (r.fac_cob_id) {
      setSectionCobs([new Set([r.fac_cob_id])]);
      if (r.total_sum_insured) setCobSiValues({ [r.fac_cob_id]: cleanNum(r.total_sum_insured) });
    }
  }, []);

  const saveRisk = useCallback(
    (id, state) => api.facUpdateRisk(id, {
      ...state,
      total_sum_insured: numOrNull(state.total_sum_insured),
      pd_sum_insured: numOrNull(state.pd_sum_insured), bi_sum_insured: numOrNull(state.bi_sum_insured),
      pml_amount: numOrNull(state.pml_amount), pml_pct: numOrNull(state.pml_pct),
      mfl_amount: numOrNull(state.mfl_amount), mfl_pct: numOrNull(state.mfl_pct),
      policy_period_months: numOrNull(state.policy_period_months), uw_year: numOrNull(state.uw_year),
      cedant_id: state.cedant_id || null, broker_id: state.broker_id || null,
      country_id: state.country_id || null, currency_id: state.currency_id || null, fac_cob_id: state.fac_cob_id || null,
    }),
    [],
  );

  const { save, markDirty, loadedRef: loaded } = useScreenSave({
    entityId: riskId || '',
    load: api.facGetRisk,
    save: saveRisk,
    currentState: () => f,
    onLoaded: hydrate,
    errorLabel: 'Risk detail',
  });

  const set = useCallback((key, val) => {
    setF(prev => ({ ...prev, [key]: val }));
    markDirty();
  }, [markDirty]);

  const handleNumSectionsChange = (n) => {
    const num = Math.max(1, Math.min(5, Number(n) || 1));
    setNumSections(num);
    setSectionCobs(prev => { const next = [...prev]; while (next.length < num) next.push(new Set()); return next.slice(0, num); });
    markDirty();
  };

  const handleSectionCobChange = (idx, cobIds) => {
    setSectionCobs(prev => { const next = [...prev]; next[idx] = new Set(cobIds); return next; });
    const first = cobIds[0] || '';
    if (first) set('fac_cob_id', first);
    markDirty();
  };

  const handleCobSiChange = (cobId, val) => {
    setCobSiValues(prev => ({ ...prev, [cobId]: val }));
    markDirty();
  };

  // Sync total SI to form for saving
  useEffect(() => {
    setF(prev => ({ ...prev, total_sum_insured: String(totalSi) }));
  }, [totalSi]);

  // Clear cedant on country change
  useEffect(() => {
    if (loaded.current && f.country_id) {
      const valid = filteredCedants.some(c => (c.company_id || c.id) === f.cedant_id);
      if (!valid && f.cedant_id) set('cedant_id', '');
    }
  }, [f.cedant_id, f.country_id, filteredCedants, loaded, set]);

  // PML/MFL
  useEffect(() => {
    const p = numOrNull(f.pml_pct);
    if (p != null && totalSi) setF(prev => ({ ...prev, pml_amount: String(Math.round(totalSi * p / 100)) }));
  }, [f.pml_pct, totalSi]);
  useEffect(() => {
    const m = numOrNull(f.mfl_pct);
    if (m != null && totalSi) setF(prev => ({ ...prev, mfl_amount: String(Math.round(totalSi * m / 100)) }));
  }, [f.mfl_pct, totalSi]);

  // Expiry
  useEffect(() => {
    if (f.inception_date && f.policy_period_months) {
      const d = new Date(f.inception_date); d.setMonth(d.getMonth() + Number(f.policy_period_months));
      setF(prev => ({ ...prev, expiry_date: d.toISOString().slice(0, 10) }));
    }
  }, [f.inception_date, f.policy_period_months]);

  const yearOptions = Array.from({ length: 10 }, (_, i) => new Date().getFullYear() - 2 + i);

  return (
    <WizardLayout routeKey={ROUTE_KEY} title="Risk Detail" headerPill={f.fac_ref || 'FACULTATIVE'} onBeforeNext={save} onBeforeBack={save}>
      <div className="wizard-form" style={{ maxWidth: 740, margin: '0 auto', padding: '8px 0 40px' }}>

        {f.fac_ref && <div style={{ fontSize: 12, color: '#00d4ff', fontFamily: 'monospace', fontWeight: 700, marginBottom: 20 }}>{f.fac_ref}</div>}

        {/* ── Parties ── */}
        <SectionTitle>Parties</SectionTitle>
        <FR label="Country" hint="Select country first to filter cedants">
          <select className="fi" value={f.country_id} onChange={e => set('country_id', e.target.value)}>
            <option value="">— Select Country —</option>
            {countries.map(c => <option key={c.id || c.country_id} value={c.id || c.country_id}>{c.name || c.country_name}</option>)}
          </select>
        </FR>
        <FR label="Cedant">
          <select className="fi" value={f.cedant_id} onChange={e => set('cedant_id', e.target.value)} disabled={!f.country_id} style={!f.country_id ? { opacity: 0.4 } : {}}>
            <option value="">{f.country_id ? '— Select Cedant —' : '— Select Country First —'}</option>
            {filteredCedants.map(c => <option key={c.company_id || c.id} value={c.company_id || c.id}>{c.company_name || c.name}</option>)}
          </select>
          {f.country_id && filteredCedants.length === 0 && <div style={{ fontSize: 10, color: 'rgba(251,191,36,0.70)', marginTop: 4 }}>No cedants found for this country</div>}
        </FR>
        <FR label="Broker">
          <select className="fi" value={f.broker_id} onChange={e => set('broker_id', e.target.value)}>
            <option value="">— Select —</option>
            {brokers.map(b => <option key={b.broker_id || b.id} value={b.broker_id || b.id}>{b.broker_name || b.name}</option>)}
          </select>
        </FR>
        <FR label="Currency">
          <select className="fi" value={f.currency_id} onChange={e => set('currency_id', e.target.value)}>
            <option value="">— Select —</option>
            {currencies.map(c => <option key={c.id || c.currency_id} value={c.id || c.currency_id}>{c.name || c.currency_code}</option>)}
          </select>
        </FR>

        {/* ── Insured ── */}
        <SectionTitle>Insured Risk</SectionTitle>
        <FR label="Insured Name"><input className="fi" value={f.insured_name} onChange={e => set('insured_name', e.target.value)} placeholder="e.g. SABIC Petrochemical Plant" /></FR>
        <FR label="Insured Address"><input className="fi" value={f.insured_address} onChange={e => set('insured_address', e.target.value)} placeholder="Physical address of premises" /></FR>
        <FR label="Nature of Business" hint="Occupation / activity"><input className="fi" value={f.nature_of_business} onChange={e => set('nature_of_business', e.target.value)} placeholder="e.g. Petrochemical manufacturing" /></FR>

        {/* ── Sections & COBs ── */}
        <SectionTitle>Sections &amp; Classes of Business</SectionTitle>
        <FR label="Number of Sections">
          <select className="fi" value={numSections} onChange={e => handleNumSectionsChange(e.target.value)} style={{ width: 80 }}>
            {[1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n}</option>)}
          </select>
        </FR>
        {Array.from({ length: numSections }, (_, i) => (
          <SectionCobChecklist key={i} sectionIndex={i} selected={sectionCobs[i] || new Set()}
            facClasses={facClasses} classesByCategory={classesByCategory} onChange={handleSectionCobChange} />
        ))}

        {/* ── Policy Period ── */}
        <SectionTitle>Policy Period</SectionTitle>
        <FR label="UW Year">
          <select className="fi" value={f.uw_year} onChange={e => set('uw_year', e.target.value)}>
            <option value="">— Select —</option>
            {yearOptions.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </FR>
        <FR label="Inception Date"><input className="fi" type="date" value={f.inception_date} onChange={e => set('inception_date', e.target.value)} /></FR>
        <FR label="Period (Months)"><input className="fi" type="number" value={f.policy_period_months} onChange={e => set('policy_period_months', e.target.value)} min={1} max={60} style={{ width: 100 }} /></FR>
        <FR label="Expiry Date"><input className="fi" type="date" value={f.expiry_date} readOnly style={{ opacity: 0.6 }} /></FR>

        {/* ── Sums Insured — one row per checked COB ── */}
        <SectionTitle>Sums Insured (100% Basis)</SectionTitle>
        {allSelectedCobs.length === 0 && (
          <div style={{ fontSize: 12, color: 'rgba(148,163,184,0.35)', padding: '12px 0' }}>Select classes of business above to enter sums insured</div>
        )}
        {allSelectedCobs.map(({ id, section }) => {
          const cls = facClasses.find(c => c.fac_cob_id === id);
          if (!cls) return null;
          const catColor = CATEGORY_COLORS[cls.category] || '#94a3b8';
          return (
            <div key={id} style={{ display: 'grid', gridTemplateColumns: '1fr 200px', gap: 12, alignItems: 'center', marginBottom: 8, padding: '8px 14px', background: 'rgba(8,14,30,0.40)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 10, borderLeft: `3px solid ${catColor}` }}>
              <div>
                <div style={{ fontSize: 12, fontWeight: 700, color: 'rgba(226,232,240,0.85)' }}>{cls.class_name}</div>
                <div style={{ fontSize: 9, color: catColor, fontWeight: 700, letterSpacing: '.08em', marginTop: 1 }}>SEC {section + 1} · {cls.category}</div>
              </div>
              <CommaInput value={cobSiValues[id] || ''} onChange={v => handleCobSiChange(id, v)} placeholder="Sum Insured" />
            </div>
          );
        })}

        {/* Total SI */}
        {totalSi > 0 && (
          <div style={{ marginTop: 10, padding: '10px 16px', background: 'rgba(35,209,139,0.06)', border: '1px solid rgba(35,209,139,0.20)', borderRadius: 10, display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.10em', color: 'rgba(35,209,139,0.55)', textTransform: 'uppercase' }}>Total Sum Insured</span>
            <span style={{ fontSize: 18, fontWeight: 900, color: '#23d18b' }}>{fmt(totalSi)}</span>
          </div>
        )}

        {/* ── PML / MFL ── */}
        {anyPropertyType && (
          <>
            <SectionTitle>PML / MFL Estimates</SectionTitle>
            <FR label="PML %"><PctInput value={f.pml_pct} onChange={v => set('pml_pct', v)} style={{ width: 100 }} /></FR>
            <FR label="PML Amount"><CommaInput value={f.pml_amount} onChange={() => {}} readOnly /></FR>
            <FR label="MFL %"><PctInput value={f.mfl_pct} onChange={v => set('mfl_pct', v)} style={{ width: 100 }} /></FR>
            <FR label="MFL Amount"><CommaInput value={f.mfl_amount} onChange={() => {}} readOnly /></FR>
          </>
        )}

        {/* ── Notes ── */}
        <SectionTitle>Underwriter Notes</SectionTitle>
        <textarea className="fi" value={f.underwriter_notes} onChange={e => set('underwriter_notes', e.target.value)}
          rows={4} placeholder="Internal notes on this risk…" style={{ width: '100%', resize: 'vertical' }} />
      </div>
    </WizardLayout>
  );
}
