// components/EqDamageRatioPanel.jsx — GEM deterministic EQ exposure rating.
//
// Treaty-mode cat exposure-rating panel. Reads the contract's CRESTA EQ
// aggregates and the saved GEM scenario, lets the underwriter assign a GEM
// damage-ratio (vulnerability) curve to each occupancy slot and supply a
// design intensity per IMT, then asks the server to compute a ground-up
// expected EQ loss (Σ over zones of eq_agg · Σ bucket_share · MDR(intensity)).
//
// The result feeds the cat side: the effective mean damage ratio (a unitless
// rate) can be applied straight into a chosen cat layer's "Dmg Ratio" exposure
// cell (catExposure) or its Pure Burn cell (catPureBurn) — both ROL% inputs the
// reducer blends into the cat total. Mirrors the inline-style + CSS-variable
// theming used across the FQ pricing workbench.

import { useState, useEffect, useMemo, useCallback } from 'react';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip,
} from 'recharts';
import { api } from '../../../../api';
import { toN, money } from '../formatters.js';

// Occupancy slots carried per CRESTA-zone row, mirrored from the server's
// OCCUPANCY_BUCKETS. `occ` is the GEM taxonomy occupancy tail (RES/COM/IND);
// `kind` routes a slot to a building vs contents loss category.
const SLOTS = [
  { slot: 'residentialBldg', label: 'Residential — building', occ: 'RES', kind: 'bldg' },
  { slot: 'commercialBldg', label: 'Commercial — building', occ: 'COM', kind: 'bldg' },
  { slot: 'commercialCont', label: 'Commercial — contents', occ: 'COM', kind: 'cont' },
  { slot: 'industrialBldg', label: 'Industrial — building', occ: 'IND', kind: 'bldg' },
  { slot: 'industrialCont', label: 'Industrial — contents', occ: 'IND', kind: 'cont' },
];

const APPLY_TARGETS = [
  { field: 'catExposure', label: 'Exposure (Dmg Ratio)' },
  { field: 'catPureBurn', label: 'Pure Burn' },
];

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
const axisTick = { fontSize: 9, fill: 'rgba(148,163,184,0.7)' };
const grid = 'rgba(255,255,255,0.07)';
const tooltipStyle = { background: '#0b1526', border: '1px solid rgba(255,255,255,0.14)', borderRadius: 8, fontSize: 11 };

function curveLabel(c) {
  const pts = c.n_points ? ` · ${c.n_points}pt` : '';
  return `${c.taxonomy} · ${c.loss_category} · ${c.imt}${pts}`;
}

// Candidate curves for a slot: prefer the slot's occupancy class and
// building/contents loss category; fall back to the whole catalogue if the
// filter is empty so an unconventional set is still selectable.
function candidatesForSlot(meta, curveList) {
  const filtered = curveList.filter((c) => {
    const occOk = !c.occupancy || c.occupancy === meta.occ;
    const isContents = c.loss_category === 'contents';
    const kindOk = meta.kind === 'cont' ? isContents : !isContents;
    return occOk && kindOk;
  });
  return filtered.length ? filtered : curveList;
}

// Deterministic mid-complexity default for a slot: prefer PGA-based functions,
// sort the pool by a stable key (taxonomy → IMT → id) and take the median
// entry. No randomness — same catalogue always yields the same pick.
function pickDefaultCurve(meta, curveList) {
  const candidates = candidatesForSlot(meta, curveList);
  if (!candidates.length) return null;
  const pga = candidates.filter((c) => c.imt === 'PGA');
  const pool = pga.length ? pga : candidates;
  const sorted = [...pool].sort((a, b) => {
    const ka = `${a.taxonomy || ''}|${a.imt || ''}`;
    const kb = `${b.taxonomy || ''}|${b.imt || ''}`;
    if (ka !== kb) return ka < kb ? -1 : 1;
    return Number(a.id) - Number(b.id);
  });
  return sorted[Math.floor((sorted.length - 1) / 2)];
}

const defaultTag = { marginLeft: 6, fontSize: 9, fontWeight: 700, color: 'var(--accent)', opacity: 0.85 };

