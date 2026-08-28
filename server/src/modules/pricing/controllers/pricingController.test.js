// Unit tests for the pricing controller hardening:
//   F60 — the standalone PUTs pass If-Unmodified-Since through to the guarded
//         repository saves and echo the fresh parent token back.
//   F61 — snapshot delete resolves the owning contract, takes the assignee
//         edit-lock, scopes the DELETE, and 404s unknown ids; snapshot create
//         attributes created_by from the VERIFIED actor, never the client body.
//   F62 — countryAggregates propagates DB errors (asyncHandler → 5xx) instead
//         of returning a 200 with zeros that reads as "no other exposure".

import { describe, it, expect, vi, beforeEach } from 'vitest';

const h = vi.hoisted(() => ({
  upsertPricingOutputs: vi.fn(),
  replacePricingYearly: vi.fn(),
  getCountryAggregates: vi.fn(),
  createComponentSnapshot: vi.fn(),
  getComponentSnapshotById: vi.fn(),
  deleteComponentSnapshot: vi.fn(),
  resolveActor: vi.fn(),
  assertCanEdit: vi.fn(),
}));

vi.mock('../repositories/pricingRepository.js', () => ({
  getTreatyPricing: vi.fn(),
  getPricingOutputs: vi.fn(),
  upsertPricingOutputs: h.upsertPricingOutputs,
  getPricingYearly: vi.fn(),
  replacePricingYearly: h.replacePricingYearly,
  saveCompositePricing: vi.fn(),
  saveStraightStats: vi.fn(),
  loadStraightStats: vi.fn(),
  getOffer: vi.fn(),
  getCountryAggregates: h.getCountryAggregates,
  getAggCobBreakdown: vi.fn(),
  getAggDrilldown: vi.fn(),
  getMarketAverage: vi.fn(),
  createComponentSnapshot: h.createComponentSnapshot,
  listComponentSnapshots: vi.fn(),
  getComponentSnapshotById: h.getComponentSnapshotById,
  deleteComponentSnapshot: h.deleteComponentSnapshot,
}));
vi.mock('../services/pricingWorkflowService.js', () => ({
  saveOfferAction: vi.fn(),
  declineTreatyAction: vi.fn(),
  submitForApprovalAction: vi.fn(),
  peerDecisionAction: vi.fn(),
  arbiterDecisionAction: vi.fn(),
  getApprovalStateAction: vi.fn(),
  getEligibleApproversAction: vi.fn(),
  getArbiterOptionsAction: vi.fn(),
  markApprovedAction: vi.fn(),
  returnToUnderwriterAction: vi.fn(),
  getApprovalTrailAction: vi.fn(),
  recallOfferAction: vi.fn(),
  markSignedAction: vi.fn(),
  markNtuAction: vi.fn(),
  getOfferPermissionsAction: vi.fn(),
}));
vi.mock('../services/pricingHelpers.js', () => ({ resolveActor: h.resolveActor }));
vi.mock('../../../services/permissions.js', () => ({ assertCanEdit: h.assertCanEdit }));
vi.mock('../../../lib/logger.js', () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock('../../../lib/pricingVerifier.js', () => ({
  verifyNpPricingOutputs: vi.fn(() => []),
  summariseDrifts: vi.fn(() => ''),
  isStrictMode: vi.fn(() => false),
  pricingDriftStats: vi.fn(() => ({})),
}));
vi.mock('../../../observability/businessMetrics.js', () => ({ recordPricingDrift: vi.fn() }));

const {
  putPricingOutputsController,
  putPricingYearlyController,
  countryAggregatesController,
  createComponentSnapshotController,
  deleteComponentSnapshotController,
} = await import('./pricingController.js');

function mockRes() {
  const res = { statusCode: 200, body: null };
  res.status = vi.fn((code) => { res.statusCode = code; return res; });
  res.json = vi.fn((body) => { res.body = body; return res; });
  return res;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.resolveActor.mockResolvedValue({ actorUserId: 'u-1', actorName: 'Vera Verified', actorRole: 'UW' });
  h.assertCanEdit.mockResolvedValue({ canEdit: true });
});

describe('putPricingOutputsController (F60)', () => {
  it('passes the If-Unmodified-Since header into the guarded save and echoes the fresh token', async () => {
    h.upsertPricingOutputs.mockResolvedValue('2026-08-01T00:00:00.000Z');
    const res = mockRes();
    await putPricingOutputsController(
      { params: { id: 'c1' }, body: { epi: 1 }, headers: { 'if-unmodified-since': '2026-07-31T00:00:00.000Z' } },
      res,
    );
    expect(h.upsertPricingOutputs).toHaveBeenCalledWith('c1', { epi: 1 }, {
      ifUnmodifiedSince: '2026-07-31T00:00:00.000Z',
    });
    expect(res.body).toEqual({ ok: true, updated_at: '2026-08-01T00:00:00.000Z' });
  });

  it('propagates a 409 STALE_WRITE from the repository', async () => {
    h.upsertPricingOutputs.mockRejectedValue(Object.assign(new Error('stale'), { status: 409, code: 'STALE_WRITE' }));
    await expect(
      putPricingOutputsController({ params: { id: 'c1' }, body: {}, headers: { 'if-unmodified-since': 'x' } }, mockRes()),
    ).rejects.toMatchObject({ code: 'STALE_WRITE' });
  });
});

