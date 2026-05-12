import { SHARE_COLS, SHARE_COL_COLORS, parsePct, fmt, cn } from './propPricingConstants.js';
import PctInput from '../../../../components/PctInput';
import { formatWithCommas, sanitizeNumber } from '../../../../utils/format.js';

/*
  PropShareScenarios — share participation scenarios table + COB agg breakdown modal.

  Props:
    shareRows, setShareRows
    shareGrid, setShareGrid
    contractAgg100, otherCountryAgg
    currency, displayCcy, toDisplay
    contractId
    setDirty
*/
export default function PropShareScenarios({
  shareRows, setShareRows, shareGrid, setShareGrid,
  contractAgg100, otherCountryAgg,
  toDisplay, setDirty,
  onShowAggBreakdown,
  onShowAggDrilldown,
}) {
  return (
    <div className="bbg-block">
      <div className="bbg-block-head">
        <div>
          <div className="bbg-block-title">Share Participation Scenarios</div>
        </div>
        <div style={{ display:'flex', gap:6 }}>
          <button className="bbg-btn" onClick={onShowAggBreakdown}
            style={{flexShrink:0,borderColor:'rgba(251,191,36,0.45)',color:'#fbbf24',fontSize:11,padding:'5px 12px',whiteSpace:'nowrap'}}>
            ◈ COB Agg Breakdown
          </button>
          <button className="bbg-btn" onClick={onShowAggDrilldown}
            style={{flexShrink:0,borderColor:'rgba(96,165,250,0.45)',color:'#60a5fa',fontSize:11,padding:'5px 12px',whiteSpace:'nowrap'}}>
            ⬡ Aggregate Analysis
          </button>
        </div>
      </div>
      <div className="bbg-table-wrap"><table className="bbg-table">
        <thead><tr>
          <th className="bbg-th bbg-th--label">Share %</th>
          {SHARE_COLS.map(c=>{
            const tok=SHARE_COL_COLORS[c.color]||{};
            const tip=c.key==='agg_contrib'
              ? "Share % × this contract's total property aggregate (sum of all CRESTA zones)"
              : c.key==='country_agg'
              ? "All other contracts in this country + Agg Contribution at this share"
              : undefined;
            return (
              <th key={c.key} className="bbg-th bbg-th--c" title={tip}
                style={{color:tok.th||'rgba(226,232,240,0.72)',boxShadow:`inset 0 -2px 0 ${tok.border||'transparent'}`,
                  ...(tip?{cursor:'help'}:{})}}>
                {c.label}{tip?<span style={{fontSize:9,marginLeft:4,opacity:0.5}}>⊕</span>:null}
              </th>
            );
          })}
        </tr></thead>
        <tbody>{shareRows.map((label,i)=>{
          const is100=label.includes('100');
          return (
            <tr key={i} className={is100?'bbg-row--calc':''}>
              <td className="bbg-td bbg-td--label">
                {is100
                  ? <span className="bbg-inp bbg-inp--share" style={{display:'flex',alignItems:'center',justifyContent:'center',fontWeight:700,cursor:'default',userSelect:'none',opacity:.75}}>100%</span>
                  // shareRows entries are row LABELS, not bare numeric values:
                  // they double as keys into shareGrid, are persisted as
                  // share_label, and surface in the Excel export ("Programme
                  // Limits" sheet). The "%" suffix is intentional — kept on
                  // blur so the stored format matches the "100%" sentinel
                  // row and round-trips cleanly with saved data.
                  : <PctInput className="bbg-inp bbg-inp--share" value={label}
                      onChange={v => {
                        const r = [...shareRows]; r[i] = v; setShareRows(r); setDirty(true);
                      }}
                      onBlur={() => {
                        const raw = String(shareRows[i] ?? '').replace(/%/g, '').trim();
                        const n = parseFloat(raw);
                        if (Number.isFinite(n)) {
                          const clamped = Math.min(99, Math.max(0, n));
                          const r = [...shareRows]; r[i] = clamped + '%'; setShareRows(r);
                        }
                      }}
                      placeholder="e.g. 5%" />
                }
              </td>
              {SHARE_COLS.map(c=>{
                const pct=parsePct(label);
                const master=shareGrid['100%']?.[c.key];
                let val;
                if(is100) {
                  if(c.key==='agg_contrib') val=contractAgg100!=null?fmt(Math.round(toDisplay(contractAgg100))):(shareGrid[label]?.[c.key]||'');
                  else if(c.key==='country_agg') {
                    if(contractAgg100!=null&&otherCountryAgg!=null) val=fmt(Math.round(toDisplay(otherCountryAgg+contractAgg100)));
                    else val=shareGrid[label]?.[c.key]||'';
                  } else val=shareGrid[label]?.[c.key]||'';
                } else {
                  if(c.key==='agg_contrib') val=contractAgg100!=null?fmt(Math.round(toDisplay(contractAgg100*pct))):'';
                  else if(c.key==='country_agg') {
                    if(contractAgg100!=null&&otherCountryAgg!=null) val=fmt(Math.round(toDisplay(otherCountryAgg+contractAgg100*pct)));
                    else val=master?fmt(Math.round(toDisplay(cn(master)))):'';
                  } else val=master?fmt(Math.round(toDisplay(cn(master)*pct))):'';
                }
                const isDownside=c.key==='downside_amt'||c.key==='shortfall_amt';
                const isComputedAgg=c.key==='agg_contrib'||c.key==='country_agg';
                const tok=SHARE_COL_COLORS[c.color]||{};
                return (
                  <td key={c.key} className={`bbg-td ${isDownside?'bbg-td--downside':''}`}
                    style={{background:tok.cell,borderBottom:'1px solid rgba(148,163,184,0.06)'}}>
                    {is100&&!isComputedAgg ? (
                      <input className={`bbg-inp ${isDownside?'bbg-inp--downside':''}`}
                        value={formatWithCommas(shareGrid[label]?.[c.key])||''} placeholder="0"
                        style={{borderColor:tok.border,color:tok.val}}
                        onChange={e=>{setShareGrid(prev=>({...prev,[label]:{...(prev[label]||{}),[c.key]:sanitizeNumber(e.target.value)}}));setDirty(true);}}/>
                    ) : (
                      <span className={`bbg-ro-val ${isDownside?'bbg-ro-val--downside':''}`}
                        style={!isDownside?{color:tok.val,fontWeight:600}:{}}>{val||'—'}</span>
                    )}
                  </td>
                );
              })}
            </tr>
          );
        })}</tbody>
      </table></div>
    </div>
  );
}
