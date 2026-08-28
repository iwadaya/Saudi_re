import { pool } from '../db/pool.js';
import { logger } from '../lib/logger.js';

// ── Seed data ────────────────────────────────────────────────────────────────

const countries = [
  ['United Arab Emirates','AE'],['Saudi Arabia','SA'],['Kuwait','KW'],['Bahrain','BH'],
  ['Oman','OM'],['Qatar','QA'],['Jordan','JO'],['Lebanon','LB'],['Egypt','EG'],
  ['Morocco','MA'],['Tunisia','TN'],['Algeria','DZ'],['South Africa','ZA'],
  ['Nigeria','NG'],['Kenya','KE'],['United Kingdom','GB'],['France','FR'],
  ['Germany','DE'],['Italy','IT'],['Spain','ES'],['Switzerland','CH'],
  ['Netherlands','NL'],['Belgium','BE'],['Turkey','TR'],['India','IN'],
  ['Pakistan','PK'],['Sri Lanka','LK'],['Bangladesh','BD'],['Malaysia','MY'],
  ['Singapore','SG'],['Japan','JP'],['China','CN'],['South Korea','KR'],
  ['Thailand','TH'],['Indonesia','ID'],['Philippines','PH'],['Australia','AU'],
  ['New Zealand','NZ'],['United States','US'],['Canada','CA'],['Mexico','MX'],
  ['Brazil','BR'],['Chile','CL'],['Colombia','CO'],['Argentina','AR'],
];

const currencies = [
  ['USD','US Dollar'],['EUR','Euro'],['GBP','British Pound'],['AED','UAE Dirham'],
  ['SAR','Saudi Riyal'],['KWD','Kuwaiti Dinar'],['BHD','Bahraini Dinar'],
  ['OMR','Omani Rial'],['QAR','Qatari Riyal'],['JOD','Jordanian Dinar'],
  ['EGP','Egyptian Pound'],['MAD','Moroccan Dirham'],['ZAR','South African Rand'],
  ['NGN','Nigerian Naira'],['KES','Kenyan Shilling'],['INR','Indian Rupee'],
  ['PKR','Pakistani Rupee'],['LKR','Sri Lankan Rupee'],['MYR','Malaysian Ringgit'],
  ['SGD','Singapore Dollar'],['JPY','Japanese Yen'],['CNY','Chinese Yuan'],
  ['KRW','South Korean Won'],['THB','Thai Baht'],['IDR','Indonesian Rupiah'],
  ['AUD','Australian Dollar'],['NZD','New Zealand Dollar'],['CAD','Canadian Dollar'],
  ['CHF','Swiss Franc'],['TRY','Turkish Lira'],['BRL','Brazilian Real'],['MXN','Mexican Peso'],
];

const brokers = [
  'Aon','Marsh','Willis Towers Watson','Guy Carpenter','Gallagher Re',
  'Lockton Re','Ed Broking','BMS Group','UIB','Howden','Direct',
];

const treatyTypes = [
  ['Quota Share','PROPORTIONAL'],['Quota Share & Surplus','PROPORTIONAL'],
  ['First Surplus','PROPORTIONAL'],['Second Surplus','PROPORTIONAL'],
  ['Third Surplus','PROPORTIONAL'],['Fac Oblig','PROPORTIONAL'],
  ['Risk XL','NON_PROPORTIONAL'],['CAT XL','NON_PROPORTIONAL'],
  ['Risk & CAT XL','NON_PROPORTIONAL'],['Stop Loss','NON_PROPORTIONAL'],
  ['Aggregate XL','NON_PROPORTIONAL'],
];

const classes = [
  ['Property','PROP'],['Motor','MOT'],['Marine','MAR'],['Engineering','ENG'],
  ['Liability','LIA'],['Medical','MED'],['Aviation','AVI'],['Energy','ENE'],
  ['Agriculture','AGR'],['Credit & Surety','CS'],['Miscellaneous','MISC'],
  ['Life','LIFE'],['Group Life','GL'],['Workers Compensation','WC'],
];

const reinsurers = [
  ['Swiss Re'],['Munich Re'],['Hannover Re'],['SCOR'],
  ['Lloyds'],['RGA'],['Everest Re'],['PartnerRe'],
  ['Transatlantic Re'],['Korean Re'],['Africa Re'],
  ['Trust Re'],['CCR Re'],['Qatar Re'],['Maiden Re'],
];

const companySeedsByCountry = {
  AE: ['Abu Dhabi National Insurance','ADNIC','Orient Insurance','Oman Insurance','Dubai Insurance','Salama Islamic Insurance'],
  SA: ['Tawuniya','Bupa Arabia','Malath Insurance','Al Rajhi Takaful','Walaa Insurance','Gulf Union Insurance'],
  KW: ['Kuwait Insurance','Gulf Insurance Group','Warba Insurance'],
  GB: ['Aviva','AXA UK','RSA Insurance','Zurich UK'],
  EG: ['Misr Insurance','GIG Egypt','Allianz Egypt'],
};

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Run a batch of upsert-style inserts.
 * Returns the number of rows processed (not necessarily inserted — many will be no-ops).
 * Throws only on a fatal DB connection error; table-missing (42P01) returns 0 gracefully.
 */
