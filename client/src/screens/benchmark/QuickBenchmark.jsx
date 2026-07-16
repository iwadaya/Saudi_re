/**
 * QuickBenchmark.jsx — 3rd-Point Geomean Power-Law Pricing
 *
 * Geomean  = √((Limit + Attachment) × Attachment)
 * x        = Geomean / EGNPI
 * Expiring ROL = Rate × EGNPI / Limit   (calibrates curve)
 * Priced   ROL = a × x^b                (from calibrated/default curve)
 * Premium  = ROL × Limit
 * Rate     = Premium / EGNPI
 * Wtd ROL  = SUMPRODUCT(ROL, Limit) / SUM(Limit)
 */
import React, { useState, useCallback, useEffect, useId } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../../api';
import { formatWithCommas, sanitizeNumber } from '../../utils/format';
import PctInput from '../../components/PctInput';
import './benchmark.css';

const MARKET_A    = 0.108;
const MARKET_B    = -1.074;
const MAX_LAYERS  = 8;
const MAX_STR     = 5;
const STR_COLORS  = ['#00d4ff','#a78bfa','#4ade80','#f59e0b','#f87171'];
const TREATY_TYPES_FALLBACK = ['Risk XL','Cat XL','Net XL','Stop Loss','Aggregate XL'];

// ── Pure helpers ────────────────────────────────────────────────────────────
function toN(v){ const n=parseFloat(String(v??'').replace(/,/g,'').trim()); return isFinite(n)?n:0; }
function fmt(v){ return v>0 ? formatWithCommas(String(Math.round(v))) : '—'; }
function fmtPct2(v){ return v>0 ? `${(v*100).toFixed(2)}%` : '—'; }
function fmtPct4(v){ return v>0 ? `${(v*100).toFixed(4)}%` : '—'; }

function geomean(limit,att){
  const top=limit+att;
  return top>0&&att>0 ? Math.sqrt(top*att) : 0;
}

function fitPowerLaw(pts){
  const p=pts.filter(p=>p.x>0&&p.y>0&&isFinite(p.x)&&isFinite(p.y));
  if(p.length<2) return {a:MARKET_A,b:MARKET_B,r2:null,calibrated:false};
  const evalB=b=>{
    let num=0,den=0;
    for(const pt of p){const xb=Math.pow(pt.x,b);num+=pt.y*xb;den+=xb*xb;}
    if(!den||!isFinite(num)) return {sse:Infinity,a:NaN};
    const a=num/den;
    if(!isFinite(a)||a<=0) return {sse:Infinity,a};
    let sse=0; for(const pt of p){const e=pt.y-a*Math.pow(pt.x,b);sse+=e*e;}
    return {sse,a};
  };
  let best={sse:Infinity,a:NaN,b:NaN};
  for(let b=-10;b<=0;b+=0.1){const r=evalB(b);if(r.sse<best.sse)best={...r,b};}
  for(let b=best.b-.15;b<=best.b+.15;b+=.005){const r=evalB(b);if(r.sse<best.sse)best={...r,b};}
  if(!isFinite(best.a)||!isFinite(best.b)||best.a<=0)
    return {a:MARKET_A,b:MARKET_B,r2:null,calibrated:false};
  const meanY=p.reduce((s,pt)=>s+pt.y,0)/p.length;
  let ssTot=0,ssRes=0;
  for(const pt of p){const yhat=best.a*Math.pow(pt.x,best.b);ssTot+=(pt.y-meanY)**2;ssRes+=(pt.y-yhat)**2;}
  const r2=ssTot>0?1-ssRes/ssTot:null;
  return {a:best.a,b:best.b,r2:isFinite(r2)?r2:null,calibrated:true};
}

function calcExp(l){
  const limit=toN(l.limit),att=toN(l.attachment),egnpi=toN(l.egnpi),rate=toN(l.rate)/100;
  if(!limit||!att||!egnpi||!rate) return {...l,_gm:0,_x:0,_rol:0,_prem:0};
  const _gm=geomean(limit,att),_x=_gm/egnpi,_rol=(rate*egnpi)/limit,_prem=rate*egnpi;
  return {...l,_gm,_x,_rol,_prem};
}
function calcNew(l,a,b){
  const limit=toN(l.limit),att=toN(l.attachment),egnpi=toN(l.egnpi);
  if(!limit||!att||!egnpi) return {...l,_gm:0,_x:0,_rol:0,_prem:0,_rate:0};
  const _gm=geomean(limit,att),_x=_gm/egnpi;
  // Power law with negative b can overflow to Infinity for tiny x; clamp non-finite to 0
  // so downstream formatters and totals don't render "Infinity".
  let _rol=_x>0?a*Math.pow(_x,b):0;
  if(!Number.isFinite(_rol)) _rol=0;
  let _prem=_rol*limit;
  if(!Number.isFinite(_prem)) _prem=0;
  const _rate=egnpi>0?_prem/egnpi:0;
  return {...l,_gm,_x,_rol,_prem,_rate};
}
function wtdROL(layers,rolKey='_rol'){
  const den=layers.reduce((s,l)=>s+(l[rolKey]>0?toN(l.limit):0),0);
  if(!den) return 0;
  return layers.reduce((s,l)=>s+(l[rolKey]>0?l[rolKey]*toN(l.limit):0),0)/den;
}

