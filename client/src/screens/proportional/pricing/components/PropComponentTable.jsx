import { COMPONENT_ROWS, fmtPct } from './propPricingConstants.js';
import { formatDate } from '../../../../utils/format.js';

/*
  PropComponentTable

  Props:
    components        – {[row]: {actuarial, actual, exposure, market, uw, downside, comment}}
    getC              – fn(row, col) => string
    setC              – fn(row, col, val)
    calcResult        – fn(col) => number
    calcMaxComm       – fn(col) => number
    snapshots         – array
    snapLabel         – string
    setSnapLabel      – fn
    showSnapHistory   – bool
    setShowSnapHistory– fn
    dirty             – bool
    saveMsg           – {type, text} | null
    isReadOnly        – bool
    onSave            – fn
    onSaveSnapshot    – fn(label)
    onDeleteSnapshot  – fn(snapId)
    onShowQuickSummary– fn
*/
export default function PropComponentTable({
  getC, setC, calcResult, calcMaxComm,
  snapshots, snapLabel, setSnapLabel, showSnapHistory, setShowSnapHistory,
  dirty, saveMsg, isReadOnly,
  onSave, onSaveSnapshot, onDeleteSnapshot, onShowQuickSummary, onShowInDepth,
}) {
  const roCol = col => col==='actuarial'||col==='actual'||col==='market'||col==='downside';

  return (
    <div className="bbg-block">
      <div className="bbg-block-head">
        <div className="bbg-block-title">Component Pricing Comparison</div>
        <div className="bbg-block-right" style={{display:'flex',gap:8,alignItems:'center'}}>
          <button className="bbg-btn bbg-btn--outline" onClick={onShowQuickSummary}>📊 Quick Summary</button>
          <button className="bbg-btn bbg-btn--outline" onClick={onShowInDepth} style={{borderColor:'rgba(96,165,250,0.4)',color:'#60a5fa'}}>🔬 In-Depth Analysis</button>
          <button className="bbg-btn bbg-btn--outline" onClick={()=>setShowSnapHistory(!showSnapHistory)}>📋 History ({snapshots.length})</button>
          {saveMsg && <span className={`bbg-msg bbg-msg--${saveMsg.type}`}>{saveMsg.text}</span>}
          {!isReadOnly && <button className={`bbg-btn bbg-btn--save ${dirty?'bbg-btn--dirty':''}`} onClick={onSave}>💾 Save</button>}
        </div>
      </div>

      <div className="bbg-table-wrap"><table className="bbg-table">
        <thead><tr>
          <th className="bbg-th bbg-th--label">Component</th>
          <th className="bbg-th bbg-th--c">Actuarial (Engine)</th>
          <th className="bbg-th bbg-th--c">Actual Stats</th>
          <th className="bbg-th bbg-th--c">Market Avg</th>
          <th className="bbg-th bbg-th--c">UW Override</th>
          <th className="bbg-th bbg-th--c">Max Downside</th>
          <th className="bbg-th">Comment</th>
        </tr></thead>
        <tbody>{COMPONENT_ROWS.map(name => {
          const isCalc = name==='Result'||name.includes('Maximum');
          return (
            <tr key={name} className={isCalc?'bbg-row--calc':''}>
              <td className="bbg-td bbg-td--label">{name}</td>
              {['actuarial','actual','market','uw','downside'].map(col=>(
                <td key={col} className="bbg-td">
                  {isCalc ? (
                    <span className={`bbg-calc-val ${name==='Result'?(calcResult(col)>=0.05?'bbg-calc-val--pos':calcResult(col)>=0?'bbg-calc-val--warn':'bbg-calc-val--neg'):''}`}>
                      {name==='Result'?fmtPct(calcResult(col)):fmtPct(calcMaxComm(col))}
                    </span>
                  ) : (
                    <input className={`bbg-inp ${roCol(col)||isReadOnly?'bbg-inp--ro':''}`}
                      value={getC(name,col)} placeholder={col==='uw'?'Override':''} readOnly={roCol(col)||isReadOnly}
                      onChange={e=>{if(!isReadOnly) setC(name,col,e.target.value);}}/>
                  )}
                </td>
              ))}
              <td className="bbg-td">
                <input className="bbg-inp bbg-inp--comment" value={getC(name,'comment')}
                  onChange={e=>setC(name,'comment',e.target.value)} placeholder="Note…"/>
              </td>
            </tr>
          );
        })}</tbody>
      </table></div>

      {/* Snapshot bar */}
      <div className="bbg-snap-bar">
        <input className="bbg-inp" style={{maxWidth:260}} value={snapLabel}
          onChange={e=>setSnapLabel(e.target.value)} placeholder="Snapshot label (e.g. Initial pricing)"/>
        <button className="bbg-btn bbg-btn--outline"
          onClick={()=>onSaveSnapshot(snapLabel)}>📸 Save Snapshot</button>
      </div>

      {/* Snapshot history */}
      {showSnapHistory && snapshots.length>0 && (
        <div className="bbg-snap-history">
          <div className="bbg-snap-history-title">Component Pricing History</div>
          <div className="bbg-table-wrap"><table className="bbg-table bbg-table--snap">
            <thead><tr>
              <th className="bbg-th bbg-th--label">Date</th>
              <th className="bbg-th bbg-th--label">Label</th>
              {COMPONENT_ROWS.filter(n=>n!=='Result'&&!n.includes('Maximum')).map(name=>(
                <th key={name} className="bbg-th bbg-th--c" style={{fontSize:10}}>
                  {name.replace('Attritional Loss Ratio','Att LR').replace('Large Loss Loading','LL Load').replace('Cat Loss Loading','Cat Load')}
                </th>
              ))}
              <th className="bbg-th bbg-th--c" style={{fontSize:10}}>Result</th>
              <th className="bbg-th" style={{width:40}}></th>
            </tr></thead>
            <tbody>{snapshots.map(snap=>{
              const c=typeof snap.components==='string'?JSON.parse(snap.components):snap.components;
              return (
                <tr key={snap.id}>
                  <td className="bbg-td" style={{fontSize:11,whiteSpace:'nowrap'}}>{formatDate(snap.snapshot_date)}</td>
                  <td className="bbg-td" style={{fontSize:11}}>{snap.snapshot_label||'—'}</td>
                  {COMPONENT_ROWS.filter(n=>n!=='Result'&&!n.includes('Maximum')).map(name=>(
                    <td key={name} className="bbg-td" style={{fontSize:11,textAlign:'center'}}>{c[name]?.uw||c[name]?.actuarial||'—'}</td>
                  ))}
                  <td className="bbg-td" style={{fontSize:11,textAlign:'center',fontWeight:700}}>{c['Result']?.uw||c['Result']?.actuarial||'—'}</td>
                  <td className="bbg-td">
                    <button className="bbg-btn-x" onClick={()=>onDeleteSnapshot(snap.id)}>×</button>
                  </td>
                </tr>
              );
            })}</tbody>
          </table></div>
        </div>
      )}
    </div>
  );
}
