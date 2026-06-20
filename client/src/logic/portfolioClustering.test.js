import { describe, it, expect } from 'vitest';
import {
  analyzePortfolio, etaSquared, pearson, decileLift, buildFeatureMatrix,
  kmeans, silhouette, chooseK, pca2, rankDrivers,
} from './portfolioClustering.js';

// Deterministic synthetic book with two latent segments:
//   A) GCC Quota Share, balance-defined  → profitable (margin ~ +0.18)
//   B) Africa Excess of Loss, ROL-defined → margin driven by ROL (high ROL → loss)
function rnd(seed) {
  let t = seed;
  return () => { t += 0x6d2b79f5; let r = Math.imul(t ^ (t >>> 15), 1 | t); r ^= r + Math.imul(r ^ (r >>> 7), 61 | r); return ((r ^ (r >>> 14)) >>> 0) / 4294967296; };
}
function makeBook(n = 240, seed = 123) {
  const R = rnd(seed);
  const gauss = (m, s) => { const u = Math.max(R(), 1e-9), v = R(); return m + s * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); };
  const rows = [];
  for (let i = 0; i < n; i++) {
    if (R() < 0.5) {
      const margin = gauss(0.18, 0.05);
      rows.push({
        contractId: `A${i}`, kind: 'PROP', country: R() < 0.7 ? 'Saudi Arabia' : 'UAE',
        region: 'Middle East', treatyType: 'Quota Share', cob: R() < 0.5 ? 'Property' : 'Engineering',
        status: margin > 0.1 ? 'SIGNED' : (R() < 0.5 ? 'NTU' : 'DECLINED'),
        premium: Math.abs(gauss(4e6, 1.2e6)), exposure: null, balance: gauss(6, 1.5), rol: null,
        margin, uwYear: 2024 + (R() < 0.5 ? 0 : 1),
      });
    } else {
      const rol = Math.abs(gauss(0.32, 0.08));
      const margin = 0.04 - 0.9 * (rol - 0.30) + gauss(0, 0.03);
      rows.push({
        contractId: `B${i}`, kind: 'NP', country: R() < 0.6 ? 'Kenya' : 'Nigeria',
        region: 'Africa', treatyType: 'Excess of Loss', cob: R() < 0.5 ? 'Motor' : 'Casualty',
        status: margin > 0 ? 'SIGNED' : 'DECLINED',
        premium: Math.abs(gauss(1.5e6, 0.6e6)), exposure: null, balance: null, rol,
        margin, uwYear: 2024 + (R() < 0.5 ? 0 : 1),
      });
    }
  }
  return rows;
}

describe('driver statistics', () => {
  const rows = makeBook();
  it('eta-squared recovers treaty type as a strong categorical driver', () => {
    const { eta2 } = etaSquared(rows.map((r) => r.treatyType), rows.map((r) => r.margin));
    expect(eta2).toBeGreaterThan(0.4);
    expect(eta2).toBeLessThanOrEqual(1);
  });
  it('pearson recovers the ROL→margin relationship within NP', () => {
    const { r, n } = pearson(rows.map((r2) => r2.rol), rows.map((r2) => r2.margin));
    expect(Math.abs(r)).toBeGreaterThan(0.3);
    expect(r).toBeLessThan(0);              // higher ROL → lower margin by construction
    expect(n).toBeGreaterThan(50);          // computed only where ROL is defined
  });
  it('decileLift returns a finite signed lift', () => {
    const { lift, topMargin, bottomMargin } = decileLift(rows.map((r) => r.rol), rows.map((r) => r.margin));
    expect(Number.isFinite(lift)).toBe(true);
    expect(topMargin).not.toBeNull();
    expect(bottomMargin).not.toBeNull();
  });
  it('rankDrivers scores all six components and sorts by strength', () => {
    const drivers = rankDrivers(rows);
    expect(drivers.map((d) => d.key).sort()).toEqual(['balance', 'cob', 'country', 'region', 'rol', 'treatyType']);
    for (let i = 1; i < drivers.length; i++) expect(drivers[i - 1].strength).toBeGreaterThanOrEqual(drivers[i].strength);
    expect(drivers[0].strength).toBeGreaterThan(0.4);
  });
});

describe('feature matrix', () => {
  const rows = makeBook();
  const { matrix, columns } = buildFeatureMatrix(rows);
  it('produces only finite values despite structural missingness', () => {
    expect(matrix.every((row) => row.every((v) => Number.isFinite(v)))).toBe(true);
  });
  it('excludes margin and adds structural-missing indicators', () => {
    expect(columns.some((c) => /margin/i.test(c.name))).toBe(false);
    expect(columns.some((c) => c.name === 'balance__missing')).toBe(true);
    expect(columns.some((c) => c.name === 'rol__missing')).toBe(true);
  });
});

describe('kmeans / silhouette / chooseK / pca', () => {
  const rows = makeBook();
  const { matrix } = buildFeatureMatrix(rows);
  it('k-means is reproducible for a fixed seed', () => {
    const a = kmeans(matrix, 2, { seed: 1 });
    const b = kmeans(matrix, 2, { seed: 1 });
    expect(a.assignments).toEqual(b.assignments);
  });
  it('silhouette at k=2 is strongly positive on separable data', () => {
    const km = kmeans(matrix, 2);
    expect(silhouette(matrix, km.assignments, 2)).toBeGreaterThan(0.3);
  });
  it('chooseK returns an interpretable k within range', () => {
    const { k } = chooseK(matrix);
    expect(k).toBeGreaterThanOrEqual(2);
    expect(k).toBeLessThanOrEqual(6);
  });
  it('pca2 returns one 2-D coordinate per contract with sane explained variance', () => {
    const { coords, explained } = pca2(matrix);
    expect(coords).toHaveLength(rows.length);
    expect(coords[0]).toHaveLength(2);
    expect(explained[0]).toBeGreaterThan(0.05);
    expect(explained[0]).toBeLessThanOrEqual(1.0001);
  });
});

describe('analyzePortfolio end-to-end', () => {
  const rows = makeBook();
  const res = analyzePortfolio(rows);
  it('recovers the two latent segments at high purity', () => {
    const byC = {};
    res.assignments.forEach((c, i) => { (byC[c] ||= []).push(rows[i].contractId[0]); });
    let correct = 0, total = 0;
    for (const c of Object.values(byC)) { const a = c.filter((x) => x === 'A').length; correct += Math.max(a, c.length - a); total += c.length; }
    expect(correct / total).toBeGreaterThan(0.9);
  });
  it('labels the QS segment profitable and the XL segment not', () => {
    const profitable = res.clusters.find((c) => c.profitLabel === 'Profitable');
    expect(profitable.dominantTreatyType.label).toBe('Quota Share');
    expect(profitable.avgMargin).toBeGreaterThan(0.1);
  });
  it('exposes a selection signal: profitable segment is more SIGNED', () => {
    const share = (c) => (c.statusMix.SIGNED || 0) / c.size;
    const profitable = res.clusters.find((c) => c.profitLabel === 'Profitable');
    const other = res.clusters.find((c) => c.profitLabel !== 'Profitable' && c.profitLabel !== 'Unscored');
    expect(share(profitable)).toBeGreaterThan(share(other));
  });
  it('degrades gracefully on tiny / empty / unscored books', () => {
    expect(analyzePortfolio(rows.slice(0, 3)).ok).toBe(false);
    expect(analyzePortfolio([]).ok).toBe(false);
    expect(analyzePortfolio(rows.map((r) => ({ ...r, margin: null }))).ok).toBe(true);
  });
});
