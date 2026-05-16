// Maps a validated ProportionalExtraction / NonProportionalExtraction
// from extractor.js into the shape the existing quote wizard hydrates
// from — see GET /api/quotes/:id in server/src/routes/quotes.js and the
// quotePutBodySchema in validation/quote.js.
//
// Two things to keep in mind:
//   1. Real FKs (cedant_id, broker_id, country_id, currency_id,
//      treaty_type_id, class_of_business_id) live in lookup tables on
//      the server. The extractor gives us *names*, not UUIDs. The mapper
//      surfaces those names in dedicated `*_name` fields and leaves the
//      FK columns null — the reviewer screen resolves them before save.
//   2. CRESTA zones MUST match an entry in ref_cresta_zone (per the
//      uniqueness constraint added in migration 064 on quote_cresta_data).
//      The mapper takes an injected `crestaLookup` so the unit tests can
//      run without DB access. Anything that doesn't resolve goes into
//      unmatchedCresta[] + warnings[] and is left out of the wizard
//      state — we never invent zone IDs.

const NUMBER_RE = /^-?\d+(?:\.\d+)?$/;

/**
 * @param {object} extraction - The .extraction field returned by extractRenewalPack.
 * @param {'proportional'|'non_proportional'} extraction's matching schema is enforced upstream.
 * @param {object} [opts]
 * @param {(args: {countryHint?: string, zoneName: string, zoneCode?: string}) =>
 *          Promise<{ zone_db_id: string, country_id: string|null, zone_id: string, zone_name: string } | null>}
 *        [opts.crestaLookup] - Resolves a CRESTA zone name to a DB row.
 *        When omitted, every CRESTA zone falls into unmatchedCresta.
 * @returns {Promise<{
 *   wizardState: object,
 *   fieldConfidence: Record<string, number>,
 *   warnings: string[],
 *   unmatchedCresta: string[]
 * }>}
 */
