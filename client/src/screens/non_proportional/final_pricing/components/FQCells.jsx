import { useState } from 'react';
import PctInput from '../../../../components/PctInput';
import { formatWithCommas } from '../../../../utils/format';

/* ─── Cell editor used by the QuickBenchmark-style layer tables ───
   FQNumCell: shows commas when not focused, raw digits while editing.
   Stores raw strings (no commas) in state so totals math stays trivial
   via toN(). Percent cells use the canonical PctInput. */
export function FQNumCell({ value, onChange, className = 'bm-cell', placeholder = '—', style }) {
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState('');
  const display = (() => {
    const s = String(value ?? '').replace(/,/g, '').trim();
    if (!s) return '';
    const n = parseFloat(s);
    return isFinite(n) && n > 0 ? formatWithCommas(String(Math.round(n))) : value;
  })();
  return (
    <input
      className={className}
      style={style}
      value={editing ? raw : display}
      placeholder={placeholder}
      onFocus={(e) => { setEditing(true); setRaw(String(value ?? '').replace(/,/g, '')); e.target.select(); }}
      onChange={(e) => { setRaw(e.target.value); onChange(e.target.value.replace(/,/g, '')); }}
      onBlur={() => setEditing(false)}
    />
  );
}

export function FQPctCell({ value, onChange, className = 'bm-cell bm-cell--sm', placeholder = '—%' }) {
  return <PctInput value={value} onChange={onChange} className={className} placeholder={placeholder} />;
}

export function FQReadCell({ value, className = 'bm-cell bm-cell--sm bm-cell--display', placeholder = '—', style, title }) {
  const display = value == null || String(value).trim() === '' ? placeholder : value;
  return (
    <span className={className} style={style} title={title}>
      {display}
    </span>
  );
}
