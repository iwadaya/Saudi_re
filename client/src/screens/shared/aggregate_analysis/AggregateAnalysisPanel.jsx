// AggregateAnalysisPanel.jsx — Shared bare-content aggregate analysis panel
// (country/zone/COB drill-down) with no modal chrome, so it can live inside a
// Modal on the proportional pricing screen or be embedded as a tab elsewhere.
// Phase 3.2 hardening: chrome comes from the ui primitives (Badge); the
// screen-specific skin lives in AggregateAnalysisPanel.css. The only inline
// styles left are genuinely dynamic (peril colors, meter widths).
import { useState, useEffect, useMemo, useRef } from 'react';
import { api } from '../../../api';
import { Badge, PctInput } from '../../../components/ui';
import { toN as cn } from '../../../utils/format.js';
import './AggregateAnalysisPanel.css';

const PERILS = ['eq_agg','ws_agg','flood_agg','srcc_agg','others_agg'];
const PERIL_LABELS = { eq_agg:'EQ', ws_agg:'WS', flood_agg:'Flood', srcc_agg:'SRCC', others_agg:'Other' };
const PERIL_COLORS = { eq_agg:'#f87171', ws_agg:'#60a5fa', flood_agg:'#34d399', srcc_agg:'#fbbf24', others_agg:'#a78bfa' };

const fmt = n => n > 0 ? (n >= 1e9 ? (n/1e9).toFixed(1)+'B' : n >= 1e6 ? (n/1e6).toFixed(1)+'M' : n >= 1e3 ? (n/1e3).toFixed(0)+'K' : n.toFixed(0)) : '—';
const fmtFull = n => Number.isFinite(n) && n > 0 ? n.toLocaleString('en-US', {maximumFractionDigits:0}) : '—';
const pct = (n, total) => total > 0 ? ((n/total)*100).toFixed(1)+'%' : '—';

const TABS = [
  { key: 'summary',   label: 'Summary' },
  { key: 'zones',     label: 'By Zone' },
  { key: 'cob',       label: 'By Class' },
  { key: 'portfolio', label: 'Portfolio' },
];

function PerilBar({ row, total }) {
  return (
    <div className="agg-mix">
      {PERILS.map(p => {
        const v = cn(row[p]);
        const w = total > 0 ? (v/total)*100 : 0;
        if (w < 0.5) return null;
        return <div key={p} className="agg-mix__seg" style={{ width:`${w}%`, background: PERIL_COLORS[p] }} title={`${PERIL_LABELS[p]}: ${fmt(v)}`} />;
      })}
    </div>
  );
}

function Legend() {
  return (
    <div className="agg-legend">
      {PERILS.map(p => (
        <div key={p} className="agg-legend__item">
          <div className="agg-swatch" style={{ background: PERIL_COLORS[p] }} />
          {PERIL_LABELS[p]}
        </div>
      ))}
    </div>
  );
}

// Shared "% of portfolio" meter — the dynamic width is the one inline style.
function MeterBar({ value, cap = true, dim = false }) {
  return (
    <div className={`agg-bar${cap ? ' agg-bar--cap' : ''}`}>
      <div className={`agg-bar__fill${dim ? ' agg-bar__fill--dim' : ''}`} style={{ width:`${Math.min(value,100)}%` }} />
    </div>
  );
}

