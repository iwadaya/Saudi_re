// NpFinalPricing.arrayGuard.test.jsx
//
// Regression guard for the asArr() coercion in hooks/useNpPricingState.ts: a
// non-array pricing slice (stale or partial wire payload) must never reach an
// unconditional `.map`/`.length` in the render tree and white-screen the
// screen behind ScreenErrorBoundary.
//
// We poison every load that hydrates an array-typed slice with a degenerate,
// non-array shape (null / undefined / {} / { layers: null }) and assert the
// screen still renders — including the offer modal, whose approval-trail block
// reads `approvalTrail.length`. approvalTrail is set through the one UNGUARDED
// setter in the loads (setApprovalTrail(trail)), so without asArr the poisoned
// null reaches `.length` and the boundary fallback takes over. With asArr the
// slice is coerced to [] and the modal renders cleanly.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import NpFinalPricing from './NpFinalPricing.jsx';
import ScreenErrorBoundary from '../../../components/ScreenErrorBoundary.jsx';
import { renderBindScreen } from '../../../test/bindPathTestUtils.jsx';
import { bindIds, makeBindPathApiMock, npTreatySnapshot } from '../../../test/bindPathFixtures.js';

const { apiMock } = vi.hoisted(() => ({ apiMock: {} }));

vi.mock('../../../api', () => ({ api: apiMock }));

// Replace every load that feeds an array-typed slice with a different
// degenerate shape so no single guard masks the others:
//   getNpExpiring     → null          (expLayers)
//   getNonPropTreaty  → undefined     (main treaty load + quote scaffold)
//   getContractCobs   → {}            (selectedCobs)
//   getNpPricing      → { layers: null } (layers / pricing main load)
//   getApprovalTrail  → null          (approvalTrail — UNGUARDED setter)
function poisonApi() {
  Object.keys(apiMock).forEach((key) => delete apiMock[key]);
  Object.assign(apiMock, makeBindPathApiMock(vi.fn, {
    getNpExpiring:        vi.fn().mockResolvedValue(null),
    getNonPropTreaty:     vi.fn().mockResolvedValue(undefined),
    getContractCobs:      vi.fn().mockResolvedValue({}),
    getNpPricing:         vi.fn().mockResolvedValue({ layers: null }),
    listReinsurers:       vi.fn().mockResolvedValue(null),
    listClassOfBusiness:  vi.fn().mockResolvedValue(undefined),
    getApprovalTrail:     vi.fn().mockResolvedValue(null),
    getEligibleApprovers: vi.fn().mockResolvedValue({}),
    listContracts:        vi.fn().mockResolvedValue(null),
  }));
}

const boundaryFallback = () => screen.queryByText(/This screen failed to render/i);

function renderScreen({ quoteMode = false } = {}) {
  return renderBindScreen(
    <ScreenErrorBoundary><NpFinalPricing /></ScreenErrorBoundary>,
    {
      route: quoteMode ? '/np/final-quote' : '/np/final-pricing',
      contractId: quoteMode ? bindIds.quote : bindIds.contract,
      quoteMode,
      appState: {
        wizardMode: 'NP',
        npTreatyDetail: {
          contractId: quoteMode ? bindIds.quote : bindIds.contract,
          cedant: 'Audit Cedant',
          cedantName: 'Audit Cedant',
          countryName: 'Saudi Arabia',
          currencyCode: 'SAR',
          classIds: [bindIds.cobMotor, bindIds.cobProperty],
          classOfBusinessIds: [bindIds.cobMotor, bindIds.cobProperty],
          lineOfBusinessLabels: ['Motor', 'Property'],
          xlType: 'RISK',
          numberOfLayers: 2,
          deductible: 100000,
          brokeragePct: 7,
        },
        npStructureLayers: npTreatySnapshot.terms.np_structure.layers,
      },
    },
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  poisonApi();
});

describe('NpFinalPricing array-slice guard', () => {
  it('treaty mode renders and opens the offer modal despite non-array slices', async () => {
    renderScreen();

    expect(await screen.findByText(/Risk XL Layers/i)).toBeInTheDocument();
    expect(boundaryFallback()).toBeNull();

    // The offer modal reads approvalTrail.length; approvalTrail is fed by the
    // unguarded getApprovalTrail load (poisoned to null here). Without asArr
    // this throws and ScreenErrorBoundary shows its fallback.
    fireEvent.click(screen.getByRole('button', { name: /Offer Treaty/i }));
    await waitFor(() => {
      expect(boundaryFallback()).toBeNull();
      expect(document.querySelector('.off-modal')).toBeInTheDocument();
    });
  });

  it('quote mode renders and opens the offer modal despite non-array slices', async () => {
    renderScreen({ quoteMode: true });

    expect(await screen.findByText(/Quote Pricing/i)).toBeInTheDocument();
    expect(boundaryFallback()).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: /Submit Quotes/i }));
    await waitFor(() => {
      expect(boundaryFallback()).toBeNull();
      expect(document.querySelector('.off-modal')).toBeInTheDocument();
    });
  });
});
