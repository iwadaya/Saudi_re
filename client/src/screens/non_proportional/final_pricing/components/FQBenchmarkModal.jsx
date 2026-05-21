import { useState, useEffect, useMemo, useRef } from 'react';
import { formatWithCommas, toN as toN_ } from '../../../../utils/format';
import { fqLayerToXY, fqPeerToXY, fqFitPowerLaw } from '../fqHelpers.js';
import { api, HttpError } from '../../../../api';

/* ─── Analysis Modal — Country / Regional / Global view ───
   Per-structure benchmark view opened from each structure header.
   Peer treaties are fetched from /api/treaties/:id/peer-structures
   (real portfolio data, scoped by country/region/global and filtered
   by COB overlap). An optional AI commentary section calls
   /api/ai/market/structure-commentary to interpret the positioning.
   Modal layout: scope toggle, COB filter chips, 6 metric summary
   cards, chart tabs (Distributions / Pricing Curve / Rate Curve /
   Ded vs Limit / Aggregates), a sortable comparable-treaty table,
   and an AI commentary panel. */
export default function FQBenchmarkModal({
  open, scope: initialScope, sourceLabel, sourceLayers, currency, cobNames, contractId, cobIds, onClose,
}) {
  const [scope, setScope] = useState(initialScope || 'country');
  const [tab, setTab] = useState('distributions');
  const [cobFilter, setCobFilter] = useState('all');
  const [sortKey, setSortKey] = useState('limit');
  const [sortDir, setSortDir] = useState('desc');

  // Peer pool fetched per (contractId, scope, cobIds). Stored as a
  // per-scope map so toggling tabs doesn't refetch already-loaded data.
  const [peerPools, setPeerPools] = useState({}); // { country: [...], region: [...], global: [...] }
  const [peerLoading, setPeerLoading] = useState(false);
  const [peerError, setPeerError] = useState('');
  const [peerNote, setPeerNote] = useState('');

  // AI commentary state — lazy: nothing fires until the user clicks
  // Generate. Once generated for a scope we keep it cached client-side
  // so toggling between scopes doesn't re-spend tokens.
  const [commentary, setCommentary] = useState({}); // { [scope]: { signal, commentary, highlights } }
  const [commentaryLoading, setCommentaryLoading] = useState(false);
  const [commentaryError, setCommentaryError] = useState('');

  // Stable join key for cobIds so the fetch effect doesn't re-run on
  // a reference-equal array passed from the parent.
  const cobIdsKey = useMemo(() => (Array.isArray(cobIds) ? cobIds.slice().sort().join(',') : ''), [cobIds]);

  // Reset state when the parent re-opens with a different default
  useEffect(() => {
    if (!open) return;
    setScope(initialScope || 'country');
    setPeerPools({});
    setPeerError('');
    setPeerNote('');
    setCommentary({});
    setCommentaryError('');
  }, [open, initialScope, contractId, cobIdsKey]);

  // Fetch peers when the active scope changes (or we just opened). The
  // mountedRef guard stops a stale fetch from clobbering state if the
  // user closes the modal mid-flight.
  const mountedRef = useRef(true);
  useEffect(() => { mountedRef.current = true; return () => { mountedRef.current = false; }; }, []);
  useEffect(() => {
    if (!open || !contractId) return;
    if (peerPools[scope]) return; // cached
    let cancelled = false;
    setPeerLoading(true);
    setPeerError('');
    setPeerNote('');
    const cobIdList = cobIdsKey ? cobIdsKey.split(',').filter(Boolean) : [];
    api.getPeerStructures(contractId, { scope, cobIds: cobIdList })
      .then((data) => {
        if (cancelled || !mountedRef.current) return;
        setPeerPools((prev) => ({ ...prev, [scope]: Array.isArray(data?.peers) ? data.peers : [] }));
        if (data?.note) setPeerNote(data.note);
      })
      .catch((err) => {
        if (cancelled || !mountedRef.current) return;
        const message = err instanceof HttpError && err.body?.error
          ? err.body.error
          : (err?.message || 'Failed to load peer treaties');
        setPeerError(message);
        setPeerPools((prev) => ({ ...prev, [scope]: [] }));
      })
      .finally(() => { if (!cancelled && mountedRef.current) setPeerLoading(false); });
    return () => { cancelled = true; };
  }, [open, contractId, scope, cobIdsKey, peerPools]);

  if (!open) return null;

  // ── Source-structure metrics (the thing we're benchmarking) ──
  const totalLim   = sourceLayers.reduce((s, l) => s + toN_(l.limit), 0);
  const totalEgnpi = sourceLayers.reduce((s, l) => s + toN_(l.egnpi), 0);
  const ded        = toN_(sourceLayers[0]?.attachment); // primary deductible
  const dOverL     = totalLim > 0 ? ded / totalLim : 0;
  const dOverE     = totalEgnpi > 0 ? ded / totalEgnpi : 0;
  const lOverE     = totalEgnpi > 0 ? totalLim / totalEgnpi : 0;
  // Limit-weighted ROL
  const wRol = (() => {
    const num = sourceLayers.reduce((s, l) => s + toN_(l.limit) * toN_(l.rol || l.uwPrice), 0);
    return totalLim > 0 ? num / totalLim : 0;
  })();

  const peers = peerPools[scope] || [];
  const filtered = cobFilter === 'all' ? peers : peers.filter((p) => p.cob === cobFilter);
  // Median helper
  const median = (arr) => {
    if (!arr.length) return 0;
    const s = [...arr].sort((a, b) => a - b);
    const m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  };
  const peerLimit = filtered.map((p) => p.limit);
  const peerDed   = filtered.map((p) => p.ded);
  const peerRol   = filtered.map((p) => p.rolPct);
  const mLimit  = median(peerLimit);
  const mDed    = median(peerDed);
  const mDoverL = median(filtered.map((p) => (p.limit > 0 ? p.ded / p.limit : 0)));
  const mDoverE = median(filtered.map((p) => (p.egnpi > 0 ? p.ded / p.egnpi : 0)));
  const mLoverE = median(filtered.map((p) => (p.egnpi > 0 ? p.limit / p.egnpi : 0)));
  const mRol    = median(peerRol);

  // Percentile rank of source value within peer list (0–100)
  const pRank = (val, arr) => {
    if (!arr.length || !isFinite(val)) return null;
    const below = arr.filter((v) => v < val).length;
    return Math.round((below / arr.length) * 100);
  };

  const fmt = (n) => (n > 0 ? formatWithCommas(String(Math.round(n))) : '—');
  const fmtPct = (n) => (n > 0 ? `${n.toFixed(2)}%` : '—');
  const fmtRatio = (n) => (n > 0 ? n.toFixed(3) : '—');

  const cards = [
    { key: 'ded',   label: 'Deductible',   value: fmt(ded),         market: fmt(mDed),   p: pRank(ded, peerDed) },
    { key: 'lim',   label: 'Limit',        value: fmt(totalLim),    market: fmt(mLimit), p: pRank(totalLim, peerLimit) },
    { key: 'd_l',   label: 'Ded / Limit',  value: fmtRatio(dOverL), market: fmtRatio(mDoverL), p: pRank(dOverL, filtered.map((p) => (p.limit > 0 ? p.ded / p.limit : 0))) },
    { key: 'd_e',   label: 'Ded / EGNPI',  value: fmtRatio(dOverE), market: fmtRatio(mDoverE), p: pRank(dOverE, filtered.map((p) => (p.egnpi > 0 ? p.ded / p.egnpi : 0))) },
    { key: 'l_e',   label: 'Limit / EGNPI',value: fmtRatio(lOverE), market: fmtRatio(mLoverE), p: pRank(lOverE, filtered.map((p) => (p.egnpi > 0 ? p.limit / p.egnpi : 0))) },
    { key: 'rol',   label: 'ROL %',        value: fmtPct(wRol),     market: fmtPct(mRol), p: pRank(wRol, peerRol) },
  ];

  // ── Sortable peer-treaty table ──
  const sortedFiltered = [...filtered].sort((a, b) => {
    const av = sortKey === 'cedant' || sortKey === 'cob' || sortKey === 'country' ? a[sortKey] : (a[sortKey] || 0);
    const bv = sortKey === 'cedant' || sortKey === 'cob' || sortKey === 'country' ? b[sortKey] : (b[sortKey] || 0);
    if (av < bv) return sortDir === 'asc' ? -1 : 1;
    if (av > bv) return sortDir === 'asc' ? 1 : -1;
    return 0;
  });
  const headerSort = (k) => () => { if (sortKey === k) setSortDir(sortDir === 'asc' ? 'desc' : 'asc'); else { setSortKey(k); setSortDir('desc'); } };
  const sortArrow = (k) => (sortKey === k ? (sortDir === 'asc' ? ' ▲' : ' ▼') : '');
  const cobColor = (cob) => ({
    Property: '#00d4ff', Marine: '#a78bfa', Energy: '#f59e0b', Aviation: '#4ade80', Liability: '#f87171',
  }[cob] || 'rgba(148,163,184,0.55)');

  // Lazy AI commentary — pulls the modal's already-computed source
  // metrics + peer medians and asks the server for a paragraph on
  // positioning. Skipped automatically when the peer pool is empty.
  const runCommentary = async () => {
    if (!contractId) {
      setCommentaryError('Cannot generate commentary: no contract context');
      return;
    }
    setCommentaryLoading(true);
    setCommentaryError('');
    try {
      const result = await api.generateStructureCommentary({
        contract_id: contractId,
        scope,
        structure_label: sourceLabel || 'Structure',
        source_metrics: {
          totalLimit: totalLim,
          totalEgnpi: totalEgnpi,
          deductible: ded,
          dOverL,
          dOverE,
          lOverE,
          rolPct: wRol,
        },
        peer_medians: {
          totalLimit: mLimit,
          totalEgnpi: null,
          deductible: mDed,
          dOverL: mDoverL,
          dOverE: mDoverE,
          lOverE: mLoverE,
          rolPct: mRol,
        },
        peer_count: filtered.length,
        cob_names: cobNames || [],
        currency: currency || '',
      });
      setCommentary((prev) => ({ ...prev, [scope]: result }));
    } catch (err) {
      const message = err instanceof HttpError && err.body?.error
        ? err.body.error
        : (err?.message || 'Failed to generate commentary');
      setCommentaryError(message);
    } finally {
      setCommentaryLoading(false);
    }
  };
  const activeCommentary = commentary[scope] || null;
  const verdictColor = {
    BETTER:  '#23d18b',
    ON_PAR:  '#fbbf24',
    WORSE:   '#f87171',
    NO_DATA: 'rgba(148,163,184,0.55)',
  };

  // ── Lightweight inline charts: tiny SVG primitives so we don't pull a
  //    chart lib into the bundle just for the scaffold. ──
  const BoxPlot = ({ label, values, sourceVal, formatter = fmt }) => {
    if (!values.length) return null;
    const sorted = [...values].sort((a, b) => a - b);
    const min = sorted[0];
    const max = sorted[sorted.length - 1];
    const q = (frac) => sorted[Math.min(sorted.length - 1, Math.floor(frac * sorted.length))];
    const p10 = q(0.10), p25 = q(0.25), p50 = q(0.50), p75 = q(0.75), p90 = q(0.90);
    const range = max - min || 1;
    const X = (v) => 8 + ((v - min) / range) * 84; // map to 8..92% of svg width
    return (
      <div style={{ marginBottom: 14 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
          <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.08em', color: 'rgba(226,232,240,0.75)' }}>{label}</span>
          <span style={{ fontSize: 10, color: 'rgba(148,163,184,0.55)' }}>P10 {formatter(p10)} · Median {formatter(p50)} · P90 {formatter(p90)}</span>
        </div>
        <svg viewBox="0 0 100 24" style={{ width: '100%', height: 28, display: 'block' }} preserveAspectRatio="none">
          <line x1={X(p10)} y1="12" x2={X(p90)} y2="12" stroke="rgba(148,163,184,0.55)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          <rect x={X(p25)} y="6" width={X(p75) - X(p25)} height="12" fill="rgba(0,212,255,0.14)" stroke="rgba(0,212,255,0.55)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          <line x1={X(p50)} y1="6" x2={X(p50)} y2="18" stroke="#00d4ff" strokeWidth="1.5" vectorEffect="non-scaling-stroke" />
          {sourceVal > 0 && (
            <polygon points={`${X(sourceVal)},4 ${X(sourceVal) + 1.6},12 ${X(sourceVal)},20 ${X(sourceVal) - 1.6},12`} fill="#f59e0b" stroke="#fbbf24" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          )}
        </svg>
      </div>
    );
  };

  const Scatter = ({ xKey, yKey, xLabel, yLabel, sourceX, sourceY }) => {
    const xs = filtered.map((p) => p[xKey]);
    const ys = filtered.map((p) => p[yKey]);
    if (!xs.length) return null;
    const xMin = Math.min(...xs, sourceX || 0);
    const xMax = Math.max(...xs, sourceX || 0);
    const yMin = Math.min(...ys, sourceY || 0);
    const yMax = Math.max(...ys, sourceY || 0);
    const X = (v) => 8 + ((v - xMin) / (xMax - xMin || 1)) * 84;
    const Y = (v) => 96 - ((v - yMin) / (yMax - yMin || 1)) * 80;
    return (
      <div style={{ marginBottom: 12 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
          <span style={{ fontSize: 11, fontWeight: 700, color: 'rgba(226,232,240,0.75)' }}>{yLabel} vs {xLabel}</span>
          <span style={{ fontSize: 10, color: 'rgba(148,163,184,0.55)' }}>{filtered.length} treaties</span>
        </div>
        <svg viewBox="0 0 100 100" preserveAspectRatio="xMidYMid meet" style={{ width: '100%', height: 240, display: 'block', background: 'rgba(0,0,0,0.20)', borderRadius: 8, fontFamily: 'inherit', fontVariantNumeric: 'tabular-nums' }}>
          {[20, 40, 60, 80].map((g) => (
            <line key={`gx${g}`} x1={g} y1={8} x2={g} y2={96} stroke="rgba(255,255,255,0.06)" strokeWidth="1" shapeRendering="crispEdges" vectorEffect="non-scaling-stroke" />
          ))}
          {[20, 40, 60, 80].map((g) => (
            <line key={`gy${g}`} x1={8} y1={g} x2={96} y2={g} stroke="rgba(255,255,255,0.06)" strokeWidth="1" shapeRendering="crispEdges" vectorEffect="non-scaling-stroke" />
          ))}
          {filtered.map((p) => (
            <circle key={p.id} cx={X(p[xKey])} cy={Y(p[yKey])} r="0.9" fill={cobColor(p.cob)} fillOpacity="0.75" />
          ))}
          {sourceX > 0 && sourceY > 0 && (
            <polygon points={`${X(sourceX)},${Y(sourceY) - 2} ${X(sourceX) + 2},${Y(sourceY)} ${X(sourceX)},${Y(sourceY) + 2} ${X(sourceX) - 2},${Y(sourceY)}`} fill="#f59e0b" stroke="#fbbf24" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          )}
        </svg>
      </div>
    );
  };

  const scopeLabel = scope === 'country' ? 'Country View — KSA cedants' : scope === 'region' ? 'Regional View — Middle East' : 'Global View — worldwide';
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

  return (
    <div className="bm-modal-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="bm-modal" style={{ width: '100vw', maxWidth: '100vw', height: '100dvh', maxHeight: '100dvh', borderRadius: 0, display: 'grid', gridTemplateRows: 'auto minmax(0, 1fr)' }}>
        {/* Header */}
        <div className="bm-modal-title" style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 12 }}>
          <div>
            <div>Analysis · {sourceLabel}</div>
            <div style={{ fontSize: 11, fontWeight: 500, color: 'rgba(148,163,184,0.55)', marginTop: 2 }}>{scopeLabel}</div>
          </div>
          <button className="bm-pill" onClick={onClose}>✕</button>
        </div>

        <div className="bm-modal-body" style={{ minHeight: 0, height: '100%', maxHeight: 'none', overflowY: 'scroll', overflowX: 'hidden', display: 'flex', flexDirection: 'column', gap: 16, padding: '20px 28px' }}>
          {/* Scope tabs + COB filter */}
          <section style={{ ...sectionStyle, display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center' }}>
            <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
              {[
                { k: 'country', label: 'Country' },
                { k: 'region',  label: 'Regional' },
                { k: 'global',  label: 'Global' },
              ].map((s) => (
                <button key={s.k}
                  onClick={() => setScope(s.k)}
                  style={{
                    appearance: 'none',
                    padding: '8px 16px',
                    border: 'none',
                    borderBottom: scope === s.k ? '2px solid #00d4ff' : '2px solid transparent',
                    background: scope === s.k ? 'rgba(0,212,255,0.08)' : 'transparent',
                    color: scope === s.k ? '#00d4ff' : 'rgba(226,232,240,0.65)',
                    fontSize: 11,
                    fontWeight: 800,
                    letterSpacing: '.08em',
                    textTransform: 'uppercase',
                    cursor: 'pointer',
                  }}>
                  {s.label}
                </button>
              ))}
            </div>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              <button className="bm-pill" onClick={() => setCobFilter('all')}
                style={cobFilter === 'all' ? { borderColor: 'rgba(35,209,139,0.55)', color: '#23d18b' } : undefined}>All COBs</button>
              {(cobNames && cobNames.length ? cobNames : ['Property', 'Marine', 'Energy']).map((c) => (
                <button key={c} className="bm-pill" onClick={() => setCobFilter(c)}
                  style={cobFilter === c ? { borderColor: cobColor(c), color: cobColor(c) } : undefined}>
                  {c}
                </button>
              ))}
            </div>
            <div style={{ marginLeft: 'auto', fontSize: 11, color: 'rgba(148,163,184,0.55)' }}>
              {peerLoading
                ? 'Loading peers…'
                : peerError
                  ? <span style={{ color: '#f87171' }}>Peer load failed — {peerError}</span>
                  : `${filtered.length} comparable treaties${peerNote ? ` · ${peerNote}` : ''}`}
            </div>
          </section>

          {/* 6 metric summary cards */}
          <section style={sectionStyle}>
            <div style={sectionTitleStyle}>Benchmark Summary</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(6, minmax(150px, 1fr))', gap: 8, overflowX: 'auto', paddingBottom: 2 }}>
              {cards.map((c) => (
                <div key={c.key} style={{ background: 'rgba(5,8,16,0.46)', border: '1px solid rgba(255,255,255,0.09)', borderRadius: 10, padding: '10px 12px' }}>
                  <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.14em', color: 'rgba(148,163,184,0.55)', textTransform: 'uppercase' }}>{c.label}</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: 'rgba(226,232,240,0.92)', marginTop: 4 }}>{c.value}</div>
                  <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.55)', marginTop: 2 }}>Market median <b style={{ color: 'rgba(226,232,240,0.75)' }}>{c.market}</b></div>
                  {c.p != null && (
                    <div style={{ marginTop: 6 }}>
                      <div style={{ fontSize: 9, color: 'rgba(148,163,184,0.55)', marginBottom: 2 }}>P{c.p} <span style={{ opacity: 0.5 }}>vs market</span></div>
                      <div style={{ height: 4, background: 'rgba(255,255,255,0.05)', borderRadius: 2, position: 'relative' }}>
                        <div style={{ position: 'absolute', left: 0, top: 0, height: 4, width: `${c.p}%`, background: c.p > 75 ? '#23d18b' : c.p > 25 ? '#00d4ff' : '#f87171', borderRadius: 2 }} />
                      </div>
                    </div>
                  )}
                </div>
              ))}
            </div>
          </section>

          <section style={{ ...sectionStyle, padding: 0, overflow: 'visible' }}>
            {/* Tab nav */}
            <div style={{ display: 'flex', gap: 4, borderBottom: '1px solid rgba(255,255,255,0.10)', padding: '0 0 0 0', background: 'rgba(5,8,16,0.38)' }}>
              {[
                { k: 'distributions',  label: 'Distributions' },
                { k: 'pricing_curve',  label: 'Pricing Curve' },
                { k: 'rate_curve',     label: 'Rate Curve' },
                { k: 'ded_vs_limit',   label: 'Ded vs Limit' },
                { k: 'aggregates',     label: 'Aggregates' },
              ].map((t) => (
                <button key={t.k} onClick={() => setTab(t.k)}
                  style={{
                    padding: '10px 14px',
                    background: tab === t.k ? 'rgba(0,212,255,0.08)' : 'transparent',
                    border: 'none',
                    borderBottom: tab === t.k ? '2px solid #00d4ff' : '2px solid transparent',
                    color: tab === t.k ? '#00d4ff' : 'rgba(226,232,240,0.65)',
                    fontSize: 11, fontWeight: 700, letterSpacing: '.06em', cursor: 'pointer', textTransform: 'uppercase',
                  }}>
                  {t.label}
                </button>
              ))}
            </div>

            {/* Tab content */}
            <div style={{ minHeight: 220, padding: '14px 16px 18px', overflow: 'visible' }}>
            {tab === 'distributions' && (
              <div>
                <BoxPlot label="Deductible"     values={peerDed}   sourceVal={ded} />
                <BoxPlot label="Limit"          values={peerLimit} sourceVal={totalLim} />
                <BoxPlot label="Ded / Limit"    values={filtered.map((p) => (p.limit > 0 ? p.ded / p.limit : 0))} sourceVal={dOverL} formatter={fmtRatio} />
                <BoxPlot label="Ded / EGNPI"    values={filtered.map((p) => (p.egnpi > 0 ? p.ded / p.egnpi : 0))} sourceVal={dOverE} formatter={fmtRatio} />
                <BoxPlot label="Limit / EGNPI"  values={filtered.map((p) => (p.egnpi > 0 ? p.limit / p.egnpi : 0))} sourceVal={lOverE} formatter={fmtRatio} />
                <BoxPlot label="ROL %"          values={peerRol}   sourceVal={wRol} formatter={fmtPct} />
              </div>
            )}
            {tab === 'pricing_curve' && (() => {
              // Curve fits — source structure + 3 market scopes
              const sourcePts  = sourceLayers.map(fqLayerToXY).filter(Boolean);
              const sourceFit  = fqFitPowerLaw(sourcePts);
              const countryFit = fqFitPowerLaw(peerPools.country.map(fqPeerToXY).filter(Boolean));
              const regionFit  = fqFitPowerLaw(peerPools.region.map(fqPeerToXY).filter(Boolean));
              const globalFit  = fqFitPowerLaw(peerPools.global.map(fqPeerToXY).filter(Boolean));
              const fits = [
                { key: 'source',  label: sourceLabel, color: '#f59e0b', fit: sourceFit, n: sourcePts.length, sample: 'layers' },
                { key: 'country', label: 'Country',  color: '#00d4ff', fit: countryFit, n: countryFit.n, sample: 'treaties' },
                { key: 'region',  label: 'Region',   color: '#a78bfa', fit: regionFit,  n: regionFit.n,  sample: 'treaties' },
                { key: 'global',  label: 'Global',   color: '#4ade80', fit: globalFit,  n: globalFit.n,  sample: 'treaties' },
              ];

              // x-range: cover the union of source pts + all peer pts so curves render comparably
              const allPts = [
                ...sourcePts,
                ...peerPools.country.map(fqPeerToXY).filter(Boolean),
                ...peerPools.region.map(fqPeerToXY).filter(Boolean),
                ...peerPools.global.map(fqPeerToXY).filter(Boolean),
              ];
              const xs = allPts.map((p) => p.x);
              const ys = allPts.map((p) => p.y);
              const xMin = Math.max(1e-6, Math.min(...xs));
              const xMax = Math.max(...xs);
              const yMin = 0;
              const rawYMax = Math.max(...ys, 0.5);
              const X = (v) => 8 + ((v - xMin) / (xMax - xMin || 1)) * 84;

              // Sample 50 points for each curve
              const sample = (a, b) => {
                if (!isFinite(a) || !isFinite(b) || a <= 0) return [];
                const out = [];
                for (let i = 0; i <= 50; i += 1) {
                  const t = i / 50;
                  const x = xMin + (xMax - xMin) * t;
                  const y = a * Math.pow(x, b);
                  if (y > 0 && y <= rawYMax * 3) out.push({ x, y });
                }
                return out;
              };
              const sampledCurves = new Map(fits.map((f) => [f.key, sample(f.fit.a, f.fit.b)]));
              const sampledYs = Array.from(sampledCurves.values()).flat().map((p) => p.y);
              const yMax = Math.max(rawYMax, ...sampledYs) * 1.12;
              const fmtCoef = (v) => (isFinite(v) ? (Math.abs(v) >= 0.01 ? v.toFixed(4) : v.toExponential(2)) : '—');
              const fmtR2   = (v) => (v == null ? '—' : v.toFixed(3));
              const eqStr   = (a, b) => `y = ${fmtCoef(a)} · x^${b >= 0 ? b.toFixed(3) : b.toFixed(3)}`;

              const peerScopePts = (sc) => peerPools[sc].map(fqPeerToXY).filter(Boolean);
              return (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 18 }}>
                  {/* Multi-curve SVG */}
                  <div>
                    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 6 }}>
                      <span style={{ fontSize: 11, fontWeight: 700, color: 'rgba(226,232,240,0.75)' }}>Implied Pricing Curves · y = a·x^b</span>
                      <span style={{ fontSize: 10, color: 'rgba(148,163,184,0.55)' }}>x = √((L+A)·A) / EGNPI · y = ROL %</span>
                    </div>
                    <svg viewBox="0 0 100 72" style={{ width: '100%', height: 'min(52vh, 460px)', minHeight: 380, display: 'block', background: 'rgba(0,0,0,0.20)', borderRadius: 8 }} preserveAspectRatio="none">
                      {[12, 24, 36, 48, 60].map((g) => (<line key={`gy${g}`} x1={6} y1={g} x2={98} y2={g} stroke="rgba(255,255,255,0.06)" strokeWidth="1" shapeRendering="crispEdges" vectorEffect="non-scaling-stroke" />))}
                      {[20, 40, 60, 80].map((g) => (<line key={`gx${g}`} x1={g} y1={6} x2={g} y2={66} stroke="rgba(255,255,255,0.06)" strokeWidth="1" shapeRendering="crispEdges" vectorEffect="non-scaling-stroke" />))}
                      {/* Peer scatter dots, faded — Y mapped to 4..56 */}
                      {(() => {
                        const Y2 = (v) => 66 - ((v - yMin) / (yMax - yMin || 1)) * 60;
                        return (
                          <>
                            {peerScopePts('country').map((p, i) => (<circle key={`c${i}`} cx={X(p.x)} cy={Y2(p.y)} r="0.5" fill="#00d4ff" fillOpacity="0.40" />))}
                            {peerScopePts('region').map((p, i)  => (<circle key={`r${i}`} cx={X(p.x)} cy={Y2(p.y)} r="0.5" fill="#a78bfa" fillOpacity="0.35" />))}
                            {peerScopePts('global').map((p, i)  => (<circle key={`g${i}`} cx={X(p.x)} cy={Y2(p.y)} r="0.5" fill="#4ade80" fillOpacity="0.30" />))}
                            {fits.map((f) => {
                              const pts = sampledCurves.get(f.key) || [];
                              const d = pts.length ? `M ${pts.map((p) => `${X(p.x).toFixed(2)} ${Y2(p.y).toFixed(2)}`).join(' L ')}` : '';
                              return (
                                <path key={f.key} d={d} stroke={f.color} strokeWidth={f.key === 'source' ? '2.4' : '1.6'} strokeDasharray={f.key === 'source' ? '0' : '4 3'} strokeLinejoin="round" strokeLinecap="round" fill="none" strokeOpacity={f.key === 'source' ? 1 : 0.85} vectorEffect="non-scaling-stroke" />
                              );
                            })}
                            {sourcePts.map((p, i) => (
                              <polygon key={`sp${i}`} points={`${X(p.x)},${Y2(p.y) - 1} ${X(p.x) + 0.9},${Y2(p.y)} ${X(p.x)},${Y2(p.y) + 1} ${X(p.x) - 0.9},${Y2(p.y)}`} fill="#fbbf24" stroke="#f59e0b" strokeWidth="1" vectorEffect="non-scaling-stroke" />
                            ))}
                          </>
                        );
                      })()}
                    </svg>
                    {/* Legend */}
                    <div style={{ display: 'flex', gap: 18, flexWrap: 'wrap', marginTop: 10, fontSize: 10 }}>
                      {fits.map((f) => (
                        <span key={f.key} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                          <span style={{ width: 16, height: 2, background: f.color, opacity: f.key === 'source' ? 1 : 0.75, borderRadius: 1 }} />
                          <b style={{ color: f.color, letterSpacing: '.04em' }}>{f.label}</b>
                          <span style={{ color: 'rgba(148,163,184,0.55)' }}>· {f.n} {f.sample}</span>
                        </span>
                      ))}
                    </div>
                  </div>

                  {/* Equations + R² */}
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 10 }}>
                    {fits.map((f) => (
                      <div key={f.key} style={{ background: 'rgba(8,14,30,0.70)', border: `1px solid ${f.color}33`, borderRadius: 10, padding: '10px 12px' }}>
                        <div style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.14em', color: f.color, textTransform: 'uppercase', marginBottom: 4 }}>{f.label}</div>
                        <div style={{ fontSize: 13, fontWeight: 700, color: 'rgba(226,232,240,0.92)', fontFamily: 'var(--font-mono)' }}>{eqStr(f.fit.a, f.fit.b)}</div>
                        <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.65)', marginTop: 4 }}>
                          R² <b style={{ color: 'rgba(226,232,240,0.85)' }}>{fmtR2(f.fit.r2)}</b>
                          {!f.fit.calibrated && <span style={{ marginLeft: 8, color: '#f87171' }}>· market default</span>}
                        </div>
                      </div>
                    ))}
                  </div>

                  {/* Metrics comparison table */}
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.14em', color: 'rgba(148,163,184,0.65)', textTransform: 'uppercase', marginBottom: 6 }}>
                      Curve Metrics Comparison
                    </div>
                    <div style={{ border: '1px solid rgba(255,255,255,0.07)', borderRadius: 8, overflow: 'hidden' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                        <thead style={{ background: 'rgba(5,8,16,0.95)' }}>
                          <tr>
                            <th style={{ padding: '8px 12px', textAlign: 'left', fontSize: 10, fontWeight: 800, letterSpacing: '.12em', color: 'rgba(148,163,184,0.65)', textTransform: 'uppercase' }}>Metric</th>
                            {fits.map((f) => (
                              <th key={f.key} style={{ padding: '8px 12px', textAlign: 'right', fontSize: 10, fontWeight: 800, letterSpacing: '.12em', color: f.color, textTransform: 'uppercase' }}>{f.label}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {[
                            { k: 'a',     label: 'a coefficient',  cell: (f) => fmtCoef(f.fit.a) },
                            { k: 'b',     label: 'b exponent',     cell: (f) => fmtCoef(f.fit.b) },
                            { k: 'r2',    label: 'R²',             cell: (f) => fmtR2(f.fit.r2) },
                            { k: 'n',     label: 'Sample size',    cell: (f) => `${f.n} ${f.sample}` },
                            { k: 'cal',   label: 'Calibrated',     cell: (f) => f.fit.calibrated ? '✓' : '— (market default)' },
                            { k: 'rolAt', label: 'ROL @ x = 0.05', cell: (f) => `${(f.fit.a * Math.pow(0.05, f.fit.b) * 100).toFixed(2)}%` },
                            { k: 'rolMid',label: 'ROL @ x = 0.10', cell: (f) => `${(f.fit.a * Math.pow(0.10, f.fit.b) * 100).toFixed(2)}%` },
                            { k: 'rolHi', label: 'ROL @ x = 0.20', cell: (f) => `${(f.fit.a * Math.pow(0.20, f.fit.b) * 100).toFixed(2)}%` },
                          ].map((row) => (
                            <tr key={row.k} style={{ borderTop: '1px solid rgba(255,255,255,0.05)' }}>
                              <td style={{ padding: '6px 12px', color: 'rgba(226,232,240,0.85)' }}>{row.label}</td>
                              {fits.map((f) => (
                                <td key={f.key} style={{ padding: '6px 12px', textAlign: 'right', fontFamily: 'var(--font-mono)', color: f.key === 'source' ? f.color : 'rgba(226,232,240,0.85)' }}>{row.cell(f)}</td>
                              ))}
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.45)', marginTop: 6 }}>
                      ROL @ x rows show what the fitted curve predicts at three reference points (x = √((L+A)·A)/EGNPI). Useful for at-a-glance pricing comparison across scopes.
                    </div>
                  </div>
                </div>
              );
            })()}
            {tab === 'rate_curve' && (
              <Scatter xKey="limit" yKey="rolPct" xLabel="Limit / EGNPI" yLabel="ROL %" sourceX={totalLim} sourceY={wRol} />
            )}
            {tab === 'ded_vs_limit' && (
              <Scatter xKey="ded" yKey="limit" xLabel="Deductible" yLabel="Limit" sourceX={ded} sourceY={totalLim} />
            )}
            {tab === 'aggregates' && (
              <div>
                <BoxPlot label="Aggregate Ded / EGNPI" values={filtered.map((p) => (p.egnpi > 0 ? p.ded * 0.6 / p.egnpi : 0))} sourceVal={totalEgnpi > 0 ? ded * 0.6 / totalEgnpi : 0} formatter={fmtRatio} />
                <BoxPlot label="Aggregate Limit / EGNPI" values={filtered.map((p) => (p.egnpi > 0 ? p.limit * 1.2 / p.egnpi : 0))} sourceVal={totalEgnpi > 0 ? totalLim * 1.2 / totalEgnpi : 0} formatter={fmtRatio} />
                <BoxPlot label="Occurrence Ded / Limit" values={filtered.map((p) => (p.limit > 0 ? p.ded / p.limit : 0))} sourceVal={dOverL} formatter={fmtRatio} />
                <BoxPlot label="Rate %" values={peerRol} sourceVal={wRol} formatter={fmtPct} />
              </div>
            )}
            </div>
          </section>

          {/* Comparable treaty table */}
          <section style={{ ...sectionStyle, marginTop: 2, borderTop: '1px solid rgba(0,212,255,0.32)', boxShadow: '0 -1px 0 rgba(0,212,255,0.12), 0 1px 0 rgba(255,255,255,0.035) inset' }}>
            <div style={{ ...sectionTitleStyle, marginBottom: 8 }}>
              Comparable treaties · top {Math.min(25, sortedFiltered.length)}
            </div>
            <div style={{ border: '1px solid rgba(255,255,255,0.07)', borderRadius: 8 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead style={{ background: 'rgba(5,8,16,0.95)' }}>
                  <tr>
                    {[
                      { k: 'cedant',  label: 'Cedant' },
                      { k: 'cob',     label: 'COB' },
                      { k: 'country', label: 'Country' },
                      { k: 'limit',   label: 'Limit' },
                      { k: 'ded',     label: 'Deductible' },
                      { k: 'egnpi',   label: 'EGNPI' },
                      { k: 'rolPct',  label: 'ROL %' },
                    ].map((h) => (
                      <th key={h.k} onClick={headerSort(h.k)} style={{ padding: '6px 10px', textAlign: h.k === 'cedant' || h.k === 'cob' || h.k === 'country' ? 'left' : 'right', fontSize: 10, fontWeight: 800, letterSpacing: '.12em', color: 'rgba(148,163,184,0.65)', textTransform: 'uppercase', cursor: 'pointer', borderBottom: '1px solid rgba(255,255,255,0.10)', userSelect: 'none' }}>
                        {h.label}{sortArrow(h.k)}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {sortedFiltered.slice(0, 25).map((p) => (
                    <tr key={p.id} style={{ borderBottom: '1px solid rgba(255,255,255,0.04)' }}>
                      <td style={{ padding: '5px 10px', color: 'rgba(226,232,240,0.85)' }}>{p.cedant}</td>
                      <td style={{ padding: '5px 10px' }}><span style={{ display: 'inline-block', padding: '1px 6px', borderRadius: 6, background: `${cobColor(p.cob)}1f`, border: `1px solid ${cobColor(p.cob)}55`, color: cobColor(p.cob), fontSize: 10, fontWeight: 700 }}>{p.cob}</span></td>
                      <td style={{ padding: '5px 10px', color: 'rgba(148,163,184,0.75)' }}>{p.country}</td>
                      <td style={{ padding: '5px 10px', textAlign: 'right' }}>{fmt(p.limit)}</td>
                      <td style={{ padding: '5px 10px', textAlign: 'right' }}>{fmt(p.ded)}</td>
                      <td style={{ padding: '5px 10px', textAlign: 'right' }}>{fmt(p.egnpi)}</td>
                      <td style={{ padding: '5px 10px', textAlign: 'right', color: '#00d4ff', fontWeight: 700 }}>{fmtPct(p.rolPct)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <div style={{ fontSize: 10, color: 'rgba(148,163,184,0.45)', marginTop: 6 }}>
              Click any column header to sort. {currency ? `Values in ${currency}.` : ''} Peer data is sourced from the live portfolio index.
            </div>
          </section>

          {/* AI commentary — lazy, triggered by button. */}
          <section style={sectionStyle}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
              <div style={sectionTitleStyle}>Market Intelligence · AI Commentary</div>
              <button
                onClick={runCommentary}
                disabled={commentaryLoading || filtered.length === 0 || !contractId}
                style={{
                  appearance: 'none',
                  padding: '6px 14px',
                  border: '1px solid rgba(0,212,255,0.35)',
                  borderRadius: 8,
                  background: 'rgba(0,212,255,0.08)',
                  color: '#00d4ff',
                  fontSize: 11,
                  fontWeight: 800,
                  letterSpacing: '.08em',
                  textTransform: 'uppercase',
                  cursor: commentaryLoading || filtered.length === 0 || !contractId ? 'not-allowed' : 'pointer',
                  opacity: commentaryLoading || filtered.length === 0 || !contractId ? 0.5 : 1,
                }}
              >
                {commentaryLoading ? 'Generating…' : activeCommentary ? 'Regenerate' : 'Generate'}
              </button>
            </div>
            {commentaryError && (
              <div style={{ fontSize: 12, color: '#f87171', marginBottom: 8 }}>{commentaryError}</div>
            )}
            {!activeCommentary && !commentaryLoading && !commentaryError && (
              <div style={{ fontSize: 12, color: 'rgba(148,163,184,0.65)' }}>
                {filtered.length === 0
                  ? 'No peers available for the current scope — switch to a wider scope to enable commentary.'
                  : 'Click Generate to surface AI analysis on how this structure\'s deductible, limit, and exposure positioning compare to the peer median.'}
              </div>
            )}
            {activeCommentary && (
              <div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 10 }}>
                  <span style={{
                    display: 'inline-block',
                    padding: '3px 10px',
                    borderRadius: 999,
                    background: `${verdictColor[activeCommentary.signal] || '#94a3b8'}1f`,
                    border: `1px solid ${verdictColor[activeCommentary.signal] || '#94a3b8'}55`,
                    color: verdictColor[activeCommentary.signal] || '#94a3b8',
                    fontSize: 10,
                    fontWeight: 800,
                    letterSpacing: '.12em',
                  }}>
                    {activeCommentary.signal}
                  </span>
                  <span style={{ fontSize: 10, color: 'rgba(148,163,184,0.55)' }}>
                    {scope.toUpperCase()} scope · {filtered.length} peers
                  </span>
                </div>
                <p style={{ fontSize: 13, lineHeight: 1.55, color: 'rgba(226,232,240,0.85)', margin: '0 0 14px' }}>
                  {activeCommentary.commentary}
                </p>
                {Array.isArray(activeCommentary.highlights) && activeCommentary.highlights.length > 0 && (
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 8 }}>
                    {activeCommentary.highlights.map((h, i) => (
                      <div key={i} style={{
                        background: 'rgba(5,8,16,0.46)',
                        border: '1px solid rgba(255,255,255,0.09)',
                        borderRadius: 8,
                        padding: '8px 10px',
                      }}>
                        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'baseline', marginBottom: 4 }}>
                          <span style={{ fontSize: 10, fontWeight: 800, letterSpacing: '.10em', color: 'rgba(148,163,184,0.65)', textTransform: 'uppercase' }}>{h.metric}</span>
                          <span style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.10em', color: verdictColor[h.verdict] || '#94a3b8' }}>
                            {h.verdict}
                          </span>
                        </div>
                        <div style={{ fontSize: 11, color: 'rgba(226,232,240,0.78)', lineHeight: 1.45 }}>{h.note}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
