import { useState, useEffect, useMemo, useRef } from 'react';
import { api, HttpError } from '../../api';
import { formatWithCommas } from '../../utils/format';
import { fqFitPowerLaw, fqGeomean } from '../non_proportional/final_pricing/fqHelpers.js';
// benchmark.css is not in the global bundle (it ships with the NP final-pricing
// / QuickBenchmark screens), so the bm-modal* / bm-pill theme classes this modal
// reuses must be imported here for it to render styled when opened from Home.
import '../benchmark/benchmark.css';

/* ─── Reinsurer Analysis Modal ───
   Portfolio-wide implied pricing-curve view. For each selected lead reinsurer we
   fit a single power-law curve y = a·x^b over its NP layers (one point per layer,
   x = √((L+A)·A) / EGNPI, y = ROL fraction) and compare each against a Global
   curve fitted over the entire filtered pool across all reinsurers. The pool can
   be sliced by class of business, NP treaty type, country, and region via the
   dropdown selectors. Data comes from /api/reinsurer-analysis; the curve maths
   reuse fqHelpers and the visual language mirrors FQScopeCurvePanel /
   FQBenchmarkModal. */

// Up to six reinsurers can be drawn at once; one palette colour each.
const PALETTE = ['#00d4ff', '#a78bfa', '#4ade80', '#f59e0b', '#f472b6', '#facc15'];
const MAX_SELECTED = 6;
const GLOBAL_COLOR = 'rgba(226,232,240,0.78)';

const sectionStyle = {
  background: 'rgba(8,14,30,0.62)',
  border: '1px solid rgba(255,255,255,0.09)',
  borderRadius: 12,
  padding: 14,
  boxShadow: '0 1px 0 rgba(255,255,255,0.035) inset',
  flex: '0 0 auto',
};
const sectionTitleStyle = {
  fontSize: 11,
  fontWeight: 850,
  letterSpacing: '.14em',
  color: 'rgba(148,163,184,0.72)',
  textTransform: 'uppercase',
  marginBottom: 10,
};
const thStyle = {
  padding: '8px 10px',
  fontSize: 9,
  fontWeight: 850,
  letterSpacing: '.11em',
  color: 'rgba(148,163,184,0.68)',
  textTransform: 'uppercase',
  borderBottom: '1px solid rgba(255,255,255,0.08)',
  whiteSpace: 'nowrap',
};
const tdStyle = {
  padding: '7px 8px',
  verticalAlign: 'middle',
  fontVariantNumeric: 'tabular-nums',
};

const fmt = (n) => (n > 0 ? formatWithCommas(Math.round(n)) : '—');
const fmtPct = (n) => (Number.isFinite(n) && n > 0 ? `${n.toFixed(2)}%` : '—');
const fmtCoef = (v) => (Number.isFinite(v) ? (Math.abs(v) >= 0.01 ? v.toFixed(4) : v.toExponential(2)) : '—');
const fmtR2 = (v) => (v == null ? '—' : v.toFixed(3));
const eqStr = (a, b) => `y = ${fmtCoef(a)} · x^${Number.isFinite(b) ? b.toFixed(3) : '—'}`;
// ROL the fitted curve predicts at a given x, in percent.
const rolAt = (fit, x) => (fit ? fit.a * Math.pow(x, fit.b) * 100 : 0);

// ── Reusable dropdown: a bm-pill trigger + an absolutely-positioned popover
//    that closes on outside-click. Open/closed is controlled by the parent so
//    Escape can close the active dropdown before the modal itself. ──
function Dropdown({ open, onToggle, onClose, label, popoverWidth = 220, children }) {
  const ref = useRef(null);
  useEffect(() => {
    if (!open) return undefined;
    const onDown = (e) => { if (ref.current && !ref.current.contains(e.target)) onClose(); };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open, onClose]);
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button className="bm-pill" onClick={onToggle}
        style={{ display: 'inline-flex', alignItems: 'center', gap: 8, ...(open ? { borderColor: 'rgba(0,212,255,0.55)', color: '#00d4ff' } : undefined) }}>
        {label}
        <span style={{ fontSize: 9, opacity: 0.7 }}>▾</span>
      </button>
      {open && (
        <div style={{
          position: 'absolute', top: 'calc(100% + 6px)', left: 0, zIndex: 50,
          width: popoverWidth, maxWidth: '90vw',
          background: 'rgba(10,16,32,0.98)', border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: 10, boxShadow: '0 12px 32px rgba(0,0,0,0.45)', padding: 8,
        }}>
          {children}
        </div>
      )}
    </div>
  );
}

// Single-select option list shared by the COB and treaty-type dropdowns.
function OptionList({ options, value, onPick }) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 2, maxHeight: 280, overflowY: 'auto' }}>
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button key={o.value} onClick={() => onPick(o.value)}
            style={{
              appearance: 'none', textAlign: 'left', padding: '7px 10px', borderRadius: 7,
              border: '1px solid transparent', cursor: 'pointer', fontSize: 12, fontWeight: 600,
              background: active ? 'rgba(0,212,255,0.12)' : 'transparent',
              color: active ? '#00d4ff' : 'rgba(226,232,240,0.85)',
            }}>
            {active ? '✓ ' : ''}{o.label}
          </button>
        );
      })}
    </div>
  );
}