export async function mapExtractionToWizardState(extraction, opts = {}) {
  const { crestaLookup } = opts;
  if (!extraction || typeof extraction !== 'object') {
    throw new Error('mapExtractionToWizardState: extraction is required');
  }

  const warnings = [];
  const fieldConfidence = {};
  const unmatchedCresta = [];

  const setLeaf = (path, leaf) => {
    if (!leaf) return undefined;
    fieldConfidence[path] = typeof leaf.confidence === 'number' ? leaf.confidence : 0;
    return leaf.value;
  };

  // ── header (shared) ────────────────────────────────────────────────────────
  const cedant = setLeaf('header.cedant_name', extraction.cedant);
  const treatyName = setLeaf('header.contract_description', extraction.treatyName);
  const classes = setLeaf('header.classes', extraction.classes);
  const uwRange = setLeaf('header.uw_year_range', extraction.uwYearRange);

  // Pick the maximum UW year from the range — convention used elsewhere
  // in the wizard for "this renewal" (the prior years are historical).
  let inferredUwYear = null;
  if (Array.isArray(uwRange) && uwRange.length === 2 && Number.isFinite(uwRange[1])) {
    inferredUwYear = Math.max(Math.trunc(uwRange[0]), Math.trunc(uwRange[1]));
  }

  const header = {
    cedant_id: null,
    cedant_name: cedant ?? null,
    broker_id: null,
    currency_id: null,
    country_id: null,
    treaty_type_id: null,
    uw_year: inferredUwYear,
    status: 'DRAFT',
    experience_source: 'TRIANGLE',
    renewal_date: null,
    inception_date: null,
    contract_description: treatyName ?? null,
    classes_text: Array.isArray(classes) ? classes : [],
  };

  // ── detail (shared scalar bits) ────────────────────────────────────────────
  const detail = {
    triangulations_available: !!extraction.hasTriangles,
    experience_start_year: inferredUwYearStart(uwRange),
    inception_date: null,
    renewal_date: null,
    qs_limit: null,
    retention_pct: null,
    retention_amt: null,
    cession_pct: null,
    cession_amt: null,
    surplus_max_retention: null,
    num_lines: null,
    total_capacity: null,
    event_limit: null,
    aal: null,
    quota_share_epi: null,
    surplus_epi: null,
    brokerage_pct: null,
    taxes_pct: null,
    loss_cap_pct: null,
  };

  // ── losses + profiles + cresta (shared) ────────────────────────────────────
  const largeLosses = mapLosses(extraction.largeLosses, 'largeLosses', setLeaf);
  const catLosses = mapLosses(extraction.catLosses, 'catLosses', setLeaf);
  const riskProfile = mapProfileBooks(extraction.riskProfile, 'riskProfile', setLeaf);
  const claimsProfile = mapProfileBooks(extraction.claimsProfile, 'claimsProfile', setLeaf);
  const cresta = await mapCresta(extraction.cresta, setLeaf, { crestaLookup, warnings, unmatchedCresta });

  // ── proportional vs non-proportional branches ──────────────────────────────
  let triangles = null;
  let npStructure = null;
  let egnpiHistory = null;
  const skipTriangleScreens = !extraction.hasTriangles;

  if ('premium' in extraction || 'claims' in extraction || 'osTriangle' in extraction) {
    // Proportional
    if (extraction.hasTriangles) {
      triangles = {
        premium: mapTriangle(extraction.premium?.triangle, 'premium.triangle', setLeaf),
        claims:  mapTriangle(extraction.claims?.triangle, 'claims.triangle', setLeaf),
        os:      mapTriangle(extraction.osTriangle, 'osTriangle', setLeaf),
      };
    }
    const latestEarned     = setLeaf('premium.latestEarned',     extraction.premium?.latestEarned);
    const growthAssumption = setLeaf('premium.growthAssumption', extraction.premium?.growthAssumption);
    const ultimateLossRatio= setLeaf('claims.ultimateLossRatio', extraction.claims?.ultimateLossRatio);
    detail.quota_share_epi = numOrNull(latestEarned);
    // The wizard exposes growthAssumption + ultimateLossRatio in the
    // pricing pages; the import flow stashes them on the detail blob so
    // the underwriter can review/override before pricing runs.
    detail.growth_assumption_pct = numOrNull(growthAssumption);
    detail.ultimate_loss_ratio_pct = numOrNull(ultimateLossRatio);
  } else if ('layers' in extraction || 'egnpiHistory' in extraction) {
    // Non-proportional
    npStructure = mapLayers(extraction.layers, setLeaf);
    egnpiHistory = mapEgnpiHistory(extraction.egnpiHistory, setLeaf);
    detail.number_of_layers = Array.isArray(npStructure?.layers) ? npStructure.layers.length : null;
    detail.est_gnpi = sumEgnpiLatest(egnpiHistory);
  } else {
    warnings.push('Extraction had neither proportional nor non-proportional fields; nothing to map');
  }

  // ── final wizardState shape (matches GET /api/quotes/:id) ──────────────────
  const wizardState = {
    header,
    detail,
    commissions: { mode: 'FIXED' },
    lossParticipation: { enabled: false },
    epi_split: [],
    class_ids: [],
    underwriting_limits: [],
    triangles,
    largeLosses,
    catLosses,
    riskProfile,
    claimsProfile,
    cresta,
    skipTriangleScreens,
    np_structure: npStructure,
    egnpi_history: egnpiHistory,
  };

  return { wizardState, fieldConfidence, warnings, unmatchedCresta };
}

// ── helpers ──────────────────────────────────────────────────────────────────

function mapTriangle(tri, pathPrefix, setLeaf) {
  if (!tri) return null;
  if (typeof tri.confidence === 'number') {
    setLeaf(`${pathPrefix}.confidence`, { value: tri.confidence, confidence: tri.confidence, source: tri.source });
  }
  return {
    uwYears: Array.isArray(tri.uwYears) ? tri.uwYears.slice() : [],
    devPeriods: Array.isArray(tri.devPeriods) ? tri.devPeriods.slice() : [],
    values: Array.isArray(tri.values) ? tri.values.map((row) => Array.isArray(row) ? row.slice() : []) : [],
    source: tri.source ?? null,
  };
}

function mapLosses(records, kind, setLeaf) {
  if (!Array.isArray(records)) return [];
  return records.map((rec, i) => {
    const out = {};
    out.uwYear         = setLeaf(`${kind}[${i}].uwYear`,          rec.uwYear);
    out.insuredName    = setLeaf(`${kind}[${i}].insuredName`,     rec.insuredName);
    out.description    = setLeaf(`${kind}[${i}].description`,     rec.description);
    out.date           = setLeaf(`${kind}[${i}].date`,            rec.date);
    out.classOfBusiness= setLeaf(`${kind}[${i}].classOfBusiness`, rec.classOfBusiness);
    out.paid           = numOrNull(setLeaf(`${kind}[${i}].paid`,     rec.paid));
    out.os             = numOrNull(setLeaf(`${kind}[${i}].os`,       rec.os));
    out.incurred       = numOrNull(setLeaf(`${kind}[${i}].incurred`, rec.incurred));
    out.is_selected = true; // default selected — UI lets reviewer toggle off
    return out;
  });
}

