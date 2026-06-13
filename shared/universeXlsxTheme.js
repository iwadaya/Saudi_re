// shared/universeXlsxTheme.js
// Universe pack palette + reusable ExcelJS styling helpers.

export const UT = {
  font: 'Calibri',
  white:    'FFFFFFFF',
  ink:      'FF16323B',
  inkSoft:  'FF5B7079',
  teal:     'FF0D5C75',   // gradient start
  green:    'FF2F8F6B',   // gradient end
  headerBg: 'FF1E7A5A',   // header row fill (white text)
  zebraA:   'FFEAF4F8',   // light blue
  zebraB:   'FFEFF7F1',   // light green
  totalBg:  'FFCDE7DD',
  totalInk: 'FF0D4A3A',
  grid:     'FFD8E2E6',
  fmtMoney: '#,##0;[Red]-#,##0',
  fmtMoney2:'#,##0.00;[Red]-#,##0.00',
  fmtPct:   '0.00%',
  fmtRate:  '#,##0.0000',
  fmtInt:   '#,##0',
  fmtDate:  'dd-mmm-yyyy',
};

const thin = () => ({ style:'thin', color:{ argb: UT.grid } });
const allThin = () => ({ top:thin(), left:thin(), bottom:thin(), right:thin() });

// Title bar across rows 1-3. Returns the row index where the column header should go (4).
export function titleBar(ws, ncols, sheetTitle, subtitle) {
  ws.mergeCells(1, 1, 2, ncols);
  const t = ws.getCell(1, 1);
  t.value = { richText: [
    { text: 'UNIVERSE', font: { name: UT.font, size: 16, bold: true, color: { argb: UT.white } } },
    { text: '    ' + (sheetTitle || ''), font: { name: UT.font, size: 13, color: { argb: 'FFEAF4F8' } } },
  ]};
  t.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  t.fill = { type: 'gradient', gradient: 'angle', degree: 0,
    stops: [ { position: 0, color: { argb: UT.teal } }, { position: 1, color: { argb: UT.green } } ] };
  ws.getRow(1).height = 22; ws.getRow(2).height = 14;

  ws.mergeCells(3, 1, 3, ncols);
  const s = ws.getCell(3, 1);
  s.value = subtitle || '';
  s.font = { name: UT.font, size: 9, italic: true, color: { argb: UT.inkSoft } };
  s.alignment = { vertical: 'middle', horizontal: 'left', indent: 1 };
  s.fill = { type:'pattern', pattern:'solid', fgColor:{ argb:'FFF4F9FA' } };
  ws.getRow(3).height = 16;
  return 4; // header row index
}

// Style the column-header row.
export function headerRow(ws, rowIdx, ncols) {
  const r = ws.getRow(rowIdx); r.height = 26;
  for (let c = 1; c <= ncols; c++) {
    const cell = ws.getCell(rowIdx, c);
    cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb: UT.headerBg } };
    cell.font = { name: UT.font, size: 10.5, bold: true, color: { argb: UT.white } };
    cell.alignment = { vertical:'middle', horizontal:'center', wrapText:true };
    cell.border = allThin();
  }
}

// Zebra-stripe + border + ink body rows from firstData..lastData inclusive.
export function zebra(ws, firstData, lastData, ncols) {
  for (let rr = firstData; rr <= lastData; rr++) {
    const fill = ((rr - firstData) % 2 === 0) ? UT.zebraA : UT.zebraB;
    for (let c = 1; c <= ncols; c++) {
      const cell = ws.getCell(rr, c);
      cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb: fill } };
      if (!cell.font) cell.font = { name: UT.font, size: 10, color: { argb: UT.ink } };
      else cell.font = { ...cell.font, name: UT.font, color: { argb: UT.ink } };
      cell.border = allThin();
    }
  }
}

