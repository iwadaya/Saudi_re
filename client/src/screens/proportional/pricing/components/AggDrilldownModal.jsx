// AggDrilldownModal.jsx — Full-screen aggregate analysis with country/zone/COB drill-down
import { useState, useEffect, useMemo } from 'react';
import { api } from '../../../../api';
import PctInput from '../../../../components/PctInput';
import { toN as cn } from '../../../../utils/format.js';

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
    <div style={{ display:'flex', height:6, borderRadius:3, overflow:'hidden', width:'100%', gap:1 }}>
      {PERILS.map(p => {
        const v = cn(row[p]);
        const w = total > 0 ? (v/total)*100 : 0;
        if (w < 0.5) return null;
        return <div key={p} style={{ width:`${w}%`, background: PERIL_COLORS[p], minWidth:2 }} title={`${PERIL_LABELS[p]}: ${fmt(v)}`} />;
      })}
    </div>
  );
}

function Legend() {
  return (
    <div style={{ display:'flex', gap:12, flexWrap:'wrap' }}>
      {PERILS.map(p => (
        <div key={p} style={{ display:'flex', alignItems:'center', gap:4, fontSize:10, color:'rgba(255,255,255,0.5)' }}>
          <div style={{ width:8, height:8, borderRadius:2, background: PERIL_COLORS[p] }} />
          {PERIL_LABELS[p]}
        </div>
      ))}
    </div>
  );
}

