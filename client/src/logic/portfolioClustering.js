// client/src/logic/portfolioClustering.js
//
// Unsupervised portfolio-profitability engine. Dependency-free, framework-free
// (so it unit-tests in isolation and could move server-side unchanged). Given one
// feature row per contract — across the whole book including DECLINED / NTU /
// SIGNED — it answers two questions the underwriting team actually asks:
//
//   1. DRIVERS  — of {country, region, treaty type, class of business, balance,
//      ROL}, which ones DETERMINE profitability, and by how much? Categoricals
//      are scored with eta-squared (the correlation ratio: share of UW-margin
//      variance the factor explains); numerics with Pearson correlation plus a
//      top-vs-bottom-decile margin lift. All six are ranked on one scale (0..1
//      "strength") so the dominant drivers are obvious.
//
//   2. SEGMENTS — K-means (k chosen by silhouette) over standardised numeric +
//      one-hot categorical features. MARGIN IS DELIBERATELY EXCLUDED from the
//      clustering features so segments form on structure alone; margin is then
//      OVERLAID to label each cluster (Profitable / Marginal / Loss-making) and
//      to expose its status mix — which doubles as a selection-quality read
//      (are we signing the profitable segments and declining the rest?). A 2-D
//      PCA projection gives coordinates for a scatter.
//
// A "row" is one contract (NP layers are pre-aggregated upstream to contract
// grain). Expected shape:
//   { contractId, country, region, treatyType, cob, kind ('PROP'|'NP'),
//     status, premium, exposure, balance, rol, margin, uwYear }
// `margin`, `balance`, `rol` may be null; the engine imputes structurally.

// ─────────────────────────────────────────────────────────────────────────────
// Small numeric helpers
// ─────────────────────────────────────────────────────────────────────────────

const isNum = (v) => typeof v === 'number' && Number.isFinite(v);

function mean(xs) {
  if (!xs.length) return 0;
  let s = 0;
  for (const x of xs) s += x;
  return s / xs.length;
}

function variance(xs, mu = mean(xs)) {
  if (xs.length < 2) return 0;
  let s = 0;
  for (const x of xs) s += (x - mu) * (x - mu);
  return s / xs.length;
}

function stddev(xs, mu = mean(xs)) {
  return Math.sqrt(variance(xs, mu));
}

function median(xs) {
  const v = xs.filter(isNum).slice().sort((a, b) => a - b);
  if (!v.length) return 0;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
}

function quantile(sortedAsc, q) {
  if (!sortedAsc.length) return 0;
  const pos = (sortedAsc.length - 1) * q;
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  if (lo === hi) return sortedAsc[lo];
  return sortedAsc[lo] + (sortedAsc[hi] - sortedAsc[lo]) * (pos - lo);
}

// ─────────────────────────────────────────────────────────────────────────────
// Driver statistics
// ─────────────────────────────────────────────────────────────────────────────

// Correlation ratio (eta-squared) of a categorical predictor on a numeric
// response: SS_between / SS_total in [0,1]. 0 → the factor explains none of the
// margin spread; 1 → margin is fully determined by which level a contract sits
// in. Levels with < minN observations are pooled into "(thin)" so a singleton
// doesn't manufacture spurious explanatory power.
export function etaSquared(labels, values, { minN = 3 } = {}) {
  const pairs = [];
  for (let i = 0; i < labels.length; i++) {
    if (isNum(values[i]) && labels[i] != null && labels[i] !== '') {
      pairs.push([String(labels[i]), values[i]]);
    }
  }
  if (pairs.length < 2) return { eta2: 0, n: pairs.length, levels: [] };

  const counts = new Map();
  for (const [lab] of pairs) counts.set(lab, (counts.get(lab) || 0) + 1);

  const groups = new Map();
  for (const [lab, val] of pairs) {
    const key = counts.get(lab) >= minN ? lab : '(thin)';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(val);
  }

  const all = pairs.map((p) => p[1]);
  const grand = mean(all);
  let ssBetween = 0;
  let ssTotal = 0;
  for (const v of all) ssTotal += (v - grand) * (v - grand);
  const levels = [];
  for (const [lab, vals] of groups) {
    const mu = mean(vals);
    ssBetween += vals.length * (mu - grand) * (mu - grand);
    levels.push({ label: lab, n: vals.length, meanMargin: mu });
  }
  levels.sort((a, b) => b.meanMargin - a.meanMargin);
  const eta2 = ssTotal > 0 ? ssBetween / ssTotal : 0;
  return { eta2: clamp01(eta2), n: pairs.length, levels };
}

