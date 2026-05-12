import { useState, useEffect, useCallback } from 'react';
import { api } from '../../../api';
import { useContractId } from '../../../hooks/useContractId';
import { useGlobalToast } from '../../../hooks/useToast';
import WizardLayout from '../../../components/WizardLayout';
import { handleStaleWrite } from '../../../utils/handleStaleWrite';

const ROUTE_KEY = 'PROP_EVENT_LOSS_TABLES';
const COLS = ['eventId','peril','region','returnPeriod','grossLoss','netQs','netXl','ultimateNetLoss','comment'];
const HEADERS = ['Event ID','Peril','Region / CRESTA','Return Period (yrs)','Gross Loss','Net of QS','Net of XL','Ultimate Net Loss','Comment'];

function defaultRows() {
  return [1,2,3,4].map(i => ({ eventId:`EVT-${10000+i}`, peril:'EQ', region:`CRESTA 0${i} / Region`, returnPeriod:String([250,100,50,20][(i-1)%4]), grossLoss:'0', netQs:'0', netXl:'0', ultimateNetLoss:'0', comment:'Top driver...' }));
}

export default function PropEventLossTables() {
  const contractId = useContractId();
  const showToast = useGlobalToast();
  const [vendor, setVendor] = useState('');
  const [modelVersion, setModelVersion] = useState('');
  const [perilSet, setPerilSet] = useState('');
  const [rows, setRows] = useState(defaultRows);
  const [dirty, setDirty] = useState(false);
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);

  useEffect(() => {
    if (!contractId) return;
    (async () => {
      try {
        const data = await api.getContract(contractId);
        const evt = data?.terms?.event_loss_tables || data?.terms?.eventLossTables;
        if (evt) {
          setVendor(evt.vendor || '');
          setModelVersion(evt.modelVersion || '');
          setPerilSet(evt.perilSet || '');
          if (Array.isArray(evt.rows) && evt.rows.length) setRows(evt.rows);
        }
        setLastUpdatedAt(data?.updated_at || data?.updatedAt || null);
      } catch {}
    })();
  }, [contractId]);

  const updateRow = (idx, col, val) => { setRows(prev => { const n = [...prev]; n[idx] = { ...n[idx], [col]: val }; return n; }); setDirty(true); };

  const save = useCallback(async (quiet = false) => {
    if (!contractId) return true;
    const valid = rows.filter(r => COLS.some(c => String(r[c] || '').trim()));
    const payload = { terms: { event_loss_tables: { vendor, modelVersion, perilSet, rows: valid, updatedAt: new Date().toISOString() } } };
    const saveOnce = async (ifUnmodifiedSince = lastUpdatedAt) => {
      const res = await api.saveContract(contractId, payload, ifUnmodifiedSince ? { ifUnmodifiedSince } : undefined);
      if (res?.updated_at) setLastUpdatedAt(res.updated_at);
      return res;
    };
    try {
      await saveOnce();
      setDirty(false);
      if (!quiet) showToast('Saved Event Set.');
      return true;
    } catch (e) {
      const stale = await handleStaleWrite(e, {
        entityType: 'treaty',
        onRefresh: () => window.location.reload(),
        onOverwrite: () => saveOnce('*'),
      });
      if (stale.handled) {
        if (stale.action === 'overwrite') {
          setDirty(false);
          if (!quiet) showToast('Saved Event Set.');
          return true;
        }
        return false;
      }
      console.error(e); if (!quiet) showToast('Save failed.'); return false;
    }
  }, [contractId, rows, vendor, modelVersion, perilSet, lastUpdatedAt, showToast]);

  return (
    <WizardLayout routeKey={ROUTE_KEY} title="Event Loss Tables" headerPill="PROPORTIONAL TREATY: EVENT LOSS TABLES"
      onBeforeNext={() => save(true)} onBeforeBack={() => save(true)}>
      {() => (<div className="EVENT_LOSS_TABLES_PAGE">
        <div className="elt-shell">
          <h2 className="elt-title">Event Loss Capture – Vendor Models</h2>
          <div className="elt-sub">Capture and review event loss tables from catastrophe vendor models (e.g. AIR, RMS) for this treaty.</div>
          <div className="elt-filter">
            <div className="elt-field"><div className="elt-label">Vendor</div>
              <select className="elt-select" value={vendor} onChange={e => { setVendor(e.target.value); setDirty(true); }}>
                <option value="">Select vendor...</option><option value="AIR">AIR</option><option value="RMS">RMS</option>
              </select></div>
            <div className="elt-field"><div className="elt-label">Model / Version</div>
              <input className="elt-input" placeholder="e.g. AIR Touchstone v2024.1" value={modelVersion} onChange={e => { setModelVersion(e.target.value); setDirty(true); }} /></div>
            <div className="elt-field"><div className="elt-label">Peril Set / Layer Name</div>
              <input className="elt-input" placeholder="e.g. EQ All CRESTA – Layer" value={perilSet} onChange={e => { setPerilSet(e.target.value); setDirty(true); }} /></div>
            <div className="elt-actions">
              <button className="elt-btn elt-btn--danger" onClick={() => { setRows(defaultRows()); setDirty(true); }}>Clear Events</button>
              <button className="elt-btn elt-btn--primary" onClick={() => save(false)}>Save Event Set</button>
            </div>
          </div>
          <div className="elt-table-wrap"><div className="elt-table-label">Event losses by vendor event ID</div>
            <table className="elt-table"><thead><tr>{HEADERS.map(h => <th key={h}>{h}</th>)}</tr></thead><tbody>
              {rows.map((r, i) => <tr key={i}>{COLS.map(c => <td key={c}><input className="elt-cell" value={r[c] || ''} onChange={e => updateRow(i, c, e.target.value)} /></td>)}</tr>)}
            </tbody></table>
          </div>
          {dirty && <div className="muted" style={{ marginTop: 8 }}>Unsaved changes</div>}
        </div>
      </div>)}
    </WizardLayout>
  );
}
