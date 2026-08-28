import { numOrNull } from '../../../helpers.js';

// Audit identity must come from VERIFIED req.user, looked up server-side — never
// from x-user-* headers or a client `_actor`. resolveActor delegates to the
// audit service's resolveAuditActor (async, DB-resolved name; SYSTEM when
// anonymous). Re-exported here so existing pricing-controller imports keep working.
export { resolveAuditActor as resolveActor } from '../../../services/audit.js';

export function parseOfferLinePct({ line_pct, written_line_pct }) {
  if (written_line_pct != null) {
    // Null-safe parse: an explicitly written 0% line is a real decision
    // ("declined to zero") and must be kept — the old `|| null` coerced it to
    // NULL, indistinguishable from "no line entered". An unparseable
    // written_line_pct falls through to line_pct instead of short-circuiting.
    const direct = parseFloat(String(written_line_pct).replace(/%/g, ''));
    if (Number.isFinite(direct)) return direct;
  }
  if (line_pct == null) return null;

  const direct = parseFloat(String(line_pct).replace(/%/g, ''));
  if (Number.isFinite(direct)) return direct;

  try {
    const parsed = JSON.parse(line_pct);
    if (typeof parsed === 'object' && parsed && !Array.isArray(parsed)) {
      // Average every present per-layer line, INCLUDING legitimate 0% layers.
      // Only null/undefined/NaN and negative entries are dropped; excluding
      // 0% layers (the old `n > 0`) biased the mean upward and silently
      // discarded layers the cedant genuinely wrote at 0%. No per-layer
      // weight is available in this map, so this is an unweighted mean.
      const vals = Object.values(parsed)
        .map((v) => parseFloat(String(v).replace(/%/g, '')))
        .filter((n) => Number.isFinite(n) && n >= 0);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    }
  } catch {}

  return null;
}

export function parseSignedLinePct(signed_line_pct) {
  if (signed_line_pct == null) return null;

  try {
    const parsed = JSON.parse(signed_line_pct);
    if (typeof parsed === 'object' && parsed && !Array.isArray(parsed)) {
      // Include 0% layers in the mean (see parseOfferLinePct) — drop only
      // null/undefined/NaN and negatives. Unweighted: no per-layer weight here.
      const vals = Object.values(parsed)
        .map((v) => parseFloat(String(v).replace(/%/g, '')))
        .filter((n) => Number.isFinite(n) && n >= 0);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    }
    return numOrNull(parsed);
  } catch {
    return numOrNull(signed_line_pct);
  }
}
