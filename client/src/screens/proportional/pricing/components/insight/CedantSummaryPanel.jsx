import { useState, useEffect, useMemo } from 'react';
import { api } from '../../../../../api.js';
import { useAppState } from '../../../../../context/AppContext.jsx';
import PctInput from '../../../../../components/PctInput';

/* ── Cedant Summary Panel (matching prototype — full table with line sizes, select all, live totals) ── */
export function CedantSummaryPanel({ contractId, currency, contract: contractProp, liveModelledMargin, liveActualMargin }) {
  const [allRows, setAllRows] = useState([]);
  const [loading, setLoading] = useState(true);
  const [includeMap, setIncludeMap] = useState({});
  const [lineSizes, setLineSizes] = useState({});
  const [yearFilter, setYearFilter] = useState('ALL');
  const { state: appState } = useAppState();
  const td = appState.propTreatyDetail || {};
  const hdrLocal = contractProp?.header || contractProp || {};

  useEffect(() => {
    if (!contractId) { setLoading(false); return; }
    let cedantId = hdrLocal.cedant_id || td.cedantId || td.cedant_id || '';
    // (debug log removed for production)

    const fetchSummary = async () => {
      try {
        // If no cedantId yet, fetch the contract to get it
        if (!cedantId) {
          const cData = await api.getContract(contractId).catch(() => null);
          cedantId = cData?.header?.cedant_id || cData?.cedant_id || '';
    // (debug log removed for production)
        }
        if (!cedantId) { setLoading(false); return; }

        let data = await api.getCedantSummary(cedantId).catch(e => {
          console.warn('[CedantSummary] getCedantSummary failed:', e);
          return [];
        });
        if (!Array.isArray(data)) data = [];

        // Fallback: fetch all treaties and filter
        if (!data.length) {
          const home = await api.getHomeSummary().catch(() => ({}));
          const allTreaties = [...(home.drafts||[]), ...(home.submitted||[]), ...(home.renewals||[])];
          data = allTreaties.filter(r => {
            const rid = String(r.cedant_id || r.cedantId || r.cedId || '');
            return rid === String(cedantId);
          });
        }

    // (debug log removed for production)
        // Ensure current treaty in list
        const curExists = data.some(r => String(r.contract_id||r.contractId||r.id||'') === String(contractId));
        if (!curExists) {
          const curUwYear = td.inceptionDate ? new Date(td.inceptionDate).getFullYear() : (td.startYear || td.uw_year || '');
          // Inject live EPI and limit from AppState treaty detail
          const curPremium = (parseFloat(td.quotaShareEpi||0)||0) + (parseFloat(td.surplusEpi||0)||0);
          const curLimit   = parseFloat(td.qsLimit||0) || parseFloat(td.totalCapacity||0) || 0;
          data.unshift({ contract_id:contractId, uw_year: curUwYear, inception_date: td.inceptionDate || '',
            status: td.status||'DRAFT', treatyType: td.treatyTypeName||'',
            premium: curPremium, limit: curLimit,
            actuarial_margin:0, actual_margin:0, uw_margin:0 });
        }
        setAllRows(data);
        const inc = {}; const ls = {};
        data.forEach(r => {
          const id = String(r.contract_id||r.contractId||r.id||'');
          const st = String(r.status||r.decision||r.uw_status||'').toUpperCase();
          inc[id] = !(st === 'DECLINED' || st === 'NTU');
          ls[id] = String(r.signed_line_pct||r.signedLinePct||r.written_line_pct||'');
        });
        // Auto-populate line size for SIGNED and submitted treaties
        data.forEach(r => {
          const id = String(r.contract_id||r.contractId||r.id||'');
          const st = String(r.status||r.uw_status||'').toUpperCase();
          const isSigned  = st === 'SIGNED';
          const isWritten = st === 'AWAITING_SIGNED_LINE' || st === 'AWAITING_APPROVAL';
          const signedPct  = r.signed_line_pct  || r.effective_line_pct;
          const writtenPct = r.written_line_pct;
          if (isSigned && signedPct && !ls[id]) {
            ls[id] = String(parseFloat(String(signedPct).replace(/%/g,'')) || '');
          } else if (isWritten && writtenPct && !ls[id]) {
            ls[id] = String(parseFloat(String(writtenPct).replace(/%/g,'')) || '');
          }
        });
        setIncludeMap(inc);
        setLineSizes(ls);
      } catch (e) { console.error('[CedantSummary] fetch error:', e); }
      setLoading(false);
    };
    fetchSummary();
  }, [contractId, hdrLocal.cedant_id, td.cedantId, td.cedant_id, td.inceptionDate, td.qsLimit, td.quotaShareEpi, td.startYear, td.status, td.surplusEpi, td.totalCapacity, td.treatyTypeName, td.uw_year]);

  // Derive UW year from inception_date for each row
  const getUwYear = r => {
    const ga2 = (obj,...keys) => { for (const k of keys) { if (obj[k] != null && obj[k] !== '') return obj[k]; } return null; };
    const inceptionDate = ga2(r,'inception_date','inceptionDate');
    if (inceptionDate) {
      const yr = new Date(inceptionDate).getFullYear();
      if (yr && !isNaN(yr)) return String(yr);
    }
    return String(ga2(r,'uw_year','uwYear','year')||'');
  };

  // Extract available UW years for filter dropdown
  const availableYears = useMemo(() => {
    const yrs = new Set();
    allRows.forEach(r => { const y = getUwYear(r); if (y) yrs.add(y); });
    return Array.from(yrs).sort((a, b) => Number(b) - Number(a));
  }, [allRows]);

  // Apply year filter
  const rows = yearFilter === 'ALL' ? allRows : allRows.filter(r => getUwYear(r) === yearFilter);

  const idOf = r => String(r.contract_id||r.contractId||r.id||'');
  const isCur = r => idOf(r) === String(contractId);
  const num = v => { const n = Number(String(v??'').replace(/,/g,'').trim()); return Number.isFinite(n)?n:0; };
  const ga = (r,...keys) => { for (const k of keys) { if (r[k] != null && r[k] !== '') return r[k]; } return null; };
  const money = n => { const v = Number(n); return Number.isFinite(v) && v !== 0 ? `${currency} ${v.toLocaleString('en-US',{maximumFractionDigits:0})}` : '—'; };
  const pctCell = v => { if (v==null) return '—'; const n = num(v); const frac = Math.abs(n)>1.5?n/100:n; const d=(frac*100).toFixed(2)+'%'; const c = frac<0?'#f87171':frac>0.08?'#4ade80':'#facc15'; return <span style={{color:c,fontWeight:600}}>{d}</span>; };
  const getLim100 = r => num(ga(r,'limit','treaty_limit','total_limit','qs_limit','total_capacity','capacity','totalCapacity','qs_limit_amt'));
  const getPrem100 = r => num(ga(r,'premium','epi','premium_amt','written_premium','quota_share_epi','quotaShareEpi','gross_premium'));
  const parsePct = s => { const v = parseFloat(String(s).replace('%','').trim()); return Number.isFinite(v)?v/100:0; };
  const getActLim = r => { const lp = parsePct(lineSizes[idOf(r)]||''); return lp>0?getLim100(r)*lp:0; };
  const getActSz = r => { const lp = parsePct(lineSizes[idOf(r)]||''); return lp>0?getPrem100(r)*lp:0; };

  const included = rows.filter(r => includeMap[idOf(r)] !== false);
  const totLim100 = included.reduce((a,r) => a+getLim100(r),0);
  const totPrem100 = included.reduce((a,r) => a+getPrem100(r),0);
  const totActLim = included.reduce((a,r) => a+getActLim(r),0);
  const totActSz = included.reduce((a,r) => a+getActSz(r),0);
  const wAvg = fn => { if (!included.length||totPrem100===0) return null; return included.reduce((a,r)=>a+fn(r)*getPrem100(r),0)/totPrem100; };
  const totModM = wAvg(r => isCur(r) && liveModelledMargin != null ? liveModelledMargin : num(ga(r,'actuarial_margin','actuarialMargin','modelled_margin')));
  const totActM = wAvg(r => isCur(r) && liveActualMargin != null ? liveActualMargin : num(ga(r,'actual_margin','actualMargin','margin_actual')));

  const allSelected = rows.length > 0 && rows.every(r => includeMap[idOf(r)] !== false);
  const toggleAll = () => { const next = !allSelected; const m = {...includeMap}; rows.forEach(r => { m[idOf(r)] = next; }); setIncludeMap(m); };
  const toggleOne = id => setIncludeMap(prev => ({...prev, [id]: !prev[id]}));
  const setLine = (id,val) => setLineSizes(prev => ({...prev, [id]: val}));

  const statusBadge = s => {
    const st = String(s||'DRAFT').toUpperCase();
    const colors = { SIGNED:'#4ade80', DRAFT:'#94a3b8', NTU:'#f97316', DECLINED:'#f87171', AWAITING_APPROVAL:'#facc15', AWAITING_SIGNED_LINE:'#60a5fa' };
    const c = colors[st]||colors.DRAFT;
    return <span style={{fontSize:11,fontWeight:600,padding:'3px 10px',borderRadius:20,border:`1px solid ${c}40`,background:`${c}18`,color:c,whiteSpace:'nowrap'}}>{st.replace(/_/g,' ')}</span>;
  };

  const thS = {padding:'11px 10px',fontSize:11,fontWeight:700,letterSpacing:'.07em',textTransform:'uppercase',color:'rgba(255,255,255,0.45)',borderBottom:'1px solid rgba(255,255,255,0.1)',whiteSpace:'nowrap',position:'sticky',top:0,zIndex:3,background:'rgba(15,26,46,0.98)'};
  const tdS = {padding:'10px 10px',verticalAlign:'middle',borderBottom:'1px solid rgba(255,255,255,0.05)'};

  return (<div style={{display:'flex',flexDirection:'column',height:'100%',fontSize:13}}>
    {/* Header bar */}
    <div style={{display:'flex',alignItems:'center',gap:12,padding:'16px 20px',borderBottom:'1px solid rgba(255,255,255,0.08)',flexShrink:0,flexWrap:'wrap'}}>
      <div style={{flex:1,minWidth:200}}>
        <div style={{fontWeight:700,fontSize:16,color:'#fff'}}>Cedant Programmes</div>
        <div style={{color:'rgba(255,255,255,0.45)',fontSize:12,marginTop:2}}>All contracts for this cedant. Edit Line Size % to calculate actual exposures. Totals update live.</div>
      </div>
      <div style={{display:'flex',gap:8,alignItems:'center',flexShrink:0}}>
        <label style={{fontSize:11,color:'rgba(255,255,255,0.45)',letterSpacing:'.08em',textTransform:'uppercase',fontWeight:700,whiteSpace:'nowrap'}}>UW Year</label>
        <select className="bbg-select" value={yearFilter} onChange={e=>setYearFilter(e.target.value)} style={{width:110,height:32,fontSize:12}}>
          <option value="ALL">All Years</option>
          {availableYears.map(y => <option key={y} value={y}>{y}</option>)}
        </select>
        <button className="bbg-btn" onClick={toggleAll} style={{borderColor:'rgba(249,115,22,0.4)',color:'#f97316'}}>{allSelected ? '☑ Deselect All' : '☑ Select All'}</button>
      </div>
    </div>

    {loading && <div style={{margin:'12px 20px',padding:'10px 16px',borderRadius:8,background:'rgba(251,191,36,0.08)',border:'1px solid rgba(251,191,36,0.2)',fontSize:13,color:'rgba(255,255,255,0.7)'}}>Loading cedant summary…</div>}
    {!loading && rows.length === 0 && <div style={{margin:'12px 20px',padding:'10px 16px',borderRadius:8,background:'rgba(251,191,36,0.08)',border:'1px solid rgba(251,191,36,0.2)',fontSize:13,color:'rgba(255,255,255,0.7)'}}>No programmes found for this cedant{yearFilter !== 'ALL' ? ` in ${yearFilter}` : ''}.</div>}

    {/* Scrollable table */}
    <div style={{flex:1,overflow:'auto',minHeight:0}}>
      <table style={{width:'100%',borderCollapse:'collapse',fontSize:12}}>
        <thead>
          <tr>
            <th style={{...thS,textAlign:'center',width:40}}></th>
            <th style={{...thS,textAlign:'left',width:80}}>UW Year</th>
            <th style={{...thS,textAlign:'left',width:130}}>Treaty Type</th>
            <th style={{...thS,textAlign:'left',width:120}}>Class of Business</th>
            <th style={{...thS,textAlign:'center',width:100}}>Line %</th>
            <th style={{...thS,textAlign:'right',width:130}}>100% Premium</th>
            <th style={{...thS,textAlign:'right',width:130}}>100% Limit</th>
            <th style={{...thS,textAlign:'right',width:120,color:'#93c5fd'}}>Premium (Share)</th>
            <th style={{...thS,textAlign:'right',width:120,color:'#93c5fd'}}>Exposure (Share)</th>
            <th style={{...thS,textAlign:'right',width:120,color:'#86efac'}}>Actuarial Margin</th>
            <th style={{...thS,textAlign:'right',width:110,color:'#86efac'}}>Actual Margin</th>
            <th style={{...thS,textAlign:'right',width:100,color:'#00e8b8'}}>UW Margin</th>
            <th style={{...thS,textAlign:'center',width:130}}>Status</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r,i) => {
            const id = idOf(r); const cur = isCur(r); const inc = includeMap[id] !== false;
            const year = getUwYear(r) || '—';
            const ttype = String(ga(r,'treaty_type','treatyType','type')||'');
            const cob = String(ga(r,'cob','classOfBusiness','class_of_business')||'—');
            const st = String(ga(r,'status','decision','uw_status')||'DRAFT');
            const lineVal = String(lineSizes[id]||'').replace('%','').trim();
            // Margins: use live values for current contract, DB values for others
            const actMargin   = cur && liveActualMargin    != null ? liveActualMargin    : ga(r,'actual_margin','actualMargin','margin_actual');
            const modMargin   = cur && liveModelledMargin  != null ? liveModelledMargin  : ga(r,'actuarial_margin','actuarialMargin','modelled_margin');
            const uwMargin    = ga(r,'uw_margin','uwMargin');
            return (<tr key={id+i} style={{opacity:inc?1:0.35,background:cur?'rgba(16,185,129,0.07)':i%2===0?'transparent':'rgba(255,255,255,0.02)',borderLeft:cur?'3px solid rgba(74,222,128,0.5)':'3px solid transparent',transition:'opacity .15s'}}>
              <td style={{...tdS,textAlign:'center'}}><input type="checkbox" checked={inc} onChange={()=>toggleOne(id)} style={{width:14,height:14,cursor:'pointer',accentColor:'#f97316'}} /></td>
              <td style={{...tdS,fontWeight:cur?700:500}}>
                {year}
                {cur && <div style={{fontSize:9,color:'#4ade80',fontWeight:700,textTransform:'uppercase',marginTop:1}}>▶ Current</div>}
              </td>
              <td style={{...tdS,fontSize:11}}>{ttype}</td>
              <td style={{...tdS,fontSize:11,overflow:'hidden',textOverflow:'ellipsis',whiteSpace:'nowrap',maxWidth:120}} title={cob}>{cob}</td>
              <td style={tdS}>
                <PctInput
                  value={lineVal} onChange={v=>setLine(id,v)} placeholder="0%"
                  className=""
                  style={{background:'rgba(255,255,255,0.07)',border:'1px solid rgba(255,255,255,0.15)',borderRadius:6,height:28,maxWidth:90,width:'100%',padding:'0 6px',fontSize:12,color:'#fff',textAlign:'right',fontFamily:'inherit',outline:'none'}}
                />
              </td>
              <td style={{...tdS,textAlign:'right'}}>{money(getPrem100(r))}</td>
              <td style={{...tdS,textAlign:'right'}}>{money(getLim100(r))}</td>
              <td style={{...tdS,textAlign:'right',color:'#60a5fa'}}>{getActSz(r)?money(getActSz(r)):'—'}</td>
              <td style={{...tdS,textAlign:'right',color:'#60a5fa'}}>{getActLim(r)?money(getActLim(r)):'—'}</td>
              <td style={{...tdS,textAlign:'right'}}>{pctCell(modMargin)}</td>
              <td style={{...tdS,textAlign:'right'}}>{pctCell(actMargin)}</td>
              <td style={{...tdS,textAlign:'right'}}>{pctCell(uwMargin)}</td>
              <td style={{...tdS,textAlign:'center'}}>{statusBadge(st)}</td>
            </tr>);
          })}
        </tbody>
        <tfoot style={{position:'sticky',bottom:0,zIndex:2}}>
          <tr style={{background:'rgba(15,26,46,0.98)'}}>
            <td colSpan={5} style={{...tdS,borderTop:'2px solid rgba(255,255,255,0.15)',fontWeight:700,fontSize:10,letterSpacing:'.06em',textTransform:'uppercase',color:'rgba(255,255,255,0.5)'}}>PORTFOLIO TOTALS ({included.length} treaties)</td>
            <td style={{...tdS,borderTop:'2px solid rgba(255,255,255,0.15)',textAlign:'right',fontWeight:700}}>{money(totPrem100)}</td>
            <td style={{...tdS,borderTop:'2px solid rgba(255,255,255,0.15)',textAlign:'right',fontWeight:700}}>{money(totLim100)}</td>
            <td style={{...tdS,borderTop:'2px solid rgba(255,255,255,0.15)',textAlign:'right',fontWeight:700,color:'#60a5fa'}}>{totActSz?money(totActSz):'—'}</td>
            <td style={{...tdS,borderTop:'2px solid rgba(255,255,255,0.15)',textAlign:'right',fontWeight:700,color:'#60a5fa'}}>{totActLim?money(totActLim):'—'}</td>
            <td style={{...tdS,borderTop:'2px solid rgba(255,255,255,0.15)',textAlign:'right',fontWeight:700}}>{pctCell(totModM)}</td>
            <td style={{...tdS,borderTop:'2px solid rgba(255,255,255,0.15)',textAlign:'right',fontWeight:700}}>{pctCell(totActM)}</td>
            <td style={{...tdS,borderTop:'2px solid rgba(255,255,255,0.15)'}}></td>
            <td style={{...tdS,borderTop:'2px solid rgba(255,255,255,0.15)'}}></td>
          </tr>
        </tfoot>
      </table>
    </div>
  </div>);
}
