// server/src/lib/statusMachine.test.js
// Pins the uw_status lifecycle. If any of these change, the audit
// trail should change with them — not quietly.

import { describe, it, expect } from 'vitest';
import {
  UW_STATUSES,
  LEGAL_TRANSITIONS,
  isLegalTransition,
  isTerminal,
  assertLegalTransition,
  InvalidTransitionError,
} from './statusMachine.js';

describe('UW_STATUSES', () => {
  it('contains exactly the seven workflow states', () => {
    expect(UW_STATUSES).toEqual([
      'DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'AWAITING_SIGNED_LINE',
      'SIGNED', 'NTU', 'DECLINED',
    ]);
  });

  it('is frozen so nobody mutates the canonical list', () => {
    expect(Object.isFrozen(UW_STATUSES)).toBe(true);
  });
});

describe('LEGAL_TRANSITIONS', () => {
  it('has an entry for every status', () => {
    for (const s of UW_STATUSES) expect(LEGAL_TRANSITIONS[s]).toBeInstanceOf(Set);
  });

  it('terminal states have only a self-loop', () => {
    expect([...LEGAL_TRANSITIONS.SIGNED]).toEqual(['SIGNED']);
    expect([...LEGAL_TRANSITIONS.NTU]).toEqual(['NTU']);
    expect([...LEGAL_TRANSITIONS.DECLINED]).toEqual(['DECLINED']);
  });

  it('DRAFT can only flow to AWAITING_APPROVAL or DECLINED (or stay)', () => {
    expect([...LEGAL_TRANSITIONS.DRAFT].sort()).toEqual(['AWAITING_APPROVAL', 'DECLINED', 'DRAFT']);
  });
});

describe('isLegalTransition', () => {
  it.each([
    ['DRAFT',                'AWAITING_APPROVAL',     true,  'submit for approval'],
    ['AWAITING_APPROVAL',     'APPROVED',             true,  'peer/arbiter approval (engine)'],
    ['AWAITING_APPROVAL',     'AWAITING_SIGNED_LINE', true,  'mark-approved skips APPROVED'],
    ['APPROVED',             'AWAITING_SIGNED_LINE', true,  'legacy mark approved → offer'],
    ['AWAITING_SIGNED_LINE', 'SIGNED',               true,  'mark signed'],
    ['AWAITING_SIGNED_LINE', 'NTU',                  true,  'mark NTU'],
    ['AWAITING_APPROVAL',     'DRAFT',                true,  'return to underwriter'],
    ['AWAITING_SIGNED_LINE', 'DRAFT',                true,  'recall offer'],
    ['DRAFT',                'DECLINED',             true,  'kill draft outright'],
  ])('legal: %s → %s (%s)', (from, to, expected) => {
    expect(isLegalTransition(from, to)).toBe(expected);
  });

  it.each([
    ['DRAFT',                'SIGNED',               'the big one — jump to signed'],
    ['DRAFT',                'APPROVED',             'skip approval entirely'],
    ['DRAFT',                'AWAITING_SIGNED_LINE', 'skip approval + offer step'],
    ['SIGNED',               'DRAFT',                'terminal → anything'],
    ['SIGNED',               'NTU',                  'signed cannot become NTU'],
    ['NTU',                  'SIGNED',               'NTU cannot become signed'],
    ['DECLINED',             'DRAFT',                'cannot resurrect a declined'],
  ])('illegal: %s → %s (%s)', (from, to) => {
    expect(isLegalTransition(from, to)).toBe(false);
  });

  it('self-transitions are always legal (no-op save)', () => {
    for (const s of UW_STATUSES) expect(isLegalTransition(s, s)).toBe(true);
  });

  it('unknown values on either side return false', () => {
    expect(isLegalTransition('SOMETIMES',       'SIGNED')).toBe(false);
    expect(isLegalTransition('DRAFT',           'BLESSED')).toBe(false);
    expect(isLegalTransition(null,              'SIGNED')).toBe(false);
    expect(isLegalTransition(undefined,         undefined)).toBe(false);
  });

  it('accepts lowercase input (coerces to upper)', () => {
    expect(isLegalTransition('draft', 'awaiting_approval')).toBe(true);
  });
});

describe('isTerminal', () => {
  it('SIGNED/NTU/DECLINED are terminal', () => {
    expect(isTerminal('SIGNED')).toBe(true);
    expect(isTerminal('NTU')).toBe(true);
    expect(isTerminal('DECLINED')).toBe(true);
  });
  it('all others are not', () => {
    for (const s of ['DRAFT', 'AWAITING_APPROVAL', 'APPROVED', 'AWAITING_SIGNED_LINE']) {
      expect(isTerminal(s)).toBe(false);
    }
  });
});

describe('assertLegalTransition', () => {
  it('returns quietly on a legal edge', () => {
    expect(() => assertLegalTransition('DRAFT', 'AWAITING_APPROVAL')).not.toThrow();
  });

  it('throws InvalidTransitionError on an illegal edge', () => {
    try {
      assertLegalTransition('DRAFT', 'SIGNED');
      throw new Error('expected assert to throw');
    } catch (err) {
      expect(err).toBeInstanceOf(InvalidTransitionError);
      expect(err.code).toBe('INVALID_TRANSITION');
      expect(err.from).toBe('DRAFT');
      expect(err.to).toBe('SIGNED');
      expect(err.message).toContain('DRAFT');
      expect(err.message).toContain('SIGNED');
    }
  });
});
