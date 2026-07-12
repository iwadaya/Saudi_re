import { useCallback, useMemo, useState } from 'react';
import { toN } from './formatters.js';

/* ─────────────────────────────────────────────────────────────────
   NpMarketAnalysis — Pricing Curve & Benchmark Comparison
   Curves: Own, Lead, Expiring, Market (Country), Region, Global
   ─────────────────────────────────────────────────────────────────*/
const CURVE_DEFS = [
  { key: 'own',      label: 'Own Pricing',   color: '#00d4ff', dash: '' },
  { key: 'lead',     label: 'Lead Pricing',  color: '#a78bfa', dash: '6 3' },
  { key: 'expiring', label: 'Expiring',      color: '#f97316', dash: '4 4' },
  { key: 'country',  label: 'Market (Country)', color: '#4ade80', dash: '8 3' },
  { key: 'region',   label: 'Region Avg',    color: '#fbbf24', dash: '3 5' },
  { key: 'global',   label: 'Global Avg',    color: '#f87171', dash: '2 4' },
];
const EPS = 1e-9;

export default function NpMarketAnalysis({
  layers = [], quotePricing = {}, npDetail = {},
  portfolioTreaties = [],
}) {
  const [activeCurves, setActiveCurves] = useState(new Set(['own', 'lead', 'expiring', 'country']));

  const fmtP = n => n > 0 ? n.toFixed(2) + '%' : '—';
  const fmtC = n => {
    if (!n || n <= 0) return '—';
    if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
    if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(0) + 'K';
    return n.toFixed(0);
  };
  const toggleCurve = k => setActiveCurves(prev => {
    const next = new Set(prev);
    if (next.has(k)) next.delete(k); else next.add(k);
    return next;
  });

  // ── Pull market ROL from quotePricing ──
  const allQpLayers = useMemo(() => {
    for (const sIdx of Object.keys(quotePricing)) {
      const qpL = quotePricing[sIdx]?.layers;
      if (qpL && Object.keys(qpL).length > 0) return qpL;
    }
    return {};
  }, [quotePricing]);

  // ── Compute portfolio benchmarks: Country / Region / Global ──
  const countryId = npDetail.countryId || npDetail.country_id || '';
  const regionId = npDetail.regionId || npDetail.region_id || npDetail.region || '';

  const { countryAvgROLs, regionAvgROLs, globalAvgROLs } = useMemo(() => {
    // Extract per-layer ROLs from portfolio treaties
    const countryROLs = {};
    const regionROLs = {};
    const globalROLs = {};

    for (const t of portfolioTreaties) {
      const tLayers = t.layers || t.np_layers || [];
      const tCountry = t.country_id || t.countryId || '';
      const tRegion = t.region_id || t.regionId || t.region || '';

      for (const l of (Array.isArray(tLayers) ? tLayers : [])) {
        const ln = parseInt(l.layer_number || l.layer || '0', 10);
        if (!ln) continue;
        const rol = parseFloat(l.rol) || 0;
        if (!rol) continue;

        // Global — all treaties
        if (!globalROLs[ln]) globalROLs[ln] = [];
        globalROLs[ln].push(rol);

        // Region — same region
        if (regionId && tRegion === regionId) {
          if (!regionROLs[ln]) regionROLs[ln] = [];
          regionROLs[ln].push(rol);
        }

        // Country — same country
        if (countryId && tCountry === countryId) {
          if (!countryROLs[ln]) countryROLs[ln] = [];
          countryROLs[ln].push(rol);
        }
      }
    }

    const avg = obj => {
      const result = {};
      for (const [ln, vals] of Object.entries(obj)) {
        result[ln] = vals.reduce((s, v) => s + v, 0) / vals.length;
      }
      return result;
    };

    return {
      countryAvgROLs: avg(countryROLs),
      regionAvgROLs: avg(regionROLs),
      globalAvgROLs: avg(globalROLs),
    };
  }, [portfolioTreaties, countryId, regionId]);

  // ── Per-layer data ──
  const layerRows = useMemo(() => layers.map((l, i) => {
    const ln = parseInt(String(l.layer ?? '').replace(/\D/g, '')) || (i + 1);
    const qRow = allQpLayers[ln] || {};
    return {
      ln,
      label: `L${ln}`,
      limit: toN(l.limit),
      attach: toN(l.deductible ?? l.attachment),
      egnpi: toN(l.egnpi),
      ep: toN(l.earnedPremium ?? l.earned_premium),
      own: toN(l.reinsurerPricing) || toN(l.riskUwPrice) || toN(l.catUwPrice) || toN(l.riskTotalPrice) || toN(l.catTotalPrice),
      lead: toN(l.leadPricing),
      expiring: toN(l.expiringPricing),
      country: countryAvgROLs[ln] || toN(qRow.market_rol) || toN(qRow.market_rate) || 0,
      region: regionAvgROLs[ln] || 0,
      global: globalAvgROLs[ln] || 0,
    };
  }), [layers, allQpLayers, countryAvgROLs, regionAvgROLs, globalAvgROLs]);

  // ── Power curve fitting ──
  const egnpiMax = useMemo(() => Math.max(0, ...layers.map(l => toN(l.egnpi)).filter(n => n > 0)), [layers]);

  const mkPts = useCallback((accessor) => {
    if (!egnpiMax) return [];
    return layerRows.map(r => {
      if (r.attach <= 0 || r.limit <= 0) return null;
      const rol01 = accessor(r) / 100;
      if (rol01 <= 0) return null;
      const x = Math.sqrt((r.attach + r.limit) * r.attach) / egnpiMax;
      return (Number.isFinite(x) && x > 0) ? { x, y: rol01, layer: r.ln } : null;
    }).filter(Boolean);
  }, [egnpiMax, layerRows]);

  const fitPower = useCallback(pts => {
    const valid = (pts || []).filter(p => p.x > EPS && p.y > EPS);
    if (valid.length < 2) return null;
    const sseB = b => {
      let num = 0, den = 0;
      for (const p of valid) { const xb = Math.pow(p.x, b); if (!Number.isFinite(xb)) return Infinity; num += p.y * xb; den += xb * xb; }
      if (!den) return Infinity;
      const a = num / den;
      if (!Number.isFinite(a) || a <= 0) return Infinity;
      let sse = 0;
      for (const p of valid) { const e = p.y - a * Math.pow(p.x, b); sse += e * e; }
      return { sse, a, b };
    };
    let best = { sse: Infinity };
    for (let b = -6; b <= 6; b += 0.1) { const r = sseB(b); if (r !== Infinity && r.sse < best.sse) best = r; }
    if (!Number.isFinite(best.sse) || best.sse === Infinity) return null;
    let b0 = best.b;
    for (let step = 0.05; step >= 0.002; step /= 2) {
      for (let b = b0 - 0.2; b <= b0 + 0.2; b += step) { const r = sseB(b); if (r !== Infinity && r.sse < best.sse) best = r; }
      b0 = best.b;
    }
    return (Number.isFinite(best.a) && Number.isFinite(best.b) && best.a > 0) ? { a: best.a, b: best.b } : null;
  }, []);

  const computeR2 = useCallback((pts, model) => {
    if (!model || pts.length < 2) return null;
    const my = pts.reduce((s, p) => s + p.y, 0) / pts.length;
    let ssTot = 0, ssRes = 0;
    for (const p of pts) { ssTot += (p.y - my) ** 2; ssRes += (p.y - model.a * Math.pow(Math.max(EPS, p.x), model.b)) ** 2; }
    return ssTot > 0 ? Math.max(0, 1 - ssRes / ssTot) : null;
  }, []);

  const seriesData = useMemo(() => {
    const accessors = {
      own: r => r.own, lead: r => r.lead, expiring: r => r.expiring,
      country: r => r.country, region: r => r.region, global: r => r.global,
    };
    return CURVE_DEFS.map(def => {
      const pts = mkPts(accessors[def.key]);
      const model = fitPower(pts);
      const r2 = computeR2(pts, model);
      return { ...def, pts, model, r2 };
    });
  }, [computeR2, fitPower, mkPts]);

  const visibleSeries = seriesData.filter(s => activeCurves.has(s.key) && s.pts.length >= 1);
  const fittedVisible = visibleSeries.filter(s => s.model);

  // ── SVG chart bounds ──
  const allPts = visibleSeries.flatMap(s => s.pts);
  const hasChart = allPts.length >= 2;
  const { x0, x1, y0, y1 } = useMemo(() => {
    if (!hasChart) return { x0: 0, x1: 1, y0: 0, y1: 0.3 };
    const xs = allPts.map(p => p.x), ys = allPts.map(p => p.y);
    return { x0: Math.max(0, Math.min(...xs) * 0.8), x1: Math.max(...xs) * 1.2, y0: Math.max(0, Math.min(...ys) * 0.75), y1: Math.max(...ys) * 1.25 };
  }, [hasChart, allPts]);

  const W = 820, H = 380, pad = { t: 30, r: 30, b: 50, l: 65 };
  const cw = W - pad.l - pad.r, ch = H - pad.t - pad.b;
  const sx = x => pad.l + ((x - x0) / (x1 - x0)) * cw;
  const sy = y => pad.t + ch - ((y - y0) / (y1 - y0)) * ch;

  const gridY = useMemo(() => {
    const range = y1 - y0; if (range <= 0) return [];
    const step = Math.pow(10, Math.floor(Math.log10(range))) / 2;
    const lines = [];
    for (let v = Math.ceil(y0 / step) * step; v <= y1; v += step) lines.push(v);
    return lines;
  }, [y0, y1]);

  // ── Comparison table totals ──
  const totals = useMemo(() => {
    const totalLim = layerRows.reduce((s, r) => s + r.limit, 0);
    const wtAvg = (field) => {
      if (!totalLim) return 0;
      return layerRows.reduce((s, r) => s + r.limit * r[field], 0) / totalLim;
    };
    return { limit: totalLim, own: wtAvg('own'), lead: wtAvg('lead'), expiring: wtAvg('expiring'), country: wtAvg('country'), region: wtAvg('region'), global: wtAvg('global') };
  }, [layerRows]);

  const thS = { padding: '10px 8px', fontSize: 10, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.45)', borderBottom: '1px solid rgba(255,255,255,0.10)', whiteSpace: 'nowrap', textAlign: 'center' };
  const tdS = { padding: '9px 8px', fontSize: 12, textAlign: 'center', borderBottom: '1px solid rgba(255,255,255,0.05)', fontVariantNumeric: 'tabular-nums' };

  return (
    <div style={{ padding: '0 4px' }}>

      {/* ── Curve selector ── */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, marginBottom: 20 }}>
        {CURVE_DEFS.map(def => {
          const s = seriesData.find(sd => sd.key === def.key);
          const active = activeCurves.has(def.key);
          const hasPts = s && s.pts.length > 0;
          return (
            <button key={def.key} onClick={() => toggleCurve(def.key)} style={{
              appearance: 'none', cursor: 'pointer', display: 'flex', alignItems: 'center', gap: 6,
              padding: '6px 14px', borderRadius: 999, fontSize: 11, fontWeight: 700,
              border: active ? `1px solid ${def.color}` : '1px solid rgba(148,163,184,0.20)',
              background: active ? `${def.color}12` : 'transparent',
              color: active ? def.color : 'var(--muted)',
              opacity: hasPts ? 1 : 0.4,
              transition: 'all .15s',
            }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: active ? def.color : 'rgba(148,163,184,0.25)' }} />
              {def.label}
              {s?.r2 != null && active && <span style={{ fontSize: 9, opacity: 0.7 }}>R²={s.r2.toFixed(2)}</span>}
            </button>
          );
        })}
      </div>

      {/* ── SVG Chart ── */}
      <div style={{ background: '#070d1c', borderRadius: 14, border: '1px solid rgba(255,255,255,0.06)', padding: '12px 8px', marginBottom: 24 }}>
        {!hasChart ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'rgba(148,163,184,0.35)', fontSize: 13 }}>
            Insufficient data to render curves. Enter layer pricing on the main screen.
          </div>
        ) : (
          <svg viewBox={`0 0 ${W} ${H}`} width="100%" preserveAspectRatio="xMidYMid meet" className="crisp-grid" style={{ display: 'block', fontFamily: 'inherit', fontVariantNumeric: 'tabular-nums' }}>
            {/* Grid */}
            {gridY.map((v, i) => (
              <g key={i}>
                <line x1={pad.l} x2={W - pad.r} y1={sy(v)} y2={sy(v)} stroke="rgba(255,255,255,0.07)" shapeRendering="crispEdges" vectorEffect="non-scaling-stroke" />
                <text x={pad.l - 8} y={sy(v)} textAnchor="end" fill="rgba(255,255,255,0.65)" fontSize={10} fontWeight="500" dominantBaseline="middle">{(v * 100).toFixed(1)}%</text>
              </g>
            ))}
            <text x={pad.l - 8} y={pad.t - 10} textAnchor="end" fill="rgba(255,255,255,0.55)" fontSize={9} fontWeight="600">ROL</text>
            <text x={W / 2} y={H - 6} textAnchor="middle" fill="rgba(255,255,255,0.55)" fontSize={9} fontWeight="600">Midpoint / EGNPI</text>

            {/* Fitted curves */}
            {fittedVisible.map(s => {
              const steps = 80;
              const pts = [];
              for (let i = 0; i <= steps; i++) {
                const xv = x0 + (x1 - x0) * (i / steps);
                const yv = s.model.a * Math.pow(Math.max(EPS, xv), s.model.b);
                if (Number.isFinite(yv) && yv >= y0 * 0.5 && yv <= y1 * 1.5) pts.push(`${sx(xv).toFixed(1)},${sy(yv).toFixed(1)}`);
              }
              return pts.length > 1 ? (
                <polyline key={s.key} points={pts.join(' ')} fill="none" stroke={s.color} strokeWidth={2} strokeDasharray={s.dash} strokeLinejoin="round" strokeLinecap="round" opacity={0.85} vectorEffect="non-scaling-stroke" />
              ) : null;
            })}

            {/* Data points */}
            {visibleSeries.map(s => s.pts.map((p, pi) => (
              <g key={`${s.key}-${pi}`}>
                <circle cx={sx(p.x)} cy={sy(p.y)} r={5} fill={s.color} opacity={0.95} />
                <text x={sx(p.x)} y={sy(p.y) - 10} textAnchor="middle" fill={s.color} fontSize={9} fontWeight={700}>L{p.layer}</text>
              </g>
            )))}
          </svg>
        )}
      </div>

      {/* ── Comparison Table by Layer ── */}
      <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: 'rgba(var(--accent-blue-rgb),0.75)', marginBottom: 10 }}>Benchmark Comparison by Layer</div>
      <div style={{ overflowX: 'auto', borderRadius: 12, border: '1px solid var(--hairline)' }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 700 }}>
          <thead>
            <tr style={{ background: '#050810' }}>
              <th style={{ ...thS, textAlign: 'left', paddingLeft: 14 }}>Layer</th>
              <th style={thS}>Limit</th>
              <th style={thS}>Deductible</th>
              <th style={{ ...thS, color: CURVE_DEFS[0].color }}>Own ROL</th>
              <th style={{ ...thS, color: CURVE_DEFS[1].color }}>Lead ROL</th>
              <th style={{ ...thS, color: CURVE_DEFS[2].color }}>Expiring ROL</th>
              <th style={{ ...thS, color: CURVE_DEFS[3].color }}>Market (Country)</th>
              <th style={{ ...thS, color: CURVE_DEFS[4].color }}>Region</th>
              <th style={{ ...thS, color: CURVE_DEFS[5].color }}>Global</th>
              <th style={thS}>Own vs Lead</th>
              <th style={thS}>Own vs Expiring</th>
            </tr>
          </thead>
          <tbody>
            {layerRows.map(r => {
              const ownVsLead = r.own && r.lead ? ((r.own / r.lead - 1) * 100) : null;
              const ownVsExp = r.own && r.expiring ? ((r.own / r.expiring - 1) * 100) : null;
              const diffStyle = v => v != null ? { color: v > 0 ? '#f87171' : '#4ade80', fontWeight: 700 } : {};
              const diffStr = v => v != null ? `${v > 0 ? '+' : ''}${v.toFixed(1)}%` : '—';
              return (
                <tr key={r.ln} style={{ background: '#080f23' }}>
                  <td style={{ ...tdS, textAlign: 'left', paddingLeft: 14 }}>
                    <span style={{ display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 28, height: 28, borderRadius: 8, fontSize: 11, fontWeight: 800, border: '1px solid rgba(99,102,241,0.35)', background: 'rgba(99,102,241,0.12)', color: '#a5b4fc' }}>{r.ln}</span>
                  </td>
                  <td style={tdS}>{fmtC(r.limit)}</td>
                  <td style={tdS}>{fmtC(r.attach)}</td>
                  <td style={{ ...tdS, color: '#00d4ff', fontWeight: 700 }}>{fmtP(r.own)}</td>
                  <td style={{ ...tdS, color: '#a78bfa', fontWeight: 600 }}>{fmtP(r.lead)}</td>
                  <td style={{ ...tdS, color: '#f97316', fontWeight: 600 }}>{fmtP(r.expiring)}</td>
                  <td style={{ ...tdS, color: '#4ade80' }}>{fmtP(r.country)}</td>
                  <td style={{ ...tdS, color: '#fbbf24' }}>{fmtP(r.region)}</td>
                  <td style={{ ...tdS, color: '#f87171' }}>{fmtP(r.global)}</td>
                  <td style={{ ...tdS, ...diffStyle(ownVsLead) }}>{diffStr(ownVsLead)}</td>
                  <td style={{ ...tdS, ...diffStyle(ownVsExp) }}>{diffStr(ownVsExp)}</td>
                </tr>
              );
            })}
            {layerRows.length === 0 && (
              <tr><td colSpan={11} style={{ padding: 24, textAlign: 'center', color: 'rgba(148,163,184,0.35)', fontSize: 12 }}>No layers to compare</td></tr>
            )}
          </tbody>
          {layerRows.length > 0 && (
            <tfoot>
              <tr style={{ background: '#0a1125', borderTop: '2px solid rgba(255,255,255,0.10)' }}>
                <td style={{ ...tdS, textAlign: 'left', paddingLeft: 14, fontWeight: 800, fontSize: 10, letterSpacing: '.10em', color: 'rgba(148,163,184,0.55)' }}>WEIGHTED AVG</td>
                <td style={{ ...tdS, fontWeight: 700 }}>{fmtC(totals.limit)}</td>
                <td style={tdS}></td>
                <td style={{ ...tdS, color: '#00d4ff', fontWeight: 800 }}>{fmtP(totals.own)}</td>
                <td style={{ ...tdS, color: '#a78bfa', fontWeight: 700 }}>{fmtP(totals.lead)}</td>
                <td style={{ ...tdS, color: '#f97316', fontWeight: 700 }}>{fmtP(totals.expiring)}</td>
                <td style={{ ...tdS, color: '#4ade80' }}>{fmtP(totals.country)}</td>
                <td style={{ ...tdS, color: '#fbbf24' }}>{fmtP(totals.region)}</td>
                <td style={{ ...tdS, color: '#f87171' }}>{fmtP(totals.global)}</td>
                <td style={{ ...tdS, fontWeight: 700, ...(totals.own && totals.lead ? { color: totals.own > totals.lead ? '#f87171' : '#4ade80' } : {}) }}>
                  {totals.own && totals.lead ? `${((totals.own / totals.lead - 1) * 100) > 0 ? '+' : ''}${((totals.own / totals.lead - 1) * 100).toFixed(1)}%` : '—'}
                </td>
                <td style={{ ...tdS, fontWeight: 700, ...(totals.own && totals.expiring ? { color: totals.own > totals.expiring ? '#f87171' : '#4ade80' } : {}) }}>
                  {totals.own && totals.expiring ? `${((totals.own / totals.expiring - 1) * 100) > 0 ? '+' : ''}${((totals.own / totals.expiring - 1) * 100).toFixed(1)}%` : '—'}
                </td>
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
