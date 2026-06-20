// src/screens/non_proportional/expiring_structure/CoveredProportionalSection.jsx
// The covered-proportional (QS/Surplus inuring) sub-section of the NP expiring
// structure screen, extracted to keep that screen under the 800-line budget.
// No behaviour change — a straight move; props unchanged.
import React from 'react';
import { api } from '../../../api';
import PctInput from '../../../components/PctInput';
import { formatWithCommas, sanitizeNumber } from '../../../utils/format';

export default function CoveredProportionalSection({ coveredProps, setCoveredProps, onDirty, currency, cedantId, countryId }) {
  const [mode, setMode] = React.useState(''); // '' | 'db' | 'manual'
  const [dbProgrammes, setDbProgrammes] = React.useState([]);
  const [dbLoading, setDbLoading] = React.useState(false);
  const [filterCountry, setFilterCountry] = React.useState('');
  const [filterCedant, setFilterCedant]   = React.useState('');
  const [countries, setCountries]         = React.useState([]);
  const [cedants,   setCedants]           = React.useState([]);
  const initialCoveredPropsLength = React.useRef(coveredProps.length);
  const setCoveredPropsOnMount = React.useRef(setCoveredProps);

  // Load filter options on mount
  React.useEffect(() => {
    api.getRefListItems('country').then(rows => setCountries(Array.isArray(rows) ? rows : [])).catch(() => {});
    api.getRefListItems('company').then(rows => setCedants(Array.isArray(rows) ? rows : [])).catch(() => {});
  }, []);

  // Default filter to current treaty's cedant/country
  React.useEffect(() => {
    if (cedantId && !filterCedant) setFilterCedant(String(cedantId));
    if (countryId && !filterCountry) setFilterCountry(String(countryId));
  }, [cedantId, countryId, filterCedant, filterCountry]);

  // Ensure at least 1 row always exists (runs once on mount)
  // run-once on mount: intentional
  React.useEffect(() => {
    if (initialCoveredPropsLength.current === 0) {
      setCoveredPropsOnMount.current([{ programme: '', qsLimit: '', retentionPct: '', surplusLines: '' }]);
    }
  }, []);

  // Load PROP contracts from DB whenever db mode is active and filters change
  React.useEffect(() => {
    if (mode !== 'db') return;
    setDbLoading(true);
    const params = { category: 'PROPORTIONAL' };
    if (filterCedant)  params.cedant_id  = filterCedant;
    if (filterCountry) params.country_id = filterCountry;
    api.listContracts(params)
      .then(rows => {
        const arr = Array.isArray(rows) ? rows : (rows?.rows || []);
        const prop = arr.filter(r => !r.has_np_details &&
          String(r.treaty_category || r.category || '').toUpperCase().includes('PROP'));
        setDbProgrammes(prop);
      })
      .catch(() => setDbProgrammes([]))
      .finally(() => setDbLoading(false));
  }, [mode, filterCedant, filterCountry]);

  const fmtC = v => formatWithCommas(v);

  // Computed row values
  const rows = coveredProps.map(r => {
    const qs      = parseFloat(String(r.qsLimit || '').replace(/,/g, '')) || 0;
    const retPct  = parseFloat(String(r.retentionPct || '').replace(/%/g, '')) || 0;
    const retAmt  = qs > 0 && retPct > 0 ? Math.round(qs * retPct / 100) : 0;
    const surplus = parseFloat(String(r.surplusLines || '').replace(/[^0-9.]/g, '')) || 0;
    const totalCap = qs + (surplus > 0 ? qs * surplus : 0);
    return { ...r, retentionAmount: retAmt, totalCapacity: totalCap };
  });

  const updateRow = (i, field, value) => {
    setCoveredProps(prev => { const n = [...prev]; n[i] = { ...n[i], [field]: value }; return n; });
    onDirty();
  };

  const addRow = () => {
    setCoveredProps(prev => [...prev, { programme: '', qsLimit: '', retentionPct: '', surplusLines: '' }]);
    onDirty();
  };

  const removeRow = i => {
    setCoveredProps(prev => prev.filter((_, idx) => idx !== i));
    onDirty();
  };

  // Build a row from a DB programme record
  const makeRowFromProg = (prog) => {
    const label = [prog.treaty_type_name, prog.cedant_name].filter(Boolean).join(' — ') || prog.contract_description || (prog.id||'').slice(-6) || '—';
    // Determine QS limit: for Quota Share use qs_limit; for Surplus use total_capacity or qs_limit
    const isSurplus = String(prog.treaty_type_name||'').toLowerCase().includes('surplus');
    const qsLimitVal  = String(prog.qs_limit || '');
    const retPctVal   = String(prog.retention_pct || '');
    const surplusLinesVal = String(prog.num_lines || '');
    const totalCap    = String(prog.total_capacity || '');
    return {
      programme:    label,
      qsLimit:      qsLimitVal,
      retentionPct: retPctVal,
      surplusLines: surplusLinesVal,
      totalCapacityOverride: isSurplus && totalCap ? totalCap : '',
      contractId:   prog.id || prog.contract_id,
    };
  };

  // Load selected DB programme into a row
  const importFromDb = (prog) => {
    const newRow = makeRowFromProg(prog);
    setCoveredProps(prev => {
      // Replace first empty row or append
      const idx = prev.findIndex(r => !r.programme && !r.qsLimit);
      if (idx >= 0) { const n = [...prev]; n[idx] = newRow; return n; }
      return [...prev, newRow];
    });
    onDirty();
  };

  return (
    <section className="np-struct-card glass">
      <div className="np-struct-card-header np-struct-card-header--plain" style={{ flexWrap: 'wrap', gap: 10 }}>
        <div style={{ flex: 1 }}>
          <div className="np-struct-card-h2">Proportional Structure Covered</div>
          <div className="np-struct-card-hint">If Net XL basis, summarise the underlying proportional programmes covered here.</div>
        </div>
        {/* Mode selector */}
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            className={`np-type-pill${mode === 'db' ? ' is-on' : ' is-off'}`}
            onClick={() => setMode(m => m === 'db' ? '' : 'db')}
            type="button"
            title="Select programme from database">
            ⬇ From Database
          </button>
          <button
            className={`np-type-pill${mode === 'manual' ? ' is-on' : ' is-off'}`}
            onClick={() => setMode(m => m === 'manual' ? '' : 'manual')}
            type="button"
            title="Enter manually">
            ✎ Manual Entry
          </button>
        </div>
      </div>

      {/* DB picker panel */}
      {mode === 'db' && (
        <div style={{ padding: '16px 18px', borderBottom: '1px solid rgba(255,255,255,0.08)', background: 'rgba(0,212,255,0.03)' }}>
          {/* Filter bar */}
          <div style={{ display: 'flex', gap: 16, alignItems: 'center', marginBottom: 16, flexWrap: 'wrap' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto' }}>
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.08em', color: 'rgba(255,255,255,0.45)', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>Country</span>
              <select className="np-mini-input np-mini-select" style={{ width: 180, textAlign: 'left' }}
                value={filterCountry} onChange={e => setFilterCountry(e.target.value)}>
                <option value="">All Countries</option>
                {countries.map(c => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
              </select>
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flex: '0 0 auto' }}>
              <span style={{ fontSize: 11, fontWeight: 700, letterSpacing: '.08em', color: 'rgba(255,255,255,0.45)', textTransform: 'uppercase', whiteSpace: 'nowrap' }}>Cedant</span>
              <select className="np-mini-input np-mini-select" style={{ width: 210, textAlign: 'left' }}
                value={filterCedant} onChange={e => setFilterCedant(e.target.value)}>
                <option value="">All Cedants</option>
                {cedants.map(c => <option key={c.id} value={String(c.id)}>{c.name}</option>)}
              </select>
            </div>
            {dbLoading && (
              <span style={{ fontSize: 11, color: 'rgba(0,212,255,0.6)', fontWeight: 600 }}>⟳ Loading…</span>
            )}
            {!dbLoading && (
              <span style={{ fontSize: 11, color: 'rgba(255,255,255,0.3)', marginLeft: 'auto' }}>
                {dbProgrammes.length} programme{dbProgrammes.length !== 1 ? 's' : ''} found
              </span>
            )}
          </div>

          {/* Results table */}
          {!dbLoading && dbProgrammes.length === 0 ? (
            <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.3)', padding: '10px 0', textAlign: 'center' }}>
              No proportional programmes found. Try adjusting the filters.
            </div>
          ) : !dbLoading && (
            <div style={{ borderRadius: 10, overflow: 'hidden', border: '1px solid rgba(255,255,255,0.08)' }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
                <thead>
                  <tr style={{ background: 'rgba(255,255,255,0.04)' }}>
                    {['UW Year','Cedant','Treaty Type','Country','Status',''].map(h => (
                      <th key={h} style={{ padding: '7px 12px', textAlign: 'left', fontSize: 10, fontWeight: 700, letterSpacing: '.08em', color: 'rgba(255,255,255,0.4)', textTransform: 'uppercase', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {dbProgrammes.map((p, i) => (
                    <tr key={i}
                      style={{ borderBottom: '1px solid rgba(255,255,255,0.04)', transition: 'background .12s' }}
                      onMouseEnter={e => e.currentTarget.style.background='rgba(0,212,255,0.06)'}
                      onMouseLeave={e => e.currentTarget.style.background='transparent'}>
                      <td style={{ padding: '7px 12px', color: 'rgba(255,255,255,0.55)', fontVariantNumeric: 'tabular-nums' }}>{p.uw_year || '—'}</td>
                      <td style={{ padding: '7px 12px', color: '#fff', fontWeight: 600 }}>{p.cedant_name || '—'}</td>
                      <td style={{ padding: '7px 12px', color: 'rgba(255,255,255,0.65)' }}>{p.treaty_type_name || '—'}</td>
                      <td style={{ padding: '7px 12px', color: 'rgba(255,255,255,0.45)', fontSize: 11 }}>{p.country_name || '—'}</td>
                      <td style={{ padding: '7px 12px' }}>
                        <span style={{ fontSize: 9, padding: '2px 7px', borderRadius: 6, background: 'rgba(255,255,255,0.07)', color: 'rgba(255,255,255,0.45)', fontWeight: 700, letterSpacing: '.06em' }}>
                          {p.uw_status || p.status || '—'}
                        </span>
                      </td>
                      <td style={{ padding: '7px 12px', textAlign: 'right' }}>
                        <button className="np-green-pill" type="button"
                          style={{ fontSize: 10, padding: '3px 12px', borderRadius: 8 }}
                          onClick={() => importFromDb(p)}>
                          + Add
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* Table */}
      <div className="np-table-wrap np-table-wrap--scroll">
        <table className="np-struct-table">
          <thead>
            <tr>
              <th className="np-col-prog">PROGRAMME</th>
              <th className="np-col">QS LIMIT 100%</th>
              <th className="np-col-half cell-center">RETENTION %</th>
              <th className="np-col">RETENTION AMT</th>
              <th className="np-col-half cell-center">SURPLUS LINES</th>
              <th className="np-col">TOTAL CAPACITY</th>
              {mode === 'manual' && <th style={{ width: 36 }}></th>}
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={i}>
                <td className="np-col-prog">
                  <div className="np-cell-input">
                    {mode === 'db' && r.contractId ? (
                      /* DB-linked row: show name + clear button */
                      <div style={{ display:'flex', alignItems:'center', gap:6, width:'100%' }}>
                        <span style={{ flex:1, fontSize:12, color:'rgba(255,255,255,0.85)', fontWeight:600, overflow:'hidden', textOverflow:'ellipsis', whiteSpace:'nowrap' }}
                          title={r.programme}>{r.programme || '—'}</span>
                        <button type="button"
                          style={{ background:'none', border:'none', color:'rgba(255,255,255,0.3)', cursor:'pointer', fontSize:13, padding:'0 2px', flexShrink:0 }}
                          onClick={() => { updateRow(i,'programme',''); updateRow(i,'contractId',''); }}
                          title="Unlink">✕</button>
                      </div>
                    ) : mode === 'db' && dbProgrammes.length > 0 ? (
                      /* DB mode: dropdown to pick */
                      <select className="np-mini-input np-mini-select"
                        value=""
                        onChange={e => {
                          const prog = dbProgrammes.find(p => (p.id||p.contract_id) === e.target.value);
                          if (prog) {
                            const n = [...coveredProps];
                            n[i] = makeRowFromProg(prog);
                            setCoveredProps(n); onDirty();
                          }
                        }}>
                        <option value="">Select programme…</option>
                        {dbProgrammes.map(p => (
                          <option key={p.id} value={p.id}>{p.cedant_name} — {p.treaty_type_name} ({p.uw_year})</option>
                        ))}
                      </select>
                    ) : (
                      /* Manual mode: plain text */
                      <input className="np-mini-input np-mini-input--center"
                        value={r.programme || ''}
                        onChange={e => updateRow(i, 'programme', e.target.value)}
                        placeholder="—" />
                    )}
                  </div>
                </td>
                <td className="np-col"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center" value={fmtC(r.qsLimit)} onChange={e => updateRow(i, 'qsLimit', sanitizeNumber(e.target.value))} placeholder="—" /><span className="np-sfx">{currency}</span></div></td>
                <td className="np-col-half cell-center"><div className="np-cell-input"><PctInput className="np-mini-input np-mini-input--center" value={r.retentionPct || ''} onChange={v => updateRow(i, 'retentionPct', v)} placeholder="—%" /></div></td>
                <td className="np-col"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center np-mini-input--readonly" readOnly value={r.retentionAmount ? fmtC(r.retentionAmount) : ''} placeholder="—" /><span className="np-sfx">{currency}</span></div></td>
                <td className="np-col-half cell-center"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center" value={r.surplusLines || ''} onChange={e => updateRow(i, 'surplusLines', e.target.value)} placeholder="—" /></div></td>
                <td className="np-col"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center np-mini-input--readonly" readOnly value={r.totalCapacity ? fmtC(r.totalCapacity) : ''} placeholder="—" /><span className="np-sfx">{currency}</span></div></td>
                {mode === 'manual' && (
                  <td style={{ textAlign: 'center', verticalAlign: 'middle' }}>
                    <button type="button"
                      style={{ background: 'rgba(248,113,113,0.12)', border: '1px solid rgba(248,113,113,0.25)', borderRadius: 6, color: '#f87171', cursor: 'pointer', fontSize: 13, padding: '2px 7px', lineHeight: 1 }}
                      onClick={() => removeRow(i)}
                      title="Remove row">✕</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Add row / footer actions */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 14px', borderTop: '1px solid rgba(255,255,255,0.06)' }}>
        <button className="np-green-pill" type="button" style={{ fontSize: 11 }} onClick={addRow}>+ Add Row</button>
        {rows.length > 0 && (
          <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.35)' }}>
            {rows.filter(r => r.programme).length} programme{rows.filter(r => r.programme).length !== 1 ? 's' : ''} · Total capacity: <span style={{ color: 'rgba(0,212,255,0.8)', fontWeight: 700 }}>{fmtC(String(rows.reduce((s,r) => s + (parseFloat(String(r.totalCapacity||'').replace(/,/g,''))||0), 0)))} {currency}</span>
          </div>
        )}
      </div>
    </section>
  );
}
