import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import NpTreatyDetail from './NpTreatyDetail.jsx';
import { renderBindScreen } from '../../../test/bindPathTestUtils.jsx';
import { bindIds, makeBindPathApiMock, refData } from '../../../test/bindPathFixtures.js';

const { apiMock } = vi.hoisted(() => ({ apiMock: {} }));

vi.mock('../../../api', () => ({ api: apiMock }));

function resetApi(overrides = {}) {
  Object.keys(apiMock).forEach((key) => delete apiMock[key]);
  Object.assign(apiMock, makeBindPathApiMock(vi.fn, {
    listTreatyTypes: vi.fn().mockResolvedValue([
      { id: 'np-risk-cat', name: 'Risk & Cat XL', category: 'NON_PROPORTIONAL' },
    ]),
    getContract: vi.fn().mockResolvedValue({
      contract_id: bindIds.quote,
      quote_id: bindIds.quote,
      updated_at: '2026-05-01T10:00:00.000Z',
      quote_ref: 'QT-2026-0001',
      quote_version: 1,
      class_ids: [bindIds.cobMotor, bindIds.cobProperty],
      header: {
        cedant_id: 'cedant-audit',
        cedant_name: 'Audit Cedant',
        broker_id: 'broker-audit',
        broker_name: 'Audit Broker',
        country_id: bindIds.country,
        country_name: 'Saudi Arabia',
        currency_id: 'SAR',
        currency_code: 'SAR',
        treaty_type_id: 'np-risk-cat',
        treaty_type_name: 'Risk & Cat XL',
        uw_year: 2026,
        status: 'DRAFT',
        renewal_date: '2026-12-31',
      },
    }),
    getNonPropTreaty: vi.fn().mockResolvedValue({
      detail: { brokerage_pct: 7, taxes_pct: 2, structures_to_quote: 2 },
      layers: [],
      terms: {},
    }),
    ...overrides,
  }));
}

function renderQuoteTreatyDetail() {
  return renderBindScreen(<NpTreatyDetail />, {
    route: '/np/treaty-detail',
    contractId: bindIds.quote,
    quoteMode: true,
    appState: {
      wizardMode: 'NP',
      npTreatyDetail: { contractId: bindIds.quote },
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

describe('NpTreatyDetail quote mode', () => {
  it('shows Classes of Business on quotes and saves them to quote COB junctions', async () => {
    renderQuoteTreatyDetail();

    expect(await screen.findByText(/Classes of Business/i)).toBeInTheDocument();
    expect(await screen.findByRole('button', { name: /Motor, Property/i })).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /go to next step/i }));

    await waitFor(() => expect(apiMock.saveContract).toHaveBeenCalled());
    expect(apiMock.saveContract.mock.calls.at(-1)[1].terms.class_ids).toEqual([bindIds.cobMotor, bindIds.cobProperty]);
    expect(apiMock.saveContract.mock.calls.at(-1)[2]).toMatchObject({ quote: true });

    await waitFor(() => expect(apiMock.saveContractCobs).toHaveBeenCalled());
    expect(apiMock.saveContractCobs.mock.calls.at(-1)).toEqual([
      bindIds.quote,
      { class_ids: [bindIds.cobMotor, bindIds.cobProperty] },
      { quote: true },
    ]);
  });

  it('lets quote users edit Classes of Business from the treaty-detail modal', async () => {
    renderQuoteTreatyDetail();

    const cobButton = await screen.findByRole('button', { name: /Motor, Property/i });
    fireEvent.click(cobButton);
    const propertyBox = await screen.findByLabelText(refData.cobs[1].name);
    fireEvent.click(propertyBox);
    fireEvent.click(screen.getByRole('button', { name: /Apply/i }));

    await waitFor(() => expect(screen.getByRole('button', { name: /^Motor/i })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /Motor, Property/i })).not.toBeInTheDocument();
  });
});
