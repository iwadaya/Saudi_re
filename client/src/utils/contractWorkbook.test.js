import { beforeEach, describe, expect, it, vi } from 'vitest';
import { UT } from '../../../shared/universeXlsxTheme.js';
import { buildContractWorkbook } from './contractWorkbook';

let capturedWorkbook;

vi.mock('./excel', async () => {
  const excelJSImport = await import('exceljs');
  const ExcelJS = excelJSImport.default || excelJSImport;
  return {
    createWorkbook: async () => {
      capturedWorkbook = new ExcelJS.Workbook();
      return {
        workbook: capturedWorkbook,
        writeFile: async () => {},
      };
    },
  };
});

describe('buildContractWorkbook', () => {
  beforeEach(() => {
    capturedWorkbook = undefined;
  });

  it('keeps decimal values from being forced to integer display', async () => {
    await buildContractWorkbook({
      contractId: 'demo-id',
      order: ['STEP'],
      labels: { STEP: 'Step' },
      registry: {
        STEP: {
          sheetName: 'Metrics',
          build: () => [
            ['Metric', 'Value'],
            ['Whole Number', 1234],
            ['Decimal Ratio', 0.2567],
          ],
        },
      },
      header: {},
      filename: 'contract-export.xlsx',
    });

    const ws = capturedWorkbook.getWorksheet('01 Metrics');
    expect(ws).toBeTruthy();

    // Header row is written on row 4, then data rows begin at row 5.
    expect(ws.getCell(5, 2).numFmt).toBe(UT.fmtInt);
    expect(ws.getCell(6, 2).numFmt || null).toBe(null);
    expect(ws.getCell(6, 2).value).toBe(0.2567);
  });
});
