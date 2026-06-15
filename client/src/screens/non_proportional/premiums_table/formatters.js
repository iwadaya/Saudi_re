// src/screens/non_proportional/premiums_table/formatters.js
// Numeric + display helpers lifted out of NpPremiumsTable.jsx so the screen
// stays under the line budget and the modal sub-component can reuse them.
//
// These are all pure functions — no React, no DOM, no screen state. They use
// the premiums-table's own conventions (fmtPct returns a bare number with no
// "%" — the "%" is added by PctInput; fmtMoney shows the full grouped figure),
// which differ from utils/format.js, so they intentionally live here.

export function toInt(v) { const n = parseInt(String(v ?? '').replace(/[^\d-]/g, ''), 10); return Number.isFinite(n) ? n : null; }
export function yearFromDate(v) { if (!v) return null; const m = String(v).match(/(\d{4})/); return m ? parseInt(m[1], 10) : null; }

export function parseFlexNum(v) {
  let s = String(v ?? '').trim();
  if (!s) return null;
  s = s.replace(/[\u2212]/g, '-');
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[%$£€¥]|\b(SAR|USD|EUR|GBP|AED|ZAR)\b/gi, '').replace(/[\s\u00A0]/g, '');
  const lastDot = s.lastIndexOf('.'); const lastComma = s.lastIndexOf(',');
  if (lastDot !== -1 && lastComma !== -1) {
    if (lastComma > lastDot) { s = s.replace(/\./g, '').replace(/,/g, '.'); }
    else { s = s.replace(/,/g, ''); }
  } else if (lastComma !== -1) {
    const tail = s.split(',').pop();
    if (tail.length <= 2) { s = s.replace(/,/g, '.'); } else { s = s.replace(/,/g, ''); }
  } else {
    if ((s.match(/\./g) || []).length > 1) s = s.replace(/\./g, '');
  }
  s = s.replace(/[^0-9.-]/g, '');
  if (!s || s === '-' || s === '.' || s === '-.') return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  return neg ? -Math.abs(n) : n;
}

export function numOrZero(v) { return parseFlexNum(v) ?? 0; }
export function fmtMoney(n) { const x = Number(n); if (!Number.isFinite(x)) return ''; return x.toLocaleString('en-US', { maximumFractionDigits: 0 }); }
export function fmtPct(n) { const x = Number(n); if (!Number.isFinite(x)) return ''; return x.toLocaleString('en-US', { maximumFractionDigits: 2 }); }

export function computeCumulative(rows) {
  let f = 1.0;
  // Coerce: a non-array (stale / partial state) must never reach `.map` and
  // white-screen the page behind ScreenErrorBoundary.
  return (Array.isArray(rows) ? rows : []).map((r, idx) => {
    const pct = numOrZero(r.inflationPct);
    if (idx > 0) f *= (1 + pct / 100);
    return { ...r, cumulativeFactor: f };
  });
}
