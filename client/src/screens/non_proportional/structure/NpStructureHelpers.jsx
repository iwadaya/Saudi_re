import { useState, useEffect } from 'react';
import { formatWithCommas, sanitizeNumber } from '../../../utils/format';
import CanonicalPctInput from '../../../components/PctInput';

/* ─── pure helpers ─── */
export function toNum(v) {
  // Strip thousands separators (commas) but preserve decimal point
  const s = String(v ?? '').replace(/,/g, '').trim();
  const n = parseFloat(s);
  if (!Number.isFinite(n)) return 0;
  // Structure values are always whole currency amounts — truncate any fractional part
  return Math.trunc(n);
}
export function rateToFloat(v) { const n = parseFloat(String(v ?? '').replace(/%/g, '')); return Number.isFinite(n) && n > 0 ? n : 0; }
export function appendPct(v) { const s = String(v ?? '').replace(/%/g, '').trim(); return s ? s + '%' : ''; }
export const fmtC = v => formatWithCommas(v);
export function fmtPctMaybe(n01) { if (!Number.isFinite(n01) || n01 <= 0) return ''; const v = n01 * 100; return `${v.toFixed(2).replace(/\.00$/, '').replace(/(\.\d)0$/, '$1')}%`; }

/* strOrEmpty: null/undefined/0 → '', non-zero values preserved as strings */
export function strOrEmpty(v) {
  if (v === null || v === undefined) return '';
  const n = typeof v === 'number' ? v : parseFloat(String(v).trim());
  if (Number.isFinite(n) && n === 0) return '';
  const s = String(v).trim();
  return s === '0' || s === '0.0' || s === '0.00' ? '' : s;
}

/* strRate: DB stores rate as plain number (1.5 = 1.5%), returns bare number string for RateInput */
export function strRate(v) {
  if (v === null || v === undefined) return '';
  const n = parseFloat(String(v));
  return (Number.isFinite(n) && n > 0) ? String(n) : '';
}

/* ─── Excel paste support ─── */
export function parseExcelInt(raw) {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  if (/^\(.*\)$/.test(s)) s = '-' + s.slice(1, -1);
  s = s.replace(/[^0-9,.-]/g, '');
  const hasDot = s.includes('.'); const hasComma = s.includes(',');
  if (hasDot && hasComma) {
    if (s.lastIndexOf('.') > s.lastIndexOf(',')) s = s.replace(/,/g, '');
    else s = s.replace(/\./g, '').replace(/,/g, '.');
  } else if (hasComma) {
    const parts = s.split(',');
    if (parts.length === 2 && parts[1].length <= 2) s = s.replace(/,/g, '.');
    else s = s.replace(/,/g, '');
  }
  if (s.includes('.')) s = s.split('.')[0];
  const digits = s.replace(/[^0-9-]/g, '');
  return digits || '';
}

export function parseClipboard(text) {
  const raw = String(text || '').replace(/\r\n/g, '\n').replace(/\r/g, '\n');
  const norm = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
  if (!norm) return [];
  return norm.split('\n').map(ln => ln.split('\t'));
}

export const PASTE_FIELD_ORDER = ['limit', 'annualAggLimit', 'egnpi', 'rate', 'mdp', 'reinstatementPct', 'aadAmount'];
export const NUMERIC_FIELDS = new Set(['limit', 'annualAggLimit', 'egnpi', 'mdp', 'aadAmount']);

export function emptyLayer(i) {
  return {
    layer: i + 1, limit: '', deductible: '', annualAggLimit: '', egnpi: '',
    rate: '', earnedPremium: '', mdp: '', mdpPct: '', reinstatements: '',
    reinstatementPct: '', aad: false, aadAmount: '', riskCover: true,
    catCover: true, rol: '', classOfBusinessIds: [],
  };
}

export function emptyCoveredProp() {
  return { cobId: '', qsLimit: '', retentionPct: '', surplusLines: '' };
}

/* ─── Comma-formatted input ─── */
export function CommaInput({ value, onChange, placeholder, readOnly, disabled, suffix, pasteField }) {
  const [display, setDisplay] = useState(fmtC(value));
  useEffect(() => { setDisplay(fmtC(value)); }, [value]);
  const handleChange = e => {
    const raw = sanitizeNumber(e.target.value);
    setDisplay(fmtC(raw));
    onChange(raw);
  };
  return (
    <div className="np-cell-input">
      <input className="np-mini-input" type="text" inputMode="numeric" placeholder={placeholder || '—'}
        value={display} onChange={handleChange} readOnly={readOnly} disabled={disabled}
        data-paste-field={pasteField || undefined} />
      {suffix && <span className="np-sfx">{suffix}</span>}
    </div>
  );
}

/* RateInput / PctInput — kept as named exports for the existing call
   sites in NpStructure & QuoteStructureSection. Both delegate to the
   canonical PctInput, with light-weight blur normalization on RateInput
   and the np-cell-input wrapper preserved for table-cell layout. */
export function RateInput({ value, onChange, pasteField, readOnly, disabled }) {
  return (
    <div className="np-cell-input">
      <CanonicalPctInput
        className="np-mini-input np-mini-input--center"
        placeholder="—%"
        value={value}
        readOnly={readOnly}
        disabled={disabled}
        onChange={onChange}
        onBlur={() => {
          const n = parseFloat(String(value ?? '').replace(/%/g, ''));
          if (Number.isFinite(n)) onChange(String(parseFloat(n.toPrecision(6))));
        }}
        data-paste-field={pasteField || undefined}
      />
    </div>
  );
}

export function PctInput({ value, onChange, placeholder, pasteField, readOnly, disabled }) {
  return (
    <div className="np-cell-input">
      <CanonicalPctInput
        className="np-mini-input np-mini-input--center"
        placeholder={placeholder || '—%'}
        value={value}
        readOnly={readOnly}
        disabled={disabled}
        onChange={onChange}
        data-paste-field={pasteField || undefined}
      />
    </div>
  );
}
