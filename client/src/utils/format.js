// src/utils/format.js — Shared formatting utilities

export function fmtNum(n, opts = {}) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  const { decimals = 0 } = opts;
  return v.toLocaleString(undefined, { minimumFractionDigits: decimals, maximumFractionDigits: decimals });
}

export function fmtPct(n, decimals = 2) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return `${(v * 100).toFixed(decimals)}%`;
}

// Treaty balance / ratio multiplier, e.g. 2.50× . Distinct from money/percent
// so balance columns read as a multiple of premium rather than an amount.
export const fmtX = (v) => Number.isFinite(Number(v)) ? `${Number(v).toFixed(2)}×` : '—';

// N/A-aware balance multiplier: a null/blank balance (e.g. a year or region
// with no proportional business — the server sends null, not 0) renders as
// '—' rather than a misleading 0.00×. A genuine 0 still shows as 0.00×.
export const fmtBal = (v) => (v != null && Number.isFinite(Number(v))) ? `${Number(v).toFixed(2)}×` : '—';

export function fmtMoney(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '0';
  if (v === 0) return '0';
  const abs = Math.abs(v);
  const sign = v < 0 ? '-' : '';
  const unit = abs >= 1e9 ? 'B' : abs >= 1e6 ? 'M' : abs >= 1e3 ? 'K' : '';
  const denom = unit === 'B' ? 1e9 : unit === 'M' ? 1e6 : unit === 'K' ? 1e3 : 1;
  const scaled = abs / denom;
  const shown = scaled >= 100 ? scaled.toFixed(0) : scaled >= 10 ? scaled.toFixed(1) : scaled.toFixed(2);
  return `${sign}${shown}${unit}`;
}

export function fmtPctPoints(n, decimals = 2) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  return `${v.toFixed(decimals)}%`;
}

export function sanitizeNumber(v) {
  let s = String(v ?? '').trim();
  if (!s) return '';
  s = s.replace(/−/g, '-');
  let neg = false;
  const paren = /^\((.+)\)$/.exec(s);
  if (paren) { neg = true; s = paren[1]; }
  s = s.replace(/[%$£€¥]|\b(SAR|USD|EUR|GBP|AED|ZAR)\b/gi, '');
  s = s.replace(/[\s ]/g, '');
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot !== -1 && lastComma !== -1) {
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(/,/g, '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma !== -1) {
    const parts = s.split(',');
    if (parts.length === 2 && parts[1].length <= 2) s = s.replace(/,/g, '.');
    else s = s.replace(/,/g, '');
  }
  s = s.replace(/[^0-9.-]/g, '');
  return neg && s && !s.startsWith('-') ? '-' + s : s;
}

