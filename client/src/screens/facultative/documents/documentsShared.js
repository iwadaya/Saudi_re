// documentsShared.js — constants + pure helpers shared by the
// FacDocuments orchestrator, its hooks and its JSX islands.
// Extracted verbatim from FacDocuments.jsx in Phase 4.2 (decomposition);
// no behavior change.

export const MAX_BYTES = 20 * 1024 * 1024;     // 20 MB
export const POLL_INTERVAL_MS = 2000;
export const POLL_DEADLINE_MS = 60_000;

// AI kinds (drive both the upload metadata and the analyser routing).
export const AI_KINDS = [
  ['PLACEMENT_SLIP',   'Placement Slip'],
  ['SURVEY_REPORT',    'Survey Report'],
  ['CLAIMS_BORDEREAU', 'Claims Bordereau'],
  ['COPE_REPORT',      'COPE Report'],
  ['WORDING',          'Wording / Clauses'],
  ['OTHER',            'Other'],
];
export const AI_KIND_LABELS = Object.fromEntries(AI_KINDS);

// Analysis status → ui Badge tone.
export const STATUS_TONES = {
  PENDING:   'neutral',
  RUNNING:   'info',
  SUCCEEDED: 'success',
  FAILED:    'danger',
};

// target_screen → wizard route. Used by the "1 change applied to X"
// pill so the underwriter can hop straight to the screen affected
// by an accepted recommendation.
export const SCREEN_ROUTES = {
  FAC_RISK_DETAIL:  'risk-detail',
  FAC_LOCATIONS:    'locations',
  FAC_COPE:         'cope',
  FAC_PRICING:      'pricing',
  FAC_LOSS_HISTORY: 'loss-history',
  FAC_DEDUCTIBLES:  'deductibles',
};

export function fmtBytes(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return '—';
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / (1024 * 1024)).toFixed(1)} MB`;
}

// Confidence-bar colour tiers used by both the drawer and any other
// surface that surfaces a recommendation card.
export function confidenceColor(c) {
  const n = Number(c);
  if (!Number.isFinite(n)) return 'rgba(148,163,184,0.30)';
  if (n >= 0.85) return '#23d18b';
  if (n >= 0.5)  return '#fbbf24';
  return 'rgba(148,163,184,0.35)';
}

// Compact JSON renderer for the "Raw extracted fields" block in the
// drawer. Falls back to a stringified summary if the value isn't
// JSON-serialisable (shouldn't happen, but defends against weird
// payloads from older analyses).
export function jsonPreview(v) {
  try { return JSON.stringify(v, null, 2); }
  catch { return String(v); }
}

// Per-recommendation editor semantics. Reads data_type semantics from
// the target_field name (factor.* / clause.* / *.append / cope.* /
// dates / numbers / generic text), so the drawer doesn't need a
// separate field-catalogue fetch.
export function inferInputKind(targetField) {
  if (targetField.startsWith('factor.')) return 'FACTOR_OPTION';
  if (targetField.startsWith('clause.')) return 'CLAUSE_TOGGLE';
  if (targetField === 'location.append')   return 'LOCATION_ARRAY';
  if (targetField === 'loss_history.append') return 'LOSS_APPEND';
  if (/_date$/.test(targetField))          return 'DATE';
  if (targetField === 'occupancy_code')    return 'INT';
  // Heuristic: anything containing 'pct' / '_pm' / numeric COPE fields → number.
  if (/_pct$|_pm$|_km$|si$|years?$|_si$/i.test(targetField)) return 'NUMERIC';
  if (targetField.startsWith('cope.construction_year')) return 'INT';
  return 'TEXT';
}

export function formatForEditor(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number') return String(v);
  if (typeof v === 'boolean') return v ? 'true' : 'false';
  try { return JSON.stringify(v, null, 2); } catch { return String(v); }
}

export function parseFromEditor(raw, inputKind) {
  if (raw == null) return null;
  switch (inputKind) {
    case 'NUMERIC': {
      const n = Number(String(raw).replace(/,/g, '').trim());
      return Number.isFinite(n) ? n : null;
    }
    case 'INT': {
      const n = Number(String(raw).trim());
      return Number.isFinite(n) ? Math.trunc(n) : null;
    }
    case 'DATE': return String(raw).slice(0, 10) || null;
    case 'CLAUSE_TOGGLE': return raw === false || raw === 'false' ? false : true;
    case 'LOCATION_ARRAY':
    case 'LOSS_APPEND': {
      try { return JSON.parse(raw); }
      catch { return raw; } // server will likely fail; leave the bad value visible
    }
    case 'FACTOR_OPTION':
    case 'TEXT':
    default: return String(raw);
  }
}
