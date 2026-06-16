// Tests for the contract history timeline service (contractHistory.js).
//
// The pure helpers (extractChanges, mergeTimeline) are exercised directly.
// getContractHistory is run against a SQL-text-dispatched pool mock so the
// merge / actor-resolution / newest-first ordering is verified without a DB.
import { describe, it, expect, vi } from 'vitest';

const { poolMock } = vi.hoisted(() => ({ poolMock: { query: vi.fn() } }));
vi.mock('../db/pool.js', () => ({ pool: poolMock }));

const { getContractHistory, mergeTimeline, extractChanges } = await import('./contractHistory.js');

describe('extractChanges', () => {
  it('returns undefined when there is nothing field-level', () => {
    expect(extractChanges(null)).toBeUndefined();
    expect(extractChanges({})).toBeUndefined();
    expect(extractChanges({ decision: 'APPROVED' })).toBeUndefined();
  });

  it('normalises an array of changes with assorted key names', () => {
    expect(extractChanges({ changes: [{ field: 'commission', from: 25, to: 30 }] }))
      .toEqual([{ field: 'commission', from: 25, to: 30 }]);
    expect(extractChanges({ diff: [{ path: 'limit', before: 1, after: 2 }] }))
      .toEqual([{ field: 'limit', from: 1, to: 2 }]);
    expect(extractChanges({ changes: [{ key: 'cob', old: 'A', new: 'B' }] }))
      .toEqual([{ field: 'cob', from: 'A', to: 'B' }]);
  });

  it('normalises an object map of changes', () => {
    expect(extractChanges({ changes: { rate: { from: 1, to: 2 } } }))
      .toEqual([{ field: 'rate', from: 1, to: 2 }]);
    expect(extractChanges({ changes: { rate: [1, 2] } }))
      .toEqual([{ field: 'rate', from: 1, to: 2 }]);
  });

  it('diffs a before/after snapshot pair, only changed keys', () => {
    const out = extractChanges({ before: { a: 1, b: 2 }, after: { a: 1, b: 9 } });
    expect(out).toEqual([{ field: 'b', from: 2, to: 9 }]);
  });
});

describe('mergeTimeline', () => {
  it('merges sources newest-first and applies the limit', () => {
    const a = [{ id: 'a1', at: '2026-01-01T00:00:00Z' }, { id: 'a2', at: '2026-03-01T00:00:00Z' }];
    const b = [{ id: 'b1', at: '2026-02-01T00:00:00Z' }];
    const out = mergeTimeline([a, b], { limit: 2 });
    expect(out.map((x) => x.id)).toEqual(['a2', 'b1']);
  });
});

// ── getContractHistory against a mocked pool ─────────────────────────────────

const AUDIT_RE = /FROM public\.contract_audit_event/i;
const WORKFLOW_RE = /FROM public\.contract_workflow_event/i;
const DECISION_RE = /FROM public\.approval_decision/i;

function mockSources({ audit = [], workflow = [], decisions = [] }) {
  poolMock.query = vi.fn(async (sql) => {
    const s = String(sql);
    if (AUDIT_RE.test(s)) return { rows: audit };
    if (WORKFLOW_RE.test(s)) return { rows: workflow };
    if (DECISION_RE.test(s)) return { rows: decisions };
    return { rows: [] };
  });
}

describe('getContractHistory', () => {
  it('merges the three sources, resolves actors and surfaces changes', async () => {
    mockSources({
      audit: [{
        event_id: 'e1', event_type: 'UPDATED', actor_ref: 'u-1', created_at: '2026-05-02T00:00:00Z',
        actor_user_id: 'u-1', actor_display_name: 'Jane UW', actor_role_code: 'TUW',
        payload: { changes: [{ field: 'commission', from: 25, to: 30 }] },
      }],
      workflow: [{
        event_id: 'w1', from_status: 'DRAFT', to_status: 'AWAITING_APPROVAL', actor_ref: 'u-1',
        comment: null, created_at: '2026-05-03T00:00:00Z',
        actor_user_id: 'u-1', actor_display_name: 'Jane UW', actor_role_code: 'TUW',
      }],
      decisions: [{
        decision_id: 'd1', decision: 'APPROVED', comment: 'looks good', decided_at: '2026-05-04T00:00:00Z',
        actor_user_id: 'u-2', actor_display_name: 'Carl CU', actor_role_code: 'CU',
      }],
    });

    const items = await getContractHistory('c1', { limit: 50 });

    // Newest-first: decision (05-04) → workflow (05-03) → audit (05-02)
    expect(items.map((i) => i.source)).toEqual(['approval', 'workflow', 'audit']);

    const decision = items[0];
    expect(decision.actor).toEqual({ id: 'u-2', name: 'Carl CU', role: 'CU' });
    expect(decision.type).toBe('DECISION_APPROVED');
    expect(decision.comment).toBe('looks good');

    const workflow = items[1];
    expect(workflow.summary).toBe('Status changed DRAFT → AWAITING_APPROVAL');
    expect(workflow.changes).toEqual([{ field: 'status', from: 'DRAFT', to: 'AWAITING_APPROVAL' }]);

    const audit = items[2];
    expect(audit.actor).toEqual({ id: 'u-1', name: 'Jane UW', role: 'TUW' });
    expect(audit.changes).toEqual([{ field: 'commission', from: 25, to: 30 }]);
    expect(audit.summary).toBe('Treaty details updated');
  });

  it('falls back to a SYSTEM actor and survives a failing source', async () => {
    poolMock.query = vi.fn(async (sql) => {
      const s = String(sql);
      if (AUDIT_RE.test(s)) {
        return {
          rows: [{
            event_id: 'e1', event_type: 'AUTOSAVED', actor_ref: 'SYSTEM', created_at: '2026-05-02T00:00:00Z',
            actor_user_id: null, actor_display_name: null, actor_role_code: null, payload: null,
          }],
        };
      }
      if (WORKFLOW_RE.test(s)) throw new Error('relation does not exist');
      return { rows: [] }; // decisions
    });

    const items = await getContractHistory('c1');
    expect(items).toHaveLength(1);
    expect(items[0].actor).toEqual({ id: null, name: 'System', role: null });
    expect(items[0].changes).toBeUndefined();
  });
});
