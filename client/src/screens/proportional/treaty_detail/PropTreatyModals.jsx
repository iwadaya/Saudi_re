// src/screens/proportional/treaty_detail/PropTreatyModals.jsx
// The treaty-detail field helpers (FR, TogglePill, CommaInput), the useEscapeKey
// hook, and the three editing modals (CobSelect, SlidingScale, EpiSplit),
// extracted to keep PropTreatyDetail under the 800-line budget. Props unchanged.
import { useState, useEffect, useMemo } from 'react';
import PctInput from '../../../components/PctInput';
import {
  numOrNull,
  fmtComma,
  fmtCommaDecimal,
  stripDigits,
  stripNonNumeric,
} from './propTreatyHelpers';

export function useEscapeKey(enabled, onEscape) {
  useEffect(() => {
    if (!enabled) return undefined;
    const onKey = e => { if (e.key === 'Escape') onEscape(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [enabled, onEscape]);
}

/* ─── Form Row: label left, input right ─── */
export function FR({ label, missing, children }) {
  return (
    <div
      className={missing ? 'fr-row required-missing' : 'fr-row'}
      style={{ display: 'grid', gridTemplateColumns: '160px 1fr', gap: 10, alignItems: 'center', minHeight: 36 }}
    >
      <div style={{ fontSize: 12, color: 'rgba(var(--text-rgb),.55)' }}>
        {label}{missing && <span style={{ color: '#f87171', marginLeft: 4 }}>*</span>}
      </div>
      <div>{children}</div>
    </div>
  );
}

/* ─── Toggle Pill ─── */
export function TogglePill({ options, value, onChange, ariaLabel }) {
  return (
    <div className="toggle-group" role="group" aria-label={ariaLabel}>
      {options.map(o => (
        <button key={String(o.value)} type="button"
          className={`toggle-option${value === o.value ? ' active' : ''}`}
          aria-pressed={value === o.value}
          style={value === o.value ? undefined : { color: 'rgba(var(--text-rgb),.82)' }}
          onClick={() => onChange(o.value)}>{o.label}</button>
      ))}
    </div>
  );
}

/* ─── Comma-formatted number input ─── */
export function CommaInput({ value, onChange = () => {}, placeholder, readOnly, disabled, title }) {
  const [display, setDisplay] = useState(fmtComma(value));
  useEffect(() => { setDisplay(fmtComma(value)); }, [value]);
  const handleChange = e => { const raw = stripDigits(e.target.value); setDisplay(fmtComma(raw)); onChange(raw); };
  return <input className="fi" type="text" inputMode="numeric" placeholder={placeholder}
    value={display} onChange={handleChange} readOnly={readOnly} disabled={disabled} title={title} />;
}

/* ─── COB Multi-Select Modal ─── */
export function CobSelectModal({ selected, classList, onSave, onClose }) {
  const [sel, setSel] = useState(new Set(selected || []));
  const toggle = id => { const n = new Set(sel); if (n.has(id)) n.delete(id); else n.add(id); setSel(n); };
  useEscapeKey(true, onClose);
  return (
    <div className="modal-backdrop" role="presentation" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal glass" role="dialog" aria-modal="true" aria-labelledby="cob-select-title" style={{ maxWidth: 500 }}>
        <div className="modal-title" id="cob-select-title">
          <span>Select Lines of Business</span>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div style={{ padding: '12px 24px', maxHeight: '50vh', overflowY: 'auto' }}>
          {(classList || []).map(c => (
            <label key={c.id} style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '6px 0', cursor: 'pointer', fontSize: 13 }}>
              <input type="checkbox" checked={sel.has(c.id)} onChange={() => toggle(c.id)} style={{ width: 16, height: 16, accentColor: 'var(--accent)' }} />
              {c.name}
            </label>
          ))}
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => onSave([...sel])}>Apply</button>
        </div>
      </div>
    </div>
  );
}

/* ─── Sliding Scale Modal ─── */
export function SlidingScaleModal({ table, provisional, onSave, onClose }) {
  const [rows, setRows] = useState(() => {
    const r = Array.isArray(table) ? table.map(r => ({ ...r })) : [];
    while (r.length < 10) r.push({ lossRatioPct: '', commissionPct: '' });
    return r;
  });
  const [provPct, setProvPct] = useState(provisional || '');
  const updateRow = (i, key, val) => { const c = [...rows]; c[i] = { ...c[i], [key]: val }; setRows(c); };
  const removeRow = i => setRows(rows.filter((_, j) => j !== i));
  useEscapeKey(true, onClose);
  return (
    <div className="modal-backdrop" role="presentation" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal glass" role="dialog" aria-modal="true" aria-labelledby="sliding-scale-title" style={{ width: 'min(680px, 94vw)', maxHeight: '88vh' }}>
        <div className="modal-title" id="sliding-scale-title" style={{ color: 'var(--accent-amber)' }}>
          <span>Sliding Scale Commission Table</span>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div style={{ padding: '16px 24px', overflowY: 'auto', flex: 1 }}>
          <FR label="Provisional Commission %"><PctInput placeholder="e.g. 30%" value={provPct} onChange={v => setProvPct(v)} /></FR>
          <table className="data-table" style={{ fontSize: 13, marginTop: 14 }}>
            <thead><tr><th>Loss Ratio %</th><th>Commission %</th><th style={{ width: 40 }}></th></tr></thead>
            <tbody>{rows.map((r, i) => (
              <tr key={i}>
                <td><PctInput placeholder="e.g. 65%" value={r.lossRatioPct} onChange={v => updateRow(i, 'lossRatioPct', v)} /></td>
                <td><PctInput placeholder="e.g. 30%" value={r.commissionPct} onChange={v => updateRow(i, 'commissionPct', v)} /></td>
                <td><button style={{ background: 'none', border: 'none', color: '#f87171', cursor: 'pointer', fontSize: 16 }} onClick={() => removeRow(i)}>✕</button></td>
              </tr>
            ))}</tbody>
          </table>
          <button className="orange-gloss-btn" style={{ marginTop: 10 }} onClick={() => setRows([...rows, { lossRatioPct: '', commissionPct: '' }])}>+ Add Row</button>
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => {
            onSave(
              rows.filter(r => String(r.lossRatioPct||'').trim() && String(r.commissionPct||'').trim()),
              provPct
            );
          }}>Save Table</button>
        </div>
      </div>
    </div>
  );
}

