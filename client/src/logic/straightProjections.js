/**
 * straightProjections.js
 *
 * Projects straight-stats (no-triangulation) data to ultimate using
 * portfolio-average development factors.
 *
 * The factors below are BENCHMARK / PLACEHOLDER values — see the
 * `IS_BENCHMARK_LDF` flag and the `source` / `reviewed` metadata on
 * each entry of LDF_CONFIG. The UI can read this flag to surface a
 * "uncalibrated benchmark factors in use" warning to the underwriter.
 * They MUST be replaced with actuarial assumptions calibrated to the
 * specific cedant / class before being used in binding pricing.
 */

/**
 * Hard flag the UI can read to display a "benchmark factors only"
 * warning banner. Toggle to false once any LDF set in LDF_CONFIG has
 * been calibrated and signed off — and update the per-entry `reviewed`
 * field accordingly.
 */
export const IS_BENCHMARK_LDF = true;

/**
 * Per-class LDF + CDF configuration. Each entry carries provenance so
 * that "where did this factor come from?" is answerable from the data
 * model alone.
 *
 *   ldfs     — array of age-to-age factors (12→24, 24→36, …)
 *   source   — free-text origin ("Internal benchmark — placeholder",
 *              "Munich Re sigma 2017", "Cedant calibration 2025-Q1", …)
 *   reviewed — null when not reviewed; ISO date when an actuary signed off
 *   label    — UI display name
 *
 * SHORT_TAIL and LONG_TAIL are kept as legacy fallback keys so existing
 * call sites (projectStraightStats) keep working unchanged.
 */
export const LDF_CONFIG = {
  PROPERTY_CAT: {
    label:    'Property — CAT',
    ldfs:     [1.300, 1.080, 1.020, 1.005, 1.001],
    source:   'Internal benchmark — placeholder',
    reviewed: null,
  },
  PROPERTY_NONCAT: {
    label:    'Property — non-CAT',
    ldfs:     [1.250, 1.080, 1.025, 1.010, 1.005],
    source:   'Internal benchmark — placeholder',
    reviewed: null,
  },
  ENGINEERING: {
    label:    'Engineering',
    ldfs:     [1.400, 1.150, 1.060, 1.030, 1.015, 1.008, 1.003],
    source:   'Internal benchmark — placeholder',
    reviewed: null,
  },
  LIABILITY: {
    label:    'Liability / Casualty',
    ldfs:     [2.100, 1.450, 1.220, 1.130, 1.075, 1.045, 1.025, 1.010],
    source:   'Internal benchmark — placeholder',
    reviewed: null,
  },
  MARINE: {
    label:    'Marine',
    ldfs:     [1.180, 1.060, 1.020, 1.008, 1.003],
    source:   'Internal benchmark — placeholder',
    reviewed: null,
  },
  // Legacy fallback keys — preserved for backwards compatibility.
  SHORT_TAIL: {
    label:    'Short tail (legacy)',
    ldfs:     [1.250, 1.080, 1.025, 1.010, 1.005],
    source:   'Internal benchmark — placeholder',
    reviewed: null,
  },
  LONG_TAIL: {
    label:    'Long tail (legacy)',
    ldfs:     [2.100, 1.450, 1.220, 1.130, 1.075, 1.045, 1.025, 1.010],
    source:   'Internal benchmark — placeholder',
    reviewed: null,
  },
};

// Premium develops slightly — mostly earned within 12 months for proportional
const PREM_LDFS = [1.050, 1.015, 1.005, 1.000, 1.000, 1.000, 1.000, 1.000];

// ── Build CDF array from LDFs (oldest year = index 0 = CDF 1.0) ──────────────
function buildCDFs(ldfs) {
  // CDF[i] = product of all LDFs from i to end
  // CDF[last] = last LDF (tail), CDF[0] = 1.0 (fully developed)
  const n = ldfs.length;
  const cdf = new Array(n + 1).fill(1.0);
  for (let i = n - 1; i >= 0; i--) {
    cdf[i] = cdf[i + 1] * ldfs[i];
  }
  return cdf; // cdf[0] = most developed (oldest), cdf[n] = 1.0 (tail factor)
}

// Pre-compute CDFs once so projectStraightStats stays cheap on hot paths.
const PREM_CDFS = buildCDFs(PREM_LDFS);
const LDF_CDFS  = Object.fromEntries(
  Object.entries(LDF_CONFIG).map(([key, cfg]) => [key, buildCDFs(cfg.ldfs)])
);

function getCDF(cdfs, devIdx) {
  // devIdx: 0 = oldest (most developed), n = newest (least developed)
  if (devIdx < 0) return 1.0;
  if (devIdx >= cdfs.length) return cdfs[cdfs.length - 1];
  return cdfs[devIdx];
}

/**
 * Resolve a class-of-business key to the LDF_CONFIG entry to use.
 * Falls back to SHORT_TAIL when the key isn't recognised.
 */
function resolveCdfs(classKey) {
  if (LDF_CDFS[classKey]) return LDF_CDFS[classKey];
  return LDF_CDFS.SHORT_TAIL;
}

/**
 * Project straight stats rows to ultimate.
 *
 * @param {Array}  stats    — [{year, premium, paid, os}]
 * @param {string} classKey — any LDF_CONFIG key (PROPERTY_CAT,
 *                             PROPERTY_NONCAT, ENGINEERING, LIABILITY,
 *                             MARINE, or legacy SHORT_TAIL/LONG_TAIL)
 * @returns {Array}         — [{year, ultPrem, ultLoss, actPrem, actLoss, devFactor, premDevFactor}]
 */
export function projectStraightStats(stats, classKey = 'SHORT_TAIL') {
  if (!stats || !stats.length) return [];

  const lossCDFs = resolveCdfs(classKey);
  const sorted   = [...stats].sort((a, b) => a.year - b.year);
  const n        = sorted.length;

  return sorted.map((row, i) => {
    // devIdx: newest year = n-1, oldest = 0
    const devIdx    = n - 1 - i;
    const lossCDF   = getCDF(lossCDFs, devIdx);
    const premCDF   = getCDF(PREM_CDFS, devIdx);

    const prem     = parseFloat(row.premium) || 0;
    const paid     = parseFloat(row.paid)    || 0;
    const os       = parseFloat(row.os)      || 0;
    const incurred = paid + os;

    return {
      year:          Number(row.year),
      actPrem:       prem,
      actLoss:       incurred,
      ultPrem:       prem * premCDF,
      ultLoss:       incurred * lossCDF,
      devFactor:     lossCDF,
      premDevFactor: premCDF,
    };
  });
}

/**
 * Export factors for display in UI. Built from LDF_CONFIG so adding a
 * new class only requires editing the config — DEV_FACTORS picks it up
 * automatically.
 */
export const DEV_FACTORS = Object.fromEntries(
  Object.entries(LDF_CONFIG).map(([key, cfg]) => [key, {
    label:    cfg.label,
    source:   cfg.source,
    reviewed: cfg.reviewed,
    ldfs: cfg.ldfs.map((ldf, i) => ({
      devYear: i === cfg.ldfs.length - 1
        ? `${(i + 1) * 12}→Ult`
        : `${(i + 1) * 12}→${(i + 2) * 12}`,
      ldf,
    })),
    cdfs: LDF_CDFS[key],
  }])
);
