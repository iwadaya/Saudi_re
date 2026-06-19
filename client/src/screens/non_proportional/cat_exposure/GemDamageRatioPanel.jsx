// screens/non_proportional/cat_exposure/GemDamageRatioPanel.jsx
//
// Deterministic earthquake exposure-rating panel for the NP cat workbench.
//
// Reads the contract's CRESTA EQ aggregates and any saved GEM scenario, lets
// the underwriter pick a vulnerability (damage-ratio) curve per occupancy slot
// from one of two providers — GEM or HAZUS — and supply a design intensity per
// IMT, then asks the server to compute a ground-up expected EQ loss
// (Σ over zones of eq_agg · Σ bucket_share · MDR(intensity)). The ground-up
// loss can be pushed into the host's cat burning-cost field via onApplyToCat.
//
// Self-contained: it owns its own data fetch/compute and hands the ground-up
// EQ loss back to the host via onApplyToCat (the host writes it into the cat
// burning-cost field with its real layer setter and persists via the screen's
// normal save). Theming mirrors the inline-style + CSS-variable convention used
// across the FQ pricing workbench (no hard-coded hex outside genuinely dynamic
// chart/series values).

import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts';
import { api } from '../../../api';
import { formatWithCommas } from '../../../utils/format';

// The five occupancy buckets carried per CRESTA-zone row, mirrored from the
// server's OCCUPANCY_BUCKETS. Each slot draws its curve from a specific
// occupancy class (RES/COM/IND) and loss category (structural vs contents).
const SLOTS = [
  { slot: 'residentialBldg', label: 'Residential — building', occupancy: 'RES', lossCategory: 'structural' },
  { slot: 'commercialBldg', label: 'Commercial — building', occupancy: 'COM', lossCategory: 'structural' },
  { slot: 'commercialCont', label: 'Commercial — contents', occupancy: 'COM', lossCategory: 'contents' },
  { slot: 'industrialBldg', label: 'Industrial — building', occupancy: 'IND', lossCategory: 'structural' },
  { slot: 'industrialCont', label: 'Industrial — contents', occupancy: 'IND', lossCategory: 'contents' },
];

const SOURCES = ['GEM', 'HAZUS'];

// HAZUS isn't published per-country; the generator seeds a GENERIC catalogue.
const HAZUS_FALLBACK_COUNTRY = 'GENERIC';

