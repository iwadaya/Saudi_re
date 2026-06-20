import React, { useState, useEffect, useCallback, useMemo, useRef, useId } from 'react';
import { api } from '../../api';
import { useContractId } from '../../hooks/useContractId';
import { useResource } from '../../hooks/useResource';
import WizardLayout from '../../components/WizardLayout';
import AsyncBoundary from '../../components/AsyncBoundary';
import { sanitizeNumber, fmtOrEm as fmt, toN as cn } from '../../utils/format';
import { logger } from '../../utils/logger';

function emptyBand() { return { min: '', max: '', policies: '', sumInsured: '', premiums: '', claimsPaid: '' }; }
function bandHasData(b) {
  return cn(b.min) !== 0 || cn(b.max) !== 0 || cn(b.policies) !== 0 || cn(b.sumInsured) !== 0 || cn(b.premiums) !== 0 || cn(b.claimsPaid) !== 0;
}

const COB_COLORS = [
  { border: 'rgba(34,197,94,.45)', bg: 'rgba(34,197,94,.10)', text: 'rgba(34,197,94,.95)', glow: 'rgba(34,197,94,.08)' },
  { border: 'rgba(59,130,246,.45)', bg: 'rgba(59,130,246,.10)', text: 'rgba(59,130,246,.95)', glow: 'rgba(59,130,246,.08)' },
  { border: 'rgba(245,158,11,.45)', bg: 'rgba(245,158,11,.10)', text: 'rgba(245,158,11,.95)', glow: 'rgba(245,158,11,.08)' },
  { border: 'rgba(168,85,247,.45)', bg: 'rgba(168,85,247,.10)', text: 'rgba(168,85,247,.95)', glow: 'rgba(168,85,247,.08)' },
  { border: 'rgba(236,72,153,.45)', bg: 'rgba(236,72,153,.10)', text: 'rgba(236,72,153,.95)', glow: 'rgba(236,72,153,.08)' },
  { border: 'rgba(20,184,166,.45)', bg: 'rgba(20,184,166,.10)', text: 'rgba(20,184,166,.95)', glow: 'rgba(20,184,166,.08)' },
  { border: 'rgba(239,68,68,.45)', bg: 'rgba(239,68,68,.10)', text: 'rgba(239,68,68,.95)', glow: 'rgba(239,68,68,.08)' },
  { border: 'rgba(148,163,184,.45)', bg: 'rgba(148,163,184,.10)', text: 'rgba(148,163,184,.95)', glow: 'rgba(148,163,184,.08)' },
];

/* ═══════════════════════════════════════════════════════════════
   MBBEFD EXPOSURE CURVES  (Swiss Re standard)
   
   Single-parameter first-loss function G(d):
     G(d) = ln(1 + (e^c - 1) · d) / c     for c > 0
     G(d) = d                                for c = 0 (uniform)
   
   G(0) = 0, G(1) = 1.  Higher c = more loss concentration.
   
   Swiss Re Y curves:
     Y1: c = 0   (Uniform — loss ∝ destruction)
     Y2: c = 1.5 (Light concentration)
     Y3: c = 3.0 (Moderate concentration)
     Y4: c = 5.0 (Heavy concentration)
   ═══════════════════════════════════════════════════════════════ */
const SWISS_RE_CURVES = [
  { name: 'Auto',         c: null, desc: 'Per-band: Y1–Y4 by mean SI (Swiss Re brochure Step 4)' },
  { name: 'Y1 (Uniform)', c: 0,   desc: 'Personal lines — SI ≤ 400k' },
  { name: 'Y2',           c: 1.5, desc: 'Commercial small — SI ≤ 1M' },
  { name: 'Y3',           c: 3.0, desc: 'Commercial medium — SI ≤ 2M' },
  { name: 'Y4',           c: 5.0, desc: 'Industrial / large commercial — SI > 2M' },
];

function mbbefdG(d, c) {
  if (d <= 0) return 0;
  if (d >= 1) return 1;
  if (Math.abs(c) < 1e-10) return d; // uniform
  return Math.log(1 + (Math.exp(c) - 1) * d) / c;
}

// Per-band auto-curve thresholds (must mirror npPricingEngine.autoCurveForBand).
// Used so the UI can preview which curve will be picked when 'Auto' is selected.
function autoCurveForBandUI(avgSI) {
  if (avgSI <= 400_000) return 'Y1';
  if (avgSI <= 1_000_000) return 'Y2';
  if (avgSI <= 2_000_000) return 'Y3';
  return 'Y4';
}
const SWISS_RE_C_MAP = { Y1: 0, Y2: 1.5, Y3: 3.0, Y4: 5.0 };

