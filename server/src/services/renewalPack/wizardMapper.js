// Translates a ProportionalExtraction / NonProportionalExtraction
// from extractor.js into per-page write data the page registry can
// persist. One entry per wizard page that the renewal pack actually
// populates — pages with no data don't appear in the output, so the
// orchestrator never touches them (and the snapshot doesn't include
// them either).
//
// CRESTA is the one place we can't blindly write: migration 064 has
// a uniqueness constraint that requires zone_id to match a row in
// public.ref_cresta_zone. Unresolved zones go into unmatchedCresta[]
// + warnings; matched zones get written. Zones with no resolution
// are NOT included in the cresta page write — we never invent zone
// IDs.

const NUMBER_RE = /^-?\d+(?:\.\d+)?$/;

/**
 * @param {object} extraction - The .extraction field returned by extractRenewalPack.
 * @param {object} [opts]
 * @param {'PROPORTIONAL'|'NON_PROPORTIONAL'} [opts.treatyCategory] -
 *   The quote's treaty category, used to gate NP-only or PROP-only
 *   page writes. When omitted, both branches' pages are produced if
 *   the extraction contains them.
 * @param {(args: {countryHint?: string, zoneName: string, zoneCode?: string}) =>
 *          Promise<{ zone_db_id: string, country_id: string|null, zone_id: string, zone_name: string } | null>}
 *   [opts.crestaLookup] - Resolves a CRESTA zone name to a DB row.
 * @returns {Promise<{
 *   pages: Record<string, object>,
 *   fieldConfidence: Record<string, number>,
 *   warnings: string[],
 *   unmatchedCresta: string[],
 * }>}
 */
