import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import NpStructure from './NpStructure.jsx';
import { renderBindScreen } from '../../../test/bindPathTestUtils.jsx';
import { bindIds, makeBindPathApiMock, npTreatySnapshot } from '../../../test/bindPathFixtures.js';

const { apiMock } = vi.hoisted(() => ({ apiMock: {} }));

vi.mock('../../../api', () => ({ api: apiMock }));

function resetApi(overrides = {}) {
  Object.keys(apiMock).forEach((key) => delete apiMock[key]);
  Object.assign(apiMock, makeBindPathApiMock(vi.fn, overrides));
}

function renderScreen() {
  return renderBindScreen(<NpStructure />, {
    route: '/np/structure',
    contractId: bindIds.contract,
    appState: {
      wizardMode: 'NP',
      npTreatyDetail: {
        contractId: bindIds.contract,
        currencyCode: 'SAR',
        xlType: 'RISK',
        numberOfLayers: 2,
        expiringNumberOfLayers: 1,
        deductible: 100000,
      },
      npStructureLayers: npTreatySnapshot.terms.np_structure.layers,
    },
  });
}

function renderQuoteScreen() {
  return renderBindScreen(<NpStructure />, {
    route: '/np/structure-quote',
    contractId: bindIds.quote,
    quoteMode: false,
    forceActiveQuoteId: bindIds.quote,
    appState: {
      wizardMode: 'NP',
      npTreatyDetail: {
        contractId: bindIds.quote,
        currencyCode: 'SAR',
        xlType: 'BOTH',
        classIds: [bindIds.cobMotor, bindIds.cobProperty],
        quoteStructuresCount: '1',
        numberOfLayers: 2,
        expiringNumberOfLayers: 1,
        deductible: 100000,
      },
      npStructureLayers: [],
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

describe('NpStructure integration', () => {
  it('adds and deletes layers, recalculates attachment, and saves the structure', async () => {
    const { container } = renderScreen();

    expect(await screen.findByText(/Treaty Structure/i)).toBeInTheDocument();
    await waitFor(() => expect(container.querySelectorAll('tr[data-layer-row]')).toHaveLength(2));

    const firstRow = container.querySelector('tr[data-layer-row="0"]');
    const firstLimit = firstRow.querySelector('input');
    fireEvent.change(firstLimit, { target: { value: '600000' } });

    await waitFor(() => {
      const secondRow = container.querySelector('tr[data-layer-row="1"]');
      expect(secondRow.querySelectorAll('input')[1]).toHaveValue('700,000');
    });

    fireEvent.click(screen.getByRole('button', { name: /\+ add layer/i }));
    await waitFor(() => expect(container.querySelectorAll('tr[data-layer-row]')).toHaveLength(3));

    fireEvent.click(screen.getByRole('button', { name: /delete layer/i }));
    await waitFor(() => expect(container.querySelectorAll('tr[data-layer-row]')).toHaveLength(2));

    fireEvent.click(screen.getByRole('button', { name: /go to next step/i }));
    await waitFor(() => expect(apiMock.saveNonPropTreaty).toHaveBeenCalled());
    const [, payload] = apiMock.saveNonPropTreaty.mock.calls.at(-1);
    expect(payload.layers).toHaveLength(2);
    expect(payload.layers[0]).toMatchObject({ layer_number: 1, layer_limit: 600000 });
  });

  it('shows a save error when the structure API fails', async () => {
    apiMock.saveNonPropTreaty.mockRejectedValueOnce(new Error('network down'));
    renderScreen();

    await screen.findByText(/Treaty Structure/i);
    fireEvent.click(screen.getByRole('button', { name: /go to next step/i }));

    expect(await screen.findByText(/structure save failed: network down/i)).toBeInTheDocument();
  });

  it('covers quote-mode structure rows, COB participation, and quote save payloads', async () => {
    const { container } = renderQuoteScreen();

    expect((await screen.findAllByText(/Structures to Quote/i)).length).toBeGreaterThan(0);
    const structuresSelect = container.querySelector('section select.fi');
    fireEvent.change(structuresSelect, { target: { value: '2' } });
    expect(await screen.findByText(/Structure 2/i)).toBeInTheDocument();

    const firstStructure = container.querySelector('section.qss-section');
    fireEvent.change(firstStructure.querySelector('select.np-mini-input'), { target: { value: '2' } });
    await waitFor(() => expect(firstStructure.querySelectorAll('tr[data-qs-row]')).toHaveLength(2));

    const firstRow = firstStructure.querySelector('tr[data-qs-row="0"]');
    const textInputs = firstRow.querySelectorAll('input[type="text"]');
    fireEvent.change(textInputs[0], { target: { value: '300000' } });
    fireEvent.change(textInputs[1], { target: { value: '100000' } });
    fireEvent.change(textInputs[2], { target: { value: '500000' } });
    fireEvent.change(textInputs[3], { target: { value: '900000' } });
    fireEvent.change(firstRow.querySelector('select'), { target: { value: 'UNLIMITED' } });
    fireEvent.click(firstRow.querySelector('input[type="checkbox"]'));

    await waitFor(() => {
      const secondRow = firstStructure.querySelector('tr[data-qs-row="1"]');
      expect(secondRow.querySelectorAll('input[type="text"]')[1]).toHaveValue('400,000');
    });

    await screen.findByText('Motor');
    const motorCobRow = Array.from(firstStructure.querySelectorAll('.bm-np-row'))
      .find(row => row.textContent.includes('Motor') && !row.hasAttribute('data-qs-row'));
    fireEvent.change(motorCobRow.querySelector('input[type="text"]'), { target: { value: '750000' } });
    fireEvent.click(motorCobRow.querySelector('input[type="checkbox"]'));

    fireEvent.click(screen.getByRole('button', { name: /go to next step/i }));
    await waitFor(() => expect(apiMock.saveNonPropTreaty).toHaveBeenCalled());
    const [, payload, opts] = apiMock.saveNonPropTreaty.mock.calls.at(-1);
    expect(opts).toMatchObject({ quote: true });
    expect(payload.layers[0]).toMatchObject({ layer_number: 1, layer_limit: 300000, attachment: 100000 });
    expect(payload.terms.np_structure.structures).toHaveLength(2);
    expect(payload.cob_underwriting_limits[0]).toMatchObject({ cob_id: bindIds.cobMotor, limit_amount: 750000 });
  });
});
