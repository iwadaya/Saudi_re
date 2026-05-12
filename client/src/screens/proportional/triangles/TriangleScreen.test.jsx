import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import TriangleScreen from './TriangleScreen.jsx';

const { apiMock, appStateMock, contractIdRef } = vi.hoisted(() => ({
  apiMock: {
    getTriangle: vi.fn(),
    saveTriangle: vi.fn(),
  },
  appStateMock: {
    quoteMode: false,
    triangleMeta: { startYear: 2021, renewalYear: 2026 },
  },
  contractIdRef: { current: 'contract-1' },
}));

vi.mock('../../../api', () => ({ api: apiMock }));
vi.mock('../../../hooks/useContractId', () => ({ useContractId: () => contractIdRef.current }));
vi.mock('../../../context/AppContext', () => ({ useAppState: () => ({ state: appStateMock }) }));
vi.mock('../../../components/WizardLayout', () => ({
  default: ({ children }) => (
    <section>
      {typeof children === 'function' ? children({ showToast: () => {} }) : children}
    </section>
  ),
}));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

beforeEach(() => {
  contractIdRef.current = 'contract-1';
  appStateMock.quoteMode = false;
  appStateMock.triangleMeta = { startYear: 2021, renewalYear: 2026 };
  apiMock.getTriangle.mockResolvedValue({
    cells: [{ origin_year: 2021, dev_months: 12, cum_value: 1000 }],
  });
});

describe('TriangleScreen', () => {
  it.each([
    ['PROP_PREMIUM_TRIANGLES', 'PREMIUM'],
    ['PROP_CLAIMS_PAID_TRIANGLES', 'CLAIMS_PAID'],
    ['PROP_OS_CLAIMS_TRIANGLES', 'CLAIMS_OS'],
  ])('loads %s once without refetching after its own state updates', async (routeKey, triangleType) => {
    render(
      <TriangleScreen
        routeKey={routeKey}
        title="Triangle"
        headerPill="PROPORTIONAL TREATY: TRIANGLE"
      />,
    );

    expect(await screen.findByDisplayValue('1,000')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument());
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    expect(apiMock.getTriangle).toHaveBeenCalledTimes(1);
    expect(apiMock.getTriangle).toHaveBeenCalledWith('contract-1', triangleType, undefined);
  });

  it('loads the incurred triangle from paid and OS once each', async () => {
    apiMock.getTriangle.mockImplementation((_id, type) => Promise.resolve({
      cells: [{ origin_year: 2021, dev_months: 12, cum_value: type === 'CLAIMS_PAID' ? 700 : 300 }],
    }));

    render(
      <TriangleScreen
        routeKey="PROP_INCURRED_CLAIMS_TRIANGLES"
        title="Incurred Claims Triangle"
        headerPill="PROPORTIONAL TREATY: INCURRED CLAIMS TRIANGLE"
      />,
    );

    expect(await screen.findByText('1,000')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument());
    await act(async () => {
      await new Promise(resolve => setTimeout(resolve, 50));
    });

    expect(apiMock.getTriangle).toHaveBeenCalledTimes(2);
    expect(apiMock.getTriangle).toHaveBeenCalledWith('contract-1', 'CLAIMS_PAID', undefined);
    expect(apiMock.getTriangle).toHaveBeenCalledWith('contract-1', 'CLAIMS_OS', undefined);
  });
});
