// Thin adapter over ExcelJS. Keeps all XLSX knowledge in one place so the
// call-sites (portfolio export, NP/Prop pricing exports, Excel import agent)
// don't have to know about the underlying library.
//
// Replaces the `xlsx` package, which had an unpatched high-severity
// prototype-pollution CVE. exceljs is lazy-loaded so it doesn't bloat the
// initial bundle — none of the call-sites run on mount.
//
// Surface intentionally matches only what the call-sites need:
//   • readWorkbook(arrayBuffer) → [{name, rows: AoA}]
//   • createWorkbook() → { appendSheet(name, aoa), writeBuffer(), writeFile(filename) }

let excelJsPromise;
function loadExcelJs() {
  if (!excelJsPromise) {
    excelJsPromise = import('exceljs').then(m => m.default || m);
  }
  return excelJsPromise;
}

// Excel sheet names are capped at 31 chars and reject *?:/\[]
function sanitizeSheetName(name) {
  return String(name || 'Sheet').replace(/[*?:/\\[\]]/g, '_').slice(0, 31) || 'Sheet';
}

// Flatten an ExcelJS cell .value to the plain scalars the parsers expect.
// xlsx by default returned numbers/strings/null; exceljs can return Date
// objects, { richText }, { formula, result }, { text, hyperlink }. Collapse
// all of those so downstream code doesn't have to care.
function normalizeCell(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10); // YYYY-MM-DD
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map(r => r.text).join('');
    if ('result' in v) return normalizeCell(v.result);
    if ('text' in v || 'hyperlink' in v) return v.text ?? v.hyperlink ?? '';
    if ('error' in v) return null;
  }
  return v;
}

function worksheetToAoa(ws) {
  const out = [];
  const rowCount = ws.rowCount || 0;
  for (let r = 1; r <= rowCount; r++) {
    const row = ws.getRow(r);
    const width = row.cellCount || (row.values?.length ? row.values.length - 1 : 0);
    const arr = [];
    for (let c = 1; c <= width; c++) {
      arr.push(normalizeCell(row.getCell(c).value));
    }
    out.push(arr);
  }
  return out;
}

/**
 * Parse an .xlsx ArrayBuffer into a list of sheets.
 * @param {ArrayBuffer} arrayBuffer
 * @returns {Promise<Array<{name:string, rows: Array<Array<any>>}>>}
 */
export async function readWorkbook(arrayBuffer) {
  const ExcelJS = await loadExcelJs();
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(arrayBuffer);
  return wb.worksheets.map(ws => ({ name: ws.name, rows: worksheetToAoa(ws) }));
}

/**
 * Build a workbook and trigger a browser download.
 * @returns {Promise<{ appendSheet: (name:string, aoa:Array<Array<any>>)=>void, writeFile: (filename:string)=>Promise<void> }>}
 */
export async function createWorkbook() {
  const ExcelJS = await loadExcelJs();
  const wb = new ExcelJS.Workbook();
  return {
    // Direct handle to the underlying ExcelJS workbook, for call-sites that
    // need to add a themed cover sheet or control sheet order.
    workbook: wb,
    // Returns the underlying ExcelJS worksheet so callers can apply styling
    // (column widths, freeze panes, etc.) — see HomeScreen portfolio export.
    appendSheet(name, aoa) {
      const ws = wb.addWorksheet(sanitizeSheetName(name));
      if (Array.isArray(aoa) && aoa.length) ws.addRows(aoa);
      return ws;
    },
    // Returns the workbook as a raw buffer. Exposed for tests and any
    // call-site that needs the bytes without triggering a download.
    async writeBuffer() {
      return wb.xlsx.writeBuffer();
    },
    async writeFile(filename) {
      const buf = await wb.xlsx.writeBuffer();
      const blob = new Blob([buf], {
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    },
  };
}
