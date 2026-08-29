/* Bornhuetter-Ferguson Method Calculator */
export function calculateBF(clProjections, premiums, ielrs) {
  if (!clProjections || !Array.isArray(clProjections)) return [];
  return clProjections.map((row, i) => {
    const premium = premiums?.[i] || 0;
    const ielr = Array.isArray(ielrs) ? (ielrs[i] ?? 0) : (Number(ielrs) || 0);
    const aPrioriUltimate = premium * ielr;
    const cdf = row.cdf || 1.0;
    const percentReported = 1 / cdf;
    const percentUnreported = 1 - percentReported;
    const expectedIbnr = aPrioriUltimate * percentUnreported;
    const bfUltimate = row.latest + expectedIbnr;
    const bfLossRatio = premium > 0 ? bfUltimate / premium : 0;
    return {
      year: row.year, method: 'BF', latest: row.latest, cdf,
      premium, ielr, aPrioriUltimate, percentUnreported, expectedIbnr,
      ultimate: bfUltimate, lossRatio: bfLossRatio,
    };
  });
}

/* Premium-flavoured BF — applied to the premium triangle.
 * Uses the client's Estimated Premium Income (EPI) at start-of-year as
 * the a priori volume base, and the achieved-premium ratio (default 100 %)
 * in place of the IELR. Output mirrors the loss BF but with field names
 * appropriate to premium development:
 *   percentUnachieved = 1 − 1/CDF (premium not yet earned)
 *   bfUnearned        = a priori × % unachieved
 *   bfUltimate        = current premium + bfUnearned
 *   achievedRatio     = bfUltimate / EPI
 */
export function calculateBFPremium(clProjections, epis, percentAchieveds) {
  if (!clProjections || !Array.isArray(clProjections)) return [];
  // Achieved-premium ratio default is 100% (see doc comment above) in BOTH
  // argument shapes. Previously a missing ARRAY element defaulted to 1 but a
  // missing/non-numeric SCALAR defaulted to 0, collapsing the a priori to 0
  // so the ultimate silently degenerated to the undeveloped latest (F100).
  // An explicit finite value — including 0 — is honoured in both shapes.
  const toPa = (v) => {
    if (v == null) return 1;
    const n = Number(v);
    return Number.isFinite(n) ? n : 1;
  };
  return clProjections.map((row, i) => {
    const epi = epis?.[i] || 0;
    const pa = Array.isArray(percentAchieveds)
      ? toPa(percentAchieveds[i])
      : toPa(percentAchieveds);
    const aPrioriUltimate = epi * pa;
    const cdf = row.cdf || 1.0;
    const percentEarned = 1 / cdf;
    const percentUnachieved = 1 - percentEarned;
    const bfUnearned = aPrioriUltimate * percentUnachieved;
    const bfUltimate = row.latest + bfUnearned;
    const achievedRatio = epi > 0 ? bfUltimate / epi : 0;
    return {
      year: row.year, method: 'BF', latest: row.latest, cdf,
      epi, percentAchieved: pa, aPrioriUltimate, percentUnachieved, bfUnearned,
      ultimate: bfUltimate, achievedRatio,
    };
  });
}