/**
 * @param {{
 *   contractId: string,
 *   layers: Array<object>,            // full pricing layers[] (for indexOf + apply)
 *   catLayers: Array<object>,         // layers.filter(l => l.cat)
 *   updateLayer: (idx:number, field:string, value:string) => void,
 *   currency: string,
 *   disabled?: boolean,
 * }} props
 */
export default function EqDamageRatioPanel({ contractId, layers, catLayers, updateLayer, currency, disabled = false }) {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState(null);
  const [countryName, setCountryName] = useState(null);
  const [zones, setZones] = useState([]);
  const [curves, setCurves] = useState([]);

  const [assignments, setAssignments] = useState({});   // slot → functionId
  const [autoSlots, setAutoSlots] = useState(() => new Set()); // slots still on auto-pick
  const [intensities, setIntensities] = useState({});    // IMT → number (string while editing)
  const [persist, setPersist] = useState(false);

  const [computing, setComputing] = useState(false);
  const [computeError, setComputeError] = useState(null);
  const [result, setResult] = useState(null);

  const [targetIdx, setTargetIdx] = useState(0);         // index into catLayers
  const [targetField, setTargetField] = useState('catExposure');

  // Load the saved scenario, the contract's CRESTA EQ zones, and the curve
  // catalogue (scoped to the contract's country) in parallel on mount.
  useEffect(() => {
    if (!contractId) { setLoading(false); return undefined; }
    let alive = true;
    setLoading(true);
    setLoadError(null);
    (async () => {
      try {
        const scn = await api.getGemScenario(contractId);
        if (!alive) return;
        const country = scn?.countryName || null;
        setCountryName(country);
        setZones(Array.isArray(scn?.zones) ? scn.zones : []);
        const saved = scn?.scenario || null;
        if (saved?.intensities && typeof saved.intensities === 'object') {
          const { byZone: _omit, ...flat } = saved.intensities;
          setIntensities(flat);
        }
        const cv = await api.getGemCurves(country ? { country } : {});
        if (!alive) return;
        const curveList = Array.isArray(cv?.curves) ? cv.curves : [];
        setCurves(curveList);

        const savedAssignments = saved?.curve_assignments && typeof saved.curve_assignments === 'object'
          ? saved.curve_assignments : null;
        if (savedAssignments && Object.keys(savedAssignments).length) {
          setAssignments(savedAssignments);
          setAutoSlots(new Set());
        } else {
          // No saved scenario — seed each slot with a deterministic
          // mid-complexity default curve so the UW starts from a sensible
          // pick rather than blanks. Flagged "(default)" until overridden;
          // we do NOT auto-calculate (the UW still presses Compute).
          const auto = {};
          const autoFlags = new Set();
          for (const meta of SLOTS) {
            const pick = pickDefaultCurve(meta, curveList);
            if (pick) { auto[meta.slot] = String(pick.id); autoFlags.add(meta.slot); }
          }
          setAssignments(auto);
          setAutoSlots(autoFlags);
        }
      } catch (err) {
        if (alive) setLoadError(err?.message || 'Failed to load GEM exposure data.');
      } finally {
        if (alive) setLoading(false);
      }
    })();
    return () => { alive = false; };
  }, [contractId]);

  const curveById = useMemo(() => {
    const m = new Map();
    for (const c of curves) m.set(String(c.id), c);
    return m;
  }, [curves]);

  const curvesForSlot = useCallback((meta) => candidatesForSlot(meta, curves), [curves]);

  // IMTs needed by the currently assigned curves → one design-intensity input each.
  const neededImts = useMemo(() => {
    const set = new Set();
    for (const meta of SLOTS) {
      const c = curveById.get(String(assignments[meta.slot]));
      if (c?.imt) set.add(c.imt);
    }
    return [...set];
  }, [assignments, curveById]);

  const totalEqAgg = useMemo(() => zones.reduce((s, z) => s + toN(z.eq_agg), 0), [zones]);

  const zoneChartData = useMemo(() => {
    if (!result?.byZone) return [];
    return result.byZone
      .filter((z) => toN(z.zoneLoss) > 0)
      .map((z) => ({ name: z.zoneName || z.zoneId || '—', loss: Math.round(toN(z.zoneLoss)) }));
  }, [result]);

  const onCompute = useCallback(async (doPersist) => {
    setComputing(true);
    setComputeError(null);
    try {
      const body = {
        curveAssignments: assignments,
        intensities: Object.fromEntries(
          Object.entries(intensities).filter(([, v]) => toN(v) > 0).map(([k, v]) => [k, toN(v)]),
        ),
        persist: !!doPersist,
      };
      const res = await api.computeGemEqLoss(contractId, body);
      setResult(res);
    } catch (err) {
      setComputeError(err?.message || 'Compute failed.');
      setResult(null);
    } finally {
      setComputing(false);
    }
  }, [assignments, intensities, contractId]);

  // Apply the effective mean damage ratio (a unitless rate) into the chosen cat
  // layer's chosen ROL% cell. The reducer recomputes the blended cat total.
  const onApply = useCallback(() => {
    if (!result || disabled) return;
    const layer = catLayers[targetIdx];
    if (!layer) return;
    const gi = layers.indexOf(layer);
    if (gi < 0) return;
    const ratioPct = toN(result.effectiveMdr) * 100;
    updateLayer(gi, targetField, `${ratioPct.toFixed(2)}%`);
  }, [result, disabled, catLayers, targetIdx, layers, targetField, updateLayer]);

  if (!contractId) return null;

  return (
    <section className="np-final-section">
      <div className="np-final-section-head" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div className="np-final-section-title">EQ Damage Ratio</div>
        <span className="np-badge">GEM EXPOSURE</span>
        {countryName && (
          <span style={{ fontSize: 11, color: 'rgba(226,232,240,0.55)' }}>{countryName}</span>
        )}
        <div style={{ flex: 1 }} />
        {totalEqAgg > 0 && (
          <span style={{ fontSize: 11, color: 'rgba(226,232,240,0.55)' }}>
            EQ aggregate&nbsp;<b style={{ color: 'var(--accent)' }}>{money(totalEqAgg, currency)}</b>
          </span>
        )}
      </div>

      <div className="np-final-card" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 16 }}>
        {loading && <div className="muted" style={{ padding: 8 }}>Loading GEM exposure data…</div>}
        {loadError && <div style={{ color: '#f87171', fontSize: 12 }}>{loadError}</div>}

        {!loading && !loadError && zones.length === 0 && (
          <div className="muted" style={{ fontSize: 12 }}>
            No CRESTA earthquake exposure captured for this contract — add zone EQ aggregates on the CRESTA screen to enable damage-ratio rating.
          </div>
        )}

        {!loading && !loadError && zones.length > 0 && (
          <>
            {/* ── Curve assignment ── */}
            <div>
              <div style={{ ...sectionLabel, marginBottom: 8 }}>Vulnerability curve per occupancy</div>
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
                {SLOTS.map((meta) => (
                  <label key={meta.slot}>
                    <span style={fieldLabel}>
                      {meta.label}
                      {autoSlots.has(meta.slot) && <span style={defaultTag}>(default)</span>}
                    </span>
                    <select
                      style={selectStyle}
                      disabled={disabled}
                      value={assignments[meta.slot] ?? ''}
                      onChange={(e) => {
                        const v = e.target.value || undefined;
                        setAssignments((a) => ({ ...a, [meta.slot]: v }));
                        // Any manual change takes the slot off its auto-pick.
                        setAutoSlots((s) => {
                          if (!s.has(meta.slot)) return s;
                          const next = new Set(s);
                          next.delete(meta.slot);
                          return next;
                        });
                      }}
                    >
                      <option value="">— none —</option>
                      {curvesForSlot(meta).map((c) => (
                        <option key={c.id} value={c.id}>{curveLabel(c)}</option>
                      ))}
                    </select>
                  </label>
                ))}
              </div>
            </div>

            {/* ── Design intensities ── */}
            <div>
              <div style={{ ...sectionLabel, marginBottom: 8 }}>Design intensity per IMT</div>
              {neededImts.length === 0 ? (
                <div className="muted" style={{ fontSize: 11 }}>Assign a curve above to set its design intensity.</div>
              ) : (
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
              )}
            </div>

            {/* ── Compute controls ── */}
            <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
              <button
                type="button"
                className="np-btn np-btn--primary"
                style={{ minWidth: 150, fontWeight: 700 }}
                disabled={computing || disabled || neededImts.length === 0}
                onClick={() => onCompute(persist)}
              >
                {computing ? '⟳ Computing…' : '⚡ Compute EQ Loss'}
              </button>
              <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11, color: 'rgba(226,232,240,0.62)' }}>
                <input type="checkbox" checked={persist} disabled={disabled} onChange={(e) => setPersist(e.target.checked)} />
                Save scenario
              </label>
              {computeError && <span style={{ fontSize: 12, color: '#f87171' }}>{computeError}</span>}
            </div>

            {/* ── Results ── */}
            {result && (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ ...card, padding: '12px 16px', flex: '1 1 200px' }}>
                    <div style={sectionLabel}>Ground-up EQ loss</div>
                    <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--accent)', marginTop: 4 }}>
                      {money(result.groundUpEqLoss, currency)}
                    </div>
                  </div>
                  <div style={{ ...card, padding: '12px 16px', flex: '1 1 200px' }}>
                    <div style={sectionLabel}>Effective mean damage ratio</div>
                    <div style={{ fontSize: 20, fontWeight: 800, color: 'var(--accent-amber)', marginTop: 4 }}>
                      {(toN(result.effectiveMdr) * 100).toFixed(2)}%
                    </div>
                  </div>
                </div>

                {Array.isArray(result.warnings) && result.warnings.length > 0 && (
                  <ul style={{ margin: 0, paddingLeft: 18, fontSize: 11, color: '#fbbf24' }}>
                    {result.warnings.map((w) => <li key={w}>{w}</li>)}
                  </ul>
                )}

                {zoneChartData.length > 0 && (
                  <div style={{ ...card, padding: '10px 12px' }}>
                    <div style={{ ...sectionLabel, marginBottom: 6 }}>Ground-up EQ loss by CRESTA zone</div>
                    <ResponsiveContainer width="100%" height={200}>
                      <BarChart data={zoneChartData} margin={{ top: 6, right: 12, bottom: 4, left: 4 }}>
                        <CartesianGrid stroke={grid} />
                        <XAxis dataKey="name" tick={axisTick} stroke={grid} interval={0} angle={-20} textAnchor="end" height={48} />
                        <YAxis tick={axisTick} stroke={grid} width={56} tickFormatter={(v) => (v >= 1e6 ? `${(v / 1e6).toFixed(1)}M` : v >= 1e3 ? `${(v / 1e3).toFixed(0)}K` : v)} />
                        <Tooltip contentStyle={tooltipStyle} formatter={(v) => money(Number(v), currency)} />
                        <Bar dataKey="loss" fill="var(--accent)" fillOpacity={0.65} isAnimationActive={false} />
                      </BarChart>
                    </ResponsiveContainer>
                  </div>
                )}

                {/* ── Apply to cat pricing ── */}
                <div style={{ ...card, padding: '12px 16px', display: 'flex', alignItems: 'flex-end', gap: 12, flexWrap: 'wrap' }}>
                  <label style={{ flex: '1 1 160px' }}>
                    <span style={fieldLabel}>Apply to cat layer</span>
                    <select style={selectStyle} disabled={disabled} value={targetIdx} onChange={(e) => setTargetIdx(Number(e.target.value))}>
                      {catLayers.map((l, i) => (
                        <option key={l.layer ?? i} value={i}>{`Layer ${l.layer ?? i + 1}`}</option>
                      ))}
                    </select>
                  </label>
                  <label style={{ flex: '1 1 160px' }}>
                    <span style={fieldLabel}>Target field</span>
                    <select style={selectStyle} disabled={disabled} value={targetField} onChange={(e) => setTargetField(e.target.value)}>
                      {APPLY_TARGETS.map((t) => <option key={t.field} value={t.field}>{t.label}</option>)}
                    </select>
                  </label>
                  <button
                    type="button"
                    className="np-btn np-btn--primary"
                    style={{ minWidth: 150, fontWeight: 700 }}
                    disabled={disabled || catLayers.length === 0}
                    onClick={onApply}
                    title={`Write ${(toN(result.effectiveMdr) * 100).toFixed(2)}% into the selected cat layer cell`}
                  >
                    Apply {(toN(result.effectiveMdr) * 100).toFixed(2)}%
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>
    </section>
  );
}