export default function ProfileScreen({ routeKey, title, headerPill, profileType = 'risk', quoteMode = false, embedded = false }) {
  const contractId = useContractId();
  const [cobs, setCobs] = useState([]);
  const [activeCobId, setActiveCobId] = useState(null);
  const [bands, setBands] = useState(() => Array.from({ length: 7 }, emptyBand));
  const [dirty, setDirty] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);
  const tableRef = useRef(null);
  const bandsRef = useRef(bands);
  bandsRef.current = bands;
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  const activeCobRef = useRef(activeCobId);
  activeCobRef.current = activeCobId;

  // Exposure rating state (risk profiles only)
  const [cValue, setCValue] = useState('');
  const [pmlPct, setPmlPct] = useState('100');
  const [selectedCurve, setSelectedCurve] = useState('Y3');
  const [customB, setCustomB] = useState('');
  const [customG, setCustomG] = useState('');
  const [grossLossRatio, setGrossLossRatio] = useState('100');
  const [showExposure, setShowExposure] = useState(false);
  const [showExpHelp, setShowExpHelp] = useState(false);
  const cValueRef = useRef(cValue);
  cValueRef.current = cValue;
  const pmlPctRef = useRef(pmlPct);
  pmlPctRef.current = pmlPct;
  const selectedCurveRef = useRef(selectedCurve);
  selectedCurveRef.current = selectedCurve;

  // Swiss Re curves from DB (if available)
  const [dbCurves, setDbCurves] = useState([]);

  const getFn = profileType === 'claims' ? api.getClaimsProfile : api.getRiskProfile;
  const saveFn = profileType === 'claims' ? api.saveClaimsProfile : api.saveRiskProfile;
  const isClaims = profileType === 'claims';
  const COLS = useMemo(() => (isClaims
    ? ['min', 'max', 'policies', 'sumInsured', 'premiums', 'claimsPaid']
    : ['min', 'max', 'policies', 'sumInsured', 'premiums']), [isClaims]);
  const LABELS = useMemo(() => (isClaims
    ? ['Min Sum Insured', 'Max Sum Insured', 'Count', 'Total Sum Insured', 'Premium', 'Incurred Claims']
    : ['Min Sum Insured', 'Max Sum Insured', 'Policies', 'Sum Insured', 'Premiums']), [isClaims]);

  // Load COBs from treaty
  useEffect(() => {
    if (!contractId) return;
    api.getContractCobs(contractId, quoteMode ? { quote: true } : undefined)
      .then(data => {
        const arr = Array.isArray(data) ? data : [];
        setCobs(arr);
        if (arr.length > 0 && !activeCobRef.current) setActiveCobId(arr[0].class_of_business_id || arr[0].id);
      })
      .catch(() => {});
    // Load DB Swiss Re curves
    api.getSwissReCurves().then(data => {
      setDbCurves(Array.isArray(data) ? data : []);
    }).catch(() => {});
  }, [contractId, quoteMode]);

  // Load bands + c_value/pml for active COB (Phase 2.2: useResource owns the
  // loading / error / abort-on-deps-change semantics). Hydration runs inside
  // the fetcher so ordering matches the old hand-rolled effect exactly —
  // reset → fetch → hydrate bands → hydrate profile → dirty=false, all before
  // `loading` flips off, and never for a superseded request. getFn / isClaims
  // both derive from profileType, which is in deps.
  const profileResource = useResource(
    async (signal) => {
      // Reset to defaults first so prior COB's values don't leak into the new one (C5)
      setBands(Array.from({ length: 7 }, emptyBand));
      if (!isClaims) {
        setCValue('');
        setPmlPct('100');
        setSelectedCurve('Y3');
        setCustomB('');
        setCustomG('');
        setGrossLossRatio('100');
      }
      const data = await getFn(contractId, activeCobId, quoteMode ? { quote: true, signal } : { signal });
      if (signal.aborted) return data; // ignore stale response (C6) — don't hydrate
      const b = data?.bands || [];
      if (b.length > 0) setBands(b.map(x => ({
        min: x.from_amt ?? x.min ?? '', max: x.to_amt ?? x.max ?? '',
        policies: x.no_of_risks ?? x.no_of_claims ?? x.policies ?? '',
        sumInsured: x.total_sum_insured ?? x.sum_insured ?? x.sumInsured ?? '',
        premiums: x.gross_premium ?? x.premiums ?? '',
        claimsPaid: x.aggregate_incurred ?? x.claims_paid ?? x.claimsPaid ?? '',
      })));

      // Restore saved C value and PML percentage
      const profile = data?.profile;
      if (profile && !isClaims) {
        if (profile.c_value != null && profile.c_value !== 0) setCValue(String(profile.c_value));
        if (profile.pml_percentage != null && profile.pml_percentage !== 0) setPmlPct(String(profile.pml_percentage));
        if (profile.selected_curve) setSelectedCurve(profile.selected_curve);
        if (profile.custom_b != null) setCustomB(String(profile.custom_b));
        if (profile.custom_g != null) setCustomG(String(profile.custom_g));
        if (profile.gross_loss_ratio != null && profile.gross_loss_ratio !== 0) setGrossLossRatio(String(profile.gross_loss_ratio));
      }

      setDirty(false);
      return data;
    },
    [contractId, activeCobId, profileType, quoteMode],
    { enabled: !!(contractId && activeCobId), reportLabel: 'profile' },
  );

  const updateBand = (idx, field, val) => {
    setBands(prev => { const n = [...prev]; n[idx] = { ...n[idx], [field]: val }; return n; });
    setDirty(true);
  };
  const removeBand = idx => { setBands(prev => prev.filter((_, i) => i !== idx)); setDirty(true); };
  const sortBands = () => { setBands(prev => [...prev].sort((a, b) => cn(a.min) - cn(b.min))); setDirty(true); };

  // Auto-detect paste: replaces all rows with pasted data.
  // Maps Excel columns 1-to-1 onto the visible COLS for the current profileType
  // so claims paste (Min, Max, Count, Premium, Incurred Claims) doesn't get
  // shoved into the risk-profile slots.
  const handlePaste = useCallback((e) => {
    const text = e.clipboardData?.getData('text/plain');
    if (!text) return;
    const rows = text.split('\n').filter(l => l.trim()).map(l => l.split('\t'));
    if (rows.length < 1 || rows[0].length < 2) return;
    e.preventDefault();
    const colKeys = isClaims
      ? ['min', 'max', 'policies', 'sumInsured', 'premiums', 'claimsPaid']
      : ['min', 'max', 'policies', 'sumInsured', 'premiums'];
    const newBands = rows.map(r => {
      const band = emptyBand();
      colKeys.forEach((key, idx) => {
        if (r[idx] != null) band[key] = sanitizeNumber(r[idx]);
      });
      return band;
    });
    setBands(newBands);
    setDirty(true);
  }, [isClaims]);

  // Cell-level paste
  const handleCellPaste = useCallback((e, startRow, startCol) => {
    const text = e.clipboardData?.getData('text/plain');
    if (!text) return;
    const pasteRows = text.split('\n').filter(l => l.trim()).map(l => l.split('\t'));
    if (pasteRows.length <= 1 && pasteRows[0]?.length <= 1) return;
    e.preventDefault();
    setBands(prev => {
      const colKeys = COLS;
      const colStart = colKeys.indexOf(startCol);
      if (colStart < 0) return prev;
      const needed = startRow + pasteRows.length;
      const next = [...prev.map(r => ({ ...r }))];
      while (next.length < needed) next.push(emptyBand());
      for (let rOff = 0; rOff < pasteRows.length; rOff++) {
        const ri = startRow + rOff;
        for (let cOff = 0; cOff < pasteRows[rOff].length; cOff++) {
          const ci = colStart + cOff;
          if (ci < colKeys.length) next[ri][colKeys[ci]] = sanitizeNumber(pasteRows[rOff][cOff]);
        }
      }
      return next;
    });
    setDirty(true);
  }, [COLS]);

  // Totals
  const totals = useMemo(() => ({
    policies: bands.reduce((s, b) => s + cn(b.policies), 0),
    sumInsured: bands.reduce((s, b) => s + cn(b.sumInsured), 0),
    premiums: bands.reduce((s, b) => s + cn(b.premiums), 0),
    claimsPaid: bands.reduce((s, b) => s + cn(b.claimsPaid), 0),
  }), [bands]);
  const avgSI = totals.policies > 0 ? totals.sumInsured / totals.policies : 0;
  const totalRate = totals.sumInsured > 0 ? (totals.premiums / totals.sumInsured) * 100 : 0;
  const totalLR = totals.premiums > 0 ? (totals.claimsPaid / totals.premiums) * 100 : 0;

  // Save — sends bands + c_value/pml_percentage/curve for audit
  const save = useCallback(async () => {
    const cobId = activeCobRef.current;
    if (!contractId || !cobId) return true;
    if (!dirtyRef.current) return true;
    const currentBands = bandsRef.current;
    const nonEmpty = currentBands.filter(bandHasData);
    if (nonEmpty.length === 0 && !cn(cValueRef.current) && !cn(pmlPctRef.current)) { setDirty(false); return true; }
    // Band payload: send only fields that map to columns the user actually edited.
    // - Risk profile inputs: Policies, Sum Insured, Premiums   → no_of_risks, total_sum_insured, gross_premium
    // - Claims profile inputs: Count, Premium, Incurred Claims → no_of_claims, gross_premium, aggregate_incurred
    const bandPayload = nonEmpty.map(b => isClaims ? ({
      from_amt: sanitizeNumber(b.min),
      to_amt: sanitizeNumber(b.max),
      no_of_claims: sanitizeNumber(b.policies),
      total_sum_insured: sanitizeNumber(b.sumInsured),
      aggregate_incurred: sanitizeNumber(b.claimsPaid),
      gross_premium: sanitizeNumber(b.premiums),
    }) : ({
      from_amt: sanitizeNumber(b.min),
      to_amt: sanitizeNumber(b.max),
      no_of_risks: sanitizeNumber(b.policies),
      total_sum_insured: sanitizeNumber(b.sumInsured),
      gross_premium: sanitizeNumber(b.premiums),
    }));
    // Profile payload: exposure-rating fields only apply to risk profiles.
    // Claims profiles only persist (selected_curve, custom_b, custom_g) on the quote side.
    const profilePayload = isClaims ? {
      selected_curve: selectedCurveRef.current || null,
      custom_b: cn(customB) || null,
      custom_g: cn(customG) || null,
      bands: bandPayload,
    } : {
      c_value: cn(cValueRef.current) || null,
      pml_percentage: cn(pmlPctRef.current) || 100,
      selected_curve: selectedCurveRef.current || null,
      custom_b: cn(customB) || null,
      custom_g: cn(customG) || null,
      gross_loss_ratio: cn(grossLossRatio) || 100,
      bands: bandPayload,
    };
    try {
      await saveFn(contractId, cobId, profilePayload, quoteMode ? { quote: true } : undefined);
      setDirty(false); setSaveMsg({ type: 'ok', text: 'Saved' }); setTimeout(() => setSaveMsg(null), 2000);
      return true;
    } catch (e) { logger.error('Save profile:', e); setSaveMsg({ type: 'err', text: 'Save failed' }); setTimeout(() => setSaveMsg(null), 3000); return false; }
  }, [contractId, customB, customG, grossLossRatio, isClaims, quoteMode, saveFn]);

  /* ═══════════════════════════════════════════════════════════════
     EXPOSURE RATING derived values (risk profiles only)
     ═══════════════════════════════════════════════════════════════ */
  const curveC = useMemo(() => {
    if (selectedCurve === 'Custom') return cn(customB); // custom uses 'c' value directly (stored in customB field)
    const curve = SWISS_RE_CURVES.find(c => c.name.startsWith(selectedCurve));
    return curve ? curve.c : 3.0;
  }, [selectedCurve, customB]);

  const curvePoints = useMemo(() => {
    const pts = [];
    for (let i = 0; i <= 100; i++) {
      const d = i / 100;
      pts.push({ d, G: mbbefdG(d, curveC) });
    }
    return pts;
  }, [curveC]);

  const bandExposure = useMemo(() => {
    const pml = cn(pmlPct);
    return bands.filter(bandHasData).map(band => {
      const si = cn(band.sumInsured);
      const pr = cn(band.premiums);
      const maxBand = cn(band.max);
      const bandPML = si * (pml / 100);
      if (bandPML <= 0) return { ...band, expRate: 0, expLoss: 0, si, prem: pr };
      const d = Math.min(maxBand / bandPML, 1);
      const G = mbbefdG(d, curveC);
      const expLoss = bandPML * G;
      return { ...band, expRate: G, expLoss, si, prem: pr };
    });
  }, [bands, curveC, pmlPct]);

  const totalExpLoss = bandExposure.reduce((s, b) => s + (b.expLoss || 0), 0);
  const overallExpRate = totals.sumInsured > 0 ? (totalExpLoss / totals.sumInsured) * 100 : 0;
  const cVal = cn(cValue);
  const cExpectedLoss = cVal > 0 && totals.sumInsured > 0 ? totals.sumInsured * cVal : 0;

  // Curve-implied severity rate (Gross XL Loss ÷ Total SI). Lets us reconcile
  // the underwriter-entered "C value" (severity factor) against the rate the
  // selected curve actually produces for the booked bands.
  const curveImpliedC = totals.sumInsured > 0 ? totalExpLoss / totals.sumInsured : 0;

  // Auto-curve preview: the per-band curve the engine will pick when 'Auto'
  // is selected. Empty when the underwriter has fixed a single curve.
  const autoCurvePreview = useMemo(() => {
    if (selectedCurve !== 'Auto') return [];
    return bands.filter(bandHasData).map((b, idx) => {
      const si = cn(b.sumInsured);
      const n = cn(b.policies);
      const avgSI = n > 0 ? si / n : 0;
      return { idx, avgSI, curve: avgSI > 0 ? autoCurveForBandUI(avgSI) : '—' };
    });
  }, [bands, selectedCurve]);

  // Reconciliation: classify how far the entered severity factor sits from
  // the curve-implied rate so the underwriter is nudged to align them.
  const alignment = useMemo(() => {
    if (cVal <= 0 || curveImpliedC <= 0) return null;
    const diff = Math.abs(cVal - curveImpliedC) / curveImpliedC;
    if (diff < 0.10) return { level: 'ok', diffPct: diff * 100 };
    if (diff < 0.25) return { level: 'warn', diffPct: diff * 100 };
    return { level: 'err', diffPct: diff * 100 };
  }, [cVal, curveImpliedC]);

  // Validation warnings shown to underwriters before save.
  const exposureWarnings = useMemo(() => {
    const w = [];
    const pml = cn(pmlPct);
    if (pml > 0 && (pml < 50 || pml > 100)) {
      w.push(`PML factor ${pml}% is outside the typical 50–100% band — confirm with risk surveyor.`);
    }
    if (selectedCurve === 'Custom') {
      const cb = cn(customB);
      if (cb <= 0) w.push('Custom curve selected but concentration c is missing or non-positive.');
      if (cb > 8) w.push(`Custom c=${cb} is above the Swiss Re Y4 ceiling (5.0); double-check intent.`);
    }
    if (selectedCurve === 'Auto' && autoCurvePreview.length === 0) {
      w.push('Auto curve selected but no bands carry SI / policy counts yet.');
    }
    if (cVal > 0 && curveImpliedC > 0 && Math.abs(cVal - curveImpliedC) / curveImpliedC >= 0.25) {
      w.push(`Entered C (${cVal.toFixed(4)}) differs >25% from curve-implied severity (${curveImpliedC.toFixed(4)}). Reconcile or pick a different curve.`);
    }
    const glr = cn(grossLossRatio);
    if (glr > 0 && (glr < 30 || glr > 120)) {
      w.push(`Gross loss ratio ${glr}% is outside the 30–120% sanity band.`);
    }
    return w;
  }, [pmlPct, selectedCurve, customB, autoCurvePreview, cVal, curveImpliedC, grossLossRatio]);

  // Stable per-instance prefix so the exposure-panel labels associate with their controls.
  const expId = useId();

  // Build exposure panel JSX inline (not as a nested component — avoids remount/cursor loss)
  const exposurePanelJsx = !isClaims && showExposure ? (
      <div className="pf-exposure-panel glass" style={{ marginTop: 16 }}>
        <div className="pf-exp-head" style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div className="pf-exp-title">Exposure Rating</div>
            <div className="pf-exp-sub">
              Swiss Re MBBEFD curves. Two distinct parameters drive pricing:
              {' '}<b>severity rate (C)</b> = expected loss ÷ SI, and
              {' '}<b>curve concentration (c)</b> = MBBEFD shape parameter (Y1=0, Y2=1.5, Y3=3, Y4=5).
            </div>
          </div>
          <button type="button" className="pf-exp-help-btn"
            onClick={() => setShowExpHelp(v => !v)}
            title="Show / hide the underwriter walkthrough">
            {showExpHelp ? 'Hide guide' : 'How it works'}
          </button>
        </div>

        {showExpHelp && (
          <div className="pf-exp-help">
            <div className="pf-exp-help-title">Underwriter walkthrough — Swiss Re 9-step exposure rating</div>
            <ol className="pf-exp-help-list">
              <li><b>Bands.</b> Enter the cedant's risk profile by SI band (Min / Max / Policies / Sum Insured / Premium). Paste from Excel works.</li>
              <li><b>PML factor.</b> Set the Probable Maximum Loss as % of SI for the class. Defaults to 100%; lower for property where the full SI is rarely lost in one event.</li>
              <li><b>Curve concentration (c).</b> Pick a Y-curve by class size, or <i>Auto</i> to let each band pick by mean SI: Y1 ≤ 400k, Y2 ≤ 1M, Y3 ≤ 2M, Y4 &gt; 2M. <i>Custom</i> lets you key in c directly.</li>
              <li><b>Severity rate (C).</b> Optional sanity input: the class's expected loss as a fraction of SI (e.g. 0.035 = 3.5%). The engine does <i>not</i> use it for pricing — it's a benchmark to reconcile against the curve-implied rate shown below.</li>
              <li><b>Gross loss ratio.</b> Step 8 multiplier — the cedant's average claims burden (Swiss Re brochure p.22). Converts gross XL loss into risk premium.</li>
              <li><b>Reconcile.</b> If the entered C diverges &gt;25% from the curve-implied rate, either (a) change the curve, (b) revise the C, or (c) document why the divergence is intentional.</li>
              <li><b>Audit.</b> The footer captures C, PML, curve, concentration c and loss ratio. All inputs persist on the risk profile and flow into ROL via <code>calcRiskExposureRating</code>.</li>
            </ol>
          </div>
        )}

        {/* Parameters row */}
        <div className="pf-exp-params">
          <div className="pf-exp-field">
            <label className="pf-exp-label" htmlFor={`${expId}-severity`}>Severity Rate (C)</label>
            <BlurInput id={`${expId}-severity`} className="pf-exp-input" placeholder="e.g. 0.035"
              value={cValue} onCommit={v => { setCValue(v); setDirty(true); }} />
            <div className="pf-exp-hint">Expected loss ÷ SI. Audit benchmark — compared to curve-implied rate.</div>
          </div>
          <div className="pf-exp-field">
            <label className="pf-exp-label" htmlFor={`${expId}-pml`}>PML Factor</label>
            <BlurInput id={`${expId}-pml`} className="pf-exp-input" placeholder="100" suffix="%"
              value={pmlPct} onCommit={v => { setPmlPct(v); setDirty(true); }} />
            <div className="pf-exp-hint">Probable Maximum Loss as % of SI</div>
          </div>
          <div className="pf-exp-field">
            <label className="pf-exp-label" htmlFor={`${expId}-curve`}>Curve</label>
            <select id={`${expId}-curve`} className="pf-exp-select" value={selectedCurve} onChange={e => { setSelectedCurve(e.target.value); setDirty(true); }}>
              {SWISS_RE_CURVES.map(c => <option key={c.name} value={c.name.split(' ')[0]}>{c.name} — {c.desc}</option>)}
              {dbCurves.map(c => <option key={`db-${c.curve_name || c}`} value={`DB:${c.curve_name || c}`}>DB: {c.curve_name || c}</option>)}
              <option value="Custom">Custom (b, g)</option>
            </select>
            <div className="pf-exp-hint">
              Concentration c = <b>{selectedCurve === 'Custom' ? (cn(customB) || '—') : (selectedCurve === 'Auto' ? 'per band' : (SWISS_RE_C_MAP[selectedCurve] ?? '—'))}</b>
              {' '}— shape of the destruction-ratio curve.
            </div>
          </div>
          {selectedCurve === 'Custom' && (
              <div className="pf-exp-field">
                <label className="pf-exp-label" htmlFor={`${expId}-concentration`}>c (concentration)</label>
                <BlurInput id={`${expId}-concentration`} className="pf-exp-input pf-exp-input--sm" placeholder="e.g. 3.0"
                  value={customB} onCommit={v => { setCustomB(v); setDirty(true); }} />
                <div className="pf-exp-hint">MBBEFD shape parameter (0 = uniform, 5 ≈ industrial).</div>
              </div>
          )}
          <div className="pf-exp-field">
            <label className="pf-exp-label" htmlFor={`${expId}-glr`}>Gross Loss Ratio</label>
            <BlurInput id={`${expId}-glr`} className="pf-exp-input" placeholder="100" suffix="%"
              value={grossLossRatio} onCommit={v => { setGrossLossRatio(v); setDirty(true); }} />
            <div className="pf-exp-hint">Step 8: cedant avg claims burden % (Swiss Re p.22)</div>
          </div>
        </div>

        {/* Alignment / reconciliation banner */}
        {(alignment || curveImpliedC > 0) && (
          <div className={`pf-exp-align pf-exp-align--${alignment?.level || 'info'}`}>
            <div className="pf-exp-align-row">
              <span className="pf-exp-align-tag">Reconciliation</span>
              <span>Entered C: <b>{cVal > 0 ? cVal.toFixed(4) : '—'}</b></span>
              <span>Curve-implied severity: <b>{curveImpliedC > 0 ? curveImpliedC.toFixed(4) : '—'}</b></span>
              {alignment && (
                <span className="pf-exp-align-diff">Δ {alignment.diffPct.toFixed(1)}%
                  {alignment.level === 'ok'   && ' — aligned'}
                  {alignment.level === 'warn' && ' — review'}
                  {alignment.level === 'err'  && ' — misaligned'}
                </span>
              )}
              {curveImpliedC > 0 && (
                <button type="button" className="pf-exp-align-btn"
                  onClick={() => { setCValue(curveImpliedC.toFixed(6)); setDirty(true); }}
                  title="Copy the curve-implied rate into the C field">
                  Apply curve-implied
                </button>
              )}
            </div>
            {selectedCurve === 'Auto' && autoCurvePreview.length > 0 && (
              <div className="pf-exp-align-row pf-exp-align-sub">
                <span className="pf-exp-align-tag">Auto-curve per band</span>
                {autoCurvePreview.map(p => (
                  <span key={p.idx}>Band {p.idx + 1} (mean SI {fmt(Math.round(p.avgSI))}): <b>{p.curve}</b></span>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Validation warnings */}
        {exposureWarnings.length > 0 && (
          <ul className="pf-exp-warnings">
            {exposureWarnings.map((w, i) => <li key={i}>{w}</li>)}
          </ul>
        )}

        {/* KPI strip */}
        <div className="pf-exp-kpis">
          <div className="pf-kpi"><div className="pf-kpi-label">Total SI</div><div className="pf-kpi-value">{fmt(totals.sumInsured)}</div></div>
          <div className="pf-kpi"><div className="pf-kpi-label">PML</div><div className="pf-kpi-value">{fmt(Math.round(totals.sumInsured * cn(pmlPct) / 100))}</div></div>
          {cVal > 0 && <div className="pf-kpi pf-kpi--green"><div className="pf-kpi-label">C × SI (Expected)</div><div className="pf-kpi-value">{fmt(Math.round(cExpectedLoss))}</div></div>}
          <div className="pf-kpi pf-kpi--blue"><div className="pf-kpi-label">Exp. Rate ({selectedCurve})</div><div className="pf-kpi-value">{overallExpRate > 0 ? overallExpRate.toFixed(3) + '%' : '—'}</div></div>
          <div className="pf-kpi"><div className="pf-kpi-label">Gross XL Loss</div><div className="pf-kpi-value">{fmt(Math.round(totalExpLoss))}</div></div>
          {cn(grossLossRatio) > 0 && cn(grossLossRatio) !== 100 && (
            <div className="pf-kpi pf-kpi--green">
              <div className="pf-kpi-label">Risk Premium ({cn(grossLossRatio)}%)</div>
              <div className="pf-kpi-value">{fmt(Math.round(totalExpLoss * cn(grossLossRatio) / 100))}</div>
            </div>
          )}
        </div>

        {/* Curve visualization */}
        <div className="pf-exp-chart-row">
          <div className="pf-exp-chart-wrap">
            <div className="pf-exp-chart-title">G(d) — Destruction Ratio Curve ({selectedCurve === 'Custom' ? `c=${cn(customB)}` : selectedCurve})</div>
            <svg width="100%" height="100%" viewBox="0 0 320 200" preserveAspectRatio="xMidYMid meet" className="crisp-grid" style={{ fontFamily: 'inherit', fontVariantNumeric: 'tabular-nums' }}>
              {[0.2, 0.4, 0.6, 0.8].map(v => (
                <React.Fragment key={v}>
                  <line x1={40} y1={180 - v * 160} x2={310} y2={180 - v * 160} stroke="rgba(255,255,255,.06)" shapeRendering="crispEdges" vectorEffect="non-scaling-stroke" />
                  <text x={36} y={184 - v * 160} textAnchor="end" fill="rgba(255,255,255,.55)" fontSize="9" fontWeight="500">{v.toFixed(1)}</text>
                  <line x1={40 + v * 270} y1={18} x2={40 + v * 270} y2={180} stroke="rgba(255,255,255,.06)" shapeRendering="crispEdges" vectorEffect="non-scaling-stroke" />
                  <text x={40 + v * 270} y={194} textAnchor="middle" fill="rgba(255,255,255,.55)" fontSize="9" fontWeight="500">{v.toFixed(1)}</text>
                </React.Fragment>
              ))}
              <line x1={40} y1={180} x2={310} y2={180} stroke="rgba(255,255,255,.30)" shapeRendering="crispEdges" vectorEffect="non-scaling-stroke" />
              <line x1={40} y1={18} x2={40} y2={180} stroke="rgba(255,255,255,.30)" shapeRendering="crispEdges" vectorEffect="non-scaling-stroke" />
              <text x={175} y={10} textAnchor="middle" fill="rgba(255,255,255,.55)" fontSize="9" fontWeight="500">G(d) vs d</text>
              <line x1={40} y1={180} x2={310} y2={18} stroke="rgba(255,255,255,.10)" strokeDasharray="4,3" vectorEffect="non-scaling-stroke" />
              <polyline
                points={curvePoints.map(p => `${40 + p.d * 270},${180 - p.G * 160}`).join(' ')}
                fill="none" stroke="#22c55e" strokeWidth="2" strokeLinejoin="round" strokeLinecap="round" opacity="0.95"
                vectorEffect="non-scaling-stroke"
              />
            </svg>
          </div>

          {/* Curve comparison table */}
          <div className="pf-exp-curves-table">
            <div className="pf-exp-chart-title">Curve Comparison at Key Points</div>
            <table className="pf-table pf-table--sm">
              <thead><tr><th>d</th>{SWISS_RE_CURVES.map(c => <th key={c.name}>{c.name.split(' ')[0]}</th>)}{selectedCurve === 'Custom' && <th>Custom</th>}</tr></thead>
              <tbody>
                {[0.01, 0.05, 0.10, 0.20, 0.30, 0.50, 0.75, 1.0].map(d => (
                  <tr key={d}>
                    <td style={{ fontWeight: 600 }}>{(d * 100).toFixed(0)}%</td>
                    {SWISS_RE_CURVES.map(cv => <td key={cv.name}>{(mbbefdG(d, cv.c) * 100).toFixed(2)}%</td>)}
                    {selectedCurve === 'Custom' && <td style={{ color: '#22c55e', fontWeight: 600 }}>{(mbbefdG(d, cn(customB)) * 100).toFixed(2)}%</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>

        {/* Audit footer */}
        <div className="pf-exp-audit">
          <span>
            Audit: C(severity)={cValue || '—'}
            , PML={pmlPct || '100'}%
            , Curve={selectedCurve}
            , c(concentration)={selectedCurve === 'Custom'
              ? (cn(customB) || '—')
              : (selectedCurve === 'Auto' ? 'per band' : (SWISS_RE_C_MAP[selectedCurve] ?? '—'))}
            , LossRatio={grossLossRatio || '100'}%
            {curveImpliedC > 0 && `, CurveImpliedC=${curveImpliedC.toFixed(4)}`}
          </span>
          <span style={{ marginLeft: 12, color: dirty ? '#f59e0b' : 'var(--accent)' }}>{dirty ? '● Unsaved' : '✓ Saved'}</span>
        </div>
      </div>
  ) : null;

  const content = (
        <div className="PROFILE_SCREEN">
          {/* COB Tabs as pills */}
          {cobs.length > 0 ? (
            <div className="pf-cob-tabs">
              <span className="pf-cob-tabs-label">Class of Business</span>
              <div className="pf-cob-tabs-row">
                {cobs.map((c, idx) => {
                  const cobId = c.class_of_business_id || c.id;
                  const isActive = cobId === activeCobId;
                  const color = COB_COLORS[idx % COB_COLORS.length];
                  return (
                    <button key={cobId}
                      className={`pf-cob-tab ${isActive ? 'pf-cob-tab--active' : ''}`}
                      style={{
                        borderColor: isActive ? color.border : 'rgba(148,163,184,.18)',
                        background: isActive ? color.bg : 'transparent',
                        color: isActive ? color.text : 'rgba(148,163,184,.65)',
                        boxShadow: isActive ? `0 0 0 4px ${color.glow}` : 'none',
                      }}
                      onClick={async () => {
                        if (dirtyRef.current) {
                          const ok = await save();
                          if (!ok) return; // keep user on the dirty COB so edits aren't lost
                        }
                        setActiveCobId(cobId);
                      }}>
                      <span className="pf-cob-dot" style={{ background: color.border }} />
                      {c.name || c.code || `Class ${idx + 1}`}
                    </button>
                  );
                })}
              </div>
            </div>
          ) : (
            <div className="pf-no-cobs">
              No Classes of Business linked to this treaty. Please add them on the Treaty Detail screen first.
            </div>
          )}

          {/* KPIs */}
          <div className="pf-kpis">
            <div className="pf-kpi"><div className="pf-kpi-label">Total {isClaims ? 'Claims' : 'Policies'}</div><div className="pf-kpi-value">{fmt(totals.policies)}</div></div>
            <div className="pf-kpi"><div className="pf-kpi-label">Total Sum Insured</div><div className="pf-kpi-value">{fmt(totals.sumInsured)}</div></div>
            <div className="pf-kpi"><div className="pf-kpi-label">Total Premium</div><div className="pf-kpi-value">{fmt(totals.premiums)}</div></div>
            {isClaims && <div className="pf-kpi"><div className="pf-kpi-label">Total Incurred Claims</div><div className="pf-kpi-value">{fmt(totals.claimsPaid)}</div></div>}
            {isClaims
              ? <div className="pf-kpi"><div className="pf-kpi-label">Loss Ratio</div><div className="pf-kpi-value" style={{ color: totalLR > 100 ? '#ef4444' : totalLR > 70 ? '#f59e0b' : '#4ade80' }}>{totalLR > 0 ? totalLR.toFixed(1) + '%' : '—'}</div></div>
              : <div className="pf-kpi"><div className="pf-kpi-label">Avg SI / Policy</div><div className="pf-kpi-value">{fmt(Math.round(avgSI))}</div></div>
            }
            <div className="pf-kpi"><div className="pf-kpi-label">Rate %</div><div className="pf-kpi-value">{totalRate > 0 ? totalRate.toFixed(3) + '%' : '—'}</div></div>
          </div>

          {/* Toolbar */}
          <div className="pf-toolbar">
            <div className="pf-toolbar-left">
              <button className="pf-btn" onClick={sortBands}>Sort ↑</button>
              {!isClaims && <button className="pf-btn" style={{ marginLeft: 8, background: showExposure ? 'rgba(34,197,94,.15)' : undefined, borderColor: showExposure ? 'rgba(34,197,94,.4)' : undefined, color: showExposure ? '#4ade80' : undefined }}
                onClick={() => setShowExposure(!showExposure)}>{showExposure ? '▼ Exposure Rating' : '▶ Exposure Rating'}</button>}
            </div>
            <div className="pf-toolbar-right">
              {saveMsg && <span className={`pf-msg pf-msg--${saveMsg.type}`}>{saveMsg.text}</span>}
              <button className={`pf-btn pf-btn--save ${dirty ? 'pf-btn--dirty' : ''}`} onClick={save}>💾 Save</button>
            </div>
          </div>

          <AsyncBoundary loading={profileResource.loading} error={profileResource.error}
            onRetry={profileResource.refetch} label="profile">
            <div className="pf-table-wrap" onPaste={handlePaste} ref={tableRef}>
              <table className="pf-table">
                <thead><tr>
                  {LABELS.map((l, i) => <th key={i} className="pf-th">{l}</th>)}
                  <th className="pf-th">{isClaims ? 'Loss Ratio' : 'Rate %'}</th>
                  {isClaims && <th className="pf-th">Rate %</th>}
                  <th className="pf-th" style={{ width: 32 }}></th>
                </tr></thead>
                <tbody>
                  {bands.map((b, i) => {
                    const si = cn(b.sumInsured);
                    const pr = cn(b.premiums);
                    const cp = cn(b.claimsPaid);
                    const rate = si > 0 ? (pr / si) * 100 : 0;
                    const lr = pr > 0 ? (cp / pr) * 100 : 0;
                    return (
                      <tr key={i}>
                        {COLS.map(f => (
                          <td key={f} className="pf-td">
                            <NumInput value={b[f]} onChange={v => updateBand(i, f, v)}
                              onPaste={e => handleCellPaste(e, i, f)} />
                          </td>
                        ))}
                        {isClaims
                          ? <td className="pf-td pf-td--rate" style={{ color: lr > 100 ? '#ef4444' : lr > 70 ? '#f59e0b' : '#4ade80' }}>{lr > 0 ? lr.toFixed(1) + '%' : '—'}</td>
                          : <td className="pf-td pf-td--rate">{rate > 0 ? rate.toFixed(3) + '%' : '—'}</td>
                        }
                        {isClaims && <td className="pf-td pf-td--rate">{rate > 0 ? rate.toFixed(3) + '%' : '—'}</td>}
                        <td className="pf-td pf-td--x"><button className="pf-btn pf-btn--x" onClick={() => removeBand(i)}>✕</button></td>
                      </tr>
                    );
                  })}
                  <tr className="pf-total">
                    <td className="pf-td" colSpan={2}><span className="pf-total-label">Total</span></td>
                    <td className="pf-td pf-td--total">{fmt(totals.policies)}</td>
                    {isClaims
                      ? <><td className="pf-td pf-td--total">{fmt(totals.sumInsured)}</td><td className="pf-td pf-td--total">{fmt(totals.premiums)}</td><td className="pf-td pf-td--total">{fmt(totals.claimsPaid)}</td></>
                      : <><td className="pf-td pf-td--total">{fmt(totals.sumInsured)}</td><td className="pf-td pf-td--total">{fmt(totals.premiums)}</td></>
                    }
                    <td className="pf-td pf-td--total pf-td--rate" style={isClaims ? { color: totalLR > 100 ? '#ef4444' : totalLR > 70 ? '#f59e0b' : '#4ade80' } : {}}>
                      {isClaims ? (totalLR > 0 ? totalLR.toFixed(1) + '%' : '—') : (totalRate > 0 ? totalRate.toFixed(3) + '%' : '—')}
                    </td>
                    {isClaims && <td className="pf-td pf-td--total pf-td--rate">{totalRate > 0 ? totalRate.toFixed(3) + '%' : '—'}</td>}
                    <td className="pf-td"></td>
                  </tr>
                </tbody>
              </table>
              <div className="pf-hint">Paste from Excel to auto-detect rows ({isClaims ? '6 columns: Min, Max, Count, Total Sum Insured, Premium, Incurred Claims' : '5 columns: Min, Max, Policies, Sum Insured, Premiums'}). Delete rows with ✕.</div>
            </div>
          </AsyncBoundary>

          {/* Exposure Rating Panel */}
          {exposurePanelJsx}
        </div>
  );

  if (embedded) return content;

  return (
    <WizardLayout routeKey={routeKey} title={title} headerPill={headerPill} onBeforeNext={save} onBeforeBack={save}>
      {() => content}
    </WizardLayout>
  );
}

function NumInput({ value, onChange, onPaste }) {
  const [editing, setEditing] = React.useState(false);
  const [raw, setRaw] = React.useState('');
  const display = React.useMemo(() => {
    const n = cn(value);
    return n === 0 && String(value ?? '').trim() === '' ? '' : n.toLocaleString('en-US', { maximumFractionDigits: 0 });
  }, [value]);
  return (
    <input className="pf-inp pf-inp--num" type="text"
      value={editing ? raw : display}
      placeholder="0"
      onFocus={() => { setEditing(true); setRaw(String(value ?? '').replace(/,/g, '')); }}
      onChange={e => { setRaw(e.target.value); onChange(e.target.value); }}
      onBlur={() => setEditing(false)}
      onPaste={onPaste} />
  );
}

/* BlurInput — edits in local state, commits to parent on blur/Enter.
   Prevents parent re-render on every keystroke so cursor stays put.
   Optional suffix (e.g. "%") shown when not focused. */
function BlurInput({ value, onCommit, className, placeholder, suffix, id }) {
  const [local, setLocal] = React.useState(value);
  const [focused, setFocused] = React.useState(false);
  React.useEffect(() => { if (!focused) setLocal(value); }, [value, focused]);
  const commit = () => { setFocused(false); if (local !== value) onCommit(local); };
  const display = !focused && suffix && local ? `${local}${suffix}` : local;
  const title = suffix === '%' ? 'Enter a number — % is added automatically.' : undefined;
  return (
    <input id={id} className={className} type="text" placeholder={placeholder} title={title}
      value={focused ? local : (display || '')}
      onFocus={() => { setFocused(true); setLocal(String(value ?? '')); }}
      onChange={e => setLocal(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') commit(); }} />
  );
}
