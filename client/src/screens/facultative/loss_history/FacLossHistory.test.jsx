// Loss history grid: opens with a block of empty rows and grows to fit a
// pasted region, so a loss run can come straight out of Excel.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import FacLossHistory from './FacLossHistory.jsx';

const { apiMock } = vi.hoisted(() => ({ apiMock: {
  facGetLosses: vi.fn(),
  facSaveLosses: vi.fn(),
  facGetExperience: vi.fn(),
  facSaveExperience: vi.fn(),
} }));
vi.mock('../../../api', () => ({ api: apiMock, default: apiMock }));
vi.mock('../../../hooks/useContractId', () => ({ useFacRiskId: () => 'risk-1' }));
vi.mock('../../../components/WizardLayout', () => ({ default: ({ children }) => <div>{children}</div> }));

afterEach(() => { cleanup(); vi.clearAllMocks(); });
beforeEach(() => {
  apiMock.facGetLosses.mockResolvedValue([]);
  apiMock.facGetExperience.mockResolvedValue({ basis: [] });
  apiMock.facSaveLosses.mockResolvedValue({ ok: true });
  apiMock.facSaveExperience.mockResolvedValue({ ok: true });
});

/** Year inputs are the first column, one per row — a cheap row count. */
const yearCells = () => document.querySelectorAll('input[data-col="0"]');
const cell = (row, col) => document.querySelector(`input[data-row="${row}"][data-col="${col}"]`);

/** Fire a clipboard paste of TSV text at a given origin cell. */
function pasteAt(row, col, tsv) {
  const target = cell(row, col);
  fireEvent.paste(target, { clipboardData: { getData: () => tsv } });
}

describe('the opening grid', () => {
  it('offers 20 empty rows to type or paste into', async () => {
    render(<FacLossHistory />);
    await waitFor(() => expect(yearCells().length).toBe(20));
    // …and they are genuinely empty: a pre-filled year would make all twenty
    // look like real losses to the save filter.
    expect(cell(0, 0).value).toBe('');
    expect(screen.getByText(/TOTAL \(0 losses\)/)).toBeInTheDocument();
  });

  it('tells the underwriter what the column order is', async () => {
    render(<FacLossHistory />);
    await waitFor(() => expect(yearCells().length).toBe(20));
    expect(screen.getByText(/Year · Date · Description · Cause · FGU Paid · FGU O\/S · Mitigation/)).toBeInTheDocument();
  });
});

describe('pasting a block', () => {
  it('fills cells across and down from the origin', async () => {
    render(<FacLossHistory />);
    await waitFor(() => expect(yearCells().length).toBe(20));

    pasteAt(0, 0, '2024\t2024-03-11\tFire in warehouse\tFire\t250000\t50000\tSprinklers fitted\n'
                + '2023\t2023-07-02\tFlood\tFlood\t80000\t0\tBunding raised');

    await waitFor(() => expect(cell(0, 2).value).toBe('Fire in warehouse'));
    expect(cell(0, 0).value).toBe('2024');
    expect(cell(0, 1).value).toBe('2024-03-11');
    expect(cell(0, 3).value).toBe('Fire');
    expect(cell(0, 4).value).toBe('250,000');   // money is comma-formatted on display
    expect(cell(0, 5).value).toBe('50,000');
    expect(cell(0, 6).value).toBe('Sprinklers fitted');
    expect(cell(1, 0).value).toBe('2023');
    expect(cell(1, 2).value).toBe('Flood');
  });

  it('grows the grid when the pasted block is deeper than the rows available', async () => {
    render(<FacLossHistory />);
    await waitFor(() => expect(yearCells().length).toBe(20));

    // 25 rows into a 20-row grid.
    const tsv = Array.from({ length: 25 }, (_, i) => `${2000 + i}\t\tLoss ${i}\t\t1000\t0\t`).join('\n');
    pasteAt(0, 0, tsv);

    // 25 filled + trailing blanks to type into.
    await waitFor(() => expect(yearCells().length).toBeGreaterThanOrEqual(28));
    expect(cell(24, 2).value).toBe('Loss 24');
  });

  it('starts from whichever cell was clicked, not always the first', async () => {
    render(<FacLossHistory />);
    await waitFor(() => expect(yearCells().length).toBe(20));

    pasteAt(3, 4, '111\t222');   // into FGU Paid / FGU O/S on row 4

    await waitFor(() => expect(cell(3, 4).value).toBe('111'));
    expect(cell(3, 5).value).toBe('222');
    expect(cell(3, 0).value).toBe('');   // year untouched
  });

  it('survives Excel-on-Windows CRLF line endings', async () => {
    render(<FacLossHistory />);
    await waitFor(() => expect(yearCells().length).toBe(20));

    pasteAt(0, 0, '2024\t\tCRLF row\t\t100\t0\tdone\r\n2023\t\tSecond\t\t200\t0\tdone\r\n');

    // A stray \r left on the last cell would break date parsing and make empty
    // rows look filled.
    await waitFor(() => expect(cell(0, 6).value).toBe('done'));
    expect(cell(1, 2).value).toBe('Second');
  });

  it('strips thousands separators and currency out of pasted money', async () => {
    render(<FacLossHistory />);
    await waitFor(() => expect(yearCells().length).toBe(20));

    pasteAt(0, 4, '1,250,000\t$75,000');

    await waitFor(() => expect(cell(0, 4).value).toBe('1,250,000'));
    expect(cell(0, 5).value).toBe('75,000');
  });

  it('fills the year from a pasted date when the year column is blank', async () => {
    // The 10-year matrix buckets on loss_year; a loss with only a date would
    // silently vanish from it.
    render(<FacLossHistory />);
    await waitFor(() => expect(yearCells().length).toBe(20));

    pasteAt(0, 1, '2022-05-04\tRoof collapse');

    await waitFor(() => expect(cell(0, 1).value).toBe('2022-05-04'));
    expect(cell(0, 0).value).toBe('2022');
  });

  it('ignores columns past the last editable one', async () => {
    render(<FacLossHistory />);
    await waitFor(() => expect(yearCells().length).toBe(20));

    // Two extra trailing columns must not throw or wrap onto the next row.
    pasteAt(0, 5, '10\tmitigation\tEXTRA\tMORE');

    await waitFor(() => expect(cell(0, 5).value).toBe('10'));
    expect(cell(0, 6).value).toBe('mitigation');
    expect(cell(1, 0).value).toBe('');
  });

  it('leaves a single-cell paste to the browser', async () => {
    render(<FacLossHistory />);
    await waitFor(() => expect(yearCells().length).toBe(20));

    const target = cell(0, 2);
    const ev = new Event('paste', { bubbles: true, cancelable: true });
    ev.clipboardData = { getData: () => 'just one value' };
    fireEvent(target, ev);

    // Not intercepted — pasting one value into one field stays normal.
    expect(ev.defaultPrevented).toBe(false);
  });
});

describe('totals', () => {
  it('counts only rows with something in them', async () => {
    render(<FacLossHistory />);
    await waitFor(() => expect(yearCells().length).toBe(20));
    expect(screen.getByText(/TOTAL \(0 losses\)/)).toBeInTheDocument();

    pasteAt(0, 0, '2024\t\tOne\t\t100\t0\t\n2023\t\tTwo\t\t200\t0\t');

    await waitFor(() => expect(screen.getByText(/TOTAL \(2 losses\)/)).toBeInTheDocument());
  });
});
