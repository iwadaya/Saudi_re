/**
 * Munich Chain Ladder (Quarg & Mack, 2004).
 *
 * A refinement of the standard chain-ladder method that uses the
 * correlation between paid/incurred ratios and link ratios to bring
 * the paid-only and incurred-only ultimate estimates closer together.
 * Useful when the gap between paid and incurred chain-ladder
 * ultimates is large and persistent — classical CL ignores the
 * information in P/I and I/P ratios, so it tends to keep the two
 * projections diverging.
 *
 * Inputs: two same-shape upper triangles, paid (P) and incurred (I).
 * Cells in the lower triangle are null. Each row represents an origin
 * year; each column a development period.
 *
 * Outputs include the standard chain-ladder LDFs/CDFs for each
 * triangle (computed as a side-effect, since MCL builds on top of
 * them), the two correlation parameters λ_P and λ_I, and the
 * row-by-row MCL projections to ultimate. Because MCL adjusts each
 * link ratio cell-by-cell using the current P/I ratio, projections
 * vary by origin year — there is no single "MCL pattern" to display
 * across the triangle.
 */

/** Σ w_i · (x_i − μ)² / (n−1) — Pearson dispersion estimator. */
function weightedVariance(values, weights, mean) {
  if (mean == null) return null;
  let num = 0, n = 0;
  for (let i = 0; i < values.length; i++) {
    if (!Number.isFinite(values[i]) || !Number.isFinite(weights[i])) continue;
    num += weights[i] * (values[i] - mean) * (values[i] - mean);
    n++;
  }
  if (n <= 1) return null;
  return num / (n - 1);
}

/** Standard volume-weighted chain-ladder LDF pattern for an upper triangle. */
function chainLadderPattern(matrix) {
  const W = matrix[0]?.length || 0;
  const pattern = [];
  for (let c = 0; c < W - 1; c++) {
    let prev = 0, curr = 0;
    for (let r = 0; r < matrix.length; r++) {
      const a = matrix[r][c], b = matrix[r][c + 1];
      if (a == null || b == null) continue;
      prev += a;
      curr += b;
    }
    pattern.push(prev > 0 ? curr / prev : 1.0);
  }
  return pattern;
}

function cdfsFromPattern(pattern) {
  const cdfs = new Array(pattern.length + 1).fill(1.0);
  for (let i = pattern.length - 1; i >= 0; i--) cdfs[i] = pattern[i] * cdfs[i + 1];
  return cdfs;
}

/**
 * Munich Chain Ladder.
 *
 * @param {Object}     opts
 * @param {number[][]} opts.paid         upper-triangle paid matrix (nulls past diag)
 * @param {number[][]} opts.incurred     upper-triangle incurred matrix
 * @param {(number|string)[]=} opts.years per-row labels (passed through to projections)
 *
 * @returns {{
 *   paidPattern: number[],
 *   paidCdfs: number[],
 *   incurredPattern: number[],
 *   incurredCdfs: number[],
 *   lambdaP: number|null,
 *   lambdaI: number|null,
 *   qBar: number[],            // weighted mean of P/I per column
 *   qStarBar: number[],         // weighted mean of I/P per column
 *   sigmaP: (number|null)[],
 *   sigmaI: (number|null)[],
 *   sigmaQ: (number|null)[],
 *   sigmaQStar: (number|null)[],
 *   projections: Array<{
 *     year: number|string,
 *     latestPaid: number, latestIncurred: number,
 *     ultimatePaid: number, ultimateIncurred: number,
 *     ibnrPaid: number, ibnrIncurred: number,
 *     paidPath: number[], incurredPath: number[],
 *   }>,
 *   warnings: string[],
 * }}
 */