// Total / summary row.
export function totalRow(ws, rowIdx, ncols) {
  const r = ws.getRow(rowIdx); r.height = 20;
  for (let c = 1; c <= ncols; c++) {
    const cell = ws.getCell(rowIdx, c);
    cell.fill = { type:'pattern', pattern:'solid', fgColor:{ argb: UT.totalBg } };
    cell.font = { name: UT.font, size: 10.5, bold: true, color: { argb: UT.totalInk } };
    cell.border = { ...allThin(), top: { style:'medium', color:{ argb: UT.green } } };
  }
}

// Final chrome: hide gridlines, freeze title+header (and N label cols), print to fit.
export function finishSheet(ws, headerRowIdx, freezeCols = 1) {
  ws.views = [{ state:'frozen', xSplit: freezeCols, ySplit: headerRowIdx, showGridLines: false }];
  ws.pageSetup = { orientation:'landscape', fitToPage:true, fitToWidth:1, fitToHeight:0,
    margins:{ left:0.4, right:0.4, top:0.5, bottom:0.5, header:0.2, footer:0.2 } };
  ws.pageSetup.printTitlesRow = `1:${headerRowIdx}`;
  ws.headerFooter = { oddFooter: '&L&"Calibri"&8 Universe — generated &D &RPage &P of &N' };
}

// Cover sheet with brand block + table of contents. tabs = [{name, desc}].
export function coverSheet(wb, tabs, meta) {
  const ws = wb.addWorksheet('Cover');
  ws.getColumn(1).width = 4; ws.getColumn(2).width = 40; ws.getColumn(3).width = 60;
  ws.mergeCells(2, 2, 4, 3);
  const t = ws.getCell(2, 2);
  t.value = { richText: [
    { text: 'UNIVERSE\n', font: { name: UT.font, size: 28, bold: true, color: { argb: UT.white } } },
    { text: (meta?.title || 'Portfolio Renewal Pack'), font: { name: UT.font, size: 15, color: { argb: 'FFEAF4F8' } } },
  ]};
  t.alignment = { vertical:'middle', horizontal:'left', indent:2, wrapText:true };
  t.fill = { type:'gradient', gradient:'angle', degree:0,
    stops:[ {position:0,color:{argb:UT.teal}}, {position:1,color:{argb:UT.green}} ] };
  ws.getRow(2).height = 30; ws.getRow(3).height = 30; ws.getRow(4).height = 30;

  const lines = meta?.lines || [
    ['Generated', (meta?.date || new Date().toISOString().slice(0,10))],
    ['Base currency', 'USD (converted at latest reference rates)'],
    ['Basis', 'Triangles: all contracts · Profiles & aggregates: signed contracts'],
  ];
  let row = 6;
  lines.forEach(([label, value]) => {
    const labelCell = ws.getCell(row, 2);
    labelCell.value = label;
    labelCell.font = { name: UT.font, bold: true, color: { argb: UT.teal } };
    const valueCell = ws.getCell(row, 3);
    valueCell.value = value;
    valueCell.font = { name: UT.font, color: { argb: UT.ink } };
    row++;
  });

  const contentsRow = row + 1;
  ws.getCell(contentsRow, 2).value = 'Contents';
  ws.getCell(contentsRow, 2).font = { name: UT.font, size: 12, bold: true, color: { argb: UT.headerBg } };
  let rr = contentsRow + 1;
  tabs.forEach((tab, i) => {
    const a = ws.getCell(rr, 2), b = ws.getCell(rr, 3);
    a.value = `${i+1}.  ${tab.name}`; b.value = tab.desc || '';
    const fill = (i % 2 === 0) ? UT.zebraA : UT.zebraB;
    [a,b].forEach(c => { c.fill = { type:'pattern', pattern:'solid', fgColor:{ argb: fill } };
      c.font = { name: UT.font, size: 10, color: { argb: UT.ink } }; c.alignment = { vertical:'middle' }; });
    rr++;
  });
  ws.views = [{ showGridLines: false }];
  return ws;
}
