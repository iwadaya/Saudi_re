import { numOrNull } from '../../../helpers.js';

// Audit identity must come from VERIFIED req.user, looked up server-side — never
// from x-user-* headers or a client `_actor`. resolveActor delegates to the
// audit service's resolveAuditActor (async, DB-resolved name; SYSTEM when
// anonymous). Re-exported here so existing pricing-controller imports keep working.
export { resolveAuditActor as resolveActor } from '../../../services/audit.js';

export function parseOfferLinePct({ line_pct, written_line_pct }) {
  if (written_line_pct != null) return parseFloat(String(written_line_pct)) || null;
  if (line_pct == null) return null;

  const direct = parseFloat(String(line_pct).replace(/%/g, ''));
  if (Number.isFinite(direct)) return direct;

  try {
    const parsed = JSON.parse(line_pct);
    if (typeof parsed === 'object' && parsed && !Array.isArray(parsed)) {
      const vals = Object.values(parsed)
        .map((v) => parseFloat(String(v).replace(/%/g, '')))
        .filter((n) => Number.isFinite(n) && n > 0);
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
      const vals = Object.values(parsed)
        .map((v) => parseFloat(String(v).replace(/%/g, '')))
        .filter((n) => Number.isFinite(n) && n > 0);
      return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
    }
    return numOrNull(parsed);
  } catch {
    return numOrNull(signed_line_pct);
  }
}
