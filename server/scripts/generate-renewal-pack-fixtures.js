// Generates 20 synthetic renewal-pack .xlsx fixtures for the parser tests.
//
// Run from the repo root with:
//   node server/scripts/generate-renewal-pack-fixtures.js
//
// Outputs to test/fixtures/renewal-packs/. Each fixture varies sheet
// combinations and edge cases (empty leading rows, unknown sheets, totals
// rows, multiple risk profiles, etc.) so the parser is exercised across
// realistic broker-pack permutations. These are synthetic — swap in real
// packs if/when sanitized examples are available.

import ExcelJS from 'exceljs';
import path from 'path';
import fs from 'fs';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const FIXTURES_DIR = path.resolve(__dirname, '../../test/fixtures/renewal-packs');

// Deterministic PRNG so regenerating produces byte-identical fixtures
// (modulo workbook timestamps, which we override below).
function rand(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

// ── sheet builders ────────────────────────────────────────────────────────────

function triangleRows({ headerLabel, uwYears, devPeriods, rng, scale = 1_000_000 }) {
  const rows = [[headerLabel, ...devPeriods]];
  for (const year of uwYears) {
    const limit = devPeriods.length - (2026 - year < 0 ? 0 : Math.max(0, 2026 - year - 1));
    const lineValues = devPeriods.map((_, j) =>
      j <= limit ? Math.round(rng() * scale * (j + 1)) : null,
    );
    rows.push([year, ...lineValues]);
  }
  return rows;
}

function largeLossRows({ uwYears, rng, n = 10, isCat = false }) {
  const rows = [
    ['UW YEAR', 'Insured', isCat ? 'Event' : 'Loss Name', 'Date', 'Class', 'Paid', 'OS', 'Incurred'],
  ];
  const classes = ['Fire', 'Engineering', 'Marine Cargo', 'Liability'];
  for (let i = 0; i < n; i++) {
    const year = uwYears[i % uwYears.length];
    const paid = Math.round(rng() * 4_000_000);
    const os = Math.round(rng() * 2_000_000);
    rows.push([
      year,
      `Insured ${i + 1}`,
      isCat ? `Event ${i + 1}` : `Loss ${i + 1}`,
      `${year}-${String((i % 12) + 1).padStart(2, '0')}-15`,
      classes[i % classes.length],
      paid,
      os,
      paid + os,
    ]);
  }
  return rows;
}

function riskProfileRows({ label, rng, n = 6 }) {
  const rows = [[label], ['MIN BAND', 'MAX BAND', 'NUM POL', 'SUM INSURED', 'PREMIUMS', 'AVG SI', 'AVG PREM', 'RATE %']];
  let min = 0;
  for (let i = 0; i < n; i++) {
    const max = min + Math.round(rng() * 10_000_000) + 1_000_000;
    const numPol = Math.round(rng() * 500) + 10;
    const si = Math.round((min + max) / 2) * numPol;
    const premiums = Math.round(si * (0.001 + rng() * 0.005));
    rows.push([min, max, numPol, si, premiums, Math.round(si / numPol), Math.round(premiums / numPol), (premiums / si) * 100]);
    min = max;
  }
  rows.push(['TOTAL', '', '', '', '', '', '', '']);
  return rows;
}

function claimsProfileRows({ label, rng, n = 5 }) {
  const rows = riskProfileRows({ label, rng, n });
  rows[0] = [label]; // already a Claims Profile label
  return rows;
}

function crestaRows({ rng, n = 8 }) {
  const rows = [['ZONE CODE', 'ZONE NAME', 'EARTHQUAKE', 'WINDSTORM', 'FLOOD', 'SRCC', 'OTHERS']];
  for (let i = 0; i < n; i++) {
    rows.push([
      `Z${String(i + 1).padStart(2, '0')}`,
      `Zone ${i + 1}`,
      Math.round(rng() * 5_000_000),
      Math.round(rng() * 5_000_000),
      Math.round(rng() * 3_000_000),
      Math.round(rng() * 1_000_000),
      Math.round(rng() * 500_000),
    ]);
  }
  return rows;
}

function treatyLayerRows({ rng, n = 4 }) {
  const rows = [
    ['LAYER', 'LIMIT', 'ATTACHMENT', 'AGG LIMIT', 'EGNPI', 'RATE %', 'EARNED PREM', 'MDP', 'MDP ALT', 'REINST', 'REINST %'],
  ];
  let attachment = 1_000_000;
  for (let i = 0; i < n; i++) {
    const limit = (i + 1) * 5_000_000;
    const egnpi = Math.round(rng() * 50_000_000) + 10_000_000;
    const rate = +(0.5 + rng() * 5).toFixed(3);
    rows.push([
      `L${i + 1}`,
      limit,
      attachment,
      limit * 2,
      egnpi,
      rate,
      Math.round((egnpi * rate) / 100),
      Math.round(limit * 0.1),
      Math.round(limit * 0.08),
      i === 0 ? 2 : 1,
      i === 0 ? 100 : 50,
    ]);
    attachment += limit;
  }
  return rows;
}

function egnpiRows({ years, rng }) {
  const rows = [['YEAR', 'EGNPI']];
  for (const y of years) rows.push([y, Math.round(rng() * 100_000_000) + 20_000_000]);
  return rows;
}

function coverRows({ cedant, classes, inception, currency }) {
  return [
    ['RENEWAL PACK'],
    [],
    ['Cedant', cedant],
    ['Class of Business', classes.join(', ')],
    ['Inception', inception],
    ['Currency', currency],
    ['Period', '12 months'],
  ];
}

// ── fixture compositions ──────────────────────────────────────────────────────

function makeProp(seed, opts) {
  const rng = rand(seed);
  const wb = new ExcelJS.Workbook();
  setStableMeta(wb);
  const uwYears = opts.uwYears;
  const devPeriods = opts.devPeriods;

  if (opts.includeCover !== false) {
    addSheet(wb, 'Cover', coverRows(opts.cover));
  }
  // a couple of empty leading rows on Premium Triangle in some packs
  addSheet(
    wb,
    'Premium Triangle',
    maybePadTop(
      triangleRows({ headerLabel: 'UW YEAR', uwYears, devPeriods, rng, scale: 2_000_000 }),
      opts.padTop ? 2 : 0,
    ),
  );
  addSheet(wb, 'Claims Triangle', triangleRows({ headerLabel: 'UW YEAR', uwYears, devPeriods, rng, scale: 800_000 }));
  if (opts.includeOs !== false) {
    addSheet(wb, 'OS Claims Triangle', triangleRows({ headerLabel: 'UW YEAR', uwYears, devPeriods, rng, scale: 300_000 }));
  }
  if (opts.largeN > 0) addSheet(wb, 'Large Loss Records', largeLossRows({ uwYears, rng, n: opts.largeN, isCat: false }));
  if (opts.catN > 0) addSheet(wb, 'Cat Loss Records', largeLossRows({ uwYears, rng, n: opts.catN, isCat: true }));
  if (opts.includeRisk !== false) {
    if (opts.twoRiskProfiles) {
      addSheet(wb, 'Risk Profile', [
        ...riskProfileRows({ label: 'Risk Profile 1', rng, n: 5 }),
        [],
        ...riskProfileRows({ label: 'Risk Profile 2', rng, n: 4 }),
      ]);
    } else {
      addSheet(wb, 'Risk Profile', riskProfileRows({ label: 'Risk Profile 1', rng, n: 6 }));
    }
  }
  if (opts.includeClaimsProfile) {
    addSheet(wb, 'Claims Profile', claimsProfileRows({ label: 'Claims Profile 1', rng, n: 5 }));
  }
  if (opts.includeCresta) addSheet(wb, 'CRESTA Zones', crestaRows({ rng, n: 8 }));
  if (opts.unknownSheet) addSheet(wb, opts.unknownSheet, [['Notes'], ['Free text from broker'], ['ignored row']]);
  return wb;
}

function makeNp(seed, opts) {
  const rng = rand(seed);
  const wb = new ExcelJS.Workbook();
  setStableMeta(wb);
  const uwYears = opts.uwYears;

  if (opts.includeCover !== false) addSheet(wb, 'Cover', coverRows(opts.cover));
  addSheet(wb, 'Treaty Layers', treatyLayerRows({ rng, n: opts.layerN ?? 4 }));
  if (opts.includeEgnpi !== false) addSheet(wb, 'EGNPI', egnpiRows({ years: uwYears, rng }));
  if (opts.largeN > 0) addSheet(wb, 'Large Loss Records', largeLossRows({ uwYears, rng, n: opts.largeN }));
  if (opts.catN > 0) addSheet(wb, 'Cat Loss Records', largeLossRows({ uwYears, rng, n: opts.catN, isCat: true }));
  if (opts.includeRisk) addSheet(wb, 'Risk Profile', riskProfileRows({ label: 'Risk Profile 1', rng, n: 5 }));
  if (opts.includeClaimsProfile) addSheet(wb, 'Claims Profile', claimsProfileRows({ label: 'Claims Profile 1', rng, n: 4 }));
  if (opts.includeCresta) addSheet(wb, 'CRESTA Zones', crestaRows({ rng, n: 6 }));
  if (opts.unknownSheet) addSheet(wb, opts.unknownSheet, [['Misc'], ['extra data']]);
  return wb;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function addSheet(wb, name, rows) {
  const ws = wb.addWorksheet(name);
  ws.addRows(rows);
}

function maybePadTop(rows, n) {
  if (!n) return rows;
  const pad = Array.from({ length: n }, () => []);
  return [...pad, ...rows];
}

function setStableMeta(wb) {
  // Make rebuilds deterministic so committed bytes don't churn.
  const epoch = new Date('2024-01-01T00:00:00Z');
  wb.created = epoch;
  wb.modified = epoch;
  wb.lastPrinted = epoch;
  wb.creator = 'fixtures';
  wb.lastModifiedBy = 'fixtures';
}

const UW_RANGE = (start, end) => Array.from({ length: end - start + 1 }, (_, i) => start + i);

// ── 20 fixture specs ──────────────────────────────────────────────────────────

const PROP_SPECS = [
  { name: 'PROP_01.xlsx', seed: 1, cover: { cedant: 'Acme Insurance Co', classes: ['Fire', 'Engineering'], inception: '2025-01-01', currency: 'USD' }, uwYears: UW_RANGE(2017, 2026), devPeriods: [12, 24, 36, 48, 60], largeN: 8, catN: 0, includeRisk: true, includeCresta: true },
  { name: 'PROP_02.xlsx', seed: 2, cover: { cedant: 'Beta Re', classes: ['Property'], inception: '2025-07-01', currency: 'EUR' }, uwYears: UW_RANGE(2019, 2025), devPeriods: [12, 24, 36, 48], largeN: 5, catN: 5, includeRisk: true, includeClaimsProfile: true, includeCresta: true },
  { name: 'PROP_03.xlsx', seed: 3, cover: { cedant: 'Gamma Mutual', classes: ['Marine Cargo', 'Marine Hull'], inception: '2025-04-01', currency: 'GBP' }, uwYears: UW_RANGE(2020, 2026), devPeriods: [12, 24, 36, 48, 60], largeN: 12, catN: 0, includeRisk: true, twoRiskProfiles: true, padTop: true },
  { name: 'PROP_04.xlsx', seed: 4, cover: { cedant: 'Delta General', classes: ['Liability'], inception: '2025-10-01', currency: 'USD' }, uwYears: UW_RANGE(2015, 2026), devPeriods: [12, 24, 36, 48, 60, 72, 84], largeN: 6, catN: 0, includeRisk: true, unknownSheet: 'Notes' },
  { name: 'PROP_05.xlsx', seed: 5, cover: { cedant: 'Epsilon Insurance', classes: ['Engineering'], inception: '2026-01-01', currency: 'INR' }, uwYears: UW_RANGE(2018, 2025), devPeriods: [12, 24, 36, 48, 60], largeN: 10, catN: 4, includeRisk: true, includeCresta: true, includeClaimsProfile: true },
  { name: 'PROP_06.xlsx', seed: 6, cover: { cedant: 'Zeta Holdings', classes: ['Fire'], inception: '2025-06-01', currency: 'AED' }, uwYears: UW_RANGE(2021, 2026), devPeriods: [12, 24, 36], largeN: 0, catN: 0, includeRisk: true, includeOs: false },
  { name: 'PROP_07.xlsx', seed: 7, cover: { cedant: 'Eta Bermuda', classes: ['Energy'], inception: '2025-09-01', currency: 'USD' }, uwYears: UW_RANGE(2016, 2025), devPeriods: [12, 24, 36, 48, 60, 72], largeN: 7, catN: 3, includeRisk: true, includeCresta: true, includeClaimsProfile: true, twoRiskProfiles: true },
  { name: 'PROP_08.xlsx', seed: 8, cover: { cedant: 'Theta Co', classes: ['Motor'], inception: '2025-03-01', currency: 'NGN' }, uwYears: UW_RANGE(2019, 2026), devPeriods: [12, 24, 36, 48], largeN: 4, catN: 0, includeRisk: false, includeClaimsProfile: true },
  { name: 'PROP_09.xlsx', seed: 9, cover: { cedant: 'Iota Insurance', classes: ['Misc Accident'], inception: '2025-12-01', currency: 'KES' }, uwYears: UW_RANGE(2018, 2026), devPeriods: [12, 24, 36, 48, 60], largeN: 9, catN: 6, includeRisk: true, includeCresta: true, unknownSheet: 'Broker Notes', padTop: true },
  { name: 'PROP_10.xlsx', seed: 10, cover: { cedant: 'Kappa Re', classes: ['Aviation', 'Marine'], inception: '2025-08-01', currency: 'USD' }, uwYears: UW_RANGE(2014, 2026), devPeriods: [12, 24, 36, 48, 60, 72, 84, 96], largeN: 14, catN: 0, includeRisk: true, includeClaimsProfile: true, includeCresta: false, includeCover: false },
];

const NP_SPECS = [
  { name: 'NP_01.xlsx', seed: 101, cover: { cedant: 'Lambda Re', classes: ['Property XL'], inception: '2025-01-01', currency: 'USD' }, uwYears: UW_RANGE(2017, 2025), layerN: 4, largeN: 10, catN: 4 },
  { name: 'NP_02.xlsx', seed: 102, cover: { cedant: 'Mu Re', classes: ['Casualty XL'], inception: '2025-04-01', currency: 'EUR' }, uwYears: UW_RANGE(2018, 2025), layerN: 5, largeN: 6, catN: 0, includeRisk: true },
  { name: 'NP_03.xlsx', seed: 103, cover: { cedant: 'Nu Bermuda', classes: ['Catastrophe XL'], inception: '2025-07-01', currency: 'USD' }, uwYears: UW_RANGE(2019, 2026), layerN: 3, largeN: 0, catN: 8, includeCresta: true },
  { name: 'NP_04.xlsx', seed: 104, cover: { cedant: 'Xi Insurance', classes: ['Property XL', 'Cat XL'], inception: '2025-10-01', currency: 'USD' }, uwYears: UW_RANGE(2016, 2025), layerN: 6, largeN: 8, catN: 6, includeCresta: true, includeRisk: true },
  { name: 'NP_05.xlsx', seed: 105, cover: { cedant: 'Omicron Co', classes: ['Stop Loss'], inception: '2025-05-01', currency: 'GBP' }, uwYears: UW_RANGE(2020, 2026), layerN: 2, largeN: 5, catN: 0 },
  { name: 'NP_06.xlsx', seed: 106, cover: { cedant: 'Pi Group', classes: ['Property XL'], inception: '2025-02-01', currency: 'KES' }, uwYears: UW_RANGE(2018, 2025), layerN: 4, largeN: 12, catN: 4, includeClaimsProfile: true, unknownSheet: 'Notes' },
  { name: 'NP_07.xlsx', seed: 107, cover: { cedant: 'Rho Holdings', classes: ['Liability XL'], inception: '2025-09-01', currency: 'USD' }, uwYears: UW_RANGE(2017, 2026), layerN: 5, largeN: 7, catN: 0, includeRisk: true, includeClaimsProfile: true },
  { name: 'NP_08.xlsx', seed: 108, cover: { cedant: 'Sigma Re', classes: ['Marine XL'], inception: '2025-11-01', currency: 'USD' }, uwYears: UW_RANGE(2019, 2025), layerN: 3, largeN: 6, catN: 3, includeCresta: true, includeEgnpi: false },
  { name: 'NP_09.xlsx', seed: 109, cover: { cedant: 'Tau Re', classes: ['Engineering XL'], inception: '2025-06-01', currency: 'EUR' }, uwYears: UW_RANGE(2018, 2026), layerN: 4, largeN: 8, catN: 2, includeRisk: true, includeCresta: true, unknownSheet: 'Misc' },
  { name: 'NP_10.xlsx', seed: 110, cover: { cedant: 'Upsilon Re', classes: ['Aviation XL'], inception: '2025-12-01', currency: 'USD' }, uwYears: UW_RANGE(2016, 2026), layerN: 6, largeN: 10, catN: 5, includeRisk: true, includeClaimsProfile: true, includeCresta: true, includeCover: false },
];

// ── main ──────────────────────────────────────────────────────────────────────

async function main() {
  fs.mkdirSync(FIXTURES_DIR, { recursive: true });
  for (const spec of PROP_SPECS) {
    const wb = makeProp(spec.seed, spec);
    await wb.xlsx.writeFile(path.join(FIXTURES_DIR, spec.name));
    process.stdout.write(`wrote ${spec.name}\n`);
  }
  for (const spec of NP_SPECS) {
    const wb = makeNp(spec.seed, spec);
    await wb.xlsx.writeFile(path.join(FIXTURES_DIR, spec.name));
    process.stdout.write(`wrote ${spec.name}\n`);
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
