// Triangle variant (migration 116). Reads/writes default to MODIFIED so all
// pre-variant behaviour is unchanged unless ACTUAL is explicitly requested.
// Returns null for an explicitly-invalid value so the caller can 400.
export const TRIANGLE_VARIANTS = new Set(['ACTUAL', 'MODIFIED']);

export function resolveVariant(raw) {
  if (raw == null || raw === '') return 'MODIFIED';
  const v = String(raw).toUpperCase();
  return TRIANGLE_VARIANTS.has(v) ? v : null;
}
