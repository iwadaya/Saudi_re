// Renewal-pack Excel parser.
//
// Ingests a .xlsx workbook (broker / cedant pack) and produces a normalized
// JSON shape that downstream loaders / pricers can consume. The classifier
// here is deterministic — no LLMs, no fuzzy heuristics that depend on
// statistics. Sheet recognition is by name + header pattern only.
//
// Schema:
//   {
//     type: 'proportional' | 'non_proportional',
//     cedant: string | null,
//     classes: string[],
//     uwYearRange: [minYear, maxYear] | null,
//     sheets: {
//       premiumTriangle?:   { uwYears, devPeriods, values },
//       claimsTriangle?:    { uwYears, devPeriods, values },
//       osClaimsTriangle?:  { uwYears, devPeriods, values },
//       largeLossRecords?:  Array<{...}>,
//       catLossRecords?:    Array<{...}>,
//       riskProfile?:       Array<{ label, rows }>,
//       claimsProfile?:     Array<{ label, rows }>,
//       crestaZones?:       Array<{...}>,
//       treatyLayers?:      Array<{ layer, limit, attachment, aggLimit, egnpi,
//                                   rate, earnedPremium, mdp, mdpAlt,
//                                   reinstatements, reinstatementPct }>,
//       egnpi?:             Array<{ year, egnpi }>,
//       cover?:             { fields: Record<string, any>, raw: rows },
//     },
//     unknown: Array<{ name, rows }>,
//     warnings: string[]
//   }
//
// Unknown sheets are preserved (not thrown) so a downstream UI can still
// surface them for manual review.

import ExcelJS from 'exceljs';

// ── resource caps ───────────────────────────────────────────────────────────
// A crafted .xlsx can declare an enormous used range or a huge number of
// sheets and blow up memory when we materialize every cell in sheetToRaw().
// These caps are set safely above any real renewal pack (which are a handful
// of sheets with thousands of rows at most) and abort with a clear error when
// exceeded, before any per-cell work happens.
const MAX_SHEETS = 50;
const MAX_ROWS_PER_SHEET = 100_000;
const MAX_COLS_PER_SHEET = 1000;
const MAX_TOTAL_CELLS = 5_000_000;

// ── public API ────────────────────────────────────────────────────────────────

/**
 * Parse a renewal pack workbook.
 *
 * @param {Buffer|ArrayBuffer|Uint8Array|string} input - workbook bytes or a path.
 * @returns {Promise<object>} normalized renewal-pack JSON (see schema above).
 */
export async function parseRenewalPack(input) {
  const workbook = await loadWorkbook(input);
  assertWorkbookWithinCaps(workbook);
  const rawSheets = workbook.worksheets.map(sheetToRaw);
  const sheets = rawSheets.map((s) => ({ name: s.name, rows: trimEmptyEdges(s.rows) }));

  const warnings = [];
  const type = classifyType(sheets);

  const known = {};
  const unknown = [];

  for (const sheet of sheets) {
    const kind = detectSheetKind(sheet.name);
    if (!kind) {
      unknown.push({ name: sheet.name, rows: sheet.rows });
      continue;
    }
    try {
      const parsed = extractByKind(kind, sheet, warnings);
      if (parsed != null) {
        // Two sheets that map to the same kind (e.g. "Claims Profile" +
        // "Claims Profile 2") get merged when the extractor returns an
        // array; otherwise the later sheet wins and we warn.
        if (Array.isArray(known[kind]) && Array.isArray(parsed)) {
          known[kind] = known[kind].concat(parsed);
        } else if (known[kind] != null) {
          warnings.push(`Sheet "${sheet.name}" replaces earlier ${kind} extraction`);
          known[kind] = parsed;
        } else {
          known[kind] = parsed;
        }
      }
    } catch (err) {
      warnings.push(`Failed to parse sheet "${sheet.name}" as ${kind}: ${err.message}`);
      unknown.push({ name: sheet.name, rows: sheet.rows });
    }
  }

  const meta = extractMeta(sheets, known);

  return {
    type,
    cedant: meta.cedant,
    classes: meta.classes,
    uwYearRange: meta.uwYearRange,
    sheets: known,
    unknown,
    warnings,
  };
}