// Pearson correlation between a numeric predictor and the response.
export function pearson(xs, ys) {
  const px = [];
  const py = [];
  for (let i = 0; i < xs.length; i++) {
    if (isNum(xs[i]) && isNum(ys[i])) {
      px.push(xs[i]);
      py.push(ys[i]);
    }
  }
  if (px.length < 3) return { r: 0, n: px.length };
  const mx = mean(px);
  const my = mean(py);
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < px.length; i++) {
    const a = px[i] - mx;
    const b = py[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  const den = Math.sqrt(dx * dy);
  return { r: den > 0 ? num / den : 0, n: px.length };
}

// Mean response in the top decile of the predictor minus the bottom decile —
// a robust, units-preserving read of "how much does moving this lever move
// margin?" that complements the (linear) correlation.
export function decileLift(xs, ys) {
  const pairs = [];
  for (let i = 0; i < xs.length; i++) {
    if (isNum(xs[i]) && isNum(ys[i])) pairs.push([xs[i], ys[i]]);
  }
  if (pairs.length < 10) return { lift: 0, topMargin: null, bottomMargin: null, n: pairs.length };
  const sortedX = pairs.map((p) => p[0]).slice().sort((a, b) => a - b);
  const loCut = quantile(sortedX, 0.1);
  const hiCut = quantile(sortedX, 0.9);
  const lo = pairs.filter((p) => p[0] <= loCut).map((p) => p[1]);
  const hi = pairs.filter((p) => p[0] >= hiCut).map((p) => p[1]);
  const topMargin = hi.length ? mean(hi) : null;
  const bottomMargin = lo.length ? mean(lo) : null;
  return {
    lift: topMargin != null && bottomMargin != null ? topMargin - bottomMargin : 0,
    topMargin,
    bottomMargin,
    n: pairs.length,
  };
}

function clamp01(x) {
  if (!isNum(x)) return 0;
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

// Rank the six requested components on a common 0..1 "strength" scale.
// Categoricals contribute eta2 directly; numerics map |r| (already 0..1).
// `strength` is what the UI sorts/bars on; the richer per-driver detail
// (level means, lift, sign) rides alongside for drill-down.
export function rankDrivers(rows, { numericKeys, categoricalKeys } = {}) {
  numericKeys = numericKeys || ['balance', 'rol'];
  categoricalKeys = categoricalKeys || ['country', 'region', 'treatyType', 'cob'];
  const margins = rows.map((r) => r.margin);

  const drivers = [];

  for (const key of categoricalKeys) {
    const { eta2, n, levels } = etaSquared(rows.map((r) => r[key]), margins);
    drivers.push({
      key,
      kind: 'categorical',
      strength: eta2,
      eta2,
      n,
      topLevels: levels.slice(0, 6),
      bottomLevels: levels.slice(-6).reverse(),
    });
  }

  for (const key of numericKeys) {
    const xs = rows.map((r) => r[key]);
    const { r, n } = pearson(xs, margins);
    const { lift, topMargin, bottomMargin } = decileLift(xs, margins);
    drivers.push({
      key,
      kind: 'numeric',
      strength: Math.abs(r),
      r,
      lift,
      topMargin,
      bottomMargin,
      n,
    });
  }

  drivers.sort((a, b) => b.strength - a.strength);
  return drivers;
}

// ─────────────────────────────────────────────────────────────────────────────
// Feature matrix: standardised numerics + weighted one-hot categoricals.
// Margin is NOT a feature here — segmentation is unsupervised w.r.t. profit.
// ─────────────────────────────────────────────────────────────────────────────

// Reduce a categorical column to its top-K levels (by frequency); everything
// else collapses to "Other" so a high-cardinality field (country) can't blow
// the matrix up into hundreds of near-empty columns.
function topLevels(values, k) {
  const counts = new Map();
  for (const v of values) {
    if (v == null || v === '') continue;
    const s = String(v);
    counts.set(s, (counts.get(s) || 0) + 1);
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  return new Set(sorted.slice(0, k).map((e) => e[0]));
}

export function buildFeatureMatrix(rows, opts = {}) {
  const {
    numericKeys = ['logPremium', 'balance', 'rol', 'uwYear'],
    categoricalKeys = ['region', 'treatyType', 'cob', 'country', 'kind'],
    countryTopK = 12,
    cobTopK = 12,
    categoricalWeight = 0.6, // damp one-hot blocks so they don't dominate distance
  } = opts;

  const n = rows.length;
  const columns = [];
  const matrix = Array.from({ length: n }, () => []);

  // Derived numeric: log premium (premium is heavy-tailed).
  const derived = rows.map((r) => ({
    ...r,
    logPremium: isNum(r.premium) && r.premium > 0 ? Math.log10(r.premium) : null,
  }));

  // ── Numerics: median-impute (structural missingness for balance/rol), then
  //    z-score. A per-column "missing" indicator preserves the prop/NP split
  //    that the imputation would otherwise erase. ──
  for (const key of numericKeys) {
    const raw = derived.map((r) => r[key]);
    const med = median(raw);
    const filled = raw.map((v) => (isNum(v) ? v : med));
    const mu = mean(filled);
    const sd = stddev(filled, mu) || 1;
    const colIdx = columns.length;
    columns.push({ name: key, type: 'numeric' });
    for (let i = 0; i < n; i++) matrix[i][colIdx] = (filled[i] - mu) / sd;

    const anyMissing = raw.some((v) => !isNum(v));
    if (anyMissing) {
      const mIdx = columns.length;
      columns.push({ name: `${key}__missing`, type: 'indicator' });
      for (let i = 0; i < n; i++) matrix[i][mIdx] = isNum(raw[i]) ? 0 : 1;
    }
  }

  // ── Categoricals: one-hot, top-K capped, each block scaled by
  //    categoricalWeight / sqrt(#levels) so a wide block and a narrow block
  //    contribute comparable distance mass. ──
  for (const key of categoricalKeys) {
    const values = derived.map((r) => r[key]);
    const capK = key === 'country' ? countryTopK : key === 'cob' ? cobTopK : 64;
    const keep = topLevels(values, capK);
    const levels = [...keep].sort();
    const hasOther = values.some((v) => v != null && v !== '' && !keep.has(String(v)));
    if (hasOther) levels.push('Other');
    if (!levels.length) continue;
    const w = categoricalWeight / Math.sqrt(levels.length);
    for (const lvl of levels) {
      const colIdx = columns.length;
      columns.push({ name: `${key}=${lvl}`, type: 'onehot' });
      for (let i = 0; i < n; i++) {
        const v = values[i];
        const s = v == null || v === '' ? null : String(v);
        const hit = s != null && (s === lvl || (lvl === 'Other' && !keep.has(s)));
        matrix[i][colIdx] = hit ? w : 0;
      }
    }
  }

  return { matrix, columns };
}

// ─────────────────────────────────────────────────────────────────────────────
// K-means (++ init, Lloyd iterations, best-of-restarts) + silhouette + PCA
// ─────────────────────────────────────────────────────────────────────────────

function dist2(a, b) {
  let s = 0;
  for (let i = 0; i < a.length; i++) {
    const d = a[i] - b[i];
    s += d * d;
  }
  return s;
}

// Deterministic PRNG (mulberry32) so clustering is reproducible run-to-run.
function rng(seed) {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

export function kmeansPlusPlusInit(X, k, rand) {
  const n = X.length;
  const centers = [];
  centers.push(X[Math.floor(rand() * n)].slice());
  const d2 = new Array(n).fill(Infinity);
  while (centers.length < k) {
    let total = 0;
    for (let i = 0; i < n; i++) {
      const last = centers[centers.length - 1];
      const dd = dist2(X[i], last);
      if (dd < d2[i]) d2[i] = dd;
      total += d2[i];
    }
    if (total === 0) {
      centers.push(X[Math.floor(rand() * n)].slice());
      continue;
    }
    let target = rand() * total;
    let idx = 0;
    for (let i = 0; i < n; i++) {
      target -= d2[i];
      if (target <= 0) {
        idx = i;
        break;
      }
    }
    centers.push(X[idx].slice());
  }
  return centers;
}

export function kmeans(X, k, { restarts = 4, maxIter = 80, seed = 42 } = {}) {
  const n = X.length;
  const dim = n ? X[0].length : 0;
  if (n === 0 || k <= 1 || k >= n) {
    return { assignments: new Array(n).fill(0), centers: n ? [colMeans(X)] : [], inertia: 0, k: 1 };
  }
  let best = null;
  for (let attempt = 0; attempt < restarts; attempt++) {
    const rand = rng(seed + attempt * 9973);
    const centers = kmeansPlusPlusInit(X, k, rand);
    const assignments = new Array(n).fill(0);
    for (let iter = 0; iter < maxIter; iter++) {
      let moved = false;
      // Assign
      for (let i = 0; i < n; i++) {
        let bestC = 0;
        let bestD = Infinity;
        for (let c = 0; c < centers.length; c++) {
          const d = dist2(X[i], centers[c]);
          if (d < bestD) {
            bestD = d;
            bestC = c;
          }
        }
        if (assignments[i] !== bestC) {
          assignments[i] = bestC;
          moved = true;
        }
      }
      // Update
      const sums = Array.from({ length: k }, () => new Array(dim).fill(0));
      const counts = new Array(k).fill(0);
      for (let i = 0; i < n; i++) {
        const c = assignments[i];
        counts[c]++;
        const row = X[i];
        const acc = sums[c];
        for (let d = 0; d < dim; d++) acc[d] += row[d];
      }
      for (let c = 0; c < k; c++) {
        if (counts[c] === 0) {
          // Re-seed an empty cluster onto the point furthest from its center.
          let far = 0;
          let farD = -1;
          for (let i = 0; i < n; i++) {
            const d = dist2(X[i], centers[assignments[i]]);
            if (d > farD) {
              farD = d;
              far = i;
            }
          }
          centers[c] = X[far].slice();
        } else {
          for (let d = 0; d < dim; d++) centers[c][d] = sums[c][d] / counts[c];
        }
      }
      if (!moved && iter > 0) break;
    }
    let inertia = 0;
    for (let i = 0; i < n; i++) inertia += dist2(X[i], centers[assignments[i]]);
    if (!best || inertia < best.inertia) best = { assignments: assignments.slice(), centers: centers.map((c) => c.slice()), inertia, k };
  }
  return best;
}

function colMeans(X) {
  const dim = X[0].length;
  const m = new Array(dim).fill(0);
  for (const row of X) for (let d = 0; d < dim; d++) m[d] += row[d];
  for (let d = 0; d < dim; d++) m[d] /= X.length;
  return m;
}

// Mean silhouette over a (sampled, for cost) set of points. Range [-1,1];
// higher means tighter, better-separated clusters. Used only to choose k.
export function silhouette(X, assignments, k, { sampleSize = 600, seed = 7 } = {}) {
  const n = X.length;
  if (n < 3 || k < 2) return 0;
  const rand = rng(seed);
  const idx = [];
  if (n <= sampleSize) {
    for (let i = 0; i < n; i++) idx.push(i);
  } else {
    const seen = new Set();
    while (idx.length < sampleSize) {
      const j = Math.floor(rand() * n);
      if (!seen.has(j)) {
        seen.add(j);
        idx.push(j);
      }
    }
  }
  const byCluster = Array.from({ length: k }, () => []);
  for (let i = 0; i < n; i++) byCluster[assignments[i]].push(i);

  let total = 0;
  let count = 0;
  for (const i of idx) {
    const ci = assignments[i];
    if (byCluster[ci].length <= 1) continue;
    let a = 0;
    for (const j of byCluster[ci]) if (j !== i) a += Math.sqrt(dist2(X[i], X[j]));
    a /= byCluster[ci].length - 1;
    let b = Infinity;
    for (let c = 0; c < k; c++) {
      if (c === ci || byCluster[c].length === 0) continue;
      let d = 0;
      for (const j of byCluster[c]) d += Math.sqrt(dist2(X[i], X[j]));
      d /= byCluster[c].length;
      if (d < b) b = d;
    }
    if (!Number.isFinite(b)) continue;
    const s = (b - a) / Math.max(a, b);
    total += s;
    count++;
  }
  return count ? total / count : 0;
}

// Choose k by silhouette, but with a parsimony tie-break: among all k the
// pick is the SMALLEST whose silhouette is within `tol` of the best. One-hot
// categoricals (country × COB × year) form tight micro-blobs, so raw
// silhouette-max tends to over-segment; for an underwriting read a few
// interpretable segments beat many micro-segments, and the tolerance keeps the
// coarser solution whenever it's near-as-good.
export function chooseK(X, { kMin = 2, kMax = 6, tol = 0.03, seed = 42 } = {}) {
  const n = X.length;
  const hiK = Math.min(kMax, Math.max(kMin, n - 1));
  const trials = [];
  for (let k = kMin; k <= hiK; k++) {
    if (k >= n) break;
    const km = kmeans(X, k, { seed });
    const sil = silhouette(X, km.assignments, k, { seed: seed + 1 });
    trials.push({ k, sil, km });
  }
  if (!trials.length) return { k: 1, sil: 0, km: kmeans(X, 1) };
  const bestSil = Math.max(...trials.map((t) => t.sil));
  const chosen = trials.find((t) => t.sil >= bestSil - tol) || trials[0];
  return chosen;
}

// Top-2 principal components via Jacobi eigen-decomposition of the covariance
// matrix. Dimensionality here is small (a few dozen columns), so the O(d^3)
// Jacobi sweep is cheap and avoids a linear-algebra dependency.
export function pca2(X) {
  const n = X.length;
  if (n === 0) return { coords: [], explained: [0, 0] };
  const dim = X[0].length;
  const mu = colMeans(X);
  const C = Array.from({ length: dim }, () => new Array(dim).fill(0));
  for (const row of X) {
    for (let a = 0; a < dim; a++) {
      const da = row[a] - mu[a];
      for (let b = a; b < dim; b++) {
        C[a][b] += da * (row[b] - mu[b]);
      }
    }
  }
  for (let a = 0; a < dim; a++) {
    for (let b = a; b < dim; b++) {
      C[a][b] /= n;
      C[b][a] = C[a][b];
    }
  }
  const { values, vectors } = jacobiEigen(C);
  const order = values.map((v, i) => [v, i]).sort((p, q) => q[0] - p[0]);
  const i1 = order[0] ? order[0][1] : 0;
  const i2 = order[1] ? order[1][1] : Math.min(1, dim - 1);
  const totalVar = values.reduce((s, v) => s + Math.max(v, 0), 0) || 1;
  const coords = X.map((row) => {
    let x = 0;
    let y = 0;
    for (let d = 0; d < dim; d++) {
      const centered = row[d] - mu[d];
      x += centered * vectors[d][i1];
      y += centered * vectors[d][i2];
    }
    return [x, y];
  });
  return {
    coords,
    explained: [Math.max(values[i1], 0) / totalVar, Math.max(values[i2], 0) / totalVar],
  };
}

function jacobiEigen(Ain, { maxSweeps = 60, tol = 1e-9 } = {}) {
  const n = Ain.length;
  const A = Ain.map((r) => r.slice());
  const V = Array.from({ length: n }, (_, i) => {
    const r = new Array(n).fill(0);
    r[i] = 1;
    return r;
  });
  for (let sweep = 0; sweep < maxSweeps; sweep++) {
    let off = 0;
    for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p][q] * A[p][q];
    if (off < tol) break;
    for (let p = 0; p < n; p++) {
      for (let q = p + 1; q < n; q++) {
        if (Math.abs(A[p][q]) < 1e-14) continue;
        const phi = 0.5 * Math.atan2(2 * A[p][q], A[q][q] - A[p][p]);
        const c = Math.cos(phi);
        const s = Math.sin(phi);
        for (let i = 0; i < n; i++) {
          const aip = A[i][p];
          const aiq = A[i][q];
          A[i][p] = c * aip - s * aiq;
          A[i][q] = s * aip + c * aiq;
        }
        for (let i = 0; i < n; i++) {
          const api = A[p][i];
          const aqi = A[q][i];
          A[p][i] = c * api - s * aqi;
          A[q][i] = s * api + c * aqi;
        }
        for (let i = 0; i < n; i++) {
          const vip = V[i][p];
          const viq = V[i][q];
          V[i][p] = c * vip - s * viq;
          V[i][q] = s * vip + c * viq;
        }
      }
    }
  }
  const values = A.map((_, i) => A[i][i]);
  return { values, vectors: V };
}

// ─────────────────────────────────────────────────────────────────────────────
// Cluster profiling
// ─────────────────────────────────────────────────────────────────────────────

function modeLabel(values) {
  const counts = new Map();
  for (const v of values) {
    if (v == null || v === '') continue;
    const s = String(v);
    counts.set(s, (counts.get(s) || 0) + 1);
  }
  let bestLabel = '—';
  let bestN = 0;
  for (const [lab, c] of counts) {
    if (c > bestN) {
      bestN = c;
      bestLabel = lab;
    }
  }
  return { label: bestLabel, share: values.length ? bestN / values.length : 0 };
}

function premiumWeightedMargin(members) {
  let wm = 0;
  let w = 0;
  for (const r of members) {
    if (isNum(r.margin) && isNum(r.premium) && r.premium > 0) {
      wm += r.margin * r.premium;
      w += r.premium;
    }
  }
  if (w > 0) return wm / w;
  const plain = members.map((r) => r.margin).filter(isNum);
  return plain.length ? mean(plain) : null;
}

export function profileClusters(rows, assignments, k, coords) {
  const clusters = [];
  for (let c = 0; c < k; c++) {
    const members = [];
    const memberCoords = [];
    for (let i = 0; i < rows.length; i++) {
      if (assignments[i] === c) {
        members.push(rows[i]);
        if (coords) memberCoords.push(coords[i]);
      }
    }
    if (!members.length) continue;

    const statusMix = {};
    for (const r of members) {
      const s = r.status || 'UNKNOWN';
      statusMix[s] = (statusMix[s] || 0) + 1;
    }

    clusters.push({
      cluster: c,
      size: members.length,
      premium: members.reduce((s, r) => s + (isNum(r.premium) ? r.premium : 0), 0),
      avgMargin: premiumWeightedMargin(members),
      avgRol: mean(members.map((r) => r.rol).filter(isNum)),
      avgBalance: mean(members.map((r) => r.balance).filter(isNum)),
      dominantCountry: modeLabel(members.map((r) => r.country)),
      dominantRegion: modeLabel(members.map((r) => r.region)),
      dominantTreatyType: modeLabel(members.map((r) => r.treatyType)),
      dominantCob: modeLabel(members.map((r) => r.cob)),
      statusMix,
      centroid: memberCoords.length
        ? [mean(memberCoords.map((p) => p[0])), mean(memberCoords.map((p) => p[1]))]
        : [0, 0],
    });
  }

  // Label by margin tertile across clusters so the wording is relative to THIS
  // book, not an absolute threshold.
  const withMargin = clusters.filter((c) => isNum(c.avgMargin)).map((c) => c.avgMargin).sort((a, b) => a - b);
  const loCut = quantile(withMargin, 1 / 3);
  const hiCut = quantile(withMargin, 2 / 3);
  for (const c of clusters) {
    if (!isNum(c.avgMargin)) c.profitLabel = 'Unscored';
    else if (c.avgMargin >= hiCut) c.profitLabel = 'Profitable';
    else if (c.avgMargin <= loCut) c.profitLabel = 'Loss-making';
    else c.profitLabel = 'Marginal';
  }
  clusters.sort((a, b) => (b.avgMargin ?? -Infinity) - (a.avgMargin ?? -Infinity));
  return clusters;
}

// ─────────────────────────────────────────────────────────────────────────────
// Top-level entry
// ─────────────────────────────────────────────────────────────────────────────

export function analyzePortfolio(rows, opts = {}) {
  const clean = Array.isArray(rows) ? rows.filter((r) => r && typeof r === 'object') : [];
  const meta = {
    nContracts: clean.length,
    nScored: clean.filter((r) => isNum(r.margin)).length,
    generatedAt: new Date().toISOString(),
    statusMix: {},
  };
  for (const r of clean) {
    const s = r.status || 'UNKNOWN';
    meta.statusMix[s] = (meta.statusMix[s] || 0) + 1;
  }

  if (clean.length < 6) {
    return { ok: false, reason: 'INSUFFICIENT_DATA', meta, drivers: [], clusters: [], projection: { coords: [], explained: [0, 0] } };
  }

  const drivers = rankDrivers(clean, opts);
  const { matrix } = buildFeatureMatrix(clean, opts);
  const { k, sil, km } = chooseK(matrix, opts);
  const { coords, explained } = pca2(matrix);
  const clusters = profileClusters(clean, km.assignments, k, coords);

  return {
    ok: true,
    meta,
    drivers,
    clusters,
    k,
    silhouette: sil,
    assignments: km.assignments,
    projection: { coords, explained },
  };
}

export default analyzePortfolio;
