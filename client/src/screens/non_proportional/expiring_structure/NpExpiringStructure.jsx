import React, { useState, useEffect, useCallback, useId, useRef, useMemo } from 'react';
import { api } from '../../../api';
import { useContractId } from '../../../hooks/useContractId';
import { useAppState } from '../../../context/AppContext';
import { ACTIVE_QUOTE_ID } from '../../../constants/storageKeys';
import WizardLayout from '../../../components/WizardLayout';
import PctInput from '../../../components/PctInput';
import { formatWithCommas, sanitizeNumber, toN, toNullableN } from '../../../utils/format';
import { getNpTreatyTypeMode, isNpStopLossTreaty } from '../../../utils/npTreatyType';
import { handleStaleWrite } from '../../../utils/handleStaleWrite';
import NpStopLossExpiring from './NpStopLossExpiring';

const ROUTE_KEY = 'NP_EXPIRING_STRUCTURE';

function toInt(v) { const n = parseInt(String(v ?? '').replace(/[^0-9-]/g, ''), 10); return Number.isFinite(n) ? n : 0; }
function fmtC(v) { return formatWithCommas(v); }
function pctVal(v) { const n = parseFloat(String(v ?? '').replace(/[^0-9.-]/g, '')); return Number.isFinite(n) ? n : 0; }

// Layer field mapping: screen state (camelCase) ↔ server DB (snake_case)
function serverLayerToLocal(sl, i) {
  return {
    layer:         `L${sl.layer_number || i + 1}`,
    layerNumber:   sl.layer_number || i + 1,
    limit:         sl.layer_limit        != null ? String(sl.layer_limit)        : '',
    deductible:    sl.attachment         != null ? String(sl.attachment)         : '',
    aggregateLimit:sl.aggregate_limit    != null ? String(sl.aggregate_limit)    : '',
    egnpi:         sl.egnpi              != null ? String(sl.egnpi)              : '',
    rate:          sl.rate               != null ? String(sl.rate)               : '',
    earnedPremium: sl.earned_premium     != null ? String(sl.earned_premium)     : '',
    mdp:           sl.mdp                != null ? String(sl.mdp)                : '',
    mdpPct:        sl.mdp_pct            != null ? String(sl.mdp_pct)            : '',
    noReinst:      sl.num_reinstatements != null ? String(sl.num_reinstatements) : '',
    pctReinst:     sl.reinstatement_pct  != null ? String(sl.reinstatement_pct)  : '',
    aad:           !!sl.annual_agg_deductible,
    aadAmount:     sl.annual_agg_deductible != null ? String(sl.annual_agg_deductible) : '',
    risk:          sl.peril_scope === 'RISK' || sl.peril_scope === 'BOTH',
    cat:           sl.peril_scope === 'CAT'  || sl.peril_scope === 'BOTH',
    rol:           sl.rol                != null ? String(sl.rol)                : '',
  };
}

function localLayerToServer(l, i) {
  const peril_scope = l.risk && l.cat ? 'BOTH' : l.risk ? 'RISK' : l.cat ? 'CAT' : 'BOTH';
  return {
    layer_number:          l.layerNumber || i + 1,
    attachment:            toNullableN(l.deductible),
    layer_limit:           toNullableN(l.limit),
    aggregate_limit:       toNullableN(l.aggregateLimit),
    egnpi:                 toNullableN(l.egnpi),
    earned_premium:        toNullableN(l.earnedPremium),
    rate:                  toNullableN(l.rate),
    rol:                   toNullableN(l.rol),
    num_reinstatements:    toNullableN(l.noReinst),
    reinstatement_pct:     toNullableN(l.pctReinst),
    annual_agg_deductible: l.aad ? toNullableN(l.aadAmount) : null,
    peril_scope,
    mdp:                   toNullableN(l.mdp),
    mdp_pct:               toNullableN(l.mdpPct),
  };
}

function emptyLayer(i) {
  return { layer: `L${i + 1}`, layerNumber: i + 1, limit: '', deductible: '', aggregateLimit: '',
    egnpi: '', rate: '', earnedPremium: '', mdp: '', mdpPct: '', noReinst: '', pctReinst: '',
    aad: false, aadAmount: '', risk: false, cat: false, rol: '' };
}

function emptyCoveredProp() {
  return { programme: '', qsLimit: '', retentionPct: '', surplusLines: '' };
}