// ── workbook loading ──────────────────────────────────────────────────────────

// Reject workbooks that exceed the resource caps before we materialize any
// cells. Checked against ExcelJS's declared dimensions (rowCount/columnCount),
// so a hostile "used range" is caught without allocating for it.
function assertWorkbookWithinCaps(workbook) {
  const sheets = workbook.worksheets || [];
  if (sheets.length > MAX_SHEETS) {
    throw new Error(
      `Renewal pack has too many worksheets (${sheets.length} > ${MAX_SHEETS}).`,
    );
  }
  let totalCells = 0;
  for (const ws of sheets) {
    const rowCount = ws.rowCount || 0;
    const colCount = ws.columnCount || 0;
    if (rowCount > MAX_ROWS_PER_SHEET) {
      throw new Error(
        `Worksheet "${ws.name}" has too many rows (${rowCount} > ${MAX_ROWS_PER_SHEET}).`,
      );
    }
    if (colCount > MAX_COLS_PER_SHEET) {
      throw new Error(
        `Worksheet "${ws.name}" has too many columns (${colCount} > ${MAX_COLS_PER_SHEET}).`,
      );
    }
    totalCells += rowCount * colCount;
    if (totalCells > MAX_TOTAL_CELLS) {
      throw new Error(
        `Renewal pack exceeds the maximum cell budget (> ${MAX_TOTAL_CELLS} cells).`,
      );
    }
  }
}

async function loadWorkbook(input) {
  const wb = new ExcelJS.Workbook();
  if (typeof input === 'string') {
    await wb.xlsx.readFile(input);
    return wb;
  }
  if (input instanceof Uint8Array && !Buffer.isBuffer(input)) {
    await wb.xlsx.load(input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength));
    return wb;
  }
  if (Buffer.isBuffer(input)) {
    await wb.xlsx.load(input);
    return wb;
  }
  if (input instanceof ArrayBuffer) {
    await wb.xlsx.load(input);
    return wb;
  }
  throw new Error('parseRenewalPack: input must be a path, Buffer, ArrayBuffer, or Uint8Array');
}

function sheetToRaw(ws) {
  const rows = [];
  const rowCount = ws.rowCount || 0;
  for (let r = 1; r <= rowCount; r++) {
    const row = ws.getRow(r);
    const width = row.cellCount || (row.values?.length ? row.values.length - 1 : 0);
    const arr = [];
    for (let c = 1; c <= width; c++) {
      arr.push(normalizeCell(row.getCell(c).value));
    }
    rows.push(arr);
  }
  return { name: ws.name, rows };
}

// ExcelJS exposes richer cell types than the legacy `xlsx` package.
// Collapse to scalars so downstream code stays simple.
function normalizeCell(v) {
  if (v == null) return null;
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (Array.isArray(v.richText)) return v.richText.map((r) => r.text).join('');
    if ('result' in v) return normalizeCell(v.result);
    if ('text' in v || 'hyperlink' in v) return v.text ?? v.hyperlink ?? '';
    if ('error' in v) return null;
  }
  return v;
}

function trimEmptyEdges(rows) {
  let start = 0;
  while (start < rows.length && isEmptyRow(rows[start])) start++;
  let end = rows.length;
  while (end > start && isEmptyRow(rows[end - 1])) end--;
  return rows.slice(start, end);
}

function isEmptyRow(row) {
  if (!row || row.length === 0) return true;
  return row.every((v) => v == null || (typeof v === 'string' && v.trim() === ''));
}

// ── type classification ───────────────────────────────────────────────────────

function classifyType(sheets) {
  const names = sheets.map((s) => String(s.name || ''));
  const hasTreatyLayers = names.some((n) => /treaty\s*layers?/i.test(n));
  const hasEgnpi = names.some((n) => /^\s*egnpi\s*$/i.test(n));
  return hasTreatyLayers || hasEgnpi ? 'non_proportional' : 'proportional';
}

// ── sheet kind detection ──────────────────────────────────────────────────────