function emptyExp(i){ return {id:i,limit:'',attachment:'',egnpi:'',rate:'',mdp:'',reinstatements:''}; }
function emptyNew(i){ return {id:i,limit:'',attachment:'',egnpi:''}; }

// ── Formatted number cell with paste support ─────────────────────────────────
// Strips commas on focus, re-formats on blur. Accepts paste from Excel.
function NumCell({ value, onChange, placeholder = '—', className = 'bm-cell', style, id, 'data-row': row, 'data-col': col, onPaste }) {
  const [editing, setEditing] = React.useState(false);
  const [raw, setRaw] = React.useState('');
  const display = React.useMemo(() => {
    const s = String(value ?? '').replace(/,/g, '').trim();
    if (!s) return '';
    const n = parseFloat(s);
    return isFinite(n) && n > 0 ? formatWithCommas(String(Math.round(n))) : value;
  }, [value]);
  return (
    <input
      id={id}
      className={className}
      style={style}
      value={editing ? raw : display}
      placeholder={placeholder}
      data-row={row}
      data-col={col}
      onFocus={e => { setEditing(true); setRaw(String(value ?? '').replace(/,/g, '')); e.target.select(); }}
      onChange={e => { setRaw(e.target.value); onChange(sanitizeNumber(e.target.value)); }}
      onBlur={() => setEditing(false)}
      onPaste={onPaste}
    />
  );
}

// ── Multi-cell paste handler (Excel-style: tab cols, newline rows) ────────────
// colMap: array of field names matching column order in the table
// updateFn: (rowIdx, field, value) => void
// startRow / startCol: the cell the paste landed on
function makeTablePasteHandler(colMap, updateFn, addRowFn, postFn) {
  return (e, startRow, startCol) => {
    const text = e.clipboardData?.getData('text/plain');
    if (!text) return;
    if (!text.includes('\t') && !text.includes('\n')) return;
    e.preventDefault();
    const rows = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n')
      .split('\n').filter(l => l.trim());
    rows.forEach((line, ri) => {
      const cells = line.split('\t');
      cells.forEach((val, ci) => {
        const colIdx = startCol + ci;
        const field = colMap[colIdx];
        if (!field) return;
        updateFn(startRow + ri, field, sanitizeNumber(val));
      });
    });
    if (postFn) setTimeout(postFn, 0);
  };
}

// ── COB Select Modal (same pattern as PropTreatyDetail) ─────────────────────
function CobSelectModal({selected,cobList,onSave,onClose}){
  const [sel,setSel]=useState(new Set(selected||[]));
  const toggle=id=>{const n=new Set(sel);n.has(id)?n.delete(id):n.add(id);setSel(n);};
  return (
    // Backdrop dismissal is a pointer-only convenience; keyboard users
    // close via the labelled ✕ button in the modal title bar.
    <div className="bm-modal-backdrop" role="presentation" onClick={e=>e.target===e.currentTarget&&onClose()}>
      <div className="bm-modal">
        <div className="bm-modal-title">
          <span>Select Lines of Business</span>
          <button type="button" className="bm-pill" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div className="bm-modal-body">
          {(cobList||[]).map(c=>(
            <label key={c.id} className="bm-cob-row">
              <input type="checkbox" checked={sel.has(c.id)} onChange={()=>toggle(c.id)} />
              {c.name}
            </label>
          ))}
        </div>
        <div className="bm-modal-actions">
          <button className="bm-btn-ghost" onClick={onClose}>Cancel</button>
          <button className="bm-btn-primary" onClick={()=>onSave([...sel])}>Apply</button>
        </div>
      </div>
    </div>
  );
}

