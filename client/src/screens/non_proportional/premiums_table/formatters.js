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

export const sameYears = (a, b) =>
  Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((v, i) => v === b[i]);

// Resolve the UW-year range from the authoritative treaty payload the premiums
// screen fetches (contract header + non-prop detail + saved EGNPI rows). Used
// as a fallback when appState.npTreatyDetail isn't hydrated in NP/quote mode,
// which otherwise leaves the premiums + inflation tables empty until you
// navigate away and back.
export function resolveYearsFromServer(header, np, egnpiRows) {
  const h = header || {};
  const d = np?.detail || np?.terms?.treaty_detail || {};
  // The non-prop payload carries its own authoritative contract/quote header
  // (uw_year + inception/renewal). Falling back to it means a failed or slow
  // getContract no longer leaves the premiums + inflation tables stuck on
  // "Waiting for years" — the range still resolves from the np payload alone.
  const ch = np?.contract_header || {};
  const start =
    toInt(d.experience_start_year) ?? toInt(d.experienceStartYear) ??
    toInt(h.uw_year) ?? toInt(h.uwYear) ?? toInt(ch.uw_year) ??
    yearFromDate(h.inception_date) ?? yearFromDate(h.inceptionDate) ??
    yearFromDate(ch.inception_date) ?? null;
  const renew =
    yearFromDate(h.renewal_date) ?? yearFromDate(h.renewalDate) ??
    yearFromDate(ch.renewal_date) ??
    toInt(h.renewal_year) ?? toInt(h.uw_year) ?? toInt(ch.uw_year) ?? null;
  const set = new Set();
  if (start) {
    const end = (renew && renew >= start) ? renew : start;
    for (let y = start; y <= end; y++) set.add(y);
  }
  for (const r of (Array.isArray(egnpiRows) ? egnpiRows : [])) {
    const y = toInt(r.uwYear ?? r.uw_year);
    if (y) set.add(y);
  }
  return [...set].sort((a, b) => a - b);
}

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
