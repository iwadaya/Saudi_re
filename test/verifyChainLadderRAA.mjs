// Verifies that client/src/logic/chainLadder.js reproduces the
// Volume-Weighted Chain Ladder result on the RAA (Mack 1993) triangle
// supplied in chain_ladder_verification.xlsx.
//
// Run with: node test/verifyChainLadderRAA.mjs

import {
  buildMatrixFromCells,
  calculateAgeToAgeFactors,
  calculatePattern,
  calculateCdfs,
  projectToUltimate,
} from '../client/src/logic/chainLadder.js';

// RAA cumulative paid losses ($ thousands), 1981-1990, dev periods 1..10
const triangle = [
  [5012, 8269, 10907, 11805, 13539, 16181, 18009, 18608, 18662, 18834],
  [ 106, 4285,  5396, 10666, 13782, 15599, 15496, 16169, 16704, null ],
  [3410, 8992, 13873, 16141, 18735, 22214, 22863, 23466, null,  null ],
  [5655,11555, 15766, 21266, 23425, 26083, 27067, null,  null,  null ],
  [1092, 9565, 15836, 22169, 25955, 26180, null,  null,  null,  null ],
  [1513, 6445, 11702, 12935, 15852, null,  null,  null,  null,  null ],
  [ 557, 4020, 10946, 12314, null,  null,  null,  null,  null,  null ],
  [1351, 6947, 13112, null,  null,  null,  null,  null,  null,  null ],
  [3133, 5395, null,  null,  null,  null,  null,  null,  null,  null ],
  [2063, null, null,  null,  null,  null,  null,  null,  null,  null ],
];
const years = [1981, 1982, 1983, 1984, 1985, 1986, 1987, 1988, 1989, 1990];

// Round-trip through buildMatrixFromCells to also exercise the cell loader
const cells = [];
triangle.forEach((row, i) => {
  row.forEach((v, c) => {
    if (v != null) cells.push({ origin_year: years[i], dev_months: (c + 1) * 12, cum_value: v });
  });
});
const dataObj = buildMatrixFromCells(cells);

const factors = calculateAgeToAgeFactors(dataObj.matrix);
const { pattern, warnings } = calculatePattern(dataObj.matrix, factors, 'weighted');
const cdfs = calculateCdfs(pattern, 1.0);
const { projections } = projectToUltimate(pattern, 1.0, dataObj);

// Expected values from Triangle (Solved) sheet
const expectedPattern = [2.9994, 1.6235, 1.2709, 1.1717, 1.1134, 1.0419, 1.0333, 1.0169, 1.0092];
const expectedCdfs    = [8.9202, 2.9740, 1.8318, 1.4414, 1.2302, 1.1049, 1.0604, 1.0263, 1.0092, 1.0000];
const expectedAy = {
  1981: { latest: 18834, ultimate: 18834.0000, ibnr:     0.0000 },
  1982: { latest: 16704, ultimate: 16857.9539, ibnr:   153.9539 },
  1983: { latest: 23466, ultimate: 24083.3709, ibnr:   617.3709 },
  1984: { latest: 27067, ultimate: 28703.1422, ibnr:  1636.1422 },
  1985: { latest: 26180, ultimate: 28926.7363, ibnr:  2746.7363 },
  1986: { latest: 15852, ultimate: 19501.1032, ibnr:  3649.1032 },
  1987: { latest: 12314, ultimate: 17749.3026, ibnr:  5435.3026 },
  1988: { latest: 13112, ultimate: 24019.1925, ibnr: 10907.1925 },
  1989: { latest:  5395, ultimate: 16044.9841, ibnr: 10649.9841 },
  1990: { latest:  2063, ultimate: 18402.4425, ibnr: 16339.4425 },
};

const fmt = (n, d = 4) => Number(n).toFixed(d);
const fmtComma = (n, d = 4) => Number(n).toLocaleString('en-US', {
  minimumFractionDigits: d, maximumFractionDigits: d,
});
let allOk = true;

console.log('Volume-Weighted Age-to-Age Factors');
console.log('Transition         Computed       Excel        Diff');
console.log('-'.repeat(56));
pattern.forEach((p, i) => {
  const diff = p - expectedPattern[i];
  const ok = Math.abs(diff) < 1e-3;
  if (!ok) allOk = false;
  console.log(`Dev ${i+1}->${i+2}        ${fmt(p, 6).padStart(12)}   ${fmt(expectedPattern[i], 4).padStart(8)}   ${fmt(diff, 6).padStart(10)}   ${ok ? 'OK' : 'FAIL'}`);
});

console.log('\nCumulative Development Factors');
console.log('Dev period         Computed       Excel        Diff');
console.log('-'.repeat(56));
cdfs.forEach((c, i) => {
  const diff = c - expectedCdfs[i];
  const ok = Math.abs(diff) < 1e-3;
  if (!ok) allOk = false;
  console.log(`CDF Dev ${i+1}        ${fmt(c, 6).padStart(12)}   ${fmt(expectedCdfs[i], 4).padStart(8)}   ${fmt(diff, 6).padStart(10)}   ${ok ? 'OK' : 'FAIL'}`);
});

console.log('\nUltimate / IBNR per Accident Year');
console.log('AY     Latest    Ult Calc        Ult Excel         dUlt    IBNR Calc      IBNR Excel       dIBNR  Status');
console.log('-'.repeat(110));
let totUlt = 0, totIbnr = 0;
projections.forEach(p => {
  const e = expectedAy[p.year];
  const dUlt = p.ultimate - e.ultimate;
  const dIbnr = p.ibnr - e.ibnr;
  const ok = Math.abs(dUlt) < 1e-3 && Math.abs(dIbnr) < 1e-3 && p.latest === e.latest;
  if (!ok) allOk = false;
  totUlt += p.ultimate;
  totIbnr += p.ibnr;
  console.log(
    `${p.year}  ${String(p.latest).padStart(6)}  ${fmtComma(p.ultimate).padStart(13)}  ${fmtComma(e.ultimate).padStart(13)}  ${fmt(dUlt, 4).padStart(8)}  ${fmtComma(p.ibnr).padStart(13)}  ${fmtComma(e.ibnr).padStart(13)}  ${fmt(dIbnr, 4).padStart(8)}  ${ok ? 'OK' : 'FAIL'}`
  );
});

console.log('-'.repeat(110));
console.log(`Total Ultimate = ${fmtComma(totUlt, 2)}   Total IBNR (Reserve) = ${fmtComma(totIbnr, 2)}   (Excel ref ≈ 52,135)`);
console.log(`\nWarnings from calculatePattern (thin columns < 3 rows): ${warnings.length}`);
warnings.forEach(w => console.log(`  - ${w.message}`));

console.log(`\nOverall: ${allOk ? 'ALL FORMULAS MATCH EXCEL SOLVED SHEET' : 'MISMATCH'}`);
process.exit(allOk ? 0 : 1);
