// Verifies that client/src/logic/munichChainLadder.js reproduces every
// number in munich_chain_ladder_verification.xlsx (Quarg-Mack 2004 MCL).
//
// Run with: node test/verifyMunichChainLadderQuarg.mjs

import { calculateMunichChainLadder } from '../client/src/logic/munichChainLadder.js';

const paid = [
  [1500, 1900, 2300, 2600, 2800],   // 2018
  [1600, 2000, 2400, 2700, null],   // 2019
  [1700, 2100, 2500, null, null],   // 2020
  [1800, 2250, null, null, null],   // 2021
  [1900, null, null, null, null],   // 2022
];
const incurred = [
  [2700, 2900, 3000, 3050, 3000],
  [2800, 3050, 3120, 3100, null],
  [2900, 3150, 3220, null, null],
  [3000, 3220, null, null, null],
  [3100, null, null, null, null],
];
const years = [2018, 2019, 2020, 2021, 2022];

const r = calculateMunichChainLadder({ paid, incurred, years });

const TOL = 1e-3;
const fmt = (n, d = 6) => n == null ? '-' : Number(n).toLocaleString('en-US', { minimumFractionDigits: d, maximumFractionDigits: d });

let pass = true;
function check(label, calc, exp) {
  const c = calc == null ? null : Number(calc);
  const e = exp == null ? null : Number(exp);
  const diff = c == null || e == null ? (c == null && e == null ? 0 : NaN) : c - e;
  const ok = (c == null && e == null) || (Number.isFinite(diff) && Math.abs(diff) <= TOL);
  if (!ok) pass = false;
  console.log(`  ${label.padEnd(34)} ${fmt(c).padStart(14)}   ${fmt(e).padStart(14)}   ${(diff == null ? '-' : fmt(diff)).padStart(12)}   ${ok ? 'OK' : 'FAIL'}`);
}

// Section C/D — CL patterns and CDFs
console.log('CL Paid pattern & CDF');
const expPaidLdf = [1.25, 1.2, 1.12766, 1.076923];
const expPaidCdf = [1.821604, 1.457283, 1.214403, 1.076923, 1.0];
r.paidPattern.forEach((v, i) => check(`f^P[${i}]  Dev${i+1}->Dev${i+2}`, v, expPaidLdf[i]));
r.paidCdfs.forEach((v, i) => check(`CDF^P[Dev${i+1}]`, v, expPaidCdf[i]));

console.log('\nCL Incurred pattern & CDF');
const expIncLdf = [1.080702, 1.026374, 1.004902, 0.983607];
const expIncCdf = [1.096368, 1.014497, 0.988428, 0.983607, 1.0];
r.incurredPattern.forEach((v, i) => check(`f^I[${i}]  Dev${i+1}->Dev${i+2}`, v, expIncLdf[i]));
r.incurredCdfs.forEach((v, i) => check(`CDF^I[Dev${i+1}]`, v, expIncCdf[i]));

// Section E/F — q̄ and q̄* per column
console.log('\nColumn means q̄ (P/I) and q̄* (I/P)');
const expQbar  = [0.586207, 0.669643, 0.770878, 0.861789, 0.933333];
const expQsbar = [1.705882, 1.493333, 1.297222, 1.160377, 1.071429];
r.qBar.forEach((v, i) => check(`q̄ [Dev${i+1}]`, v, expQbar[i]));
r.qStarBar.forEach((v, i) => check(`q̄*[Dev${i+1}]`, v, expQsbar[i]));

// Section G — sigmas
console.log('\nColumn standard deviations');
const expSP  = [0.51131, 0.447774, 0.186253, null];   // c=3 only has 1 obs => null
const expSI  = [0.438059, 0.374645, 0.902485, null];
const expSQ  = [1.217403, 1.148099, 0.282639, 0.725721, null];
const expSQs = [2.723024, 2.071787, 0.417087, 0.90726, null];
r.sigmaP.forEach((v, i) => check(`σ^P [c=${i}]`, v, expSP[i]));
r.sigmaI.forEach((v, i) => check(`σ^I [c=${i}]`, v, expSI[i]));
r.sigmaQ.forEach((v, i) => check(`σ^Q [c=${i}]`, v, expSQ[i]));
r.sigmaQStar.forEach((v, i) => check(`σ^Q* [c=${i}]`, v, expSQs[i]));

