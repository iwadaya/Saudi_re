import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import TriangleScreen from './TriangleScreen.jsx';

const { apiMock, appStateMock, contractIdRef, toastMock } = vi.hoisted(() => ({
  apiMock: {
    getTriangle: vi.fn(),
    saveTriangle: vi.fn(),
  },
  appStateMock: {
    quoteMode: false,
    triangleMeta: { startYear: 2021, renewalYear: 2026 },
  },
  contractIdRef: { current: 'contract-1' },
  toastMock: vi.fn(),
}));

vi.mock('../../../api', () => ({ api: apiMock }));
vi.mock('../../../hooks/useContractId', () => ({ useContractId: () => contractIdRef.current }));
vi.mock('../../../context/AppContext', () => ({ useAppState: () => ({ state: appStateMock }) }));
vi.mock('../../../components/WizardLayout', () => ({
  default: ({ children }) => (
    <section>
      {typeof children === 'function' ? children({ showToast: toastMock }) : children}
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

async function renderAndWait() {
  const utils = render(
    <TriangleScreen
      routeKey="PROP_PREMIUM_TRIANGLES"
      title="Premium Triangle"
      headerPill="PROPORTIONAL TREATY: PREMIUM TRIANGLE"
    />,
  );
  await screen.findByDisplayValue('1,000');
  await waitFor(() => expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument());
  return utils;
}

function pasteInto(row, col, text) {
  const input = document.querySelector(`input[data-row="${row}"][data-col="${col}"]`);
  if (!input) throw new Error(`No input at (${row},${col})`);
  fireEvent.paste(input, { clipboardData: { getData: () => text } });
  return input;
}

function inputAt(row, col) {
  return document.querySelector(`input[data-row="${row}"][data-col="${col}"]`);
}

describe('TriangleScreen', () => {
  it.each([
    ['PROP_PREMIUM_TRIANGLES', 'PREMIUM'],
    ['PROP_CLAIMS_PAID_TRIANGLES', 'CLAIMS_PAID'],
    ['PROP_OS_CLAIMS_TRIANGLES', 'CLAIMS_OS'],
  ])('loads %s once per variant without refetching after its own state updates', async (routeKey, triangleType) => {
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

    // Both variants (MODIFIED + ACTUAL) are fetched up front so the hidden tab
    // is populated; no further refetches on state updates.
    expect(apiMock.getTriangle).toHaveBeenCalledTimes(2);
    expect(apiMock.getTriangle).toHaveBeenCalledWith('contract-1', triangleType, { variant: 'MODIFIED' });
    expect(apiMock.getTriangle).toHaveBeenCalledWith('contract-1', triangleType, { variant: 'ACTUAL' });
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

    // Derived from the active variant (MODIFIED by default), paid + OS once each.
    expect(apiMock.getTriangle).toHaveBeenCalledTimes(2);
    expect(apiMock.getTriangle).toHaveBeenCalledWith('contract-1', 'CLAIMS_PAID', { variant: 'MODIFIED' });
    expect(apiMock.getTriangle).toHaveBeenCalledWith('contract-1', 'CLAIMS_OS', { variant: 'MODIFIED' });
  });

  it('re-derives the incurred triangle from the selected variant on tab switch', async () => {
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

    // Initial load derives from the MODIFIED variant's paid + OS.
    expect(await screen.findByText('1,000')).toBeInTheDocument();
    await waitFor(() => expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument());
    expect(apiMock.getTriangle).toHaveBeenCalledWith('contract-1', 'CLAIMS_PAID', { variant: 'MODIFIED' });
    expect(apiMock.getTriangle).toHaveBeenCalledWith('contract-1', 'CLAIMS_OS', { variant: 'MODIFIED' });

    // Switching to the ACTUAL tab re-derives from the ACTUAL paid + OS — this
    // is what proves per-variant re-derivation, not just the default load.
    apiMock.getTriangle.mockClear();
    fireEvent.click(screen.getByRole('tab', { name: 'Actual' }));

    await waitFor(() => {
      expect(apiMock.getTriangle).toHaveBeenCalledWith('contract-1', 'CLAIMS_PAID', { variant: 'ACTUAL' });
      expect(apiMock.getTriangle).toHaveBeenCalledWith('contract-1', 'CLAIMS_OS', { variant: 'ACTUAL' });
    });
  });

  describe('paste safety', () => {
    it('pastes a 2×2 numeric block fully inside the triangle without a toast', async () => {
      await renderAndWait();
      pasteInto(0, 0, '10\t20\n30\t40');

      await waitFor(() => expect(inputAt(0, 0).value).toBe('10'));
      expect(inputAt(0, 1).value).toBe('20');
      expect(inputAt(1, 0).value).toBe('30');
      expect(inputAt(1, 1).value).toBe('40');
      expect(toastMock).not.toHaveBeenCalled();
    });

    it('toasts and clips cells that extend past the grid edge', async () => {
      // 4×4 grid: 2022..2025 origin years, dev years 1..4.
      appStateMock.triangleMeta = { startYear: 2022, renewalYear: 2026 };
      apiMock.getTriangle.mockResolvedValue({ cells: [] });

      render(
        <TriangleScreen
          routeKey="PROP_PREMIUM_TRIANGLES"
          title="Premium Triangle"
          headerPill="PROPORTIONAL TREATY: PREMIUM TRIANGLE"
        />,
      );
      await waitFor(() => expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument());

      // 5×5 block pasted at top-left of a 4×4 triangle.
      const block = Array.from({ length: 5 }, (_, r) =>
        Array.from({ length: 5 }, (_, c) => String((r + 1) * 10 + c + 1)).join('\t'),
      ).join('\n');
      pasteInto(0, 0, block);

      // Toast surfaces clipping. Both gates trip here (the 5th row/col is
      // past the grid edge AND parts of the in-grid paste land below the
      // triangle diagonal), so the message mentions both.
      await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
      const msg = toastMock.mock.calls[0][0];
      expect(msg).toMatch(/past the grid edge/);

      // In-bounds, in-triangle cells filled correctly (row 0 max-col = 3).
      expect(inputAt(0, 0).value).toBe('11');
      expect(inputAt(0, 1).value).toBe('12');
      expect(inputAt(0, 2).value).toBe('13');
      expect(inputAt(0, 3).value).toBe('14');
      // Past grid edge (col 4) — no input even exists at (0,4).
      expect(inputAt(0, 4)).toBeNull();
    });

    it('toasts and skips cells that land below the triangle diagonal', async () => {
      // Default 5-year triangle. Paste 2×2 at (3,0): row 3 max-col = 1,
      // row 4 max-col = 0. So (3,0), (3,1), (4,0) are in-triangle and
      // (4,1) is off-triangle.
      await renderAndWait();
      pasteInto(3, 0, '100\t200\n300\t400');

      await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
      const msg = toastMock.mock.calls[0][0];
      expect(msg).toMatch(/below the triangle diagonal/);

      expect(inputAt(3, 0).value).toBe('100');
      expect(inputAt(3, 1).value).toBe('200');
      expect(inputAt(4, 0).value).toBe('300');
      // (4,1) is off-triangle — no input rendered, just a tri-off td.
      expect(inputAt(4, 1)).toBeNull();
    });

    it('leaves existing cells alone when paste tokens are non-numeric (header row)', async () => {
      // Cell (0,0) is pre-loaded with 1,000 from the mocked triangle.
      await renderAndWait();
      pasteInto(0, 0, 'Year\t1\t2\nValue\t100\t200');

      // "Year" must NOT blank the pre-existing 1,000 in (0,0).
      await waitFor(() => expect(toastMock).toHaveBeenCalledTimes(1));
      expect(inputAt(0, 0).value).toBe('1,000');

      // "1" and "2" parse as numeric and overwrite empty cells with their
      // values — they don't blank anything (the cells were empty), but
      // the safety contract is: non-numeric never clobbers, numeric does.
      expect(inputAt(0, 1).value).toBe('1');
      expect(inputAt(0, 2).value).toBe('2');

      // "Value" leaves the empty (1,0) untouched; numeric cells fill.
      expect(inputAt(1, 0).value).toBe('');
      expect(inputAt(1, 1).value).toBe('100');
      expect(inputAt(1, 2).value).toBe('200');

      const msg = toastMock.mock.calls[0][0];
      expect(msg).toMatch(/non-numeric/);
    });

    it('handles a single-cell paste at an in-triangle corner without crashing', async () => {
      // (4,0) is the last in-triangle cell (row 4 max-col = 0).
      await renderAndWait();
      pasteInto(4, 0, '999');

      await waitFor(() => expect(inputAt(4, 0).value).toBe('999'));
      expect(toastMock).not.toHaveBeenCalled();
    });
  });

  describe('theme-aware headings', () => {
    it('renders .tri-yr and .tri-hdr without hardcoded mint inline styles', async () => {
      await renderAndWait();
      const headers = document.querySelectorAll('.tri-hdr');
      const yearCells = document.querySelectorAll('.tri-yr');
      expect(headers.length).toBeGreaterThan(0);
      expect(yearCells.length).toBeGreaterThan(0);
      [...headers, ...yearCells].forEach((el) => {
        const style = el.getAttribute('style') || '';
        expect(style).not.toMatch(/#23d18b/i);
        expect(style).not.toMatch(/rgb\(\s*35\s*,\s*209\s*,\s*139\s*\)/i);
      });
    });
  });
});