function mapProfileBooks(profile, kind, setLeaf) {
  if (!profile || !Array.isArray(profile.books)) return { books: [] };
  const books = profile.books.map((book, bi) => ({
    label: typeof book.label === 'string' ? book.label : `Profile ${bi + 1}`,
    bands: (book.bands || []).map((band, bj) => {
      const path = `${kind}.books[${bi}].bands[${bj}]`;
      return {
        band_min:        numOrNull(setLeaf(`${path}.bandMin`,        band.bandMin)),
        band_max:        numOrNull(setLeaf(`${path}.bandMax`,        band.bandMax)),
        num_policies:    numOrNull(setLeaf(`${path}.numPolicies`,    band.numPolicies)),
        sum_insured:     numOrNull(setLeaf(`${path}.sumInsured`,     band.sumInsured)),
        premiums:        numOrNull(setLeaf(`${path}.premiums`,       band.premiums)),
        avg_sum_insured: numOrNull(setLeaf(`${path}.avgSumInsured`,  band.avgSumInsured)),
        avg_premium:     numOrNull(setLeaf(`${path}.avgPremium`,     band.avgPremium)),
        rate_pct:        numOrNull(setLeaf(`${path}.ratePct`,        band.ratePct)),
      };
    }),
    source: book.source ?? null,
  }));
  return { books };
}

async function mapCresta(cresta, setLeaf, { crestaLookup, warnings, unmatchedCresta }) {
  if (!cresta || !Array.isArray(cresta.countries)) return { zones: [] };
  const zones = [];
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

      const zoneRow = {
        country_id: resolved?.country_id ?? null,
        country_code: countryCode ?? null,
        zone_id: resolved?.zone_id ?? null,
        zone_name: resolved?.zone_name ?? zoneName ?? null,
        zone_db_id: resolved?.zone_db_id ?? null,
        eq_agg: earthquake,
        ws_agg: windstorm,
        flood_agg: flood,
        srcc_agg: srcc,
        others_agg: others,
        needsManualCrestaMatch: !resolved,
      };
      if (!resolved) {
        const label = zoneName || zoneCode || '<unnamed zone>';
        if (!unmatchedCresta.includes(label)) unmatchedCresta.push(label);
        warnings.push(`CRESTA zone "${label}" did not resolve against ref_cresta_zone`);
      }
      zones.push(zoneRow);
    }
  }
  return { zones };
}

function mapLayers(layers, setLeaf) {
  if (!Array.isArray(layers)) return { layers: [] };
  const out = layers.map((l, i) => {
    const path = `np_structure.layers[${i}]`;
    return {
      layer_number: i + 1,
      label:             setLeaf(`${path}.layer`,            l.layer),
      attachment:        numOrNull(setLeaf(`${path}.attachment`,    l.attachment)),
      layer_limit:       numOrNull(setLeaf(`${path}.limit`,         l.limit)),
      aggregate_limit:   numOrNull(setLeaf(`${path}.aggLimit`,      l.aggLimit)),
      egnpi:             numOrNull(setLeaf(`${path}.egnpi`,         l.egnpi)),
      rate:              numOrNull(setLeaf(`${path}.rate`,          l.rate)),
      earned_premium:    numOrNull(setLeaf(`${path}.earnedPremium`, l.earnedPremium)),
      mdp:               numOrNull(setLeaf(`${path}.mdp`,           l.mdp)),
      mdp_alt:           numOrNull(setLeaf(`${path}.mdpAlt`,        l.mdpAlt)),
      num_reinstatements: numOrNull(setLeaf(`${path}.reinstatements`,    l.reinstatements)),
      reinstatement_pct:  numOrNull(setLeaf(`${path}.reinstatementPct`, l.reinstatementPct)),
    };
  });
  return { layers: out };
}

function mapEgnpiHistory(egnpiHistory, setLeaf) {
  if (!Array.isArray(egnpiHistory)) return [];
  return egnpiHistory.map((row, i) => ({
    uw_year: numOrNull(setLeaf(`egnpiHistory[${i}].year`,  row.year)),
    egnpi:   numOrNull(setLeaf(`egnpiHistory[${i}].egnpi`, row.egnpi)),
  }));
}

function sumEgnpiLatest(history) {
  if (!Array.isArray(history) || !history.length) return null;
  // Latest year (max uw_year) → its egnpi.
  let best = null;
  for (const r of history) {
    if (r.uw_year == null) continue;
    if (!best || r.uw_year > best.uw_year) best = r;
  }
  return best?.egnpi ?? null;
}

function inferredUwYearStart(uwRange) {
  if (Array.isArray(uwRange) && uwRange.length === 2 && Number.isFinite(uwRange[0])) {
    return Math.trunc(uwRange[0]);
  }
  return null;
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
