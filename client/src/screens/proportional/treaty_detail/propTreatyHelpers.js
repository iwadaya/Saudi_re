// src/screens/proportional/treaty_detail/propTreatyHelpers.js
// Pure constants + helpers for the proportional treaty-detail screen (number
// coercion/formatting, treaty-mode detection, required-field validation, LP-slide
// extraction, date math). Extracted to keep the screen under the 800-line budget.
// No React, no side effects; some are re-exported from PropTreatyDetail for the
// unit tests that pin their behaviour.
import { addMonthsClamped, yearFromDateInput } from '../../../utils/format';

export const ALLOWED_PROP_TYPES = new Set(['Quota Share','Quota Share & Surplus','First Surplus','Second Surplus','Third Surplus','Fac Oblig']);
export const NA_TYPE = 'Not applicable for this treaty type';
export const PROP_SLIP_CURRENT_KEYS = 'countryId cedantId treatyTypeId classIds brokerId currencyId inceptionDate renewalDate experienceStartYear qsLimit retentionPct cessionPct surplusMaxRetention numLines eventLimit aal quotaShareEpi surplusEpi brokeragePct taxesPct lossCapPct fixedCommissionQSPct'.split(' ');
export const pickKeys = (source, keys) => keys.reduce((out, key) => { out[key] = source[key]; return out; }, {});

/* ─── helpers (exported for unit tests) ─── */
export const numOrNull = v => { const c = String(v ?? '').replace(/,/g,'').trim(); if (!c) return null; const n = Number(c); return Number.isFinite(n) ? n : null; };
export const clampPct = v => { const n = numOrNull(v); return n == null ? 0 : Math.max(0, Math.min(100, n)); };
export const fmtComma = v => { const d = String(v ?? '').replace(/[^\d]/g,''); return d ? Number(d).toLocaleString('en-US') : ''; };
/** Like fmtComma but preserves a decimal portion. "1234.5" → "1,234.5". */
export { formatWithCommasDecimal as fmtCommaDecimal } from '../../../utils/format';
export const stripDigits = v => String(v ?? '').replace(/[^\d]/g,'');
/** Decimal-preserving variant of stripDigits. Keeps digits and a decimal point. */
export const stripNonNumeric = v => String(v ?? '').replace(/[^\d.]/g, '');
export const normalizeCommMode = v => { const r = String(v ?? '').toLowerCase(); return r.includes('slid') ? 'sliding' : 'fixed'; };
/** Strip trailing decimal zeros from DB numeric values: "30.000000" → "30", "2.50" → "2.5", "" → "" */
export const cleanNum = v => { if (v == null || v === '') return ''; const n = Number(v); if (!Number.isFinite(n)) return String(v); return n === Math.floor(n) ? String(Math.floor(n)) : String(n); };

/**
 * Extract loss-participation slides from the LP modal's row state.
 * Drops empty rows and converts to the snake_case shape the API expects.
 * Pure & exported so the audit's "no LP corridors silently dropped" test
 * can pin behavior without rendering the component.
 */
export function extractLpSlides(lpSlides) {
  return (lpSlides || [])
    .filter(r => r && (r.minLr || r.maxLr || r.share))
    .map(r => ({ min_lr: numOrNull(r.minLr), max_lr: numOrNull(r.maxLr), share: numOrNull(r.share) }));
}

/**
 * Returns the list of human-readable field labels that are required
 * for the current treaty mode + commission mode but missing from the
 * slice. Empty array means OK to proceed.
 *
 * "Active" fields only — disabled fields are skipped. Mirrors the
 * disabled={!isQS}/{!isSurplus} gates in the JSX so the rule is
 * "if you can see it active, you must fill it".
 *
 * Nullable (NEVER added to the missing list): Event Limit, AAL,
 * Brokerage %, Taxes %, Loss Cap %, Mgmt Expenses %, Profit
 * Commission %, LCF, Alt Contract ID. Loss Participation scalars
 * become required when the toggle is YES.
 */
