// server/src/db/contractJoins.js
// Shared SQL fragments for the contract/quote reference-table joins.
//
// Both `contract` and `quote` rows carry the same foreign keys — cedant_id,
// broker_id, country_id, treaty_type_id, currency_id — and every listing/
// detail endpoint needs the same five LEFT JOINs to resolve display names.
// That chain was previously duplicated across ~18 routes. These helpers
// produce the canonical SQL fragments so schema changes (new column on
// country, renamed field on treaty_type, etc.) stay a one-file edit.
//
// Conventions kept consistent with the original inline chains:
//   ced → companies (cedant)
//   bk  → brokers
//   cnt → country
//   tt  → treaty_type
//   cur → currency
//
// All fragments are safe to interpolate — they never consume user input.

/**
 * LEFT JOIN fragment resolving cedant, broker, country, treaty_type,
 * currency for a row keyed by (cedant_id, broker_id, country_id,
 * treaty_type_id, currency_id).
 *
 * @param {string} baseAlias The alias of the contract/quote table in the
 *   outer query (e.g. 'c' for contract, 'q' for quote).
 * @returns {string} SQL fragment (no leading space, trailing newline).
 */
export function contractContextJoins(baseAlias) {
  return [
    `LEFT JOIN public.companies   ced ON ced.company_id    = ${baseAlias}.cedant_id`,
    `LEFT JOIN public.brokers     bk  ON bk.broker_id      = ${baseAlias}.broker_id`,
    `LEFT JOIN public.country     cnt ON cnt.country_id    = ${baseAlias}.country_id`,
    `LEFT JOIN public.treaty_type tt  ON tt.treaty_type_id = ${baseAlias}.treaty_type_id`,
    `LEFT JOIN public.currency    cur ON cur.currency_id   = ${baseAlias}.currency_id`,
  ].join('\n');
}

/**
 * Canonical SELECT projection for cedant/broker/country/treaty_type/currency
 * display names used by listing endpoints. Add any columns the caller needs
 * by concatenating after this fragment.
 *
 * @returns {string} Comma-joined list of projected columns (no leading comma).
 */
export const contractContextColumns =
  [
    'ced.company_name  AS cedant_name',
    'bk.broker_name    AS broker_name',
    'cnt.country_name  AS country_name',
    'cnt.country_code  AS country_code',
    'tt.treaty_type    AS treaty_type_name',
    'tt.category       AS treaty_category',
    'cur.currency_code AS currency_code',
  ].join(',\n         ');

/**
 * Short-form projection used by some list endpoints that only need the
 * primary display label (cedant), country, and treaty type/category/currency.
 */
export const contractContextListColumns =
  [
    'ced.company_name  AS name',
    'cnt.country_name  AS country',
    'cnt.country_code',
    'tt.treaty_type    AS treaty_type_name',
    'tt.category       AS treaty_category',
    'cur.currency_code',
  ].join(',\n         ');
