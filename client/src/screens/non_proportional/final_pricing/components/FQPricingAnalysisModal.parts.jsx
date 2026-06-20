// components/FQPricingAnalysisModal.parts.jsx
// Module-level pieces extracted from FQPricingAnalysisModal to keep that screen
// under the 800-line budget: the top-tab list, the editable weight cell, and the
// per-component / table-band colour maps. No behaviour change — a straight move.
import { useState } from 'react';
import { capPct2 } from '../formatters.js';

export const TOP_TABS = [
  { k: 'pricing', label: 'Pricing Analysis' },
  { k: 'pareto', label: 'Pareto Simulation' },
  { k: 'loss', label: 'Inflation & Loss' },
  { k: 'eq', label: 'CAT Modelling' },
  { k: 'agg', label: 'Aggregate Analysis' },
];

// Editable weight cell: shows the value with a "%" suffix while idle (capped at
// 2 dp), bare full-precision digits while editing. Entry keeps full precision
// and strips any "%" (onChange passes the raw number); only the idle display is
// capped and suffixed — the stored weight stays a bare number, so the Σ=100
// blend math reads it unchanged.
export function WtInput({ value, disabled, ariaLabel, onChange }) {
  const [editing, setEditing] = useState(false);
  const [raw, setRaw] = useState('');
  const idle = capPct2(value);
  return (
    <input
      type="text"
      inputMode="decimal"
      className="bm-cell bm-cell--sm"
      aria-label={ariaLabel}
      value={editing ? raw : (idle === '' ? '' : `${idle}%`)}
      disabled={disabled}
      onFocus={() => { setEditing(true); setRaw(String(value ?? '').replace(/%/g, '')); }}
      onChange={(e) => { const v = e.target.value.replace(/[^0-9.]/g, ''); setRaw(v); onChange(v); }}
      onBlur={() => setEditing(false)}
      style={{ width: '100%', boxSizing: 'border-box', opacity: disabled ? 0.5 : 1 }}
    />
  );
}

// Per-component colours for the modelled block. Each component (Pure Burn /
// Pareto / Exposure) gets a distinct line + faint tint, and its matching weight
// column (Wt Burn / Wt Pareto / Wt Exp) reuses the SAME colour so the blend
// weights read visually paired with the component they weight.
export const COMP = {
  pureBurn: { line: 'var(--accent)',       tint: 'rgba(var(--accent-rgb),0.10)' },        // green
  pareto:   { line: 'var(--accent-amber)', tint: 'rgba(var(--accent-amber-rgb),0.10)' },  // amber
  exposure: { line: 'var(--accent-rose)',  tint: 'rgba(var(--accent-rose-rgb),0.10)' },   // violet → rose (no violet token)
};

// Subtle background tints that band the table into Modelled / Implied-Expiring /
// Implied-Market / UW groups.
export const G = {
  modelled: 'rgba(var(--accent-rgb),0.06)',
  exp: 'rgba(var(--accent-amber-rgb),0.08)',
  country: 'rgba(var(--accent-blue-rgb),0.08)',
  region: 'rgba(var(--accent-rose-rgb),0.08)',   // violet → rose (no violet token)
  global: 'rgba(var(--accent-rgb),0.08)',
  uw: 'rgba(var(--accent-blue-rgb),0.08)',
  note: 'var(--surface-hover)',
};
