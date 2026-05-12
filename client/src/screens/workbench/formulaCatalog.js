// client/src/screens/workbench/formulaCatalog.js
//
// Catalog of formulas that the Workbench knows how to read/edit/preview.
// V1 scope:
//   • Defaults are read from the existing JS modules (single source of truth).
//   • Workbench DB stores override proposals + audit trail.
//   • Live preview applies the proposed value in-memory so an actuary can
//     see "what does this change actually do to the projection?" before
//     submitting.
//   • Wiring the engine to consume DB overrides is intentionally OUT OF
//     SCOPE for this PR (it would require touching pricing screens which
//     the project rules forbid here). When that wiring lands, this catalog
//     becomes the registry the engine queries on cold-start.

import { LDF_CONFIG } from '../../logic/straightProjections';

const CDF_TAIL = 1.000;

function ldfsToCdfs(ldfs) {
  const arr = ldfs.map(Number).filter(Number.isFinite);
  const out = new Array(arr.length + 1).fill(CDF_TAIL);
  for (let i = arr.length - 1; i >= 0; i--) out[i] = out[i + 1] * arr[i];
  return out;
}

function fmtMult(x) {
  return Number.isFinite(x) ? x.toFixed(3) : '—';
}

// Sample yearly stats used by the LDF preview — tweak only here if you want
// the "what does this do?" panel to show different magnitudes.
const SAMPLE_STATS = [
  { year: 2019, premium: 10_000_000, incurred: 6_500_000 },
  { year: 2020, premium: 11_000_000, incurred: 5_800_000 },
  { year: 2021, premium: 11_500_000, incurred: 7_200_000 },
  { year: 2022, premium: 12_000_000, incurred: 4_900_000 },
  { year: 2023, premium: 12_500_000, incurred: 3_100_000 },
  { year: 2024, premium: 13_000_000, incurred: 1_400_000 },
];

function projectWithLdfs(stats, ldfs) {
  const cdfs = ldfsToCdfs(ldfs);
  const sorted = [...stats].sort((a, b) => a.year - b.year);
  const n = sorted.length;
  return sorted.map((row, i) => {
    const devIdx = n - 1 - i;
    const cdf = devIdx >= cdfs.length ? cdfs[cdfs.length - 1] : cdfs[Math.max(0, devIdx)];
    const ultLoss = row.incurred * cdf;
    return {
      year: row.year,
      premium: row.premium,
      incurred: row.incurred,
      cdf,
      ultLoss,
      ultLR: row.premium > 0 ? ultLoss / row.premium : 0,
    };
  });
}

function ldfFormula(classKey, label, plainEnglish) {
  const defaults = LDF_CONFIG[classKey];
  return {
    module: 'PROJECTIONS',
    name: `LDF_${classKey}`,
    label,
    plainEnglish,
    technical:
      `For class ${classKey}, project incurred losses to ultimate by multiplying each ` +
      `development year by an age-to-age factor (LDF). The cumulative product from a year ` +
      `forward to ultimate is the CDF used as a multiplier on incurred-to-date.`,
    formula: [
      'CDF[t]       =  LDF[t] × LDF[t+1] × … × LDF[last] × 1.000',
      'Ult Loss[y]  =  Incurred[y] × CDF[ devYear(y) ]',
      'Ult LR[y]    =  Ult Loss[y] / Premium[y]',
    ],
    parameters: [{
      key: 'ldfs',
      label: 'Loss-development factors (12→24, 24→36, …, last→Ult)',
      kind: 'array-number',
      defaultValue: defaults?.ldfs || [],
      defaultMeta: { source: defaults?.source, reviewed: defaults?.reviewed },
    }],
    preview(values) {
      const ldfs = values.ldfs || [];
      const projected = projectWithLdfs(SAMPLE_STATS, ldfs);
      const cdfs = ldfsToCdfs(ldfs);
      return {
        headline: `CDF (newest→oldest): ${cdfs.map(fmtMult).join(' · ')}`,
        rows: projected.map(r => ({
          year: r.year,
          premium: r.premium,
          incurred: r.incurred,
          cdf: fmtMult(r.cdf),
          ultLoss: Math.round(r.ultLoss),
          ultLR: `${(r.ultLR * 100).toFixed(1)}%`,
        })),
        rowColumns: [
          { key: 'year',     label: 'UW Year' },
          { key: 'premium',  label: 'Premium', format: (v) => v.toLocaleString() },
          { key: 'incurred', label: 'Incurred', format: (v) => v.toLocaleString() },
          { key: 'cdf',      label: 'CDF' },
          { key: 'ultLoss',  label: 'Ult Loss', format: (v) => v.toLocaleString() },
          { key: 'ultLR',    label: 'Ult LR' },
        ],
      };
    },
  };
}

const IELR_DEFAULT_BY_CLASS = {
  PROPERTY_CAT:    0.55,
  PROPERTY_NONCAT: 0.60,
  ENGINEERING:     0.55,
  LIABILITY:       0.70,
  MARINE:          0.55,
};

const PARETO_DEFAULTS = {
  alphaSeed: 1.5,
  weight:    0.0,
};

