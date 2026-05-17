// Tests for the NP treaty type classifiers + the matching wizard
// filtering behaviour. Locking these down because the same flags drive
// both the sidebar tabs and the Back/Next navigation — a mismatch
// would let a step appear in the sidebar but skip past it on Next.

import { describe, it, expect } from 'vitest';
import {
  getNpTreatyTypeMode,
  isNpCatFlowDisabled,
  isNpRiskFlowDisabled,
  isNpStopLossTreaty,
  isNpAggregateXlTreaty,
} from './npTreatyType.js';
import { getWizardNav } from '../config/wizard.js';

const state = (name) => ({ npTreatyDetail: { treatyTypeName: name } });

describe('getNpTreatyTypeMode', () => {
  it('Risk XL → RISK', () => {
    expect(getNpTreatyTypeMode(state('Risk XL'))).toBe('RISK');
    expect(getNpTreatyTypeMode(state('  risk  xl '))).toBe('RISK');
  });
  it('CAT XL → CAT', () => {
    expect(getNpTreatyTypeMode(state('CAT XL'))).toBe('CAT');
  });
  it('Stop Loss / Aggregate XL / Risk & CAT XL → BOTH', () => {
    expect(getNpTreatyTypeMode(state('Stop Loss'))).toBe('BOTH');
    expect(getNpTreatyTypeMode(state('Aggregate XL'))).toBe('BOTH');
    expect(getNpTreatyTypeMode(state('Risk & CAT XL'))).toBe('BOTH');
  });
  it('unknown / empty → BOTH (permissive default)', () => {
    expect(getNpTreatyTypeMode(state(''))).toBe('BOTH');
    expect(getNpTreatyTypeMode({})).toBe('BOTH');
  });
});

describe('isNpStopLossTreaty', () => {
  it('true only for Stop Loss (Aggregate XL is now a separate flow)', () => {
    expect(isNpStopLossTreaty(state('Stop Loss'))).toBe(true);
    expect(isNpStopLossTreaty(state('stop loss'))).toBe(true);
  });
  it('false for Aggregate XL (was true before separation)', () => {
    expect(isNpStopLossTreaty(state('Aggregate XL'))).toBe(false);
    expect(isNpStopLossTreaty(state('aggregate xl'))).toBe(false);
  });
  it('false for Risk XL / CAT XL / Risk & CAT XL', () => {
    expect(isNpStopLossTreaty(state('Risk XL'))).toBe(false);
    expect(isNpStopLossTreaty(state('CAT XL'))).toBe(false);
    expect(isNpStopLossTreaty(state('Risk & CAT XL'))).toBe(false);
  });
  it('false for unknown / empty treaty type', () => {
    expect(isNpStopLossTreaty(state(''))).toBe(false);
    expect(isNpStopLossTreaty({})).toBe(false);
  });
  it('non-overlap with cat/risk flags — Stop Loss treaty has neither disabled', () => {
    const s = state('Stop Loss');
    expect(isNpCatFlowDisabled(s)).toBe(false);
    expect(isNpRiskFlowDisabled(s)).toBe(false);
    expect(isNpStopLossTreaty(s)).toBe(true);
  });
});

describe('isNpAggregateXlTreaty', () => {
  it('true only for Aggregate XL', () => {
    expect(isNpAggregateXlTreaty(state('Aggregate XL'))).toBe(true);
    expect(isNpAggregateXlTreaty(state('aggregate xl'))).toBe(true);
    expect(isNpAggregateXlTreaty(state('Stop Loss'))).toBe(false);
    expect(isNpAggregateXlTreaty(state('Risk XL'))).toBe(false);
  });
});

describe('getWizardNav — NP_STOP_LOSS_PRICING visibility', () => {
  it('hidden when npStopLoss is false (default for Risk XL / CAT XL)', () => {
    const { order } = getWizardNav('NP_TREATY_DETAIL', { npStopLoss: false });
    expect(order).not.toContain('NP_STOP_LOSS_PRICING');
  });

  it('visible when npStopLoss is true (Stop Loss / Aggregate XL)', () => {
    const { order } = getWizardNav('NP_TREATY_DETAIL', { npStopLoss: true });
    expect(order).toContain('NP_STOP_LOSS_PRICING');
    // Inserted right before NP_FINAL_PRICING.
    expect(order.indexOf('NP_STOP_LOSS_PRICING'))
      .toBe(order.indexOf('NP_FINAL_PRICING') - 1);
  });

  it('Back/Next on Risk Profile skips the stop-loss step when hidden', () => {
    const { next } = getWizardNav('NP_EVENT_LOSS_TABLES', { npStopLoss: false });
    expect(next).toBe('NP_FINAL_PRICING');
  });

  it('Back/Next on Risk Profile walks through the stop-loss step when visible', () => {
    const { next } = getWizardNav('NP_EVENT_LOSS_TABLES', { npStopLoss: true });
    expect(next).toBe('NP_STOP_LOSS_PRICING');
  });

  it('NP_STOP_LOSS_PRICING itself returns nav neighbours when visible', () => {
    const { prev, next } = getWizardNav('NP_STOP_LOSS_PRICING', { npStopLoss: true });
    expect(prev).toBe('NP_EVENT_LOSS_TABLES');
    expect(next).toBe('NP_FINAL_PRICING');
  });

  it('order is unchanged for FAC / PROP modes', () => {
    const fac = getWizardNav('FAC_RISK_DETAIL', { npStopLoss: true });
    expect(fac.order).not.toContain('NP_STOP_LOSS_PRICING');
    const prop = getWizardNav('PROP_TREATY_DETAIL', { npStopLoss: true });
    expect(prop.order).not.toContain('NP_STOP_LOSS_PRICING');
  });
});
