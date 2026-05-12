// Round-trip test: write a workbook via the exceljs adapter, then read it
// back and assert the shape. Guards against regressions in the tiny
// replacement-for-xlsx API surface that the export/import call-sites rely on.
//
// Uses writeBuffer() to bypass the DOM-triggered download path; the browser
// plumbing (Blob + anchor click) is exercised manually during regression
// testing of the actual Export buttons.

import { describe, it, expect } from 'vitest';
import { createWorkbook, readWorkbook } from './excel';

describe('excel adapter', () => {
  it('round-trips a simple workbook: write → read yields the same rows', async () => {
    const wb = await createWorkbook();
    wb.appendSheet('Alpha', [
      ['Name', 'Count', 'Ratio'],
      ['foo', 1, 0.25],
      ['bar', 2, 0.5],
    ]);
    wb.appendSheet('Beta', [
      ['a', 'b'],
      [null, 'x'],
    ]);
    const buf = await wb.writeBuffer();

    const sheets = await readWorkbook(buf);
    expect(sheets).toHaveLength(2);
    expect(sheets[0].name).toBe('Alpha');
    expect(sheets[0].rows[0]).toEqual(['Name', 'Count', 'Ratio']);
    expect(sheets[0].rows[1]).toEqual(['foo', 1, 0.25]);
    expect(sheets[0].rows[2]).toEqual(['bar', 2, 0.5]);
    expect(sheets[1].name).toBe('Beta');
    expect(sheets[1].rows[0]).toEqual(['a', 'b']);
    expect(sheets[1].rows[1][0]).toBeNull();
    expect(sheets[1].rows[1][1]).toBe('x');
  });

  it('sanitizes sheet names longer than 31 chars or with illegal chars', async () => {
    const wb = await createWorkbook();
    wb.appendSheet('A:Name*With?Illegal/Chars\\And[Brackets]', [['x']]);
    wb.appendSheet('x'.repeat(60), [['y']]);
    const buf = await wb.writeBuffer();

    const sheets = await readWorkbook(buf);
    // illegal chars replaced, then truncated at 31
    expect(sheets[0].name).toBe('A_Name_With_Illegal_Chars_And_B');
    expect(sheets[0].name.length).toBeLessThanOrEqual(31);
    expect(sheets[1].name.length).toBeLessThanOrEqual(31);
  });

  it('preserves rows even when a sheet is created empty', async () => {
    const wb = await createWorkbook();
    wb.appendSheet('Empty', []);
    wb.appendSheet('One', [['only']]);
    const buf = await wb.writeBuffer();

    const sheets = await readWorkbook(buf);
    expect(sheets).toHaveLength(2);
    expect(sheets[0].rows).toEqual([]);
    expect(sheets[1].rows).toEqual([['only']]);
  });
});
