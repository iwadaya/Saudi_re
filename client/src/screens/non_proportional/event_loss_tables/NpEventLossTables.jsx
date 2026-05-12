import { useState, useEffect, useCallback } from 'react';
import { api } from '../../../api';
import { useContractId } from '../../../hooks/useContractId';
import WizardLayout from '../../../components/WizardLayout';
import { useAppState } from '../../../context/AppContext';

const ROUTE_KEY = 'NP_EVENT_LOSS_TABLES';
const COLS = ['eventId','peril','region','returnPeriod','grossLoss','netQs','netXl','ultimateNetLoss','comment'];
const HEADERS = ['Event ID','Peril','Region / CRESTA','Return Period (yrs)','Gross Loss','Net of QS','Net of XL','Ultimate Net Loss','Comment'];

function defaultRows() {
  return [1,2,3,4].map(i=>({eventId:`EVT-${10000+i}`,peril:'EQ',region:`CRESTA 0${i} / Region`,returnPeriod:String([250,100,50,20][(i-1)%4]),grossLoss:'0',netQs:'0',netXl:'0',ultimateNetLoss:'0',comment:'Top driver...'}));
}

export default function NpEventLossTables() {
  const contractId = useContractId();
  const { state: appState } = useAppState();
  const quoteMode = !!appState.quoteMode;
  const [vendor, setVendor] = useState('');
  const [modelVersion, setModelVersion] = useState('');
  const [perilSet, setPerilSet] = useState('');
  const [rows, setRows] = useState(defaultRows);
  const [dirty, setDirty] = useState(false);
  const [saveMsg, setSaveMsg] = useState(null);

  useEffect(() => {
    if (!contractId) return;
    (async () => {
      try {
        const data = await api.getNonPropTreaty(contractId, quoteMode ? { quote: true } : undefined);
        const evt = data?.terms?.event_loss_tables || data?.terms?.eventLossTables;
        if (evt) { setVendor(evt.vendor||''); setModelVersion(evt.modelVersion||''); setPerilSet(evt.perilSet||'');
          if (Array.isArray(evt.rows) && evt.rows.length) setRows(evt.rows); }
      } catch {}
    })();
  }, [contractId, quoteMode]);

  const updateRow = (i,c,v) => { setRows(p=>{const n=[...p];n[i]={...n[i],[c]:v};return n;}); setDirty(true); };

  const save = useCallback(async (quiet=false) => {
    if (!contractId) return true;
    const valid = rows.filter(r=>COLS.some(c=>String(r[c]||'').trim()));
    try { await api.saveNonPropTreaty(contractId, { terms: { event_loss_tables: { vendor, modelVersion, perilSet, rows: valid, updatedAt: new Date().toISOString() } } }, quoteMode ? { quote: true } : undefined);
      setDirty(false); if (!quiet) { setSaveMsg({ type: 'ok', text: 'Saved' }); setTimeout(() => setSaveMsg(null), 2000); } return true; }
    catch (e) { console.error(e); setSaveMsg({ type: 'err', text: 'Save failed' }); setTimeout(() => setSaveMsg(null), 3000); return false; }
  }, [contractId, vendor, modelVersion, perilSet, rows, quoteMode]);

  return (
    <WizardLayout routeKey={ROUTE_KEY} title="Event Loss Tables" headerPill={`${quoteMode ? "NP-QUOTE TREATY" : "NON-PROPORTIONAL TREATY"}: EVENT LOSS TABLES`}
      onBeforeNext={()=>save(true)} onBeforeBack={()=>save(true)}>
      {() => (<div className="EVENT_LOSS_TABLES_PAGE NP_EVENT_LOSS_TABLES_PAGE">
        <div className="elt-shell">
          <h2 className="elt-title">Event Loss Capture – Vendor Models</h2>
          <div className="elt-sub">Capture and review event loss tables from catastrophe vendor models (e.g. AIR, RMS) for this treaty.</div>
          <div className="elt-filter">
            <div className="elt-field"><div className="elt-label">Vendor</div>
              <select className="elt-select" value={vendor} onChange={e=>{setVendor(e.target.value);setDirty(true);}}>
                <option value="">Select vendor...</option><option value="AIR">AIR</option><option value="RMS">RMS</option></select></div>
            <div className="elt-field"><div className="elt-label">Model / Version</div>
              <input className="elt-input" placeholder="e.g. AIR Touchstone v2024.1" value={modelVersion} onChange={e=>{setModelVersion(e.target.value);setDirty(true);}}/></div>
            <div className="elt-field"><div className="elt-label">Peril Set / Layer Name</div>
              <input className="elt-input" placeholder="e.g. EQ All CRESTA – Layer" value={perilSet} onChange={e=>{setPerilSet(e.target.value);setDirty(true);}}/></div>
            <div className="elt-actions">
              <button className="elt-btn elt-btn--danger" onClick={()=>{setRows(defaultRows());setDirty(true);}}>Clear Events</button>
              {saveMsg && <span style={{ fontSize:11, padding:'4px 10px', borderRadius:6, background: saveMsg.type==='ok' ? 'rgba(74,222,128,0.12)' : 'rgba(248,113,113,0.12)', color: saveMsg.type==='ok' ? '#4ade80' : '#f87171', border: `1px solid ${saveMsg.type==='ok' ? 'rgba(74,222,128,0.3)' : 'rgba(248,113,113,0.3)'}` }}>{saveMsg.text}</span>}
              <button className="elt-btn elt-btn--primary" onClick={()=>save(false)}>Save Event Set</button></div>
          </div>
          <div className="elt-table-wrap"><div className="elt-table-label">Event losses by vendor event ID</div>
            <table className="elt-table"><thead><tr>{HEADERS.map(h=><th key={h}>{h}</th>)}</tr></thead><tbody>
              {rows.map((r,i)=><tr key={i}>{COLS.map(c=><td key={c}><input className="elt-cell" value={r[c]||''} onChange={e=>updateRow(i,c,e.target.value)}/></td>)}</tr>)}
            </tbody></table></div>
          {dirty && <div className="muted" style={{marginTop:8}}>Unsaved changes</div>}
        </div>
      </div>)}
    </WizardLayout>
  );
}