const SHEET_KIND_PATTERNS = [
  // Order matters: more-specific patterns (OS Claims, Cat Loss) before generic.
  { kind: 'osClaimsTriangle', re: /\bo\.?s\.?\b.*claims?.*triangle|os\s*claims?\s*triangle/i },
  { kind: 'premiumTriangle', re: /premium\s*triangle/i },
  { kind: 'claimsTriangle', re: /(?<!os\s)(claims?|paid)\s*triangle/i },
  { kind: 'catLossRecords', re: /(cat|catastrophe)\s*loss(es)?(\s*records?)?/i },
  { kind: 'largeLossRecords', re: /large\s*loss(es)?(\s*records?)?/i },
  { kind: 'claimsProfile', re: /claims?\s*profile/i },
  { kind: 'riskProfile', re: /risk\s*profile/i },
  { kind: 'crestaZones', re: /cresta(\s*zones?)?/i },
  { kind: 'treatyLayers', re: /treaty\s*layers?/i },
  { kind: 'egnpi', re: /^\s*egnpi\s*$/i },
  { kind: 'cover', re: /^\s*cover\s*$/i },
];

function detectSheetKind(name) {
  const n = String(name || '');
  for (const { kind, re } of SHEET_KIND_PATTERNS) {
    if (re.test(n)) return kind;
  }
  return null;
}

// ── extractor dispatch ────────────────────────────────────────────────────────

function extractByKind(kind, sheet, warnings) {
  switch (kind) {
    case 'premiumTriangle':
    case 'claimsTriangle':
    case 'osClaimsTriangle':
      return extractTriangle(sheet, warnings);
    case 'largeLossRecords':
      return extractLossRecords(sheet, /*isCat=*/ false);
    case 'catLossRecords':
      return extractLossRecords(sheet, /*isCat=*/ true);
    case 'riskProfile':
      return extractBandedProfile(sheet, /^risk\s*profil/i);
    case 'claimsProfile':
      return extractBandedProfile(sheet, /^claims?\s*profil/i);
    case 'crestaZones':
      return extractCrestaZones(sheet);
    case 'treatyLayers':
      return extractTreatyLayers(sheet);
    case 'egnpi':
      return extractEgnpi(sheet);
    case 'cover':
      return extractCover(sheet);
    default:
      return null;
  }
}

// ── extractors ────────────────────────────────────────────────────────────────

function extractTriangle(sheet, warnings) {
  const rows = sheet.rows;
  const headerIdx = rows.findIndex((r) => {
    const first = String(r?.[0] ?? '').toUpperCase();
    if (!/UW|YEAR/.test(first)) return false;
    // header row must have at least 2 dev columns
    return r.slice(1).filter((v) => v != null && v !== '').length >= 1;
  });
  if (headerIdx < 0) {
    warnings.push(`Triangle in "${sheet.name}": header row not found`);
    return { uwYears: [], devPeriods: [], values: [] };
  }
  const devPeriods = rows[headerIdx]
    .slice(1)
    .map((v) => toNumberOrNull(v))
    .filter((v) => v != null && Number.isFinite(v));

  const uwYears = [];
  const values = [];
  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    const yearCell = row?.[0];
    const year = toIntOrNull(yearCell);
    if (year == null || year < 1900 || year > 2200) continue;
    uwYears.push(year);
    const lineValues = devPeriods.map((_, j) => toNumberOrNull(row[j + 1]));
    values.push(lineValues);
  }
  return { uwYears, devPeriods, values };
}

function extractLossRecords(sheet, isCat) {
  const rows = sheet.rows;
  const headerIdx = findHeaderRow(rows, ['UW', 'YEAR']);
  const start = headerIdx >= 0 ? headerIdx + 1 : 0;
  const out = [];
  for (let i = start; i < rows.length; i++) {
    const r = rows[i];
    const year = toIntOrNull(r?.[0]);
    if (year == null || year < 1900 || year > 2200) continue;
    const rec = {
      uwYear: year,
      insuredName: toStr(r[1]),
      [isCat ? 'eventName' : 'lossName']: toStr(r[2]),
      [isCat ? 'dateOfEvent' : 'dateOfLoss']: toStr(r[3]),
      classOfBusiness: toStr(r[4]),
      paid: toNumberOrZero(r[5]),
      os: toNumberOrZero(r[6]),
      incurred: toNumberOrZero(r[7]),
    };
    out.push(rec);
  }
  return out;
}

