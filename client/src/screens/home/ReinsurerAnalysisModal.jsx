import { useState, useEffect, useMemo, useRef } from 'react';
import { api, HttpError } from '../../api';
import { formatWithCommas } from '../../utils/format';
import { fqFitPowerLaw, fqGeomean } from '../non_proportional/final_pricing/fqHelpers.js';
// benchmark.css is not in the global bundle (it ships with the NP final-pricing
// / QuickBenchmark screens), so the bm-modal* / bm-pill theme classes this modal
// reuses must be imported here for it to render styled when opened from Home.
import '../benchmark/benchmark.css';

/* ─── Reinsurer Analysis Modal ───
   Portfolio-wide implied pricing-curve view. For each lead reinsurer we fit a
   single power-law curve y = a·x^b over its NP layers (one point per layer,
   x = √((L+A)·A) / EGNPI, y = ROL fraction) and compare the fitted curves side
   by side. The pool can be sliced by class of business and NP treaty type, and
   a dashed grey "market" baseline fits the whole filtered pool for reference.
   Data comes from /api/reinsurer-analysis (every NP layer carrying a lead
   reinsurer); the curve maths reuse fqHelpers and the visual language mirrors
   FQScopeCurvePanel / FQBenchmarkModal. */

// Up to six reinsurers can be compared at once; one palette colour each.
const PALETTE = ['#00d4ff', '#a78bfa', '#4ade80', '#f59e0b', '#f472b6', '#facc15'];
const MAX_SELECTED = 6;
const MARKET_COLOR = 'rgba(148,163,184,0.85)';

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