export default function AggregateAnalysisPanel({ contractId, onMeta }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('summary');
  const [sortZone, setSortZone] = useState('total_agg');
  const [sortCob, setSortCob] = useState('total_agg');
  const [filterPeril, setFilterPeril] = useState(null);
  const [portfolioShareInput, setPortfolioShareInput] = useState('');

  const onMetaRef = useRef(onMeta);
  onMetaRef.current = onMeta;

  useEffect(() => {
    // Guard against a stale response for a previous contractId overwriting the
    // current one's data.
    let cancelled = false;
    api.getAggDrilldown(contractId).then(d => {
      if (cancelled) return;
      setData(d);
      onMetaRef.current?.(d?.contract || null);
      setLoading(false);
    }).catch(e => {
      if (cancelled) return;
      setError(e.message);
      setLoading(false);
    });
    return () => { cancelled = true; };
  }, [contractId]);

  // Totals
  const contractTotal = useMemo(() => (data?.zones||[]).reduce((s,r)=>s+cn(r.total_agg),0), [data]);
  const portfolioTotal = useMemo(() => (data?.portfolio?.zones||[]).reduce((s,r)=>s+cn(r.total_agg),0), [data]);
  const peakCell = useMemo(() => {
    let best = { value: 0, zone: null, peril: null };
    for (const z of (data?.zones || [])) {
      for (const p of PERILS) {
        const v = cn(z[p]);
        if (v > best.value) {
          best = { value: v, zone: z, peril: p };
        }
      }
    }
    return best;
  }, [data]);
  const portfolioZoneMap = useMemo(() => {
    const m = new Map();
    for (const z of (data?.portfolio?.zones || [])) {
      m.set(z.zone_id, z);
    }
    return m;
  }, [data]);
  const contractByPeril = useMemo(() => {
    const m = {};
    for (const p of PERILS) {
      m[p] = (data?.zones || []).reduce((s, r) => s + cn(r[p]), 0);
    }
    return m;
  }, [data]);
  const portfolioByPeril = useMemo(() => {
    const m = {};
    for (const p of PERILS) {
      m[p] = (data?.portfolio?.zones || []).reduce((s, r) => s + cn(r[p]), 0);
    }
    return m;
  }, [data]);
  const allClasses = useMemo(() => {
    const set = new Set();
    for (const r of (data?.cob || [])) set.add(r.cob);
    for (const r of (data?.portfolio?.cob || [])) set.add(r.cob);
    return [...set];
  }, [data]);

  return (
    <>
      {/* ── Tabs ── */}
      <div className="agg-tabs">
        {TABS.map(t => (
          <button key={t.key} type="button" onClick={() => setTab(t.key)}
            className={`agg-tab${tab===t.key ? ' agg-tab--active' : ''}`}>
            {t.label}
          </button>
        ))}
      </div>

      {/* ── Content ── */}
      <div className="agg-content">

        {loading && <div className="agg-loading">Loading aggregate data…</div>}
        {error && <div className="agg-error">Error: {error}</div>}

        {data && tab === 'summary' && (() => {
          const signedLine = cn(data.contract?.signed_line_pct);
          const peakPctOfContract = contractTotal > 0 ? (peakCell.value / contractTotal) * 100 : 0;
          const portfolioPeakZone = peakCell.zone ? (data.portfolio?.zones||[]).find(z => z.zone_id === peakCell.zone.zone_id) : null;
          const portfolioPeakPerilVal = portfolioPeakZone && peakCell.peril ? cn(portfolioPeakZone[peakCell.peril]) : 0;
          const peakPctOfCountryPeril = portfolioPeakPerilVal > 0 ? (peakCell.value / portfolioPeakPerilVal) * 100 : 0;
          return (
          <div className="agg-stack">
            {/* (a) Country header strip */}
            <div className="agg-hero">
              <div className="agg-hero__label">
                Aggregate Exposure — {data.contract?.country_name || '—'} · UW {data.contract?.uw_year || '—'}
              </div>
              <div className="agg-hero__value">
                {fmt(contractTotal)}
              </div>
              <div className="agg-hero__sub">
                Total contract aggregate at 100%
              </div>
            </div>

            {/* (b) Peril breakdown bar */}
            <div className="agg-panel">
              <div className="agg-panel__title">Peril Breakdown — This Contract</div>
              <div className="agg-chip-row">
                {PERILS.map(p => {
                  const v = data.zones?.reduce((s,r)=>s+cn(r[p]),0)||0;
                  const pctVal = contractTotal > 0 ? (v/contractTotal*100).toFixed(0) : 0;
                  const active = filterPeril === p;
                  return (
                    <button key={p} type="button" className="agg-chip"
                      style={{ background: active ? `${PERIL_COLORS[p]}22` : undefined, borderColor: active ? PERIL_COLORS[p] : undefined }}
                      onClick={() => setFilterPeril(active ? null : p)}>
                      <span className="agg-chip__label" style={{ color: PERIL_COLORS[p] }}>{PERIL_LABELS[p]}</span>
                      <span className="agg-chip__value">{fmt(v)}</span>
                      <span className="agg-chip__sub">{pctVal}% of total</span>
                    </button>
                  );
                })}
              </div>
              <Legend />
            </div>

            {/* (c) Peak exposure zone-peril combo card */}
            {peakCell.value > 0 ? (
              <div className="agg-peak" style={{ border:`1px solid ${PERIL_COLORS[peakCell.peril]}`, boxShadow:`0 0 24px ${PERIL_COLORS[peakCell.peril]}15` }}>
                <div className="agg-peak__title">Peak Exposure</div>
                <div className="agg-peak__combo" style={{ color: PERIL_COLORS[peakCell.peril] }}>
                  {peakCell.zone.zone_name || peakCell.zone.zone_id} — {PERIL_LABELS[peakCell.peril]}
                </div>
                <div className="agg-peak__value">
                  {fmt(peakCell.value)}
                </div>
                <div className="agg-peak__note">
                  {peakPctOfContract.toFixed(1)}% of contract total
                </div>
                {portfolioPeakPerilVal > 0 && (
                  <div className="agg-peak__note agg-peak__note--tight">
                    {peakPctOfCountryPeril.toFixed(1)}% of country&apos;s {PERIL_LABELS[peakCell.peril]} exposure in this zone
                  </div>
                )}
              </div>
            ) : (
              <div className="agg-empty">
                No exposure data captured for this contract yet.
              </div>
            )}

            {/* (d) "At your signed line" hint */}
            {signedLine > 0 && (
              <div className="agg-hint">
                At your signed line of {signedLine.toFixed(2)}%, your share of this contract&apos;s total = {fmt(contractTotal * (signedLine/100))}
              </div>
            )}

            {/* (e) Top zones preview */}
            <div className="agg-panel">
              <div className="agg-panel__title">Top Zones by Aggregate</div>
              {(data.zones||[]).slice(0,5).map((z,i) => (
                <div key={i} className="agg-zone-row">
                  <div className="agg-zone-row__head">
                    <span className="agg-zone-row__name">{z.zone_name||z.zone_id}</span>
                    <span className="agg-zone-row__val">{fmt(cn(z.total_agg))}</span>
                  </div>
                  <PerilBar row={z} total={cn(z.total_agg)} />
                </div>
              ))}
              {(data.zones||[]).length > 5 && <button type="button" className="agg-link-btn" onClick={()=>setTab('zones')}>View all {data.zones.length} zones →</button>}
            </div>
          </div>
          );
        })()}

        {data && tab === 'zones' && (
          <div>
            <div className="agg-toolbar">
              <div className="agg-toolbar__note">{(data.zones||[]).length} zones · click column headers to sort</div>
              <Legend />
            </div>
            <table className="agg-table">
              <thead>
                <tr>
                  <th className="agg-th" onClick={()=>setSortZone('zone_name')}>Zone</th>
                  <th className="agg-th agg-th--num" onClick={()=>setSortZone('total_agg')}>Total Agg {sortZone==='total_agg'&&'▼'}</th>
                  <th className="agg-th agg-th--num" onClick={()=>setSortZone('eq_agg')}>EQ {sortZone==='eq_agg'&&'▼'}</th>
                  <th className="agg-th agg-th--num" onClick={()=>setSortZone('ws_agg')}>WS {sortZone==='ws_agg'&&'▼'}</th>
                  <th className="agg-th agg-th--num" onClick={()=>setSortZone('flood_agg')}>Flood {sortZone==='flood_agg'&&'▼'}</th>
                  <th className="agg-th agg-th--num" onClick={()=>setSortZone('srcc_agg')}>SRCC {sortZone==='srcc_agg'&&'▼'}</th>
                  <th className="agg-th agg-th--num">Other</th>
                  <th className="agg-th agg-th--w160">Peril Mix</th>
                  <th className="agg-th agg-th--num" onClick={()=>setSortZone('portfolio_total')}>Portfolio (Country) {sortZone==='portfolio_total'&&'▼'}</th>
                  <th className="agg-th agg-th--w140">% of Country Zone</th>
                </tr>
              </thead>
              <tbody>
                {[...(data.zones||[])].sort((a,b) => {
                    if (sortZone === 'zone_name') return (a.zone_name||'').localeCompare(b.zone_name||'');
                    if (sortZone === 'portfolio_total') return cn(portfolioZoneMap.get(b.zone_id)?.total_agg) - cn(portfolioZoneMap.get(a.zone_id)?.total_agg);
                    return cn(b[sortZone]) - cn(a[sortZone]);
                  })
                  .filter(z => !filterPeril || cn(z[filterPeril]) > 0)
                  .map((z,i) => {
                  const tot = cn(z.total_agg);
                  const portfolioZone = portfolioZoneMap.get(z.zone_id);
                  const portfolioZoneTotal = portfolioZone ? cn(portfolioZone.total_agg) : 0;
                  const pctOfCountryZone = portfolioZoneTotal > 0 ? (tot / portfolioZoneTotal) * 100 : 0;
                  return (
                    <tr key={i}>
                      <td className="agg-td">
                        <div className="agg-strong">{z.zone_name||z.zone_id}</div>
                        <div className="agg-cell-id">{z.zone_id}</div>
                      </td>
                      <td className="agg-td agg-td--num agg-td--total">{fmtFull(tot)}</td>
                      <td className="agg-td agg-td--num agg-td--eq">{fmt(cn(z.eq_agg))}</td>
                      <td className="agg-td agg-td--num agg-td--ws">{fmt(cn(z.ws_agg))}</td>
                      <td className="agg-td agg-td--num agg-td--flood">{fmt(cn(z.flood_agg))}</td>
                      <td className="agg-td agg-td--num agg-td--srcc">{fmt(cn(z.srcc_agg))}</td>
                      <td className="agg-td agg-td--num agg-td--other">{fmt(cn(z.others_agg))}</td>
                      <td className="agg-td agg-td--w160"><PerilBar row={z} total={tot} /></td>
                      <td className="agg-td agg-td--num agg-td--dim">{portfolioZoneTotal > 0 ? fmtFull(portfolioZoneTotal) : '—'}</td>
                      <td className="agg-td agg-td--w140">
                        {portfolioZoneTotal > 0 ? (
                          <div className="agg-inline">
                            <span className="agg-pct__label">{pctOfCountryZone.toFixed(1)}%</span>
                            <MeterBar value={pctOfCountryZone} />
                          </div>
                        ) : (
                          <span className="agg-dash">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
              <tfoot>
                <tr className="agg-tr--foot">
                  <td className="agg-td agg-td--foot">TOTAL</td>
                  <td className="agg-td agg-td--num agg-td--foot-num">{fmtFull(contractTotal)}</td>
                  {PERILS.map(p => <td key={p} className="agg-td agg-td--num agg-td--w700">{fmtFull(contractByPeril[p] || 0)}</td>)}
                  <td className="agg-td" />
                  <td className="agg-td agg-td--num agg-td--foot-dim">{fmtFull(portfolioTotal)}</td>
                  <td className="agg-td agg-td--w140">
                    {portfolioTotal > 0 ? (
                      <div className="agg-inline">
                        <span className="agg-pct__label agg-pct__label--bold">{((contractTotal/portfolioTotal)*100).toFixed(1)}%</span>
                        <MeterBar value={(contractTotal/portfolioTotal)*100} />
                      </div>
                    ) : (
                      <span className="agg-dash">—</span>
                    )}
                  </td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}

        {data && tab === 'cob' && (
          <div>
            <div className="agg-toolbar">
              <div className="agg-toolbar__note">Aggregates split by Class of Business — this contract vs country portfolio</div>
              <Legend />
            </div>
            <table className="agg-table">
              <thead>
                <tr>
                  <th className="agg-th" onClick={()=>setSortCob('cob')}>Class of Business</th>
                  <th className="agg-th agg-th--num" onClick={()=>setSortCob('total_agg')}>This Contract {sortCob==='total_agg'&&'▼'}</th>
                  <th className="agg-th agg-th--num">EQ</th>
                  <th className="agg-th agg-th--num">WS</th>
                  <th className="agg-th agg-th--num">Flood</th>
                  <th className="agg-th agg-th--num">SRCC</th>
                  <th className="agg-th agg-th--w120">Mix</th>
                  <th className="agg-th agg-th--num">Country Portfolio</th>
                  <th className="agg-th agg-th--w140">Contract %</th>
                </tr>
              </thead>
              <tbody>
                {[...(data.cob||[])].sort((a,b) => sortCob==='cob' ? a.cob.localeCompare(b.cob) : cn(b[sortCob])-cn(a[sortCob]))
                  .map((r,i) => {
                  const tot = cn(r.total_agg);
                  const portCob = (data.portfolio?.cob||[]).find(p=>p.cob===r.cob);
                  const portTot = cn(portCob?.total_agg);
                  return (
                    <tr key={i}>
                      <td className="agg-td agg-strong">{r.cob}</td>
                      <td className="agg-td agg-td--num agg-td--total">{fmtFull(tot)}</td>
                      <td className="agg-td agg-td--num agg-td--eq">{fmt(cn(r.eq_agg))}</td>
                      <td className="agg-td agg-td--num agg-td--ws">{fmt(cn(r.ws_agg))}</td>
                      <td className="agg-td agg-td--num agg-td--flood">{fmt(cn(r.flood_agg))}</td>
                      <td className="agg-td agg-td--num agg-td--srcc">{fmt(cn(r.srcc_agg))}</td>
                      <td className="agg-td agg-td--w120"><PerilBar row={r} total={tot} /></td>
                      <td className="agg-td agg-td--num agg-td--dim">{portTot > 0 ? fmtFull(portTot) : '—'}</td>
                      <td className="agg-td agg-td--w140">
                        {portTot > 0 ? (() => {
                          const ratio = tot / portTot;
                          const pctVal = ratio * 100;
                          return (
                            <div className="agg-inline">
                              <span className={`agg-pct__label ${ratio > 0.5 ? 'agg-pct__label--hot' : 'agg-pct__label--ok'}`}>{pctVal.toFixed(1)}%</span>
                              <MeterBar value={pctVal} />
                            </div>
                          );
                        })() : (
                          <span className="agg-dash">—</span>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}

        {data && tab === 'portfolio' && (() => {
          const portfolioShareRaw = parseFloat(String(portfolioShareInput || '').replace('%', ''));
          const portfolioShareFrac = Number.isFinite(portfolioShareRaw)
            ? Math.max(0, Math.min(100, portfolioShareRaw)) / 100
            : 0;
          const totalOfRow = (row) => row ? cn(row.eq_agg) + cn(row.ws_agg) + cn(row.flood_agg) + cn(row.srcc_agg) + cn(row.others_agg) : 0;

          const growthClass = (g, hasShare) => {
            if (!hasShare) return 'agg-tone-flat';
            if (g > 0.0005) return 'agg-tone-up';
            if (g < -0.0005) return 'agg-tone-down';
            return 'agg-tone-flat';
          };
          const fmtGrowth = (g, hasShare) => {
            if (!hasShare) return '—';
            const sign = g > 0 ? '+' : '';
            return `${sign}${g.toFixed(1)}%`;
          };
          const hasShare = portfolioShareFrac > 0;
          // Bound contracts already sit in the country portfolio at 100%, so
          // applying a share first removes that contribution. Quotes are not
          // in the book yet — their share is purely additive.
          const inPortfolio = data.contract?.portfolio_includes_contract !== false;
          const newTotalAtShare = (portCur, contractTot) => {
            if (!hasShare) return portCur;
            const contrib = contractTot * portfolioShareFrac;
            return inPortfolio ? portCur - contractTot + contrib : portCur + contrib;
          };

          return (
          <div className="agg-stack">
            {/* (a) Share input bar */}
            <div className="agg-share-bar">
              <span className="agg-share-bar__label">Apply share %:</span>
              <div className="agg-share-bar__input">
                <PctInput value={portfolioShareInput}
                  onChange={v => setPortfolioShareInput(v)}
                  placeholder="e.g. 5%" />
              </div>
              <span className="agg-share-bar__note">
                Type a share to see how this contract would affect the country book.
              </span>
            </div>

            {/* (b) Two side-by-side share-impact panels */}
            <div className="agg-panel-row">
              {/* Panel 1 — By Peril */}
              <div className="agg-panel agg-panel--grow">
                <div className="agg-panel__title agg-panel__title--spaced">Share Impact By Peril</div>
                <table className="agg-table">
                  <thead>
                    <tr>
                      <th className="agg-th agg-th--plain">Peril</th>
                      <th className="agg-th agg-th--num agg-th--plain">Country Portfolio</th>
                      <th className="agg-th agg-th--num agg-th--plain">Contract @ Share</th>
                      <th className="agg-th agg-th--num agg-th--plain">New Portfolio Total</th>
                      <th className="agg-th agg-th--num agg-th--plain">Growth</th>
                    </tr>
                  </thead>
                  <tbody>
                    {PERILS.map((p) => {
                      const portCur = portfolioByPeril[p] || 0;
                      const contractPeril = contractByPeril[p] || 0;
                      const myContribAtShare = contractPeril * portfolioShareFrac;
                      const newTotal = newTotalAtShare(portCur, contractPeril);
                      const growthPct = portCur > 0 ? ((newTotal - portCur) / portCur) * 100 : 0;
                      return (
                        <tr key={p}>
                          <td className="agg-td">
                            <div className="agg-inline">
                              <span className="agg-swatch" style={{ background: PERIL_COLORS[p] }} />
                              <span className="agg-strong">{PERIL_LABELS[p]}</span>
                            </div>
                          </td>
                          <td className="agg-td agg-td--num agg-td--cur">{fmt(portCur)}</td>
                          <td className={`agg-td agg-td--num ${hasShare ? 'agg-td--share' : 'agg-td--share-empty'}`}>{hasShare ? fmt(myContribAtShare) : '—'}</td>
                          <td className="agg-td agg-td--num agg-td--total">{fmt(newTotal)}</td>
                          <td className={`agg-td agg-td--num agg-td--growth ${growthClass(growthPct, hasShare)}`}>{fmtGrowth(growthPct, hasShare)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>

              {/* Panel 2 — By Class */}
              <div className="agg-panel agg-panel--grow">
                <div className="agg-panel__title agg-panel__title--spaced">Share Impact By Class</div>
                <table className="agg-table">
                  <thead>
                    <tr>
                      <th className="agg-th agg-th--plain">Class</th>
                      <th className="agg-th agg-th--num agg-th--plain">Country Portfolio</th>
                      <th className="agg-th agg-th--num agg-th--plain">Contract @ Share</th>
                      <th className="agg-th agg-th--num agg-th--plain">New Portfolio Total</th>
                      <th className="agg-th agg-th--num agg-th--plain">Growth</th>
                    </tr>
                  </thead>
                  <tbody>
                    {allClasses.map((clsName) => {
                      const contractRow = (data.cob || []).find(r => r.cob === clsName);
                      const portfolioRow = (data.portfolio?.cob || []).find(r => r.cob === clsName);
                      const contractTot = totalOfRow(contractRow);
                      const portCur = totalOfRow(portfolioRow);
                      const myContribAtShare = contractTot * portfolioShareFrac;
                      const newTotal = newTotalAtShare(portCur, contractTot);
                      const growthPct = portCur > 0 ? ((newTotal - portCur) / portCur) * 100 : 0;
                      return (
                        <tr key={clsName}>
                          <td className="agg-td agg-strong">{clsName}</td>
                          <td className="agg-td agg-td--num agg-td--cur">{fmt(portCur)}</td>
                          <td className={`agg-td agg-td--num ${hasShare ? 'agg-td--share' : 'agg-td--share-empty'}`}>{hasShare ? fmt(myContribAtShare) : '—'}</td>
                          <td className="agg-td agg-td--num agg-td--total">{fmt(newTotal)}</td>
                          <td className={`agg-td agg-td--num agg-td--growth ${growthClass(growthPct, hasShare)}`}>{fmtGrowth(growthPct, hasShare)}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            </div>

            {/* (c) Active contracts table */}
            <div className="agg-panel">
              <div className="agg-panel__title agg-panel__title--mb12">Active Contracts in Country (by Total Agg)</div>
              <table className="agg-table">
                <thead>
                  <tr>
                    <th className="agg-th">Cedant</th>
                    <th className="agg-th agg-th--center">UW Year</th>
                    <th className="agg-th agg-th--num">Total Agg</th>
                    <th className="agg-th agg-th--w120">Share of Portfolio</th>
                  </tr>
                </thead>
                <tbody>
                  {(data.portfolio?.contracts||[]).map((c,i) => {
                    const tot = cn(c.total_agg);
                    const isThisContract = c.contract_id === contractId;
                    return (
                      <tr key={i} className={isThisContract ? 'agg-tr--this' : undefined}>
                        <td className={`agg-td ${isThisContract ? 'agg-td--cedant-this' : 'agg-td--cedant'}`}>
                          {c.cedant_name||'Unknown'}
                          {isThisContract && <Badge className="agg-badge-this">THIS</Badge>}
                        </td>
                        <td className="agg-td agg-td--center agg-td--mid">{c.uw_year}</td>
                        <td className="agg-td agg-td--num agg-td--total">{fmtFull(tot)}</td>
                        <td className="agg-td">
                          <div className="agg-inline">
                            <MeterBar value={(tot/portfolioTotal)*100} cap={false} dim={!isThisContract} />
                            <span className="agg-pct__share">{pct(tot,portfolioTotal)}</span>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
          );
        })()}

      </div>
    </>
  );
}
