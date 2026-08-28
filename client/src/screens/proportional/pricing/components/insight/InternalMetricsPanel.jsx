import { useState, useEffect, useMemo } from 'react';
import { api } from '../../../../../api';
import { useAppState } from '../../../../../context/AppContext.jsx';
import { Badge, Callout, Table } from '../../../../../components/ui';
import { cn } from './_shared.jsx';
import './InternalMetricsPanel.css';

/* ── Internal Metrics Panel ───────────────────────────────────────────────────
   Two top-level tabs:
     FINANCE  sub-tabs: Ratios | Accounts | Renewal Comparison
     CLAIMS   all losses + provisional + cash calls, flagged for discrepancies
   ─────────────────────────────────────────────────────────────────────────── */
const cx = (...xs) => xs.filter(Boolean).join(' ');

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
  const ratioCls = v => n(v)>100?'c-neg':n(v)>70?'c-amber':'c-pos';

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

  // Presentation: visual styles live in InternalMetricsPanel.css
  const kpi=(label,value,tone,sub)=>(
    <div key={label} className="imp-card imp-kpi">
      <div className="imp-kpi__label">{label}</div>
      <div className={cx('imp-kpi__value',tone)}>{value}</div>
      {sub&&<div className="imp-kpi__sub">{sub}</div>}
    </div>
  );

  return (
    <div className="imp-root">

      {/* Top tabs */}
      <div className="imp-toptabs">
        <button type="button" className={cx('imp-toptab',topTab==='finance'&&'is-active')} onClick={()=>setTopTab('finance')}>💰 Finance</button>
        <button type="button" className={cx('imp-toptab',topTab==='claims'&&'is-active')} onClick={()=>setTopTab('claims')}>
          🔴 Claims
          {flagCount>0&&<Badge tone="danger" className="imp-flagchip">{flagCount} flags</Badge>}
        </button>
      </div>

      {/* ═══ FINANCE ═══ */}
      {topTab==='finance'&&(
        <div className="imp-pane">
          <div className="imp-subtabs">
            {[['ratios','📊 Ratios'],['accounts','📋 Accounts'],['renewal','🔄 Renewal']].map(([k,l])=>(
              <button key={k} type="button" className={cx('imp-subtab',finTab===k&&'is-active')} onClick={()=>setFinTab(k)}>{l}</button>
            ))}
          </div>
          <div className="imp-body">

            {finTab==='ratios'&&(<>
              <div className="imp-kpis">
                {kpi('Gross Written Premium',fmtM(gwp),'c-pos')}
                {kpi('Total Incurred',fmtM(incurred),'c-neg',`Paid ${fmtM(paidC)} · OS ${fmtM(osC)}`)}
                {kpi('Commission',fmtM(commission),'c-violet')}
                {kpi('Brokerage',fmtM(brokerage),'c-indigo')}
                {kpi('Technical Result',fmtM(result),result>=0?'c-pos':'c-neg',result>=0?'Profitable':'Loss-making')}
              </div>
              <div className="imp-kpis">
                {kpi('Loss Ratio',lossRatio!=null?`${lossRatio.toFixed(1)}%`:'—',ratioCls(lossRatio),'Incurred ÷ GWP')}
                {kpi('Expense Ratio',expenseRatio!=null?`${expenseRatio.toFixed(1)}%`:'—','c-violet','Comm+Brok ÷ GWP')}
                {kpi('Combined Ratio',combinedRatio!=null?`${combinedRatio.toFixed(1)}%`:'—',ratioCls(combinedRatio),combinedRatio!=null?(combinedRatio<=100?'✓ Profitable':'✗ Loss-making'):'')}
              </div>
              {actuals.length>0?(
                <div className="imp-card">
                  <div className="imp-card__head"><span>Year-by-Year</span></div>
                  <Table className="imp-table" wrapClassName="imp-tablewrap">
                    <thead><tr>
                      {['UW Year','GWP','Paid','OS','Incurred','Comm','Brokerage','Result','LR','ER','CR'].map(h=>(
                        <th key={h} className={h==='UW Year'?undefined:'ta-r'}>{h}</th>
                      ))}
                    </tr></thead>
                    <tbody>
                      {actuals.map((r,i)=>{
                        const g=cn(r.ultimate_premium),p=cn(r.paid_loss)||cn(r.paid_claims),o=cn(r.os_loss)||cn(r.os_claims);
                        const inc=cn(r.ultimate_loss)||p+o,co=cn(r.commission_amt),br=cn(r.brokerage_amt);
                        const res=g-inc-co-br,lr=g>0?(inc/g)*100:null,er=g>0?((co+br)/g)*100:null,cr=lr!=null&&er!=null?lr+er:null;
                        return(
                          <tr key={i}>
                            <td className="fw7">{r.uw_year}</td>
                            <td className="ta-r c-pos">{fmt(g)}</td>
                            <td className="ta-r c-neg">{fmt(p)}</td>
                            <td className="ta-r c-orange">{fmt(o)}</td>
                            <td className="ta-r fw6 c-orange2">{fmt(inc)}</td>
                            <td className="ta-r c-violet">{fmt(co)}</td>
                            <td className="ta-r c-indigo">{fmt(br)}</td>
                            <td className={cx('ta-r','fw7',res>=0?'c-pos':'c-neg')}>{fmt(res)}</td>
                            <td className={cx('ta-r','fw7',ratioCls(lr))}>{lr!=null?`${lr.toFixed(1)}%`:'—'}</td>
                            <td className="ta-r c-violet">{er!=null?`${er.toFixed(1)}%`:'—'}</td>
                            <td className={cx('ta-r','fw7',ratioCls(cr))}>{cr!=null?`${cr.toFixed(1)}%`:'—'}</td>
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
                      return(<tfoot><tr className="imp-total">
                        <td className="imp-total__label">5YR AVG</td>
                        {Array(7).fill(0).map((_,i)=><td key={i} className="ta-r c-dim">—</td>)}
                        <td className={cx('ta-r','fw8',ratioCls(aLR))}>{aLR!=null?`${aLR.toFixed(1)}%`:'—'}</td>
                        <td className="ta-r fw8 c-violet">{aER!=null?`${aER.toFixed(1)}%`:'—'}</td>
                        <td className={cx('ta-r','fw8',ratioCls(aCR))}>{aCR!=null?`${aCR.toFixed(1)}%`:'—'}</td>
                      </tr></tfoot>);
                    })()}
                  </Table>
                </div>
              ):<Callout variant="warn" title="No accounting data.">Add historical year rows in Projected Summary.</Callout>}
            </>)}

            {finTab==='accounts'&&(<>
              <div className="imp-kpis">
                {kpi('Accounts Rendered',String(accountsRendered),'c-cyan')}
                {kpi('Missing Accounts',String(missingAccounts),missingAccounts>0?'c-neg':'c-pos')}
                {kpi('Last Account',actuals[actuals.length-1]?.uw_year?`UW ${actuals[actuals.length-1].uw_year}`:'—')}
                {kpi('History',accountsRendered>1?`${accountsRendered} years`:accountsRendered===1?'1 year':'None','c-violet')}
              </div>
              {actuals.length>0&&(
                <div className="imp-card">
                  <div className="imp-card__head"><span>Accounting Records</span><span className="imp-card__meta">{accountsRendered} year{accountsRendered!==1?'s':''} on file</span></div>
                  <Table className="imp-table" wrapClassName="imp-tablewrap">
                    <thead><tr>
                      {['UW Year','GWP','Paid','OS','Incurred','Commission','LR','Type'].map(h=>(
                        <th key={h} className={h==='UW Year'||h==='Type'?undefined:'ta-r'}>{h}</th>
                      ))}
                    </tr></thead>
                    <tbody>
                      {actuals.map((r,i)=>{
                        const g=cn(r.ultimate_premium),p=cn(r.paid_loss)||cn(r.paid_claims),o=cn(r.os_loss)||cn(r.os_claims);
                        const inc=cn(r.ultimate_loss)||p+o,co=cn(r.commission_amt),lr=g>0?(inc/g)*100:null;
                        return(
                          <tr key={i}>
                            <td className="fw7">{r.uw_year}</td>
                            <td className="ta-r c-pos">{fmt(g)}</td>
                            <td className="ta-r c-neg">{fmt(p)}</td>
                            <td className="ta-r c-orange">{fmt(o)}</td>
                            <td className="ta-r fw6 c-orange2">{fmt(inc)}</td>
                            <td className="ta-r c-violet">{fmt(co)}</td>
                            <td className={cx('ta-r','fw7',ratioCls(lr))}>{lr!=null?`${lr.toFixed(1)}%`:'—'}</td>
                            <td><Badge>{String(r.record_type||'ACTUAL')}</Badge></td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </Table>
                </div>
              )}
              {missingAccounts>0&&<Callout variant="danger" title={`⚠ ${missingAccounts} missing account year${missingAccounts>1?'s':''} detected.`} />}
            </>)}

            {finTab==='renewal'&&(<>
              <div className="imp-renewal-note">
                Comparing <b className="c-pos">UW {prevYear}</b> data from two sources — internal accounting system vs renewal pack / UW modelling data
              </div>
              {(()=>{
                const dcCls=(a,b)=>{if(!n(a)||!n(b))return'c-w35';const d=((n(a)-n(b))/Math.abs(n(b)))*100;return Math.abs(d)<0.5?'c-w40':d>0?'c-pos':'c-neg';};
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
                  <div className="imp-card">
                    <div className="imp-card__head">
                      <span>UW {prevYear} — Internal Accounting vs UW Renewal Pack</span>
                      <span className="imp-card__meta imp-card__meta--sm">Same year · two sources</span>
                    </div>
                    <Table className="imp-table" wrapClassName="imp-tablewrap">
                      <thead><tr>
                        <th>Metric</th>
                        <th className="ta-r c-pos">Internal Accounting {prevYear}</th>
                        <th className="ta-r c-blue">UW / Renewal Pack {prevYear}</th>
                        <th className="ta-r">Difference</th>
                      </tr></thead>
                      <tbody>
                        {rows.map((row,i)=>(
                          <tr key={i} className={row.isResult?'row-result':undefined}>
                            <td className={cx(row.isResult||row.isRatio?'fw7':'fw5',row.isResult?'c-pos':'c-text')}>{row.label}</td>
                            <td className={cx('ta-r','fw7',row.isResult?(n(row.internal)>=0?'c-pos':'c-neg'):'c-pos')}>{row.fmt(row.internal)}</td>
                            <td className={cx('ta-r',row.uw?'c-blue':'c-s35')}>{row.uw?row.fmt(row.uw):'—'}</td>
                            <td className={cx('ta-r','fw7',dcCls(row.internal,row.uw))}>{dl(row.internal,row.uw)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </Table>
                    <div className="imp-card__foot">
                      Internal Accounting = entries from your accounting system (record_type: ACTUAL) · UW / Renewal Pack = underwriting modelling data. Add a row with record_type UW in Projected Summary to populate the right column separately.
                    </div>
                  </div>
                );
              })()}
              {!actuals.length&&<Callout variant="warn" title="No historical data.">Add year rows in Projected Summary to enable comparison.</Callout>}
            </>)}

          </div>
        </div>
      )}

      {/* ═══ CLAIMS ═══ */}
      {topTab==='claims'&&(
        <div className="imp-pane imp-pane--claims">

          <div className="imp-kpis imp-kpis--claims">
            {[
              {label:'Total Losses',value:allLosses.length},
              {label:'Reported',value:allLosses.filter(l=>l.loss_type==='REPORTED').length,tone:'c-blue'},
              {label:'Provisional',value:allLosses.filter(l=>l.loss_type==='PROVISIONAL').length,tone:'c-amber'},
              {label:'Cash Calls',value:allLosses.filter(l=>l.loss_type==='CASH_CALL').length,tone:'c-orange'},
              {label:'Flags',value:flagCount,tone:flagCount>0?'c-neg':'c-pos'},
            ].map(k=>(
              <div key={k.label} className="imp-card imp-kpi imp-kpi--sm">
                <div className="imp-kpi__label">{k.label}</div>
                <div className={cx('imp-kpi__value',k.tone)}>{k.value}</div>
              </div>
            ))}
          </div>

          <div className="imp-legends">
            <div className="imp-legend imp-legend--uw">🔴 In internal claims — NOT in UW modelling data</div>
            <div className="imp-legend imp-legend--int">🟡 In UW modelling data — NOT in internal claims</div>
          </div>

          {lossLoading?(
            <div className="imp-loading">Loading losses…</div>
          ):(
            <div className="imp-scroll">
              <Table className="imp-table" wrapClassName="imp-tablewrap">
                <thead><tr>
                  {['','Src','Type','Insured / Event','Loss Name','Date of Loss','CoB','Gross Amount','Paid','OS','Incurred','Our Share %','Our Paid','Our OS'].map(h=>(
                    <th key={h} className={['Gross Amount','Paid','OS','Incurred','Our Paid','Our OS'].includes(h)?'ta-r':undefined}>{h}</th>
                  ))}
                </tr></thead>
                <tbody>
                  {allLosses.length===0&&(
                    <tr><td colSpan={14} className="imp-empty">No losses found. Enter data in the Large Loss or Cat Loss List screens.</td></tr>
                  )}
                  {allLosses.map((l,i)=>{
                    const missingInUw=!l.in_uw_data, missingInInt=!l.in_internal;
                    // Normalize once to a FRACTION: our_share_pct is stored as a
                    // whole percent (25 = 25%) while signedLinePct is already
                    // divided by 100 above — never mix the two units.
                    const shareFrac=l.our_share_pct!=null?cn(l.our_share_pct)/100:(signedLinePct||null);
                    const ourPaid=shareFrac?l.paid*shareFrac:null, ourOs=shareFrac?l.os*shareFrac:null;
                    const typeTones={REPORTED:'info',PROVISIONAL:'warn',CASH_CALL:'warn'};
                    const srcBadge=l.source==='CAT'?{tone:'danger',t:'CAT'}:l.source==='INTERNAL'?{tone:'neutral',t:'INT'}:{tone:'info',t:'LG'};
                    return(
                      <tr key={i} className={missingInUw?'row-flag-uw':missingInInt?'row-flag-int':undefined}>
                        <td className="imp-flagcell">
                          {missingInUw&&<span title="In internal claims — NOT in UW data" className="imp-flagdot">🔴</span>}
                          {missingInInt&&<span title="In UW data — NOT in internal claims" className="imp-flagdot">🟡</span>}
                        </td>
                        <td className="imp-chipcell"><Badge tone={srcBadge.tone}>{srcBadge.t}</Badge></td>
                        <td className="imp-chipcell"><Badge tone={typeTones[l.loss_type]||'info'} className={l.loss_type==='CASH_CALL'?'imp-badge-cashcall':undefined}>{l.loss_type}</Badge></td>
                        <td className="imp-clip" title={l.insured_name}>{l.insured_name||'—'}</td>
                        <td className="imp-clip imp-clip--sm" title={l.loss_name}>{l.loss_name||'—'}</td>
                        <td className="imp-date">{(l.date_of_loss||'').slice(0,10)||'—'}</td>
                        <td className="imp-cob">{l.class_of_business||'—'}</td>
                        <td className="ta-r">{fmt(l.gross_amount||l.incurred)}</td>
                        <td className="ta-r c-neg">{fmt(l.paid)}</td>
                        <td className="ta-r c-orange">{fmt(l.os)}</td>
                        <td className="ta-r fw7 c-orange2">{fmt(l.incurred)}</td>
                        <td className="ta-r imp-share">{shareFrac?`${(shareFrac*100).toFixed(2)}%`:'—'}</td>
                        <td className="ta-r c-neg">{ourPaid!=null?fmt(ourPaid):'—'}</td>
                        <td className="ta-r c-orange">{ourOs!=null?fmt(ourOs):'—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
                {allLosses.length>0&&(
                  <tfoot><tr className="imp-total">
                    <td colSpan={7} className="imp-total__label">TOTAL ({allLosses.length})</td>
                    <td className="ta-r fw7">{fmt(allLosses.reduce((s,l)=>s+n(l.gross_amount||l.incurred),0))}</td>
                    <td className="ta-r fw7 c-neg">{fmt(allLosses.reduce((s,l)=>s+l.paid,0))}</td>
                    <td className="ta-r fw7 c-orange">{fmt(allLosses.reduce((s,l)=>s+l.os,0))}</td>
                    <td className="ta-r fw7 c-orange2">{fmt(allLosses.reduce((s,l)=>s+l.incurred,0))}</td>
                    <td colSpan={3}></td>
                  </tr></tfoot>
                )}
              </Table>
            </div>
          )}
        </div>
      )}

    </div>
  );
}
