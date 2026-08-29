// src/components/PctInput.jsx — Canonical percentage input.
// Shows "<value>%" when not focused; strips "%" on focus for editing.
// Calls onChange with the bare numeric string (no "%"). Includes a
// title tooltip so underwriters know "%" is appended automatically.
//
// `min` / `max` clamp the committed value on blur. The underlying input is
// type="text" (for the % suffix), where the native min/max attributes do
// nothing — so the clamp must be ours or out-of-range entries (e.g. a
// mangled "8080") flow into autosave and only fail server-side.
import { useState } from 'react';

const DEFAULT_TOOLTIP = 'Enter a number — % is added automatically.';

export default function PctInput({
  value,
  onChange,
  className = 'fi',
  placeholder = '—%',
  min,
  max,
  step,
  style,
  readOnly,
  disabled,
  title = DEFAULT_TOOLTIP,
  inputMode = 'decimal',
  onBlur,
  onFocus,
  displayMaxDp,
  ...rest
}) {
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState('');

  const bare = String(value ?? '').replace(/%/g, '').trim();
  // Idle display can be capped to a max number of decimals (display only —
  // editing shows the full-precision `bare` value, and onChange/onBlur pass the
  // untouched entry, so stored precision is never lost).
  const idle = (() => {
    if (displayMaxDp == null || bare === '') return bare;
    const n = Number(bare);
    if (!Number.isFinite(n)) return bare;
    const f = 10 ** displayMaxDp;
    return String(Math.round(n * f) / f);
  })();
  const display = editing ? raw : (idle ? `${idle}%` : '');

  return (
    <input
      {...rest}
      type="text"
      inputMode={inputMode}
      className={className}
      style={style}
      placeholder={placeholder}
      value={display}
      title={title}
      readOnly={readOnly}
      disabled={disabled}
      min={min}
      max={max}
      step={step}
      onFocus={(e) => {
        setEditing(true);
        setRaw(bare);
        e.target.select();
        if (onFocus) onFocus(e);
      }}
      onChange={(e) => {
        const next = e.target.value.replace(/%/g, '');
        setRaw(next);
        onChange(next);
      }}
      onBlur={(e) => {
        setEditing(false);
        const n = Number(bare);
        if (bare !== '' && Number.isFinite(n)) {
          const clamped = Math.min(max ?? Infinity, Math.max(min ?? -Infinity, n));
          if (clamped !== n) onChange(String(clamped));
        }
        if (onBlur) onBlur(e);
      }}
    />
  );
}