// Section I — lambda_P and lambda_I
console.log('\nMunich correlation parameters');
check('λ_P (paid)',     r.lambdaP,  0.603323);
check('λ_I (incurred)', r.lambdaI, -0.220216);

// Section — Summary table per AY
console.log('\nSummary: CL vs MCL Ultimates per AY (paid & incurred)');
console.log('  Year  Latest P    Latest I       CL Ult P       CL Ult I      MCL Ult P     MCL Ult I');
const expSummary = {
  2018: { latestP: 2800, latestI: 3000, clUltP: 2800.000000, clUltI: 3000.000000, mclUltP: 2800.000000, mclUltI: 3000.000000 },
  2019: { latestP: 2700, latestI: 3100, clUltP: 2907.692308, clUltI: 3049.180328, mclUltP: 2907.692308, mclUltI: 3049.180328 },
  2020: { latestP: 2500, latestI: 3220, clUltP: 3036.006547, clUltI: 3182.738669, mclUltP: 3029.317160, mclUltI: 3170.446153 },
  2021: { latestP: 2250, latestI: 3220, clUltP: 3278.887070, clUltI: 3266.679030, mclUltP: 3204.308576, mclUltI: 3163.712315 },
  2022: { latestP: 1900, latestI: 3100, clUltP: 3461.047463, clUltI: 3398.741569, mclUltP: 3345.914585, mclUltI: 3266.962047 },
};

// Recreate CL ultimates by walking the CL patterns from latest dev
function clUlt(triangle, pattern, r) {
  let lastCol = -1, val = 0;
  for (let c = triangle[r].length - 1; c >= 0; c--) {
    if (triangle[r][c] != null) { lastCol = c; val = triangle[r][c]; break; }
  }
  for (let c = lastCol; c < pattern.length; c++) val *= pattern[c];
  return val;
}

for (let i = 0; i < r.projections.length; i++) {
  const p = r.projections[i];
  const e = expSummary[p.year];
  const clP = clUlt(paid, r.paidPattern, i);
  const clI = clUlt(incurred, r.incurredPattern, i);

  const row = [
    p.year,
    p.latestPaid, p.latestIncurred,
    clP, clI,
    p.ultimatePaid, p.ultimateIncurred,
  ];
  console.log(`  ${row.map((v, idx) => idx === 0 ? String(v).padEnd(6) : fmt(v).padStart(13)).join(' ')}`);
  const checks = [
    ['latestP', p.latestPaid, e.latestP],
    ['latestI', p.latestIncurred, e.latestI],
    ['clUltP',  clP, e.clUltP],
    ['clUltI',  clI, e.clUltI],
    ['mclUltP', p.ultimatePaid,    e.mclUltP],
    ['mclUltI', p.ultimateIncurred, e.mclUltI],
  ];
  for (const [name, c, x] of checks) {
    if (Math.abs(c - x) > TOL) { pass = false; console.log(`     FAIL ${name}: ${c} vs ${x}`); }
  }
}

// Cell-by-cell step verification for the trickiest path: 2022 (4 projection steps)
console.log('\n2022 projection path (P, I per step) vs Excel');
const expPaid2022 = [1900, 2359.006456, 2807.445362, 3106.920686, 3345.914585];
const expInc2022  = [3100, 3343.617597, 3423.179315, 3321.411415, 3266.962047];
const proj2022 = r.projections[4];
proj2022.paidPath.forEach((v, i)     => check(`P  2022 step${i}`, v, expPaid2022[i]));
proj2022.incurredPath.forEach((v, i) => check(`I  2022 step${i}`, v, expInc2022[i]));

console.log(`\nWarnings: ${r.warnings.length}`);
r.warnings.forEach(w => console.log(`  - ${w}`));
console.log(`\nOverall: ${pass ? 'ALL MCL VALUES MATCH EXCEL SOLVED SHEET' : 'MISMATCH'}`);
process.exit(pass ? 0 : 1);
