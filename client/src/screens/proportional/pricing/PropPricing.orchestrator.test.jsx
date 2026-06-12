// PropPricing.orchestrator.test.jsx — Phase 4.2 (docs/frontend-hardening.md).
//
// Covers the orchestrator's inline interaction handlers that the golden
// master and integration suites don't touch: the Lead & Expiring inputs
// (select/select/PctInput → dirty), and the Quick Summary / In-Depth /
// COB Agg Breakdown overlay open-close round trips. Complements (never
// replaces) PropPricing.goldenMaster.test.jsx, which pins the money path.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import PropPricing from './PropPricing.jsx';
import { renderBindScreen } from '../../../test/bindPathTestUtils.jsx';
import { bindIds, makeBindPathApiMock } from '../../../test/bindPathFixtures.js';

const { apiMock } = vi.hoisted(() => ({ apiMock: {} }));

vi.mock('../../../api', () => ({ api: apiMock }));

function resetApi(overrides = {}) {
  Object.keys(apiMock).forEach((key) => delete apiMock[key]);
  Object.assign(apiMock, makeBindPathApiMock(vi.fn, overrides));
}

function renderScreen({ quoteMode = false } = {}) {
  return renderBindScreen(<PropPricing />, {
    route: '/prop/pricing',
    contractId: bindIds.contract,
    quoteMode,
    appState: {
      wizardMode: 'PROP',
      propTreatyDetail: {
        contractId: bindIds.contract,
        cedantName: 'Audit Cedant',
        countryName: 'Saudi Arabia',
        currencyCode: 'SAR',
        treatyTypeName: 'Quota Share',
        quotaShareEpi: '6000000',
        fixedCommissionQSPct: '24%',
        brokeragePct: '7.5%',
        taxesPct: '2%',
      },
    },
  });
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  resetApi();
});

describe('PropPricing orchestrator interactions', () => {
  it('edits the Lead & Expiring panel and marks the screen dirty', async () => {
    const { container } = renderScreen();
    await screen.findByText(/Component Pricing Comparison/i);

    const saveBtn = container.querySelector('.bbg-btn--save');
    expect(saveBtn).not.toHaveClass('bbg-btn--dirty');

    const [leadSelect, expiringSelect] = container.querySelectorAll('select.bbg-select');
    fireEvent.change(leadSelect, { target: { value: 'Lead Re' } });
    fireEvent.change(expiringSelect, { target: { value: 'Expiring Re' } });
    fireEvent.change(screen.getByPlaceholderText('e.g. 50%'), { target: { value: '50' } });

    expect(leadSelect).toHaveValue('Lead Re');
    expect(expiringSelect).toHaveValue('Expiring Re');
    expect(saveBtn).toHaveClass('bbg-btn--dirty');

    // The edited leads ride the next save payload.
    fireEvent.click(saveBtn);
    await waitFor(() => expect(apiMock.savePricingComposite).toHaveBeenCalled());
    const [payload] = apiMock.savePricingComposite.mock.calls.at(-1);
    expect(payload.leads).toMatchObject({
      lead_reinsurer: 'Lead Re',
      expiring_reinsurer: 'Expiring Re',
      lead_share_pct: '50',
    });
  });

  it('opens and closes the Quick Summary, In-Depth and COB Agg Breakdown overlays', async () => {
    const { container } = renderScreen();
    await screen.findByText(/Component Pricing Comparison/i);

    // Quick Summary full-screen overlay (the wizard nav also has a
    // "Quick Summary" tab — target the toolbar button by its emoji label).
    fireEvent.click(screen.getByRole('button', { name: /📊 Quick Summary/i }));
    await waitFor(() => expect(container.querySelector('.bbg-modal-full')).toBeInTheDocument());
    fireEvent.click(container.querySelector('.bbg-modal-close'));
    await waitFor(() => expect(container.querySelector('.bbg-modal-full')).not.toBeInTheDocument());

    // In-Depth portfolio analysis (ui Modal — labelled close button).
    fireEvent.click(screen.getByRole('button', { name: /In-Depth Analysis/i }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /Close dialog/i }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

    // COB Agg Breakdown overlay.
    fireEvent.click(screen.getByRole('button', { name: /COB Agg Breakdown/i }));
    expect(await screen.findByRole('button', { name: /^Close$/ })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /^Close$/ }));
    await waitFor(() => expect(screen.queryByRole('button', { name: /^Close$/ })).not.toBeInTheDocument());
  });
});
