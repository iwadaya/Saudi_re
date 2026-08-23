// components/ledger.jsx — presentational bits shared by the Claims and
// Finance modules (the "ledger" screens). They live here rather than in a
// screen so ClaimDetailScreen doesn't have to import ClaimsHomeScreen just
// to reuse the approval badge — which would pull the whole register screen
// into the claim-detail route chunk and defeat the lazy split.
//
// Status colour comes from Badge tones (token-bound), so these reskin with
// the theme instead of carrying hard-coded hex.
import { Badge } from './ui';

/**
 * Headline metric tile used across the Claims and Finance dashboards.
 *
 * @param {object} props
 * @param {string} props.label
 * @param {import('react').ReactNode} props.value
 * @param {string} [props.sub]     small caption under the value
 * @param {'muted'|'warn'|'danger'|'ok'} [props.tone]  tints the value only
 */
export function KpiCard({ label, value, sub, tone }) {
  return (
    <div className="cf-kpi">
      <div className="cf-kpi__label">{label}</div>
      <div className={`cf-kpi__value${tone ? ` cf-kpi__value--${tone}` : ''}`}>{value}</div>
      <div className="cf-kpi__sub">{sub || ''}</div>
    </div>
  );
}

// ── Status → Badge tone maps ──────────────────────────────────────────────
// Note CLOSED means different things in the two modules: a closed *claim* is
// a settled good outcome (success), a closed *ledger entry* is simply
// inactive (neutral). Hence two maps rather than one shared one.
const CLAIM_STATUS_TONE = {
  OPEN: 'info',
  REOPENED: 'warn',
  CLOSED: 'success',
  DECLINED: 'danger',
};

const APPROVAL_TONE = {
  DRAFT: 'neutral',
  WAITING_APPROVAL: 'warn',
  REJECTED: 'danger',
  FINALISED: 'success',
};

const FINANCE_STATUS_TONE = {
  PENDING_SETUP: 'warn',
  ACTIVE: 'success',
  SUSPENDED: 'danger',
  CLOSED: 'neutral',
};

/** Underscored enum → display label ("WAITING_APPROVAL" → "WAITING APPROVAL"). */
const label = (status) => String(status ?? '').replace(/_/g, ' ');

/** Claim lifecycle: OPEN / REOPENED / CLOSED / DECLINED. */
export function ClaimStatusBadge({ status }) {
  return <Badge tone={CLAIM_STATUS_TONE[status] || 'info'}>{label(status)}</Badge>;
}

/** Claim approval state: DRAFT / WAITING_APPROVAL / REJECTED / FINALISED. */
export function ApprovalBadge({ status }) {
  return <Badge tone={APPROVAL_TONE[status] || 'neutral'}>{label(status || 'DRAFT')}</Badge>;
}

/** Finance ledger entry: PENDING_SETUP / ACTIVE / SUSPENDED / CLOSED. */
export function FinanceStatusBadge({ status }) {
  return <Badge tone={FINANCE_STATUS_TONE[status] || 'warn'}>{label(status)}</Badge>;
}

/* ── Shared ledger display formatters ─────────────────────────────────
   The claims/finance screens all render money, dates and percents the
   same way (en-dash for missing); one copy here instead of one per
   screen. */

/** Whole-unit money or en-dash: 1234567.8 → "1,234,568". */
export const fmtMoney = (v) => {
  const n = Number(v);
  if (!Number.isFinite(n)) return '–';
  return n.toLocaleString(undefined, { maximumFractionDigits: 0 });
};

/** yyyy-mm-dd slice of a date/timestamp, or en-dash. */
export const fmtDate = (v) => (v ? String(v).slice(0, 10) : '–');

/** Percent with unit, or en-dash for null/undefined. */
export const fmtPct = (v) => (v == null ? '–' : `${Number(v)}%`);