export function getMissingRequiredFields(s, { tMode, commMode }) {
  const has = v => v != null && String(v).trim() !== '';
  const missing = [];

  // Always required
  if (!has(s.countryId))           missing.push('Country');
  if (!has(s.cedantId))            missing.push('Cedant Name');
  if (!has(s.treatyTypeId))        missing.push('Treaty Type');
  if (!(s.classIds || []).length)  missing.push('Line of Business');
  if (!has(s.brokerId))            missing.push('Broker');
  if (!has(s.currencyId))          missing.push('Currency');
  if (!has(s.inceptionDate))       missing.push('Treaty Inception Date');
  if (!has(s.experienceStartYear)) missing.push('Experience Start Year');

  const isQS = tMode === 'quota' || tMode === 'both';
  const isSurplus = tMode === 'surplus' || tMode === 'both';

  // QS side (required when QS active — both sides required in 'both' mode)
  if (isQS) {
    if (!has(s.qsLimit))       missing.push('QS 100% Limit');
    if (!has(s.retentionPct))  missing.push('Retention %');
    if (!has(s.quotaShareEpi)) missing.push('Quota Share EPI');
  }
  // Surplus side
  if (isSurplus) {
    if (!has(s.surplusMaxRetention)) missing.push('Surplus Max Retention');
    if (!has(s.numLines))            missing.push('Number of Lines');
    if (!has(s.surplusEpi))          missing.push('Surplus EPI');
  }

  // Commissions
  if (commMode === 'fixed') {
    if (isQS && !has(s.fixedCommissionQSPct))           missing.push('Fixed QS Commission %');
    if (isSurplus && !has(s.fixedCommissionSurplusPct)) missing.push('Fixed Surplus Commission %');
  } else if (commMode === 'sliding') {
    if (!has(s.slidingMinLossRatio))      missing.push('Sliding Min Loss Ratio %');
    if (!has(s.slidingMaxLossRatio))      missing.push('Sliding Max Loss Ratio %');
    if (!has(s.slidingMinCommission))     missing.push('Sliding Min Commission %');
    if (!has(s.slidingMaxCommission))     missing.push('Sliding Max Commission %');
    if (!has(s.provisionalCommissionPct)) missing.push('Provisional Commission %');
    const validRows = (s.slidingTable || []).filter(r => has(r.lossRatioPct) && has(r.commissionPct));
    if (validRows.length < 2) missing.push('Sliding Scale table (need ≥2 complete rows)');
  }

  // Loss participation — only when toggle is YES, scalar trio is required
  if (s.lossPartEnabled !== false) {
    if (!has(s.minLossRatioPct))   missing.push('LP Min Loss Ratio %');
    if (!has(s.maxLossRatioPct))   missing.push('LP Max Loss Ratio %');
    if (!has(s.reinsurerSharePct)) missing.push('LP Reinsurer Share %');
  }

  return missing;
}

export function treatyModeFromType(name) {
  const n = String(name ?? '').toLowerCase();
  if (n.includes('quota') && n.includes('surplus')) return 'both';
  if (n.includes('quota')) return 'quota';
  if (n.includes('surplus') || n.includes('fac oblig')) return 'surplus';
  return 'quota';
}

/**
 * Add months to a 'YYYY-MM-DD' date string with day clamping. JS's
 * Date.setMonth overflows when the source day doesn't exist in the
 * target month (e.g. Jan 31 → Mar 3). Clamp to the last valid day.
 */
export function addMonths(dateStr, months) {
  return addMonthsClamped(dateStr, months);
}

/** Year from an ISO date input ('YYYY-MM-DD') without timezone conversion. */
export const yearFromDateStr = yearFromDateInput;

/**
 * True only when every column that migration 104 made NOT NULL on quote and
 * contract is present: cedant, broker, currency, country, treaty_type,
 * uw_year (startYear or derived from inception), and inception_date. The
 * unmount autosave uses this to avoid POSTing a partial draft that the DB
 * would reject — there is no valid partial-draft row without these.
 */
export function canPersistTreatyHeader(s = {}) {
  const has = v => v != null && String(v).trim() !== '';
  const uwYear = s.startYear || yearFromDateStr(s.inceptionDate);
  return has(s.cedantId) && has(s.brokerId) && has(s.currencyId) &&
    has(s.countryId) && has(s.treatyTypeId) && has(uwYear) &&
    has(s.inceptionDate);
}

/* Close-on-Escape — wired by every screen-level modal in this file. */