export async function mapExtractionToPages(extraction, opts = {}) {
  const { crestaLookup, treatyCategory } = opts;
  if (!extraction || typeof extraction !== 'object') {
    throw new Error('mapExtractionToPages: extraction is required');
  }

  const warnings = [];
  const fieldConfidence = {};
  const unmatchedCresta = [];
  const pages = {};

  const setLeaf = (path, leaf) => {
    if (!leaf) return undefined;
    if (typeof leaf.confidence === 'number') fieldConfidence[path] = leaf.confidence;
    return leaf.value;
  };

  // ── proportional branches ────────────────────────────────────────────────
  if (!treatyCategory || treatyCategory === 'PROPORTIONAL') {
    const premiumTri = extraction?.premium?.triangle;
    const claimsTri  = extraction?.claims?.triangle;
    const osTri      = extraction?.osTriangle;

    const premiumCells = trianglesToCells(premiumTri, 'premium.triangle', setLeaf);
    if (premiumCells.length) pages.premium_history = { cells: premiumCells };

    const claimsCells = trianglesToCells(claimsTri, 'claims.triangle', setLeaf);
    const osCells     = trianglesToCells(osTri,    'osTriangle',     setLeaf);
    // One wizard page (claims_history) covers both paid + OS. We keep
    // them as two registry pages internally (one per triangle_type
    // enum) so the snapshot/write helpers stay simple — but they
    // travel together in filledPages reporting.
    if (claimsCells.length) pages.claims_history_paid = { cells: claimsCells };
    if (osCells.length)     pages.claims_history_os   = { cells: osCells };
  }

  // ── non-proportional branches ────────────────────────────────────────────
  if (!treatyCategory || treatyCategory === 'NON_PROPORTIONAL') {
    if (Array.isArray(extraction.layers) && extraction.layers.length) {
      pages.np_structure = { layers: extraction.layers.map((l, i) => mapLayer(l, i, setLeaf)) };
    }
    if (Array.isArray(extraction.egnpiHistory) && extraction.egnpiHistory.length) {
      pages.egnpi_history = { rows: extraction.egnpiHistory.map((r, i) => mapEgnpiRow(r, i, setLeaf)) };
    }
  }

  // ── shared pages (apply to both treaty categories) ───────────────────────
  const largeLossRecords = mapLossRecords(extraction.largeLosses, 'largeLosses', setLeaf);
  const catLossRecords   = mapLossRecords(extraction.catLosses,   'catLosses',   setLeaf);
  if (largeLossRecords.length || catLossRecords.length) {
    pages.large_losses = {
      report_data: { large: largeLossRecords, cat: catLossRecords },
    };
  }

  const crestaRows = await mapCrestaRows(extraction.cresta, setLeaf, { crestaLookup, warnings, unmatchedCresta });
  if (crestaRows.length) pages.cresta = { rows: crestaRows };

  // Cedant / treaty header bits are surfaced as confidences for the
  // UI's "review highlights" affordance, but we don't write them
  // here — treaty detail is filled separately (it's a precondition
  // for this endpoint).
  setLeaf('header.cedant_name', extraction.cedant);
  setLeaf('header.contract_description', extraction.treatyName);
  setLeaf('header.classes', extraction.classes);
  setLeaf('header.uw_year_range', extraction.uwYearRange);

  return { pages, fieldConfidence, warnings, unmatchedCresta };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function trianglesToCells(tri, pathPrefix, setLeaf) {
  if (!tri) return [];
  if (typeof tri.confidence === 'number') {
    setLeaf(`${pathPrefix}.confidence`, { value: tri.confidence, confidence: tri.confidence });
  }
  const uwYears = Array.isArray(tri.uwYears) ? tri.uwYears : [];
  const devPeriods = Array.isArray(tri.devPeriods) ? tri.devPeriods : [];
  const values = Array.isArray(tri.values) ? tri.values : [];

  // Normalise dev periods to months. A pack may carry dev columns as plain
  // integer indices (1, 2, 3, …) rather than months (12, 24, 36); downstream
  // 12/24/36-keyed LDF logic can't match bare indices. The labelling scheme
  // is detected ONCE for the whole header row (F74): the triangle is
  // index-labelled only when its dev periods are exactly the consecutive
  // integer sequence 1..n, and then EVERY column is scaled by 12 — including
  // columns 12 and beyond. The old per-cell `< 12` heuristic split a
  // 13-column index triangle into colliding cells (index 12 → 12 months,
  // same key as index 1 → unique-constraint failure on quote_triangle_cells)
  // and nonsense 13-month periods. Anything not shaped 1..n is treated as
  // already being months for every column.
  const numericDevs = devPeriods.map(Number);
  const isIndexScheme = numericDevs.length > 0
    && numericDevs.every((d) => Number.isInteger(d))
    && [...numericDevs].sort((a, b) => a - b).every((d, i) => d === i + 1);

  const out = [];
  for (let i = 0; i < uwYears.length; i++) {
    const oy = Number(uwYears[i]);
    if (!Number.isFinite(oy)) continue;
    const row = Array.isArray(values[i]) ? values[i] : [];
    for (let j = 0; j < devPeriods.length; j++) {
      const rawDev = Number(devPeriods[j]);
      if (!Number.isFinite(rawDev)) continue;
      const dm = isIndexScheme ? rawDev * 12 : rawDev;
      const cv = row[j];
      if (cv == null) continue;
      const n = Number(cv);
      if (!Number.isFinite(n)) continue;
      out.push({ origin_year: oy, dev_months: dm, cum_value: n });
    }
  }
  return out;
}

function mapLossRecords(records, kind, setLeaf) {
  if (!Array.isArray(records)) return [];
  return records.map((rec, i) => ({
    uwYear: setLeaf(`${kind}[${i}].uwYear`, rec.uwYear),
    insuredName: setLeaf(`${kind}[${i}].insuredName`, rec.insuredName),
    description: setLeaf(`${kind}[${i}].description`, rec.description),
    date: setLeaf(`${kind}[${i}].date`, rec.date),
    classOfBusiness: setLeaf(`${kind}[${i}].classOfBusiness`, rec.classOfBusiness),
    paid: numOrNull(setLeaf(`${kind}[${i}].paid`, rec.paid)),
    os: numOrNull(setLeaf(`${kind}[${i}].os`, rec.os)),
    incurred: numOrNull(setLeaf(`${kind}[${i}].incurred`, rec.incurred)),
  }));
}

async function mapCrestaRows(cresta, setLeaf, { crestaLookup, warnings, unmatchedCresta }) {
  if (!cresta || !Array.isArray(cresta.countries)) return [];
  const out = [];
  for (let ci = 0; ci < cresta.countries.length; ci++) {
    const country = cresta.countries[ci];
    const countryCode = setLeaf(`cresta.countries[${ci}].countryCode`, country.countryCode);
    for (let zi = 0; zi < (country.zones || []).length; zi++) {
      const z = country.zones[zi];
      const path = `cresta.countries[${ci}].zones[${zi}]`;
      const zoneName = setLeaf(`${path}.zoneName`, z.zoneName);
      const zoneCode = setLeaf(`${path}.zoneCode`, z.zoneCode);
      const earthquake = numOrNull(setLeaf(`${path}.earthquake`, z.earthquake));
      const windstorm  = numOrNull(setLeaf(`${path}.windstorm`,  z.windstorm));
      const flood      = numOrNull(setLeaf(`${path}.flood`,      z.flood));
      const srcc       = numOrNull(setLeaf(`${path}.srcc`,       z.srcc));
      const others     = numOrNull(setLeaf(`${path}.others`,     z.others));

      let resolved = null;
      if (crestaLookup && (zoneName || zoneCode)) {
        try {
          resolved = await crestaLookup({
            countryHint: countryCode,
            zoneName: zoneName ?? '',
            zoneCode: zoneCode ?? undefined,
          });
        } catch (err) {
          warnings.push(`CRESTA lookup failed for "${zoneName ?? zoneCode}": ${err?.message || err}`);
        }
      }

      if (!resolved) {
        const label = zoneName || zoneCode || '<unnamed zone>';
        if (!unmatchedCresta.includes(label)) unmatchedCresta.push(label);
        warnings.push(`CRESTA zone "${label}" did not resolve against ref_cresta_zone`);
        continue; // never write a row with an unresolved zone — the slice-uniqueness index won't allow it cleanly
      }

      out.push({
        country_id: resolved.country_id,
        zone_id: resolved.zone_id,
        zone_name: resolved.zone_name,
        eq_agg: earthquake,
        ws_agg: windstorm,
        flood_agg: flood,
        srcc_agg: srcc,
        others_agg: others,
        treaty_type: 'Both',
      });
    }
  }
  return out;
}

function mapLayer(l, i, setLeaf) {
  const path = `np_structure.layers[${i}]`;
  return {
    layer_number: i + 1,
    label: setLeaf(`${path}.layer`, l.layer),
    attachment: numOrNull(setLeaf(`${path}.attachment`, l.attachment)),
    layer_limit: numOrNull(setLeaf(`${path}.limit`, l.limit)),
    aggregate_limit: numOrNull(setLeaf(`${path}.aggLimit`, l.aggLimit)),
    egnpi: numOrNull(setLeaf(`${path}.egnpi`, l.egnpi)),
    rate: numOrNull(setLeaf(`${path}.rate`, l.rate)),
    earned_premium: numOrNull(setLeaf(`${path}.earnedPremium`, l.earnedPremium)),
    mdp: numOrNull(setLeaf(`${path}.mdp`, l.mdp)),
    mdp_pct: numOrNull(setLeaf(`${path}.mdpAlt`, l.mdpAlt)),
    num_reinstatements: numOrNull(setLeaf(`${path}.reinstatements`, l.reinstatements)),
    reinstatement_pct: numOrNull(setLeaf(`${path}.reinstatementPct`, l.reinstatementPct)),
    peril_scope: 'BOTH',
  };
}

function mapEgnpiRow(r, i, setLeaf) {
  return {
    uw_year: numOrNull(setLeaf(`egnpiHistory[${i}].year`, r.year)),
    egnpi: numOrNull(setLeaf(`egnpiHistory[${i}].egnpi`, r.egnpi)),
  };
}

function numOrNull(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  const s = String(v).trim();
  if (!NUMBER_RE.test(s)) {
    const n = Number(s.replace(/,/g, '').replace(/%$/, ''));
    return Number.isFinite(n) ? n : null;
  }
  return Number(s);
}

// ── reporting helper ────────────────────────────────────────────────────────

/**
 * Collapse the registry's split (premium_history, claims_history_paid,
 * claims_history_os) into the wizard-page names the underwriter sees.
 * The split is an implementation detail of how triangle_type is stored;
 * the response shouldn't surface it.
 */
export function userVisibleFilledPages(pageNames) {
  const out = new Set();
  for (const name of pageNames) {
    if (name === 'claims_history_paid' || name === 'claims_history_os') {
      out.add('claims_history');
    } else {
      out.add(name);
    }
  }
  return Array.from(out);
}
