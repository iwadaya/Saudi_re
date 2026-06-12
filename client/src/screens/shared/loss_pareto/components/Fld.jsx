// loss_pareto/components/Fld.jsx — commit-on-blur/Enter numeric field of
// the Parameters card. Moved verbatim from LossParetoScreen.jsx
// (Phase 4.2). The local useState is the input draft buffer, not screen
// state — it stays out of the reducer on purpose.

import { useState, useEffect } from 'react';

export default function Fld({label,help,value,onCommit}){
  const [local,setLocal]=useState(value);
  useEffect(()=>{setLocal(value);},[value]);
  return(
    <div className="llp-field">
      <div className="llp-label">{label}</div>
      <input className="llp-input numeric" value={local} onChange={e=>setLocal(e.target.value)} onBlur={()=>onCommit(local)} onKeyDown={e=>{if(e.key==='Enter')onCommit(local);}}/>
      {help&&<div className="llp-help">{help}</div>}
    </div>
  );
}