export function calculateMunichChainLadder({ paid, incurred, years }) {
  if (!Array.isArray(paid) || !Array.isArray(incurred)) {
    return null;
  }
  const R = Math.min(paid.length, incurred.length);
  const C = Math.min(paid[0]?.length || 0, incurred[0]?.length || 0);
  if (!R || !C) return null;

  const warnings = [];

  const paidPattern = chainLadderPattern(paid);
  const incurredPattern = chainLadderPattern(incurred);
  const paidCdfs = cdfsFromPattern(paidPattern);
  const incurredCdfs = cdfsFromPattern(incurredPattern);

  // Per-column averages for Q = P/I and Q* = I/P, weighted by the
  // denominator's volume (so they reduce to ΣP/ΣI and ΣI/ΣP).
  const qBar = new Array(C).fill(null);       // P/I means
  const qStarBar = new Array(C).fill(null);   // I/P means
  for (let c = 0; c < C; c++) {
    let sumP = 0, sumI = 0;
    for (let r = 0; r < R; r++) {
      const p = paid[r]?.[c], inc = incurred[r]?.[c];
      if (p == null || inc == null || inc === 0 || p === 0) continue;
      sumP += p; sumI += inc;
    }
    qBar[c] = sumI > 0 ? sumP / sumI : null;
    qStarBar[c] = sumP > 0 ? sumI / sumP : null;
  }

  // Pearson sigma estimates per column. For link ratios we use the
  // canonical Mack form σ²_j = Σ w_i · (f_i,j − f_j)² / (n−1) with
  // weights = the column-j denominator. For Q / Q* ratios the weight
  // is the denominator of the ratio (I or P respectively).
  const sigmaP = new Array(C - 1).fill(null);
  const sigmaI = new Array(C - 1).fill(null);
  const sigmaQ = new Array(C).fill(null);
  const sigmaQStar = new Array(C).fill(null);

  for (let c = 0; c < C - 1; c++) {
    const fpVals = [], fpW = [], fiVals = [], fiW = [];
    for (let r = 0; r < R; r++) {
      const p0 = paid[r]?.[c], p1 = paid[r]?.[c + 1];
      const i0 = incurred[r]?.[c], i1 = incurred[r]?.[c + 1];
      if (p0 != null && p1 != null && p0 !== 0) { fpVals.push(p1 / p0); fpW.push(p0); }
      if (i0 != null && i1 != null && i0 !== 0) { fiVals.push(i1 / i0); fiW.push(i0); }
    }
    const fp = paidPattern[c], fi = incurredPattern[c];
    sigmaP[c] = weightedVariance(fpVals, fpW, fp);
    sigmaI[c] = weightedVariance(fiVals, fiW, fi);
    sigmaP[c] = sigmaP[c] != null ? Math.sqrt(sigmaP[c]) : null;
    sigmaI[c] = sigmaI[c] != null ? Math.sqrt(sigmaI[c]) : null;
  }

  for (let c = 0; c < C; c++) {
    const qVals = [], qW = [], qsVals = [], qsW = [];
    for (let r = 0; r < R; r++) {
      const p = paid[r]?.[c], i = incurred[r]?.[c];
      if (p == null || i == null || p === 0 || i === 0) continue;
      qVals.push(p / i);  qW.push(i);
      qsVals.push(i / p); qsW.push(p);
    }
    const v1 = weightedVariance(qVals, qW, qBar[c]);
    const v2 = weightedVariance(qsVals, qsW, qStarBar[c]);
    sigmaQ[c] = v1 != null ? Math.sqrt(v1) : null;
    sigmaQStar[c] = v2 != null ? Math.sqrt(v2) : null;
  }

  // Pearson residuals + correlation slopes λ_P and λ_I.
  // For paid link factors at (i, c) we pair the residual of f^P with
  // the residual of Q*_{i,c} (incurred-to-paid) at the same cell;
  // mirror for incurred ↔ Q.
  let numP = 0, denP = 0;
  let numI = 0, denI = 0;

  for (let c = 0; c < C - 1; c++) {
    for (let r = 0; r < R; r++) {
      const p0 = paid[r]?.[c], p1 = paid[r]?.[c + 1];
      const i0 = incurred[r]?.[c], i1 = incurred[r]?.[c + 1];
      if (p0 == null || p1 == null || i0 == null || i1 == null || p0 === 0 || i0 === 0) continue;

      const fpRes = sigmaP[c] ? (p1 / p0 - paidPattern[c]) * Math.sqrt(p0) / sigmaP[c] : null;
      const fiRes = sigmaI[c] ? (i1 / i0 - incurredPattern[c]) * Math.sqrt(i0) / sigmaI[c] : null;
      const qRes  = sigmaQ[c] && qBar[c] != null
        ? (p0 / i0 - qBar[c]) * Math.sqrt(i0) / sigmaQ[c] : null;
      const qsRes = sigmaQStar[c] && qStarBar[c] != null
        ? (i0 / p0 - qStarBar[c]) * Math.sqrt(p0) / sigmaQStar[c] : null;

      if (fpRes != null && qsRes != null) { numP += fpRes * qsRes; denP += qsRes * qsRes; }
      if (fiRes != null && qRes != null)  { numI += fiRes * qRes;  denI += qRes  * qRes;  }
    }
  }

  const lambdaP = denP > 0 ? numP / denP : null;
  const lambdaI = denI > 0 ? numI / denI : null;

  if (lambdaP == null || lambdaI == null) {
    warnings.push('Insufficient residual variance to estimate Munich correlation; falling back to standard chain ladder.');
  }

  // Cell-by-cell forward projection to the rightmost column.
  const projections = [];
  for (let r = 0; r < R; r++) {
    let lastCol = -1;
    for (let c = C - 1; c >= 0; c--) {
      if (paid[r]?.[c] != null && incurred[r]?.[c] != null) { lastCol = c; break; }
    }
    if (lastCol < 0) {
      projections.push({
        year: years?.[r] ?? r,
        latestPaid: 0, latestIncurred: 0,
        ultimatePaid: 0, ultimateIncurred: 0,
        ibnrPaid: 0, ibnrIncurred: 0,
        paidPath: [], incurredPath: [],
      });
      continue;
    }

    const paidPath = [paid[r][lastCol]];
    const incurredPath = [incurred[r][lastCol]];

    let curP = paid[r][lastCol];
    let curI = incurred[r][lastCol];

    for (let c = lastCol; c < C - 1; c++) {
      const fpBase = paidPattern[c] ?? 1.0;
      const fiBase = incurredPattern[c] ?? 1.0;

      // Use the *current* P/I and I/P in the ratio adjustment — that's
      // the Quarg-Mack innovation: each step's link ratio reacts to the
      // up-to-date relationship between paid and incurred.
      const qStarCur = curP > 0 ? curI / curP : null;
      const qCur     = curI > 0 ? curP / curI : null;

      let fpAdj = fpBase;
      if (lambdaP != null && sigmaP[c] != null && sigmaQStar[c] != null
          && qStarCur != null && qStarBar[c] != null && sigmaQStar[c] > 0) {
        fpAdj = fpBase + lambdaP * (sigmaP[c] / sigmaQStar[c]) * (qStarCur - qStarBar[c]);
      }

      let fiAdj = fiBase;
      if (lambdaI != null && sigmaI[c] != null && sigmaQ[c] != null
          && qCur != null && qBar[c] != null && sigmaQ[c] > 0) {
        fiAdj = fiBase + lambdaI * (sigmaI[c] / sigmaQ[c]) * (qCur - qBar[c]);
      }

      // Guard against pathological negative factors when the residual
      // adjustment overshoots — clamp at a tiny positive floor so the
      // path stays monotone with the data sign rather than collapsing.
      if (!Number.isFinite(fpAdj) || fpAdj <= 0) fpAdj = fpBase;
      if (!Number.isFinite(fiAdj) || fiAdj <= 0) fiAdj = fiBase;

      curP = curP * fpAdj;
      curI = curI * fiAdj;
      paidPath.push(curP);
      incurredPath.push(curI);
    }

    projections.push({
      year: years?.[r] ?? r,
      latestPaid: paid[r][lastCol],
      latestIncurred: incurred[r][lastCol],
      ultimatePaid: curP,
      ultimateIncurred: curI,
      ibnrPaid: curP - paid[r][lastCol],
      ibnrIncurred: curI - incurred[r][lastCol],
      paidPath, incurredPath,
    });
  }

  return {
    paidPattern, paidCdfs,
    incurredPattern, incurredCdfs,
    lambdaP, lambdaI,
    qBar, qStarBar,
    sigmaP, sigmaI, sigmaQ, sigmaQStar,
    projections,
    warnings,
  };
}
