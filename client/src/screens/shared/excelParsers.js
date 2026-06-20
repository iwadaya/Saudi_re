// src/screens/shared/excelParsers.js
// Sheet detection + per-sheet row parsers for the Excel import agent, extracted
// from ExcelImportAgent to keep that screen under the 800-line budget. Pure data
// transforms (+ a couple of api lookups for id resolution); no React. The num/str
// cell coercers are kept local so this module is self-contained.
import { api } from '../../api';
import { logger } from '../../utils/logger';

const num = v => { const n = parseFloat(String(v ?? '').replace(/,/g, '')); return Number.isFinite(n) ? n : 0; };
const str = v => (v != null && v !== '') ? String(v).trim() : '';

// ── sheet detectors ───────────────────────────────────────────────────────────
export const SHEET_MAP = {
  // Proportional
  'Premium Triangle'  : { type: 'triangle',      label: 'Premium Triangle',    treaty: 'prop' },
  'Claims Triangle'   : { type: 'triangle',      label: 'Claims Triangle',     treaty: 'prop' },
  'OS Claims Triangle': { type: 'triangle',      label: 'OS Claims Triangle',  treaty: 'prop' },
  // NP + Prop shared
  'Large Loss Records': { type: 'largeLosses',   label: 'Large Losses',        treaty: 'both' },
  'Cat Loss Records'  : { type: 'catLosses',     label: 'CAT Losses',          treaty: 'both' },
  'Risk Profile'      : { type: 'riskProfile',   label: 'Risk Profile',        treaty: 'both' },
  'Claims Profile'    : { type: 'claimsProfile', label: 'Claims Profile',      treaty: 'both' },
  'CRESTA Zones'      : { type: 'cresta',        label: 'CRESTA Zones',        treaty: 'both' },
  'Cresta'            : { type: 'cresta',        label: 'CRESTA Zones',        treaty: 'both' },
  // NP-only
  'Treaty Layers'     : { type: 'npLayers',      label: 'NP Treaty Layers',    treaty: 'np'   },
  'EGNPI'             : { type: 'egnpi',         label: 'EGNPI History',       treaty: 'np'   },
  'Claims Profile 2'  : { type: 'claimsProfile', label: 'Claims Profile 2',   treaty: 'both' },
};

const TRIANGLE_TYPE = {
  'Premium Triangle'  : 'premium',
  'Claims Triangle'   : 'paid',
  'OS Claims Triangle': 'os',
};

// ── parse functions ───────────────────────────────────────────────────────────
function parseTriangle(rows) {
  // Find header row with UW / DEV
  const hIdx = rows.findIndex(r => String(r[0] ?? '').includes('UW'));
  if (hIdx < 0) return null;
  const devYears = rows[hIdx].slice(1).map(v => str(v)).filter(Boolean);
  const data = [];
  for (let i = hIdx + 1; i < rows.length; i++) {
    const r = rows[i];
    const uw = str(r[0]);
    if (!uw || !/^\d{4}/.test(uw)) continue;
    const vals = devYears.map((_, j) => r[j + 1] != null ? num(r[j + 1]) : null);
    data.push({ uw_year: parseInt(uw), values: vals });
  }
  return { dev_years: devYears.map(Number), rows: data };
}

function parseLargeLosses(rows) {
  // Skip header rows until we hit UW YEAR
  const hIdx = rows.findIndex(r => String(r[0] ?? '').toUpperCase().includes('UW'));
  const start = hIdx >= 0 ? hIdx + 1 : 1;
  return rows.slice(start).filter(r => r[0] && /^\d{4}/.test(String(r[0]))).map(r => ({
    uw_year    : parseInt(r[0]),
    insured_name : str(r[1]),
    loss_name  : str(r[2]),
    date_of_loss : str(r[3]),
    class_of_business: str(r[4]),
    paid       : num(r[5]),
    os         : num(r[6]),
    incurred   : num(r[7]),
    is_selected: true,
  }));
}

function parseCatLosses(rows) {
  const hIdx = rows.findIndex(r => String(r[0] ?? '').toUpperCase().includes('UW'));
  const start = hIdx >= 0 ? hIdx + 1 : 1;
  // Use loss_name (not event_name) — the server's contract_cat_losses
  // column is loss_name, and the loss-list screen renders that field.
  // The old event_name key was silently dropped so imports showed '—'.
  return rows.slice(start).filter(r => r[0] && /^\d{4}/.test(String(r[0]))).map(r => ({
    uw_year    : parseInt(r[0]),
    insured_name : str(r[1]),
    loss_name  : str(r[2]),
    date_of_event: str(r[3]),
    class      : str(r[4]),
    paid       : num(r[5]),
    os         : num(r[6]),
    incurred   : num(r[7]),
    is_selected: true,
  }));
}

