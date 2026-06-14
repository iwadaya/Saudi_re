import { numOrNull } from '../../../helpers.js';

export function resolveActor(req, fallbackName = 'SYSTEM', fallbackRole = null) {
  return {
    actorUserId: req.user?.userId || null,
    actorName: req.user?.displayName || req.headers['x-user-name'] || fallbackName,
    actorRole: req.user?.role || fallbackRole,
  };
}

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
