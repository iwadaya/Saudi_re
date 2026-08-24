// load-test/agents/lib/gen.js
//
// Deterministic seeded generators for the underwriter-agent simulation.
// Every agent gets its own RNG stream (seed = runSeed + agentIndex), so a
// run is reproducible and two agents never contend on Math.random state.

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rnd() {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export class Rng {
  constructor(seed) { this.rnd = mulberry32(seed); }
  float(min, max) { return this.rnd() * (max - min) + min; }
  int(min, max) { return Math.floor(this.float(min, max + 1)); }
  pick(arr) { return arr[Math.floor(this.rnd() * arr.length)]; }
  money(min, max, step = 1000) { return Math.round(this.float(min, max) / step) * step; }
  pct(min, max) { return Math.round(this.float(min, max) * 100) / 100; }
  chance(p) { return this.rnd() < p; }
  sample(arr, n) {
    const c = [...arr];
    for (let i = c.length - 1; i > 0; i -= 1) {
      const j = Math.floor(this.rnd() * (i + 1));
      [c[i], c[j]] = [c[j], c[i]];
    }
    return c.slice(0, Math.min(n, c.length));
  }
}

// 40 distinct underwriter names (deterministic; index-addressable).
const FIRST = ['Amara', 'Kofi', 'Nia', 'Tunde', 'Zainab', 'Ekow', 'Femi', 'Adjoa',
  'Kwame', 'Abena', 'Yusuf', 'Esi', 'Chidi', 'Afia', 'Sefu', 'Nana',
  'Idris', 'Ama', 'Kojo', 'Lamis', 'Baraka', 'Efua', 'Jelani', 'Akosua',
  'Faisal', 'Adwoa', 'Obi', 'Yaa', 'Salim', 'Akua', 'Musa', 'Aba',
  'Tariq', 'Araba', 'Zuberi', 'Ekua', 'Hamid', 'Aya', 'Rafiq', 'Serwa'];
const LAST = ['Boateng', 'Mensah', 'Okafor', 'Adeyemi', 'Haddad', 'Asante', 'Balogun', 'Owusu',
  'Ampofo', 'Darko', 'Rahman', 'Appiah', 'Eze', 'Osei', 'Mwangi', 'Agyeman',
  'Diallo', 'Acheampong', 'Antwi', 'Nasser', 'Juma', 'Quartey', 'Kamau', 'Frimpong',
  'Zahrani', 'Bediako', 'Nwosu', 'Asantewaa', 'Farsi', 'Addo', 'Kone', 'Yeboah',
  'Amin', 'Sarpong', 'Otieno', 'Ansah', 'Karimi', 'Tetteh', 'Aziz', 'Gyasi'];

export function underwriterName(i) {
  return `${FIRST[i % FIRST.length]} ${LAST[i % LAST.length]}`;
}

const TREATY_DESCRIPTORS = ['Motor', 'Property', 'Marine Cargo', 'Engineering', 'General Accident',
  'Fire & Allied Perils', 'Casualty', 'Energy', 'Aviation', 'Bond & Credit'];

/**
 * Generate the terms an agent writes to a PROPORTIONAL treaty, as three
 * wizard-style slices (the app saves per-screen, so the sim does too).
 * Returns { create, sliceHeaderDetail, sliceCommissions, sliceStructure }.
 */
export function propTreatyPlan(rng, refs, uwYear) {
  const cedant = rng.pick(refs.cedants);
  const broker = rng.pick(refs.brokers);
  const currency = rng.pick(refs.currencies);
  const country = rng.pick(refs.countries);
  const type = rng.pick(refs.treatyTypes.filter((t) => t.category === 'PROPORTIONAL'));
  const cobs = rng.sample(refs.cobs, rng.int(1, 3));
  const inception = `${uwYear}-01-01`;
  const renewal = `${uwYear + 1}-01-01`;
  const description = `${cedant.name.split(' ')[0]} ${rng.pick(TREATY_DESCRIPTORS)} ${type.name} ${uwYear}`;

  const create = {
    uw_year: uwYear,
    cedant_id: cedant.id,
    broker_id: broker.id,
    currency_id: currency.id,
    country_id: country.id,
    treaty_type_id: type.id,
    inception_date: inception,
    experience_source: 'TRIANGLE',
    primary_class_of_business_id: cobs[0].id,
  };

  const detail = {
    triangulations_available: true,
    qs_limit: rng.money(500_000, 5_000_000),
    retention_pct: rng.pct(10, 40),
    retention_amt: rng.money(100_000, 900_000),
    cession_pct: rng.pct(50, 90),
    cession_amt: rng.money(1_000_000, 4_000_000),
    surplus_max_retention: rng.money(250_000, 1_500_000),
    num_lines: rng.int(5, 20),
    total_capacity: rng.money(5_000_000, 40_000_000),
    event_limit: rng.money(2_000_000, 10_000_000),
    aal: rng.money(500_000, 3_000_000),
    quota_share_epi: rng.money(1_000_000, 12_000_000),
    surplus_epi: rng.money(500_000, 8_000_000),
    brokerage_pct: rng.pct(1, 12),
    taxes_pct: rng.pct(0, 6),
    loss_cap_pct: rng.pct(100, 250),
    experience_start_year: uwYear - 10,
    strip_large_cat_losses: rng.chance(0.5),
  };

  const sliceHeaderDetail = {
    header: {
      cedant_id: cedant.id,
      broker_id: broker.id,
      currency_id: currency.id,
      country_id: country.id,
      treaty_type_id: type.id,
      uw_year: uwYear,
      experience_source: 'TRIANGLE',
      renewal_date: renewal,
      inception_date: inception,
      contract_description: description,
      primary_class_of_business_id: cobs[0].id,
    },
    detail,
  };

  const slidingTable = Array.from({ length: rng.int(3, 6) }, (_, i) => ({
    loss_ratio_pct: 40 + i * 10,
    commission_pct: rng.pct(15, 37.5),
  }));
  const sliceCommissions = {
    commissions: {
      mode: rng.chance(0.5) ? 'SLIDING' : 'FIXED',
      fixed_commission_pct: rng.pct(20, 35),
      fixed_commission_qs_pct: rng.pct(20, 35),
      fixed_commission_surplus_pct: rng.pct(15, 30),
      provisional_commission_pct: rng.pct(20, 30),
      sliding_min_loss_ratio: 40,
      sliding_max_loss_ratio: 80,
      sliding_min_commission: rng.pct(15, 20),
      sliding_max_commission: rng.pct(30, 40),
      mgmt_expenses_pct: rng.pct(2, 8),
      profit_commission_pct: rng.pct(10, 25),
      lcf_years: rng.int(1, 5),
      lcf_extinction: rng.chance(0.4),
      sliding_table: slidingTable,
    },
  };

  const lpSlides = [{ from: 80, to: 100, share: rng.pct(10, 50) }];
  const sliceStructure = {
    lossParticipation: {
      enabled: rng.chance(0.6),
      min_loss_ratio_pct: 80,
      max_loss_ratio_pct: rng.pct(100, 140),
      reinsurer_share_pct: rng.pct(10, 60),
      slides: lpSlides,
    },
    classIds: cobs.map((c) => c.id),
    epi_split: cobs.map((c) => ({ class_id: c.id, premium: rng.money(200_000, 4_000_000) })),
    underwriting_limits: cobs.map((c) => ({
      class_of_business_id: c.id,
      limit_amount: rng.money(500_000, 5_000_000),
      basis: rng.pick(['COMBINED', 'RISK', 'CAT']),
    })),
  };

  return { kind: 'PROP', cedant, type, cobs, inception, renewal, description,
    create, sliceHeaderDetail, sliceCommissions, sliceStructure };
}

/** NP treaty plan: header slice + np-details/layers via non-prop/save. */
export function npTreatyPlan(rng, refs, uwYear) {
  const cedant = rng.pick(refs.cedants);
  const broker = rng.pick(refs.brokers);
  const currency = rng.pick(refs.currencies);
  const country = rng.pick(refs.countries);
  const type = rng.pick(refs.treatyTypes.filter((t) => t.category === 'NON_PROPORTIONAL'));
  const cobs = rng.sample(refs.cobs, rng.int(1, 3));
  const inception = `${uwYear}-01-01`;
  const renewal = `${uwYear + 1}-01-01`;
  const description = `${cedant.name.split(' ')[0]} ${rng.pick(TREATY_DESCRIPTORS)} ${type.name} ${uwYear}`;

  const create = {
    uw_year: uwYear,
    cedant_id: cedant.id,
    broker_id: broker.id,
    currency_id: currency.id,
    country_id: country.id,
    treaty_type_id: type.id,
    inception_date: inception,
    experience_source: 'TRIANGLE',
    primary_class_of_business_id: cobs[0].id,
  };

  const sliceHeader = {
    header: {
      cedant_id: cedant.id,
      broker_id: broker.id,
      currency_id: currency.id,
      country_id: country.id,
      treaty_type_id: type.id,
      uw_year: uwYear,
      renewal_date: renewal,
      inception_date: inception,
      contract_description: description,
      primary_class_of_business_id: cobs[0].id,
    },
  };

  const layerCount = rng.int(2, 4);
  let attach = rng.money(250_000, 1_000_000, 50_000);
  const layers = [];
  for (let i = 1; i <= layerCount; i += 1) {
    const limit = rng.money(500_000, 4_000_000, 50_000);
    layers.push({
      layer_number: i,
      attachment: attach,
      layer_limit: limit,
      aggregate_limit: limit * rng.int(2, 4),
      egnpi: rng.money(4_000_000, 30_000_000),
      rate: rng.pct(0.5, 8),
      rol: rng.pct(2, 30),
      num_reinstatements: rng.int(1, 3),
      reinstatement_pct: rng.pick([50, 100, 125]),
      annual_agg_deductible: rng.money(0, 500_000, 50_000),
      peril_scope: rng.pick(['BOTH', 'CAT', 'RISK']),
      mdp: rng.money(50_000, 800_000),
      mdp_pct: rng.pct(60, 100),
    });
    attach += limit;
  }
  const npSave = {
    detail: {
      number_of_layers: layerCount,
      expiring_number_of_layers: layerCount,
      deductible: rng.money(100_000, 500_000),
      max_retention: rng.money(500_000, 2_000_000),
      accounting_method: rng.pick(['CLEAN_CUT', 'UY']),
      xl_type: type.name.toUpperCase().includes('CAT') ? 'CAT_XL' : 'RISK_XL',
      accounts: rng.pick(['QUARTERLY', 'HALF_YEARLY', 'ANNUAL']),
      brokerage_pct: rng.pct(5, 15),
      taxes_pct: rng.pct(0, 5),
      no_claims_bonus_pct: rng.pct(0, 15),
      profit_commission_pct: rng.pct(0, 20),
      est_gnpi: rng.money(8_000_000, 60_000_000),
      experience_start_year: uwYear - 10,
    },
    layers,
    cob_underwriting_limits: cobs.map((c) => ({
      cob_id: c.id, limit_amount: rng.money(500_000, 5_000_000),
    })),
  };

  return { kind: 'NP', cedant, type, cobs, inception, renewal, description,
    create, sliceHeader, npSave, layers };
}

/**
 * Upper triangle inside the server bounds: startYear = uwYear-10 =>
 * numDevYears = 10; row r keeps cells while (r + dev/12 - 1) < 10.
 */
export function triangleCells(rng, uwYear, { base = 1_000_000, growth = 0.35 } = {}) {
  const startYear = uwYear - 10;
  const numDevYears = 10;
  const cells = [];
  for (let r = 0; r < numDevYears; r += 1) {
    const originYear = startYear + r;
    let cum = rng.money(base * 0.4, base * 1.6, 1000);
    for (let dev = 12; (r + dev / 12 - 1) < numDevYears; dev += 12) {
      cells.push({ origin_year: originYear, dev_months: dev, cum_value: cum });
      cum = Math.round(cum * (1 + growth * Math.exp(-dev / 24) + rng.float(0, 0.03)));
    }
  }
  return cells;
}

export function devFactors(rng) {
  const factors = [];
  let cdf = 1;
  for (let dev = 108; dev >= 12; dev -= 12) {
    const ldf = 1 + rng.float(0.005, 0.4) * Math.exp(-(108 - dev) / 40);
    factors.push({ dev_month: dev, ldf });
  }
  // CDF builds tail-first: cdf(dev) = ldf(dev) * cdf(dev+12).
  factors.sort((a, b) => b.dev_month - a.dev_month);
  for (const f of factors) {
    cdf *= f.ldf;
    f.cdf = cdf;
  }
  factors.sort((a, b) => a.dev_month - b.dev_month);
  return factors.map((f) => ({
    dev_month: f.dev_month,
    selected_ldf: Math.round(f.ldf * 10000) / 10000,
    selected_cdf: Math.round(f.cdf * 10000) / 10000,
    actual_ldf: Math.round(f.ldf * 10000) / 10000,
    actual_cdf: Math.round(f.cdf * 10000) / 10000,
    chosen_source: 'ACTUAL',
    chosen_ldf: Math.round(f.ldf * 10000) / 10000,
    chosen_cdf: Math.round(f.cdf * 10000) / 10000,
    overridden: false,
  }));
}

const INSUREDS = ['Volta Aluminium', 'Tema Oil Refinery', 'Accra Mall', 'Takoradi Port Authority',
  'Kumasi Central Market', 'GRIDCo Substation', 'Achimota Transport', 'Cape Coast Hotel Group'];
const LOSS_NAMES = ['Fire loss', 'Flood damage', 'Machinery breakdown', 'Collision', 'Storm damage', 'Theft'];

export function largeLosses(rng, uwYear, count = null) {
  const n = count ?? rng.int(2, 5);
  return Array.from({ length: n }, () => {
    const y = rng.int(uwYear - 8, uwYear - 1);
    const paid = rng.money(150_000, 2_000_000);
    const os = rng.money(0, 800_000);
    return {
      uw_year: y,
      insured_name: rng.pick(INSUREDS),
      loss_name: rng.pick(LOSS_NAMES),
      date_of_loss: `${y}-${String(rng.int(1, 12)).padStart(2, '0')}-${String(rng.int(1, 28)).padStart(2, '0')}`,
      class_of_business: 'Property',
      paid,
      os,
      incurred: paid + os,
      is_selected: rng.chance(0.8),
      actuarial_reported_date: `${y + 1}-06-30`,
    };
  });
}

/** Fresh standalone quote payloads (create + one PUT slice). */
export function quotePlan(rng, refs, uwYear) {
  const cedant = rng.pick(refs.cedants);
  const broker = rng.pick(refs.brokers);
  const currency = rng.pick(refs.currencies);
  const country = rng.pick(refs.countries);
  const type = rng.pick(refs.treatyTypes.filter((t) => t.category === 'PROPORTIONAL'));
  const cobs = rng.sample(refs.cobs, rng.int(1, 2));
  const inception = `${uwYear}-04-01`;
  const renewal = `${uwYear + 1}-04-01`;
  const description = `Quote — ${cedant.name.split(' ')[0]} ${rng.pick(TREATY_DESCRIPTORS)} ${uwYear}`;

  return {
    cedant, type, cobs, inception, renewal, description,
    create: {
      uw_year: uwYear,
      cedant_id: cedant.id,
      broker_id: broker.id,
      currency_id: currency.id,
      country_id: country.id,
      treaty_type_id: type.id,
      inception_date: inception,
      renewal_date: renewal,
      contract_description: description,
    },
    put: {
      header: {
        cedant_id: cedant.id,
        broker_id: broker.id,
        currency_id: currency.id,
        country_id: country.id,
        treaty_type_id: type.id,
        uw_year: uwYear,
        contract_description: description,
        inception_date: inception,
        renewal_date: renewal,
      },
      detail: {
        triangulations_available: true,
        qs_limit: rng.money(500_000, 5_000_000),
        retention_pct: rng.pct(10, 40),
        retention_amt: rng.money(100_000, 900_000),
        cession_pct: rng.pct(50, 90),
        cession_amt: rng.money(1_000_000, 4_000_000),
        surplus_max_retention: rng.money(250_000, 1_500_000),
        num_lines: rng.int(5, 20),
        total_capacity: rng.money(5_000_000, 40_000_000),
        event_limit: rng.money(2_000_000, 10_000_000),
        aal: rng.money(500_000, 3_000_000),
        quota_share_epi: rng.money(1_000_000, 12_000_000),
        surplus_epi: rng.money(500_000, 8_000_000),
        brokerage_pct: rng.pct(1, 12),
        taxes_pct: rng.pct(0, 6),
        loss_cap_pct: rng.pct(100, 250),
        experience_start_year: uwYear - 10,
        strip_large_cat_losses: false,
      },
      commissions: {
        mode: 'FIXED',
        fixed_commission_pct: rng.pct(20, 35),
        fixed_commission_qs_pct: rng.pct(20, 35),
        fixed_commission_surplus_pct: rng.pct(15, 30),
        provisional_commission_pct: rng.pct(20, 30),
        sliding_min_loss_ratio: 40,
        sliding_max_loss_ratio: 80,
        sliding_min_commission: rng.pct(15, 20),
        sliding_max_commission: rng.pct(30, 40),
        mgmt_expenses_pct: rng.pct(2, 8),
        profit_commission_pct: rng.pct(10, 25),
      },
      classIds: cobs.map((c) => c.id),
      epi_split: cobs.map((c) => ({ class_id: c.id, premium: rng.money(200_000, 4_000_000) })),
      lossParticipation: {
        enabled: rng.chance(0.5),
        min_loss_ratio_pct: 80,
        max_loss_ratio_pct: 120,
        reinsurer_share_pct: rng.pct(10, 60),
      },
    },
  };
}