// ── SVG Curve ────────────────────────────────────────────────────────────────
function PricingCurve({expCalc,structCalcs,a,b,r2}){
  const allPts=[
    ...expCalc.filter(l=>l._x>0&&l._rol>0),
    ...structCalcs.flat().filter(l=>l._x>0&&l._rol>0),
  ];
  if(!allPts.length) return (
    <div className="bm-curve-empty">Enter layer data to see the pricing curve</div>
  );
  const W=860,H=270,pL=56,pR=24,pT=22,pB=38;
  const allX=allPts.map(p=>p._x),allY=allPts.map(p=>p._rol);
  const xMin=Math.max(0,Math.min(...allX)*0.65),xMax=Math.max(...allX)*1.40;
  const yMin=Math.max(0,Math.min(...allY)*0.65),yMax=Math.max(...allY)*1.40;
  const sx=x=>pL+((x-xMin)/(xMax-xMin||1))*(W-pL-pR);
  const sy=y=>H-pB-((y-yMin)/(yMax-yMin||1))*(H-pT-pB);
  let pathD='';
  for(let i=0;i<=120;i++){
    const x=xMin+(i/120)*(xMax-xMin);
    if(x<=0) continue;
    const y=a*Math.pow(x,b);
    if(y<0||!isFinite(y)) continue;
    pathD+=`${i===0?'M':'L'}${sx(x).toFixed(1)},${sy(y).toFixed(1)} `;
  }
  const YTICKS=5,yStep=(yMax-yMin)/YTICKS;
  return (
    <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" className="crisp-grid" style={{display:'block', fontFamily:'inherit', fontVariantNumeric:'tabular-nums'}}>
      {Array.from({length:YTICKS+1},(_,i)=>{const y=yMin+i*yStep;return(
        <line key={i} x1={pL} x2={W-pR} y1={sy(y)} y2={sy(y)} stroke="rgba(255,255,255,0.07)" strokeWidth={1} shapeRendering="crispEdges" vectorEffect="non-scaling-stroke"/>
      );})}
      <line x1={pL} y1={pT} x2={pL} y2={H-pB} stroke="rgba(255,255,255,0.30)" shapeRendering="crispEdges" vectorEffect="non-scaling-stroke"/>
      <line x1={pL} y1={H-pB} x2={W-pR} y2={H-pB} stroke="rgba(255,255,255,0.30)" shapeRendering="crispEdges" vectorEffect="non-scaling-stroke"/>
      {Array.from({length:YTICKS+1},(_,i)=>{const y=yMin+i*yStep;return(
        <text key={i} x={pL-5} y={sy(y)+4} fontSize={10} fontWeight="500" fill="rgba(148,163,184,0.85)" textAnchor="end">{(y*100).toFixed(1)}%</text>
      );})}
      <text x={pL+10} y={H-6} fontSize={10} fontWeight="500" fill="rgba(148,163,184,0.70)">x = Geomean / EGNPI</text>
      {pathD&&<path d={pathD} fill="none" stroke="rgba(0,212,255,0.85)" strokeWidth={2.5} strokeLinejoin="round" strokeLinecap="round" vectorEffect="non-scaling-stroke"/>}
      <text x={W-pR} y={pT+12} fontSize={10} fontWeight="600" fill="rgba(0,212,255,0.85)" textAnchor="end"
        style={{ fontFamily: 'var(--font-mono)' }}>
        ROL = {a.toFixed(5)} × x^{b.toFixed(3)}{r2!=null?`   R² = ${r2.toFixed(4)}`:''}
      </text>
      <text x={W-pR} y={pT+26} fontSize={9} fontWeight="500" fill="rgba(0,212,255,0.55)" textAnchor="end"
        style={{ fontFamily: 'var(--font-mono)' }}>
        Power law · x = Geomean / EGNPI
      </text>
      {expCalc.filter(l=>l._x>0&&l._rol>0).map((l,i)=>(
        <g key={`e${i}`}>
          <circle cx={sx(l._x)} cy={sy(l._rol)} r={7} fill="rgba(167,139,250,0.80)" stroke="rgba(167,139,250,0.25)" strokeWidth={2}/>
          <text x={sx(l._x)+10} y={sy(l._rol)+4} fontSize={10} fill="rgba(167,139,250,0.90)" fontWeight={700}>E{i+1}</text>
        </g>
      ))}
      {structCalcs.map((sCalc,sIdx)=>
        sCalc.filter(l=>l._x>0&&l._rol>0).map((l,lIdx)=>{
          const col=STR_COLORS[sIdx%STR_COLORS.length];
          return (
            <g key={`n${sIdx}-${lIdx}`}>
              <circle cx={sx(l._x)} cy={sy(l._rol)} r={7} fill={col+'cc'} stroke={col+'44'} strokeWidth={2}/>
              <text x={sx(l._x)+10} y={sy(l._rol)+4} fontSize={10} fill={col} fontWeight={700}>S{sIdx+1}L{lIdx+1}</text>
            </g>
          );
        })
      )}
      <circle cx={pL+10} cy={pT+7} r={5} fill="rgba(167,139,250,0.80)"/>
      <text x={pL+20} y={pT+11} fontSize={10} fill="rgba(167,139,250,0.75)">Expiring</text>
      {structCalcs.map((_,i)=>{const col=STR_COLORS[i%STR_COLORS.length];return(
        <g key={i}>
          <circle cx={pL+82+i*76} cy={pT+7} r={5} fill={col+'cc'}/>
          <text x={pL+92+i*76} y={pT+11} fontSize={10} fill={col+'bb'}>Str {i+1}</text>
        </g>
      );})}
    </svg>
  );
}