function parseRiskProfile(rows) {
  // May have multiple profiles — find all header rows
  const profiles = [];
  let currentLabel = 'Risk Profile 1';
  let inProfile = false;
  const dataRows = [];

  for (const row of rows) {
    const first = str(row[0]).toUpperCase();
    if (!first) continue;
    if (first.startsWith('RISK PROFILE') || first.startsWith('RISK PROFIL')) {
      if (dataRows.length) profiles.push({ label: currentLabel, rows: [...dataRows] });
      currentLabel = str(row[0]) || currentLabel;
      dataRows.length = 0;
      inProfile = true;
      continue;
    }
    if (first === 'MIN BAND') {
      inProfile = true;
      continue;
    }
    if (!inProfile) continue;
    if (!row[0] || row[0] === 'MIN BAND') continue;
    const band_min = str(row[0]);
    if (band_min.toUpperCase() === 'TOTAL') continue;
    dataRows.push({
      band_min   : num(row[0]),
      band_max   : num(row[1]),
      num_policies: num(row[2]),
      sum_insured: num(row[3]),
      premiums   : num(row[4]),
      avg_sum_insured: num(row[5]),
      avg_premium: num(row[6]),
      rate_pct   : num(row[7]),
      // Claims profile sheets carry a paid-amount column the screen
      // displays per band; without this the paid column renders blank
      // for imported profiles. Risk-profile sheets don't have col 8,
      // num() yields 0 for them — harmless for that consumer.
      claims_paid: num(row[8]),
    });
  }
  if (dataRows.length) profiles.push({ label: currentLabel, rows: [...dataRows] });
  return profiles;
}

function parseClaimsProfile(rows) {
  return parseRiskProfile(rows.map((r) => {
    // rename first cell if it says Claims Profile
    const first = str(r[0]);
    if (first.toUpperCase().startsWith('CLAIMS PROFILE')) return ['Risk Profile ' + (first.match(/\d+/)?.[0] || '1'), ...r.slice(1)];
    return r;
  }));
}

function parseCresta(rows) {
  const hIdx = rows.findIndex(r => String(r[0] ?? '').toUpperCase().includes('ZONE'));
  const start = hIdx >= 0 ? hIdx + 1 : 1;
  return rows.slice(start).filter(r => r[0]).map(r => ({
    zone_code  : str(r[0]),
    zone_name  : str(r[1]),
    earthquake : num(r[2]),
    windstorm  : num(r[3]),
    flood      : num(r[4]),
    srcc       : num(r[5]),
    others     : num(r[6]),
  }));
}

function parseNpLayers(rows) {
  const hIdx = rows.findIndex(r => String(r[0] ?? '').toUpperCase() === 'LAYER');
  const headerRow = hIdx >= 0 ? rows[hIdx] : [];
  // Locate a peril/scope/cover column so risk-only or cat-only slips
  // don't get marked as both. Excel layouts vary across cedants, so
  // match a few common header labels. If the column is missing we
  // fall back to both ON (the historical default) but warn — silently
  // marking everything risk+cat was the original bug.
  const perilColIdx = headerRow.findIndex(c => /^(peril|scope|cover|peril.?scope)$/i.test(String(c ?? '').trim()));
  if (perilColIdx < 0) {
    logger.warn('[ExcelImportAgent] NP Treaty Layers sheet has no peril/scope column — defaulting every layer to risk+cat. Verify by hand or add a "Peril Scope" header.');
  }
  const start = hIdx >= 0 ? hIdx + 1 : 1;
  return rows.slice(start).filter(r => r[0] && /^\d/.test(String(r[0]))).map(r => {
    const perilRaw = perilColIdx >= 0 ? String(r[perilColIdx] ?? '').toUpperCase().trim() : '';
    // No column or empty cell → permissive default (both ON).
    // BOTH explicitly → both ON. Otherwise honour the cell text.
    const ambiguous = perilColIdx < 0 || !perilRaw;
    const isBoth = perilRaw.includes('BOTH');
    const risk_cover = ambiguous || isBoth || perilRaw.includes('RISK');
    const cat_cover  = ambiguous || isBoth || perilRaw.includes('CAT');
    return {
      layer_number : parseInt(r[0]),
      limit        : num(r[1]),
      deductible   : num(r[2]),
      aggregate_limit: num(r[3]),
      egnpi        : num(r[4]),
      rate         : num(r[5]),
      earned_premium: num(r[6]),
      mdp          : num(r[7]),
      mdp_pct      : num(r[8]),
      num_reinstatements: num(r[9]),
      reinstatement_pct : num(r[10]),
      risk_cover,
      cat_cover,
    };
  });
}

function parseEgnpi(rows) {
  return rows.filter(r => r[0] && /^\d{4}/.test(String(r[0]))).map(r => ({
    year: parseInt(r[0]),
    egnpi: num(r[1]),
  }));
}

