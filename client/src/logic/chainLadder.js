/* Chain Ladder actuarial calculations */

export function buildMatrixFromCells(cells, startYear, numYears) {
  if (!Array.isArray(cells) || !cells.length) return null;

  // Auto-detect from cells if startYear/numYears not provided
  if (startYear == null || numYears == null) {
    const yearsSet = new Set(), devsSet = new Set();
    cells.forEach(c => { yearsSet.add(Number(c.origin_year)); devsSet.add(Number(c.dev_months)); });
    const years = Array.from(yearsSet).sort((a, b) => a - b);
    const devPeriods = Array.from(devsSet).sort((a, b) => a - b);
    const matrix = years.map(() => new Array(devPeriods.length).fill(null));
    cells.forEach(c => {
      const r = years.indexOf(Number(c.origin_year));
      const col = devPeriods.indexOf(Number(c.dev_months));
      if (r >= 0 && col >= 0) matrix[r][col] = c.cum_value == null ? null : Number(c.cum_value) || 0;
    });
    return { matrix, years, devPeriods };
  }

  const years = Array.from({ length: numYears }, (_, i) => startYear + i);
  const devPeriods = Array.from({ length: numYears }, (_, i) => (i + 1) * 12);
  const matrix = years.map(() => new Array(devPeriods.length).fill(null));
  cells.forEach(c => {
    const r = years.indexOf(c.origin_year);
    const col = devPeriods.indexOf(c.dev_months);
    if (r >= 0 && col >= 0) matrix[r][col] = c.cum_value == null ? null : Number(c.cum_value) || 0;
  });
  return { matrix, years, devPeriods };
}

export function calculateAgeToAgeFactors(matrix) {
  return matrix.map(row => {
    const factors = [];
    for (let c = 0; c < row.length - 1; c++) {
      const cur = row[c], next = row[c + 1];
      factors.push(cur != null && next != null && cur !== 0 ? next / cur : null);
    }
    return factors;
  });
}

/**
 * Compute the age-to-age LDF pattern from a triangle matrix +
 * pre-computed cell-level factors.
 *
 * Returns the pattern (array of LDFs, length = width - 1) plus a
 * warnings list calling out columns where fewer than 3 origin years
 * contributed. Such columns produce volatile LDFs — the underwriter
 * should be told before relying on them.
 *
 * The pattern array is also exposed directly on the return value so
 * callers can keep a one-line `const { pattern } = calculatePattern(...)`
 * if they don't care about warnings.
 *
 * @returns {{ pattern:number[], warnings:Array<{column:number, devPeriod:string, contributingRows:number, message:string}> }}
 */
export function calculatePattern(matrix, factors, method = 'weighted', { excluded } = {}) {
  const width = matrix[0]?.length || 0;
  const pattern = [];
  const warnings = [];
  const isExcluded = excluded ? (r, c) => excluded.has(`${r}:${c}`) : () => false;
  for (let c = 0; c < width - 1; c++) {
    const validRows = [];
    for (let r = 0; r < matrix.length; r++) if (factors[r]?.[c] !== null && !isExcluded(r, c)) validRows.push(r);
    let rowsToUse = validRows;
    if (method === 'last3') rowsToUse = validRows.slice(-3);
    if (method === 'last5') rowsToUse = validRows.slice(-5);
    let ldf = 1.0;
    if (method === 'weighted') {
      let sumPrev = 0, sumCur = 0;
      for (const r of rowsToUse) { sumPrev += matrix[r][c] || 0; sumCur += matrix[r][c + 1] || 0; }
      ldf = sumPrev !== 0 ? sumCur / sumPrev : 1.0;
    } else {
      let sum = 0, cnt = 0;
      for (const r of rowsToUse) { sum += factors[r][c]; cnt++; }
      ldf = cnt > 0 ? sum / cnt : 1.0;
    }
    pattern.push(ldf);

    // Flag thin columns. Fewer than 3 contributing rows means the LDF
    // is one or two observations — too noisy to rely on without a
    // judgement call from the actuary.
    if (rowsToUse.length < 3) {
      warnings.push({
        column: c,
        devPeriod: `${(c + 1) * 12}→${(c + 2) * 12}`,
        contributingRows: rowsToUse.length,
        message: `LDF for ${(c + 1) * 12}→${(c + 2) * 12} months derived from only ${rowsToUse.length} origin year(s); minimum recommended is 3.`,
      });
    }
  }
  return { pattern, warnings };
}