describe('putPricingYearlyController (F60)', () => {
  it('passes the header through with the rows and echoes the fresh token', async () => {
    h.replacePricingYearly.mockResolvedValue('2026-08-01T00:00:00.000Z');
    const res = mockRes();
    await putPricingYearlyController(
      { params: { id: 'c1' }, body: { rows: [{ uw_year: 2024 }] }, headers: { 'if-unmodified-since': 't0' } },
      res,
    );
    expect(h.replacePricingYearly).toHaveBeenCalledWith('c1', [{ uw_year: 2024 }], { ifUnmodifiedSince: 't0' });
    expect(res.body).toEqual({ ok: true, updated_at: '2026-08-01T00:00:00.000Z' });
  });
});

describe('countryAggregatesController (F62)', () => {
  it('propagates a DB error instead of masking it as 200-with-zeros', async () => {
    h.getCountryAggregates.mockRejectedValue(new Error('statement timeout'));
    const res = mockRes();
    await expect(
      countryAggregatesController({ params: { countryId: 'cty-1' }, query: {} }, res),
    ).rejects.toThrow('statement timeout');
    expect(res.json).not.toHaveBeenCalled();
  });

  it('still returns zeros for a country with no aggregate rows (legitimate empty)', async () => {
    h.getCountryAggregates.mockResolvedValue(null);
    const res = mockRes();
    await countryAggregatesController({ params: { countryId: 'cty-1' }, query: {} }, res);
    expect(res.body).toEqual({ total_agg: 0, total_country_agg: 0, weighted_country_agg: 0 });
  });
});

describe('createComponentSnapshotController (F61)', () => {
  it('attributes created_by from the verified actor, ignoring a client-supplied created_by', async () => {
    h.createComponentSnapshot.mockResolvedValue({ id: 7 });
    const res = mockRes();
    await createComponentSnapshotController(
      { params: { id: 'c1' }, body: { label: 'v1', components: [], created_by: 'FORGED' } },
      res,
    );
    expect(h.createComponentSnapshot).toHaveBeenCalledWith('c1', 'v1', [], 'Vera Verified');
  });

  it('falls back to the verified user id when no display name resolves', async () => {
    h.resolveActor.mockResolvedValue({ actorUserId: 'u-9', actorName: 'SYSTEM', actorRole: null });
    h.createComponentSnapshot.mockResolvedValue({ id: 8 });
    await createComponentSnapshotController({ params: { id: 'c1' }, body: { components: [] } }, mockRes());
    expect(h.createComponentSnapshot).toHaveBeenCalledWith('c1', undefined, [], 'u-9');
  });
});

describe('deleteComponentSnapshotController (F61)', () => {
  it('resolves the owning contract, edit-locks it, and scopes the delete to (id, contract_id)', async () => {
    h.getComponentSnapshotById.mockResolvedValue({ id: 12, contract_id: 'c-owner' });
    const res = mockRes();
    await deleteComponentSnapshotController({ params: { snapId: '12' }, headers: {} }, res);
    expect(h.assertCanEdit).toHaveBeenCalledWith(expect.anything(), 'CONTRACT', 'c-owner');
    expect(h.deleteComponentSnapshot).toHaveBeenCalledWith(12, 'c-owner');
    expect(res.body).toEqual({ ok: true });
  });

  it('404s an unknown snapshot id instead of a silent no-op 200', async () => {
    h.getComponentSnapshotById.mockResolvedValue(null);
    const res = mockRes();
    await deleteComponentSnapshotController({ params: { snapId: '999' } }, res);
    expect(res.statusCode).toBe(404);
    expect(h.deleteComponentSnapshot).not.toHaveBeenCalled();
  });

  it('404s a non-integer snapshot id without touching the DB', async () => {
    const res = mockRes();
    await deleteComponentSnapshotController({ params: { snapId: 'abc' } }, res);
    expect(res.statusCode).toBe(404);
    expect(h.getComponentSnapshotById).not.toHaveBeenCalled();
  });

  it('propagates the 403 READ_ONLY when the requester is not the assignee', async () => {
    h.getComponentSnapshotById.mockResolvedValue({ id: 12, contract_id: 'c-owner' });
    h.assertCanEdit.mockRejectedValue(Object.assign(new Error('read only'), { status: 403, code: 'READ_ONLY' }));
    await expect(
      deleteComponentSnapshotController({ params: { snapId: '12' } }, mockRes()),
    ).rejects.toMatchObject({ code: 'READ_ONLY' });
    expect(h.deleteComponentSnapshot).not.toHaveBeenCalled();
  });
});
