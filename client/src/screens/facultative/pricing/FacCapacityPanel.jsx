// src/screens/facultative/pricing/FacCapacityPanel.jsx
//
// The capacity check, at three levels. This is what finding F14 was about:
// the screen used to show `max_capacity_sar` — a static territorial budget
// that never looked at what had already been written — so ten identical
// warehouses in one CRESTA zone each passed against the same untouched
// number. This panel shows the committed book.
//
// A breach is a referral, not a refusal, and the panel says so: the
// underwriter with the authority still binds it, and the override goes on the
// record. "No budget set" is its own state and deliberately neither passes
// nor fails — a budget is an appetite decision, and showing a green tick
// against a budget nobody set would be the same failure in a nicer colour.

import { useEffect, useState } from 'react';
import api from '../../../api';
import { logger } from '../../../utils/logger';
import './FacPricing.css';

const money = (v) => (v === null || v === undefined || !Number.isFinite(Number(v))
  ? '—'
  : Math.round(Number(v)).toLocaleString('en-US'));
const pct = (v) => (v === null || v === undefined || !Number.isFinite(Number(v))
  ? '—'
  : `${(Number(v) * 100).toFixed(1)}%`);

const LEVEL_LABEL = {
  PER_RISK_LINE:        'Per-risk line',
  ZONE_ACCUMULATION:    'Zone accumulation',
  SYSTEMIC_VENDOR:      'Common vendor',
  SYSTEMIC_CONVEYANCE:  'Any one conveyance',
  SYSTEMIC_WAR_REGION:  'War region',
  SYSTEMIC_ONE_EVENT:   'One event',
};

const STATUS_CLASS = {
  PASS: 'pass',
  BREACH: 'breach',
  NO_BUDGET: 'nobudget',
  NOT_APPLICABLE: 'pass',
};

const STATUS_LABEL = {
  PASS: 'Within capacity',
  BREACH: 'Referral — capacity breach',
  NO_BUDGET: 'Committed exposure shown, no budget set',
  NOT_APPLICABLE: 'Not applicable yet',
};

function Figures({ check }) {
  const items = [];
  if (check.maxLine !== undefined) {
    items.push(['Line size', money(check.lineSize)]);
    items.push(['Max line', money(check.maxLine)]);
    if (check.written !== null && check.written !== undefined) {
      items.push(['Written', money(check.written)]);
    }
    items.push(['Headroom', money(check.headroom)]);
  }
  if (check.level === 'ZONE_ACCUMULATION') {
    items.push(['Committed', money(check.committed)]);
    items.push(['This risk', money(check.adding)]);
    items.push(['Would be', money(check.wouldBe)]);
    if (check.budget !== undefined && check.budget !== null) {
      items.push(['Budget', money(check.budget)]);
      items.push(['Utilisation', pct(check.utilisation)]);
    }
  }
  if (check.level === 'SYSTEMIC_VENDOR' && check.committedLimit !== null
      && check.committedLimit !== undefined) {
    items.push(['Committed limit', money(check.committedLimit)]);
    items.push(['Bound risks', String(check.riskCount ?? '—')]);
  }
  if (items.length === 0) return null;
  return (
    <div className="facpx-cap-figures">
      {items.map(([label, value]) => (
        <span key={label}>{label} <strong>{value}</strong></span>
      ))}
    </div>
  );
}

/**
 * @param {object} props
 * @param {string} props.riskId
 * @param {number} [props.refreshKey]  bump to re-fetch after a save
 */
export default function FacCapacityPanel({ riskId, refreshKey = 0 }) {
  const [capacity, setCapacity] = useState(null);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!riskId) return undefined;
    let live = true;
    setError(null);
    api.facGetAccumulation(riskId)
      .then((out) => { if (live) setCapacity(out); })
      .catch((err) => {
        // A capacity check that will not load must not take the pricing
        // screen with it, but it must not look like a pass either.
        logger.warn('fac capacity check failed to load', { error: err?.message });
        if (live) { setCapacity(null); setError(err?.message || 'Could not load'); }
      });
    return () => { live = false; };
  }, [riskId, refreshKey]);

  if (error) {
    return (
      <div className="facpx-empty">
        The capacity check could not be loaded ({error}). This risk has not been checked against
        the committed book.
      </div>
    );
  }
  if (!capacity) {
    return <div className="facpx-empty">Checking committed capacity…</div>;
  }

  const checks = capacity.checks || [];

  return (
    <div className="facpx-cap">
      <span className={`facpx-cap-status facpx-cap-status--${STATUS_CLASS[capacity.status] || 'pass'}`}>
        {STATUS_LABEL[capacity.status] || capacity.status}
      </span>

      {capacity.referral && (
        <div className="facpx-note">
          A breach is a referral, not a refusal. Binding needs the referral approved and the
          override recorded with a reason.
        </div>
      )}

      {checks.length === 0 && (
        <div className="facpx-empty">
          Nothing to check yet — this risk has no locations, no line size and no systemic tags.
        </div>
      )}

      {checks.map((check, i) => (
        <div className="facpx-cap-check" key={`${check.level}-${check.zone || check.vendor || check.region || i}`}>
          <div className="facpx-cap-level">
            {LEVEL_LABEL[check.level] || check.level}
            {check.zone ? ` · ${check.zone}` : ''}
            {check.vendor ? ` · ${check.vendor}` : ''}
            {check.region ? ` · ${check.region}` : ''}
          </div>
          <div>
            <div className={`facpx-cap-body${
              check.status === 'BREACH' ? ' facpx-cap-body--breach'
                : check.status === 'NO_BUDGET' ? ' facpx-cap-body--nobudget' : ''
            }`}
            >
              {check.message}
            </div>
            <Figures check={check} />
          </div>
        </div>
      ))}

      <div className="facpx-note">
        Line measured on {capacity.line_basis?.toLowerCase().replace(/_/g, ' ') || 'the risk'}
        {capacity.line_size ? ` (${money(capacity.line_size)})` : ''}.
        {capacity.zones?.length > 0 ? ` Zones: ${capacity.zones.join(', ')}.` : ''}
      </div>
    </div>
  );
}