export default function ReinsurerAnalysisModal({ open, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [selected, setSelected] = useState(() => new Set()); // reinsurer names
  const [cobFilter, setCobFilter] = useState('all');
  const [ttFilter, setTtFilter] = useState('all');
  const [countryFilter, setCountryFilter] = useState('all');
  const [regionFilter, setRegionFilter] = useState('all');
  const [openKey, setOpenKey] = useState(null);   // 'reinsurer' | 'cob' | 'type' | 'country' | 'region' | null
  const [reinsurerSearch, setReinsurerSearch] = useState('');
  const [sortKey, setSortKey] = useState('limit');
  const [sortDir, setSortDir] = useState('desc');
  const [logScale, setLogScale] = useState(true);

  // Mounted guard so a close mid-flight can't set state after unmount.
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);

  // Fetch the portfolio pool once per open. Default-selects the top 3
  // reinsurers by treaty count so the modal opens with something on-screen.
  useEffect(() => {
    if (!open) return undefined;
    let cancelled = false;
    setLoading(true);
    setError('');
    setData(null);
    setCobFilter('all');
    setTtFilter('all');
    setCountryFilter('all');
    setRegionFilter('all');
    setOpenKey(null);
    setReinsurerSearch('');
    api.getReinsurerAnalysis()
      .then((res) => {
        if (cancelled || !mountedRef.current) return;
        setData(res);
        const top = (Array.isArray(res?.reinsurers) ? res.reinsurers : []).slice(0, 3).map((r) => r.name);
        setSelected(new Set(top));
      })
      .catch((err) => {
        if (cancelled || !mountedRef.current) return;
        const message = err instanceof HttpError && err.body?.error
          ? err.body.error
          : (err?.message || 'Failed to load reinsurer analysis');
        setError(message);
      })
      .finally(() => { if (!cancelled && mountedRef.current) setLoading(false); });
    return () => { cancelled = true; };
  }, [open]);

  // Escape closes the active dropdown first, then the modal.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => {
      if (e.key !== 'Escape') return;
      if (openKey) { setOpenKey(null); return; }
      onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, openKey, onClose]);

  // Memoised because it feeds every downstream useMemo (eslint deps).
  const points = useMemo(() => data?.points || [], [data]);
  const reinsurers = useMemo(() => (Array.isArray(data?.reinsurers) ? data.reinsurers : []), [data]);
  const cobs = useMemo(() => (Array.isArray(data?.cobs) ? data.cobs : []), [data]);
  const treatyTypes = useMemo(() => (Array.isArray(data?.treatyTypes) ? data.treatyTypes : []), [data]);
  const countries = useMemo(() => (Array.isArray(data?.countries) ? data.countries : []), [data]);
  const regions = useMemo(() => (Array.isArray(data?.regions) ? data.regions : []), [data]);

  // Layer → (x, y) for the power-law fit, keeping the row fields for scatter +
  // the underlying-treaty roll-up. Drop anything that can't sit on a log curve.
  const mapped = useMemo(() => points.map((p) => {
    const x = fqGeomean(Number(p.limit), Number(p.attachment)) / Number(p.egnpi);
    const y = (Number(p.rolPct) || 0) / 100;
    if (!(x > 0) || !(y > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { ...p, x, y };
  }).filter(Boolean), [points]);

  // A COB filter matches a point when its parent treaty carries that class
  // (cobs[]), so a multi-COB treaty shows under each of its classes. The Global
  // curve fits this pool across ALL reinsurers (it ignores the selection).
  const filtered = useMemo(() => mapped.filter((p) => {
    if (cobFilter !== 'all' && !(Array.isArray(p.cobs) ? p.cobs : []).includes(cobFilter)) return false;
    if (ttFilter !== 'all' && p.treatyType !== ttFilter) return false;
    if (countryFilter !== 'all' && p.country !== countryFilter) return false;
    if (regionFilter !== 'all' && p.region !== regionFilter) return false;
    return true;
  }), [mapped, cobFilter, ttFilter, countryFilter, regionFilter]);

  // Stable, ranked order for the selected reinsurers so colours don't reshuffle
  // as the user ticks rows on and off.
  const selectedList = useMemo(
    () => reinsurers.filter((r) => selected.has(r.name)).map((r) => r.name),
    [reinsurers, selected],
  );

  // Global baseline: one fit over the entire filtered pool (all reinsurers).
  const globalFit = useMemo(() => fqFitPowerLaw(filtered), [filtered]);
  const globalTreaties = useMemo(() => new Set(filtered.map((p) => p.contractId)).size, [filtered]);

  // Per-reinsurer fitted series (curve + its own scatter + counts).
  const series = useMemo(() => selectedList.map((name, i) => {
    const pts = filtered.filter((p) => p.reinsurer === name);
    return {
      key: name,
      label: name,
      color: PALETTE[i % PALETTE.length],
      fit: fqFitPowerLaw(pts),
      pts,
      treaties: new Set(pts.map((p) => p.contractId)).size,
      layers: pts.length,
    };
  }), [selectedList, filtered]);

  // Global series object — always present in legend / equation cards / table.
  const globalSeries = {
    key: '__global__', label: 'Global (all reinsurers)', color: GLOBAL_COLOR, fit: globalFit,
    pts: filtered, treaties: globalTreaties, layers: filtered.length, isGlobal: true,
  };
  const allSeries = [...series, globalSeries];

  // ── Chart geometry: log–log by default so the power-law y = a·x^b reads as a
  //    straight line. On linear axes the steep small-x arm collapses every curve
  //    into the bottom-left corner and the reinsurer lines overlap. ──
  const PX0 = 8; const PX1 = 98; const PY0 = 6; const PY1 = 66;
  const lg = (v) => Math.log10(Math.max(v, 1e-9));

  // DATA x-range from the scatter points — fitted curves are sampled across it.
  const xsData = filtered.map((p) => p.x);
  const ysData = filtered.map((p) => p.y);
  const xLoData = xsData.length ? Math.min(...xsData) : 1e-3;
  const xHiData = xsData.length ? Math.max(...xsData) : 1;

  const sampleCurve = (fit) => {
    if (!fit || !Number.isFinite(fit.a) || !Number.isFinite(fit.b) || fit.a <= 0) return [];
    const lo = Math.max(xLoData, 1e-9);
    const hi = Math.max(xHiData, lo * 1.0001);
    const out = [];
    const STEPS = 60;
    for (let i = 0; i <= STEPS; i += 1) {
      const t = i / STEPS;
      // Geometric stepping in log mode keeps samples even across the decades.
      const x = logScale ? lo * Math.pow(hi / lo, t) : lo + (hi - lo) * t;
      const y = fit.a * Math.pow(x, fit.b);
      if (x > 0 && y > 0 && Number.isFinite(y)) out.push({ x, y });
    }
    return out;
  };
  // Global drawn first (underneath), then each reinsurer curve.
  const sampled = [globalSeries, ...series].map((s) => ({ s, pts: sampleCurve(s.fit) }));
  const curvePts = sampled.flatMap((c) => c.pts);

  // Chart domain spans BOTH scatter + sampled-curve points so the steep small-x
  // arm of the power law never clips off the top of the plot.
  const allX = [...xsData, ...curvePts.map((p) => p.x)];
  const allY = [...ysData, ...curvePts.map((p) => p.y)];
  const xMinRaw = allX.length ? Math.min(...allX) : 1e-3;
  const xMaxRaw = allX.length ? Math.max(...allX) : 1;
  const yMinRaw = allY.length ? Math.min(...allY) : 1e-3;
  const yMaxRaw = allY.length ? Math.max(...allY) : 0.5;

  // Pad generously (multiplicative) in log mode; lightly in linear mode.
  const xLo = logScale ? xMinRaw / 1.15 : xMinRaw / 1.02;
  const xHi = logScale ? xMaxRaw * 1.15 : xMaxRaw * 1.02;
  const yHi = logScale ? yMaxRaw * 1.25 : yMaxRaw * 1.12;
  const yLo = logScale ? yMinRaw / 1.25 : 0;

  const X = (v) => {
    if (logScale) {
      const a = lg(xLo); const b = lg(xHi);
      return PX0 + ((lg(v) - a) / ((b - a) || 1)) * (PX1 - PX0);
    }
    return PX0 + ((v - xLo) / ((xHi - xLo) || 1)) * (PX1 - PX0);
  };
  const Y = (v) => {
    if (logScale) {
      const a = lg(yLo); const b = lg(yHi);
      return PY1 - ((lg(v) - a) / ((b - a) || 1)) * (PY1 - PY0);
    }
    return PY1 - ((v - yLo) / ((yHi - yLo) || 1)) * (PY1 - PY0);
  };

  // Axis ticks: 1·2·5 per decade within range in log mode, even divisions
  // (n steps) in linear mode.
  const logTicks = (lo, hi) => {
    const out = [];
    for (let d = Math.floor(lg(lo)); d <= Math.ceil(lg(hi)); d += 1) {
      for (const m of [1, 2, 5]) {
        const v = m * (10 ** d);
        if (v >= lo * 0.999 && v <= hi * 1.001) out.push(v);
      }
    }
    return out;
  };
  const linTicks = (lo, hi, n = 5) => {
    const step = (hi - lo) / n || 1;
    return Array.from({ length: n + 1 }, (_, i) => lo + step * i);
  };
  const xTicks = logScale ? logTicks(xLo, xHi) : linTicks(xLo, xHi);
  const yTicks = logScale ? logTicks(yLo, yHi) : linTicks(Math.max(yLo, 0), yHi);

  // The SVG uses preserveAspectRatio="none", so any in-SVG <text> would stretch
  // horizontally. Labels are rendered as an HTML overlay positioned in wrapper
  // %; convert viewBox coords (100 wide × 72 tall) → percentages.
  const pctX = (vb) => vb;                 // viewBox x is already 0..100
  const pctY = (vb) => (vb / 72) * 100;
  const fmtTickX = (v) => `${Number(v.toPrecision(2))}`;   // ~2 significant digits
  const fmtTickY = (v) => `${Number((v * 100).toPrecision(2))}%`; // ROL %

  // ── Underlying treaties, rolled up from the selected reinsurers' layers ──
  const treatyRows = useMemo(() => {
    const map = new Map();
    for (const p of filtered) {
      if (!selected.has(p.reinsurer)) continue;
      let row = map.get(p.contractId);
      if (!row) {
        row = {
          id: p.contractId, reinsurer: p.reinsurer, cedant: p.cedant || 'Unknown',
          country: p.country || '—', uwYear: p.uwYear, treatyType: p.treatyType || '—',
          limit: 0, attachment: Infinity, egnpi: 0, _wRolNum: 0, layers: 0,
        };
        map.set(p.contractId, row);
      }
      const limit = Number(p.limit) || 0;
      row.limit += limit;
      row.attachment = Math.min(row.attachment, Number(p.attachment) || Infinity);
      row.egnpi += Number(p.egnpi) || 0;
      row._wRolNum += limit * (Number(p.rolPct) || 0);
      row.layers += 1;
    }
    return Array.from(map.values()).map((r) => ({
      ...r,
      attachment: Number.isFinite(r.attachment) ? r.attachment : 0,
      rolPct: r.limit > 0 ? r._wRolNum / r.limit : 0,
    }));
  }, [filtered, selected]);

  const sortedTreaties = useMemo(() => {
    const textKeys = new Set(['reinsurer', 'cedant', 'country', 'treatyType']);
    return [...treatyRows].sort((a, b) => {
      const av = textKeys.has(sortKey) ? (a[sortKey] || '') : (a[sortKey] || 0);
      const bv = textKeys.has(sortKey) ? (b[sortKey] || '') : (b[sortKey] || 0);
      if (av < bv) return sortDir === 'asc' ? -1 : 1;
      if (av > bv) return sortDir === 'asc' ? 1 : -1;
      return 0;
    });
  }, [treatyRows, sortKey, sortDir]);

  // Reinsurer rows shown in the dropdown, filtered by the search box.
  const reinsurerMatches = useMemo(() => {
    const q = reinsurerSearch.trim().toLowerCase();
    return q ? reinsurers.filter((r) => r.name.toLowerCase().includes(q)) : reinsurers;
  }, [reinsurers, reinsurerSearch]);

  if (!open) return null;

  const atCap = selected.size >= MAX_SELECTED;
  const toggleReinsurer = (name) => setSelected((prev) => {
    const n = new Set(prev);
    if (n.has(name)) n.delete(name);
    else if (n.size < MAX_SELECTED) n.add(name);
    return n;
  });
  // Select all = fill up to the cap from the currently-filtered (ranked) list.
  const selectAll = () => setSelected(() => new Set(reinsurerMatches.slice(0, MAX_SELECTED).map((r) => r.name)));
  const clearAll = () => setSelected(new Set());

  const headerSort = (k) => () => {
    if (sortKey === k) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else { setSortKey(k); setSortDir('desc'); }
  };
  const sortArrow = (k) => (sortKey === k ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');

  const colorOf = (name) => {
    const idx = selectedList.indexOf(name);
    return idx >= 0 ? PALETTE[idx % PALETTE.length] : 'rgba(148,163,184,0.55)';
  };

  // Directional delta of a reinsurer's ROL @ x=0.10 vs the Global baseline.
  const globalRol10 = rolAt(globalFit, 0.10);
  const vsGlobal = (fit) => {
    const r = rolAt(fit, 0.10);
    if (!(globalRol10 > 0) || !(r > 0)) return null;
    const pct = ((r - globalRol10) / globalRol10) * 100;
    if (Math.abs(pct) < 0.05) return { flat: true };
    const above = r > globalRol10;
    return { arrow: above ? '▲' : '▼', color: above ? '#f87171' : '#23d18b', text: `${Math.abs(pct).toFixed(1)}%` };
  };

  const metricRows = [
    { k: 'a', label: 'a coefficient', cell: (s) => fmtCoef(s.fit.a) },
    { k: 'b', label: 'b exponent', cell: (s) => fmtCoef(s.fit.b) },
    { k: 'r2', label: 'R²', cell: (s) => fmtR2(s.fit.r2) },
    { k: 'treaties', label: 'Treaties', cell: (s) => `${s.treaties}` },
    { k: 'layers', label: 'Layers', cell: (s) => `${s.layers}` },
    { k: 'cal', label: 'Calibrated', cell: (s) => (s.fit.calibrated ? '✓' : '— (market default)') },
    { k: 'rol05', label: 'ROL @ x = 0.05', cell: (s) => `${rolAt(s.fit, 0.05).toFixed(2)}%` },
    { k: 'rol10', label: 'ROL @ x = 0.10', cell: (s) => `${rolAt(s.fit, 0.10).toFixed(2)}%` },
    { k: 'rol20', label: 'ROL @ x = 0.20', cell: (s) => `${rolAt(s.fit, 0.20).toFixed(2)}%` },
  ];

  const treatyCols = [
    { k: 'reinsurer', label: 'Reinsurer', align: 'left' },
    { k: 'cedant', label: 'Cedant', align: 'left' },
    { k: 'country', label: 'Country', align: 'left' },
    { k: 'treatyType', label: 'Treaty Type', align: 'left' },
    { k: 'uwYear', label: 'UW Year', align: 'right' },
    { k: 'limit', label: 'Total Limit', align: 'right' },
    { k: 'attachment', label: 'Min Attach', align: 'right' },
    { k: 'egnpi', label: 'Total EGNPI', align: 'right' },
    { k: 'rolPct', label: 'Wtd ROL %', align: 'right' },
    { k: 'layers', label: 'Layers', align: 'right' },
  ];

  const cobOptions = [{ value: 'all', label: 'All COBs' }, ...cobs.map((c) => ({ value: c, label: c }))];
  const ttOptions = [{ value: 'all', label: 'All Types' }, ...treatyTypes.map((t) => ({ value: t, label: t }))];
  const countryOptions = [{ value: 'all', label: 'All Countries' }, ...countries.map((c) => ({ value: c, label: c }))];
  const regionOptions = [{ value: 'all', label: 'All Regions' }, ...regions.map((r) => ({ value: r, label: r }))];

  return (
    <div className="bm-modal-backdrop" role="presentation" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bm-modal" style={{ width: '100vw', maxWidth: '100vw', height: '100dvh', maxHeight: '100dvh', borderRadius: 0, display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)' }}>
        {/* Header */}
        <div className="bm-modal-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div>Reinsurer Analysis · Implied Pricing Curves</div>
            <div style={{ fontSize: 11, fontWeight: 500, color: 'rgba(148,163,184,0.55)', marginTop: 2 }}>
              y = a·x^b per lead reinsurer vs Global · x = √((L+A)·A) / EGNPI · y = ROL %
            </div>
          </div>
          <button className="bm-pill" onClick={onClose}>Close</button>
        </div>

        <div className="bm-modal-body" style={{ minHeight: 0, height: '100%', maxHeight: 'none', overflowY: 'auto', overflowX: 'hidden', display: 'flex', flexDirection: 'column', gap: 16, padding: '20px 28px' }}>
          {loading && (
            <div style={{ fontSize: 13, color: 'rgba(148,163,184,0.7)', padding: 40, textAlign: 'center' }}>Loading reinsurer pricing pool…</div>
          )}
          {!loading && error && (
            <div style={{ fontSize: 13, color: '#f87171', padding: 40, textAlign: 'center' }}>Failed to load — {error}</div>
          )}
          {!loading && !error && points.length === 0 && (
            <div style={{ fontSize: 13, color: 'rgba(148,163,184,0.7)', padding: 40, textAlign: 'center' }}>No NP treaties carry a lead reinsurer yet.</div>
          )}

          {!loading && !error && points.length > 0 && (
            <>
              {/* Controls — three dropdown selectors in a row */}
              <section style={{ ...sectionStyle, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'flex-start' }}>
                <div>
                  <div style={{ fontSize: 9, fontWeight: 850, letterSpacing: '.12em', color: 'rgba(148,163,184,0.6)', textTransform: 'uppercase', marginBottom: 5 }}>Reinsurer</div>
                  <Dropdown
                    label={`${selected.size} selected`} popoverWidth={300}
                    open={openKey === 'reinsurer'}
                    onToggle={() => setOpenKey((k) => (k === 'reinsurer' ? null : 'reinsurer'))}
                    onClose={() => setOpenKey((k) => (k === 'reinsurer' ? null : k))}
                  >
                    <input
                      type="text" value={reinsurerSearch} placeholder="Search reinsurers…"
                      onChange={(e) => setReinsurerSearch(e.target.value)}
                      style={{ width: '100%', boxSizing: 'border-box', padding: '7px 9px', marginBottom: 6, fontSize: 12, color: 'rgba(226,232,240,0.9)', background: 'rgba(5,8,16,0.7)', border: '1px solid rgba(255,255,255,0.12)', borderRadius: 7, outline: 'none' }}
                    />
                    <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
                      <button className="bm-pill" onClick={selectAll} style={{ flex: 1, fontSize: 10 }}>Select all</button>
                      <button className="bm-pill" onClick={clearAll} style={{ flex: 1, fontSize: 10 }}>Clear</button>
                    </div>
                    <div style={{ maxHeight: 260, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 1 }}>
                      {reinsurerMatches.length === 0 && (
                        <div style={{ fontSize: 11, color: 'rgba(148,163,184,0.6)', padding: '8px 4px' }}>No matches.</div>
                      )}
                      {reinsurerMatches.map((r) => {
                        const on = selected.has(r.name);
                        const disabled = !on && atCap;
                        return (
                          <label key={r.name} title={disabled ? `Max ${MAX_SELECTED} on the chart — clear one to add another` : undefined}
                            style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 8px', borderRadius: 6, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.45 : 1, background: on ? 'rgba(0,212,255,0.07)' : 'transparent' }}>
                            <input type="checkbox" checked={on} disabled={disabled} onChange={() => toggleReinsurer(r.name)} style={{ verticalAlign: 'middle' }} />
                            {on && <span style={{ width: 8, height: 8, borderRadius: 2, background: colorOf(r.name), flex: '0 0 auto' }} />}
                            <span style={{ flex: 1, fontSize: 12, fontWeight: 600, color: 'rgba(226,232,240,0.88)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.name}</span>
                            <span style={{ fontSize: 10, color: 'rgba(148,163,184,0.6)' }}>{r.treatyCount}t</span>
                          </label>
                        );
                      })}
                    </div>
                    <div style={{ fontSize: 10, color: atCap ? '#f59e0b' : 'rgba(148,163,184,0.55)', marginTop: 8, paddingTop: 6, borderTop: '1px solid rgba(255,255,255,0.08)' }}>
                      {selected.size}/{MAX_SELECTED} drawn on chart{atCap ? ' · max reached' : ''}
                    </div>
                  </Dropdown>
                </div>

                <div>
                  <div style={{ fontSize: 9, fontWeight: 850, letterSpacing: '.12em', color: 'rgba(148,163,184,0.6)', textTransform: 'uppercase', marginBottom: 5 }}>Class of Business</div>
                  <Dropdown
                    label={cobFilter === 'all' ? 'All COBs' : cobFilter} popoverWidth={220}
                    open={openKey === 'cob'}
                    onToggle={() => setOpenKey((k) => (k === 'cob' ? null : 'cob'))}
                    onClose={() => setOpenKey((k) => (k === 'cob' ? null : k))}
                  >
                    <OptionList options={cobOptions} value={cobFilter} onPick={(v) => { setCobFilter(v); setOpenKey(null); }} />
                  </Dropdown>
                </div>

                <div>
                  <div style={{ fontSize: 9, fontWeight: 850, letterSpacing: '.12em', color: 'rgba(148,163,184,0.6)', textTransform: 'uppercase', marginBottom: 5 }}>NP Treaty Type</div>
                  <Dropdown
                    label={ttFilter === 'all' ? 'All Types' : ttFilter} popoverWidth={220}
                    open={openKey === 'type'}
                    onToggle={() => setOpenKey((k) => (k === 'type' ? null : 'type'))}
                    onClose={() => setOpenKey((k) => (k === 'type' ? null : k))}
                  >
                    <OptionList options={ttOptions} value={ttFilter} onPick={(v) => { setTtFilter(v); setOpenKey(null); }} />
                  </Dropdown>
                </div>

                <div>
                  <div style={{ fontSize: 9, fontWeight: 850, letterSpacing: '.12em', color: 'rgba(148,163,184,0.6)', textTransform: 'uppercase', marginBottom: 5 }}>Country</div>
                  <Dropdown
                    label={countryFilter === 'all' ? 'All Countries' : countryFilter} popoverWidth={220}
                    open={openKey === 'country'}
                    onToggle={() => setOpenKey((k) => (k === 'country' ? null : 'country'))}
                    onClose={() => setOpenKey((k) => (k === 'country' ? null : k))}
                  >
                    <OptionList options={countryOptions} value={countryFilter} onPick={(v) => { setCountryFilter(v); setOpenKey(null); }} />
                  </Dropdown>
                </div>

                <div>
                  <div style={{ fontSize: 9, fontWeight: 850, letterSpacing: '.12em', color: 'rgba(148,163,184,0.6)', textTransform: 'uppercase', marginBottom: 5 }}>Region</div>
                  <Dropdown
                    label={regionFilter === 'all' ? 'All Regions' : regionFilter} popoverWidth={220}
                    open={openKey === 'region'}
                    onToggle={() => setOpenKey((k) => (k === 'region' ? null : 'region'))}
                    onClose={() => setOpenKey((k) => (k === 'region' ? null : k))}
                  >
                    <OptionList options={regionOptions} value={regionFilter} onPick={(v) => { setRegionFilter(v); setOpenKey(null); }} />
                  </Dropdown>
                </div>

                <div style={{ marginLeft: 'auto', alignSelf: 'flex-end', fontSize: 11, color: 'rgba(148,163,184,0.6)', paddingBottom: 6 }}>
                  {filtered.length} of {data?.pointCount ?? points.length} layers in scope{data?.truncated ? ' · pool truncated' : ''}
                </div>
              </section>

              {selectedList.length === 0 && (
                <section style={sectionStyle}>
                  <div style={{ fontSize: 12, color: 'rgba(148,163,184,0.65)' }}>Select one or more reinsurers above to fit and compare pricing curves against the Global baseline.</div>
                </section>
              )}

              {/* Summary cards per selected reinsurer */}
              {selectedList.length > 0 && (
                <section style={sectionStyle}>
                  <div style={sectionTitleStyle}>Curve Summary · ROL @ x = 0.10 vs Global</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 10 }}>
                    {series.map((s) => {
                      const d = vsGlobal(s.fit);
                      return (
                        <div key={s.key} style={{ background: 'rgba(5,8,16,0.46)', border: `1px solid ${s.color}33`, borderRadius: 10, padding: '10px 12px' }}>
                          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.04em', color: s.color, marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{s.label}</div>
                          <div style={{ fontSize: 13, fontWeight: 700, color: 'rgba(226,232,240,0.92)', fontFamily: 'var(--font-mono)' }}>{eqStr(s.fit.a, s.fit.b)}</div>
                          <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.65)', marginTop: 4 }}>
                            R² <b style={{ color: 'rgba(226,232,240,0.85)' }}>{fmtR2(s.fit.r2)}</b>
                            {!s.fit.calibrated && <span style={{ marginLeft: 8, color: '#f87171' }}>· market default</span>}
                          </div>
                          <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.65)', marginTop: 2 }}>
                            {s.treaties} treaties · {s.layers} layers
                          </div>
                          <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginTop: 8 }}>
                            <span style={{ fontSize: 16, fontWeight: 700, color: 'rgba(226,232,240,0.92)' }}>{rolAt(s.fit, 0.10).toFixed(2)}%</span>
                            {d && !d.flat && (
                              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 3, fontSize: 11, fontWeight: 800, color: d.color }}>
                                <span style={{ fontSize: 9, lineHeight: 1 }}>{d.arrow}</span>{d.text}
                              </span>
                            )}
                          </div>
                          <div style={{ fontSize: 9, color: 'rgba(148,163,184,0.5)', marginTop: 2 }}>vs Global {globalRol10 > 0 ? `${globalRol10.toFixed(2)}%` : '—'}</div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              {/* Multi-curve SVG + legend */}
              {selectedList.length > 0 && (
                <section style={sectionStyle}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6, gap: 12 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: 'rgba(226,232,240,0.75)' }}>Implied Pricing Curves · y = a·x^b</span>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontSize: 10, color: 'rgba(148,163,184,0.55)' }}>x = √((L+A)·A) / EGNPI · y = ROL %</span>
                      <div style={{ display: 'flex', gap: 4 }}>
                        {[
                          { k: true, label: 'Log–log' },
                          { k: false, label: 'Linear' },
                        ].map((o) => (
                          <button key={o.label} className="bm-pill" onClick={() => setLogScale(o.k)}
                            aria-pressed={logScale === o.k}
                            style={{ fontSize: 10, ...(logScale === o.k ? { borderColor: '#00d4ff', color: '#00d4ff' } : undefined) }}>
                            {o.label}
                          </button>
                        ))}
                      </div>
                    </div>
                  </div>
                  <div style={{ position: 'relative', width: '100%', height: 'min(52vh, 460px)', minHeight: 360 }}>
                    <svg viewBox="0 0 100 72" style={{ width: '100%', height: '100%', display: 'block', background: 'rgba(0,0,0,0.20)', borderRadius: 8 }} preserveAspectRatio="none">
                      <defs>
                        <clipPath id="ra-plot-clip">
                          <rect x={PX0} y={PY0} width={PX1 - PX0} height={PY1 - PY0} />
                        </clipPath>
                      </defs>
                      {/* Gridlines at computed ticks */}
                      {yTicks.map((t) => (
                        <line key={`gy${t}`} x1={PX0} y1={Y(t)} x2={PX1} y2={Y(t)} stroke="rgba(255,255,255,0.06)" strokeWidth="1" shapeRendering="crispEdges" vectorEffect="non-scaling-stroke" />
                      ))}
                      {xTicks.map((t) => (
                        <line key={`gx${t}`} x1={X(t)} y1={PY0} x2={X(t)} y2={PY1} stroke="rgba(255,255,255,0.06)" strokeWidth="1" shapeRendering="crispEdges" vectorEffect="non-scaling-stroke" />
                      ))}
                      {/* Plot contents clipped to the frame so they never spill past the axes */}
                      <g clipPath="url(#ra-plot-clip)">
                        {/* Faded per-reinsurer scatter */}
                        {series.flatMap((s) => s.pts.map((p, i) => (
                          <circle key={`${s.key}-${i}`} cx={X(p.x)} cy={Y(p.y)} r="0.55" fill={s.color} fillOpacity={0.4} />
                        )))}
                        {/* Fitted curves — Global drawn dashed/grey + thinner */}
                        {sampled.map(({ s, pts }) => {
                          const d = pts.length ? `M ${pts.map((p) => `${X(p.x).toFixed(2)} ${Y(p.y).toFixed(2)}`).join(' L ')}` : '';
                          return (
                            <path key={s.key} d={d} stroke={s.color}
                              strokeWidth={s.isGlobal ? '1.4' : '2.2'}
                              strokeDasharray={s.isGlobal ? '4 3' : '0'}
                              strokeLinejoin="round" strokeLinecap="round" fill="none"
                              strokeOpacity={s.isGlobal ? 0.8 : 1} vectorEffect="non-scaling-stroke" />
                          );
                        })}
                      </g>
                    </svg>
                    {/* Axis tick labels — HTML overlay (in-SVG text would stretch under
                        preserveAspectRatio="none"). y = ROL %, x = ~2 sig digits. */}
                    {yTicks.map((t) => (
                      <span key={`yl${t}`} style={{ position: 'absolute', top: `${pctY(Y(t))}%`, left: 0, width: `${pctX(PX0)}%`, transform: 'translateY(-50%)', paddingRight: 4, textAlign: 'right', fontSize: 9, lineHeight: 1, color: 'rgba(148,163,184,0.6)', fontVariantNumeric: 'tabular-nums', pointerEvents: 'none' }}>{fmtTickY(t)}</span>
                    ))}
                    {xTicks.map((t) => (
                      <span key={`xl${t}`} style={{ position: 'absolute', top: `${pctY(PY1)}%`, left: `${pctX(X(t))}%`, transform: 'translate(-50%, 4px)', fontSize: 9, lineHeight: 1, color: 'rgba(148,163,184,0.6)', fontVariantNumeric: 'tabular-nums', pointerEvents: 'none', whiteSpace: 'nowrap' }}>{fmtTickX(t)}</span>
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 10, fontSize: 10 }}>
                    {allSeries.map((s) => (
                      <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ width: 16, height: 0, borderTop: s.isGlobal ? `2px dashed ${s.color}` : `2px solid ${s.color}`, opacity: s.isGlobal ? 0.8 : 1 }} />
                        <b style={{ color: s.color, letterSpacing: '.04em' }}>{s.label}</b>
                        <span style={{ color: 'rgba(148,163,184,0.55)' }}>· {s.treaties}t / {s.layers}L</span>
                      </span>
                    ))}
                  </div>
                </section>
              )}

              {/* Curve metrics comparison table */}
              {selectedList.length > 0 && (
                <section style={sectionStyle}>
                  <div style={sectionTitleStyle}>Curve Metrics Comparison</div>
                  <div style={{ border: '1px solid rgba(255,255,255,0.07)', borderRadius: 8, overflow: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                      <thead style={{ background: 'rgba(5,8,16,0.95)' }}>
                        <tr>
                          <th style={{ ...thStyle, textAlign: 'left' }}>Metric</th>
                          {allSeries.map((s) => (
                            <th key={s.key} style={{ ...thStyle, textAlign: 'right', color: s.color }}>{s.label}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {metricRows.map((row) => (
                          <tr key={row.k} style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                            <td style={{ ...tdStyle, textAlign: 'left', color: 'rgba(226,232,240,0.85)' }}>{row.label}</td>
                            {allSeries.map((s) => (
                              <td key={s.key} style={{ ...tdStyle, textAlign: 'right', fontFamily: 'var(--font-mono)', color: s.isGlobal ? 'rgba(226,232,240,0.7)' : 'rgba(226,232,240,0.9)' }}>{row.cell(s)}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.45)', marginTop: 6 }}>
                    ROL @ rows show each fitted curve&apos;s predicted rate-on-line at the listed x. Global is the fit over the whole filtered pool across all reinsurers.
                  </div>
                </section>
              )}

              {/* Underlying treaties (rolled up to treaty level) */}
              {selectedList.length > 0 && (
                <section style={{ ...sectionStyle, borderTop: '1px solid rgba(0,212,255,0.32)', boxShadow: '0 -1px 0 rgba(0,212,255,0.12), 0 1px 0 rgba(255,255,255,0.035) inset' }}>
                  <div style={{ ...sectionTitleStyle, marginBottom: 8 }}>Underlying Treaties · {sortedTreaties.length}</div>
                  <div style={{ border: '1px solid rgba(255,255,255,0.07)', borderRadius: 8, overflow: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                      <thead style={{ background: 'rgba(5,8,16,0.95)' }}>
                        <tr>
                          {treatyCols.map((h) => (
                            <th key={h.k} onClick={headerSort(h.k)} style={{ ...thStyle, textAlign: h.align, cursor: 'pointer', userSelect: 'none' }}>
                              {h.label}{sortArrow(h.k)}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {sortedTreaties.map((r) => (
                          <tr key={r.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                            <td style={{ ...tdStyle, textAlign: 'left' }}><span style={{ color: colorOf(r.reinsurer), fontWeight: 700 }}>{r.reinsurer}</span></td>
                            <td style={{ ...tdStyle, textAlign: 'left', color: 'rgba(226,232,240,0.85)' }}>{r.cedant}</td>
                            <td style={{ ...tdStyle, textAlign: 'left', color: 'rgba(148,163,184,0.75)' }}>{r.country}</td>
                            <td style={{ ...tdStyle, textAlign: 'left', color: 'rgba(148,163,184,0.75)' }}>{r.treatyType}</td>
                            <td style={{ ...tdStyle, textAlign: 'right', color: 'rgba(148,163,184,0.75)' }}>{r.uwYear || '—'}</td>
                            <td style={{ ...tdStyle, textAlign: 'right' }}>{fmt(r.limit)}</td>
                            <td style={{ ...tdStyle, textAlign: 'right' }}>{fmt(r.attachment)}</td>
                            <td style={{ ...tdStyle, textAlign: 'right' }}>{fmt(r.egnpi)}</td>
                            <td style={{ ...tdStyle, textAlign: 'right', color: '#00d4ff', fontWeight: 700 }}>{fmtPct(r.rolPct)}</td>
                            <td style={{ ...tdStyle, textAlign: 'right', color: 'rgba(148,163,184,0.75)' }}>{r.layers}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.45)', marginTop: 6 }}>
                    Click any column header to sort. Rolled up to treaty level: total limit, minimum attachment, total EGNPI, and limit-weighted ROL across the treaty&apos;s layers.
                  </div>
                </section>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