// ── Shared style fragments (CSS-variable theming, matches the FQ workbench). ──
const card = { background: 'rgba(8,14,30,0.72)', border: '1px solid rgba(var(--accent-rgb),0.22)', borderRadius: 12 };
const sectionLabel = { fontSize: 9, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.7)' };
const fieldLabel = { fontSize: 10, fontWeight: 700, color: 'rgba(226,232,240,0.62)', marginBottom: 4, display: 'block' };
const selectStyle = {
  width: '100%', boxSizing: 'border-box', padding: '6px 8px', fontSize: 11,
  background: 'var(--control-bg, rgba(8,16,30,.64))', color: 'rgba(226,232,240,0.9)',
  border: '1px solid rgba(148,163,184,0.22)', borderRadius: 6,
};
const numInput = { ...selectStyle, fontVariantNumeric: 'tabular-nums' };
const thStyle = { ...sectionLabel, textAlign: 'right', padding: '6px 8px', borderBottom: '1px solid rgba(148,163,184,0.18)' };
const tdStyle = { fontSize: 11, padding: '5px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'rgba(226,232,240,0.86)' };
const axisTick = { fontSize: 9, fill: 'rgba(148,163,184,0.7)' };
const gridStroke = 'rgba(255,255,255,0.07)';
const tooltipStyle = { background: '#0b1526', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 8, fontSize: 11 };

/** Coerce to a finite number or 0. */
const toNum = (v) => {
  const x = typeof v === 'number' ? v : Number.parseFloat(v);
  return Number.isFinite(x) ? x : 0;
};

const pct = (v) => `${(toNum(v) * 100).toFixed(2)}%`;
const money = (v, ccy) => `${ccy ? `${ccy} ` : ''}${formatWithCommas(toNum(v))}`;

// Option label for a curve <select>: taxonomy + intensity measure type.
const curveOptionLabel = (c) => `${c.taxonomy} (${c.imt})`;

// Deterministic representative pick for a slot: prefer PGA-based functions,
// sort by a stable key (taxonomy → IMT → id) and take the median entry. No
// randomness — the same catalogue always yields the same default.
function pickDefaultCurve(list) {
  if (!Array.isArray(list) || !list.length) return null;
  const pga = list.filter((c) => c.imt === 'PGA');
  const pool = pga.length ? pga : list;
  const sorted = [...pool].sort((a, b) => {
    const ka = `${a.taxonomy || ''}|${a.imt || ''}`;
    const kb = `${b.taxonomy || ''}|${b.imt || ''}`;
    if (ka !== kb) return ka < kb ? -1 : 1;
    return Number(a.id) - Number(b.id);
  });
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

// HAZUS placeholder curves are seeded with a "HAZUS:" taxonomy prefix. Prefer a
// real API flag if one is ever returned; until then key off that prefix.
const isHazusPlaceholderCurve = (c) => c?.placeholder === true
  || (typeof c?.taxonomy === 'string' && c.taxonomy.startsWith('HAZUS:'));

const defaultTag = { marginLeft: 6, fontSize: 9, fontWeight: 700, color: 'var(--accent)', opacity: 0.85 };

/**
 * @param {{
 *   contractId: string,
 *   currency: string,
 *   catLayers?: Array<object>,   // cat-covering layers; gates the apply button
 *   onApplyToCat?: (groundUpEqLoss: number) => void,
 *   disabled?: boolean,          // read-only / terminal contract states
 * }} props
 */
export default function GemDamageRatioPanel({
  contractId, currency, catLayers = [], onApplyToCat, disabled = false,
}) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [ready, setReady] = useState(false);          // scenario loaded → curve loads may run

  const [countryName, setCountryName] = useState(null); // contract's resolved country
  const [country, setCountry] = useState('');           // active curve-filter country
  const [countryDraft, setCountryDraft] = useState(''); // editable input, committed on blur/Enter
  const [zones, setZones] = useState([]);

  const [source, setSource] = useState('GEM');
  const [curvesBySlot, setCurvesBySlot] = useState({}); // slot → curve list
  const [curvesLoading, setCurvesLoading] = useState(false);
  const [curvesError, setCurvesError] = useState(null);

  const [assignments, setAssignments] = useState({});   // slot → curve id
  const [autoSlots, setAutoSlots] = useState(() => new Set()); // slots still on an auto-pick
  const [intensities, setIntensities] = useState({});   // IMT → number (string while editing)

  // Refs let the stable loadCurves callback read current scenario/auto state
  // without re-creating itself (and re-triggering the load effect).
  const savedScenarioRef = useRef(false);
  const autoSlotsRef = useRef(autoSlots);
  const assignmentsRef = useRef(assignments);
  useEffect(() => { autoSlotsRef.current = autoSlots; }, [autoSlots]);
  useEffect(() => { assignmentsRef.current = assignments; }, [assignments]);

  const [computing, setComputing] = useState(false);
  const [computeError, setComputeError] = useState(null);
  const [result, setResult] = useState(null);
  const [applied, setApplied] = useState(false);
  const [expanded, setExpanded] = useState(() => new Set()); // expanded zone ids

  // ── Mount: load the saved scenario + CRESTA zones + country. ──
  useEffect(() => {
    if (!contractId) { setLoading(false); return undefined; }
    let alive = true;
    setLoading(true);
    setLoadError(null);
    (async () => {
      try {
        const scn = await api.getGemScenario(contractId);
        if (!alive) return;
        const ctry = scn?.countryName || null;
        setCountryName(ctry);
        setCountry(ctry || '');
        setCountryDraft(ctry || '');
        setZones(Array.isArray(scn?.zones) ? scn.zones : []);

        const saved = scn?.scenario || null;
        savedScenarioRef.current = !!saved;
        if (saved) {
          // Source rides in curve_assignments.source (the engine ignores any
          // non-slot key); hydrate it so a reload restores the chosen provider.
          const savedAssign = saved.curve_assignments && typeof saved.curve_assignments === 'object'
            ? saved.curve_assignments : {};
          if (savedAssign.source === 'HAZUS') setSource('HAZUS');
          const hydrated = {};
          for (const meta of SLOTS) {
            if (savedAssign[meta.slot] != null) hydrated[meta.slot] = String(savedAssign[meta.slot]);
          }
          setAssignments(hydrated);

          if (saved.intensities && typeof saved.intensities === 'object') {
            const { byZone: _omit, source: _src, ...flat } = saved.intensities;
            setIntensities(flat);
          }
        }
      } catch (err) {
        if (alive) setLoadError(err?.message || 'Failed to load GEM exposure data.');
      } finally {
        if (alive) { setLoading(false); setReady(true); }
      }
    })();
    return () => { alive = false; };
  }, [contractId]);

  // ── Load all five curve lists; re-runs whenever source OR country changes. ──
  const loadCurves = useCallback(async (src, ctry) => {
    setCurvesLoading(true);
    setCurvesError(null);
    try {
      const results = await Promise.all(SLOTS.map(async (meta) => {
        const base = { occupancy: meta.occupancy, lossCategory: meta.lossCategory, source: src };
        let resp = await api.getGemCurves(ctry ? { ...base, country: ctry } : base);
        let list = Array.isArray(resp?.curves) ? resp.curves : [];
        // HAZUS fragility isn't country-specific — fall back to GENERIC when a
        // country-scoped query comes back empty.
        if (!list.length && src === 'HAZUS' && ctry && ctry !== HAZUS_FALLBACK_COUNTRY) {
          resp = await api.getGemCurves({ ...base, country: HAZUS_FALLBACK_COUNTRY });
          list = Array.isArray(resp?.curves) ? resp.curves : [];
        }
        return [meta.slot, list];
      }));
      const next = Object.fromEntries(results);
      setCurvesBySlot(next);
      // Reconcile assignments against the freshly loaded lists: keep any that
      // still resolve, drop the rest. With no saved scenario, seed each empty
      // slot with a deterministic representative curve from the current
      // source's list and flag it "(default)". We never auto-calculate.
      const prev = assignmentsRef.current;
      const out = {};
      const nextAuto = new Set();
      for (const meta of SLOTS) {
        const id = prev[meta.slot];
        const list = next[meta.slot] || [];
        if (id != null && list.some((c) => String(c.id) === String(id))) {
          out[meta.slot] = id;
          if (autoSlotsRef.current.has(meta.slot)) nextAuto.add(meta.slot);
        } else if (!savedScenarioRef.current) {
          const pick = pickDefaultCurve(list);
          if (pick) { out[meta.slot] = String(pick.id); nextAuto.add(meta.slot); }
        }
      }
      setAssignments(out);
      setAutoSlots(nextAuto);
    } catch (err) {
      setCurvesError(err?.message || 'Failed to load vulnerability curves.');
      setCurvesBySlot({});
    } finally {
      setCurvesLoading(false);
    }
  }, []);

  useEffect(() => {
    if (!ready || !contractId) return;
    loadCurves(source, country);
  }, [ready, contractId, source, country, loadCurves]);

  // IMTs needed by the currently assigned curves → one design-intensity input
  // each. PGA is always offered; SA(…) periods appear only when a chosen curve
  // uses them.
  const neededImts = useMemo(() => {
    const set = new Set(['PGA']);
    for (const meta of SLOTS) {
      const id = assignments[meta.slot];
      if (id == null) continue;
      const c = (curvesBySlot[meta.slot] || []).find((x) => String(x.id) === String(id));
      if (c?.imt) set.add(c.imt);
    }
    return [...set].sort((a, b) => (a === 'PGA' ? -1 : b === 'PGA' ? 1 : a.localeCompare(b)));
  }, [assignments, curvesBySlot]);

  const totalEqAgg = useMemo(() => zones.reduce((s, z) => s + toNum(z.eq_agg), 0), [zones]);

  const zoneChartData = useMemo(() => {
    if (!result?.byZone) return [];
    return result.byZone
      .filter((z) => toNum(z.zoneLoss) > 0)
      .map((z) => ({ name: z.zoneName || z.zoneId || '—', loss: Math.round(toNum(z.zoneLoss)) }));
  }, [result]);

  // True when HAZUS is active and any assigned curve is placeholder data.
  const hazusPlaceholderInUse = useMemo(() => {
    if (source !== 'HAZUS') return false;
    return SLOTS.some((meta) => {
      const id = assignments[meta.slot];
      if (id == null) return false;
      const c = (curvesBySlot[meta.slot] || []).find((x) => String(x.id) === String(id));
      return isHazusPlaceholderCurve(c);
    });
  }, [source, assignments, curvesBySlot]);

  const commitCountry = useCallback(() => {
    setCountry(countryDraft.trim());
  }, [countryDraft]);

  // Build the compute payload. `source` rides in curveAssignments so persisting
  // the scenario also persists the provider (the server engine ignores it).
  const buildBody = useCallback((persist) => ({
    curveAssignments: {
      ...Object.fromEntries(SLOTS
        .map((m) => [m.slot, assignments[m.slot]])
        .filter(([, v]) => v != null)),
      source,
    },
    intensities: Object.fromEntries(
      Object.entries(intensities).map(([k, v]) => [k, toNum(v)]).filter(([, v]) => v > 0),
    ),
    persist,
  }), [assignments, intensities, source]);

  const onCompute = useCallback(async (persist) => {
    setComputing(true);
    setComputeError(null);
    setApplied(false);
    try {
      const res = await api.computeGemEqLoss(contractId, buildBody(persist));
      setResult(res);
      setExpanded(new Set());
    } catch (err) {
      setComputeError(err?.message || 'Compute failed.');
      setResult(null);
    } finally {
      setComputing(false);
    }
  }, [contractId, buildBody]);

  const onApply = useCallback(() => {
    // Never push placeholder-derived HAZUS losses (or apply in a read-only /
    // no-cat-layer state) into cat pricing.
    if (!result || disabled || catLayers.length === 0
        || hazusPlaceholderInUse || typeof onApplyToCat !== 'function') return;
    onApplyToCat(toNum(result.groundUpEqLoss));
    setApplied(true);
  }, [result, disabled, catLayers, hazusPlaceholderInUse, onApplyToCat]);

  const toggleZone = useCallback((zid) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(zid)) next.delete(zid); else next.add(zid);
      return next;
    });
  }, []);

  if (!contractId) return null;

  return (
    <section className="np-final-section">
      <div className="np-final-section-head" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div className="np-final-section-title">EQ Damage Ratios</div>
        <span className="np-badge">EXPOSURE RATING</span>
        {countryName && <span style={{ fontSize: 11, color: 'rgba(226,232,240,0.55)' }}>{countryName}</span>}
        <div style={{ flex: 1 }} />
        {totalEqAgg > 0 && (
          <span style={{ fontSize: 11, color: 'rgba(226,232,240,0.55)' }}>
            EQ aggregate&nbsp;<b style={{ color: 'var(--accent)' }}>{money(totalEqAgg, currency)}</b>
          </span>
        )}
      </div>

      <div className="np-final-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
        {loading && <div className="muted" style={{ padding: 8 }}>Loading GEM exposure data…</div>}
        {loadError && <div style={{ color: 'var(--accent-rose)', fontSize: 12 }}>{loadError}</div>}

        {!loading && !loadError && zones.length === 0 && (
          <div className="muted" style={{ fontSize: 12 }}>
            Capture CRESTA EQ exposure for this contract first.
          </div>
        )}

        {!loading && !loadError && zones.length > 0 && (
          <>
            {/* ── Source + country controls ── */}
            <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, flexWrap: 'wrap' }}>
              <div>
                <span style={fieldLabel}>Curve source</span>
                <div style={{ display: 'inline-flex', border: '1px solid rgba(148,163,184,0.28)', borderRadius: 8, overflow: 'hidden' }}>
                  {SOURCES.map((s) => {
                    const on = source === s;
                    return (
                      <button
                        key={s}
                        type="button"
                        disabled={disabled}
                        onClick={() => setSource(s)}
                        style={{
                          padding: '6px 16px', fontSize: 11, fontWeight: 800, letterSpacing: '.04em',
                          border: 'none', cursor: disabled ? 'not-allowed' : 'pointer',
                          background: on ? 'rgba(var(--accent-rgb),0.22)' : 'transparent',
                          color: on ? 'var(--accent)' : 'rgba(226,232,240,0.62)',
                        }}
                        aria-pressed={on}
                      >
                        {s}
                      </button>
                    );
                  })}
                </div>
              </div>
              <label style={{ minWidth: 180 }}>
                <span style={fieldLabel}>Country filter</span>
                <input
                  type="text"
                  style={numInput}
                  value={countryDraft}
                  disabled={disabled}
                  placeholder="e.g. GENERIC"
                  onChange={(e) => setCountryDraft(e.target.value)}
                  onBlur={commitCountry}
                  onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); commitCountry(); } }}
                />
              </label>
              {curvesLoading && <span style={{ fontSize: 11, color: 'rgba(226,232,240,0.5)' }}>Loading curves…</span>}
              {curvesError && <span style={{ fontSize: 12, color: 'var(--accent-rose)' }}>{curvesError}</span>}
            </div>

            {/* HAZUS calibration caveat. */}
            {source === 'HAZUS' && (
              <div style={{
                fontSize: 11, lineHeight: 1.45, padding: '10px 12px', borderRadius: 8,
                color: 'var(--accent-amber)',
                background: 'rgba(var(--accent-amber-rgb),0.10)',
                border: '1px solid rgba(var(--accent-amber-rgb),0.35)',
              }}>
                HAZUS fragility is calibrated to US building types and design levels — confirm the
                model-building-type / design-level mapping before relying on it for non-US risk.
              </div>
            )}

            {/* Placeholder-data guard: seeded HAZUS curves are not pricing-valid. */}
            {hazusPlaceholderInUse && (
              <div style={{
                fontSize: 11, fontWeight: 700, lineHeight: 1.45, padding: '10px 12px', borderRadius: 8,
                color: 'var(--accent-rose)',
                background: 'rgba(var(--accent-rose-rgb),0.10)',
                border: '1px solid rgba(var(--accent-rose-rgb),0.40)',
              }}>
                ⚠ HAZUS curves loaded from placeholder parameters — not valid for pricing until
                replaced with FEMA Technical Manual values.
              </div>
            )}

            {/* ── Curve assignment per occupancy slot ── */}
            <div>
              <div style={{ ...sectionLabel, marginBottom: 8 }}>Vulnerability curve per occupancy</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
                {SLOTS.map((meta) => {
                  const list = curvesBySlot[meta.slot] || [];
                  return (
                    <label key={meta.slot}>
                      <span style={fieldLabel}>
                        {meta.label}
                        {autoSlots.has(meta.slot) && <span style={defaultTag}>(default)</span>}
                      </span>
                      <select
                        style={selectStyle}
                        value={assignments[meta.slot] ?? ''}
                        disabled={curvesLoading || disabled}
                        onChange={(e) => {
                          const v = e.target.value || undefined;
                          setAssignments((a) => {
                            const next = { ...a };
                            if (v == null) delete next[meta.slot]; else next[meta.slot] = v;
                            return next;
                          });
                          // A manual choice takes the slot off its auto-pick.
                          setAutoSlots((s) => {
                            if (!s.has(meta.slot)) return s;
                            const n = new Set(s);
                            n.delete(meta.slot);
                            return n;
                          });
                        }}
                      >
                        <option value="">— no curve —</option>
                        {list.map((c) => (
                          <option key={c.id} value={c.id}>{curveOptionLabel(c)}</option>
                        ))}
                      </select>
                    </label>
                  );
                })}
              </div>
            </div>

            {/* ── Design intensities ── */}
            <div>
              <div style={{ ...sectionLabel, marginBottom: 8 }}>Design intensity per IMT (g)</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 10 }}>
                {neededImts.map((imt) => (
                  <label key={imt}>
                    <span style={fieldLabel}>{imt}</span>
                    <input
                      type="text"
                      inputMode="decimal"
                      style={numInput}
                      disabled={disabled}
                      placeholder="e.g. 0.18"
                      value={intensities[imt] ?? ''}
                      onChange={(e) => {
                        const v = e.target.value.replace(/[^0-9.]/g, '');
                        setIntensities((m) => ({ ...m, [imt]: v }));
                      }}
                    />
                  </label>
                ))}
              </div>
              <div className="muted" style={{ fontSize: 10, marginTop: 6 }}>
                v1 applies one contract-level intensity set to every zone; per-zone / GEM-hazard
                lookup is a later enhancement.
              </div>
            </div>

            {/* ── Compute controls ── */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="np-btn np-btn--primary"
                style={{ minWidth: 140, fontWeight: 700 }}
                disabled={computing || curvesLoading || disabled}
                onClick={() => onCompute(false)}
              >
                {computing ? '⟳ Calculating…' : '⚡ Calculate'}
              </button>
              <button
                type="button"
                className="np-btn"
                style={{ fontWeight: 700 }}
                disabled={computing || curvesLoading || disabled}
                onClick={() => onCompute(true)}
              >
                Save scenario
              </button>
              {computeError && <span style={{ fontSize: 12, color: 'var(--accent-rose)' }}>{computeError}</span>}
            </div>

            {/* ── Results ── */}
            {result && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'stretch' }}>
                  <div style={{ ...card, padding: '12px 16px', flex: '1 1 220px' }}>
                    <div style={sectionLabel}>Ground-up EQ loss</div>
                    <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--accent)', marginTop: 4 }}>
                      {money(result.groundUpEqLoss, currency)}
                    </div>
                  </div>
                  <div style={{ ...card, padding: '12px 16px', flex: '1 1 200px' }}>
                    <div style={sectionLabel}>Effective mean damage ratio</div>
                    <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--accent-amber)', marginTop: 4 }}>
                      {pct(result.effectiveMdr)}
                    </div>
                  </div>
                  {typeof onApplyToCat === 'function' && (
                    <div style={{ ...card, padding: '12px 16px', flex: '1 1 200px', display: 'flex', flexDirection: 'column', justifyContent: 'center', gap: 8 }}>
                      <button
                        type="button"
                        className="np-btn np-btn--primary"
                        style={{ fontWeight: 700 }}
                        disabled={disabled || catLayers.length === 0 || hazusPlaceholderInUse}
                        onClick={onApply}
                        title={hazusPlaceholderInUse
                          ? 'HAZUS placeholder curves are not valid for pricing — replace them with FEMA Technical Manual values before applying to cat.'
                          : catLayers.length === 0
                            ? 'Add a cat-covering layer to apply the ground-up EQ loss.'
                            : 'Write the ground-up EQ loss into the cat burning-cost field'}
                      >
                        Apply to cat burning cost
                      </button>
                      {applied && (
                        <span data-testid="eq-applied" style={{ fontSize: 11, fontWeight: 700, color: 'var(--accent)' }}>
                          ✓ Applied to cat burning cost
                        </span>
                      )}
                    </div>
                  )}
                </div>

                {Array.isArray(result.warnings) && result.warnings.length > 0 && (
                  <div style={{
                    padding: '10px 12px', borderRadius: 8, fontSize: 11,
                    color: 'var(--accent-amber)',
                    background: 'rgba(var(--accent-amber-rgb),0.10)',
                    border: '1px solid rgba(var(--accent-amber-rgb),0.35)',
                  }}>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {result.warnings.map((w) => <li key={w}>{w}</li>)}
                    </ul>
                  </div>
                )}

                {/* Per-zone breakdown; rows expand to their occupancy buckets. */}
                {Array.isArray(result.byZone) && result.byZone.length > 0 && (
                  <div style={{ ...card, padding: '4px 4px 8px', overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 520 }}>
                      <thead>
                        <tr>
                          <th style={{ ...thStyle, textAlign: 'left' }}>Zone</th>
                          <th style={thStyle}>EQ aggregate</th>
                          <th style={thStyle}>Effective MDR</th>
                          <th style={thStyle}>Zone loss</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.byZone.map((z, i) => {
                          const zid = z.zoneId ?? `idx-${i}`;
                          const open = expanded.has(zid);
                          const buckets = Array.isArray(z.byBucket) ? z.byBucket : [];
                          return (
                            <ZoneRows
                              key={zid}
                              zone={z}
                              open={open}
                              buckets={buckets}
                              currency={currency}
                              onToggle={() => toggleZone(zid)}
                            />
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                )}

                {zoneChartData.length > 0 && (
                  <div style={{ ...card, padding: '10px 12px' }}>
                    <div style={{ ...sectionLabel, marginBottom: 6 }}>Ground-up EQ loss by CRESTA zone</div>
                    <ResponsiveContainer width="100%" height={200}>
                      <BarChart data={zoneChartData} margin={{ top: 6, right: 12, bottom: 4, left: 4 }}>
                        <CartesianGrid stroke={gridStroke} />
                        <XAxis dataKey="name" tick={axisTick} stroke={gridStroke} interval={0} angle={-20} textAnchor="end" height={48} />
                        <YAxis tick={axisTick} stroke={gridStroke} width={56} tickFormatter={(v) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(0)}K` : v)} />
                        <Tooltip contentStyle={tooltipStyle} formatter={(v) => money(Number(v), currency)} />
                        <Bar dataKey="loss" fill="var(--accent)" fillOpacity={0.65} isAnimationActive={false} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}

// Zone summary row + (when open) its per-bucket detail rows.
function ZoneRows({ zone, open, buckets, currency, onToggle }) {
  return (
    <>
      <tr onClick={onToggle} style={{ cursor: 'pointer' }}>
        <td style={{ ...tdStyle, textAlign: 'left', fontWeight: 700 }}>
          <span style={{ display: 'inline-block', width: 14, color: 'rgba(148,163,184,0.7)' }}>{open ? '▾' : '▸'}</span>
          {zone.zoneName || zone.zoneId || '—'}
        </td>
        <td style={tdStyle}>{money(zone.eqAgg, currency)}</td>
        <td style={{ ...tdStyle, color: 'var(--accent-amber)' }}>{pct(zone.effectiveMdr)}</td>
        <td style={{ ...tdStyle, fontWeight: 700 }}>{money(zone.zoneLoss, currency)}</td>
      </tr>
      {open && (
        <tr>
          <td colSpan={4} style={{ padding: '0 8px 8px 22px' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse' }}>
              <thead>
                <tr>
                  <th style={{ ...thStyle, textAlign: 'left' }}>Bucket</th>
                  <th style={thStyle}>Share</th>
                  <th style={thStyle}>TSI</th>
                  <th style={{ ...thStyle, textAlign: 'left' }}>Taxonomy</th>
                  <th style={thStyle}>IMT</th>
                  <th style={thStyle}>MDR</th>
                  <th style={thStyle}>Loss</th>
                </tr>
              </thead>
              <tbody>
                {buckets.map((b) => (
                  <tr key={b.bucket}>
                    <td style={{ ...tdStyle, textAlign: 'left' }}>{b.label}</td>
                    <td style={tdStyle}>{toNum(b.sharePct).toFixed(1)}%</td>
                    <td style={tdStyle}>{money(b.tsi, currency)}</td>
                    <td style={{ ...tdStyle, textAlign: 'left', color: 'rgba(226,232,240,0.6)' }}>{b.taxonomy || '—'}</td>
                    <td style={tdStyle}>{b.imt || '—'}</td>
                    <td style={tdStyle}>{pct(b.mdr)}</td>
                    <td style={tdStyle}>
                      {money(b.loss, currency)}
                      {b.note && (
                        <span style={{ marginLeft: 6, fontSize: 10, color: 'var(--accent-amber)' }}>({b.note})</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </td>
        </tr>
      )}
    </>
  );
}
