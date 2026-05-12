import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import AggDrilldownModal from './AggDrilldownModal.jsx';
import { renderBindScreen } from '../../../../test/bindPathTestUtils.jsx';
import { bindIds, makeBindPathApiMock } from '../../../../test/bindPathFixtures.js';

const { apiMock } = vi.hoisted(() => ({ apiMock: {} }));

vi.mock('../../../../api', () => ({ api: apiMock }));

function resetApi(overrides = {}) {
  Object.keys(apiMock).forEach((key) => delete apiMock[key]);
  Object.assign(apiMock, makeBindPathApiMock(vi.fn, overrides));
}

function renderModal() {
  return renderBindScreen(
    <AggDrilldownModal contractId={bindIds.contract} shareRows={[]} onClose={() => {}} />,
    { route: '/prop/pricing', contractId: bindIds.contract },
  );
}

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

beforeEach(() => {
  resetApi();
});

describe('AggDrilldownModal integration', () => {
  it('opens with aggregate data and recalculates share impact when the filter input changes', async () => {
    renderModal();

    expect(await screen.findByText(/Aggregate Analysis/i)).toBeInTheDocument();
    expect(screen.getAllByText(/Saudi Arabia/i).length).toBeGreaterThan(0);
    expect(screen.getByText('5.7M')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /portfolio/i }));
    fireEvent.change(screen.getByPlaceholderText(/e.g. 5%/i), { target: { value: '5%' } });

    expect((await screen.findAllByText('150K')).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/-43\.8%/).length).toBeGreaterThan(0);
  });

  it('switches through zone and class drilldowns with sample aggregates', async () => {
    renderModal();

    expect(await screen.findByText(/Aggregate Analysis/i)).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /by zone/i }));
    expect(await screen.findByText(/click column headers to sort/i)).toBeInTheDocument();
    expect(screen.getByText('Riyadh')).toBeInTheDocument();
    fireEvent.click(screen.getByText(/^Zone$/i));
    expect(screen.getByText('Jeddah')).toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: /by class/i }));
    expect(await screen.findByText(/Aggregates split by Class of Business/i)).toBeInTheDocument();
    expect(screen.getByText('Motor')).toBeInTheDocument();
    expect(screen.getByText('Property')).toBeInTheDocument();
  });

  it('renders a network error from the aggregate endpoint', async () => {
    apiMock.getAggDrilldown.mockRejectedValueOnce(new Error('aggregate service unavailable'));
    renderModal();

    expect(await screen.findByText(/error: aggregate service unavailable/i)).toBeInTheDocument();
  });
});
