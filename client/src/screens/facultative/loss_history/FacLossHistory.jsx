// src/screens/facultative/loss_history/FacLossHistory.jsx
import { useCallback, useMemo, useState } from 'react';
import api from '../../../api';
import WizardLayout from '../../../components/WizardLayout';
import { useScreenSave } from '../../../hooks/useScreenSave';
import { useFacRiskId } from '../../../hooks/useContractId';

const ROUTE_KEY = 'FAC_LOSS_HISTORY';
const numOrNull = v => { const c = String(v ?? '').replace(/,/g,'').trim(); if (!c) return null; const n = Number(c); return Number.isFinite(n) ? n : null; };
const fmtComma = v => { const d = String(v ?? '').replace(/[^\d]/g,''); return d ? Number(d).toLocaleString('en-US') : ''; };
const stripDigits = v => String(v ?? '').replace(/[^\d]/g,'');
const cleanNum = v => { if (v == null || v === '') return ''; const n = Number(v); if (!Number.isFinite(n)) return String(v); return n === Math.floor(n) ? String(Math.floor(n)) : String(n); };

const BLANK = () => ({ loss_year: new Date().getFullYear(), loss_date: '', loss_description: '', cause_of_loss: '', fgu_paid: '', fgu_outstanding: '', mitigation_measures: '', is_open: true, _key: Math.random() });

