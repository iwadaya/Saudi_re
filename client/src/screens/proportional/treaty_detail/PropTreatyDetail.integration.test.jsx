import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react';
import PropTreatyDetail from './PropTreatyDetail.jsx';
import { renderBindScreen, makeHttpError } from '../../../test/bindPathTestUtils.jsx';
import { bindIds, makeBindPathApiMock } from '../../../test/bindPathFixtures.js';

const { apiMock } = vi.hoisted(() => ({ apiMock: {} }));

vi.mock('../../../api', () => ({ api: apiMock }));

function resetApi(overrides = {}) {
  Object.keys(apiMock).forEach((key) => delete apiMock[key]);
  Object.assign(apiMock, makeBindPathApiMock(vi.fn, overrides));
}

function inputFor(labelText) {
  const label = screen.getByText(labelText);
  return label.parentElement.querySelector('input,select,textarea');
}

function controlFor(labelText) {
  const label = screen.getByText(labelText);
  return label.parentElement.querySelector('input,select,textarea,button');
}

function renderScreen() {
  return renderBindScreen(<PropTreatyDetail />, {
    route: '/prop/treaty-detail',
    contractId: bindIds.contract,
    appState: {
      wizardMode: 'PROP',
      propTreatyDetail: { contractId: bindIds.contract },
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

describe('PropTreatyDetail integration', () => {
  it('loads treaty details, recalculates cession from retention, and saves', async () => {
    renderScreen();

    expect(await screen.findByText('Retention %')).toBeInTheDocument();
    await waitFor(() => expect(inputFor('Retention %')).toHaveValue('50%'));

    fireEvent.change(inputFor('Retention %'), { target: { value: '60%' } });
    expect(inputFor('Cession %')).toHaveValue('40%');

    apiMock.saveContract.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /go to next step/i }));

    await waitFor(() => expect(apiMock.saveContract).toHaveBeenCalled());
    const [, payload] = apiMock.saveContract.mock.calls.at(-1);
    expect(payload.terms.detail.retention_pct).toBe(60);
    expect(payload.terms.detail.cession_pct).toBe(40);
  });

  it('shows the stale-write modal and overwrites only after confirmation', async () => {
    renderScreen();

    await screen.findByText('Retention %');
    apiMock.saveContract.mockRejectedValueOnce(makeHttpError({
      status: 409,
      code: 'STALE_WRITE',
      message: 'Stale write',
      body: { current: '2026-05-01T12:00:00.000Z', expected: '2026-05-01T11:00:00.000Z' },
    }));

    fireEvent.click(screen.getByRole('button', { name: /go to next step/i }));
    expect(await screen.findByRole('dialog', { name: /concurrent edit detected/i })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: /save anyway, overwriting theirs/i }));

    await waitFor(() => expect(apiMock.saveContract).toHaveBeenCalledTimes(2));
    expect(apiMock.saveContract.mock.calls[1][2]).toMatchObject({ ifUnmodifiedSince: '*' });
  });

  it('exercises COB, sliding commission, EPI split, and loss-participation modals', async () => {
    renderScreen();

    expect(await screen.findByText('Retention %')).toBeInTheDocument();

    fireEvent.click(controlFor('Line of Business'));
    expect(await screen.findByRole('dialog', { name: /select lines of business/i })).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Property'));
    fireEvent.click(screen.getByRole('button', { name: /Apply/i }));
    await waitFor(() => expect(screen.queryByRole('dialog', { name: /select lines of business/i })).not.toBeInTheDocument());

    fireEvent.click(screen.getByRole('button', { name: /SLIDING SCALE/i }));
    fireEvent.click(screen.getByRole('button', { name: /Enter slide manually/i }));
    const slidingDialog = await screen.findByRole('dialog', { name: /Sliding Scale Commission Table/i });
    const sliding = within(slidingDialog);
    fireEvent.change(sliding.getAllByPlaceholderText(/e.g. 30%/i)[0], { target: { value: '28%' } });
    fireEvent.change(sliding.getAllByPlaceholderText(/e.g. 65%/i)[0], { target: { value: '55%' } });
    fireEvent.change(sliding.getAllByPlaceholderText(/e.g. 30%/i)[1], { target: { value: '26%' } });
    fireEvent.click(screen.getByRole('button', { name: /\+ Add Row/i }));
    fireEvent.click(screen.getByRole('button', { name: /Save Table/i }));

    fireEvent.click(screen.getByRole('button', { name: /EPI Split/i }));
    expect(await screen.findByRole('dialog', { name: /EPI Split by Line of Business/i })).toBeInTheDocument();
    const splitInputs = screen.getAllByPlaceholderText(/e.g. 1,000,000/i);
    fireEvent.change(splitInputs[0], { target: { value: '600000' } });
    if (splitInputs[1]) fireEvent.change(splitInputs[1], { target: { value: '288888' } });
    vi.spyOn(window, 'confirm').mockReturnValue(true);
    fireEvent.click(screen.getByRole('button', { name: /Save Split/i }));

    fireEvent.click(screen.getByRole('button', { name: /Enter Slides Manually/i }));
    expect(await screen.findByRole('dialog', { name: /Stepped Loss Participation/i })).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText(/Corridor 1 minimum loss ratio/i), { target: { value: '65%' } });
    fireEvent.change(screen.getByLabelText(/Corridor 1 maximum loss ratio/i), { target: { value: '90%' } });
    fireEvent.change(screen.getByLabelText(/Corridor 1 reinsurer share/i), { target: { value: '50%' } });
    fireEvent.click(screen.getByRole('button', { name: /Done/i }));

    apiMock.saveContract.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /go to next step/i }));
    await waitFor(() => expect(apiMock.saveContract).toHaveBeenCalled());
    const [, payload] = apiMock.saveContract.mock.calls.at(-1);
    expect(payload.terms.commissions.sliding_table).toEqual(
      expect.arrayContaining([expect.objectContaining({ lossRatioPct: '55', commissionPct: '26' })]),
    );
    expect(payload.terms.lossParticipation.slides).toEqual(
      expect.arrayContaining([expect.objectContaining({ min_lr: 65, max_lr: 90, share: 50 })]),
    );
  });
});