/* ─── EPI Split Modal ─── */
export function EpiSplitModal({ split, classIds, classList, qsEpi, surplusEpi, onSave, onClose }) {
  const initial = useMemo(() => classIds.map(id => {
    const existing = (split || []).find(r => r.classId === id);
    const totalRef = (numOrNull(qsEpi) || 0) + (numOrNull(surplusEpi) || 0);
    const equalShare = (totalRef && classIds.length) ? String(Math.round(totalRef / classIds.length)) : '';
    return { classId: id, premium: existing?.premium || equalShare };
  }), [classIds, split, qsEpi, surplusEpi]);
  const [rows, setRows] = useState(initial);
  const classMap = useMemo(() => new Map((classList || []).map(c => [c.id, c.name])), [classList]);
  const totalRef = (numOrNull(qsEpi) || 0) + (numOrNull(surplusEpi) || 0);
  const totalSplit = rows.reduce((s, r) => s + (numOrNull(r.premium) || 0), 0);
  const updateRow = (i, val) => { const c = [...rows]; c[i] = { ...c[i], premium: stripNonNumeric(val) }; setRows(c); };
  useEscapeKey(true, onClose);
  return (
    <div className="modal-backdrop" role="presentation" onClick={e => e.target === e.currentTarget && onClose()}>
      <div className="modal glass" role="dialog" aria-modal="true" aria-labelledby="epi-split-title" style={{ width: 'min(680px, 94vw)', maxHeight: '88vh' }}>
        <div className="modal-title" id="epi-split-title" style={{ color: 'var(--accent-amber)' }}>
          <span>EPI Split by Line of Business</span>
          <button type="button" className="modal-close" onClick={onClose} aria-label="Close">✕</button>
        </div>
        <div style={{ padding: '16px 24px', overflowY: 'auto', flex: 1 }}>
          <div style={{ display: 'flex', gap: 18, background: 'var(--surface-hover)', borderRadius: 8, padding: '10px 16px', marginBottom: 18, fontSize: 12, color: 'rgba(var(--text-rgb),.55)' }}>
            <span>QS: <b style={{ color: 'var(--text)' }}>{fmtComma(qsEpi) || '—'}</b></span>
            <span>Surplus: <b style={{ color: 'var(--text)' }}>{fmtComma(surplusEpi) || '—'}</b></span>
            <span>Total: <b style={{ color: 'var(--text)' }}>{totalRef ? fmtComma(String(Math.round(totalRef))) : '—'}</b></span>
          </div>
          <table className="data-table" style={{ fontSize: 13 }}>
            <thead><tr><th>Line of Business</th><th>Premium</th><th style={{ textAlign: 'right' }}>% of Total</th></tr></thead>
            <tbody>{rows.map((r, i) => (
              <tr key={r.classId}>
                <td>{classMap.get(r.classId) || r.classId}</td>
                <td><input className="fi" type="text" inputMode="decimal" placeholder="e.g. 1,000,000" value={fmtCommaDecimal(r.premium)} onChange={e => updateRow(i, e.target.value)} /></td>
                <td style={{ textAlign: 'right' }}>{totalRef > 0 && numOrNull(r.premium) ? ((numOrNull(r.premium) / totalRef) * 100).toFixed(1) + '%' : '—'}</td>
              </tr>
            ))}</tbody>
            <tfoot><tr style={{ fontWeight: 700 }}><td>TOTAL</td><td>{totalSplit ? fmtComma(String(Math.round(totalSplit))) : '—'}</td>
              <td style={{ textAlign: 'right', color: totalRef > 0 && Math.abs(totalSplit - totalRef) < 1 ? 'var(--accent)' : 'var(--accent-amber)' }}>{totalRef > 0 && totalSplit > 0 ? ((totalSplit / totalRef) * 100).toFixed(1) + '%' : '—'}</td>
            </tr></tfoot>
          </table>
        </div>
        <div className="modal-actions">
          <button className="btn ghost" onClick={onClose}>Cancel</button>
          <button className="btn primary" onClick={() => {
            const diff = Math.abs(totalSplit - totalRef);
            if (totalRef > 0 && diff > 1) {
              const msg = `Split total (${fmtComma(String(Math.round(totalSplit)))}) doesn't match EPI total (${fmtComma(String(Math.round(totalRef)))}). Save anyway?`;
              if (!window.confirm(msg)) return;
            }
            onSave(rows);
          }}>Save Split</button>
        </div>
      </div>
    </div>
  );
}

/* ═══════════════════════════════════════════════
   MAIN COMPONENT
   ═══════════════════════════════════════════════ */
