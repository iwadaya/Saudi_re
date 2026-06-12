import { useState, useEffect, useMemo } from 'react';
import { api } from '../../../../../api';
import { useAppState } from '../../../../../context/AppContext.jsx';
import { cn } from './_shared.jsx';

/* ── Internal Metrics Panel ───────────────────────────────────────────────────
   Two top-level tabs:
     FINANCE  sub-tabs: Ratios | Accounts | Renewal Comparison
     CLAIMS   all losses + provisional + cash calls, flagged for discrepancies
   ─────────────────────────────────────────────────────────────────────────── */
export function InternalMetricsPanel({ contractId, td: tdProp, yearly: yearlyProp, currency: currencyProp }) {
  const [topTab, setTopTab]       = useState('finance');
  const [finTab, setFinTab]       = useState('ratios');
  const [data, setData]           = useState(null);
  const [allLosses, setAllLosses] = useState([]);
  const [, setLoading]            = useState(true);
  const [lossLoading, setLossLoading] = useState(true);
  const { state: appState } = useAppState();

  const td       = useMemo(() => tdProp || appState.propTreatyDetail || {}, [appState.propTreatyDetail, tdProp]);
  const currency = currencyProp || td.currencyCode || td.currency || 'USD';
  const yearly   = useMemo(() => yearlyProp || [], [yearlyProp]);

  useEffect(() => {
    if (!contractId) { setLoading(false); return; }
    api.getContract(contractId).then(d => { setData({ contract: d }); setLoading(false); }).catch(() => setLoading(false));
  }, [contractId]);

  useEffect(() => {
    if (!contractId) { setLossLoading(false); return; }
    const getSnap = (snap) => snap?.items || snap?.snapshot?.selected_losses || [];
    Promise.all([
      api.getLargeLosses(contractId).catch(() => ({ losses: [] })),
      api.getCatLosses(contractId).catch(() => ({ losses: [] })),
      api.getLossSelectionLatest(contractId, 'large').catch(() => null),
      api.getLossSelectionLatest(contractId, 'cat').catch(() => null),
    ]).then(([largeData, catData, largeSnap, catSnap]) => {
      const largeItems = getSnap(largeSnap), catItems = getSnap(catSnap);
      const snapById = {};
      [...largeItems, ...catItems].forEach(s => { if (s.source_loss_id) snapById[s.source_loss_id] = s; });

      const parseLoss = (l, src) => {
        const snapItem = snapById[l.loss_id];
        return {
          loss_id:      l.loss_id,
          source:       src,
          insured_name: l.insured_name || l.insuredName || '',
          loss_name:    l.loss_name    || l.lossName    || '',
          date_of_loss: l.date_of_loss || l.dateOfLoss  || '',
          class_of_business: l.class_of_business || l.classOfBusiness || '',
          gross_amount: cn(l.gross_amount) || cn(l.paid) + cn(l.os),
          paid:         cn(l.paid),
          os:           cn(l.os),
          incurred:     cn(l.incurred) || cn(l.paid) + cn(l.os),
          our_share_pct: l.our_share_pct || null,
          loss_type:    l.loss_type || 'REPORTED',
          in_uw_data:   true,
          in_internal:  !!snapItem,
        };
      };

      const large = (largeData?.losses || largeData || []).map(l => parseLoss(l, 'LARGE'));
      const cat   = (catData?.losses   || catData   || []).map(l => parseLoss(l, 'CAT'));
      const uwIds = new Set([...large, ...cat].map(l => l.loss_id).filter(Boolean));

      const internalOnly = [...largeItems, ...catItems]
        .filter(s => s.source_loss_id && !uwIds.has(s.source_loss_id))
        .map(s => ({
          loss_id: s.source_loss_id, source: 'INTERNAL',
          insured_name: s.insured_name || '', loss_name: s.loss_name || '',
          date_of_loss: s.date_of_loss || '', class_of_business: s.class_of_business || '',
          gross_amount: cn(s.inflated_incurred) || cn(s.incurred),
          paid: cn(s.paid), os: cn(s.os), incurred: cn(s.incurred),
          our_share_pct: null, loss_type: 'REPORTED',
          in_uw_data: false, in_internal: true,
        }));

      setAllLosses([...large, ...cat, ...internalOnly]);
      setLossLoading(false);
    }).catch(() => setLossLoading(false));
  }, [contractId]);

  const n    = v => { const x = Number(String(v??'').replace(/,/g,'').trim()); return Number.isFinite(x)?x:0; };
  const fmt  = v => { const x=n(v); return x?x.toLocaleString('en-US',{maximumFractionDigits:0}):'—'; };
  const fmtM = v => { const x=n(v); return x?`${currency} ${x.toLocaleString('en-US',{maximumFractionDigits:0})}`:'—'; };
  const fmtP = (v,d=1) => { const x=n(v); return x?`${x.toFixed(d)}%`:'—'; };
  const ratioColor = v => n(v)>100?'#f87171':n(v)>70?'#fbbf24':'#4ade80';

  const actuals = useMemo(() =>
    (yearly||[]).filter(r=>String(r.record_type||'').toUpperCase()!=='PROJECTED').sort((a,b)=>Number(a.uw_year)-Number(b.uw_year)),[yearly]);

  const det=data?.contract?.detail||{}, comm=data?.contract?.commissions||{};
  const latestA = actuals[actuals.length-1]||{};
  const curYear=n(td.startYear)||new Date().getFullYear(), prevYear=curYear-1;
  const gwp=cn(latestA.ultimate_premium)||cn(det.quota_share_epi)+cn(det.surplus_epi);
  const paidC=cn(latestA.paid_loss)||cn(latestA.paid_claims)||0, osC=cn(latestA.os_loss)||cn(latestA.os_claims)||0;
  const incurred=paidC+osC||cn(latestA.ultimate_loss)||0;
  const commission=cn(latestA.commission_amt)||(gwp*cn(comm.fixed_commission_qs_pct||comm.fixed_commission_pct)/100)||0;
  const brokerage=cn(latestA.brokerage_amt)||(gwp*cn(td.brokeragePct)/100)||0;
  const result=gwp-incurred-commission-brokerage;
  const lossRatio=gwp>0?(incurred/gwp)*100:null, expenseRatio=gwp>0?((commission+brokerage)/gwp)*100:null;
  const combinedRatio=lossRatio!=null&&expenseRatio!=null?lossRatio+expenseRatio:null;
  const accountsRendered=actuals.length;
  const missingAccounts=Math.max(0,(curYear-(actuals[0]?n(actuals[0].uw_year):curYear)+1)-accountsRendered);
  const prevRow=actuals.find(r=>n(r.uw_year)===prevYear)||{};
  const flagCount=allLosses.filter(l=>!l.in_uw_data||!l.in_internal).length;
  const signedLinePct=(data?.contract?.header?.signed_line_pct||td.signedLinePct||0)/100;

  // Styles
  const topBtn=active=>({padding:'9px 22px',border:'none',cursor:'pointer',fontSize:12,fontWeight:800,letterSpacing:'.10em',textTransform:'uppercase',background:active?'rgba(0,212,255,0.12)':'transparent',color:active?'#00d4ff':'rgba(255,255,255,0.38)',borderBottom:active?'2px solid #00d4ff':'2px solid transparent'});
  const subBtn=active=>({padding:'6px 14px',border:'none',cursor:'pointer',fontSize:11,fontWeight:700,letterSpacing:'.06em',textTransform:'uppercase',borderRadius:6,background:active?'rgba(0,232,184,0.12)':'rgba(255,255,255,0.03)',color:active?'#00e8b8':'rgba(255,255,255,0.40)',borderBottom:active?'2px solid #00e8b8':'2px solid transparent'});
  const card={background:'rgba(8,14,30,0.70)',border:'1px solid rgba(255,255,255,0.09)',borderRadius:12,overflow:'hidden'};
  const cH={padding:'10px 16px',borderBottom:'1px solid rgba(255,255,255,0.07)',fontSize:9,fontWeight:800,letterSpacing:'.14em',textTransform:'uppercase',color:'rgba(148,163,184,0.55)',display:'flex',alignItems:'center',justifyContent:'space-between'};
  const thS={padding:'9px 12px',fontSize:9,fontWeight:800,letterSpacing:'.12em',textTransform:'uppercase',color:'rgba(148,163,184,0.55)',borderBottom:'1px solid rgba(255,255,255,0.08)',background:'rgba(5,8,16,0.85)',whiteSpace:'nowrap'};
  const tdS={padding:'9px 12px',borderBottom:'1px solid rgba(255,255,255,0.04)',fontVariantNumeric:'tabular-nums',fontSize:12};
  const kpi=(label,value,color,sub)=>(
    <div key={label} style={{...card,padding:'12px 16px',flex:'1 1 120px'}}>
      <div style={{fontSize:9,fontWeight:800,letterSpacing:'.14em',textTransform:'uppercase',color:'rgba(148,163,184,0.50)',marginBottom:5}}>{label}</div>
      <div style={{fontSize:19,fontWeight:900,color:color||'rgba(226,232,240,0.9)',letterSpacing:'-.01em'}}>{value}</div>
      {sub&&<div style={{fontSize:10,color:'rgba(148,163,184,0.45)',marginTop:2}}>{sub}</div>}
    </div>
  );

  return (
    <div style={{display:'flex',flexDirection:'column',height:'100%',gap:0}}>

      {/* Top tabs */}
      <div style={{display:'flex',borderBottom:'1px solid rgba(255,255,255,0.10)',flexShrink:0,padding:'0 4px'}}>
        <button style={topBtn(topTab==='finance')} onClick={()=>setTopTab('finance')}>💰 Finance</button>
        <button style={topBtn(topTab==='claims')}  onClick={()=>setTopTab('claims')}>
          🔴 Claims
          {flagCount>0&&<span style={{marginLeft:7,fontSize:9,padding:'1px 6px',borderRadius:10,background:'rgba(248,113,113,0.20)',color:'#f87171',fontWeight:800}}>{flagCount} flags</span>}
        </button>
      </div>

      {/* ═══ FINANCE ═══ */}
      {topTab==='finance'&&(
        <div style={{display:'flex',flexDirection:'column',flex:1,overflow:'hidden'}}>
          <div style={{display:'flex',gap:4,padding:'10px 4px 0',flexShrink:0,borderBottom:'1px solid rgba(255,255,255,0.06)',marginBottom:14}}>
            {[['ratios','📊 Ratios'],['accounts','📋 Accounts'],['renewal','🔄 Renewal']].map(([k,l])=>(
              <button key={k} style={subBtn(finTab===k)} onClick={()=>setFinTab(k)}>{l}</button>
            ))}
          </div>
          <div style={{flex:1,overflowY:'auto',display:'flex',flexDirection:'column',gap:14}}>

            {finTab==='ratios'&&(<>
              <div style={{display:'flex',gap:10,flexWrap:'wrap'}}>
                {kpi('Gross Written Premium',fmtM(gwp),'#4ade80')}
                {kpi('Total Incurred',fmtM(incurred),'#f87171',`Paid ${fmtM(paidC)} · OS ${fmtM(osC)}`)}
                {kpi('Commission',fmtM(commission),'#a78bfa')}
                {kpi('Brokerage',fmtM(brokerage),'#818cf8')}
                {kpi('Technical Result',fmtM(result),result>=0?'#4ade80':'#f87171',result>=0?'Profitable':'Loss-making')}
              </div>
              <div style={{display:'flex',gap:10,flexWrap:'wrap'}}>
                {kpi('Loss Ratio',lossRatio!=null?`${lossRatio.toFixed(1)}%`:'—',ratioColor(lossRatio),'Incurred ÷ GWP')}
                {kpi('Expense Ratio',expenseRatio!=null?`${expenseRatio.toFixed(1)}%`:'—','#a78bfa','Comm+Brok ÷ GWP')}
                {kpi('Combined Ratio',combinedRatio!=null?`${combinedRatio.toFixed(1)}%`:'—',ratioColor(combinedRatio),combinedRatio!=null?(combinedRatio<=100?'✓ Profitable':'✗ Loss-making'):'')}
              </div>
              {actuals.length>0?(
                <div style={card}>
                  <div style={cH}><span>Year-by-Year</span></div>
                  <div style={{overflowX:'auto'}}>
                    <table style={{width:'100%',borderCollapse:'collapse'}}>
                      <thead><tr>
                        {['UW Year','GWP','Paid','OS','Incurred','Comm','Brokerage','Result','LR','ER','CR'].map(h=>(
                          <th key={h} style={{...thS,textAlign:h==='UW Year'?'left':'right'}}>{h}</th>
                        ))}
                      </tr></thead>
                      <tbody>
                        {actuals.map((r,i)=>{
                          const g=cn(r.ultimate_premium),p=cn(r.paid_loss)||cn(r.paid_claims),o=cn(r.os_loss)||cn(r.os_claims);
                          const inc=cn(r.ultimate_loss)||p+o,co=cn(r.commission_amt),br=cn(r.brokerage_amt);
                          const res=g-inc-co-br,lr=g>0?(inc/g)*100:null,er=g>0?((co+br)/g)*100:null,cr=lr!=null&&er!=null?lr+er:null;
                          return(
                            <tr key={i} style={{background:i%2===0?'transparent':'rgba(255,255,255,0.018)',borderBottom:'1px solid rgba(255,255,255,0.04)'}}>
                              <td style={{...tdS,fontWeight:700}}>{r.uw_year}</td>
                              <td style={{...tdS,textAlign:'right',color:'#4ade80'}}>{fmt(g)}</td>
                              <td style={{...tdS,textAlign:'right',color:'#f87171'}}>{fmt(p)}</td>
                              <td style={{...tdS,textAlign:'right',color:'#f97316'}}>{fmt(o)}</td>
                              <td style={{...tdS,textAlign:'right',color:'#fb923c',fontWeight:600}}>{fmt(inc)}</td>
                              <td style={{...tdS,textAlign:'right',color:'#a78bfa'}}>{fmt(co)}</td>
                              <td style={{...tdS,textAlign:'right',color:'#818cf8'}}>{fmt(br)}</td>
                              <td style={{...tdS,textAlign:'right',fontWeight:700,color:res>=0?'#4ade80':'#f87171'}}>{fmt(res)}</td>
                              <td style={{...tdS,textAlign:'right',fontWeight:700,color:ratioColor(lr)}}>{lr!=null?`${lr.toFixed(1)}%`:'—'}</td>
                              <td style={{...tdS,textAlign:'right',color:'#a78bfa'}}>{er!=null?`${er.toFixed(1)}%`:'—'}</td>
                              <td style={{...tdS,textAlign:'right',fontWeight:700,color:ratioColor(cr)}}>{cr!=null?`${cr.toFixed(1)}%`:'—'}</td>
                            </tr>
                          );
                        })}
                      </tbody>
                      {actuals.length>=3&&(()=>{
                        const r5=actuals.slice(-5);
                        const mk=(fn)=>{const vals=r5.map(fn).filter(v=>v!=null);return vals.length?vals.reduce((a,b)=>a+b,0)/vals.length:null;};
                        const aLR=mk(r=>{const g=cn(r.ultimate_premium);return g>0?cn(r.ultimate_loss)/g*100:null;});
                        const aER=mk(r=>{const g=cn(r.ultimate_premium);return g>0?(cn(r.commission_amt)+cn(r.brokerage_amt))/g*100:null;});
                        const aCR=aLR!=null&&aER!=null?aLR+aER:null;
                        return(<tfoot><tr style={{borderTop:'2px solid rgba(255,255,255,0.12)',background:'rgba(5,8,16,0.85)'}}>
                          <td style={{...tdS,fontSize:9,fontWeight:800,letterSpacing:'.08em',textTransform:'uppercase',color:'rgba(148,163,184,0.50)'}}>5YR AVG</td>
                          {Array(7).fill(0).map((_,i)=><td key={i} style={{...tdS,textAlign:'right',color:'rgba(148,163,184,0.3)'}}>—</td>)}
                          <td style={{...tdS,textAlign:'right',fontWeight:800,color:ratioColor(aLR)}}>{aLR!=null?`${aLR.toFixed(1)}%`:'—'}</td>
                          <td style={{...tdS,textAlign:'right',fontWeight:800,color:'#a78bfa'}}>{aER!=null?`${aER.toFixed(1)}%`:'—'}</td>
                          <td style={{...tdS,textAlign:'right',fontWeight:800,color:ratioColor(aCR)}}>{aCR!=null?`${aCR.toFixed(1)}%`:'—'}</td>
                        </tr></tfoot>);
                      })()}
                    </table>
                  </div>
                </div>
              ):<div style={{padding:'12px 16px',borderRadius:10,background:'rgba(251,191,36,0.08)',border:'1px solid rgba(251,191,36,0.2)',fontSize:13,color:'rgba(255,255,255,0.6)'}}>No accounting data. Add historical year rows in Projected Summary.</div>}
            </>)}

            {finTab==='accounts'&&(<>
              <div style={{display:'flex',gap:10,flexWrap:'wrap'}}>
                {kpi('Accounts Rendered',String(accountsRendered),'#00d4ff')}
                {kpi('Missing Accounts',String(missingAccounts),missingAccounts>0?'#f87171':'#4ade80')}
                {kpi('Last Account',actuals[actuals.length-1]?.uw_year?`UW ${actuals[actuals.length-1].uw_year}`:'—','rgba(226,232,240,0.9)')}
                {kpi('History',accountsRendered>1?`${accountsRendered} years`:accountsRendered===1?'1 year':'None','#a78bfa')}
              </div>
              {actuals.length>0&&(
                <div style={card}>
                  <div style={cH}><span>Accounting Records</span><span style={{fontSize:11,color:'rgba(148,163,184,0.4)'}}>{accountsRendered} year{accountsRendered!==1?'s':''} on file</span></div>
                  <table style={{width:'100%',borderCollapse:'collapse'}}>
                    <thead><tr>
                      {['UW Year','GWP','Paid','OS','Incurred','Commission','LR','Type'].map(h=>(
                        <th key={h} style={{...thS,textAlign:h==='UW Year'||h==='Type'?'left':'right'}}>{h}</th>
                      ))}
                    </tr></thead>
                    <tbody>
                      {actuals.map((r,i)=>{
                        const g=cn(r.ultimate_premium),p=cn(r.paid_loss)||cn(r.paid_claims),o=cn(r.os_loss)||cn(r.os_claims);
                        const inc=cn(r.ultimate_loss)||p+o,co=cn(r.commission_amt),lr=g>0?(inc/g)*100:null;
                        return(
                          <tr key={i} style={{borderBottom:'1px solid rgba(255,255,255,0.04)'}}>
                            <td style={{...tdS,fontWeight:700}}>{r.uw_year}</td>
                            <td style={{...tdS,textAlign:'right',color:'#4ade80'}}>{fmt(g)}</td>
                            <td style={{...tdS,textAlign:'right',color:'#f87171'}}>{fmt(p)}</td>
                            <td style={{...tdS,textAlign:'right',color:'#f97316'}}>{fmt(o)}</td>
                            <td style={{...tdS,textAlign:'right',fontWeight:600,color:'#fb923c'}}>{fmt(inc)}</td>
                            <td style={{...tdS,textAlign:'right',color:'#a78bfa'}}>{fmt(co)}</td>
                            <td style={{...tdS,textAlign:'right',fontWeight:700,color:ratioColor(lr)}}>{lr!=null?`${lr.toFixed(1)}%`:'—'}</td>
                            <td style={tdS}><span style={{fontSize:9,fontWeight:700,padding:'2px 7px',borderRadius:10,background:'rgba(148,163,184,0.10)',color:'rgba(148,163,184,0.70)',letterSpacing:'.06em'}}>{String(r.record_type||'ACTUAL')}</span></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              )}
              {missingAccounts>0&&<div style={{padding:'12px 16px',borderRadius:10,background:'rgba(248,113,113,0.08)',border:'1px solid rgba(248,113,113,0.25)',fontSize:13,color:'rgba(255,255,255,0.75)'}}>⚠ {missingAccounts} missing account year{missingAccounts>1?'s':''} detected.</div>}
            </>)}

            {finTab==='renewal'&&(<>
              <div style={{fontSize:12,color:'rgba(148,163,184,0.55)',marginBottom:4}}>
                Comparing <b style={{color:'#4ade80'}}>UW {prevYear}</b> data from two sources — internal accounting system vs renewal pack / UW modelling data
              </div>
              {(()=>{
                const dc=(a,b)=>{if(!n(a)||!n(b))return'rgba(255,255,255,0.35)';const d=((n(a)-n(b))/Math.abs(n(b)))*100;return Math.abs(d)<0.5?'rgba(255,255,255,0.4)':d>0?'#4ade80':'#f87171';};
                const dl=(a,b)=>{if(!n(a)||!n(b))return'—';const d=((n(a)-n(b))/Math.abs(n(b)))*100;return`${d>=0?'+':''}${d.toFixed(1)}%`;};
                // Both columns = prevYear. Left = internal accounting (prevRow from yearly data).
                // Right = UW/renewal pack (also prevRow, same source for now — UW can manually edit).
                // prevRow comes from the yearly[] prop which is populated from Projected Summary
                // internal = accounting entries (record_type=ACTUAL), uw = underwriting entries
                const internalRow = actuals.find(r=>n(r.uw_year)===prevYear && String(r.record_type||'ACTUAL').toUpperCase()==='ACTUAL') || prevRow;
                const uwRow       = actuals.find(r=>n(r.uw_year)===prevYear && String(r.record_type||'').toUpperCase()==='UW') || {};
                const rows=[
                  {label:'Gross Written Premium', internal:cn(internalRow.ultimate_premium), uw:cn(uwRow.ultimate_premium)||cn(prevRow.ultimate_premium),  fmt:fmtM},
                  {label:'Paid Claims',            internal:cn(internalRow.paid_loss)||cn(internalRow.paid_claims), uw:cn(uwRow.paid_loss)||cn(prevRow.paid_loss), fmt:fmtM},
                  {label:'OS Claims',              internal:cn(internalRow.os_loss)||cn(internalRow.os_claims),     uw:cn(uwRow.os_loss)||cn(prevRow.os_loss),     fmt:fmtM},
                  {label:'Total Incurred',         internal:cn(internalRow.ultimate_loss)||cn(internalRow.paid_loss)+cn(internalRow.os_loss), uw:cn(uwRow.ultimate_loss)||cn(prevRow.ultimate_loss), fmt:fmtM},
                  {label:'Commission',             internal:cn(internalRow.commission_amt), uw:cn(uwRow.commission_amt)||cn(prevRow.commission_amt), fmt:fmtM},
                  {label:'Brokerage',              internal:cn(internalRow.brokerage_amt),  uw:cn(uwRow.brokerage_amt)||cn(prevRow.brokerage_amt),  fmt:fmtM},
                  {label:'Technical Result',
                   internal:cn(internalRow.ultimate_premium)-(cn(internalRow.ultimate_loss)||cn(internalRow.paid_loss)+cn(internalRow.os_loss))-cn(internalRow.commission_amt)-cn(internalRow.brokerage_amt),
                   uw:cn(uwRow.ultimate_premium||prevRow.ultimate_premium)-cn(uwRow.ultimate_loss||prevRow.ultimate_loss)-cn(uwRow.commission_amt||prevRow.commission_amt)-cn(uwRow.brokerage_amt||prevRow.brokerage_amt),
                   fmt:fmtM,isResult:true},
                  {label:'Loss Ratio',
                   internal:cn(internalRow.ultimate_premium)>0?((cn(internalRow.ultimate_loss)||cn(internalRow.paid_loss)+cn(internalRow.os_loss))/cn(internalRow.ultimate_premium))*100:null,
                   uw:cn(uwRow.ultimate_premium||prevRow.ultimate_premium)>0?(cn(uwRow.ultimate_loss||prevRow.ultimate_loss)/cn(uwRow.ultimate_premium||prevRow.ultimate_premium))*100:null,
                   fmt:v=>v!=null?fmtP(v):'—',isRatio:true},
                ];
                return(
                  <div style={card}>
                    <div style={cH}>
                      <span>UW {prevYear} — Internal Accounting vs UW Renewal Pack</span>
                      <span style={{fontSize:10,color:'rgba(148,163,184,0.4)'}}>Same year · two sources</span>
                    </div>
                    <table style={{width:'100%',borderCollapse:'collapse'}}>
                      <thead><tr>
                        <th style={{...thS,textAlign:'left'}}>Metric</th>
                        <th style={{...thS,textAlign:'right',color:'#4ade80'}}>Internal Accounting {prevYear}</th>
                        <th style={{...thS,textAlign:'right',color:'#60a5fa'}}>UW / Renewal Pack {prevYear}</th>
                        <th style={{...thS,textAlign:'right'}}>Difference</th>
                      </tr></thead>
                      <tbody>
                        {rows.map((row,i)=>(
                          <tr key={i} style={{borderBottom:'1px solid rgba(255,255,255,0.04)',background:row.isResult?'rgba(74,222,128,0.04)':'transparent'}}>
                            <td style={{...tdS,fontWeight:row.isResult||row.isRatio?700:500,color:row.isResult?'#4ade80':'rgba(226,232,240,0.85)'}}>{row.label}</td>
                            <td style={{...tdS,textAlign:'right',fontWeight:700,color:row.isResult?(n(row.internal)>=0?'#4ade80':'#f87171'):'#4ade80'}}>{row.fmt(row.internal)}</td>
                            <td style={{...tdS,textAlign:'right',color:row.uw?'#60a5fa':'rgba(148,163,184,0.35)'}}>{row.uw?row.fmt(row.uw):'—'}</td>
                            <td style={{...tdS,textAlign:'right',fontWeight:700,color:dc(row.internal,row.uw)}}>{dl(row.internal,row.uw)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    <div style={{padding:'8px 14px',fontSize:10,color:'rgba(148,163,184,0.40)',borderTop:'1px solid rgba(255,255,255,0.05)'}}>
                      Internal Accounting = entries from your accounting system (record_type: ACTUAL) · UW / Renewal Pack = underwriting modelling data. Add a row with record_type UW in Projected Summary to populate the right column separately.
                    </div>
                  </div>
                );
              })()}
              {!actuals.length&&<div style={{padding:'12px 16px',borderRadius:10,background:'rgba(251,191,36,0.08)',border:'1px solid rgba(251,191,36,0.2)',fontSize:13,color:'rgba(255,255,255,0.6)'}}>No historical data. Add year rows in Projected Summary to enable comparison.</div>}
            </>)}

          </div>
        </div>
      )}

      {/* ═══ CLAIMS ═══ */}
      {topTab==='claims'&&(
        <div style={{display:'flex',flexDirection:'column',flex:1,overflow:'hidden',paddingTop:14}}>

          <div style={{display:'flex',gap:10,flexWrap:'wrap',marginBottom:12,flexShrink:0}}>
            {[
              {label:'Total Losses',value:allLosses.length,color:'rgba(226,232,240,0.9)'},
              {label:'Reported',value:allLosses.filter(l=>l.loss_type==='REPORTED').length,color:'#60a5fa'},
              {label:'Provisional',value:allLosses.filter(l=>l.loss_type==='PROVISIONAL').length,color:'#fbbf24'},
              {label:'Cash Calls',value:allLosses.filter(l=>l.loss_type==='CASH_CALL').length,color:'#f97316'},
              {label:'Flags',value:flagCount,color:flagCount>0?'#f87171':'#4ade80'},
            ].map(k=>(
              <div key={k.label} style={{...card,padding:'10px 14px',flex:'1 1 100px'}}>
                <div style={{fontSize:9,fontWeight:800,letterSpacing:'.12em',textTransform:'uppercase',color:'rgba(148,163,184,0.50)',marginBottom:4}}>{k.label}</div>
                <div style={{fontSize:20,fontWeight:900,color:k.color}}>{k.value}</div>
              </div>
            ))}
          </div>

          <div style={{display:'flex',gap:10,marginBottom:10,flexShrink:0,flexWrap:'wrap'}}>
            <div style={{fontSize:10,padding:'4px 10px',borderRadius:6,background:'rgba(248,113,113,0.12)',border:'1px solid rgba(248,113,113,0.35)',color:'rgba(226,232,240,0.75)',fontWeight:600}}>🔴 In internal claims — NOT in UW modelling data</div>
            <div style={{fontSize:10,padding:'4px 10px',borderRadius:6,background:'rgba(251,191,36,0.10)',border:'1px solid rgba(251,191,36,0.35)',color:'rgba(226,232,240,0.75)',fontWeight:600}}>🟡 In UW modelling data — NOT in internal claims</div>
          </div>

          {lossLoading?(
            <div style={{padding:16,color:'rgba(148,163,184,0.5)',fontSize:13}}>Loading losses…</div>
          ):(
            <div style={{flex:1,overflowY:'auto'}}>
              <div style={{overflowX:'auto'}}>
                <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
                  <thead><tr>
                    {['','Src','Type','Insured / Event','Loss Name','Date of Loss','CoB','Gross Amount','Paid','OS','Incurred','Our Share %','Our Paid','Our OS'].map(h=>(
                      <th key={h} style={{...thS,textAlign:['Gross Amount','Paid','OS','Incurred','Our Paid','Our OS'].includes(h)?'right':'left'}}>{h}</th>
                    ))}
                  </tr></thead>
                  <tbody>
                    {allLosses.length===0&&(
                      <tr><td colSpan={14} style={{padding:24,textAlign:'center',color:'rgba(148,163,184,0.4)',fontSize:12}}>No losses found. Enter data in the Large Loss or Cat Loss List screens.</td></tr>
                    )}
                    {allLosses.map((l,i)=>{
                      const missingInUw=!l.in_uw_data, missingInInt=!l.in_internal;
                      const sharePct=l.our_share_pct||(signedLinePct||null);
                      const ourPaid=sharePct?l.paid*sharePct:null, ourOs=sharePct?l.os*sharePct:null;
                      const typeColors={REPORTED:'#60a5fa',PROVISIONAL:'#fbbf24',CASH_CALL:'#f97316'};
                      const srcBadge=l.source==='CAT'?{bg:'rgba(248,113,113,0.12)',c:'#f87171',t:'CAT'}:l.source==='INTERNAL'?{bg:'rgba(148,163,184,0.10)',c:'rgba(148,163,184,0.7)',t:'INT'}:{bg:'rgba(96,165,250,0.12)',c:'#60a5fa',t:'LG'};
                      return(
                        <tr key={i} style={{borderBottom:'1px solid rgba(255,255,255,0.04)',background:missingInUw?'rgba(248,113,113,0.06)':missingInInt?'rgba(251,191,36,0.04)':i%2===0?'transparent':'rgba(255,255,255,0.015)'}}>
                          <td style={{...tdS,width:24,textAlign:'center',padding:'9px 6px'}}>
                            {missingInUw&&<span title="In internal claims — NOT in UW data" style={{fontSize:10}}>🔴</span>}
                            {missingInInt&&<span title="In UW data — NOT in internal claims" style={{fontSize:10}}>🟡</span>}
                          </td>
                          <td style={{...tdS,padding:'9px 8px'}}><span style={{fontSize:9,fontWeight:800,padding:'2px 6px',borderRadius:10,background:srcBadge.bg,color:srcBadge.c,letterSpacing:'.06em'}}>{srcBadge.t}</span></td>
                          <td style={{...tdS,padding:'9px 8px'}}><span style={{fontSize:9,fontWeight:800,padding:'2px 6px',borderRadius:10,background:`${typeColors[l.loss_type]||'#60a5fa'}18`,color:typeColors[l.loss_type]||'#60a5fa',letterSpacing:'.06em'}}>{l.loss_type}</span></td>
                          <td style={{...tdS,maxWidth:150,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={l.insured_name}>{l.insured_name||'—'}</td>
                          <td style={{...tdS,maxWidth:130,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap'}} title={l.loss_name}>{l.loss_name||'—'}</td>
                          <td style={{...tdS,whiteSpace:'nowrap',color:'rgba(148,163,184,0.7)'}}>{(l.date_of_loss||'').slice(0,10)||'—'}</td>
                          <td style={{...tdS,fontSize:11,color:'rgba(148,163,184,0.6)'}}>{l.class_of_business||'—'}</td>
                          <td style={{...tdS,textAlign:'right'}}>{fmt(l.gross_amount||l.incurred)}</td>
                          <td style={{...tdS,textAlign:'right',color:'#f87171'}}>{fmt(l.paid)}</td>
                          <td style={{...tdS,textAlign:'right',color:'#f97316'}}>{fmt(l.os)}</td>
                          <td style={{...tdS,textAlign:'right',fontWeight:700,color:'#fb923c'}}>{fmt(l.incurred)}</td>
                          <td style={{...tdS,textAlign:'right',color:'rgba(148,163,184,0.55)',fontSize:11}}>{sharePct?`${(sharePct*100).toFixed(2)}%`:'—'}</td>
                          <td style={{...tdS,textAlign:'right',color:'#f87171'}}>{ourPaid!=null?fmt(ourPaid):'—'}</td>
                          <td style={{...tdS,textAlign:'right',color:'#f97316'}}>{ourOs!=null?fmt(ourOs):'—'}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                  {allLosses.length>0&&(
                    <tfoot><tr style={{borderTop:'2px solid rgba(255,255,255,0.12)',background:'rgba(5,8,16,0.85)'}}>
                      <td colSpan={7} style={{...tdS,fontSize:9,fontWeight:800,letterSpacing:'.08em',textTransform:'uppercase',color:'rgba(148,163,184,0.50)'}}>TOTAL ({allLosses.length})</td>
                      <td style={{...tdS,textAlign:'right',fontWeight:700}}>{fmt(allLosses.reduce((s,l)=>s+n(l.gross_amount||l.incurred),0))}</td>
                      <td style={{...tdS,textAlign:'right',fontWeight:700,color:'#f87171'}}>{fmt(allLosses.reduce((s,l)=>s+l.paid,0))}</td>
                      <td style={{...tdS,textAlign:'right',fontWeight:700,color:'#f97316'}}>{fmt(allLosses.reduce((s,l)=>s+l.os,0))}</td>
                      <td style={{...tdS,textAlign:'right',fontWeight:700,color:'#fb923c'}}>{fmt(allLosses.reduce((s,l)=>s+l.incurred,0))}</td>
                      <td colSpan={3} style={tdS}></td>
                    </tr></tfoot>
                  )}
                </table>
              </div>
            </div>
          )}
        </div>
      )}

    </div>
  );
}