export const FORMULA_CATALOG = [
  ldfFormula('PROPERTY_CAT',    'Property — CAT — LDFs',
    'These factors say "incurred losses for a CAT year are not done developing — they keep growing for a few years before they settle." Higher numbers mean we expect bigger upward revisions.'),
  ldfFormula('PROPERTY_NONCAT', 'Property — non-CAT — LDFs',
    'How much we still expect property non-CAT incurred losses to grow before settling at ultimate.'),
  ldfFormula('ENGINEERING',     'Engineering — LDFs',
    'Engineering claims report and develop slower than property. These factors capture how much growth to expect at each development year.'),
  ldfFormula('LIABILITY',       'Liability / Casualty — LDFs',
    'Long-tail business — losses can develop for a decade. These factors are the largest in the catalog because the projection has the most uncertainty to absorb.'),
  ldfFormula('MARINE',          'Marine — LDFs',
    'How quickly marine claims develop to ultimate. Generally short-tail, but with a wider spread than property non-CAT.'),
  {
    module:    'PRICING',
    name:      'IELR_DEFAULTS',
    label:     'IELR — Initial Expected Loss Ratios (BF method)',
    plainEnglish:
      'When we Bornhuetter-Ferguson a young year, we need a starting loss ratio. These are the defaults we use per class of business when no calibrated number is available.',
    technical:
      'BF expected loss = premium × IELR × (1 − 1/CDF). The IELR_DEFAULTS object provides the per-class starting point; underwriters can override at the contract level.',
    formula: [
      'BF Expected Loss  =  Premium × IELR × (1 − 1 / CDF)',
      'Ultimate Loss     =  Reported Loss + BF Expected Loss',
    ],
    parameters: Object.entries(IELR_DEFAULT_BY_CLASS).map(([cls, val]) => ({
      key:          `ielr_${cls.toLowerCase()}`,
      label:        `${cls.replace('_', ' / ')} default IELR`,
      kind:         'number',
      defaultValue: val,
    })),
    preview(values) {
      const rows = Object.keys(IELR_DEFAULT_BY_CLASS).map(cls => {
        const v = Number(values[`ielr_${cls.toLowerCase()}`] ?? IELR_DEFAULT_BY_CLASS[cls]);
        return { class: cls.replace('_', ' / '), ielr: `${(v * 100).toFixed(1)}%` };
      });
      return {
        headline: 'BF expected-loss seed by class',
        rows,
        rowColumns: [
          { key: 'class', label: 'Class' },
          { key: 'ielr',  label: 'IELR' },
        ],
      };
    },
  },
  {
    module:    'NP_PRICING',
    name:      'PARETO_BLEND',
    label:     'Pareto component — alpha seed + blend weight',
    plainEnglish:
      'For non-prop layer pricing we blend three signals: pure burn, exposure, and Pareto-extrapolated burn. These two parameters control where the Pareto curve starts and how heavily it counts toward the final rate.',
    technical:
      'Layer rate = (w_burn·burn + w_exp·exposure + w_pareto·pareto) / Σw. alpha_seed is the prior used by the MLE if there are too few losses to fit a curve. weight is a default fraction (0..1) for the Pareto component when no per-contract value has been entered.',
    formula: [
      'Layer Rate  =  (w_burn·burn + w_exp·exposure + w_pareto·pareto) / Σw',
      'w_pareto    =  weight             (input parameter, 0..1)',
      'w_burn      =  w_exp  =  (1 − w_pareto) / 2',
      'α           =  MLE(losses)        if  n ≥ threshold',
      'α           =  α_seed             otherwise',
    ],
    parameters: [
      { key: 'alphaSeed', label: 'Pareto α seed (prior)',  kind: 'number', defaultValue: PARETO_DEFAULTS.alphaSeed },
      { key: 'weight',    label: 'Pareto blend weight (0..1)', kind: 'number', defaultValue: PARETO_DEFAULTS.weight },
    ],
    preview(values) {
      const a = Number(values.alphaSeed ?? PARETO_DEFAULTS.alphaSeed);
      const w = Number(values.weight ?? PARETO_DEFAULTS.weight);
      const sampleBurn = 0.030, sampleExp = 0.022, sampleParetoBurn = 0.034;
      // Equal split between burn + exp for the remaining weight.
      const wBurnExp = (1 - w) / 2;
      const blended = wBurnExp * sampleBurn + wBurnExp * sampleExp + w * sampleParetoBurn;
      return {
        headline: `α seed = ${a.toFixed(2)} · Pareto weight = ${(w * 100).toFixed(0)}%`,
        rows: [
          { component: 'Pure burn (3.0%)',     weight: `${(wBurnExp * 100).toFixed(0)}%` },
          { component: 'Exposure (2.2%)',      weight: `${(wBurnExp * 100).toFixed(0)}%` },
          { component: 'Pareto burn (3.4%)',   weight: `${(w * 100).toFixed(0)}%` },
          { component: 'Blended layer rate',   weight: `${(blended * 100).toFixed(2)}%` },
        ],
        rowColumns: [
          { key: 'component', label: 'Component (sample inputs)' },
          { key: 'weight',    label: 'Weight / Result' },
        ],
      };
    },
  },
];

export function findFormula(module, name) {
  return FORMULA_CATALOG.find(f => f.module === module && f.name === name) || null;
}