export default function AggDrilldownModal({ contractId, shareRows: _shareRows, onClose }) {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [tab, setTab] = useState('summary');
  const [sortZone, setSortZone] = useState('total_agg');
  const [sortCob, setSortCob] = useState('total_agg');
  const [filterPeril, setFilterPeril] = useState(null);
  const [portfolioShareInput, setPortfolioShareInput] = useState('');

  useEffect(() => {
    api.getAggDrilldown(contractId).then(d => {
      setData(d);
      setLoading(false);
    }).catch(e => {
      setError(e.message);
      setLoading(false);
    });
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

  const thS = { padding:'8px 12px', fontSize:10, fontWeight:700, letterSpacing: 0, textTransform:'uppercase',
    color:'rgba(255,255,255,0.4)', borderBottom:'1px solid rgba(255,255,255,0.08)', whiteSpace:'nowrap',
    background:'rgba(8,14,28,0.98)', position:'sticky', top:0, zIndex:2, cursor:'pointer' };
  const tdS = { padding:'8px 12px', borderBottom:'1px solid rgba(255,255,255,0.05)', fontSize:12, verticalAlign:'middle' };

  return (
    <div className="modal-backdrop" style={{ position:'fixed', inset:0, background:'rgba(2,6,18,0.88)', backdropFilter:'blur(8px)',
      zIndex:4000, display:'flex', alignItems:'center', justifyContent:'center' }}
      onClick={e => { if(e.target===e.currentTarget) onClose(); }}>
      <div className="glass" role="dialog" aria-modal="true" style={{ width:'calc(100vw - 20px)', height:'calc(100vh - 20px)', maxWidth:1400,
        background:'linear-gradient(160deg,#0b1628 0%,#060e1c 100%)',
        border:'1px solid rgba(96,165,250,0.25)', borderRadius:16,
        boxShadow:'0 32px 80px rgba(0,0,0,0.7)', display:'flex', flexDirection:'column', overflow:'hidden' }}>

        {/* ── Header ── */}
        <div style={{ padding:'14px 20px', borderBottom:'1px solid rgba(255,255,255,0.08)', display:'flex', alignItems:'center', gap:16, flexShrink:0 }}>
          <div style={{ flex:1 }}>
            <div style={{ fontWeight:800, fontSize:15, color:'#fff', letterSpacing: 0 }}>
              ◈ Aggregate Analysis
              {data?.contract?.country_name && <span style={{ marginLeft:10, fontSize:12, color:'rgba(96,165,250,0.8)', fontWeight:600 }}>{data.contract.country_name} · UW {data.contract.uw_year}</span>}
            </div>
            <div style={{ fontSize:11, color:'rgba(255,255,255,0.35)', marginTop:2 }}>Drill-down by zone, class of business and portfolio position</div>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" style={{ background:'none', border:'none', color:'rgba(255,255,255,0.4)', fontSize:20, cursor:'pointer', padding:'2px 8px' }}>✕</button>
        </div>

        {/* ── Tabs ── */}
        <div style={{ display:'flex', gap:0, borderBottom:'1px solid rgba(255,255,255,0.08)', flexShrink:0 }}>
          {TABS.map(t => (
            <button key={t.key} onClick={() => setTab(t.key)}
              style={{ padding:'10px 20px', fontSize:12, fontWeight:700, border:'none', cursor:'pointer',
                background: tab===t.key ? 'rgba(96,165,250,0.12)' : 'transparent',
                color: tab===t.key ? '#60a5fa' : 'rgba(255,255,255,0.45)',
                borderBottom: tab===t.key ? '2px solid #60a5fa' : '2px solid transparent',
                letterSpacing: 0, textTransform:'uppercase', transition:'all 0.15s' }}>
              {t.label}
            </button>
          ))}
        </div>

        {/* ── Content ── */}
        <div style={{ flex:1, overflow:'auto', padding:'16px 20px' }}>

          {loading && <div style={{ color:'rgba(255,255,255,0.4)', fontSize:13, padding:40, textAlign:'center' }}>Loading aggregate data…</div>}
          {error && <div style={{ color:'#f87171', fontSize:12, padding:20 }}>Error: {error}</div>}

          {data && tab === 'summary' && (() => {
            const signedLine = cn(data.contract?.signed_line_pct);
            const peakPctOfContract = contractTotal > 0 ? (peakCell.value / contractTotal) * 100 : 0;
            const portfolioPeakZone = peakCell.zone ? (data.portfolio?.zones||[]).find(z => z.zone_id === peakCell.zone.zone_id) : null;
            const portfolioPeakPerilVal = portfolioPeakZone && peakCell.peril ? cn(portfolioPeakZone[peakCell.peril]) : 0;
            const peakPctOfCountryPeril = portfolioPeakPerilVal > 0 ? (peakCell.value / portfolioPeakPerilVal) * 100 : 0;
            return (
            <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
              {/* (a) Country header strip */}
              <div style={{ padding:'12px 16px', borderRadius:10, background:'rgba(96,165,250,0.05)', border:'1px solid rgba(96,165,250,0.2)' }}>
                <div style={{ fontSize:11, fontWeight:700, color:'rgba(96,165,250,0.8)', textTransform:'uppercase', letterSpacing: 0 }}>
                  Aggregate Exposure — {data.contract?.country_name || '—'} · UW {data.contract?.uw_year || '—'}
                </div>
                <div style={{ fontSize:24, fontWeight:800, color:'#fff', marginTop:4 }}>
                  {fmt(contractTotal)}
                </div>
                <div style={{ fontSize:11, color:'rgba(255,255,255,0.4)', marginTop:2 }}>
                  Total contract aggregate at 100%
                </div>
              </div>

              {/* (b) Peril breakdown bar */}
              <div style={{ padding:'14px 16px', borderRadius:10, background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.08)' }}>
                <div style={{ fontSize:11, fontWeight:700, color:'rgba(255,255,255,0.5)', textTransform:'uppercase', marginBottom:10 }}>Peril Breakdown — This Contract</div>
                <div style={{ display:'flex', gap:8, marginBottom:8 }}>
                  {PERILS.map(p => {
                    const v = data.zones?.reduce((s,r)=>s+cn(r[p]),0)||0;
                    const pctVal = contractTotal > 0 ? (v/contractTotal*100).toFixed(0) : 0;
                    return (
                      <div key={p} style={{ flex:1, padding:'10px 12px', borderRadius:8,
                        background: filterPeril===p ? `${PERIL_COLORS[p]}22` : 'rgba(255,255,255,0.03)',
                        border:`1px solid ${filterPeril===p ? PERIL_COLORS[p] : 'rgba(255,255,255,0.08)'}`,
                        cursor:'pointer', transition:'all 0.15s' }}
                        onClick={() => setFilterPeril(filterPeril===p ? null : p)}>
                        <div style={{ fontSize:9, fontWeight:700, color:PERIL_COLORS[p], textTransform:'uppercase', marginBottom:4 }}>{PERIL_LABELS[p]}</div>
                        <div style={{ fontSize:16, fontWeight:800, color:'#fff' }}>{fmt(v)}</div>
                        <div style={{ fontSize:10, color:'rgba(255,255,255,0.35)', marginTop:2 }}>{pctVal}% of total</div>
                      </div>
                    );
                  })}
                </div>
                <Legend />
              </div>

              {/* (c) Peak exposure zone-peril combo card */}
              {peakCell.value > 0 ? (
                <div style={{ padding:'18px 20px', borderRadius:10, background:'rgba(255,255,255,0.04)', border:`1px solid ${PERIL_COLORS[peakCell.peril]}`, boxShadow:`0 0 24px ${PERIL_COLORS[peakCell.peril]}15` }}>
                  <div style={{ fontSize:11, fontWeight:700, color:'rgba(255,255,255,0.5)', textTransform:'uppercase', letterSpacing: 0, marginBottom:6 }}>Peak Exposure</div>
                  <div style={{ fontSize:13, fontWeight:600, color: PERIL_COLORS[peakCell.peril], marginBottom:4 }}>
                    {peakCell.zone.zone_name || peakCell.zone.zone_id} — {PERIL_LABELS[peakCell.peril]}
                  </div>
                  <div style={{ fontSize:28, fontWeight:800, color:'#fff', letterSpacing: 0 }}>
                    {fmt(peakCell.value)}
                  </div>
                  <div style={{ fontSize:11, color:'rgba(255,255,255,0.5)', marginTop:6 }}>
                    {peakPctOfContract.toFixed(1)}% of contract total
                  </div>
                  {portfolioPeakPerilVal > 0 && (
                    <div style={{ fontSize:11, color:'rgba(255,255,255,0.5)', marginTop:2 }}>
                      {peakPctOfCountryPeril.toFixed(1)}% of country&apos;s {PERIL_LABELS[peakCell.peril]} exposure in this zone
                    </div>
                  )}
                </div>
              ) : (
                <div style={{ padding:'18px 20px', borderRadius:10, background:'rgba(255,255,255,0.03)', border:'1px solid rgba(255,255,255,0.08)', color:'rgba(255,255,255,0.45)', fontSize:12, textAlign:'center' }}>
                  No exposure data captured for this contract yet.
                </div>
              )}

              {/* (d) "At your signed line" hint */}
              {signedLine > 0 && (
                <div style={{ fontSize:11, color:'rgba(255,255,255,0.4)', fontStyle:'italic' }}>
                  At your signed line of {signedLine.toFixed(2)}%, your share of this contract&apos;s total = {fmt(contractTotal * (signedLine/100))}
                </div>
              )}

              {/* (e) Top zones preview */}
              <div style={{ padding:'14px 16px', borderRadius:10, background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.08)' }}>
                <div style={{ fontSize:11, fontWeight:700, color:'rgba(255,255,255,0.5)', textTransform:'uppercase', marginBottom:10 }}>Top Zones by Aggregate</div>
                {(data.zones||[]).slice(0,5).map((z,i) => (
                  <div key={i} style={{ marginBottom:8 }}>
                    <div style={{ display:'flex', justifyContent:'space-between', marginBottom:3 }}>
                      <span style={{ fontSize:12, color:'rgba(255,255,255,0.75)' }}>{z.zone_name||z.zone_id}</span>
                      <span style={{ fontSize:12, color:'#fff', fontWeight:700 }}>{fmt(cn(z.total_agg))}</span>
                    </div>
                    <PerilBar row={z} total={cn(z.total_agg)} />
                  </div>
                ))}
                {(data.zones||[]).length > 5 && <button onClick={()=>setTab('zones')} style={{ fontSize:11, color:'#60a5fa', background:'none', border:'none', cursor:'pointer', marginTop:4 }}>View all {data.zones.length} zones →</button>}
              </div>
            </div>
            );
          })()}

          {data && tab === 'zones' && (
            <div>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
                <div style={{ fontSize:12, color:'rgba(255,255,255,0.4)' }}>{(data.zones||[]).length} zones · click column headers to sort</div>
                <Legend />
              </div>
              <table style={{ width:'100%', borderCollapse:'collapse' }}>
                <thead>
                  <tr>
                    <th style={thS} onClick={()=>setSortZone('zone_name')}>Zone</th>
                    <th style={{...thS,textAlign:'right'}} onClick={()=>setSortZone('total_agg')}>Total Agg {sortZone==='total_agg'&&'▼'}</th>
                    <th style={{...thS,textAlign:'right'}} onClick={()=>setSortZone('eq_agg')}>EQ {sortZone==='eq_agg'&&'▼'}</th>
                    <th style={{...thS,textAlign:'right'}} onClick={()=>setSortZone('ws_agg')}>WS {sortZone==='ws_agg'&&'▼'}</th>
                    <th style={{...thS,textAlign:'right'}} onClick={()=>setSortZone('flood_agg')}>Flood {sortZone==='flood_agg'&&'▼'}</th>
                    <th style={{...thS,textAlign:'right'}} onClick={()=>setSortZone('srcc_agg')}>SRCC {sortZone==='srcc_agg'&&'▼'}</th>
                    <th style={{...thS,textAlign:'right'}}>Other</th>
                    <th style={{...thS, width:160}}>Peril Mix</th>
                    <th style={{...thS,textAlign:'right'}} onClick={()=>setSortZone('portfolio_total')}>Portfolio (Country) {sortZone==='portfolio_total'&&'▼'}</th>
                    <th style={{...thS, width:140}}>% of Country Zone</th>
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
                      <tr key={i} style={{ background: i%2===0 ? 'transparent' : 'rgba(255,255,255,0.02)' }}>
                        <td style={tdS}>
                          <div style={{ fontWeight:600, color:'rgba(255,255,255,0.85)' }}>{z.zone_name||z.zone_id}</div>
                          <div style={{ fontSize:10, color:'rgba(255,255,255,0.35)' }}>{z.zone_id}</div>
                        </td>
                        <td style={{...tdS,textAlign:'right',fontWeight:700,color:'#fff'}}>{fmtFull(tot)}</td>
                        <td style={{...tdS,textAlign:'right',color:'#f87171'}}>{fmt(cn(z.eq_agg))}</td>
                        <td style={{...tdS,textAlign:'right',color:'#60a5fa'}}>{fmt(cn(z.ws_agg))}</td>
                        <td style={{...tdS,textAlign:'right',color:'#34d399'}}>{fmt(cn(z.flood_agg))}</td>
                        <td style={{...tdS,textAlign:'right',color:'#fbbf24'}}>{fmt(cn(z.srcc_agg))}</td>
                        <td style={{...tdS,textAlign:'right',color:'#a78bfa'}}>{fmt(cn(z.others_agg))}</td>
                        <td style={{...tdS, width:160}}><PerilBar row={z} total={tot} /></td>
                        <td style={{...tdS,textAlign:'right',color:'rgba(255,255,255,0.55)'}}>{portfolioZoneTotal > 0 ? fmtFull(portfolioZoneTotal) : '—'}</td>
                        <td style={{...tdS, width:140}}>
                          {portfolioZoneTotal > 0 ? (
                            <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                              <span style={{ fontSize:11, color:'#60a5fa', fontWeight:600, width:48, textAlign:'right' }}>{pctOfCountryZone.toFixed(1)}%</span>
                              <div style={{ flex:1, maxWidth:80, height:4, borderRadius:2, background:'rgba(255,255,255,0.08)', overflow:'hidden' }}>
                                <div style={{ height:'100%', borderRadius:2, width:`${Math.min(pctOfCountryZone,100)}%`, background:'#60a5fa' }} />
                              </div>
                            </div>
                          ) : (
                            <span style={{ fontSize:11, color:'rgba(255,255,255,0.35)' }}>—</span>
                          )}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
                <tfoot>
                  <tr style={{ background:'rgba(255,255,255,0.06)' }}>
                    <td style={{...tdS,fontWeight:800,color:'rgba(255,255,255,0.9)'}}>TOTAL</td>
                    <td style={{...tdS,textAlign:'right',fontWeight:800,color:'#fff'}}>{fmtFull(contractTotal)}</td>
                    {PERILS.slice(0,4).map(p => <td key={p} style={{...tdS,textAlign:'right',fontWeight:700}}>{fmtFull(data.zones?.reduce((s,r)=>s+cn(r[p]),0)||0)}</td>)}
                    <td style={tdS} /><td style={tdS} />
                    <td style={{...tdS,textAlign:'right',fontWeight:800,color:'rgba(255,255,255,0.85)'}}>{fmtFull(portfolioTotal)}</td>
                    <td style={{...tdS, width:140}}>
                      {portfolioTotal > 0 ? (
                        <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                          <span style={{ fontSize:11, color:'#60a5fa', fontWeight:700, width:48, textAlign:'right' }}>{((contractTotal/portfolioTotal)*100).toFixed(1)}%</span>
                          <div style={{ flex:1, maxWidth:80, height:4, borderRadius:2, background:'rgba(255,255,255,0.08)', overflow:'hidden' }}>
                            <div style={{ height:'100%', borderRadius:2, width:`${Math.min((contractTotal/portfolioTotal)*100,100)}%`, background:'#60a5fa' }} />
                          </div>
                        </div>
                      ) : (
                        <span style={{ fontSize:11, color:'rgba(255,255,255,0.35)' }}>—</span>
                      )}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}

          {data && tab === 'cob' && (
            <div>
              <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:12 }}>
                <div style={{ fontSize:12, color:'rgba(255,255,255,0.4)' }}>Aggregates split by Class of Business — this contract vs country portfolio</div>
                <Legend />
              </div>
              <table style={{ width:'100%', borderCollapse:'collapse' }}>
                <thead>
                  <tr>
                    <th style={thS} onClick={()=>setSortCob('cob')}>Class of Business</th>
                    <th style={{...thS,textAlign:'right'}} onClick={()=>setSortCob('total_agg')}>This Contract {sortCob==='total_agg'&&'▼'}</th>
                    <th style={{...thS,textAlign:'right'}}>EQ</th>
                    <th style={{...thS,textAlign:'right'}}>WS</th>
                    <th style={{...thS,textAlign:'right'}}>Flood</th>
                    <th style={{...thS,textAlign:'right'}}>SRCC</th>
                    <th style={{...thS, width:120}}>Mix</th>
                    <th style={{...thS,textAlign:'right'}}>Country Portfolio</th>
                    <th style={{...thS, width:140}}>Contract %</th>
                  </tr>
                </thead>
                <tbody>
                  {[...(data.cob||[])].sort((a,b) => sortCob==='cob' ? a.cob.localeCompare(b.cob) : cn(b[sortCob])-cn(a[sortCob]))
                    .map((r,i) => {
                    const tot = cn(r.total_agg);
                    const portCob = (data.portfolio?.cob||[]).find(p=>p.cob===r.cob);
                    const portTot = cn(portCob?.total_agg);
                    return (
                      <tr key={i} style={{ background: i%2===0 ? 'transparent' : 'rgba(255,255,255,0.02)' }}>
                        <td style={{...tdS,fontWeight:600,color:'rgba(255,255,255,0.85)'}}>{r.cob}</td>
                        <td style={{...tdS,textAlign:'right',fontWeight:700,color:'#fff'}}>{fmtFull(tot)}</td>
                        <td style={{...tdS,textAlign:'right',color:'#f87171'}}>{fmt(cn(r.eq_agg))}</td>
                        <td style={{...tdS,textAlign:'right',color:'#60a5fa'}}>{fmt(cn(r.ws_agg))}</td>
                        <td style={{...tdS,textAlign:'right',color:'#34d399'}}>{fmt(cn(r.flood_agg))}</td>
                        <td style={{...tdS,textAlign:'right',color:'#fbbf24'}}>{fmt(cn(r.srcc_agg))}</td>
                        <td style={{...tdS,width:120}}><PerilBar row={r} total={tot} /></td>
                        <td style={{...tdS,textAlign:'right',color:'rgba(255,255,255,0.55)'}}>{portTot > 0 ? fmtFull(portTot) : '—'}</td>
                        <td style={{...tdS, width:140}}>
                          {portTot > 0 ? (() => {
                            const ratio = tot / portTot;
                            const pctVal = ratio * 100;
                            return (
                              <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                                <span style={{ fontSize:11, color: ratio > 0.5 ? '#f87171' : '#4ade80', fontWeight:600, width:48, textAlign:'right' }}>{pctVal.toFixed(1)}%</span>
                                <div style={{ flex:1, maxWidth:80, height:4, borderRadius:2, background:'rgba(255,255,255,0.08)', overflow:'hidden' }}>
                                  <div style={{ height:'100%', borderRadius:2, width:`${Math.min(pctVal,100)}%`, background:'#60a5fa' }} />
                                </div>
                              </div>
                            );
                          })() : (
                            <span style={{ fontSize:11, color:'rgba(255,255,255,0.35)' }}>—</span>
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

            const growthColor = (g, hasShare) => {
              if (!hasShare) return 'rgba(255,255,255,0.4)';
              if (g > 0.0005) return '#4ade80';
              if (g < -0.0005) return '#f87171';
              return 'rgba(255,255,255,0.4)';
            };
            const fmtGrowth = (g, hasShare) => {
              if (!hasShare) return '—';
              const sign = g > 0 ? '+' : '';
              return `${sign}${g.toFixed(1)}%`;
            };
            const hasShare = portfolioShareFrac > 0;

            return (
            <div style={{ display:'flex', flexDirection:'column', gap:16 }}>
              {/* (a) Share input bar */}
              <div style={{ display:'flex', alignItems:'center', gap:12, padding:'12px 16px', borderRadius:10, background:'rgba(96,165,250,0.05)', border:'1px solid rgba(96,165,250,0.2)' }}>
                <span style={{ fontSize:12, fontWeight:600, color:'rgba(96,165,250,0.85)' }}>Apply share %:</span>
                <div style={{ width:140 }}>
                  <PctInput value={portfolioShareInput}
                    onChange={v => setPortfolioShareInput(v)}
                    placeholder="e.g. 5%" />
                </div>
                <span style={{ fontSize:11, color:'rgba(255,255,255,0.4)' }}>
                  Type a share to see how this contract would affect the country book.
                </span>
              </div>

              {/* (b) Two side-by-side share-impact panels */}
              <div style={{ display:'flex', gap:16, flexWrap:'wrap' }}>
                {/* Panel 1 — By Peril */}
                <div style={{ flex:1, minWidth:320, padding:'14px 16px', borderRadius:10, background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.08)' }}>
                  <div style={{ fontSize:11, fontWeight:700, color:'rgba(255,255,255,0.5)', textTransform:'uppercase', letterSpacing: 0, marginBottom:10 }}>Share Impact By Peril</div>
                  <table style={{ width:'100%', borderCollapse:'collapse' }}>
                    <thead>
                      <tr>
                        <th style={{...thS, cursor:'default'}}>Peril</th>
                        <th style={{...thS, textAlign:'right', cursor:'default'}}>Country Portfolio</th>
                        <th style={{...thS, textAlign:'right', cursor:'default'}}>Contract @ Share</th>
                        <th style={{...thS, textAlign:'right', cursor:'default'}}>New Portfolio Total</th>
                        <th style={{...thS, textAlign:'right', cursor:'default'}}>Growth</th>
                      </tr>
                    </thead>
                    <tbody>
                      {PERILS.map((p, i) => {
                        const portCur = portfolioByPeril[p] || 0;
                        const contractPeril = contractByPeril[p] || 0;
                        const myContribAtShare = contractPeril * portfolioShareFrac;
                        const newTotal = hasShare ? portCur - contractPeril + myContribAtShare : portCur;
                        const growthPct = portCur > 0 ? ((newTotal - portCur) / portCur) * 100 : 0;
                        return (
                          <tr key={p} style={{ background: i%2===0 ? 'transparent' : 'rgba(255,255,255,0.02)' }}>
                            <td style={tdS}>
                              <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                                <span style={{ width:8, height:8, borderRadius:2, background: PERIL_COLORS[p] }} />
                                <span style={{ fontWeight:600, color:'rgba(255,255,255,0.85)' }}>{PERIL_LABELS[p]}</span>
                              </div>
                            </td>
                            <td style={{...tdS, textAlign:'right', color:'rgba(255,255,255,0.7)'}}>{fmt(portCur)}</td>
                            <td style={{...tdS, textAlign:'right', color: hasShare ? '#60a5fa' : 'rgba(255,255,255,0.35)', fontWeight:600}}>{hasShare ? fmt(myContribAtShare) : '—'}</td>
                            <td style={{...tdS, textAlign:'right', color:'#fff', fontWeight:700}}>{fmt(newTotal)}</td>
                            <td style={{...tdS, textAlign:'right', color: growthColor(growthPct, hasShare), fontWeight:700}}>{fmtGrowth(growthPct, hasShare)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>

                {/* Panel 2 — By Class */}
                <div style={{ flex:1, minWidth:320, padding:'14px 16px', borderRadius:10, background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.08)' }}>
                  <div style={{ fontSize:11, fontWeight:700, color:'rgba(255,255,255,0.5)', textTransform:'uppercase', letterSpacing: 0, marginBottom:10 }}>Share Impact By Class</div>
                  <table style={{ width:'100%', borderCollapse:'collapse' }}>
                    <thead>
                      <tr>
                        <th style={{...thS, cursor:'default'}}>Class</th>
                        <th style={{...thS, textAlign:'right', cursor:'default'}}>Country Portfolio</th>
                        <th style={{...thS, textAlign:'right', cursor:'default'}}>Contract @ Share</th>
                        <th style={{...thS, textAlign:'right', cursor:'default'}}>New Portfolio Total</th>
                        <th style={{...thS, textAlign:'right', cursor:'default'}}>Growth</th>
                      </tr>
                    </thead>
                    <tbody>
                      {allClasses.map((clsName, i) => {
                        const contractRow = (data.cob || []).find(r => r.cob === clsName);
                        const portfolioRow = (data.portfolio?.cob || []).find(r => r.cob === clsName);
                        const contractTot = totalOfRow(contractRow);
                        const portCur = totalOfRow(portfolioRow);
                        const myContribAtShare = contractTot * portfolioShareFrac;
                        const newTotal = hasShare ? portCur - contractTot + myContribAtShare : portCur;
                        const growthPct = portCur > 0 ? ((newTotal - portCur) / portCur) * 100 : 0;
                        return (
                          <tr key={clsName} style={{ background: i%2===0 ? 'transparent' : 'rgba(255,255,255,0.02)' }}>
                            <td style={{...tdS, fontWeight:600, color:'rgba(255,255,255,0.85)'}}>{clsName}</td>
                            <td style={{...tdS, textAlign:'right', color:'rgba(255,255,255,0.7)'}}>{fmt(portCur)}</td>
                            <td style={{...tdS, textAlign:'right', color: hasShare ? '#60a5fa' : 'rgba(255,255,255,0.35)', fontWeight:600}}>{hasShare ? fmt(myContribAtShare) : '—'}</td>
                            <td style={{...tdS, textAlign:'right', color:'#fff', fontWeight:700}}>{fmt(newTotal)}</td>
                            <td style={{...tdS, textAlign:'right', color: growthColor(growthPct, hasShare), fontWeight:700}}>{fmtGrowth(growthPct, hasShare)}</td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>

              {/* (c) Active contracts table */}
              <div style={{ padding:'14px 16px', borderRadius:10, background:'rgba(255,255,255,0.04)', border:'1px solid rgba(255,255,255,0.08)' }}>
                <div style={{ fontSize:11, fontWeight:700, color:'rgba(255,255,255,0.5)', textTransform:'uppercase', marginBottom:12 }}>Active Contracts in Country (by Total Agg)</div>
                <table style={{ width:'100%', borderCollapse:'collapse' }}>
                  <thead>
                    <tr>
                      <th style={thS}>Cedant</th>
                      <th style={{...thS,textAlign:'center'}}>UW Year</th>
                      <th style={{...thS,textAlign:'right'}}>Total Agg</th>
                      <th style={{...thS, width:120}}>Share of Portfolio</th>
                    </tr>
                  </thead>
                  <tbody>
                    {(data.portfolio?.contracts||[]).map((c,i) => {
                      const tot = cn(c.total_agg);
                      const isThisContract = c.contract_id === contractId;
                      return (
                        <tr key={i} style={{ background: isThisContract ? 'rgba(96,165,250,0.08)' : i%2===0 ? 'transparent' : 'rgba(255,255,255,0.02)' }}>
                          <td style={{...tdS,fontWeight: isThisContract ? 700 : 500, color: isThisContract ? '#60a5fa' : 'rgba(255,255,255,0.8)'}}>
                            {c.cedant_name||'Unknown'}
                            {isThisContract && <span style={{ marginLeft:6, fontSize:9, color:'#60a5fa', fontWeight:800, background:'rgba(96,165,250,0.15)', padding:'1px 6px', borderRadius:10 }}>THIS</span>}
                          </td>
                          <td style={{...tdS,textAlign:'center',color:'rgba(255,255,255,0.5)'}}>{c.uw_year}</td>
                          <td style={{...tdS,textAlign:'right',fontWeight:700,color:'#fff'}}>{fmtFull(tot)}</td>
                          <td style={tdS}>
                            <div style={{ display:'flex', alignItems:'center', gap:6 }}>
                              <div style={{ flex:1, height:4, borderRadius:2, background:'rgba(255,255,255,0.08)', overflow:'hidden' }}>
                                <div style={{ height:'100%', borderRadius:2, width:`${Math.min((tot/portfolioTotal)*100, 100)}%`, background: isThisContract ? '#60a5fa' : 'rgba(255,255,255,0.25)' }} />
                              </div>
                              <span style={{ fontSize:10, color:'rgba(255,255,255,0.4)', width:36, textAlign:'right' }}>{pct(tot,portfolioTotal)}</span>
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
      </div>
    </div>
  );
}
