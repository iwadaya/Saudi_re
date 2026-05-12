// src/screens/facultative/locations/FacLocations.jsx
import { useCallback, useState } from 'react';
import api from '../../../api';
import WizardLayout from '../../../components/WizardLayout';
import { useScreenSave } from '../../../hooks/useScreenSave';
import { useFacRiskId } from '../../../hooks/useContractId';

const ROUTE_KEY = 'FAC_LOCATIONS';
const numOrNull = v => { const c = String(v ?? '').replace(/,/g,'').trim(); if (!c) return null; const n = Number(c); return Number.isFinite(n) ? n : null; };
const fmtComma = v => { const d = String(v ?? '').replace(/[^\d]/g,''); return d ? Number(d).toLocaleString('en-US') : ''; };
const stripDigits = v => String(v ?? '').replace(/[^\d]/g,'');

const BLANK_LOC = () => ({ location_name:'', address:'', pd_si:'', bi_si:'', cresta_zone:'', _key: Math.random() });

export default function FacLocations() {
  const riskId = useFacRiskId();
  const [rows, setRows] = useState([BLANK_LOC()]);

  const hydrate = useCallback((data) => {
    if (data?.length) setRows(data.map(r => ({ ...r, _key: r.location_id || Math.random() })));
    else setRows([BLANK_LOC()]);
  }, []);

  const saveLocations = useCallback(
    (id, state) => api.facSaveLocations(id, state.filter(r => r.location_name || numOrNull(r.pd_si) || numOrNull(r.bi_si)).map(r => ({
      location_name: r.location_name, address: r.address,
      pd_si: numOrNull(r.pd_si), bi_si: numOrNull(r.bi_si), cresta_zone: r.cresta_zone,
    }))),
    [],
  );

  const { save, markDirty } = useScreenSave({
    entityId: riskId || '',
    load: api.facGetLocations,
    save: saveLocations,
    currentState: () => rows,
    onLoaded: hydrate,
    errorLabel: 'Locations',
  });

  const setRow = (i, key, val) => {
    setRows(prev => prev.map((r, j) => j === i ? { ...r, [key]: val } : r));
    markDirty();
  };

  const addRow = () => { setRows(prev => [...prev, BLANK_LOC()]); markDirty(); };
  const removeRow = i => { setRows(prev => prev.filter((_, j) => j !== i)); markDirty(); };

  const totalPD = rows.reduce((s, r) => s + (numOrNull(r.pd_si) || 0), 0);
  const totalBI = rows.reduce((s, r) => s + (numOrNull(r.bi_si) || 0), 0);

  return (
    <WizardLayout routeKey={ROUTE_KEY} title="Locations & SI" headerPill="FACULTATIVE" onBeforeNext={save} onBeforeBack={save}>
      <div style={{ maxWidth: 900, margin: '0 auto', padding: '8px 0 40px' }}>
        <div style={{ fontSize: 12, color: 'rgba(148,163,184,0.55)', marginBottom: 16 }}>
          Break down the total sum insured by location. Each site's Physical Damage and Business Interruption values should be entered separately.
        </div>

        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
          <thead>
            <tr style={{ background: 'rgba(5,8,16,0.6)' }}>
              {['#', 'Location Name', 'Address', 'PD SI', 'BI SI', 'Total SI', 'CRESTA', ''].map(h => (
                <th key={h} style={{ padding: '8px 10px', textAlign: h === 'PD SI' || h === 'BI SI' || h === 'Total SI' ? 'right' : 'left', fontSize: 9, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.50)', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>{h}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const total = (numOrNull(r.pd_si) || 0) + (numOrNull(r.bi_si) || 0);
              return (
                <tr key={r._key} style={{ borderBottom: '1px solid rgba(255,255,255,0.05)' }}>
                  <td style={{ padding: '6px 10px', color: 'rgba(148,163,184,0.40)', width: 30 }}>{i + 1}</td>
                  <td style={{ padding: '4px 4px' }}><input className="fi" value={r.location_name || ''} onChange={e => setRow(i, 'location_name', e.target.value)} placeholder="Site name" style={{ fontSize: 12 }} /></td>
                  <td style={{ padding: '4px 4px' }}><input className="fi" value={r.address || ''} onChange={e => setRow(i, 'address', e.target.value)} placeholder="Address" style={{ fontSize: 12 }} /></td>
                  <td style={{ padding: '4px 4px', width: 130 }}><input className="fi" type="text" inputMode="numeric" value={fmtComma(r.pd_si)} onChange={e => setRow(i, 'pd_si', stripDigits(e.target.value))} style={{ textAlign: 'right', fontSize: 12 }} /></td>
                  <td style={{ padding: '4px 4px', width: 130 }}><input className="fi" type="text" inputMode="numeric" value={fmtComma(r.bi_si)} onChange={e => setRow(i, 'bi_si', stripDigits(e.target.value))} style={{ textAlign: 'right', fontSize: 12 }} /></td>
                  <td style={{ padding: '6px 10px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: 'rgba(226,232,240,0.70)', width: 130 }}>{total ? total.toLocaleString('en-US') : '—'}</td>
                  <td style={{ padding: '4px 4px', width: 90 }}><input className="fi" value={r.cresta_zone || ''} onChange={e => setRow(i, 'cresta_zone', e.target.value)} placeholder="Zone" style={{ fontSize: 12 }} /></td>
                  <td style={{ padding: '4px 4px', width: 30 }}>
                    {rows.length > 1 && <span style={{ cursor: 'pointer', color: '#f87171', fontSize: 16 }} onClick={() => removeRow(i)}>×</span>}
                  </td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr style={{ borderTop: '2px solid rgba(0,212,255,0.20)' }}>
              <td colSpan={3} style={{ padding: '8px 10px', fontSize: 11, fontWeight: 700, color: 'rgba(0,212,255,0.60)' }}>TOTAL</td>
              <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700, color: '#00d4ff', fontSize: 12 }}>{totalPD ? totalPD.toLocaleString('en-US') : '—'}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 700, color: '#00d4ff', fontSize: 12 }}>{totalBI ? totalBI.toLocaleString('en-US') : '—'}</td>
              <td style={{ padding: '8px 10px', textAlign: 'right', fontWeight: 900, color: '#23d18b', fontSize: 12 }}>{(totalPD + totalBI) ? (totalPD + totalBI).toLocaleString('en-US') : '—'}</td>
              <td colSpan={2}></td>
            </tr>
          </tfoot>
        </table>

        <button onClick={addRow} style={{ marginTop: 12, appearance: 'none', border: '1px dashed rgba(35,209,139,0.30)', background: 'rgba(35,209,139,0.05)', color: '#23d18b', borderRadius: 8, padding: '8px 16px', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>+ Add Location</button>
      </div>
    </WizardLayout>
  );
}