async function tryInsertMany(label, sql, rows) {
  let count = 0;
  try {
    for (const row of rows) {
      await pool.query(sql, row);
      count++;
    }
  } catch (err) {
    if (err.code === '42P01') {
      // Table doesn't exist yet — migrations may not have run fully.
      // Log a warning and continue; the data will be seeded on the next boot
      // once migrations have created the table.
      logger.warn('ensureReferenceData: table missing, will retry on next boot', { label });
      return 0;
    }
    // Any other error: log it but don't crash the boot
    logger.warn('ensureReferenceData: unexpected error seeding', { label, error: err.message.split('\n')[0] });
    return count;
  }
  return count;
}

// ── Main export ───────────────────────────────────────────────────────────────

export async function ensureReferenceData() {
  await tryInsertMany(
    'countries',
    'INSERT INTO public.country (country_name, country_code) SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM public.country WHERE country_code = $2)',
    countries,
  );

  await tryInsertMany(
    'currencies',
    'INSERT INTO public.currency (currency_code, currency_name) SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM public.currency WHERE currency_code = $1)',
    currencies,
  );

  await tryInsertMany(
    'brokers',
    'INSERT INTO public.brokers (broker_name) SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM public.brokers WHERE broker_name = $1)',
    brokers.map((v) => [v]),
  );

  // Seed canonical treaty types into the singular table (has FK constraints from contract/quote)
  await tryInsertMany(
    'treaty_type',
    'INSERT INTO public.treaty_type (treaty_type, category) SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM public.treaty_type WHERE treaty_type = $1)',
    treatyTypes,
  );

  // Soft-deactivate non-canonical treaty types so they disappear from the
  // reference dropdowns (lookups.js filters `is_active IS NOT FALSE`,
  // migration 141) without destroying anything.
  //
  // This block used to hard-DELETE every non-canonical row on every boot —
  // silently erasing user-created reference data — after attempting to NULL
  // out contract/quote.treaty_type_id, which can never succeed because both
  // columns are NOT NULL (so the only rows that "survived" were the ones a
  // constraint violation happened to protect, and every error was swallowed).
  // Boot must never delete reference rows; if canonical enforcement is ever
  // wanted, it belongs in a reviewed migration.
  //
  // Only ACTIVE rows are touched (`is_active IS DISTINCT FROM false`) so rows
  // already soft-deleted — by a user or by test fixtures — are left exactly
  // as they are, and the statement is a no-op on an already-converged DB.
  try {
    const canonicalNames = treatyTypes.map(([name]) => name);
    const res = await pool.query(
      `UPDATE public.treaty_type
          SET is_active = false
        WHERE treaty_type <> ALL($1::text[])
          AND is_active IS DISTINCT FROM false`,
      [canonicalNames]
    );
    if (res.rowCount > 0) {
      logger.info('ensureReferenceData: deactivated non-canonical treaty types', { count: res.rowCount });
    }
  } catch (e) {
    logger.warn('ensureReferenceData: treaty_type deactivation failed', { error: e.message?.split('\n')[0] });
  }


  await tryInsertMany(
    'class_of_business',
    'INSERT INTO public.class_of_business (class_of_business, code) SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM public.class_of_business WHERE class_of_business = $1)',
    classes,
  );

  await tryInsertMany(
    'reinsurers',
    'INSERT INTO public.reinsurers (reinsurer_name) SELECT $1 WHERE NOT EXISTS (SELECT 1 FROM public.reinsurers WHERE reinsurer_name = $1)',
    reinsurers,
  );

  // Companies need a country_id lookup first — wrap entirely
  try {
    for (const [countryCode, companyNames] of Object.entries(companySeedsByCountry)) {
      const { rows } = await pool.query(
        'SELECT country_id FROM public.country WHERE country_code = $1 LIMIT 1',
        [countryCode],
      );
      const countryId = rows[0]?.country_id;
      if (!countryId) continue;
      for (const companyName of companyNames) {
        await pool.query(
          'INSERT INTO public.companies (company_name, country_id) SELECT $1, $2 WHERE NOT EXISTS (SELECT 1 FROM public.companies WHERE company_name = $1)',
          [companyName, countryId],
        );
      }
    }
  } catch (err) {
    if (err.code === '42P01') {
      logger.warn('ensureReferenceData: companies table missing, will retry on next boot');
    } else {
      logger.warn('ensureReferenceData: unexpected error seeding companies', { error: err.message.split('\n')[0] });
    }
  }

  // Summary — use IF EXISTS style counts so a missing table doesn't crash this either
  const summaryQueries = {
    countries:   'SELECT COUNT(*)::int AS count FROM public.country',
    currencies:  'SELECT COUNT(*)::int AS count FROM public.currency',
    brokers:     'SELECT COUNT(*)::int AS count FROM public.brokers',
    treatyTypes: 'SELECT COUNT(*)::int AS count FROM public.treaty_type',
    classes:     'SELECT COUNT(*)::int AS count FROM public.class_of_business',
    cedants:     'SELECT COUNT(*)::int AS count FROM public.companies',
  };

  const summary = {};
  for (const [key, sql] of Object.entries(summaryQueries)) {
    try {
      const { rows } = await pool.query(sql);
      summary[key] = rows[0]?.count ?? 0;
    } catch {
      summary[key] = '?';
    }
  }
  logger.info('reference data ready', summary);
  return summary;
}
