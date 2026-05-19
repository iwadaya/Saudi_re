// Verifies that client/src/logic/bornhuetterFerguson.js (calculateBF)
// reproduces the BF Solved sheet of bornhuetter_ferguson_verification.xlsx
// using the RAA triangle + Earned Premium and IELR=0.75.
//
// Run with: node test/verifyBornhuetterFergusonRAA.mjs

import {
  buildMatrixFromCells,
  calculateAgeToAgeFactors,
  calculatePattern,
  projectToUltimate,
} from '../client/src/logic/chainLadder.js';
import { calculateBF } from '../client/src/logic/bornhuetterFerguson.js';

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
const years    = [1981, 1982, 1983, 1984, 1985, 1986, 1987, 1988, 1989, 1990];
const premiums = [18000, 17500, 24000, 28000, 28500, 19500, 17500, 23000, 19000, 23000];
const ielrs    = years.map(() => 0.75);

// Run the codebase's chain-ladder pipeline -> projections (latest + CDF per AY)
const cells = [];
triangle.forEach((row, i) => row.forEach((v, c) => {
  if (v != null) cells.push({ origin_year: years[i], dev_months: (c + 1) * 12, cum_value: v });
}));
const dataObj = buildMatrixFromCells(cells);
const factors = calculateAgeToAgeFactors(dataObj.matrix);
const { pattern } = calculatePattern(dataObj.matrix, factors, 'weighted');
const { projections: clProj } = projectToUltimate(pattern, 1.0, dataObj);

// Drive calculateBF
const bf = calculateBF(clProj, premiums, ielrs);

// Excel solved values
const expected = {
  1981: { latest: 18834, cdf: 1.000000, pctUnrep: 0.000000, apriori: 13500, ibnr:     0.000000, ult: 18834.000000, lr: 1.046333 },
  1982: { latest: 16704, cdf: 1.009217, pctUnrep: 0.009132, apriori: 13125, ibnr:   119.863014, ult: 16823.863014, lr: 0.961364 },
  1983: { latest: 23466, cdf: 1.026309, pctUnrep: 0.025635, apriori: 18000, ibnr:   461.425299, ult: 23927.425299, lr: 0.996976 },
  1984: { latest: 27067, cdf: 1.060448, pctUnrep: 0.057002, apriori: 21000, ibnr:  1197.046136, ult: 28264.046136, lr: 1.009430 },
  1985: { latest: 26180, cdf: 1.104917, pctUnrep: 0.094955, apriori: 21375, ibnr:  2029.661717, ult: 28209.661717, lr: 0.989813 },
  1986: { latest: 15852, cdf: 1.230198, pctUnrep: 0.187123, apriori: 14625, ibnr:  2736.672565, ult: 18588.672565, lr: 0.953265 },
  1987: { latest: 12314, cdf: 1.441392, pctUnrep: 0.306226, apriori: 13125, ibnr:  4019.219692, ult: 16333.219692, lr: 0.933327 },
  1988: { latest: 13112, cdf: 1.831848, pctUnrep: 0.454103, apriori: 17250, ibnr:  7833.280437, ult: 20945.280437, lr: 0.910664 },
  1989: { latest:  5395, cdf: 2.974047, pctUnrep: 0.663758, apriori: 14250, ibnr:  9458.549319, ult: 14853.549319, lr: 0.781766 },
  1990: { latest:  2063, cdf: 8.920234, pctUnrep: 0.887895, apriori: 17250, ibnr: 15316.194205, ult: 17379.194205, lr: 0.755617 },
};
const TOTAL = { ibnr: 43171.912384, ult: 204158.912384, apriori: 163500 };

const TOL_ABS = 1e-3; // Excel rounded to 6dp; allow rounding noise
const fmt = (n, d=6) => Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

let pass = true;
console.log('Bornhuetter-Ferguson — codebase vs Excel (Solved) reference');
console.log('AY   Field           Codebase            Excel              Diff       Status');
console.log('-'.repeat(80));
const checks = [
  ['latest',       (b, e) => [b.latest,            e.latest]],
  ['CDF',          (b, e) => [b.cdf,               e.cdf]],
  ['% Unrep',      (b, e) => [b.percentUnreported, e.pctUnrep]],
  ['A Priori',     (b, e) => [b.aPrioriUltimate,   e.apriori]],
  ['Exp IBNR (BF)',(b, e) => [b.expectedIbnr,      e.ibnr]],
  ['BF Ultimate',  (b, e) => [b.ultimate,          e.ult]],
  ['BF Loss Ratio',(b, e) => [b.lossRatio,         e.lr]],
];

let totIbnr = 0, totUlt = 0, totApr = 0;
for (const r of bf) {
  const e = expected[r.year];
  totIbnr += r.expectedIbnr; totUlt += r.ultimate; totApr += r.aPrioriUltimate;
  for (const [name, picker] of checks) {
    const [c, x] = picker(r, e);
    const diff = c - x;
    const ok = Math.abs(diff) <= TOL_ABS;
    if (!ok) pass = false;
    console.log(`${r.year} ${name.padEnd(15)} ${fmt(c).padStart(16)}  ${fmt(x).padStart(16)}  ${fmt(diff).padStart(12)}  ${ok ? 'OK' : 'FAIL'}`);
  }
  console.log();
}

console.log('-'.repeat(80));
console.log(`TOTAL A Priori : codebase ${fmt(totApr,2)}  excel ${fmt(TOTAL.apriori,2)}  diff ${fmt(totApr-TOTAL.apriori,4)}`);
console.log(`TOTAL Exp IBNR : codebase ${fmt(totIbnr,6)}  excel ${fmt(TOTAL.ibnr,6)}  diff ${fmt(totIbnr-TOTAL.ibnr,6)}`);
console.log(`TOTAL BF Ult   : codebase ${fmt(totUlt,6)}  excel ${fmt(TOTAL.ult,6)}  diff ${fmt(totUlt-TOTAL.ult,6)}`);
if (Math.abs(totApr-TOTAL.apriori)>TOL_ABS || Math.abs(totIbnr-TOTAL.ibnr)>TOL_ABS || Math.abs(totUlt-TOTAL.ult)>TOL_ABS) pass = false;

console.log(`\nOverall: ${pass ? 'ALL BF VALUES MATCH EXCEL SOLVED SHEET' : 'MISMATCH'}`);
process.exit(pass ? 0 : 1);