// ── Main ─────────────────────────────────────────────────────────────────────
export default function QuickBenchmark(){
  const navigate=useNavigate();
  const fid=useId(); // prefix for the Treaty Details field ids (label ↔ control)

  // Ref data
  const [countries,setCountries]=useState([]);
  const [cedants,setCedants]=useState([]);
  const [cobList,setCobList]=useState([]);
  const [treatyTypes,setTreatyTypes]=useState(TREATY_TYPES_FALLBACK);

  useEffect(()=>{
    api.getRefListItems('country').then(r=>setCountries(Array.isArray(r)?r:[])).catch(()=>{});
    api.listClassOfBusiness().then(r=>setCobList(Array.isArray(r)?r:[])).catch(()=>{});
    api.listTreatyTypes().then(r=>{
      if(!Array.isArray(r)||!r.length) return;
      const np = r.filter(t => /NP|NON.PROP|XL|EXCESS|STOP.LOSS|AGGREGATE/i.test(t.category||t.name||''));
      const list = np.length ? np.map(t=>t.name) : r.map(t=>t.name);
      setTreatyTypes(list);
      setMeta(p => p.treatyType ? p : { ...p, treatyType: list[0] || '' });
    }).catch(()=>{});
  },[]);

  // Header state
  const [meta,setMeta]=useState({
    countryId:'',cedantId:'',treatyType:'',uwYear:String(new Date().getFullYear()),egnpi:'',
  });
  const updateMeta=(k,v)=>setMeta(p=>({...p,[k]:v}));

  // Load cedants when country changes
  useEffect(()=>{
    if(!meta.countryId){setCedants([]);updateMeta('cedantId','');return;}
    api.listCedants({countryId:meta.countryId})
      .then(r=>setCedants(Array.isArray(r)?r:[]))
      .catch(()=>setCedants([]));
    updateMeta('cedantId','');
  },[meta.countryId]);

  // Selected COBs with UW limits
  const [selectedCobs,setSelectedCobs]=useState([]); // [{id, name, uwLimit:''}]
  const [showCobModal,setShowCobModal]=useState(false);

  const handleCobSave=ids=>{
    const cobMap=new Map(cobList.map(c=>[c.id,c.name]));
    setSelectedCobs(prev=>{
      const prevMap=new Map(prev.map(c=>[c.id,c]));
      return ids.map(id=>prevMap.get(id)||{id,name:cobMap.get(id)||id,uwLimit:''});
    });
    setShowCobModal(false);
  };
  const updateUwLimit=(cobId,val)=>
    setSelectedCobs(prev=>prev.map(c=>c.id===cobId?{...c,uwLimit:val}:c));

  // Apply EGNPI to all layers
  const applyEgnpi=useCallback(()=>{
    const v=meta.egnpi; if(!v) return;
    setExpLayers(prev=>prev.map(l=>({...l,egnpi:v})));
    setStructures(prev=>prev.map(s=>({...s,layers:s.layers.map(l=>({...l,egnpi:v}))})));
  },[meta.egnpi]);

  // Expiring layers
  // Cascade attachments: layer[i].attachment = layer[i-1].attachment + layer[i-1].limit
  const cascadeAttachments = (layers) => {
    const result = [...layers];
    for (let i = 1; i < result.length; i++) {
      const prev = result[i - 1];
      const prevAtt = toN(prev.attachment);
      const prevLim = toN(prev.limit);
      if (prevAtt > 0 || prevLim > 0) {
        result[i] = { ...result[i], attachment: String(prevAtt + prevLim) };
      }
    }
    return result;
  };

  const [expLayers,setExpLayers]=useState([emptyExp(0),emptyExp(1),emptyExp(2)]);
  const updateExp=(i,f,v)=>setExpLayers(prev=>{
    const n=[...prev]; n[i]={...n[i],[f]:v};
    return (f==='limit'||f==='attachment') ? cascadeAttachments(n) : n;
  });
  const addExp=()=>{if(expLayers.length<MAX_LAYERS)setExpLayers(p=>cascadeAttachments([...p,emptyExp(p.length)]));};
  const removeExp=i=>setExpLayers(p=>p.filter((_,idx)=>idx!==i));

  // Structures: each has layers[] and cobToggles {cobId: bool[]}
  const [numStr,setNumStr]=useState(1);
  const makeStructure=()=>({layers:[emptyNew(0),emptyNew(1),emptyNew(2)],cobToggles:{}});
  const [structures,setStructures]=useState([makeStructure()]);

  useEffect(()=>{
    const n=Math.max(1,Math.min(MAX_STR,numStr));
    setStructures(prev=>{
      const next=[...prev];
      while(next.length<n) next.push(makeStructure());
      return next.slice(0,n);
    });
  },[numStr]);

  // When COBs change, sync cobToggles for all structures
  useEffect(()=>{
    setStructures(prev=>prev.map(s=>{
      const ct={};
      selectedCobs.forEach(c=>{
        const existing=s.cobToggles[c.id];
        ct[c.id]=existing||Array(s.layers.length).fill(false);
        // ensure length matches
        while(ct[c.id].length<s.layers.length) ct[c.id].push(false);
        ct[c.id]=ct[c.id].slice(0,s.layers.length);
      });
      return {...s,cobToggles:ct};
    }));
  },[selectedCobs]);

  const updateStrLayer=(sIdx,lIdx,f,v)=>setStructures(prev=>prev.map((s,si)=>{
    if(si!==sIdx) return s;
    const newLayers=[...s.layers]; newLayers[lIdx]={...newLayers[lIdx],[f]:v};
    return {...s, layers: (f==='limit'||f==='attachment') ? cascadeAttachments(newLayers) : newLayers};
  }));
  const addStrLayer=sIdx=>setStructures(prev=>prev.map((s,si)=>{
    if(si!==sIdx||s.layers.length>=MAX_LAYERS) return s;
    const newLayers=[...s.layers,emptyNew(s.layers.length)];
    const newCt={};
    Object.entries(s.cobToggles).forEach(([cobId,flags])=>{
      newCt[cobId]=[...flags,false];
    });
    return {...s,layers:cascadeAttachments(newLayers),cobToggles:newCt};
  }));
  const removeStrLayer=(sIdx,lIdx)=>setStructures(prev=>prev.map((s,si)=>{
    if(si!==sIdx) return s;
    const newLayers=s.layers.filter((_,li)=>li!==lIdx);
    const newCt={};
    Object.entries(s.cobToggles).forEach(([cobId,flags])=>{
      newCt[cobId]=flags.filter((_,li)=>li!==lIdx);
    });
    return {...s,layers:cascadeAttachments(newLayers),cobToggles:newCt};
  }));
  const toggleCobLayer=(sIdx,cobId,lIdx)=>setStructures(prev=>prev.map((s,si)=>{
    if(si!==sIdx) return s;
    const flags=[...(s.cobToggles[cobId]||[])];
    while(flags.length<=lIdx) flags.push(false);
    flags[lIdx]=!flags[lIdx];
    return {...s,cobToggles:{...s.cobToggles,[cobId]:flags}};
  }));

  // ── Compute ──────────────────────────────────────────────────────────────
  const expCalc=expLayers.map(calcExp);
  const fitPoints=expCalc.filter(l=>l._x>0&&l._rol>0).map(l=>({x:l._x,y:l._rol}));
  const {a,b,r2,calibrated}=fitPowerLaw(fitPoints);
  const structCalcs=structures.map(s=>s.layers.map(l=>calcNew(l,a,b)));

  const countryName=countries.find(c=>c.id===meta.countryId)?.name||'';
  const cedantName=cedants.find(c=>c.id===meta.cedantId)?.name||'';

  const expPasteHandler = makeTablePasteHandler(
    ['limit','attachment','egnpi','rate','mdp','reinstatements'],
    (rowIdx, field, val) => {
      setExpLayers(prev => {
        const next = [...prev];
        while (next.length <= rowIdx) next.push(emptyExp(next.length));
        next[rowIdx] = { ...next[rowIdx], [field]: val };
        return next;
      });
    },
    null,
    // post-paste: cascade attachments
    () => setExpLayers(prev => cascadeAttachments(prev))
  );

  const strPasteHandlers = structures.map((_, sIdx) => makeTablePasteHandler(
    ['limit','attachment','egnpi'],
    (rowIdx, field, val) => {
      setStructures(prev => prev.map((s, si) => {
        if (si !== sIdx) return s;
        const newLayers = [...s.layers];
        while (newLayers.length <= rowIdx) newLayers.push(emptyNew(newLayers.length));
        newLayers[rowIdx] = { ...newLayers[rowIdx], [field]: val };
        return { ...s, layers: newLayers };
      }));
    },
    null,
    // post-paste: cascade attachments for this structure
    () => setStructures(prev => prev.map((s, si) =>
      si !== sIdx ? s : { ...s, layers: cascadeAttachments(s.layers) }
    ))
  ));

  return (
    <div className="bm-shell">

      {/* Topbar */}
      <header className="bm-topbar">
        <div className="bm-topbar-left">
          <div className="bm-logo">U3</div>
          <div>
            <div className="bm-topbar-title">QUICK BENCHMARK</div>
            <div className="bm-topbar-sub">
              3rd-Point Geomean Power-Law
              {cedantName&&countryName&&<span className="bm-topbar-context"> · {cedantName} · {countryName}</span>}
            </div>
          </div>
        </div>
        <div className="bm-topbar-right">
          <button className="bm-pill" onClick={()=>navigate('/')}>↑ Home</button>
          <button className="bm-pill" onClick={()=>navigate('/dashboard')}>Dashboard</button>
        </div>
      </header>

      <main className="bm-main">

        {/* Treaty Details */}
        <section className="bm-card bm-card--meta">
          <div className="bm-card-header" style={{borderBottom:'none'}}>
            <div className="bm-card-title">Treaty Details</div>
          </div>
          <div className="bm-meta-grid">
            <div className="bm-field">
              <label className="bm-label" htmlFor={`${fid}-country`}>Country</label>
              <select id={`${fid}-country`} className="bm-input" value={meta.countryId} onChange={e=>updateMeta('countryId',e.target.value)}>
                <option value="">— Select country —</option>
                {countries.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="bm-field">
              <label className="bm-label" htmlFor={`${fid}-cedant`}>Cedant</label>
              <select id={`${fid}-cedant`} className="bm-input" value={meta.cedantId} onChange={e=>updateMeta('cedantId',e.target.value)}
                disabled={!meta.countryId}>
                <option value="">{meta.countryId?'— Select cedant —':'Select country first'}</option>
                {cedants.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
              </select>
            </div>
            <div className="bm-field">
              <label className="bm-label" htmlFor={`${fid}-cob`}>Class of Business</label>
              <button id={`${fid}-cob`} className="bm-input bm-input--btn" onClick={()=>setShowCobModal(true)}>
                <span style={{color:selectedCobs.length?'rgba(226,232,240,0.90)':'rgba(255,255,255,0.30)'}}>
                  {selectedCobs.length ? selectedCobs.map(c=>c.name).join(', ') : '— Select COB —'}
                </span>
                <span className="bm-input-chevron">▾</span>
              </button>
            </div>
            <div className="bm-field">
              <label className="bm-label" htmlFor={`${fid}-treaty-type`}>Treaty Type</label>
              <select id={`${fid}-treaty-type`} className="bm-input" value={meta.treatyType} onChange={e=>updateMeta('treatyType',e.target.value)}>
                {treatyTypes.map(t=><option key={t}>{t}</option>)}
              </select>
            </div>
            <div className="bm-field">
              <label className="bm-label" htmlFor={`${fid}-egnpi`}>EGNPI (100%)</label>
              <div className="bm-input-row">
                <NumCell id={`${fid}-egnpi`} className="bm-input" value={meta.egnpi}
                  onChange={v=>updateMeta('egnpi',v)} placeholder="e.g. 50,000,000"/>
                <button className="bm-apply-btn" onClick={applyEgnpi} title="Apply to all layers">↓ All</button>
              </div>
            </div>
            <div className="bm-field">
              <label className="bm-label" htmlFor={`${fid}-uw-year`}>UW Year</label>
              <input id={`${fid}-uw-year`} className="bm-input" value={meta.uwYear}
                onChange={e=>updateMeta('uwYear',e.target.value)} placeholder={String(new Date().getFullYear())}/>
            </div>
            <div className="bm-field">
              <label className="bm-label" htmlFor={`${fid}-num-structures`}>Structures to Benchmark</label>
              <select id={`${fid}-num-structures`} className="bm-input" value={numStr} onChange={e=>setNumStr(Number(e.target.value))}>
                {[1,2,3,4,5].map(n=><option key={n} value={n}>{n} structure{n>1?'s':''}</option>)}
              </select>
            </div>
          </div>


        </section>

        {/* Calibration badge */}
        <div className="bm-curve-badge-row">
          <div className={`bm-curve-badge ${calibrated?'bm-curve-badge--live':'bm-curve-badge--market'}`}>
            {calibrated?'⚡ Calibrated from expiring':'📊 Market default (a=0.108, b=−1.074)'}
            <span>a={a.toFixed(5)}</span>
            <span>b={b.toFixed(4)}</span>
            {r2!=null&&<span>R²={r2.toFixed(3)}</span>}
            {!calibrated&&<span style={{opacity:.55}}>Add ≥2 expiring layers to calibrate</span>}
          </div>
        </div>

        {/* Expiring Structure */}
        <section className="bm-card">
          <div className="bm-card-header">
            <div>
              <div className="bm-card-title">Expiring Structure</div>
              <div className="bm-card-hint">Known market terms — calibrates the pricing curve. Leave blank to use default coefficients.</div>
            </div>
            <button className="bm-add-btn" onClick={addExp} disabled={expLayers.length>=MAX_LAYERS}>+ Layer</button>
          </div>
          <div className="bm-table-wrap">
            <table className="bm-table">
              <thead>
                <tr>
                  <th>#</th><th>Limit</th><th>Attachment</th><th>EGNPI</th>
                  <th>Rate %</th><th>ROL %</th><th>Premium</th>
                  <th>MDP</th><th>Reinst.</th>
                  <th>Geomean</th><th>x=G/E</th><th></th>
                </tr>
              </thead>
              <tbody>
                {expCalc.map((l,i)=>(
                  <tr key={i} className={l._rol>0?'bm-tr--active':''}>
                    <td><span className="bm-badge bm-badge--exp">E{i+1}</span></td>
                    <td><NumCell value={l.limit}       onChange={v=>updateExp(i,'limit',v)}       data-row={i} data-col={0} onPaste={e=>expPasteHandler(e,i,0)} /></td>
                    <td><NumCell value={l.attachment}  onChange={v=>updateExp(i,'attachment',v)}  data-row={i} data-col={1} onPaste={e=>expPasteHandler(e,i,1)} /></td>
                    <td><NumCell value={l.egnpi}       onChange={v=>updateExp(i,'egnpi',v)}       data-row={i} data-col={2} onPaste={e=>expPasteHandler(e,i,2)} /></td>
                    <td><PctInput className="bm-cell bm-cell--sm" value={l.rate} onChange={v=>updateExp(i,'rate',v)} placeholder="—%"/></td>
                    <td className="bm-calc bm-calc--hi">{fmtPct2(l._rol)}</td>
                    <td className="bm-calc">{fmt(l._prem)}</td>
                    <td><NumCell className="bm-cell bm-cell--sm" value={l.mdp} onChange={v=>updateExp(i,'mdp',v)} /></td>
                    <td><input className="bm-cell bm-cell--sm" value={l.reinstatements} onChange={e=>updateExp(i,'reinstatements',e.target.value)} placeholder="—"/></td>
                    <td className="bm-calc bm-calc--dim">{fmt(l._gm)}</td>
                    <td className="bm-calc bm-calc--dim">{l._x>0?l._x.toFixed(4):'—'}</td>
                    <td><button className="bm-del" onClick={()=>removeExp(i)}>✕</button></td>
                  </tr>
                ))}
              </tbody>
              {expCalc.some(l=>l._rol>0)&&(
                <tfoot>
                  <tr className="bm-foot">
                    <td>TOTAL</td>
                    <td>{fmt(expCalc.reduce((s,l)=>s+toN(l.limit),0))}</td>
                    <td colSpan={3}></td>
                    <td className="bm-calc bm-calc--hi" style={{fontWeight:800}}>{fmtPct2(wtdROL(expCalc.map(l=>({...l,_rol:l._rol}))))}</td>
                    <td className="bm-calc">{fmt(expCalc.reduce((s,l)=>s+(l._prem||0),0))}</td>
                    <td colSpan={5}></td>
                  </tr>
                </tfoot>
              )}
            </table>
          </div>
          {expCalc.some(l=>l._rol>0)&&(
            <div className="bm-totals-bar">
              <div className="bm-totals-item"><span className="bm-totals-label">LAYERS</span><span className="bm-totals-value">{expCalc.filter(l=>l._rol>0).length}</span></div>
              <div className="bm-totals-item"><span className="bm-totals-label">TOTAL LIMIT</span><span className="bm-totals-value">{fmt(expCalc.reduce((s,l)=>s+toN(l.limit),0))}</span></div>
              <div className="bm-totals-item"><span className="bm-totals-label">TOTAL PREMIUM</span><span className="bm-totals-value">{fmt(expCalc.reduce((s,l)=>s+(l._prem||0),0))}</span></div>
              <div className="bm-totals-item bm-totals-item--hi"><span className="bm-totals-label">WTD ROL</span><span className="bm-totals-value">{fmtPct2(wtdROL(expCalc))}</span></div>
              <div className="bm-totals-item"><span className="bm-totals-label">TOP ATTACHMENT</span><span className="bm-totals-value">{fmt(Math.max(...expCalc.map(l=>toN(l.attachment)+toN(l.limit))))}</span></div>
            </div>
          )}
        </section>
        <section className="bm-card bm-card--curve">
          <div className="bm-card-header">
            <div className="bm-card-title">Implied Pricing Curve</div>
            <div className="bm-card-hint">Violet = expiring · Coloured dots = new structure layers priced on curve</div>
          </div>
          <div className="bm-curve-svg-wrap">
            <PricingCurve expCalc={expCalc} structCalcs={structCalcs} a={a} b={b} r2={r2}/>
          </div>
        </section>

        {/* New Structures */}
        {structures.map((str,sIdx)=>{
          const calc=structCalcs[sIdx];
          const color=STR_COLORS[sIdx%STR_COLORS.length];
          const wROL=wtdROL(calc);
          const totPrem=calc.reduce((s,l)=>s+(l._prem||0),0);
          const totLim=calc.reduce((s,l)=>s+toN(l.limit),0);

          return (
            <section key={sIdx} className="bm-card" style={{borderColor:`${color}22`}}>
              <div className="bm-card-header">
                <div>
                  <div className="bm-card-title" style={{color}}>
                    Structure {sIdx+1}
                    {wROL>0&&<span className="bm-wtd-badge" style={{borderColor:`${color}45`,color}}>Wtd ROL {fmtPct2(wROL)}</span>}
                    {totPrem>0&&<span className="bm-wtd-badge" style={{borderColor:`${color}30`,color,opacity:.75}}>Premium {fmt(totPrem)}</span>}
                  </div>
                  <div className="bm-card-hint">ROL and premium auto-priced from curve · Rate = Premium / EGNPI</div>
                </div>
                <button className="bm-add-btn" style={{borderColor:`${color}40`,color}}
                  onClick={()=>addStrLayer(sIdx)} disabled={str.layers.length>=MAX_LAYERS}>
                  + Layer
                </button>
              </div>

              {/* Layer pricing table */}
              <div className="bm-table-wrap">
                <table className="bm-table">
                  <thead>
                    <tr>
                      <th>#</th><th>Limit</th><th>Attachment</th><th>Premium</th>
                      <th>Geomean</th><th>x=G/E</th>
                      <th style={{color}}>ROL % ↗</th>
                      <th style={{color}}>Premium ↗</th>
                      <th style={{color}}>Rate % ↗</th>
                      <th></th>
                    </tr>
                  </thead>
                  <tbody>
                    {calc.map((l,lIdx)=>(
                      <tr key={lIdx} className={l._rol>0?'bm-tr--active':''}>
                        <td><span className="bm-badge" style={{background:`${color}14`,borderColor:`${color}35`,color}}>L{lIdx+1}</span></td>
                        <td><NumCell value={l.limit}      onChange={v=>updateStrLayer(sIdx,lIdx,'limit',v)}      data-row={lIdx} data-col={0} onPaste={e=>strPasteHandlers[sIdx](e,lIdx,0)} /></td>
                        <td><NumCell value={l.attachment} onChange={v=>updateStrLayer(sIdx,lIdx,'attachment',v)} data-row={lIdx} data-col={1} onPaste={e=>strPasteHandlers[sIdx](e,lIdx,1)} /></td>
                        <td><NumCell value={l.egnpi}      onChange={v=>updateStrLayer(sIdx,lIdx,'egnpi',v)}      data-row={lIdx} data-col={2} onPaste={e=>strPasteHandlers[sIdx](e,lIdx,2)} /></td>
                        <td className="bm-calc bm-calc--dim">{fmt(l._gm)}</td>
                        <td className="bm-calc bm-calc--dim">{l._x>0?l._x.toFixed(4):'—'}</td>
                        <td className="bm-calc" style={{color,fontWeight:800}}>{fmtPct2(l._rol)}</td>
                        <td className="bm-calc" style={{color}}>{fmt(l._prem)}</td>
                        <td className="bm-calc" style={{color,opacity:.80}}>{fmtPct4(l._rate)}</td>
                        <td><button className="bm-del" onClick={()=>removeStrLayer(sIdx,lIdx)}>✕</button></td>
                      </tr>
                    ))}
                  </tbody>
                  {totLim>0&&(
                    <tfoot>
                      <tr className="bm-foot" style={{borderTopColor:`${color}25`}}>
                        <td>TOTAL</td>
                        <td>{fmt(totLim)}</td>
                        <td colSpan={4}></td>
                        <td style={{color,fontWeight:800}}>{fmtPct2(wROL)}</td>
                        <td style={{color,fontWeight:800}}>{fmt(totPrem)}</td>
                        <td colSpan={2}></td>
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
              {totLim>0&&(
                <div className="bm-totals-bar" style={{borderTopColor:`${color}20`}}>
                  <div className="bm-totals-item"><span className="bm-totals-label">LAYERS</span><span className="bm-totals-value">{calc.filter(l=>l._rol>0).length}</span></div>
                  <div className="bm-totals-item"><span className="bm-totals-label">TOTAL LIMIT</span><span className="bm-totals-value">{fmt(totLim)}</span></div>
                  <div className="bm-totals-item"><span className="bm-totals-label">TOTAL PREMIUM</span><span className="bm-totals-value" style={{color}}>{fmt(totPrem)}</span></div>
                  <div className="bm-totals-item bm-totals-item--hi" style={{'--hi-color':color}}><span className="bm-totals-label">WTD ROL</span><span className="bm-totals-value" style={{color}}>{fmtPct2(wROL)}</span></div>
                  <div className="bm-totals-item"><span className="bm-totals-label">TOP ATTACHMENT</span><span className="bm-totals-value">{fmt(Math.max(...calc.map(l=>toN(l.attachment)+toN(l.limit))))}</span></div>
                  <div className="bm-totals-item"><span className="bm-totals-label">PROGRAMME LIMIT</span><span className="bm-totals-value">{fmt(toN(calc[0]?.attachment)+totLim)}</span></div>
                </div>
              )}
              {selectedCobs.length>0&&(
                <div className="bm-cob-section">
                  <div className="bm-cob-section-header">
                    <div className="bm-cob-section-title">Classes of Business &amp; Layer Participation</div>
                    <div className="bm-cob-section-hint">Enter underwriting limit per class and tick which layers it participates in.</div>
                  </div>
                  <div className="bm-np-table-wrap">
                    <table className="bm-np-table">
                      <thead>
                        <tr>
                          <th className="bm-np-th--cob">CLASS OF BUSINESS</th>
                          <th className="bm-np-th--limit">UNDERWRITING LIMIT</th>
                          {str.layers.map((_,lIdx)=>(
                            <th key={lIdx} className="bm-np-th--layer">LAYER {lIdx+1}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {selectedCobs.map(cob=>{
                          const flags=str.cobToggles[cob.id]||[];
                          return (
                            <tr key={cob.id} className="bm-np-row">
                              <td className="bm-np-td--cob">{cob.name}</td>
                              <td className="bm-np-td--limit">
                                <div className="bm-np-limit-cell">
                                  <NumCell
                                    className="bm-np-limit-input"
                                    value={cob.uwLimit}
                                    onChange={v=>updateUwLimit(cob.id,v)}
                                  />
                                  <span className="bm-np-limit-suffix">
                                    {meta.countryId ? (countries.find(c=>c.id===meta.countryId)?.code||'') : ''}
                                  </span>
                                </div>
                              </td>
                              {str.layers.map((_,lIdx)=>(
                                <td key={lIdx} className="bm-np-td--check">
                                  <input
                                    type="checkbox"
                                    className="np-check"
                                    checked={!!flags[lIdx]}
                                    onChange={()=>toggleCobLayer(sIdx,cob.id,lIdx)}
                                  />
                                </td>
                              ))}
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </section>
          );
        })}

      </main>

      {/* COB Modal */}
      {showCobModal&&(
        <CobSelectModal
          selected={selectedCobs.map(c=>c.id)}
          cobList={cobList}
          onSave={handleCobSave}
          onClose={()=>setShowCobModal(false)}
        />
      )}
    </div>
  );
}