function extractBandedProfile(sheet, labelRegex) {
  const rows = sheet.rows;
  const profiles = [];
  let currentLabel = null;
  let dataRows = [];
  let inProfile = false;

  const pushCurrent = () => {
    if (dataRows.length) {
      profiles.push({ label: currentLabel || `Profile ${profiles.length + 1}`, rows: dataRows });
    }
    dataRows = [];
  };

  for (const row of rows) {
    const first = toStr(row?.[0]);
    const firstUpper = first.toUpperCase();
    if (!first) continue;
    if (labelRegex.test(first)) {
      pushCurrent();
      currentLabel = first;
      inProfile = true;
      continue;
    }
    if (firstUpper === 'MIN BAND' || firstUpper.startsWith('MIN BAND')) {
      inProfile = true;
      continue;
    }
    if (!inProfile) continue;
    if (firstUpper === 'TOTAL') continue;

    // Band rows have numeric min/max in cols 0/1.
    const min = toNumberOrNull(row[0]);
    const max = toNumberOrNull(row[1]);
    if (min == null && max == null) continue;
    dataRows.push({
      bandMin: min ?? 0,
      bandMax: max ?? 0,
      numPolicies: toNumberOrZero(row[2]),
      sumInsured: toNumberOrZero(row[3]),
      premiums: toNumberOrZero(row[4]),
      avgSumInsured: toNumberOrZero(row[5]),
      avgPremium: toNumberOrZero(row[6]),
      ratePct: toNumberOrZero(row[7]),
    });
  }
  pushCurrent();

  // No explicit label header — assume the whole sheet is one profile.
  if (!profiles.length && rows.length) {
    const fallback = [];
    for (const row of rows) {
      const min = toNumberOrNull(row?.[0]);
      const max = toNumberOrNull(row?.[1]);
      if (min == null && max == null) continue;
      fallback.push({
        bandMin: min ?? 0,
        bandMax: max ?? 0,
        numPolicies: toNumberOrZero(row[2]),
        sumInsured: toNumberOrZero(row[3]),
        premiums: toNumberOrZero(row[4]),
        avgSumInsured: toNumberOrZero(row[5]),
        avgPremium: toNumberOrZero(row[6]),
        ratePct: toNumberOrZero(row[7]),
      });
    }
    if (fallback.length) profiles.push({ label: 'Profile 1', rows: fallback });
  }

  return profiles;
}

function extractCrestaZones(sheet) {
  const rows = sheet.rows;
  const headerIdx = findHeaderRow(rows, ['ZONE']);
  const start = headerIdx >= 0 ? headerIdx + 1 : 0;
  const out = [];
  for (let i = start; i < rows.length; i++) {
    const r = rows[i];
    const code = toStr(r?.[0]);
    if (!code) continue;
    if (code.toUpperCase() === 'TOTAL') continue;
    out.push({
      zoneCode: code,
      zoneName: toStr(r[1]),
      earthquake: toNumberOrZero(r[2]),
      windstorm: toNumberOrZero(r[3]),
      flood: toNumberOrZero(r[4]),
      srcc: toNumberOrZero(r[5]),
      others: toNumberOrZero(r[6]),
    });
  }
  return out;
}

function extractTreatyLayers(sheet) {
  const rows = sheet.rows;
  const headerIdx = findHeaderRow(rows, ['LAYER']);
  const start = headerIdx >= 0 ? headerIdx + 1 : 0;
  const out = [];
  for (let i = start; i < rows.length; i++) {
    const r = rows[i];
    const layerCell = r?.[0];
    if (layerCell == null || layerCell === '') continue;
    const layerStr = toStr(layerCell);
    if (!layerStr || /^total/i.test(layerStr)) continue;
    // Accept either pure-number layer cells ("1", "2") or labelled ("L1", "Layer 1").
    const num = toIntOrNull(layerCell);
    const isValidLayer = num != null || /^l?\s*\d+/i.test(layerStr);
    if (!isValidLayer) continue;

    out.push({
      layer: layerStr,
      limit: toNumberOrZero(r[1]),
      attachment: toNumberOrZero(r[2]),
      aggLimit: toNumberOrZero(r[3]),
      egnpi: toNumberOrZero(r[4]),
      rate: toNumberOrZero(r[5]),
      earnedPremium: toNumberOrZero(r[6]),
      mdp: toNumberOrZero(r[7]),
      mdpAlt: toNumberOrZero(r[8]),
      reinstatements: toNumberOrZero(r[9]),
      reinstatementPct: toNumberOrZero(r[10]),
    });
  }
  return out;
}

