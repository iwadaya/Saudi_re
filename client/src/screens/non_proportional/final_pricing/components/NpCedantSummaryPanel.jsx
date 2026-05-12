// src/screens/non_proportional/final_pricing/components/NpCedantSummaryPanel.jsx
// Side panel that shows every NP programme this cedant has with us,
// so the underwriter can size the new treaty against the portfolio.
// Pulls data from:
//   • api.getCedantSummary(cedantId) — canonical source if available
//   • api.getHomeSummary() — fallback that scans drafts/submitted/renewals
//   • current contract's own layer state, injected if the API response
//     doesn't already include the row we're on
//
// Fix during extraction: the parent used to leak `quoteMode` into this
// component's closure (a real lint error); now it properly reads the
// `isQuote` prop.

import { useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../../../api';
import { useAppState } from '../../../../context/AppContext';
import { toN } from '../formatters.js';
import PctInput from '../../../../components/PctInput';

/**
 * @param {{
 *   contractId: string,
 *   currency: string,
 *   layers: Array<object>,
 *   isQuote?: boolean,
 * }} props
 */
export default function NpCedantSummaryPanel({ contractId, currency: rawCurrency, layers: currentLayers, isQuote = false }) {
  const currency = /^[A-Z]{3}$/.test(rawCurrency) ? rawCurrency : 'USD';
  const [allRows, setAllRows]       = useState([]);
  const [loading, setLoading]       = useState(true);
  const [includeMap, setIncludeMap] = useState({});
  const [lineSizes, setLineSizes]   = useState({});
  const [yearFilter, setYearFilter] = useState('ALL');
  const { state: appState } = useAppState();
  const td = useMemo(() => appState.npTreatyDetail || {}, [appState.npTreatyDetail]);

  // 100% limit/premium computed from the current contract's layers
  const cur100Limit = useMemo(() => {
    if (!Array.isArray(currentLayers)) return 0;
    return currentLayers.reduce((s, l) => s + toN(l.limit), 0);
  }, [currentLayers]);

  const cur100Prem = useMemo(() => {
    if (!Array.isArray(currentLayers)) return 0;
    return currentLayers.reduce((s, l) => s + toN(l.earnedPremium), 0);
  }, [currentLayers]);

  const fetchInputsRef = useRef({ td, cur100Limit, cur100Prem, isQuote });
  useEffect(() => {
    fetchInputsRef.current = { td, cur100Limit, cur100Prem, isQuote };
  }, [td, cur100Limit, cur100Prem, isQuote]);

  useEffect(() => {
    if (!contractId) { setLoading(false); return; }
    let cancelled = false;
    const fetchData = async () => {
      if (cancelled) return;
      try {
        const {
          td: currentTd,
          cur100Limit: current100Limit,
          cur100Prem: current100Prem,
          isQuote: currentIsQuote,
        } = fetchInputsRef.current;
        let cedantId = currentTd.cedantId || currentTd.cedant_id || '';
        if (!cedantId) {
          const apiOpts = currentIsQuote ? { quote: true } : undefined;
          const cData = await api.getContract(contractId, apiOpts).catch(() => null);
          cedantId = cData?.header?.cedant_id || cData?.cedant_id || '';
        }
        if (!cedantId) { setLoading(false); return; }

        let data = await api.getCedantSummary(cedantId).catch(() => []);
        if (!Array.isArray(data)) data = [];

        if (!data.length) {
          const home = await api.getHomeSummary().catch(() => ({}));
          const all = [...(home.drafts || []), ...(home.submitted || []), ...(home.renewals || [])];
          data = all.filter(r => String(r.cedant_id || r.cedantId || '') === String(cedantId));
        }

        // Ensure current contract is in the list even if the API hasn't indexed it yet
        const curExists = data.some(r => String(r.contract_id || r.contractId || r.id || '') === String(contractId));
        if (!curExists) {
          data.unshift({
            contract_id: contractId,
            uw_year: currentTd.inceptionDate ? new Date(currentTd.inceptionDate).getFullYear() : '',
            inception_date: currentTd.inceptionDate || '',
            status: currentTd.status || 'DRAFT',
            treatyType: currentTd.treatyTypeName || currentTd.treatyType || 'Non-Prop',
            premium: current100Prem,
            limit: current100Limit,
            actuarial_margin: 0, actual_margin: 0,
          });
        }

        setAllRows(data);
        const inc = {}; const ls = {};
        data.forEach(r => {
          const id = String(r.contract_id || r.contractId || r.id || '');
          const st = String(r.status || r.decision || r.uw_status || '').toUpperCase();
          inc[id] = !(st === 'DECLINED' || st === 'NTU');
          ls[id]  = String(r.signed_line_pct || r.signedLinePct || r.written_line_pct || '');
        });
        setIncludeMap(inc);
        setLineSizes(ls);
      } catch (e) { console.error('[NpCedantSummary] error:', e); }
      setLoading(false);
    };
    fetchData();
    return () => { cancelled = true; };
  }, [contractId]);

  const getUwYear = r => {
    const d = r.inception_date || r.inceptionDate;
    if (d) { const y = new Date(d).getFullYear(); if (y && !isNaN(y)) return String(y); }
    return String(r.uw_year || r.uwYear || r.year || '');
  };

  const availableYears = useMemo(() => {
    const yrs = new Set();
    allRows.forEach(r => { const y = getUwYear(r); if (y) yrs.add(y); });
    return Array.from(yrs).sort((a, b) => Number(b) - Number(a));
  }, [allRows]);

  const rows = yearFilter === 'ALL' ? allRows : allRows.filter(r => getUwYear(r) === yearFilter);
  const idOf = r => String(r.contract_id || r.contractId || r.id || '');
  const isCur = r => idOf(r) === String(contractId);
  const num = v => { const n = Number(String(v ?? '').replace(/,/g, '').trim()); return Number.isFinite(n) ? n : 0; };
  const ga = (r, ...keys) => { for (const k of keys) if (r[k] != null && r[k] !== '') return r[k]; return null; };

  const moneyFmt = n => {
    const v = Number(n);
    if (!Number.isFinite(v) || v === 0) return '—';
    return `${currency} ${v.toLocaleString('en-US', { maximumFractionDigits: 0 })}`;
  };

  const pctCell = v => {
    if (v == null) return '—';
    const n = num(v);
    const frac = Math.abs(n) > 1.5 ? n / 100 : n;
    const d = (frac * 100).toFixed(2) + '%';
    const clr = frac < 0 ? '#f87171' : frac > 0.08 ? '#4ade80' : '#facc15';
    return <span style={{ color: clr, fontWeight: 600 }}>{d}</span>;
  };

  // For each row, 100% Limit = Risk+Cat layer limits; 100% Premium = earned premium total.
  // Other cedant rows without NP layer breakdown fall back to API fields.
  const getLim100 = r => {
    if (isCur(r)) return cur100Limit;
    return num(ga(r, 'limit', 'treaty_limit', 'total_limit', 'capacity'));
  };
  const getPrem100 = r => {
    if (isCur(r)) return cur100Prem;
    return num(ga(r, 'premium', 'epi', 'premium_amt', 'written_premium'));
  };

  const parsePct = s => { const v = parseFloat(String(s).replace('%', '').trim()); return Number.isFinite(v) ? v / 100 : 0; };
  const getActLim = r => { const lp = parsePct(lineSizes[idOf(r)] || ''); return lp > 0 ? getLim100(r) * lp : 0; };
  const getActSz  = r => { const lp = parsePct(lineSizes[idOf(r)] || ''); return lp > 0 ? getPrem100(r) * lp : 0; };

  const included = rows.filter(r => includeMap[idOf(r)] !== false);
  const totLim100  = included.reduce((a, r) => a + getLim100(r),  0);
  const totPrem100 = included.reduce((a, r) => a + getPrem100(r), 0);
  const totActLim  = included.reduce((a, r) => a + getActLim(r),  0);
  const totActSz   = included.reduce((a, r) => a + getActSz(r),   0);
  const wAvg = fn => {
    if (!included.length || totPrem100 === 0) return null;
    return included.reduce((a, r) => a + fn(r) * getPrem100(r), 0) / totPrem100;
  };
  const totModM = wAvg(r => num(ga(r, 'actuarial_margin', 'actuarialMargin', 'modelled_margin')));
  const totActM = wAvg(r => num(ga(r, 'actual_margin',    'actualMargin',    'margin_actual')));

  const allSelected = rows.length > 0 && rows.every(r => includeMap[idOf(r)] !== false);
  const toggleAll = () => { const m = { ...includeMap }; rows.forEach(r => { m[idOf(r)] = !allSelected; }); setIncludeMap(m); };
  const toggleOne = id => setIncludeMap(prev => ({ ...prev, [id]: !prev[id] }));
  const setLine = (id, val) => setLineSizes(prev => ({ ...prev, [id]: val }));

  const statusBadge = s => {
    const st = String(s || 'DRAFT').toUpperCase();
    const colors = {
      SIGNED: '#4ade80', DRAFT: '#94a3b8', NTU: '#00d4ff',
      DECLINED: '#f87171', AWAITING_APPROVAL: '#facc15', AWAITING_SIGNED_LINE: '#60a5fa',
    };
    const clr = colors[st] || colors.DRAFT;
    return (
      <span style={{
        fontSize: 11, fontWeight: 600, padding: '3px 10px', borderRadius: 20,
        border: `1px solid ${clr}40`, background: `${clr}18`, color: clr, whiteSpace: 'nowrap',
      }}>{st.replace(/_/g, ' ')}</span>
    );
  };

  const thS = {
    padding: '11px 10px', fontSize: 11, fontWeight: 700, letterSpacing: '.07em',
    textTransform: 'uppercase', color: 'rgba(255,255,255,0.45)',
    borderBottom: '1px solid rgba(255,255,255,0.1)', whiteSpace: 'nowrap',
    position: 'sticky', top: 0, zIndex: 3, background: 'rgba(15,26,46,0.98)',
  };
  const tdS = {
    padding: '10px 10px', verticalAlign: 'middle',
    borderBottom: '1px solid rgba(255,255,255,0.05)',
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%', fontSize: 13 }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 12,
        padding: '16px 20px',
        borderBottom: '1px solid rgba(255,255,255,0.08)',
        flexShrink: 0, flexWrap: 'wrap',
      }}>
        <div style={{ flex: 1, minWidth: 200 }}>
          <div style={{ fontWeight: 700, fontSize: 16, color: '#fff' }}>Cedant Programmes (NP)</div>
          <div style={{ color: 'rgba(255,255,255,0.45)', fontSize: 12, marginTop: 2 }}>
            100% Limit = Risk + Cat layer limits combined · 100% Premium = total earned premium across all layers
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexShrink: 0 }}>
          <label style={{
            fontSize: 11, color: 'rgba(255,255,255,0.45)',
            letterSpacing: '.08em', textTransform: 'uppercase',
            fontWeight: 700, whiteSpace: 'nowrap',
          }}>UW Year</label>
          <select className="bbg-select" value={yearFilter} onChange={e => setYearFilter(e.target.value)} style={{ width: 110, height: 32, fontSize: 12 }}>
            <option value="ALL">All Years</option>
            {availableYears.map(y => <option key={y} value={y}>{y}</option>)}
          </select>
          <button className="bbg-btn" onClick={toggleAll} style={{ borderColor: 'rgba(0,212,255,0.4)', color: '#00d4ff' }}>
            {allSelected ? '☑ Deselect All' : '☑ Select All'}
          </button>
        </div>
      </div>

      {loading && (
        <div style={{ margin: '12px 20px', padding: '10px 16px', borderRadius: 8, background: 'rgba(0,212,255,0.08)', border: '1px solid rgba(0,212,255,0.2)', fontSize: 13, color: 'rgba(255,255,255,0.7)' }}>
          Loading cedant summary…
        </div>
      )}
      {!loading && rows.length === 0 && (
        <div style={{ margin: '12px 20px', padding: '10px 16px', borderRadius: 8, background: 'rgba(0,212,255,0.08)', border: '1px solid rgba(0,212,255,0.2)', fontSize: 13, color: 'rgba(255,255,255,0.7)' }}>
          No programmes found for this cedant{yearFilter !== 'ALL' ? ` in ${yearFilter}` : ''}
        </div>
      )}

      <div style={{ flex: 1, overflow: 'auto', minHeight: 0 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 13 }}>
          <thead>
            <tr>
              <th style={{ ...thS, textAlign: 'center', width: 48 }}></th>
              <th style={{ ...thS, textAlign: 'left',   width: 90 }}>UW Year</th>
              <th style={{ ...thS, textAlign: 'left',   width: 140 }}>Treaty Type</th>
              <th style={{ ...thS, textAlign: 'left' }}>Class of Business</th>
              <th style={{ ...thS, textAlign: 'center', width: 120 }}>Line Size %</th>
              <th style={{ ...thS, textAlign: 'right',  width: 160 }}>100% Limit</th>
              <th style={{ ...thS, textAlign: 'right',  width: 160 }}>100% Earned Prem</th>
              <th style={{ ...thS, textAlign: 'right',  width: 160, color: '#93c5fd' }}>Exposure (Share)</th>
              <th style={{ ...thS, textAlign: 'right',  width: 150, color: '#93c5fd' }}>Premium (Share)</th>
              <th style={{ ...thS, textAlign: 'right',  width: 140, color: '#86efac' }}>Modelled Margin</th>
              <th style={{ ...thS, textAlign: 'right',  width: 140, color: '#86efac' }}>Actual Margin</th>
              <th style={{ ...thS, textAlign: 'center', width: 140 }}>Status</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r, i) => {
              const id = idOf(r);
              const cur = isCur(r);
              const inc = includeMap[id] !== false;
              const year = getUwYear(r) || '—';
              const ttype = String(ga(r, 'treaty_type', 'treatyType', 'type') || '');
              const cob = String(ga(r, 'classOfBusiness', 'class_of_business', 'cob') || '—');
              const st = String(ga(r, 'status', 'decision', 'uw_status') || 'DRAFT');
              const lineVal = String(lineSizes[id] || '').replace('%', '').trim();
              return (
                <tr key={id + i} style={{
                  opacity: inc ? 1 : 0.35,
                  background: cur ? 'rgba(16,185,129,0.07)' : 'transparent',
                  borderLeft: cur ? '3px solid rgba(74,222,128,0.5)' : '3px solid transparent',
                  transition: 'opacity .15s',
                }}>
                  <td style={{ ...tdS, textAlign: 'center' }}>
                    <input type="checkbox" checked={inc} onChange={() => toggleOne(id)}
                      style={{ width: 16, height: 16, cursor: 'pointer', accentColor: '#00d4ff' }} />
                  </td>
                  <td style={{ ...tdS, fontVariantNumeric: 'tabular-nums', fontWeight: 600 }}>
                    {year}
                    {cur && <div style={{ fontSize: 10, color: '#4ade80', marginTop: 1 }}>Current</div>}
                  </td>
                  <td style={tdS}>{ttype}</td>
                  <td style={{ ...tdS, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 280 }} title={cob}>
                    {cob}
                  </td>
                  <td style={tdS}>
                    <PctInput
                      value={lineVal}
                      onChange={v => setLine(id, v)}
                      placeholder="0%"
                      className=""
                      style={{
                        background: 'rgba(255,255,255,0.07)',
                        border: '1px solid rgba(255,255,255,0.15)',
                        borderRadius: 8, height: 34, maxWidth: 110, width: '100%',
                        padding: '0 8px', fontSize: 13, color: '#fff', textAlign: 'right',
                        fontFamily: 'inherit', outline: 'none',
                      }}
                    />
                  </td>
                  <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{moneyFmt(getLim100(r))}</td>
                  <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>{moneyFmt(getPrem100(r))}</td>
                  <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#60a5fa' }}>
                    {getActLim(r) ? moneyFmt(getActLim(r)) : '—'}
                  </td>
                  <td style={{ ...tdS, textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: '#60a5fa' }}>
                    {getActSz(r) ? moneyFmt(getActSz(r)) : '—'}
                  </td>
                  <td style={{ ...tdS, textAlign: 'right' }}>{pctCell(ga(r, 'actuarial_margin', 'actuarialMargin', 'modelled_margin'))}</td>
                  <td style={{ ...tdS, textAlign: 'right' }}>{pctCell(ga(r, 'actual_margin',    'actualMargin',    'margin_actual'))}</td>
                  <td style={{ ...tdS, textAlign: 'center' }}>{statusBadge(st)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot style={{ position: 'sticky', bottom: 0, zIndex: 2 }}>
            <tr style={{ background: 'rgba(15,26,46,0.98)' }}>
              <td style={{ ...tdS, borderTop: '2px solid rgba(255,255,255,0.15)' }}></td>
              <td style={{ ...tdS, borderTop: '2px solid rgba(255,255,255,0.15)', fontWeight: 700, fontSize: 11, letterSpacing: '.06em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.5)' }}>Totals</td>
              <td style={{ ...tdS, borderTop: '2px solid rgba(255,255,255,0.15)' }} colSpan={3}></td>
              <td style={{ ...tdS, borderTop: '2px solid rgba(255,255,255,0.15)', textAlign: 'right', fontWeight: 700 }}>{moneyFmt(totLim100)}</td>
              <td style={{ ...tdS, borderTop: '2px solid rgba(255,255,255,0.15)', textAlign: 'right', fontWeight: 700 }}>{moneyFmt(totPrem100)}</td>
              <td style={{ ...tdS, borderTop: '2px solid rgba(255,255,255,0.15)', textAlign: 'right', fontWeight: 700, color: '#60a5fa' }}>
                {totActLim ? moneyFmt(totActLim) : '—'}
              </td>
              <td style={{ ...tdS, borderTop: '2px solid rgba(255,255,255,0.15)', textAlign: 'right', fontWeight: 700, color: '#60a5fa' }}>
                {totActSz ? moneyFmt(totActSz) : '—'}
              </td>
              <td style={{ ...tdS, borderTop: '2px solid rgba(255,255,255,0.15)', textAlign: 'right', fontWeight: 700 }}>{pctCell(totModM)}</td>
              <td style={{ ...tdS, borderTop: '2px solid rgba(255,255,255,0.15)', textAlign: 'right', fontWeight: 700 }}>{pctCell(totActM)}</td>
              <td style={{ ...tdS, borderTop: '2px solid rgba(255,255,255,0.15)' }}></td>
            </tr>
          </tfoot>
        </table>
      </div>
    </div>
  );
}
