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
    // Required-field gate now needs the sliding scalars filled (Min/Max
    // LR, Min/Max Commission) plus a sliding table with ≥2 complete
    // rows. Fill both on the main page; the modal supplies the rows.
    // "Min Loss Ratio %" / "Max Loss Ratio %" labels appear once in the
    // sliding card and again in the LP card — JSX order puts sliding
    // first so getAllByText[0] is the sliding row's input.
    const slidingInput = (labelText) => {
      const labels = screen.getAllByText(labelText);
      return labels[0].parentElement.querySelector('input,select,textarea');
    };
    fireEvent.change(slidingInput('Min Loss Ratio %'), { target: { value: '40%' } });
    fireEvent.change(slidingInput('Max Loss Ratio %'), { target: { value: '80%' } });
    fireEvent.change(inputFor('Min Commission %'), { target: { value: '20%' } });
    fireEvent.change(inputFor('Max Commission %'), { target: { value: '35%' } });
    fireEvent.click(screen.getByRole('button', { name: /Enter slide manually/i }));
    const slidingDialog = await screen.findByRole('dialog', { name: /Sliding Scale Commission Table/i });
    const sliding = within(slidingDialog);
    fireEvent.change(sliding.getAllByPlaceholderText(/e.g. 30%/i)[0], { target: { value: '28%' } });
    fireEvent.change(sliding.getAllByPlaceholderText(/e.g. 65%/i)[0], { target: { value: '55%' } });
    fireEvent.change(sliding.getAllByPlaceholderText(/e.g. 30%/i)[1], { target: { value: '26%' } });
    // 2nd row so the new ≥2-rows table check passes.
    fireEvent.change(sliding.getAllByPlaceholderText(/e.g. 65%/i)[1], { target: { value: '70%' } });
    fireEvent.change(sliding.getAllByPlaceholderText(/e.g. 30%/i)[2], { target: { value: '20%' } });
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

  it('required-field gate: empty slice + Next click → SaveStateIndicator surfaces the missing-field list, saveContract not called', async () => {
    // Override getContract to return null so the form starts empty —
    // mirrors the "new treaty" flow.
    resetApi({ getContract: vi.fn().mockResolvedValue(null) });
    renderBindScreen(<PropTreatyDetail />, {
      route: '/prop/treaty-detail',
      contractId: null,
      appState: { wizardMode: 'PROP', propTreatyDetail: {} },
    });

    await screen.findByText('Country');

    // Type into Country to set hasContent=true so save() runs the
    // required-field gate (the no-content shortcut returns early).
    fireEvent.change(inputFor('Country'), { target: { value: bindIds.country } });

    apiMock.saveContract.mockClear();
    apiMock.createContract.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /go to next step/i }));

    // Banner reports the comma-separated list of missing labels.
    const banner = await screen.findByRole('alert');
    expect(banner.textContent).toMatch(/Required fields missing/);
    expect(banner.textContent).toMatch(/Cedant Name/);
    expect(banner.textContent).toMatch(/Treaty Type/);
    expect(banner.textContent).toMatch(/Treaty Inception Date/);

    // No API calls should have happened — gate blocks before save.
    expect(apiMock.saveContract).not.toHaveBeenCalled();
    expect(apiMock.createContract).not.toHaveBeenCalled();
  });

  it('unmount autosave: new treaty with only a cedant does NOT throw and does NOT call the save API', async () => {
    resetApi({ getContract: vi.fn().mockResolvedValue(null) });
    const { unmount } = renderBindScreen(<PropTreatyDetail />, {
      route: '/prop/treaty-detail',
      contractId: null,
      appState: { wizardMode: 'PROP', propTreatyDetail: { cedantId: bindIds.contract } },
    });

    await screen.findByText('Country');

    apiMock.saveContract.mockClear();
    apiMock.createContract.mockClear();

    // Tearing down with an incomplete header (only a cedant) must be silent:
    // canPersistTreatyHeader is false, so the unmount effect returns without
    // attempting a create that the NOT NULL columns would reject.
    expect(() => unmount()).not.toThrow();

    expect(apiMock.createContract).not.toHaveBeenCalled();
    expect(apiMock.saveContract).not.toHaveBeenCalled();
  });

  it('manual renewal override on a saved treaty: hydration sets _renewalManual when renewal ≠ inception+12mo', async () => {
    // Server returns inception 2026-01-01 + renewal 2027-02-15 (NOT
    // exactly +12 months). Loaded slice should mark renewal as manual.
    const override = {
      ...JSON.parse(JSON.stringify({
        contract_id: bindIds.contract,
        header: {
          cedant_id: 'cedant-audit', broker_id: 'broker-audit',
          country_id: bindIds.country, treaty_type_id: 'treaty-qs',
          currency_id: 'SAR', uw_year: 2026,
          inception_date: '2026-01-01', renewal_date: '2027-02-15',
          primary_class_of_business_id: bindIds.cobMotor,
        },
        class_ids: [bindIds.cobMotor],
        detail: {
          inception_date: '2026-01-01', renewal_date: '2027-02-15',
          experience_start_year: 2021, qs_limit: 10000000,
          retention_pct: 50, cession_pct: 50, quota_share_epi: 6000000,
        },
        commissions: { mode: 'FIXED', fixed_commission_qs_pct: 0.24 },
        lossParticipation: { enabled: true, min_loss_ratio_pct: 70, max_loss_ratio_pct: 100, reinsurer_share_pct: 50 },
        updated_at: '2026-05-01T10:00:00.000Z',
      })),
    };
    resetApi({ getContract: vi.fn().mockResolvedValue(override) });
    renderScreen();

    // Wait for hydration to apply the manual-renewal detection.
    await screen.findByText('Country');
    await waitFor(() => expect(inputFor('Treaty Renewal Date')).toHaveValue('2027-02-15'));

    // Edit inception by +1 day. If _renewalManual=true was set by the
    // load-time detection, the auto-recalc effect must NOT clobber the
    // saved renewal.
    fireEvent.change(inputFor('Treaty Inception Date'), { target: { value: '2026-01-02' } });
    await new Promise(r => setTimeout(r, 50)); // let effects flush
    expect(inputFor('Treaty Renewal Date')).toHaveValue('2027-02-15');
  });

  it('EPI Split defaults to equal split across COBs when the modal was never opened', async () => {
    // Treaty with TWO COBs and total EPI = 1,000,000 (QS only).
    const twoCob = {
      ...JSON.parse(JSON.stringify({
        contract_id: bindIds.contract,
        header: {
          cedant_id: 'cedant-audit', broker_id: 'broker-audit',
          country_id: bindIds.country, treaty_type_id: 'treaty-qs',
          currency_id: 'SAR', uw_year: 2026,
          inception_date: '2026-01-01', renewal_date: '2026-12-31',
          primary_class_of_business_id: bindIds.cobMotor,
        },
        class_ids: [bindIds.cobMotor, bindIds.cobProperty],
        detail: {
          inception_date: '2026-01-01', renewal_date: '2026-12-31',
          experience_start_year: 2021, qs_limit: 1000000,
          retention_pct: 50, cession_pct: 50, quota_share_epi: 1000000,
          surplus_epi: 0,
        },
        commissions: { mode: 'FIXED', fixed_commission_qs_pct: 0.24 },
        lossParticipation: { enabled: true, min_loss_ratio_pct: 70, max_loss_ratio_pct: 100, reinsurer_share_pct: 50 },
        epi_split: [],
        updated_at: '2026-05-01T10:00:00.000Z',
      })),
    };
    resetApi({ getContract: vi.fn().mockResolvedValue(twoCob) });
    renderScreen();

    // Wait for hydration so the slice has classIds + quotaShareEpi
    // before we click save (otherwise the default-split branch sees
    // an empty slice and skips).
    await screen.findByText('Country');
    await waitFor(() => expect(inputFor('Retention %')).toHaveValue('50%'));

    apiMock.saveContract.mockClear();
    fireEvent.click(screen.getByRole('button', { name: /go to next step/i }));

    await waitFor(() => expect(apiMock.saveContract).toHaveBeenCalled());
    const [, payload] = apiMock.saveContract.mock.calls.at(-1);
    expect(payload.terms.epi_split).toHaveLength(2);
    expect(payload.terms.epi_split.every(r => r.premium === 500_000)).toBe(true);
  });
});