function extractEgnpi(sheet) {
  const rows = sheet.rows;
  const out = [];
  for (const r of rows) {
    const year = toIntOrNull(r?.[0]);
    if (year == null || year < 1900 || year > 2200) continue;
    out.push({ year, egnpi: toNumberOrZero(r[1]) });
  }
  return out;
}

// "Cover" pages are usually a free-form key/value summary (cedant, classes,
// inception, etc). We do a best-effort 2-column scan and keep the raw rows
// so a downstream reviewer can still see anything we missed.
function extractCover(sheet) {
  const fields = {};
  for (const row of sheet.rows) {
    const key = toStr(row?.[0]);
    if (!key) continue;
    const val = row[1];
    if (val == null || val === '') continue;
    const slug = slugifyKey(key);
    if (!slug) continue;
    if (!(slug in fields)) fields[slug] = typeof val === 'string' ? val.trim() : val;
  }
  return { fields, raw: sheet.rows };
}

// ── meta extraction ───────────────────────────────────────────────────────────

function extractMeta(sheets, known) {
  const cover = sheets.find((s) => /^\s*cover\s*$/i.test(s.name));
  const coverFields = cover ? extractCover(cover).fields : {};
  const cedant = coverFields.cedant || coverFields.client || coverFields.reinsured || null;
  const classes = parseClassesField(coverFields);

  const years = collectAllUwYears(known);
  const uwYearRange = years.length ? [Math.min(...years), Math.max(...years)] : null;

  return { cedant, classes, uwYearRange };
}

function parseClassesField(coverFields) {
  const raw = coverFields.classOfBusiness || coverFields.classesOfBusiness || coverFields.class || coverFields.classes;
  if (!raw) return [];
  if (Array.isArray(raw)) return raw.map(String).map((s) => s.trim()).filter(Boolean);
  return String(raw)
    .split(/[,;/&]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function collectAllUwYears(known) {
  const years = new Set();
  for (const tri of ['premiumTriangle', 'claimsTriangle', 'osClaimsTriangle']) {
    const t = known[tri];
    if (t?.uwYears) for (const y of t.uwYears) if (y != null) years.add(y);
  }
  for (const list of ['largeLossRecords', 'catLossRecords']) {
    const l = known[list];
    if (Array.isArray(l)) for (const rec of l) if (rec.uwYear != null) years.add(rec.uwYear);
  }
  if (Array.isArray(known.egnpi)) for (const rec of known.egnpi) if (rec.year != null) years.add(rec.year);
  return [...years];
}

// ── small parsing helpers ─────────────────────────────────────────────────────

function findHeaderRow(rows, mustContain) {
  for (let i = 0; i < rows.length; i++) {
    const first = String(rows[i]?.[0] ?? '').toUpperCase();
    if (mustContain.every((needle) => first.includes(needle))) return i;
  }
  return -1;
}

function toStr(v) {
  if (v == null) return '';
  if (typeof v === 'string') return v.trim();
  return String(v).trim();
}

function toNumberOrNull(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).replace(/,/g, '').replace(/%$/, '').trim();
  if (s === '') return null;
  const n = Number.parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

function toNumberOrZero(v) {
  const n = toNumberOrNull(v);
  return n == null ? 0 : n;
}

function toIntOrNull(v) {
  const n = toNumberOrNull(v);
  if (n == null) return null;
  return Math.trunc(n);
}

function slugifyKey(s) {
  return String(s)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .map((w, i) => (i === 0 ? w : w[0].toUpperCase() + w.slice(1)))
    .join('');
}