export default function FacLossHistory() {
  const riskId = useFacRiskId();
  const [rows, setRows] = useState([]);

  const hydrate = useCallback((data) => {
    setRows((data || []).map(r => ({
      ...r,
      loss_year: r.loss_year || '',
      loss_date: r.loss_date ? String(r.loss_date).substring(0, 10) : '',
      fgu_paid: cleanNum(r.fgu_paid) || '',
      fgu_outstanding: cleanNum(r.fgu_outstanding) || '',
      _key: r.loss_id || Math.random(),
    })));
  }, []);

  const saveLosses = useCallback(
    (id, state) => api.facSaveLosses(
      id,
      state.filter(r => r.loss_year || r.loss_description || numOrNull(r.fgu_paid) || numOrNull(r.fgu_outstanding)).map(r => ({
        loss_year: numOrNull(r.loss_year), loss_date: r.loss_date || null,
        loss_description: r.loss_description, cause_of_loss: r.cause_of_loss,
        fgu_paid: numOrNull(r.fgu_paid), fgu_outstanding: numOrNull(r.fgu_outstanding),
        mitigation_measures: r.mitigation_measures, is_open: r.is_open,
      })),
    ),
    [],
  );

  const { save, markDirty } = useScreenSave({
    entityId: riskId || '',
    load: api.facGetLosses,
    save: saveLosses,
    currentState: () => rows,
    onLoaded: hydrate,
    errorLabel: 'Loss history',
  });

  const setRow = (i, k, v) => { setRows(prev => prev.map((r, j) => j === i ? { ...r, [k]: v } : r)); markDirty(); };
  const addRow = () => { setRows(prev => [...prev, BLANK()]); markDirty(); };
  const removeRow = i => { setRows(prev => prev.filter((_, j) => j !== i)); markDirty(); };

  const totalPaid = rows.reduce((s, r) => s + (numOrNull(r.fgu_paid) || 0), 0);
  const totalOS = rows.reduce((s, r) => s + (numOrNull(r.fgu_outstanding) || 0), 0);

  // ── Ten-year rolling matrix ───────────────────────────────────────────
  // Rows: current UW year + 9 prior years (always 10, even when sparse).
  // Columns: claim count, FGU paid / O/S / incurred, RI incurred, as-if
  // claim ratio. Premium-per-year isn't captured anywhere yet, so the
  // claim-ratio column shows '—' until a future change wires it in.
  const matrix = useMemo(() => {
    const thisYear = new Date().getFullYear();
    const years = Array.from({ length: 10 }, (_, i) => thisYear - i);
    const buckets = new Map(years.map((y) => [y, {
      year: y, count: 0, fguPaid: 0, fguOS: 0, fguIncurred: 0, riIncurred: 0,
    }]));
    for (const r of rows) {
      const y = Number(r.loss_year);
      if (!Number.isFinite(y)) continue;
      const b = buckets.get(y);
      if (!b) continue;
      const paid = numOrNull(r.fgu_paid) || 0;
      const os = numOrNull(r.fgu_outstanding) || 0;
      // ri_paid / ri_outstanding aren't captured by this screen yet, but
      // they may arrive through other flows — include defensively so the
      // RI incurred column is right when they exist.
      const riPaid = numOrNull(r.ri_paid) || 0;
      const riOs = numOrNull(r.ri_outstanding) || 0;
      b.count += 1;
      b.fguPaid += paid;
      b.fguOS += os;
      b.fguIncurred += paid + os;
      b.riIncurred += riPaid + riOs;
    }
    return Array.from(buckets.values());
  }, [rows]);
  const fmt0 = (n) => (Number.isFinite(n) && n !== 0 ? Math.round(n).toLocaleString('en-US') : '—');

  return (
    <WizardLayout routeKey={ROUTE_KEY} title="Loss History" headerPill="FACULTATIVE" onBeforeNext={save} onBeforeBack={save}>
      <div style={{ maxWidth: 1000, margin: '0 auto', padding: '8px 0 40px' }}>
        <div style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 16 }}>
          FGU (from the ground up) loss experience — minimum 3 years. Enter all material losses with details and mitigation measures taken.
        </div>

        {/* ── Ten-year matrix ── */}
        <div style={{ marginBottom: 24 }}>
          <div style={{ fontSize: 11, fontWeight: 800, letterSpacing: '.14em',
                        textTransform: 'uppercase', color: 'rgba(var(--accent-blue-rgb),0.75)',
                        marginBottom: 10, paddingBottom: 6,
                        borderBottom: '1px solid var(--hairline)' }}>
            10-Year Loss Matrix
          </div>
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
            <thead>
              <tr style={{ background: 'var(--table-head-bg)' }}>
                {['Year', 'Claims', 'FGU Paid', 'FGU O/S', 'FGU Incurred', 'RI Incurred', 'As-if Claim Ratio'].map((h) => (
                  <th key={h} style={{ padding: '8px 10px',
                                       textAlign: h === 'Year' ? 'left' : 'right',
                                       fontSize: 9, fontWeight: 800, letterSpacing: '.10em',
                                       textTransform: 'uppercase', color: 'var(--muted)',
                                       borderBottom: '1px solid var(--hairline)',
                                       whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {matrix.map((m) => (
                <tr key={m.year} style={{ borderBottom: '1px solid var(--hairline)' }}>
                  <td style={{ padding: '6px 10px', fontVariantNumeric: 'tabular-nums',
                                color: 'rgba(var(--text-rgb),0.80)', fontWeight: 700 }}>{m.year}</td>
                  <td style={{ padding: '6px 10px', textAlign: 'right',
                                fontVariantNumeric: 'tabular-nums',
                                color: m.count ? 'rgba(var(--text-rgb),0.85)' : 'rgba(var(--text-rgb),0.4)' }}>
                    {m.count || '—'}
                  </td>
                  <td style={{ padding: '6px 10px', textAlign: 'right',
                                fontVariantNumeric: 'tabular-nums',
                                color: m.fguPaid ? 'var(--accent-rose)' : 'rgba(var(--text-rgb),0.4)' }}>
                    {fmt0(m.fguPaid)}
                  </td>
                  <td style={{ padding: '6px 10px', textAlign: 'right',
                                fontVariantNumeric: 'tabular-nums',
                                color: m.fguOS ? 'var(--accent-amber)' : 'rgba(var(--text-rgb),0.4)' }}>
                    {fmt0(m.fguOS)}
                  </td>
                  <td style={{ padding: '6px 10px', textAlign: 'right',
                                fontVariantNumeric: 'tabular-nums',
                                fontWeight: 700,
                                color: m.fguIncurred ? 'var(--accent)' : 'rgba(var(--text-rgb),0.4)' }}>
                    {fmt0(m.fguIncurred)}
                  </td>
                  <td style={{ padding: '6px 10px', textAlign: 'right',
                                fontVariantNumeric: 'tabular-nums',
                                color: m.riIncurred ? 'rgba(var(--text-rgb),0.85)' : 'rgba(var(--text-rgb),0.4)' }}>
                    {fmt0(m.riIncurred)}
                  </td>
                  <td style={{ padding: '6px 10px', textAlign: 'right',
                                color: 'rgba(var(--text-rgb),0.4)' }}>—</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div style={{ marginTop: 6, fontSize: 10, color: 'rgba(var(--text-rgb),0.5)' }}>
            As-if claim ratio shows &lsquo;—&rsquo; until premium-per-year is captured against this risk.
          </div>
        </div>

        {rows.length === 0 ? (
          <div style={{ padding: 40, textAlign: 'center', color: 'rgba(var(--text-rgb),0.55)', fontSize: 12, background: 'var(--control-bg)', borderRadius: 12, border: '1px solid var(--hairline)' }}>
            No losses recorded. <span role="button" tabIndex={0} style={{ color: 'var(--accent)', cursor: 'pointer' }}
              onClick={addRow}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); addRow(); }
              }}>Add a loss record →</span>
            <div style={{ marginTop: 8, fontSize: 11, color: 'rgba(var(--text-rgb),0.4)' }}>A clean loss history is positive for pricing.</div>
          </div>
        ) : (
          <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 12 }}>
            <thead>
              <tr style={{ background: 'var(--table-head-bg)' }}>
                {['Year', 'Date', 'Description', 'Cause', 'FGU Paid', 'FGU O/S', 'FGU Incurred', 'Mitigation', ''].map(h => (
                  <th key={h} style={{ padding: '8px 8px', textAlign: ['FGU Paid','FGU O/S','FGU Incurred'].includes(h) ? 'right' : 'left', fontSize: 9, fontWeight: 800, letterSpacing: '.10em', textTransform: 'uppercase', color: 'var(--muted)', borderBottom: '1px solid var(--hairline)', whiteSpace: 'nowrap' }}>{h}</th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((r, i) => {
                const incurred = (numOrNull(r.fgu_paid) || 0) + (numOrNull(r.fgu_outstanding) || 0);
                return (
                  <tr key={r._key} style={{ borderBottom: '1px solid var(--hairline)' }}>
                    <td style={{ padding: '4px 4px', width: 70 }}><input className="fi" type="number" value={r.loss_year} onChange={e => setRow(i, 'loss_year', e.target.value)} style={{ width: 65, fontSize: 12 }} /></td>
                    <td style={{ padding: '4px 4px', width: 120 }}><input className="fi" type="date" value={r.loss_date} onChange={e => setRow(i, 'loss_date', e.target.value)} style={{ fontSize: 11 }} /></td>
                    <td style={{ padding: '4px 4px' }}><input className="fi" value={r.loss_description || ''} onChange={e => setRow(i, 'loss_description', e.target.value)} placeholder="Loss details" style={{ fontSize: 12 }} /></td>
                    <td style={{ padding: '4px 4px', width: 110 }}><input className="fi" value={r.cause_of_loss || ''} onChange={e => setRow(i, 'cause_of_loss', e.target.value)} placeholder="Cause" style={{ fontSize: 12 }} /></td>
                    <td style={{ padding: '4px 4px', width: 110 }}><input className="fi" type="text" inputMode="numeric" value={fmtComma(r.fgu_paid)} onChange={e => setRow(i, 'fgu_paid', stripDigits(e.target.value))} style={{ textAlign: 'right', fontSize: 12 }} /></td>
                    <td style={{ padding: '4px 4px', width: 110 }}><input className="fi" type="text" inputMode="numeric" value={fmtComma(r.fgu_outstanding)} onChange={e => setRow(i, 'fgu_outstanding', stripDigits(e.target.value))} style={{ textAlign: 'right', fontSize: 12 }} /></td>
                    <td style={{ padding: '6px 8px', textAlign: 'right', fontVariantNumeric: 'tabular-nums', color: incurred ? 'var(--accent-amber)' : 'rgba(var(--text-rgb),0.4)', width: 110 }}>{incurred ? incurred.toLocaleString('en-US') : '—'}</td>
                    <td style={{ padding: '4px 4px', width: 140 }}><input className="fi" value={r.mitigation_measures || ''} onChange={e => setRow(i, 'mitigation_measures', e.target.value)} placeholder="Actions taken" style={{ fontSize: 11 }} /></td>
                    <td style={{ padding: '4px 4px', width: 28 }}><span role="button" tabIndex={0} aria-label="Remove loss record"
                      style={{ cursor: 'pointer', color: 'var(--accent-rose)', fontSize: 16 }}
                      onClick={() => removeRow(i)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); removeRow(i); }
                      }}>×</span></td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              <tr style={{ borderTop: '2px solid rgba(var(--accent-blue-rgb),0.20)' }}>
                <td colSpan={4} style={{ padding: '8px 8px', fontSize: 11, fontWeight: 700, color: 'rgba(var(--accent-blue-rgb),0.80)' }}>TOTAL ({rows.length} losses)</td>
                <td style={{ padding: '8px 8px', textAlign: 'right', fontWeight: 700, color: 'var(--accent-rose)', fontSize: 12 }}>{totalPaid ? totalPaid.toLocaleString('en-US') : '—'}</td>
                <td style={{ padding: '8px 8px', textAlign: 'right', fontWeight: 700, color: 'var(--accent-amber)', fontSize: 12 }}>{totalOS ? totalOS.toLocaleString('en-US') : '—'}</td>
                <td style={{ padding: '8px 8px', textAlign: 'right', fontWeight: 900, color: 'var(--accent)', fontSize: 12 }}>{(totalPaid + totalOS) ? (totalPaid + totalOS).toLocaleString('en-US') : '—'}</td>
                <td colSpan={2}></td>
              </tr>
            </tfoot>
          </table>
        )}

        <button onClick={addRow} style={{ marginTop: 12, appearance: 'none', border: '1px dashed rgba(var(--accent-rgb),0.30)', background: 'rgba(var(--accent-rgb),0.05)', color: 'var(--accent)', borderRadius: 8, padding: '8px 16px', fontSize: 11, fontWeight: 700, cursor: 'pointer' }}>+ Add Loss Record</button>
      </div>
    </WizardLayout>
  );
}