export default function ReinsurerAnalysisModal({ open, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [selected, setSelected] = useState(() => new Set()); // reinsurer names
  const [cobFilter, setCobFilter] = useState('all');
  const [ttFilter, setTtFilter] = useState('all');
  const [showMarket, setShowMarket] = useState(true);
  const [sortKey, setSortKey] = useState('limit');
  const [sortDir, setSortDir] = useState('desc');

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

  // Escape closes.
  useEffect(() => {
    if (!open) return undefined;
    const onKey = (e) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);

  // Memoised because it feeds every downstream useMemo (eslint deps).
  const points = useMemo(() => data?.points || [], [data]);
  const reinsurers = useMemo(() => (Array.isArray(data?.reinsurers) ? data.reinsurers : []), [data]);
  const cobs = useMemo(() => (Array.isArray(data?.cobs) ? data.cobs : []), [data]);
  const treatyTypes = useMemo(() => (Array.isArray(data?.treatyTypes) ? data.treatyTypes : []), [data]);

  // Layer → (x, y) for the power-law fit, keeping the row fields for scatter +
  // the underlying-treaty roll-up. Drop anything that can't sit on a log curve.
  const mapped = useMemo(() => points.map((p) => {
    const x = fqGeomean(Number(p.limit), Number(p.attachment)) / Number(p.egnpi);
    const y = (Number(p.rolPct) || 0) / 100;
    if (!(x > 0) || !(y > 0) || !Number.isFinite(x) || !Number.isFinite(y)) return null;
    return { ...p, x, y };
  }).filter(Boolean), [points]);

  // A COB filter matches a point when its parent treaty carries that class
  // (cobs[]), so a multi-COB treaty shows under each of its classes.
  const filtered = useMemo(() => mapped.filter((p) => {
    if (cobFilter !== 'all' && !(Array.isArray(p.cobs) ? p.cobs : []).includes(cobFilter)) return false;
    if (ttFilter !== 'all' && p.treatyType !== ttFilter) return false;
    return true;
  }), [mapped, cobFilter, ttFilter]);

  // Stable, ranked order for the selected reinsurers so colours don't reshuffle
  // as the user ticks chips on and off.
  const selectedList = useMemo(
    () => reinsurers.filter((r) => selected.has(r.name)).map((r) => r.name),
    [reinsurers, selected],
  );

  // Market baseline: one fit over the entire filtered pool.
  const marketFit = useMemo(() => fqFitPowerLaw(filtered), [filtered]);
  const marketTreaties = useMemo(() => new Set(filtered.map((p) => p.contractId)).size, [filtered]);

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

  // Series feeding the legend, equation cards, and metrics table — market last.
  const marketSeries = {
    key: '__market__', label: 'Market', color: MARKET_COLOR, fit: marketFit,
    pts: filtered, treaties: marketTreaties, layers: filtered.length, isMarket: true,
  };
  const allSeries = showMarket ? [...series, marketSeries] : series;

  // ── SVG geometry over the filtered pool (stable axis across selections) ──
  const xs = filtered.map((p) => p.x);
  const ys = filtered.map((p) => p.y);
  const xMin = Math.max(1e-6, xs.length ? Math.min(...xs) : 1e-3);
  const xMax = xs.length ? Math.max(...xs) : 1;
  const rawYMax = Math.max(ys.length ? Math.max(...ys) : 0, 0.5);
  const X = (v) => 8 + ((v - xMin) / (xMax - xMin || 1)) * 84;
  const sampleCurve = (fit) => {
    if (!fit || !Number.isFinite(fit.a) || !Number.isFinite(fit.b) || fit.a <= 0) return [];
    const out = [];
    for (let i = 0; i <= 50; i += 1) {
      const x = xMin + (xMax - xMin) * (i / 50);
      const y = fit.a * Math.pow(x, fit.b);
      if (y > 0 && y <= rawYMax * 3) out.push({ x, y });
    }
    return out;
  };
  const sampled = allSeries.map((s) => ({ s, pts: sampleCurve(s.fit) }));
  const sampledYs = sampled.flatMap((c) => c.pts.map((p) => p.y));
  const yMax = Math.max(rawYMax, ...sampledYs, 0.01) * 1.12;
  const Y = (v) => 66 - ((v - 0) / (yMax || 1)) * 60;

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

  if (!open) return null;

  const toggleReinsurer = (name) => setSelected((prev) => {
    const n = new Set(prev);
    if (n.has(name)) n.delete(name);
    else if (n.size < MAX_SELECTED) n.add(name);
    return n;
  });
  const headerSort = (k) => () => {
    if (sortKey === k) setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    else { setSortKey(k); setSortDir('desc'); }
  };
  const sortArrow = (k) => (sortKey === k ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');

  // Directional delta of a reinsurer's ROL @ x=0.10 vs the market baseline.
  const marketRol10 = rolAt(marketFit, 0.10);
  const vsMarket = (fit) => {
    const r = rolAt(fit, 0.10);
    if (!(marketRol10 > 0) || !(r > 0)) return null;
    const pct = ((r - marketRol10) / marketRol10) * 100;
    if (Math.abs(pct) < 0.05) return { flat: true };
    const above = r > marketRol10;
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

  const colorOf = (name) => {
    const idx = selectedList.indexOf(name);
    return idx >= 0 ? PALETTE[idx % PALETTE.length] : 'rgba(148,163,184,0.55)';
  };

  return (
    <div className="bm-modal-backdrop" role="presentation" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bm-modal" style={{ width: '100vw', maxWidth: '100vw', height: '100dvh', maxHeight: '100dvh', borderRadius: 0, display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)' }}>
        {/* Header */}
        <div className="bm-modal-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div>Reinsurer Analysis · Implied Pricing Curves</div>
            <div style={{ fontSize: 11, fontWeight: 500, color: 'rgba(148,163,184,0.55)', marginTop: 2 }}>
              y = a·x^b per lead reinsurer · x = √((L+A)·A) / EGNPI · y = ROL %
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
              {/* Controls: reinsurer chips, COB filter, treaty-type filter, market toggle */}
              <section style={sectionStyle}>
                <div style={{ ...sectionTitleStyle, display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 12 }}>
                  <span>Reinsurers · {selected.size} of {reinsurers.length} selected (max {MAX_SELECTED})</span>
                  <span style={{ fontWeight: 600, letterSpacing: 0, textTransform: 'none', color: 'rgba(148,163,184,0.6)' }}>
                    {filtered.length} of {data?.pointCount ?? points.length} layers in scope
                    {data?.truncated ? ' · pool truncated' : ''}
                  </span>
                </div>
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
                  {reinsurers.map((r) => {
                    const on = selected.has(r.name);
                    const disabled = !on && selected.size >= MAX_SELECTED;
                    return (
                      <button key={r.name} className="bm-pill" onClick={() => !disabled && toggleReinsurer(r.name)}
                        title={disabled ? `Deselect one to add (max ${MAX_SELECTED})` : undefined}
                        style={{
                          ...(on ? { borderColor: `${colorOf(r.name)}99`, color: colorOf(r.name) } : undefined),
                          ...(disabled ? { opacity: 0.4, cursor: 'not-allowed' } : undefined),
                        }}>
                        {on && <span style={{ display: 'inline-block', width: 8, height: 8, borderRadius: 2, background: colorOf(r.name), marginRight: 6, verticalAlign: 'middle' }} />}
                        {r.name} <span style={{ opacity: 0.6 }}>· {r.treatyCount}t / {r.layerCount}L</span>
                      </button>
                    );
                  })}
                </div>

                <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.1em', color: 'rgba(148,163,184,0.55)', textTransform: 'uppercase' }}>COB</span>
                    <button className="bm-pill" onClick={() => setCobFilter('all')}
                      style={cobFilter === 'all' ? { borderColor: 'rgba(35,209,139,0.55)', color: '#23d18b' } : undefined}>All</button>
                    {cobs.map((c) => (
                      <button key={c} className="bm-pill" onClick={() => setCobFilter(c)}
                        style={cobFilter === c ? { borderColor: 'rgba(0,212,255,0.55)', color: '#00d4ff' } : undefined}>{c}</button>
                    ))}
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
                    <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.1em', color: 'rgba(148,163,184,0.55)', textTransform: 'uppercase' }}>Type</span>
                    <button className="bm-pill" onClick={() => setTtFilter('all')}
                      style={ttFilter === 'all' ? { borderColor: 'rgba(35,209,139,0.55)', color: '#23d18b' } : undefined}>All</button>
                    {treatyTypes.map((t) => (
                      <button key={t} className="bm-pill" onClick={() => setTtFilter(t)}
                        style={ttFilter === t ? { borderColor: 'rgba(167,139,250,0.55)', color: '#a78bfa' } : undefined}>{t}</button>
                    ))}
                  </div>
                  <button className="bm-pill" onClick={() => setShowMarket((v) => !v)}
                    style={{ marginLeft: 'auto', ...(showMarket ? { borderColor: MARKET_COLOR, color: 'rgba(226,232,240,0.85)' } : { opacity: 0.6 }) }}>
                    {showMarket ? '✓ ' : ''}Market baseline
                  </button>
                </div>
              </section>

              {selectedList.length === 0 && (
                <section style={sectionStyle}>
                  <div style={{ fontSize: 12, color: 'rgba(148,163,184,0.65)' }}>Select one or more reinsurers above to fit and compare pricing curves.</div>
                </section>
              )}

              {/* Summary cards per selected reinsurer */}
              {selectedList.length > 0 && (
                <section style={sectionStyle}>
                  <div style={sectionTitleStyle}>Curve Summary · ROL @ x = 0.10 vs market</div>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(230px, 1fr))', gap: 10 }}>
                    {series.map((s) => {
                      const d = vsMarket(s.fit);
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
                          <div style={{ fontSize: 9, color: 'rgba(148,163,184,0.5)', marginTop: 2 }}>vs market {marketRol10 > 0 ? `${marketRol10.toFixed(2)}%` : '—'}</div>
                        </div>
                      );
                    })}
                  </div>
                </section>
              )}

              {/* Multi-curve SVG + legend */}
              {selectedList.length > 0 && (
                <section style={sectionStyle}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: 'rgba(226,232,240,0.75)' }}>Implied Pricing Curves · y = a·x^b</span>
                    <span style={{ fontSize: 10, color: 'rgba(148,163,184,0.55)' }}>x = √((L+A)·A) / EGNPI · y = ROL %</span>
                  </div>
                  <svg viewBox="0 0 100 72" style={{ width: '100%', height: 'min(52vh, 460px)', minHeight: 360, display: 'block', background: 'rgba(0,0,0,0.20)', borderRadius: 8 }} preserveAspectRatio="none">
                    {[12, 24, 36, 48, 60].map((g) => (<line key={`gy${g}`} x1={6} y1={g} x2={98} y2={g} stroke="rgba(255,255,255,0.06)" strokeWidth="1" shapeRendering="crispEdges" vectorEffect="non-scaling-stroke" />))}
                    {[20, 40, 60, 80].map((g) => (<line key={`gx${g}`} x1={g} y1={6} x2={g} y2={66} stroke="rgba(255,255,255,0.06)" strokeWidth="1" shapeRendering="crispEdges" vectorEffect="non-scaling-stroke" />))}
                    {/* Faded per-reinsurer scatter */}
                    {series.flatMap((s) => s.pts.map((p, i) => (
                      <circle key={`${s.key}-${i}`} cx={X(p.x)} cy={Y(p.y)} r="0.55" fill={s.color} fillOpacity={0.4} />
                    )))}
                    {/* Fitted curves — market drawn dashed/grey */}
                    {sampled.map(({ s, pts }) => {
                      const d = pts.length ? `M ${pts.map((p) => `${X(p.x).toFixed(2)} ${Y(p.y).toFixed(2)}`).join(' L ')}` : '';
                      return (
                        <path key={s.key} d={d} stroke={s.color}
                          strokeWidth={s.isMarket ? '1.6' : '2.2'}
                          strokeDasharray={s.isMarket ? '4 3' : '0'}
                          strokeLinejoin="round" strokeLinecap="round" fill="none"
                          strokeOpacity={s.isMarket ? 0.85 : 1} vectorEffect="non-scaling-stroke" />
                      );
                    })}
                  </svg>
                  <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 10, fontSize: 10 }}>
                    {allSeries.map((s) => (
                      <span key={s.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                        <span style={{ width: 16, height: 2, background: s.color, opacity: s.isMarket ? 0.75 : 1, borderRadius: 1 }} />
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
                              <td key={s.key} style={{ ...tdStyle, textAlign: 'right', fontFamily: 'var(--font-mono)', color: s.isMarket ? 'rgba(226,232,240,0.7)' : 'rgba(226,232,240,0.9)' }}>{row.cell(s)}</td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                  <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.45)', marginTop: 6 }}>
                    ROL @ rows show each fitted curve&apos;s predicted rate-on-line at the listed x. Market is the fit over the whole filtered pool.
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