// ── CoveredProportionalSection ─────────────────────────────────────────────
function CoveredProportionalSection({ coveredProps, setCoveredProps, onDirty, currency, cedantId, countryId }) {
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

export default function NpExpiringStructure() {
  const contractId = useContractId();
  const { state: appState, setSlice } = useAppState();
  const [layers, setLayers] = useState([]);
  const [terms, setTerms] = useState({ brokerage_pct: '', no_claims_bonus_pct: '', profit_commission_pct: '' });
  const [numLayersInput, setNumLayersInput] = useState('');
  const numLayersSelectId = useId();
  const [coveredProps, setCoveredProps] = useState([]);
  const [loading, setLoading] = useState(false);
  const [autoPopMsg, setAutoPopMsg] = useState('');
  const [saveMsg, setSaveMsg] = useState('');
  const [showCurveModal, setShowCurveModal] = useState(false);
  // Parent-entity timestamp for optimistic locking. Seeded from the load
  // response and updated after each successful save, so a concurrent
  // save by NpStructure (which writes the same expiring endpoint with
  // its own If-Unmodified-Since) returns STALE_WRITE here instead of
  // silently clobbering.
  const [lastUpdatedAt, setLastUpdatedAt] = useState(null);
  const dirty = useRef(false);
  const loaded = useRef(false);

  const npDetail = useMemo(() => appState.npTreatyDetail || {}, [appState.npTreatyDetail]);
  const mode = getNpTreatyTypeMode(appState);
  const currency = npDetail.currencyCode || npDetail.currency || 'SAR';

  const handleNumLayersChange = useCallback((val) => {
    const n = Math.max(0, parseInt(val, 10) || 0);
    setNumLayersInput(val);
    setLayers(prev => {
      const next = [...prev];
      while (next.length < n) next.push(emptyLayer(next.length));
      return next.slice(0, n);
    });
    dirty.current = true;
    setSlice('npTreatyDetail', { expiringNumberOfLayers: String(n) });
  }, [setSlice]);

  // Load from dedicated expiring endpoint
  useEffect(() => {
    if (!contractId) return;
    setLoading(true);
    // Cancel-token: if the effect re-fires (e.g. quoteMode toggles mid-edit)
    // before this fetch resolves, we must NOT apply the stale response on top
    // of the user's edits. Closure-captured boolean is enough — no abort
    // controller needed because we only need to ignore the result.
    let cancelled = false;
    // Determine quote mode: appState is authoritative, but fall back to localStorage
    // in case RESET_FLOW hasn't propagated yet when this effect fires
    const isQuote = appState.quoteMode || (() => {
      try { return localStorage.getItem(ACTIVE_QUOTE_ID) === contractId; } catch { return false; }
    })();
    api.getNpExpiring(contractId, isQuote ? { quote: true } : undefined)
      .then(data => {
        if (cancelled) return;
        // Seed the optimistic-lock baseline even if we're going to skip
        // the rest of the load (dirty + already-loaded path) — the
        // freshly-fetched parent timestamp is still the most recent
        // value we've seen for the lock.
        if (data?.updated_at) setLastUpdatedAt(data.updated_at);
        // Don't clobber unsaved edits with a fresh load. This matters when the
        // effect re-runs because of a non-contract dep change (quoteMode) and
        // the user already has dirty state on screen.
        if (dirty.current && loaded.current) return;
        const serverLayers = Array.isArray(data?.layers) ? data.layers : [];
        const serverTerms  = data?.terms || {};

        const localLayers = serverLayers.map((sl, i) => serverLayerToLocal(sl, i));
        const count = localLayers.length;

        // If server has no saved expiring layers yet, seed layer count from treaty detail field
        const seedCount = count > 0 ? count
          : parseInt(npDetail.expiringNumberOfLayers || npDetail.expiring_number_of_layers || '0', 10) || 0;

        if (seedCount > 0 && count === 0) {
          const seeded = Array.from({ length: seedCount }, (_, i) => emptyLayer(i));
          setNumLayersInput(String(seedCount));
          setLayers(seeded);
          dirty.current = false; // do NOT mark dirty — seeding empty layers should NOT trigger save
        } else {
          setNumLayersInput(count > 0 ? String(count) : '');
          setLayers(localLayers);
        }
        setTerms({
          brokerage_pct:         serverTerms.brokerage_pct         != null ? String(serverTerms.brokerage_pct)         : '',
          no_claims_bonus_pct:   serverTerms.no_claims_bonus_pct   != null ? String(serverTerms.no_claims_bonus_pct)   : '',
          profit_commission_pct: serverTerms.profit_commission_pct != null ? String(serverTerms.profit_commission_pct) : '',
        });

        if (data?.autoPopulated) {
          setAutoPopMsg('Auto-populated from parent contract structure. Review and save to confirm.');
        }

        if (seedCount > 0) setSlice('npTreatyDetail', { expiringNumberOfLayers: String(seedCount) });

        // coveredProps: prefer DB-returned value, fall back to JSONB appState for older contracts
        const dbCoveredProps = Array.isArray(data?.coveredProps) ? data.coveredProps : null;
        if (dbCoveredProps && dbCoveredProps.length > 0) {
          setCoveredProps(dbCoveredProps);
        } else {
          const jsonbExp = (appState.npStructure || {}).expiringStructure || {};
          const cp = jsonbExp.coveredProps || jsonbExp.covered_props || [];
          setCoveredProps(cp.length > 0 ? cp : [emptyCoveredProp()]);
        }
        loaded.current = true;
      })
      .catch((e) => {
        if (cancelled) return;
        // The server now returns a real 5xx on load failures (it used to mask
        // them as empty 200s). Refuse to overwrite local state with empties —
        // a subsequent save would then DELETE the user's saved row. Surface
        // the failure and let the user retry instead.
        console.warn('NP Expiring Structure load failed:', e);
        setSaveMsg(dirty.current
          ? 'Load failed — your unsaved edits are preserved. Refresh to retry.'
          : 'Load failed — refresh to retry.');
        // First-ever load + nothing dirty: the form is blank either way, so
        // unblock saves by marking loaded. Otherwise we keep the prior good
        // state on screen and leave loaded as it was.
        if (!loaded.current && !dirty.current) {
          setNumLayersInput('');
          setLayers([]);
          setCoveredProps([emptyCoveredProp()]);
          loaded.current = true;
        }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [contractId, appState.quoteMode, appState.npStructure, npDetail.expiringNumberOfLayers, npDetail.expiring_number_of_layers, setSlice]);

  // Recalculate derived fields per layer
  const recalcLayer = useCallback((l, idx, allLayers) => {
    const limit        = toInt(l.limit);
    const egnpi        = toInt(l.egnpi);
    const rate         = pctVal(l.rate);
    const earnedPremium = rate > 0 && egnpi > 0 ? Math.round(egnpi * rate / 100) : toInt(l.earnedPremium);
    const mdp          = toInt(l.mdp);
    const mdpPct       = earnedPremium > 0 && mdp > 0 ? ((mdp / earnedPremium) * 100).toFixed(2) : '';
    const rol          = limit > 0 && earnedPremium > 0 ? ((earnedPremium / limit) * 100).toFixed(4) : '';

    let deductible = l.deductible;
    if (idx === 0) {
      const fromDetail = toInt(npDetail.deductible || npDetail.retention || 0);
      if (!deductible && fromDetail) deductible = String(fromDetail);
    } else if (idx > 0 && allLayers[idx - 1]) {
      const prevDed = toInt(allLayers[idx - 1].deductible);
      const prevLim = toInt(allLayers[idx - 1].limit);
      if (prevDed + prevLim > 0) deductible = String(prevDed + prevLim);
    }
    return { ...l, deductible, earnedPremium: String(earnedPremium || l.earnedPremium || ''), mdpPct, rol };
  }, [npDetail]);

  const updateLayer = useCallback((idx, field, value) => {
    setLayers(prev => {
      const next = [...prev];
      next[idx] = { ...next[idx], [field]: value };
      return next.map((l, i) => recalcLayer(l, i, next));
    });
    dirty.current = true;
  }, [recalcLayer]);

  const updateTerms = useCallback((field, value) => {
    setTerms(prev => ({ ...prev, [field]: value }));
    dirty.current = true;
  }, []);

  // Save to dedicated expiring endpoint
  const save = useCallback(async (opts = {}) => {
    if (!contractId) return true;
    // Don't save if load hasn't completed — would overwrite DB with empty state
    if (!loaded.current) return true;
    // Don't save if nothing changed (unless explicitly forced)
    if (!dirty.current && !opts.force) return true;
    // Only block if absolutely nothing has been touched AND not forced
    // (dirty flag is the primary gate — don't block saves that user explicitly triggered)
    const payload = {
      layers: layers.map((l, i) => localLayerToServer(l, i)),
      terms: {
        brokerage_pct:         toNullableN(terms.brokerage_pct),
        no_claims_bonus_pct:   toNullableN(terms.no_claims_bonus_pct),
        profit_commission_pct: toNullableN(terms.profit_commission_pct),
      },
      coveredProps: coveredProps.filter(r => r.programme || r.qsLimit || r.retentionPct || r.surplusLines),
    };
    const isQuoteSave = appState.quoteMode || (() => {
      try { return localStorage.getItem(ACTIVE_QUOTE_ID) === contractId; } catch { return false; }
    })();
    // Optimistic-lock plumbing mirrors NpStructure: the special '*'
    // override is what the stale-write modal's "overwrite" branch
    // sends, bypassing the lock for that one retry.
    const lockOverride = opts?.ifUnmodifiedSince;
    const activeLock = lockOverride || lastUpdatedAt;
    const requestOpts = isQuoteSave
      ? { quote: true, ...(activeLock ? { ifUnmodifiedSince: activeLock } : {}) }
      : (activeLock ? { ifUnmodifiedSince: activeLock } : undefined);
    try {
      const response = await api.saveNpExpiring(contractId, payload, requestOpts);
      if (response?.updated_at) setLastUpdatedAt(response.updated_at);
      dirty.current = false;
      setSaveMsg('Saved ✓');
      setTimeout(() => setSaveMsg(''), 2000);
      return true;
    } catch (e) {
      console.warn('NP Expiring Structure save failed:', e);
      if (lockOverride !== '*') {
        const stale = await handleStaleWrite(e, {
          entityType: isQuoteSave ? 'quote expiring structure' : 'expiring structure',
          onRefresh: () => window.location.reload(),
          onOverwrite: () => save({ ...opts, ifUnmodifiedSince: '*' }),
        });
        if (stale.handled) return stale.action === 'overwrite' ? !!stale.result : false;
      }
      setSaveMsg('Save failed');
      return opts.quiet ? true : false;
    }
  }, [contractId, layers, terms, coveredProps, appState.quoteMode, lastUpdatedAt]);

  const handleManualSave = useCallback(async () => {
    dirty.current = true; // force save even if no changes detected
    await save({ force: true });
  }, [save]);

  // Totals row
  const totals = layers.reduce((acc, l) => {
    const lim = toInt(l.limit);
    const rol = pctVal(l.rol);
    return {
      limit:          acc.limit          + lim,
      deductible:     acc.deductible,
      aggregateLimit: acc.aggregateLimit + toInt(l.aggregateLimit),
      egnpi:          acc.egnpi          + toInt(l.egnpi),
      earnedPremium:  acc.earnedPremium  + toInt(l.earnedPremium),
      mdp:            acc.mdp            + toInt(l.mdp),
      // SUMPRODUCT(limit × ROL) numerator — divide by totalLimit for weighted avg ROL
      rolNumerator:   acc.rolNumerator   + (lim > 0 && rol > 0 ? lim * rol : 0),
    };
  }, { limit: 0, deductible: 0, aggregateLimit: 0, egnpi: 0, earnedPremium: 0, mdp: 0, rolNumerator: 0 });

  // Weighted average ROL = SUMPRODUCT(limit × ROL) / totalLimit
  const weightedRol = totals.limit > 0 && totals.rolNumerator > 0
    ? (totals.rolNumerator / totals.limit).toFixed(4)
    : '';

  // coveredPropsWithCalc computed inside CoveredProportionalSection

  const stopLossTreaty = isNpStopLossTreaty(appState);

  return (
    <WizardLayout routeKey={ROUTE_KEY} title="Expiring Structure & Terms" headerPill="NP: EXPIRING STRUCTURE" onBeforeNext={save} onBeforeBack={save}>
      {() => (
        <div className="NP_EXPIRING_STRUCTURE">
          {stopLossTreaty ? (
            <NpStopLossExpiring currency={currency} />
          ) : loading ? (
            <div className="df-card df-card--notice"><div className="df-note">Loading…</div></div>
          ) : (
            <>
              {autoPopMsg && (
                <div className="df-card df-card--notice" style={{ marginBottom: 12 }}>
                  <div className="df-note" style={{ color: '#4ade80' }}>ℹ {autoPopMsg}</div>
                </div>
              )}

              {/* Header: layer count + terms */}
              <section className="np-struct-card glass" style={{ marginBottom: 0 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 24, padding: '14px 18px', flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <label htmlFor={numLayersSelectId} style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.14em', color: 'rgba(255,255,255,0.5)', whiteSpace: 'nowrap', textTransform: 'uppercase' }}>LAYERS</label>
                    <select id={numLayersSelectId} className="np-mini-input np-mini-select" style={{ width: 90 }} value={numLayersInput} onChange={e => handleNumLayersChange(e.target.value)}>
                      <option value="">—</option>
                      {[1,2,3,4,5,6,7,8,9,10,11,12].map(n => <option key={n} value={n}>{n}</option>)}
                    </select>
                  </div>
                  {[
                    { key: 'brokerage_pct',         label: 'BROKERAGE %' },
                    { key: 'no_claims_bonus_pct',   label: 'NCB %' },
                    { key: 'profit_commission_pct', label: 'PROFIT COMM. %' },
                  ].map(({ key, label }) => (
                    <div key={key} style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                      <label style={{ fontSize: 11, fontWeight: 800, letterSpacing: '0.14em', color: 'rgba(255,255,255,0.45)', whiteSpace: 'nowrap', textTransform: 'uppercase' }}>{label}</label>
                      <PctInput
                        className="np-mini-input np-mini-input--center"
                        style={{ width: 90 }}
                        value={terms[key]}
                        placeholder="—%"
                        onChange={v => updateTerms(key, v)}
                      />
                    </div>
                  ))}
                  <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 10 }}>
                    {saveMsg && <span style={{ fontSize: 12, color: saveMsg.includes('failed') ? '#f87171' : '#4ade80' }}>{saveMsg}</span>}
                    <button className="np-green-pill" type="button" onClick={handleManualSave}>SAVE</button>
                  </div>
                </div>
              </section>

              {/* Layers table */}
              <section className="np-struct-card glass">
                <div className="np-struct-card-header">
                  <div>
                    <div className="np-struct-card-title">EXPIRING TREATY STRUCTURE – LAYERS</div>
                    <div className="np-struct-card-hint">New business — enter expiring market terms manually for YoY comparison in pricing metrics.</div>
                  </div>
                  <div className="np-struct-card-actions">
                    <button className="np-green-pill" type="button" onClick={() => setShowCurveModal(true)}>⬥ VIEW IMPLIED PRICING CURVE</button>
                    <div className="np-type-pills">
                      <span className={`np-type-pill ${mode === 'RISK' || mode === 'BOTH' ? 'is-on' : 'is-off'}`}>RISK XL</span>
                      <span className={`np-type-pill ${mode === 'CAT'  || mode === 'BOTH' ? 'is-on' : 'is-off'}`}>CAT XL</span>
                    </div>
                  </div>
                </div>
                <div className="np-table-wrap np-table-wrap--scroll np-table-wrap--wide">
                  <table className="np-struct-table np-struct-table--wide">
                    <thead>
                      <tr>
                        <th className="np-table-sticky cell-center">LAYER</th>
                        <th className="np-col">LIMIT</th>
                        <th className="np-col">DEDUCTIBLE / ATTACHMENT</th>
                        <th className="np-col">AGGREGATE LIMIT</th>
                        <th className="np-col">EGNPI</th>
                        <th className="np-col-rate cell-center">RATE %</th>
                        <th className="np-col">EARNED PREM</th>
                        <th className="np-col">MDP</th>
                        <th className="np-col-mdp-pct cell-center">MDP%</th>
                        <th className="np-col-reinst cell-center">REINST #</th>
                        <th className="np-col-reinst cell-center">REINST %</th>
                        <th className="np-col-chk cell-center">AAD</th>
                        <th className="np-col">AAD AMT</th>
                        <th className="np-col-chk cell-center">RISK</th>
                        <th className="np-col-chk cell-center">CAT</th>
                        <th className="np-col-rol cell-center">ROL%</th>
                      </tr>
                    </thead>
                    <tbody>
                      {layers.map((l, i) => (
                        <tr key={i}>
                          <th className="np-table-sticky cell-center">{l.layer || `L${i + 1}`}</th>
                          <td className="np-col"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center" value={fmtC(l.limit)} onChange={e => updateLayer(i, 'limit', sanitizeNumber(e.target.value))} placeholder="—" /><span className="np-sfx">{currency}</span></div></td>
                          <td className="np-col"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center" value={fmtC(l.deductible)} onChange={e => updateLayer(i, 'deductible', sanitizeNumber(e.target.value))} placeholder="—" /><span className="np-sfx">{currency}</span></div></td>
                          <td className="np-col"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center" value={fmtC(l.aggregateLimit)} onChange={e => updateLayer(i, 'aggregateLimit', sanitizeNumber(e.target.value))} placeholder="—" /><span className="np-sfx">{currency}</span></div></td>
                          <td className="np-col"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center" value={fmtC(l.egnpi)} onChange={e => updateLayer(i, 'egnpi', sanitizeNumber(e.target.value))} placeholder="—" /><span className="np-sfx">{currency}</span></div></td>
                          <td className="np-col-rate cell-center"><div className="np-cell-input"><PctInput className="np-mini-input np-mini-input--center" value={l.rate} onChange={v => updateLayer(i, 'rate', v)} placeholder="—%" /></div></td>
                          <td className="np-col"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center" value={fmtC(l.earnedPremium)} onChange={e => updateLayer(i, 'earnedPremium', sanitizeNumber(e.target.value))} placeholder="—" /><span className="np-sfx">{currency}</span></div></td>
                          <td className="np-col"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center" value={fmtC(l.mdp)} onChange={e => updateLayer(i, 'mdp', sanitizeNumber(e.target.value))} placeholder="—" /><span className="np-sfx">{currency}</span></div></td>
                          <td className="np-col-mdp-pct cell-center"><div className="np-cell-input"><PctInput className="np-mini-input np-mini-input--center np-mini-input--readonly" readOnly value={l.mdpPct || ''} onChange={() => {}} placeholder="—%" /></div></td>
                          <td className="np-col-reinst cell-center"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center" value={l.noReinst} onChange={e => updateLayer(i, 'noReinst', e.target.value)} placeholder="—" /></div></td>
                          <td className="np-col-reinst cell-center"><div className="np-cell-input"><PctInput className="np-mini-input np-mini-input--center" value={l.pctReinst} onChange={v => updateLayer(i, 'pctReinst', v)} placeholder="—%" /></div></td>
                          <td className="np-col-chk cell-center"><input type="checkbox" className="np-check" checked={!!l.aad} onChange={e => updateLayer(i, 'aad', e.target.checked)} /></td>
                          <td className="np-col"><div className="np-cell-input"><input className={`np-mini-input np-mini-input--center${!l.aad ? ' np-mini-input--readonly' : ''}`} value={fmtC(l.aadAmount)} onChange={e => updateLayer(i, 'aadAmount', sanitizeNumber(e.target.value))} disabled={!l.aad} placeholder="—" /><span className="np-sfx">{currency}</span></div></td>
                          <td className="np-col-chk cell-center"><input type="checkbox" className="np-check" checked={!!l.risk} onChange={e => updateLayer(i, 'risk', e.target.checked)} /></td>
                          <td className="np-col-chk cell-center"><input type="checkbox" className="np-check" checked={!!l.cat} onChange={e => updateLayer(i, 'cat', e.target.checked)} /></td>
                          <td className="np-col-rol cell-center"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center np-mini-input--readonly" readOnly value={l.rol ? `${l.rol}%` : ''} placeholder="—" style={l.rol ? { borderColor: 'rgba(0,212,255,0.55)', borderWidth: 2 } : undefined} /></div></td>
                        </tr>
                      ))}
                    </tbody>
                    {layers.length > 1 && (
                      <tfoot>
                        <tr style={{ borderTop: '2px solid rgba(0,212,255,0.45)', background: 'rgba(0,212,255,0.06)' }}>
                          <th className="np-table-sticky cell-center" style={{ color: '#00d4ff', fontSize: 10, letterSpacing: '.08em', fontWeight: 800, background: 'rgba(0,212,255,0.08)' }}>TOTAL</th>
                          <td className="np-col"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center np-mini-input--readonly" readOnly value={fmtC(totals.limit)} placeholder="—" /><span className="np-sfx">{currency}</span></div></td>
                          <td className="np-col"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center np-mini-input--readonly" readOnly value={layers[0]?.deductible ? fmtC(layers[0].deductible) : '—'} placeholder="—" /><span className="np-sfx">{currency}</span></div></td>
                          <td className="np-col"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center np-mini-input--readonly" readOnly value={totals.aggregateLimit ? fmtC(totals.aggregateLimit) : ''} placeholder="—" /><span className="np-sfx">{currency}</span></div></td>
                          <td className="np-col"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center np-mini-input--readonly" readOnly value={fmtC(totals.egnpi)} placeholder="—" /><span className="np-sfx">{currency}</span></div></td>
                          <td className="np-col-rate"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center np-mini-input--readonly" readOnly value="" placeholder="—" /></div></td>
                          <td className="np-col"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center np-mini-input--readonly" readOnly value={fmtC(totals.earnedPremium)} placeholder="—" /><span className="np-sfx">{currency}</span></div></td>
                          <td className="np-col"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center np-mini-input--readonly" readOnly value={totals.mdp ? fmtC(totals.mdp) : ''} placeholder="—" /><span className="np-sfx">{currency}</span></div></td>
                          <td colSpan={3}></td>
                          <td className="np-col-rol cell-center"><div className="np-cell-input"><input className="np-mini-input np-mini-input--center np-mini-input--readonly" readOnly value={weightedRol ? `${weightedRol}%` : ''} placeholder="—" style={weightedRol ? { borderColor: 'rgba(0,212,255,0.55)', borderWidth: 2 } : undefined} /></div></td>
                          <td colSpan={4}></td>
                        </tr>
                      </tfoot>
                    )}
                  </table>
                </div>
                <div className="np-struct-footnote">
                  Expiring structure is used to auto-populate year-on-year metrics in Final Pricing.
                </div>
              </section>

              {/* Covered Proportional Structure */}
              <CoveredProportionalSection
                coveredProps={coveredProps}
                setCoveredProps={setCoveredProps}
                onDirty={() => { dirty.current = true; }}
                currency={currency}
                cedantId={npDetail.cedantId}
                countryId={npDetail.countryId}
              />

              {/* Implied Pricing Curve Modal */}
              {showCurveModal && (() => {
                const eps = 1e-9;

                // Power-law curve fit: ROL = a × x^b
                const fitPowerCurve = (points) => {
                  const pts = (points || [])
                    .map(p => ({ x: Math.max(eps, Number(p.x) || 0), y: Math.max(eps, Number(p.y) || 0) }))
                    .filter(p => p.x > 0 && p.y > 0 && Number.isFinite(p.x) && Number.isFinite(p.y));
                  if (pts.length < 2) return null;
                  const sseForB = b => {
                    let num = 0, den = 0;
                    for (const p of pts) {
                      const xb = Math.pow(p.x, b);
                      if (!Number.isFinite(xb)) return { sse: Infinity, a: NaN };
                      num += p.y * xb; den += xb * xb;
                    }
                    if (!den) return { sse: Infinity, a: NaN };
                    const a = num / den;
                    if (!Number.isFinite(a) || a <= 0) return { sse: Infinity, a };
                    let sse = 0;
                    for (const p of pts) { const e = p.y - a * Math.pow(p.x, b); sse += e * e; }
                    return { sse, a };
                  };
                  let best = { sse: Infinity, a: NaN, b: NaN };
                  for (let b = -6; b <= 6; b += 0.1) {
                    const r = sseForB(b);
                    if (r.sse < best.sse) best = { sse: r.sse, a: r.a, b };
                  }
                  if (!Number.isFinite(best.sse) || best.sse === Infinity) return null;
                  let b0 = best.b;
                  for (let step = 0.05; step >= 0.002; step /= 2) {
                    let lb = best;
                    for (let b = b0 - 0.2; b <= b0 + 0.2; b += step) {
                      const r = sseForB(b);
                      if (r.sse < lb.sse) lb = { sse: r.sse, a: r.a, b };
                    }
                    best = lb; b0 = best.b;
                  }
                  return (Number.isFinite(best.a) && Number.isFinite(best.b) && best.a > 0) ? { a: best.a, b: best.b } : null;
                };

                const r2ForPower = (pts, model) => {
                  if (!model || pts.length < 2) return NaN;
                  const meanY = pts.reduce((s, p) => s + p.y, 0) / pts.length;
                  let ssTot = 0, ssRes = 0;
                  for (const p of pts) {
                    const yhat = model.a * Math.pow(Math.max(1e-6, p.x), model.b);
                    ssTot += (p.y - meanY) ** 2; ssRes += (p.y - yhat) ** 2;
                  }
                  const r2 = 1 - ssRes / ssTot;
                  return Number.isFinite(r2) ? r2 : NaN;
                };

                // Build points: x = √((Att+Lim)×Att) / EGNPI, y = ROL fraction
                const egnpiOverall = Math.max(0, ...layers.map(l => toN(l.egnpi)).filter(n => n > 0));
                const pts = egnpiOverall > 0 ? layers.map((l, i) => {
                  const ded = toN(l.deductible);
                  const lim = toN(l.limit);
                  if (ded <= 0 || lim <= 0) return null;
                  const epN = toN(l.earnedPremium);
                  const rolRaw = parseFloat(String(l.rol || l.rate || '').replace(/%/g, '')) || 0;
                  const rol01 = (lim > 0 && epN > 0) ? epN / lim : rolRaw / 100;
                  if (!rol01 || rol01 <= 0) return null;
                  const x = Math.sqrt((ded + lim) * ded) / egnpiOverall;
                  return (Number.isFinite(x) && x > 0) ? { x, y: rol01, layer: i + 1 } : null;
                }).filter(Boolean) : [];

                const model = fitPowerCurve(pts);
                const r2 = r2ForPower(pts, model);

                const renderSVG = () => {
                  if (pts.length < 2 || !model) return null;
                  const W = 860, H = 300, padL = 54, padR = 18, padT = 24, padB = 38;
                  const xs = pts.map(p => p.x), ys = pts.map(p => p.y);
                  const x0 = Math.max(0, Math.min(...xs) * 0.85);
                  const x1 = Math.max(...xs) * 1.15;
                  const y0 = Math.max(0, Math.min(...ys) * 0.85);
                  const y1 = Math.max(...ys) * 1.15;
                  const sx = x => padL + ((x - x0) / (x1 - x0 || 1)) * (W - padL - padR);
                  const sy = y => H - padB - ((y - y0) / (y1 - y0 || 1)) * (H - padT - padB);
                  let pathD = '';
                  for (let i = 0; i <= 80; i++) {
                    const x = x0 + (i / 80) * (x1 - x0);
                    const y = model.a * Math.pow(Math.max(eps, x), model.b);
                    pathD += `${i === 0 ? 'M' : 'L'}${sx(x).toFixed(2)},${sy(y).toFixed(2)}`;
                  }
                  const label = `ROL = ${(model.a * 100).toFixed(4)}% × x^${model.b.toFixed(4)}${Number.isFinite(r2) ? `  |  R² = ${r2.toFixed(3)}` : ''}`;
                  return (
                    <svg width="100%" viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" className="crisp-grid" style={{ display: 'block', fontFamily: 'inherit', fontVariantNumeric: 'tabular-nums' }} role="img" aria-label="Implied power curve">
                      <line x1={padL} y1={padT} x2={padL} y2={H - padB} stroke="rgba(255,255,255,0.30)" shapeRendering="crispEdges" vectorEffect="non-scaling-stroke" />
                      <line x1={padL} y1={H - padB} x2={W - padR} y2={H - padB} stroke="rgba(255,255,255,0.30)" shapeRendering="crispEdges" vectorEffect="non-scaling-stroke" />
                      <text x={padL + 6} y={padT + 14} fontSize={12} fontWeight="600" fill="rgba(255,255,255,0.85)">{label}</text>
                      <path d={pathD} fill="none" stroke="#00d4ff" strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" opacity={0.95} vectorEffect="non-scaling-stroke" />
                      {pts.map((p, i) => (
                        <g key={i}>
                          <circle cx={sx(p.x).toFixed(2)} cy={sy(p.y).toFixed(2)} r={5} fill="#00d4ff" opacity={0.95} />
                          <text x={+sx(p.x).toFixed(2) + 7} y={+sy(p.y).toFixed(2) + 4} fontSize={11} fill="rgba(255,255,255,0.85)" fontWeight="700">L{p.layer}</text>
                        </g>
                      ))}
                      <text x={padL} y={H - 8} fontSize={11} fontWeight="500" fill="rgba(255,255,255,0.65)">x = √((Att+Lim)×Att) / EGNPI</text>
                      <text x={10} y={padT + 4} fontSize={11} fontWeight="500" fill="rgba(255,255,255,0.65)">ROL</text>
                    </svg>
                  );
                };

                return (
                  <div
                    className="modal-backdrop"
                    role="presentation"
                    style={{ position: 'fixed', inset: 0, zIndex: 1200, display: 'flex', alignItems: 'center', justifyContent: 'center', background: 'rgba(0,0,0,0.65)' }}
                    onClick={e => { if (e.target === e.currentTarget) setShowCurveModal(false); }}>
                    <div className="glass" role="dialog" aria-modal="true" style={{ background: '#0b1220', border: '1px solid rgba(0,212,255,0.25)', borderRadius: 14, width: '92vw', maxWidth: 1000, maxHeight: '80vh', display: 'flex', flexDirection: 'column', overflow: 'hidden', boxShadow: '0 24px 60px rgba(0,0,0,0.7)' }}>
                      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '14px 20px', borderBottom: '1px solid rgba(255,255,255,0.08)' }}>
                        <div>
                          <div style={{ fontWeight: 800, fontSize: 14, letterSpacing: '.06em', color: '#e2e8f0', textTransform: 'uppercase' }}>Implied Pricing Curve</div>
                          <div style={{ fontSize: 12, color: 'rgba(255,255,255,0.45)', marginTop: 3 }}>
                            Power-law fit: ROL = a × x^b &nbsp;|&nbsp; x = √((Att+Lim)×Att) / EGNPI. Requires ≥2 layers with Limit, Deductible, EGNPI and ROL.
                          </div>
                        </div>
                        <button type="button" onClick={() => setShowCurveModal(false)} aria-label="Close"
                          style={{ background: 'none', border: '1px solid rgba(255,255,255,0.15)', color: 'rgba(255,255,255,0.6)', borderRadius: 6, padding: '4px 12px', cursor: 'pointer', fontSize: 13 }}>
                          ✕ Close
                        </button>
                      </div>
                      <div style={{ overflowY: 'auto', padding: '16px 20px', flex: 1 }}>
                        {pts.length < 2 ? (
                          <p style={{ color: 'rgba(255,255,255,0.4)', textAlign: 'center', padding: 32 }}>
                            Enter Limit, Deductible, EGNPI and ROL for at least two layers to display the curve.
                          </p>
                        ) : !model ? (
                          <p style={{ color: 'rgba(255,255,255,0.4)', textAlign: 'center', padding: 32 }}>
                            Unable to fit a curve from the current layer points.
                          </p>
                        ) : (
                          <>
                            <div style={{ background: 'rgba(0,212,255,0.03)', border: '1px solid rgba(0,212,255,0.12)', borderRadius: 10, padding: '12px 16px', marginBottom: 14 }}>
                              {renderSVG()}
                            </div>
                            <div style={{ fontSize: 11, color: 'rgba(255,255,255,0.32)', borderTop: '1px solid rgba(255,255,255,0.07)', paddingTop: 10 }}>
                              Model: ROL = a × x^b &nbsp;|&nbsp; x = √((Attachment + Limit) × Attachment) / EGNPI &nbsp;|&nbsp; Fitted by least-squares search over b ∈ [−6, 6].
                              {Number.isFinite(r2) && <span style={{ marginLeft: 16, color: 'rgba(0,212,255,0.7)', fontWeight: 700 }}>R² = {r2.toFixed(3)}</span>}
                            </div>
                            <table className="np-struct-table" style={{ width: '100%', marginTop: 14 }}>
                              <thead><tr><th>Layer</th><th>Attachment</th><th>Top</th><th>ROL %</th><th>Fitted ROL %</th></tr></thead>
                              <tbody>
                                {layers.filter(l => toN(l.limit) > 0 && toN(l.deductible) > 0).map((l, i) => {
                                  const ded = toN(l.deductible), lim = toN(l.limit);
                                  const rolRaw = parseFloat(String(l.rol || l.rate || '').replace(/%/g,'')) || 0;
                                  const epN = toN(l.earnedPremium);
                                  const rol = lim > 0 && epN > 0 ? (epN / lim * 100).toFixed(4) : rolRaw ? rolRaw.toFixed(4) : '—';
                                  const x = egnpiOverall > 0 ? Math.sqrt((ded + lim) * ded) / egnpiOverall : 0;
                                  const fitted = model && x > 0 ? (model.a * Math.pow(Math.max(eps, x), model.b) * 100).toFixed(4) : '—';
                                  return (
                                    <tr key={i}>
                                      <td>L{i + 1}</td>
                                      <td>{fmtC(String(ded))}</td>
                                      <td>{fmtC(String(ded + lim))}</td>
                                      <td style={{ color: '#00d4ff', fontWeight: 700 }}>{rol}%</td>
                                      <td style={{ color: 'rgba(255,255,255,0.5)' }}>{fitted}{fitted !== '—' ? '%' : ''}</td>
                                    </tr>
                                  );
                                })}
                              </tbody>
                            </table>
                          </>
                        )}
                      </div>
                    </div>
                  </div>
                );
              })()}
            </>
          )}
        </div>
      )}
    </WizardLayout>
  );
}