export function formatWithCommas(digitsOrNumber) {
  if (digitsOrNumber === null || digitsOrNumber === undefined) return '';
  if (digitsOrNumber === '' || digitsOrNumber === '-') return String(digitsOrNumber);
  // If already a number, format directly
  if (typeof digitsOrNumber === 'number') {
    return Number.isFinite(digitsOrNumber) ? digitsOrNumber.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '';
  }
  // String: strip existing commas and spaces, preserve negative sign and digits
  const s = String(digitsOrNumber).replace(/,/g, '').replace(/\s/g, '').trim();
  if (!s) return '';
  // Parse as number to handle decimals, negatives, etc.
  const n = Number(s);
  if (!Number.isFinite(n)) return String(digitsOrNumber);
  return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

/**
 * Display-cell variant of formatWithCommas: returns '—' for
 * null/undefined/NaN instead of an empty string. Use this when
 * rendering to a table cell or side-panel row where a visible dash
 * signals "no value" more clearly than blank space.
 *
 * Replaces the identical local `fmt(n)` helpers that had accreted in
 * half a dozen screens.
 *
 * @param {*} n
 * @returns {string}
 */
export function fmtOrEm(n) {
  if (n === null || n === undefined || n === '') return '—';
  const v = typeof n === 'number' ? n : Number(n);
  if (!Number.isFinite(v)) return '—';
  return v.toLocaleString('en-US', { maximumFractionDigits: 0 });
}

export function dateInputValue(v) {
  if (!v) return '';
  const s = String(v).trim();
  // Already yyyy-MM-dd
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // ISO timestamp
  if (s.includes('T')) return s.split('T')[0];
  // dd/mm/yyyy or dd-mm-yyyy or dd.mm.yyyy
  const dmy = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (dmy) {
    const [, a, b, y] = dmy;
    const day = parseInt(a), mon = parseInt(b);
    // If first number > 12, it must be day (dd/mm/yyyy)
    // If second number > 12, it must be day (mm/dd/yyyy)
    // Default: assume dd/mm/yyyy (European format)
    if (day > 12 || mon <= 12) {
      return `${y}-${String(mon).padStart(2,'0')}-${String(day).padStart(2,'0')}`;
    } else {
      // mm/dd/yyyy
      return `${y}-${String(day).padStart(2,'0')}-${String(mon).padStart(2,'0')}`;
    }
  }
  // yyyy/mm/dd
  const ymd = s.match(/^(\d{4})[/\-.](\d{1,2})[/\-.](\d{1,2})$/);
  if (ymd) {
    const [, y, m, d] = ymd;
    return `${y}-${String(m).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
  }
  // Fallback: try Date parse
  const d = new Date(s);
  if (!Number.isNaN(d.getTime())) return d.toISOString().split('T')[0];
  return s; // Return as-is if unparseable (user can fix manually)
}

export function yearFromDateInput(v) {
  const s = dateInputValue(v);
  const y = s ? Number(s.slice(0, 4)) : NaN;
  return Number.isFinite(y) && y > 0 ? y : null;
}

export function addMonthsClamped(dateStr, months) {
  if (!dateStr) return '';
  const [y, m, d] = String(dateStr).slice(0, 10).split('-').map(Number);
  if (!y || !m || !d) return '';
  const targetMonth = m - 1 + Number(months || 0);
  const targetYear = y + Math.floor(targetMonth / 12);
  const normMonth = ((targetMonth % 12) + 12) % 12;
  const lastDay = new Date(targetYear, normMonth + 1, 0).getDate();
  const day = Math.min(d, lastDay);
  return `${targetYear}-${String(normMonth + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function parseDateLike(v) {
  if (!v) return null;
  const d = v instanceof Date ? v : new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function formatDate(v, opts) {
  const d = parseDateLike(v);
  if (!d) return '—';
  return d.toLocaleDateString('en-GB', opts);
}

export function formatDateTime(v, opts) {
  const d = parseDateLike(v);
  if (!d) return '—';
  return d.toLocaleString('en-GB', opts);
}

export function formatTime(v, opts) {
  const d = parseDateLike(v);
  if (!d) return '';
  return d.toLocaleTimeString('en-GB', opts);
}

export function parseFlexibleNumber(v) {
  let s = String(v ?? '').trim();
  if (!s) return null;
  s = s.replace(/\u2212/g, '-');
  let neg = false;
  if (/^\(.*\)$/.test(s)) { neg = true; s = s.slice(1, -1); }
  s = s.replace(/[%$£€¥]|\b(SAR|USD|EUR|GBP|AED|ZAR)\b/gi, '');
  s = s.replace(/[\s\u00A0]/g, '');
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');
  if (lastDot !== -1 && lastComma !== -1) {
    if (lastComma > lastDot) s = s.replace(/\./g, '').replace(/,/g, '.');
    else s = s.replace(/,/g, '');
  } else if (lastComma !== -1) {
    const parts = s.split(',');
    if (parts.length === 2 && parts[1].length <= 2) s = s.replace(/,/g, '.');
    else s = s.replace(/,/g, '');
  }
  s = s.replace(/[^0-9.-]/g, '');
  const n = parseFloat(s);
  if (isNaN(n)) return null;
  return neg ? -Math.abs(n) : n;
}

/**
 * Parse a number, falling back to 0 for empty or unparseable input.
 *
 * Wraps parseFlexibleNumber for callers that want a numeric default
 * rather than null. This is the canonical replacement for the various
 * inline `toN`, `toNum`, `fqToN` helpers scattered through the screens —
 * import this instead of declaring a new local one.
 *
 *   toN('1,234.50')   // 1234.5
 *   toN('$1,234')     // 1234   (handles currency)
 *   toN('(500)')      // -500   (handles accounting negatives)
 *   toN('1.234,56')   // 1234.56  (handles European decimals)
 *   toN('')           // 0
 *   toN(null)         // 0
 *   toN('garbage')    // 0
 */
export function toN(v) {
  const n = parseFlexibleNumber(v);
  return n == null ? 0 : n;
}

/**
 * Like toN but returns null for empty/invalid input. Use when callers
 * need to distinguish "no value" from "zero" (e.g. NpExpiringStructure
 * where null means "carry expiring value through" but 0 means "explicit zero").
 */
export function toNullableN(v) {
  return parseFlexibleNumber(v);
}
