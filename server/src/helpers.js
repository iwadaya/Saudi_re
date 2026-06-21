// server/src/helpers.js
// Shared utility functions for the backend

/**
 * Parse a value to a finite number, returning 0 for invalid/empty inputs.
 * Used for display and computation where 0 is a safe default.
 */
export function parseNum(v) {
  if (v === null || v === undefined || v === "") return 0;
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  const s = String(v).replace(/,/g, "").trim();
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : 0;
}

/**
 * Coerce incoming values to a numeric suitable for Postgres numeric columns.
 * Returns null for empty/invalid inputs so Postgres doesn't throw
 * "invalid input syntax for type numeric".
 */
export function toNum(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === "string") {
    const s = v.replace(/,/g, "").trim();
    if (s === "") return null;
    const n = Number.parseFloat(s);
    return Number.isFinite(n) ? n : null;
  }
  if (typeof v === "number") return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/,/g, "").trim();
  if (s === "") return null;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

/**
 * Wrap an async Express handler so thrown errors reach the error middleware.
 */
export function asyncHandler(fn) {
  return (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
}

/**
 * Sanitize a SQL identifier (table/schema name) to prevent injection.
 * Allows schema-qualified names like "public"."table_name".
 */
export function safeSqlIdentifier(name) {
  const parts = String(name || "").split(".");
  const safe = parts.every((p) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(p));
  if (!safe) return '"dashboard"';
  return parts.map((p) => `"${p}"`).join(".");
}

/**
 * Parse to null-safe numeric suitable for Postgres.
 * Returns null for empty/invalid; numeric for valid.
 */
export function numOrNull(v) {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Parse to an ISO date string (YYYY-MM-DD) or null.
 * Handles YYYY-MM-DD, DD/MM/YYYY, MM/DD/YYYY, and Date-parseable strings.
 */
export function dateOrNull(v) {
  if (!v) return null;
  const s = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.substring(0, 10);
  const m = s.match(/^(\d{1,2})[/\-.](\d{1,2})[/\-.](\d{4})$/);
  if (m) {
    const [, a, b, y] = m;
    const day = parseInt(a), mon = parseInt(b);
    if (day > 12 || mon <= 12)
      return `${y}-${String(mon).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    return `${y}-${String(day).padStart(2, '0')}-${String(mon).padStart(2, '0')}`;
  }
  const d = new Date(s);
  return isNaN(d.getTime()) ? null : d.toISOString().substring(0, 10);
}

/**
 * Coerce to boolean with a fallback.
 */
export function boolOrDefault(v, def = true) {
  if (v === true || v === 'true' || v === 1) return true;
  if (v === false || v === 'false' || v === 0) return false;
  return def;
}

/** Calendar year (UTC) from a date-like value; null when missing or invalid. */
export function yearFromDate(dateLike) {
  if (!dateLike) return null;
  const y = new Date(dateLike).getUTCFullYear();
  return Number.isFinite(y) ? y : null;
}

/**
 * Underwriting year for a loss record. Explicit uw_year wins, then the policy
 * inception year, then the loss-date year. Each derived year is NaN-guarded
 * (via yearFromDate) so an invalid date string never propagates into the
 * integer uw_year column and aborts the whole save.
 */
export function safeUwYear(loss) {
  return numOrNull(loss?.uw_year) ?? yearFromDate(loss?.policy_inception_date) ?? yearFromDate(loss?.date_of_loss);
}

/**
 * Merge an incoming boolean with the previously-saved value: an explicit
 * incoming value (true/false, 'true'/'false', 1/0) wins; otherwise keep the
 * existing DB value; otherwise the default. Lets a save that OMITS the field
 * (e.g. the loss-list grid, which doesn't send is_selected) preserve a choice
 * made elsewhere instead of silently resetting it.
 */
export function preserveBool(incoming, prev, fallback = true) {
  if (incoming === true || incoming === 'true' || incoming === 1) return true;
  if (incoming === false || incoming === 'false' || incoming === 0) return false;
  if (prev === true || prev === false) return prev;
  return fallback;
}

/** Numeric counterpart of preserveBool: incoming (if present) → existing → default. */
export function preserveNum(incoming, prev, fallback) {
  const inc = numOrNull(incoming);
  if (inc !== null) return inc;
  const p = numOrNull(prev);
  if (p !== null) return p;
  return fallback;
}

/**
 * Throw a 404 when a parent row doesn't exist, before a write FK-fails with a
 * 500. `table`/`idColumn` MUST be trusted literals (never user input) — they
 * are interpolated into SQL. `client` is a pg pool or connection.
 */
export async function assertExists(client, table, idColumn, id, label = 'Resource') {
  const { rowCount } = await client.query(`SELECT 1 FROM ${table} WHERE ${idColumn} = $1`, [id]);
  if (!rowCount) {
    const err = new Error(`${label} not found`);
    err.status = 404;
    err.code = 'NOT_FOUND';
    throw err;
  }
}

/**
 * Staleness predicate shared by the dev-factor and loss-selection checks:
 * true only when a save timestamp exists AND the source was updated strictly
 * after it. A null savedAt (never saved) is never stale.
 */
export function isStaleSince(sourceUpdatedAt, savedAt) {
  return !!(savedAt && sourceUpdatedAt && new Date(sourceUpdatedAt) > new Date(savedAt));
}

// "UNLIMITED" reinstatements stay null in the numeric column; the literal is
// preserved separately in the JSONB terms. Any other value parses as a number.
export function reinstatInt(v) {
  if (String(v || '').trim().toUpperCase() === 'UNLIMITED') return null;
  return numOrNull(v);
}
