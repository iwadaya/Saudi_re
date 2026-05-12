// src/screens/non_proportional/historical_performance/NpHistoricalPerformance.jsx
import { useState, useEffect, useCallback, useMemo } from 'react';
import api from '../../../api';
import { useAppState } from '../../../context/AppContext';
import { useContractId } from '../../../hooks/useContractId';
import { useScreenSave } from '../../../hooks/useScreenSave';
import WizardLayout from '../../../components/WizardLayout';
import { toN } from '../../../utils/format';

const ROUTE_KEY = 'NP_HISTORICAL_PERFORMANCE';

const fmtC = v => { const n = Number(String(v ?? '').replace(/[^0-9.-]/g, '')); return Number.isFinite(n) && n !== 0 ? Math.round(n).toLocaleString('en-US') : ''; };
const numOrEmpty = v => (v == null || v === '' || v === 0) ? '' : String(v);
const stripNum = v => String(v ?? '').replace(/[^0-9.-]/g, '');

// Editable fields in column order (matches paste order from Excel)
const EDIT_FIELDS = ['premiums', 'claims', 'egnpi', 'expense_ratio'];

export default function NpHistoricalPerformance() {
  const contractId = useContractId();
  const { state: appState } = useAppState();

  const npDetail = appState.npTreatyDetail || {};
  const startYear = parseInt(npDetail.experienceStartYear || npDetail.startYear || '2015', 10);
  const uwYear = parseInt(npDetail.startYear || new Date().getFullYear(), 10);

  const [rows, setRows] = useState([]);
  const [showMA, setShowMA] = useState(false);
  const [maWindow, setMaWindow] = useState(3);

  const yearRange = useMemo(() => {
    const years = [];
    for (let y = startYear; y <= uwYear; y++) years.push(y);
    return years;
  }, [startYear, uwYear]);

  // Server load → map rows into yearRange, defaulting expense_ratio to 10
  const hydrate = useCallback((data) => {
    const serverMap = {};
    for (const r of (data || [])) serverMap[r.uw_year] = r;
    setRows(yearRange.map(y => {
      const s = serverMap[y] || {};
      return {
        uw_year: y,
        premiums: numOrEmpty(s.premiums),
        claims: numOrEmpty(s.claims),
        egnpi: numOrEmpty(s.egnpi),
        expense_ratio: numOrEmpty(s.expense_ratio) || '10',
      };
    }));
  }, [yearRange]);

  // The save payload is rows + computed ratios — we'd need to access
  // `computedRows` from inside the hook's save fn, so we pass a thunk
  // that closes over it.
  const persist = useCallback((id, snapshot) => {
    const payload = snapshot.map(r => ({
      uw_year: r.uw_year,
      premiums: toN(r.premiums) || null,
      claims: toN(r.claims) || null,
      egnpi: toN(r.egnpi) || null,
      result: r.result || null,
      loss_ratio: r.loss_ratio || null,
      expense_ratio: toN(r.expense_ratio) || null,
      combined_ratio: r.combined_ratio || null,
    }));
    return api.saveNpHistoricalPerformance(id, payload);
  }, []);

  const { save, markDirty, loadedRef } = useScreenSave({
    entityId: contractId || '',
    load: api.getNpHistoricalPerformance,
    save: persist,
    currentState: () => computedRows,
    onLoaded: hydrate,
    errorLabel: 'Historical performance',
  });

  // Sync rows when yearRange changes (only after the initial hydrate)
  useEffect(() => {
    if (!loadedRef.current) return;
    setRows(prev => {
      const map = {};
      for (const r of prev) map[r.uw_year] = r;
      return yearRange.map(y => map[y] || { uw_year: y, premiums: '', claims: '', egnpi: '', expense_ratio: '10' });
    });
  }, [yearRange, loadedRef]);

  const updateRow = useCallback((idx, field, val) => {
    setRows(prev => { const next = [...prev]; next[idx] = { ...next[idx], [field]: val }; return next; });
    markDirty();
  }, [markDirty]);

  // Paste handler — supports tab/newline-separated data from Excel
  const handlePaste = useCallback((e, rowIdx, colIdx) => {
    const text = e.clipboardData?.getData('text/plain');
    if (!text) return;

    // Split by newlines then tabs
    const pasteRows = text.split(/[\r\n]+/).filter(Boolean).map(line => line.split('\t'));

    // If single cell paste, let default handler work
    if (pasteRows.length === 1 && pasteRows[0].length === 1) {
      // Still strip to number
      e.preventDefault();
      const val = stripNum(pasteRows[0][0]);
      updateRow(rowIdx, EDIT_FIELDS[colIdx], val);
      return;
    }

    // Multi-cell paste
    e.preventDefault();
    setRows(prev => {
      const next = [...prev];
      for (let ri = 0; ri < pasteRows.length; ri++) {
        const targetRow = rowIdx + ri;
        if (targetRow >= next.length) break;
        for (let ci = 0; ci < pasteRows[ri].length; ci++) {
          const targetCol = colIdx + ci;
          if (targetCol >= EDIT_FIELDS.length) break;
          next[targetRow] = { ...next[targetRow], [EDIT_FIELDS[targetCol]]: stripNum(pasteRows[ri][ci]) };
        }
      }
      return next;
    });
    markDirty();
  }, [markDirty, updateRow]);

  // Computed fields
  const computedRows = useMemo(() => rows.map(r => {
    const prem = toN(r.premiums);
    const claims = toN(r.claims);
    const expR = toN(r.expense_ratio);
    const result = prem ? prem - claims : 0;
    const lossRatio = prem ? (claims / prem) * 100 : 0;
    const combinedRatio = lossRatio + expR;
    return { ...r, result, loss_ratio: lossRatio, combined_ratio: combinedRatio };
  }), [rows]);

  // Totals
  const totals = useMemo(() => {
    const n = computedRows.length;
    if (!n) return null;
    const sumPrem = computedRows.reduce((s, r) => s + toN(r.premiums), 0);
    const sumClaims = computedRows.reduce((s, r) => s + toN(r.claims), 0);
    const sumEgnpi = computedRows.reduce((s, r) => s + toN(r.egnpi), 0);
    const sumResult = sumPrem - sumClaims;
    const avgLR = sumPrem ? (sumClaims / sumPrem) * 100 : 0;
    const avgER = computedRows.reduce((s, r) => s + toN(r.expense_ratio), 0) / n;
    return { premiums: sumPrem, claims: sumClaims, egnpi: sumEgnpi, result: sumResult, loss_ratio: avgLR, expense_ratio: avgER, combined_ratio: avgLR + avgER };
  }, [computedRows]);

  // Moving averages
  const maRows = useMemo(() => {
    const w = Math.max(2, Math.min(10, maWindow));
    return computedRows.map((r, i) => {
      if (i < w - 1) return { ...r, ma_lr: null, ma_er: null, ma_cr: null, ma_prem: null, ma_claims: null };
      const win = computedRows.slice(i - w + 1, i + 1);
      const wPrem = win.reduce((s, wr) => s + toN(wr.premiums), 0);
      const wClaims = win.reduce((s, wr) => s + toN(wr.claims), 0);
      const wER = win.reduce((s, wr) => s + toN(wr.expense_ratio), 0) / w;
      const wLR = wPrem ? (wClaims / wPrem) * 100 : 0;
      return { ...r, ma_lr: wLR, ma_er: wER, ma_cr: wLR + wER, ma_prem: wPrem / w, ma_claims: wClaims / w };
    });
  }, [computedRows, maWindow]);

  // ── Styles ──
  const thS = { padding: '11px 10px', fontSize: 9, fontWeight: 800, letterSpacing: '.12em', textTransform: 'uppercase', color: 'rgba(255,255,255,0.45)', borderBottom: '1px solid rgba(255,255,255,0.10)', whiteSpace: 'nowrap', textAlign: 'center', background: '#050810' };
  const tdS = { padding: '7px 8px', textAlign: 'center', borderBottom: '1px solid rgba(255,255,255,0.05)', fontVariantNumeric: 'tabular-nums', fontSize: 12, verticalAlign: 'middle' };
  const inputS = { background: 'rgba(255,255,255,0.03)', border: '1px solid rgba(255,255,255,0.08)', borderRadius: 6, color: 'rgba(226,232,240,0.90)', padding: '6px 10px', height: 32, width: '100%', textAlign: 'center', fontSize: 12, outline: 'none', fontVariantNumeric: 'tabular-nums', fontWeight: 600 };
  const readonlyS = { ...tdS, color: 'rgba(148,163,184,0.70)', fontWeight: 600 };

  const lrColor = v => v > 100 ? '#f87171' : v > 80 ? '#fbbf24' : '#4ade80';
  const crColor = v => v > 110 ? '#f87171' : v > 95 ? '#fbbf24' : '#4ade80';

  // ── Comma input component ──
  const CInput = ({ value, onChange, onPaste, placeholder }) => {
    const display = fmtC(value);
    const handleChange = e => onChange(stripNum(e.target.value));
    return <input style={inputS} value={display} onChange={handleChange} onPaste={onPaste} placeholder={placeholder || '0'} />;
  };

  return (
    <WizardLayout routeKey={ROUTE_KEY} title="Historical Performance" headerPill="NP TREATY" onBeforeNext={save} onBeforeBack={save}>
      <div style={{ maxWidth: 1100, margin: '0 auto', padding: '8px 0 40px' }}>

        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div>
            <div style={{ fontSize: 13, fontWeight: 700, color: 'rgba(226,232,240,0.90)' }}>Underwriting Year Performance</div>
            <div style={{ fontSize: 11, color: 'rgba(148,163,184,0.50)', marginTop: 2 }}>
              {startYear} – {uwYear} · {yearRange.length} years · Paste from Excel supported
            </div>
          </div>
          <button onClick={() => setShowMA(true)} style={{
            appearance: 'none', border: '1px solid rgba(0,212,255,0.30)', background: 'rgba(0,212,255,0.06)',
            color: '#00d4ff', borderRadius: 8, padding: '7px 16px', fontSize: 11, fontWeight: 700, cursor: 'pointer',
          }}>📊 Moving Averages</button>
        </div>

        {/* ── Main table ── */}
        <div style={{ overflowX: 'auto', borderRadius: 12, border: '1px solid rgba(255,255,255,0.06)' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 900, tableLayout: 'fixed' }}>
            <colgroup>
              <col style={{ width: '8%' }} />
              <col style={{ width: '14%' }} />
              <col style={{ width: '14%' }} />
              <col style={{ width: '14%' }} />
              <col style={{ width: '12%' }} />
              <col style={{ width: '12%' }} />
              <col style={{ width: '12%' }} />
              <col style={{ width: '14%' }} />
            </colgroup>
            <thead>
              <tr>
                <th style={{ ...thS, textAlign: 'center' }}>UW Year</th>
                <th style={thS}>Premiums</th>
                <th style={thS}>Claims</th>
                <th style={thS}>EGNPI</th>
                <th style={thS}>Result</th>
                <th style={thS}>Loss Ratio</th>
                <th style={thS}>Expense Ratio</th>
                <th style={thS}>Combined Ratio</th>
              </tr>
            </thead>
            <tbody>
              {computedRows.map((r, i) => (
                <tr key={r.uw_year} style={{ background: i % 2 === 0 ? '#080f23' : '#0a1125' }}>
                  <td style={{ ...tdS, fontWeight: 800, color: 'rgba(0,212,255,0.70)', fontSize: 13 }}>{r.uw_year}</td>
                  <td style={tdS}><CInput value={r.premiums} onChange={v => updateRow(i, 'premiums', v)} onPaste={e => handlePaste(e, i, 0)} /></td>
                  <td style={tdS}><CInput value={r.claims} onChange={v => updateRow(i, 'claims', v)} onPaste={e => handlePaste(e, i, 1)} /></td>
                  <td style={tdS}><CInput value={r.egnpi} onChange={v => updateRow(i, 'egnpi', v)} onPaste={e => handlePaste(e, i, 2)} /></td>
                  <td style={{ ...readonlyS, color: r.result >= 0 ? '#4ade80' : '#f87171', fontWeight: 700 }}>{r.result ? fmtC(r.result) : '—'}</td>
                  <td style={{ ...readonlyS, color: r.loss_ratio ? lrColor(r.loss_ratio) : undefined, fontWeight: 700 }}>{r.loss_ratio ? r.loss_ratio.toFixed(1) + '%' : '—'}</td>
                  <td style={tdS}>
                    <input style={{ ...inputS, width: 80, margin: '0 auto' }} value={numOrEmpty(r.expense_ratio)}
                      onChange={e => updateRow(i, 'expense_ratio', e.target.value)}
                      onPaste={e => handlePaste(e, i, 3)} placeholder="10" />
                  </td>
                  <td style={{ ...readonlyS, color: r.combined_ratio ? crColor(r.combined_ratio) : undefined, fontWeight: 800, fontSize: 13 }}>
                    {r.combined_ratio ? r.combined_ratio.toFixed(1) + '%' : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
            {totals && (
              <tfoot>
                <tr style={{ background: '#060c1a', borderTop: '2px solid rgba(255,255,255,0.10)' }}>
                  <td style={{ ...tdS, fontWeight: 800, fontSize: 10, letterSpacing: '.10em', color: 'rgba(148,163,184,0.55)' }}>TOTAL / AVG</td>
                  <td style={{ ...tdS, fontWeight: 700, color: 'rgba(226,232,240,0.85)' }}>{fmtC(totals.premiums)}</td>
                  <td style={{ ...tdS, fontWeight: 700, color: 'rgba(226,232,240,0.85)' }}>{fmtC(totals.claims)}</td>
                  <td style={{ ...tdS, fontWeight: 700, color: 'rgba(226,232,240,0.85)' }}>{fmtC(totals.egnpi)}</td>
                  <td style={{ ...tdS, fontWeight: 700, color: totals.result >= 0 ? '#4ade80' : '#f87171' }}>{fmtC(totals.result)}</td>
                  <td style={{ ...tdS, fontWeight: 700, color: lrColor(totals.loss_ratio) }}>{totals.loss_ratio.toFixed(1)}%</td>
                  <td style={{ ...tdS, fontWeight: 700, color: 'rgba(226,232,240,0.70)' }}>{totals.expense_ratio.toFixed(1)}%</td>
                  <td style={{ ...tdS, fontWeight: 800, fontSize: 13, color: crColor(totals.combined_ratio) }}>{totals.combined_ratio.toFixed(1)}%</td>
                </tr>
              </tfoot>
            )}
          </table>
        </div>

        {/* ── Moving Averages Modal ── */}
        {showMA && (
          <div className="modal-backdrop" style={{
            position: 'fixed', inset: 0, zIndex: 1000,
            background: 'rgba(0,0,0,0.65)', display: 'flex', alignItems: 'center', justifyContent: 'center',
          }} onClick={e => e.target === e.currentTarget && setShowMA(false)}>
            <div className="glass" role="dialog" aria-modal="true" style={{
              background: '#0a1020', border: '1px solid rgba(255,255,255,0.10)',
              borderRadius: 18, width: 950, maxWidth: '95vw', maxHeight: '85vh', overflow: 'hidden',
              display: 'flex', flexDirection: 'column',
            }}>
              <div style={{ padding: '18px 24px', borderBottom: '1px solid rgba(255,255,255,0.08)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                <div>
                  <div style={{ fontSize: 15, fontWeight: 800, color: 'rgba(226,232,240,0.92)' }}>Moving Averages</div>
                  <div style={{ fontSize: 11, color: 'rgba(148,163,184,0.50)', marginTop: 2 }}>Rolling window analysis of underwriting performance</div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                  <label style={{ fontSize: 11, color: 'rgba(148,163,184,0.60)' }}>Window:</label>
                  <select value={maWindow} onChange={e => setMaWindow(Number(e.target.value))} style={{
                    background: 'rgba(255,255,255,0.05)', border: '1px solid rgba(255,255,255,0.12)',
                    borderRadius: 6, color: '#00d4ff', padding: '4px 8px', fontSize: 12, outline: 'none',
                  }}>
                    {[2, 3, 4, 5, 6, 7, 8, 10].map(w => <option key={w} value={w}>{w}-Year</option>)}
                  </select>
                  <button type="button" onClick={() => setShowMA(false)} aria-label="Close" style={{ appearance: 'none', border: 'none', background: 'transparent', color: 'rgba(148,163,184,0.60)', fontSize: 18, cursor: 'pointer' }}>✕</button>
                </div>
              </div>

              <div style={{ flex: 1, overflowY: 'auto', padding: '16px 24px' }}>
                <div style={{ overflowX: 'auto', borderRadius: 10, border: '1px solid rgba(255,255,255,0.06)' }}>
                  <table style={{ width: '100%', borderCollapse: 'collapse', minWidth: 800, tableLayout: 'fixed' }}>
                    <colgroup>
                      <col style={{ width: '8%' }} />
                      <col style={{ width: '11%' }} />
                      <col style={{ width: '11%' }} />
                      <col style={{ width: '10%' }} />
                      <col style={{ width: '12%' }} />
                      <col style={{ width: '12%' }} />
                      <col style={{ width: '12%' }} />
                      <col style={{ width: '12%' }} />
                      <col style={{ width: '12%' }} />
                    </colgroup>
                    <thead>
                      <tr>
                        <th style={{ ...thS, textAlign: 'center' }}>UW Year</th>
                        <th style={thS}>Premiums</th>
                        <th style={thS}>Claims</th>
                        <th style={thS}>Loss Ratio</th>
                        <th style={{ ...thS, color: '#00d4ff' }}>{maWindow}Y MA Prem</th>
                        <th style={{ ...thS, color: '#00d4ff' }}>{maWindow}Y MA Claims</th>
                        <th style={{ ...thS, color: '#00d4ff' }}>{maWindow}Y MA LR</th>
                        <th style={{ ...thS, color: '#fbbf24' }}>{maWindow}Y MA ER</th>
                        <th style={{ ...thS, color: '#a855f7' }}>{maWindow}Y MA CR</th>
                      </tr>
                    </thead>
                    <tbody>
                      {maRows.map((r, i) => (
                        <tr key={r.uw_year} style={{ background: i % 2 === 0 ? '#080f23' : '#0a1125' }}>
                          <td style={{ ...tdS, fontWeight: 700, color: 'rgba(0,212,255,0.70)' }}>{r.uw_year}</td>
                          <td style={{ ...tdS, color: 'rgba(226,232,240,0.70)' }}>{fmtC(toN(r.premiums))}</td>
                          <td style={{ ...tdS, color: 'rgba(226,232,240,0.70)' }}>{fmtC(toN(r.claims))}</td>
                          <td style={{ ...tdS, color: r.loss_ratio ? lrColor(r.loss_ratio) : 'rgba(148,163,184,0.40)', fontWeight: 600 }}>{r.loss_ratio ? r.loss_ratio.toFixed(1) + '%' : '—'}</td>
                          <td style={{ ...tdS, color: '#00d4ff', fontWeight: 600 }}>{r.ma_prem != null ? fmtC(Math.round(r.ma_prem)) : '—'}</td>
                          <td style={{ ...tdS, color: '#00d4ff', fontWeight: 600 }}>{r.ma_claims != null ? fmtC(Math.round(r.ma_claims)) : '—'}</td>
                          <td style={{ ...tdS, color: r.ma_lr != null ? lrColor(r.ma_lr) : 'rgba(148,163,184,0.40)', fontWeight: 700 }}>{r.ma_lr != null ? r.ma_lr.toFixed(1) + '%' : '—'}</td>
                          <td style={{ ...tdS, color: '#fbbf24', fontWeight: 600 }}>{r.ma_er != null ? r.ma_er.toFixed(1) + '%' : '—'}</td>
                          <td style={{ ...tdS, color: r.ma_cr != null ? crColor(r.ma_cr) : 'rgba(148,163,184,0.40)', fontWeight: 800, fontSize: 13 }}>{r.ma_cr != null ? r.ma_cr.toFixed(1) + '%' : '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* MA Summary Cards */}
                {(() => {
                  const filled = maRows.filter(r => r.ma_lr != null);
                  if (!filled.length) return null;
                  const avgLR = filled.reduce((s, r) => s + r.ma_lr, 0) / filled.length;
                  const avgCR = filled.reduce((s, r) => s + r.ma_cr, 0) / filled.length;
                  const minLR = Math.min(...filled.map(r => r.ma_lr));
                  const maxLR = Math.max(...filled.map(r => r.ma_lr));
                  const trend = filled.length >= 2 ? filled[filled.length - 1].ma_cr - filled[filled.length - 2].ma_cr : null;
                  return (
                    <div style={{ display: 'grid', gridTemplateColumns: 'repeat(4, 1fr)', gap: 10, marginTop: 16 }}>
                      {[
                        { label: `Avg ${maWindow}Y MA Loss Ratio`, value: avgLR.toFixed(1) + '%', color: lrColor(avgLR) },
                        { label: `Avg ${maWindow}Y MA Combined`, value: avgCR.toFixed(1) + '%', color: crColor(avgCR) },
                        { label: 'MA Loss Ratio Range', value: `${minLR.toFixed(1)}% – ${maxLR.toFixed(1)}%`, color: 'rgba(226,232,240,0.70)' },
                        { label: 'Latest MA Trend', value: trend != null ? `${trend > 0 ? '▲' : '▼'} ${Math.abs(trend).toFixed(1)}pp` : '—', color: trend != null ? (trend > 0 ? '#f87171' : '#4ade80') : 'rgba(148,163,184,0.40)' },
                      ].map(({ label, value, color }) => (
                        <div key={label} style={{ background: 'rgba(255,255,255,0.02)', border: '1px solid rgba(255,255,255,0.06)', borderRadius: 10, padding: '12px 14px', textAlign: 'center' }}>
                          <div style={{ fontSize: 9, fontWeight: 800, letterSpacing: '.10em', textTransform: 'uppercase', color: 'rgba(148,163,184,0.45)', marginBottom: 4 }}>{label}</div>
                          <div style={{ fontSize: 18, fontWeight: 900, color }}>{value}</div>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>
            </div>
          </div>
        )}
      </div>
    </WizardLayout>
  );
}
