// usePropPricingActions — F79: submit-for-approval must send epi_usd in REAL
// USD. The screen's `epi` is derived in the TREATY currency (quotaShareEpi +
// surplusEpi), and the old code posted it raw under the epi_usd key, so a SAR
// treaty's 37.5M SAR gated the approver picker as "USD 37.5M" (FX-factor off).
// The hook now converts with the same local→USD fxRate the screen already uses
// for its USD display toggle. (The server independently derives USD EPI from
// the stored contract and that value wins; this converted figure is the honest
// fallback when derivation finds nothing.)
import { describe, it, expect, vi, afterEach } from 'vitest';
import { renderHook, cleanup, act } from '@testing-library/react';

const { apiMock } = vi.hoisted(() => ({
  apiMock: {
    submitOfferForApproval: vi.fn(),
    getApprovalTrail: vi.fn(),
  },
}));
vi.mock('../../../../api', () => ({ api: apiMock }));

const { usePropPricingActions } = await import('./usePropPricingActions.js');

function build(over = {}) {
  return renderHook(() => usePropPricingActions({
    cid: 'c1',
    actorName: 'IT Underwriter',
    showToast: vi.fn(),
    save: vi.fn().mockResolvedValue(true),
    getC: () => '',
    calcResult: () => 0,
    calcMaxComm: () => 0,
    epi: 37_500_000,          // treaty currency (e.g. SAR)
    fxRate: 1 / 3.75,         // SAR → USD
    offerStatus: 'DRAFT',
    offerLine: '25',
    offerComment: '',
    offerApprover: 'u-cu',
    returnReason: '',
    signedLinePct: '',
    setSnapshots: vi.fn(),
    setSnapLabel: vi.fn(),
    setOfferStatusState: vi.fn(),
    setApprovalTrail: vi.fn(),
    setReturnReason: vi.fn(),
    ...over,
  }));
}

afterEach(() => {
  cleanup();
  apiMock.submitOfferForApproval.mockReset().mockResolvedValue({ ok: true });
  apiMock.getApprovalTrail.mockReset().mockResolvedValue([]);
});

describe('doSubmitForApproval — epi_usd is converted to USD (F79)', () => {
  it('converts the treaty-currency EPI with the local→USD fxRate', async () => {
    apiMock.submitOfferForApproval.mockResolvedValue({ ok: true });
    apiMock.getApprovalTrail.mockResolvedValue([]);
    const { result } = build();

    await act(() => result.current.doSubmitForApproval({}));

    expect(apiMock.submitOfferForApproval).toHaveBeenCalledTimes(1);
    const [, payload] = apiMock.submitOfferForApproval.mock.calls[0];
    // 37.5M SAR at 3.75 SAR/USD is USD 10M — NOT 37.5M "USD".
    expect(payload.epi_usd).toBeCloseTo(10_000_000, 0);
  });

  it('defaults fxRate to 1 (USD treaties / missing rate keep the prior behaviour)', async () => {
    apiMock.submitOfferForApproval.mockResolvedValue({ ok: true });
    apiMock.getApprovalTrail.mockResolvedValue([]);
    const { result } = build({ fxRate: undefined, epi: 5_000_000 });

    await act(() => result.current.doSubmitForApproval({}));

    const [, payload] = apiMock.submitOfferForApproval.mock.calls[0];
    expect(payload.epi_usd).toBe(5_000_000);
  });

  it('sends null when there is no usable EPI', async () => {
    apiMock.submitOfferForApproval.mockResolvedValue({ ok: true });
    apiMock.getApprovalTrail.mockResolvedValue([]);
    const { result } = build({ epi: 0 });

    await act(() => result.current.doSubmitForApproval({}));

    const [, payload] = apiMock.submitOfferForApproval.mock.calls[0];
    expect(payload.epi_usd).toBeNull();
  });
});