// ── main parser dispatcher ────────────────────────────────────────────────────
export function parseSheet(sheetName, rows) {
  const info = Object.entries(SHEET_MAP).find(([k]) =>
    sheetName.toLowerCase().includes(k.toLowerCase())
  );
  if (!info) return null;
  const [, meta] = info;
  const triType = TRIANGLE_TYPE[sheetName] || TRIANGLE_TYPE[Object.keys(TRIANGLE_TYPE).find(k => sheetName.toLowerCase().includes(k.toLowerCase().split(' ')[0])) || ''];

  switch (meta.type) {
    case 'triangle':
      return { ...meta, triType, data: parseTriangle(rows) };
    case 'largeLosses':
      return { ...meta, data: parseLargeLosses(rows) };
    case 'catLosses':
      return { ...meta, data: parseCatLosses(rows) };
    case 'riskProfile':
      return { ...meta, data: parseRiskProfile(rows) };
    case 'claimsProfile':
      return { ...meta, data: parseClaimsProfile(rows) };
    case 'cresta':
      return { ...meta, data: parseCresta(rows) };
    case 'npLayers':
      return { ...meta, data: parseNpLayers(rows) };
    case 'egnpi':
      return { ...meta, data: parseEgnpi(rows) };
    default:
      return null;
  }
}

// ── API push functions ────────────────────────────────────────────────────────
export async function pushSheet(contractId, sheet, opts = {}) {
  const { type, triType, data } = sheet;
  // classIds rides along on opts as a sidecar for profile imports;
  // strip it from the apiOpts spread so it doesn't leak into the
  // underlying fetch options object the api helpers pass through.
  const { classIds, variant, ...apiOpts } = opts;
  switch (type) {
    case 'triangle': {
      // INCURRED is derived (paid + OS) and has no stored variant — never tag
      // it. The TRIANGLE_TYPE map can't produce INCURRED today; this guards a
      // future mapping from ever writing ACTUAL-tagged incurred rows.
      const triOpts = String(triType).toUpperCase() === 'INCURRED' ? apiOpts : { ...apiOpts, variant };
      return api.saveTriangle(contractId, triType, { triangle: data }, triOpts);
    }
    case 'largeLosses':
      return api.saveLargeLosses(contractId, { losses: data }, apiOpts);
    case 'catLosses':
      return api.saveCatLosses(contractId, { losses: data }, apiOpts);
    case 'riskProfile':
    case 'claimsProfile': {
      // Real class_of_business_id from Treaty Detail's classIds —
      // the server's risk-profiles PUT validates this as an FK, so the
      // old 'default' / 'profile_N' string sentinels FK-violated and
      // never persisted. Caller threads classIds through opts.
      const resolvedCobIds = (classIds || []).filter(Boolean);
      if (resolvedCobIds.length === 0) {
        throw new Error('No class of business selected on Treaty Detail — pick at least one before importing profiles.');
      }
      const results = [];
      for (let i = 0; i < data.length; i++) {
        // Map profile i to classIds[i] in order; if the sheet has
        // more profiles than the contract has selected COBs, fall
        // back to the first COB so the import still lands somewhere.
        const cobId = resolvedCobIds[i] || resolvedCobIds[0];
        results.push(await api.saveRiskProfile(contractId, cobId, { rows: data[i].rows }, apiOpts).catch(e => e));
      }
      return results;
    }
    case 'cresta':
      return api.saveCrestaData(contractId, { zones: data }, apiOpts);
    case 'npLayers':
      return api.saveNonPropTreaty(contractId, {
        terms: {
          np_structure: {
            // Use the per-layer peril scope parsed from the slip
            // instead of forcing every layer to risk+cat. parseNpLayers
            // falls back to both-on when the slip lacks a peril column.
            layers: data.map(l => ({
              layer: `L${l.layer_number}`,
              limit: String(l.limit),
              deductible: String(l.deductible),
              aggregate_limit: String(l.aggregate_limit),
              egnpi: String(l.egnpi),
              rate: String(l.rate),
              earnedPremium: String(l.earned_premium),
              noReinst: String(l.num_reinstatements),
              reinstPct: String(l.reinstatement_pct) + '%',
              riskCover: l.risk_cover !== undefined ? !!l.risk_cover : true,
              catCover:  l.cat_cover  !== undefined ? !!l.cat_cover  : true,
            })),
          },
        },
      }, apiOpts);
    case 'egnpi':
      // Route through saveNpEgnpiYear — the same relational endpoint
      // NpPremiumsTable writes. The old `terms.egnpi_history` key
      // wasn't a recognised JSONB field and the validator silently
      // dropped it, so imports never landed anywhere queryable.
      return api.saveNpEgnpiYear(contractId, {
        rows: data.map(r => ({ uw_year: r.year, egnpi: r.egnpi })),
      }, apiOpts);
    default:
      throw new Error('Unknown sheet type: ' + type);
  }
}