/**
 * Build the cumulative-development-factor (CDF) array from a sequence of
 * age-to-age factors and a tail factor.
 *
 *   cdf[i]      = pattern[i] * cdf[i + 1]   (i = N-1 .. 0)
 *   cdf[N]      = tailFactor
 *
 * The array is AGE-indexed: cdf[i] is the factor to ultimate from dev age
 * (i+1)*12 months. cdf[0] = product of ALL LDFs × tail — the LARGEST
 * factor, applied to the LEAST-developed (newest) origin year; cdf[N] =
 * tailFactor, applied to the most-developed (oldest) year.
 *
 * @param {number[]} pattern    age-to-age LDFs (length N)
 * @param {number}   tailFactor factor from the last triangle column to ultimate
 * @returns {number[]}          length N+1, indexed by dev age (see above)
 */
export function calculateCdfs(pattern, tailFactor = 1.0) {
  const cdfs = new Array(pattern.length + 1).fill(1.0);
  cdfs[pattern.length] = tailFactor;
  for (let i = pattern.length - 1; i >= 0; i--) cdfs[i] = pattern[i] * cdfs[i + 1];
  return cdfs;
}

/**
 * Project each origin year on a triangle matrix to ultimate using the
 * CDFs implied by `pattern` + `tailFactor`. Returns both the CDF array
 * and the per-row projection so callers can keep the two together.
 *
 * @param {number[]} pattern    age-to-age LDFs
 * @param {number}   tailFactor factor to ultimate
 * @param {{matrix:number[][], years:(number|string)[]}} dataObj
 * @returns {{cdfs:number[], projections:Array<{year, latest, cdf, ultimate, ibnr}>}}
 */
export function projectToUltimate(pattern, tailFactor, dataObj) {
  const cdfs = calculateCdfs(pattern, tailFactor);
  if (!dataObj || !Array.isArray(dataObj.matrix)) return { cdfs, projections: [] };
  const { matrix, years } = dataObj;
  const projections = (years || []).map((year, r) => {
    let latestVal = 0, latestCol = -1;
    for (let c = (matrix[r]?.length || 0) - 1; c >= 0; c--) {
      if (matrix[r][c] != null) { latestVal = matrix[r][c]; latestCol = c; break; }
    }
    if (latestCol === -1) return { year, latest: 0, cdf: 1, ultimate: 0, ibnr: 0 };
    const cdf = cdfs[latestCol] || 1.0;
    const ultimate = latestVal * cdf;
    return { year, latest: latestVal, cdf, ultimate, ibnr: ultimate - latestVal };
  });
  return { cdfs, projections };
}

export function fitExponentialCdfs(cdfs) {
  const xs = [], ys = [];
  for (let i = 0; i < (cdfs?.length || 0); i++) {
    const v = Number(cdfs[i]);
    if (!Number.isFinite(v) || v <= 1.0000001) continue;
    xs.push(i + 1); ys.push(Math.log(v - 1));
  }
  if (xs.length < 2) return (cdfs || []).slice();
  const n = xs.length;
  let sumX = 0, sumY = 0, sumXX = 0, sumXY = 0;
  for (let i = 0; i < n; i++) { sumX += xs[i]; sumY += ys[i]; sumXX += xs[i] * xs[i]; sumXY += xs[i] * ys[i]; }
  const denom = n * sumXX - sumX * sumX;
  if (Math.abs(denom) < 1e-12) return (cdfs || []).slice();
  const b = (n * sumXY - sumX * sumY) / denom;
  const a = (sumY - b * sumX) / n;
  const out = [];
  for (let i = 0; i < (cdfs?.length || 0); i++) out.push(1 + Math.exp(a + b * (i + 1)));
  if (cdfs?.length && Number(cdfs[cdfs.length - 1]) === 1) out[out.length - 1] = 1;
  return out;
}

export function deriveLdfsFromCdfs(cdfs) {
  const out = [];
  for (let i = 0; i < (cdfs?.length || 0) - 1; i++) {
    const a = Number(cdfs[i]), b = Number(cdfs[i + 1]);
    out.push(Number.isFinite(a) && Number.isFinite(b) && b !== 0 ? a / b : null);
  }
  return out;
}
